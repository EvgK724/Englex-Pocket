import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicWrite, isPlausibleMp3, ENGINE, VOICE_ID, ENDPOINT} from './generate-fish-audio.mjs';

export const RECOVER_ID = '8c7b57756ded59cf6ce7';
export const TRIAL_SPECS = Object.freeze([
  Object.freeze({name: 'A', text: '<|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.'}),
  Object.freeze({name: 'B', text: '[British English, Received Pronunciation] <|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.'})
]);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const run = promisify(execFile);
const DEFAULT_OUTPUT = fileURLToPath(new URL('../.recover-trial/', import.meta.url));
const SOFTEN_SCRIPT = fileURLToPath(new URL('./soften-fish-audio.py', import.meta.url));

// Retry-After is a lower bound: stop instead of retrying early when it exceeds
// this tiny experiment's 30-second waiting budget.
export function retryDelay(value, attempt, now = Date.now()) {
  let delay = 1000 * (2 ** attempt);
  if (value) {
    const seconds = Number(value);
    const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(requested)) delay = Math.max(delay, requested);
  }
  if (delay > 30000) throw new Error('Fish requested a retry wait longer than 30 seconds; experiment stopped.');
  return Math.max(0, delay);
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

async function fetchTrial({text, apiKey, fetchImpl, sleep, now}) {
  // At most three attempts per fixed specimen; no network-error or paid fallback.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', model: ENGINE},
        body: JSON.stringify({text, reference_id: VOICE_ID, format: 'mp3', mp3_bitrate: 128, latency: 'normal'})
      });
    } catch { throw new Error('Fish request failed or timed out; experiment stopped.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([429, 503].includes(response.status) && attempt < 2) {
        await sleep(retryDelay(response.headers.get('retry-after'), attempt, now()));
        continue;
      }
      throw new Error(`Fish HTTP ${Number(response.status)}; experiment stopped without paid fallback.`);
    }
    if (/json|text|html/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Fish returned a non-audio response; experiment stopped.');
    }
    let bytes;
    try { bytes = await boundedAudio(response); }
    catch { throw new Error('Fish audio transfer failed or exceeded the size limit; experiment stopped.'); }
    if (!isPlausibleMp3(bytes)) throw new Error('Fish returned invalid or truncated MP3 data; experiment stopped.');
    return bytes;
  }
}

async function soften({sourceDir, outputDir}) {
  try {
    await run('python3', [SOFTEN_SCRIPT, '--source', sourceDir, '--output', outputDir, '--denoise'], {timeout: 60000});
  } catch { throw new Error('Accepted audio processing failed; original trial audio remains preserved.'); }
}

export async function generateRecoverTrial({outputDir = DEFAULT_OUTPUT,
  apiKey = process.env.FISH_API_KEY, fetchImpl = globalThis.fetch,
  processAudio = soften, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set the server-side FISH_API_KEY secret.');
  if (process.env.FISH_ENGINE && process.env.FISH_ENGINE !== ENGINE) throw new Error('Only s2.1-pro-free is allowed.');
  outputDir = resolve(outputDir);
  const metadata = {version: 1, cardId: RECOVER_ID, word: 'recover', engine: ENGINE,
    voiceId: VOICE_ID, processing: 'accepted clean-1', complete: false,
    variants: TRIAL_SPECS.map(spec => ({...spec, raw: `raw/${spec.name}/${RECOVER_ID}.mp3`,
      processed: `processed/${spec.name}/${RECOVER_ID}.mp3`, ready: false}))};
  const saveMetadata = () => atomicWrite(join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  await saveMetadata();
  // Strictly one active request, leaving the four library workers independent.
  for (const variant of metadata.variants) {
    const bytes = await fetchTrial({text: variant.text, apiKey: apiKey.trim(), fetchImpl, sleep, now});
    await atomicWrite(join(outputDir, variant.raw), bytes);
    await processAudio({sourceDir: join(outputDir, 'raw', variant.name), outputDir: join(outputDir, 'processed', variant.name)});
    if (!isPlausibleMp3(await readFile(join(outputDir, variant.processed)))) throw new Error('Processed trial audio is invalid; experiment stopped.');
    variant.ready = true;
    await saveMetadata();
  }
  metadata.complete = true;
  await saveMetadata();
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('This fixed two-recording trial accepts no CLI arguments.');
    const result = await generateRecoverTrial();
    console.log(`Recover experiment: ${result.variants.length} recordings prepared for listening review.`);
  } catch (error) {
    const secret = process.env.FISH_API_KEY;
    console.error(secret ? String(error.message).split(secret).join('[REDACTED]') : error.message);
    process.exitCode = 1;
  }
}
