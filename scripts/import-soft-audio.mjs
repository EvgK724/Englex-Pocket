import {link, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {atomicWrite, isPlausibleMp3} from './generate-fish-audio.mjs';

export const SOFT_PROVIDER = 'AI Voice Generator';
export const SOFT_VOICE = 'delicate';
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 1024 * 1024;
const ID = /^[a-f0-9]{20}$/;
const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// Offline, original-provider audio only. No generation, URLs, credentials or
// changes to the existing voice are accepted by this import contract.
export function decodeSoftAudioBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BUNDLE_BYTES) throw new Error('Soft AI Voice bundle exceeds 20 MiB.');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Soft AI Voice bundle is not valid JSON.'); }
  if (raw?.version !== 1 || raw.provider !== SOFT_PROVIDER || raw.voice !== SOFT_VOICE ||
      !Array.isArray(raw.recordings) || raw.recordings.length > 1000 ||
      Object.keys(raw).some(key => !['version', 'provider', 'voice', 'recordings'].includes(key)))
    throw new Error('Soft AI Voice bundle requires version 1, AI Voice Generator, delicate and at most 1000 recordings.');
  const recordings = new Map();
  let totalBytes = 0;
  for (const row of raw.recordings) {
    if (!row || typeof row.id !== 'string' || !ID.test(row.id) ||
        typeof row.word !== 'string' || !row.word.trim() || row.word.length > 4096 ||
        typeof row.audioBase64 !== 'string' || Object.keys(row).some(key => !['id', 'word', 'audioBase64'].includes(key)) ||
        row.audioBase64.length > 4 * Math.ceil(MAX_RECORDING_BYTES / 3) ||
        row.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.audioBase64))
      throw new Error('Invalid soft AI Voice ID, word or canonical base64 recording.');
    const audio = Buffer.from(row.audioBase64, 'base64');
    totalBytes += audio.length;
    if (audio.length > MAX_RECORDING_BYTES || totalBytes > MAX_BUNDLE_BYTES ||
        audio.toString('base64') !== row.audioBase64 || !isPlausibleMp3(audio))
      throw new Error('Soft AI Voice bundle contains invalid or oversized MP3 audio.');
    const previous = recordings.get(row.id);
    if (previous && (previous.word !== row.word || !previous.audio.equals(audio)))
      throw new Error('Conflicting soft AI Voice recordings for the same ID.');
    recordings.set(row.id, {id: row.id, word: row.word, audio});
  }
  return [...recordings.values()];
}

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function installWithoutReplacing(path, bytes) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    try { await link(temporary, path); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readFile(path)).equals(bytes)) throw new Error('Concurrent soft audio conflict; the existing MP3 was preserved.');
      return false;
    }
  } finally { await rm(temporary, {force: true}); }
}

export async function importSoftAudio({bundle, inputFile, distDir = DEFAULT_DIST} = {}) {
  if (bundle !== undefined && inputFile !== undefined) throw new Error('Choose a bundle or an input file, not both.');
  if (bundle === undefined) {
    if (typeof inputFile !== 'string' || !inputFile || /^[a-z][a-z0-9+.-]*:/i.test(inputFile))
      throw new Error('Soft AI Voice input must be a local bundle file.');
    const inputPath = resolve(inputFile), info = await stat(inputPath);
    if (!info.isFile() || info.size > MAX_BUNDLE_BYTES) throw new Error('Soft AI Voice bundle exceeds 20 MiB or is not a file.');
    bundle = await readFile(inputPath);
  }
  const recordings = decodeSoftAudioBundle(bundle);
  distDir = resolve(distDir);
  const dictionary = JSON.parse(await readFile(join(distDir, 'dictionary.json'), 'utf8'));
  if (!Array.isArray(dictionary?.cards)) throw new Error('Current dictionary cards are missing.');
  const byId = new Map();
  for (const card of dictionary.cards) {
    if (!card || typeof card.id !== 'string' || !ID.test(card.id) || byId.has(card.id) || typeof card.word !== 'string' || !card.word.trim())
      throw new Error('Current dictionary has an invalid card or duplicate ID.');
    byId.set(card.id, card);
  }
  // Verify every row against current main before creating any audio or index.
  for (const row of recordings) {
    if (!byId.has(row.id) || byId.get(row.id).word !== row.word)
      throw new Error('Soft AI Voice bundle ID and word must exactly match the current dictionary.');
  }
  const manifestPath = join(distDir, 'audio-index.json');
  const previousBytes = await optionalRead(manifestPath);
  if (!previousBytes) throw new Error('Existing soft AI Voice index is required.');
  const previous = JSON.parse(previousBytes);
  if (previous.version !== 1 || previous.provider !== SOFT_PROVIDER || previous.voice !== SOFT_VOICE ||
      !Array.isArray(previous.cards) || previous.count !== previous.cards.length ||
      previous.cards.some(id => typeof id !== 'string' || !byId.has(id)) ||
      new Set(previous.cards).size !== previous.cards.length)
    throw new Error('Existing soft AI Voice index has invalid provenance, count or IDs.');
  if (previous.voiceOverrides !== undefined && (!previous.voiceOverrides || typeof previous.voiceOverrides !== 'object' ||
      Array.isArray(previous.voiceOverrides) || Object.keys(previous.voiceOverrides).some(id => !previous.cards.includes(id))))
    throw new Error('Existing soft AI Voice overrides must reference preserved indexed cards.');
  const previousIds = new Set(previous.cards), available = new Set(previous.cards);
  const writes = [];
  const report = {changed: false, received: recordings.length, added: 0, writtenFiles: 0, unchanged: 0, conflicts: []};
  for (const row of recordings) {
    const path = join(distDir, 'audio', `${row.id}.mp3`);
    const existing = await optionalRead(path);
    if (!existing && Object.hasOwn(previous.voiceOverrides || {}, row.id) && previous.voiceOverrides[row.id]?.voice !== SOFT_VOICE)
      throw new Error('A missing MP3 with a different voice override cannot be restored from a delicate bundle.');
    if (existing && !existing.equals(row.audio)) {
      report.unchanged++;
      report.conflicts.push({id: row.id, word: row.word, reason: 'Existing MP3 differs; its bytes and existing voice metadata were preserved.'});
      continue;
    }
    if (!existing) writes.push({path, audio: row.audio});
    if (!available.has(row.id)) { available.add(row.id); report.added++; }
    else if (existing) report.unchanged++;
  }
  for (const write of writes) if (await installWithoutReplacing(write.path, write.audio)) report.writtenFiles++;
  if (report.added) {
    if (!(await readFile(manifestPath)).equals(previousBytes))
      throw new Error('Soft AI Voice index changed concurrently; it was not overwritten. Re-run the merge.');
    const cards = [...previous.cards, ...dictionary.cards.filter(card => available.has(card.id) && !previousIds.has(card.id)).map(card => card.id)];
    // Preserve all existing fields, including the explicitly recorded overrides.
    await atomicWrite(manifestPath, JSON.stringify({...previous, count: cards.length, cards}, null, 2) + '\n');
  }
  report.total = available.size;
  report.changed = report.added > 0 || report.writtenFiles > 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Use node scripts/import-soft-audio.mjs /local/soft-audio-batch.json');
    console.log(JSON.stringify(await importSoftAudio({inputFile: process.argv[2]}), null, 2));
  } catch (error) {
    console.error(error.code ? 'Soft AI Voice import could not read or write a local file.' :
      error instanceof SyntaxError ? 'Soft AI Voice input or index contains invalid JSON.' : error.message);
    process.exitCode = 1;
  }
}
