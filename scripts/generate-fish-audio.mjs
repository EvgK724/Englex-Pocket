import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {speechText} from '../dist/core.mjs';

export const VOICE_ID = '089f2e853e064d6fb15f5b5882914b52';
export const ENGINE = 's2.1-pro-free';
export const ENDPOINT = 'https://api.fish.audio/v1/tts';
const ID = /^[a-f0-9]{20}$/;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));

export function parseArgs(args) {
  const options = {limit: 5};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--limit', '--ids'].includes(name) || seen.has(name)) throw new Error('Use only --limit 1..50 and optional --ids id,id.');
    seen.add(name);
    const value = args[++i];
    if (name === '--limit') {
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value || '')) throw new Error('Limit must be an integer from 1 to 50.');
      options.limit = Number(value);
    } else {
      const ids = (value || '').split(',').map(id => id.trim());
      if (!ids.every(id => ID.test(id))) throw new Error('IDs must be comma-separated 20-character lowercase hex card IDs.');
      options.ids = [...new Set(ids)];
    }
  }
  return options;
}

// Require at least one complete MPEG Layer III frame, optionally after an ID3
// tag. A MIME header, ID3 prefix, empty file or JSON error alone is not audio.
export function isPlausibleMp3(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_AUDIO_BYTES) return false;
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    if (bytes.length < 10 || bytes[3] < 2 || bytes[3] > 4 || [6, 7, 8, 9].some(i => bytes[i] & 0x80)) return false;
    offset = 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10;
  }
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[offset + 1] >> 3) & 3;
  const layer = (bytes[offset + 1] >> 1) & 3;
  const rateIndex = (bytes[offset + 2] >> 2) & 3;
  const bitrateIndex = bytes[offset + 2] >> 4;
  if (version === 1 || layer !== 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return false;
  const bitrates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const rate = [44100,48000,32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / rate) + ((bytes[offset + 2] >> 1) & 1);
  return offset + frameLength <= bytes.length;
}

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function atomicWrite(path, data) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, {flag: 'wx'});
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readBoundedAudio(response) {
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) throw new Error('Audio response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing audio response body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error('Audio response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function generateFishAudio({distDir = DEFAULT_DIST, limit = 5, ids,
  apiKey = process.env.FISH_API_KEY, engine = process.env.FISH_ENGINE || ENGINE,
  fetchImpl = globalThis.fetch} = {}) {
  // Check credentials and the exact free engine before any filesystem mutation.
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set the server-side FISH_API_KEY secret before generating audio.');
  if (engine !== ENGINE) throw new Error('Only s2.1-pro-free is allowed; paid model fallback is disabled.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be an integer from 1 to 50.');
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && ID.test(id)))) throw new Error('Invalid card IDs.');
  distDir = resolve(distDir);
  const dictionary = JSON.parse(await readFile(join(distDir, 'dictionary.json'), 'utf8'));
  if (!Array.isArray(dictionary.cards)) throw new Error('Dictionary must contain a cards array.');
  const allIds = new Set();
  for (const card of dictionary.cards) {
    if (!card || typeof card.id !== 'string' || !ID.test(card.id) || allIds.has(card.id) || typeof card.word !== 'string' || !speechText(card.word) || speechText(card.word).length > 500) throw new Error('Dictionary contains an invalid, duplicate or excessively long card.');
    allIds.add(card.id);
  }
  if (ids?.some(id => !allIds.has(id))) throw new Error('A requested card ID is not in the dictionary.');
  const manifestPath = join(distDir, 'fish-chonishvili-index.json');
  const previous = await optionalRead(manifestPath);
  if (previous) {
    const manifest = JSON.parse(previous.toString('utf8'));
    if (manifest.version !== 1 || manifest.voiceId !== VOICE_ID || manifest.engine !== ENGINE || !Array.isArray(manifest.cards)) throw new Error('Existing Fish index has incompatible voice or engine metadata.');
  }
  const audioDir = join(distDir, 'audio', 'fish-chonishvili');
  const available = new Set();
  for (const card of dictionary.cards) {
    const bytes = await optionalRead(join(audioDir, `${card.id}.mp3`));
    if (bytes && isPlausibleMp3(bytes)) available.add(card.id);
  }
  const selected = ids ? new Set(ids) : allIds;
  const pending = dictionary.cards.filter(card => selected.has(card.id) && !available.has(card.id))
    .sort((a, b) => String(b.added || '').localeCompare(String(a.added || ''))).slice(0, limit);
  const writeManifest = () => atomicWrite(manifestPath, JSON.stringify({version: 1, voiceId: VOICE_ID, engine: ENGINE,
    cards: dictionary.cards.filter(card => available.has(card.id)).map(card => card.id)}, null, 2) + '\n');
  let generated = 0;
  for (const card of pending) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: {'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', model: ENGINE},
        body: JSON.stringify({text: speechText(card.word), reference_id: VOICE_ID, format: 'mp3', mp3_bitrate: 128})
      });
    } catch {
      throw new Error('Fish request failed or timed out; generation stopped without retrying.');
    }
    // Never echo response bodies: they may include request data or credentials.
    if (!response.ok) throw new Error(`Fish HTTP ${Number(response.status)}; generation stopped without retry or paid fallback.`);
    const contentType = response.headers.get('content-type') || '';
    if (/json|text|html/i.test(contentType)) throw new Error('Fish returned a non-audio response; no recording was written.');
    let bytes;
    try { bytes = await readBoundedAudio(response); }
    catch { throw new Error('Fish audio transfer failed; no recording was written.'); }
    if (!isPlausibleMp3(bytes)) throw new Error('Fish returned invalid or truncated MP3 data; no recording was written.');
    await atomicWrite(join(audioDir, `${card.id}.mp3`), bytes);
    available.add(card.id);
    await writeManifest();
    generated++;
  }
  if (!pending.length) await writeManifest();
  return {generated, available: available.size, remaining: dictionary.cards.filter(card => selected.has(card.id) && !available.has(card.id)).length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await generateFishAudio(parseArgs(process.argv.slice(2)));
    console.log(`Fish recordings: ${result.generated} generated, ${result.available} available, ${result.remaining} selected cards remaining.`);
  } catch (error) {
    // Redact even unexpected local errors before printing a CLI diagnostic.
    const secret = process.env.FISH_API_KEY;
    console.error(secret ? String(error.message).split(secret).join('[REDACTED]') : error.message);
    process.exitCode = 1;
  }
}
