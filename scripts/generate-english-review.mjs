import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeText, speechText} from '../dist/core.mjs';
import {atomicWrite, isPlausibleMp3, ENGINE, VOICE_ID, ENDPOINT} from './generate-fish-audio.mjs';
import {retryDelay} from './generate-recover-trial.mjs';

export const RECOVER_ID = '8c7b57756ded59cf6ce7';
export const REVIEW_PROFILE = 'english-review-v3';
const CUE = '[Native British English pronunciation, clear neutral English vowels] ';
const PHONES = '<|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.';
export const REVIEW_SPECS = Object.freeze([
  Object.freeze({name: 'a', text: CUE + 'Recover.', temperature: 0.3}),
  Object.freeze({name: 'b', text: CUE + PHONES, temperature: 0.3}),
  Object.freeze({name: 'c', text: CUE + PHONES, temperature: 0.5})
]);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const run = promisify(execFile);
const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL('../.english-review/', import.meta.url));
const SOFTEN_SCRIPT = fileURLToPath(new URL('./soften-fish-audio.py', import.meta.url));

async function verifyRecover(distDir) {
  const dictionary = JSON.parse(await readFile(join(distDir, 'dictionary.json'), 'utf8'));
  if (!Array.isArray(dictionary?.cards)) throw new Error('Dictionary must contain a cards array.');
  const matches = dictionary.cards.filter(card => card?.id === RECOVER_ID);
  if (matches.length !== 1 || typeof matches[0].word !== 'string' ||
      normalizeText(speechText(matches[0].word)) !== 'recover') {
    throw new Error('The current dictionary does not contain exactly one matching recover card; review stopped.');
  }
}

async function boundedAudio(response) {
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
    await response.body?.cancel();
    throw new Error('Oversized audio.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing audio.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error('Oversized audio.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function fetchReview({text, temperature, apiKey, fetchImpl, sleep, now}) {
  // Three fixed specimens, at most three attempts each. No model or voice fallback.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', model: ENGINE},
        body: JSON.stringify({text, temperature, reference_id: VOICE_ID,
          format: 'mp3', mp3_bitrate: 128, latency: 'normal'})
      });
    } catch { throw new Error('Fish request failed or timed out; review stopped.'); }
    if (!response.ok) {
      // Never read or log a server error body, which might contain credentials.
      await response.body?.cancel().catch(() => {});
      if ([429, 503].includes(response.status) && attempt < 2) {
        await sleep(retryDelay(response.headers.get('retry-after'), attempt, now()));
        continue;
      }
      throw new Error(`Fish HTTP ${Number(response.status)}; review stopped without paid fallback.`);
    }
    if (/json|text|html/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Fish returned a non-audio response; review stopped.');
    }
    let bytes;
    try { bytes = await boundedAudio(response); }
    catch { throw new Error('Fish audio transfer failed or exceeded the size limit; review stopped.'); }
    if (!isPlausibleMp3(bytes)) throw new Error('Fish returned invalid or truncated MP3 data; review stopped.');
    return bytes;
  }
}

async function soften({sourceDir, outputDir}) {
  await run('python3', [SOFTEN_SCRIPT, '--source', sourceDir, '--output', outputDir, '--denoise'], {timeout: 60000});
}

export async function generateEnglishReview({distDir = DEFAULT_DIST, outputDir = DEFAULT_OUTPUT,
  apiKey = process.env.FISH_API_KEY, engine = process.env.FISH_ENGINE || ENGINE,
  fetchImpl = globalThis.fetch, processAudio = soften,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set the server-side FISH_API_KEY secret.');
  if (engine !== ENGINE) throw new Error('Only s2.1-pro-free is allowed; paid model fallback is disabled.');
  // Check the live checkout before requests or output writes; never use a stale word/ID mapping.
  await verifyRecover(resolve(distDir));
  outputDir = resolve(outputDir);
  const metadata = {version: 1, profile: REVIEW_PROFILE, cardId: RECOVER_ID, word: 'recover',
    engine: ENGINE, voiceId: VOICE_ID, processing: 'accepted clean-1', complete: false,
    variants: REVIEW_SPECS.map(spec => ({...spec, raw: `raw/${spec.name}/${RECOVER_ID}.mp3`,
      processed: `processed/${spec.name}/${RECOVER_ID}.mp3`, ready: false}))};
  const saveMetadata = () => atomicWrite(join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  await saveMetadata();
  for (const variant of metadata.variants) {
    const bytes = await fetchReview({...variant, apiKey: apiKey.trim(), fetchImpl, sleep, now});
    await atomicWrite(join(outputDir, variant.raw), bytes);
    try {
      // Use the same processor and settings as accepted recordings; preserve each original.
      await processAudio({sourceDir: join(outputDir, 'raw', variant.name), outputDir: join(outputDir, 'processed', variant.name)});
      if (!isPlausibleMp3(await readFile(join(outputDir, variant.processed)))) throw new Error('Invalid processed audio.');
    } catch { throw new Error('Accepted audio processing failed; original review audio remains preserved.'); }
    variant.ready = true;
    await saveMetadata();
  }
  metadata.complete = true;
  await saveMetadata();
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('This fixed three-recording review accepts no CLI arguments.');
    const result = await generateEnglishReview();
    console.log(`English pronunciation review: ${result.variants.length} same-voice recordings prepared for listening.`);
  } catch (error) {
    const secret = process.env.FISH_API_KEY;
    console.error(secret ? String(error.message).split(secret).join('[REDACTED]') : error.message);
    process.exitCode = 1;
  }
}
