import {link, mkdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {atomicWrite, isPlausibleMp3} from './generate-fish-audio.mjs';

// Offline import only. The input must come from actual downloads of the
// Englex dictionary's visible AI playback, never generated replacement audio.
// Credentials, signed source URLs and browser state are not accepted or copied.
const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const ID = /^[a-f0-9]{20}$/;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const normalizeEnglexAudioWord = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function localPath(value, base) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[\\/]{2}/.test(value)) {
    throw new Error('Audio input must name a local file, not a URL.');
  }
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

async function readAudio(path) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > MAX_AUDIO_BYTES) throw new Error('Audio input is not a regular MP3 within the size limit.');
  const bytes = await readFile(canonical);
  if (!isPlausibleMp3(bytes)) throw new Error('Audio input is not a valid MP3.');
  return bytes;
}

async function installWithoutReplacing(path, bytes) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    try { await link(temporary, path); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readFile(path)).equals(bytes)) throw new Error('Concurrent audio conflict; existing file was not overwritten.');
      return false;
    }
  } finally { await rm(temporary, {force: true}); }
}

export async function importEnglexAudio({inputFile, distDir = DEFAULT_DIST} = {}) {
  inputFile = localPath(inputFile, process.cwd());
  distDir = resolve(distDir);
  const rows = JSON.parse(await readFile(inputFile, 'utf8'));
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Audio input must be an array of at most 10000 {word,file} records.');
  const dictionary = JSON.parse(await readFile(join(distDir, 'dictionary.json'), 'utf8'));
  if (!Array.isArray(dictionary?.cards)) throw new Error('Dictionary cards are missing.');
  const cardsByWord = new Map();
  const validIds = new Set();
  for (const card of dictionary.cards) {
    if (!ID.test(card?.id || '') || validIds.has(card.id) || typeof card.word !== 'string' || !normalizeEnglexAudioWord(card.word)) throw new Error('Invalid dictionary card or duplicate ID.');
    validIds.add(card.id);
    const key = normalizeEnglexAudioWord(card.word);
    const matches = cardsByWord.get(key) || [];
    matches.push(card);
    cardsByWord.set(key, matches);
  }
  const manifestPath = join(distDir, 'englex-ai-index.json');
  const previousBytes = await optionalRead(manifestPath);
  const previous = previousBytes ? JSON.parse(previousBytes) : {version: 1, source: 'englex-ai', recordings: {}};
  if (previous.version !== 1 || previous.source !== 'englex-ai' || !previous.recordings ||
      typeof previous.recordings !== 'object' || Array.isArray(previous.recordings) ||
      Object.keys(previous).some(key => !['version', 'source', 'recordings'].includes(key))) throw new Error('Invalid Englex AI manifest.');
  for (const [id, path] of Object.entries(previous.recordings)) {
    if (!validIds.has(id) || path !== `audio/englex-ai/${id}.mp3`) throw new Error('Invalid or foreign Englex AI recording entry.');
  }
  const sources = new Map();
  for (const row of rows) {
    if (!row || typeof row.word !== 'string' || !normalizeEnglexAudioWord(row.word) ||
        Object.keys(row).some(key => !['word', 'file'].includes(key))) throw new Error('Each input row must contain only word and local file.');
    const path = localPath(row.file, dirname(inputFile));
    const bytes = await readAudio(path);
    const key = normalizeEnglexAudioWord(row.word);
    const existing = sources.get(key);
    if (existing) {
      if (existing.hash !== digest(bytes)) existing.conflict = true;
    } else sources.set(key, {word: row.word, bytes, hash: digest(bytes), conflict: false});
  }
  const report = {changed: false, capturedWords: sources.size, matchedCards: 0, added: 0, writtenFiles: 0,
    unchanged: 0, unmatchedWords: [], conflicts: []};
  const recordings = {...previous.recordings};
  const writes = [];
  for (const [key, source] of sources) {
    const matches = cardsByWord.get(key);
    if (!matches) { report.unmatchedWords.push(source.word); continue; }
    report.matchedCards += matches.length;
    if (source.conflict) {
      report.conflicts.push({word: source.word, ids: matches.map(card => card.id), reason: 'Different captured recordings for the same normalized word.'});
      continue;
    }
    for (const card of matches) {
      const path = `audio/englex-ai/${card.id}.mp3`;
      const existing = await optionalRead(join(distDir, path));
      if (existing && !existing.equals(source.bytes)) {
        report.conflicts.push({word: card.word, ids: [card.id], reason: 'Existing MP3 differs; it was preserved.'});
        continue;
      }
      if (!existing) writes.push({path, bytes: source.bytes});
      if (!Object.hasOwn(recordings, card.id)) { recordings[card.id] = path; report.added++; }
      else if (existing) report.unchanged++;
    }
  }
  for (const write of writes) if (await installWithoutReplacing(join(distDir, write.path), write.bytes)) report.writtenFiles++;
  if (report.added) {
    const currentBytes = await optionalRead(manifestPath);
    if (previousBytes ? !currentBytes?.equals(previousBytes) : currentBytes !== null) throw new Error('Manifest changed concurrently; it was not overwritten. Re-run the merge.');
    const ordered = Object.fromEntries(dictionary.cards.filter(card => Object.hasOwn(recordings, card.id)).map(card => [card.id, recordings[card.id]]));
    await atomicWrite(manifestPath, JSON.stringify({version: 1, source: 'englex-ai', recordings: ordered}, null, 2) + '\n');
  }
  report.changed = report.added > 0 || report.writtenFiles > 0;
  report.total = Object.keys(recordings).length;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Use node scripts/import-englex-audio.mjs /local/captured-ai.json');
    console.log(JSON.stringify(await importEnglexAudio({inputFile: process.argv[2]}), null, 2));
  } catch (error) {
    // File-system errors can echo input paths: avoid printing those paths.
    console.error(error.code ? 'Englex AI import could not read or write a local file.' :
      error instanceof SyntaxError ? 'Englex AI input or manifest contains invalid JSON.' : error.message);
    process.exitCode = 1;
  }
}
