import {copyFile, mkdir, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {speechText} from '../dist/core.mjs';
import {atomicWrite, isPlausibleMp3, ENGINE, VOICE_ID, ENDPOINT} from './generate-fish-audio.mjs';

export const PROFILE = 'en-gb-v1';
export const PREFIX = '[British English accent, non-rhotic pronunciation] ';
export const AUDIO_DIRECTORY = `fish-chonishvili-${PROFILE}`;
export const INDEX_FILENAME = `${AUDIO_DIRECTORY}-index.json`;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[a-f0-9]{20}$/;
const MAX_BYTES = 10 * 1024 * 1024;
const run = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function parseLibraryArgs(args) {
  const options = {mode: 'trial', publish: false, deadlineMinutes: 250};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (seen.has(name)) throw new Error('Duplicate option.');
    seen.add(name);
    if (name === '--publish') options.publish = true;
    else if (name === '--mode') {
      options.mode = args[++i];
      if (!['trial', 'full'].includes(options.mode)) throw new Error('Mode must be trial or full.');
    } else if (name === '--deadline-minutes') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 250) throw new Error('Deadline must be 1..250 minutes.');
      options.deadlineMinutes = Number(value);
    } else throw new Error('Use --mode trial|full, --publish and --deadline-minutes 1..250 only.');
  }
  return options;
}

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function validateDictionary(raw) {
  if (!Array.isArray(raw?.cards) || raw.cards.length > 10000) throw new Error('Dictionary must contain no more than 10000 cards.');
  const ids = new Set();
  for (const card of raw.cards) {
    if (!card || !ID.test(card.id || '') || ids.has(card.id) || typeof card.word !== 'string' ||
        !speechText(card.word) || speechText(card.word).length > 500) throw new Error('Invalid or duplicate dictionary card.');
    ids.add(card.id);
  }
  return raw.cards;
}

function validateIndex(raw, validIds) {
  if (!raw || raw.version !== 1 || raw.voiceId !== VOICE_ID || raw.engine !== ENGINE || raw.profile !== PROFILE ||
      !Array.isArray(raw.cards) || new Set(raw.cards).size !== raw.cards.length ||
      raw.cards.some(id => !ID.test(id) || !validIds.has(id))) throw new Error('Incompatible English voice manifest.');
  return raw.cards;
}

export function selectTrialCards(cards) {
  const selected = [];
  const add = card => { if (card && !selected.some(item => item.id === card.id) && selected.length < 10) selected.push(card); };
  // Existing dictionary entries only: no spelling changes or invented cards.
  for (const word of ['recover', 'doctor', 'teacher', 'fever', 'a bit more', 'healthcare', 'look after', 'cure', 'far away', 'take care of']) {
    add(cards.find(card => speechText(card.word).toLowerCase() === word));
  }
  add(cards.find(card => /r\s+[aeiou]/i.test(speechText(card.word))));
  for (const card of cards.filter(card => /r[.!?]?$/i.test(speechText(card.word)))) add(card);
  for (const card of cards) add(card);
  return selected;
}

export function retryDelay(response, attempt, now = Date.now()) {
  const raw = response.headers.get('retry-after');
  let instructed = 0;
  if (raw) instructed = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - now);
  if (!Number.isFinite(instructed) || instructed > 60000) throw new Error('Fish requested a long retry delay; stop and resume later.');
  return Math.max(1000 * 2 ** attempt, instructed);
}

async function fetchRecording(card, {apiKey, fetchImpl, delay, now, deadline}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: {'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', model: ENGINE},
        body: JSON.stringify({text: PREFIX + speechText(card.word), reference_id: VOICE_ID, format: 'mp3', mp3_bitrate: 128, latency: 'normal'})
      });
    } catch { throw new Error('Fish request failed or timed out; no paid fallback was attempted.'); }
    if ([429, 503].includes(response.status) && attempt < 2) {
      const wait = retryDelay(response, attempt, now());
      await response.body?.cancel().catch(() => {});
      if (now() + wait >= deadline) throw new Error('Retry would exceed the generation deadline.');
      await delay(wait);
      continue;
    }
    if (!response.ok) throw new Error(`Fish HTTP ${Number(response.status)}; generation stopped.`);
    if (/json|text|html/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Fish returned a non-audio or oversized response.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Fish returned an empty audio body.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Fish audio response exceeded the limit.'); }
        chunks.push(Buffer.from(value));
      }
    } catch { throw new Error('Fish audio transfer failed; no incomplete recording was saved.'); }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, size);
    if (!isPlausibleMp3(bytes)) throw new Error('Fish returned invalid or truncated MP3 data.');
    return bytes;
  }
  throw new Error('Fish transient retry limit reached.');
}

async function softenBatch({sourceDir, outputDir}) {
  try {
    await run('python3', [join(ROOT, 'scripts/soften-fish-audio.py'), '--source', sourceDir, '--output', outputDir, '--denoise'], {maxBuffer: 1024 * 1024});
  } catch { throw new Error('Audio processing failed; original recordings are retained for recovery.'); }
}

// An isolated index builds a commit on the latest main without checking out,
// resetting or overwriting concurrent dictionary imports. Push is never forced.
export async function publishCheckpoint({repoDir = ROOT, distDir, workDir, ids}) {
  if (!ids.length) return null;
  const indexFile = join(workDir, `publish-index-${randomUUID()}`);
  const git = async (args, extra = {}) => (await run('git', args, {
    cwd: repoDir, env: {...process.env, GIT_INDEX_FILE: indexFile}, maxBuffer: 20 * 1024 * 1024, ...extra
  })).stdout.trim();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await git(['fetch', '--quiet', 'origin', 'main']);
      const parent = await git(['rev-parse', 'origin/main']);
      const cards = validateDictionary(JSON.parse(await git(['show', `${parent}:dist/dictionary.json`])));
      const validIds = new Set(cards.map(card => card.id));
      const current = validateIndex(JSON.parse(await git(['show', `${parent}:dist/${INDEX_FILENAME}`])), validIds);
      const additions = ids.filter(id => validIds.has(id) && !current.includes(id));
      if (!additions.length) return null;
      await rm(indexFile, {force: true});
      await git(['read-tree', parent]);
      for (const id of additions) {
        const file = join(distDir, 'audio', AUDIO_DIRECTORY, `${id}.mp3`);
        if (!isPlausibleMp3(await readFile(file))) throw new Error('Invalid local checkpoint audio.');
        const blob = await git(['hash-object', '-w', file]);
        await git(['update-index', '--add', '--cacheinfo', `100644,${blob},dist/audio/${AUDIO_DIRECTORY}/${id}.mp3`]);
      }
      const combined = new Set([...current, ...additions]);
      const manifest = {version: 1, voiceId: VOICE_ID, engine: ENGINE, profile: PROFILE,
        cards: cards.filter(card => combined.has(card.id)).map(card => card.id)};
      const temporaryManifest = join(workDir, 'publish-manifest.json');
      await atomicWrite(temporaryManifest, JSON.stringify(manifest, null, 2) + '\n');
      const blob = await git(['hash-object', '-w', temporaryManifest]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},dist/${INDEX_FILENAME}`]);
      const tree = await git(['write-tree']);
      const commit = await git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit-tree', tree, '-p', parent, '-m', `Add ${additions.length} English Fish voice recordings (${PROFILE})`]);
      try {
        await git(['push', '--quiet', 'origin', `${commit}:refs/heads/main`]);
        return commit;
      } catch {
        if (attempt === 2) throw new Error('Checkpoint push failed; prepared files remain available as an artifact.');
      }
    }
  } catch (error) {
    // Git subprocess errors can contain authentication details: never surface them.
    if (error.message?.startsWith('Checkpoint push failed')) throw error;
    throw new Error('Checkpoint publication failed; prepared recordings were retained.');
  } finally { await rm(indexFile, {force: true}); }
}

export async function generateFishLibrary({distDir = join(ROOT, 'dist'), workDir = join(ROOT, '.fish-library'),
  mode = 'trial', apiKey = process.env.FISH_API_KEY, engine = process.env.FISH_ENGINE || ENGINE,
  concurrency = 4, deadlineMinutes = 250, fetchImpl = globalThis.fetch, processAudio = softenBatch,
  publish = false, publisher = publishCheckpoint, onFirstPublish = async () => {}, now = Date.now, delay = sleep, checkpointSize = 50} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set the server-side FISH_API_KEY secret.');
  if (engine !== ENGINE) throw new Error('Only s2.1-pro-free is permitted; paid fallback is disabled.');
  if (!['trial', 'full'].includes(mode)) throw new Error('Mode must be trial or full.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrency must be 1..4.');
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0 || deadlineMinutes > 250) throw new Error('Deadline must be within 250 minutes.');
  if (!Number.isInteger(checkpointSize) || checkpointSize < 1 || checkpointSize > 50) throw new Error('Checkpoint size must be 1..50.');
  distDir = resolve(distDir); workDir = resolve(workDir);
  const cards = validateDictionary(JSON.parse(await readFile(join(distDir, 'dictionary.json'), 'utf8')));
  const validIds = new Set(cards.map(card => card.id));
  const oldIndex = await optionalRead(join(distDir, INDEX_FILENAME));
  if (oldIndex) validateIndex(JSON.parse(oldIndex.toString()), validIds);
  const audioDir = join(distDir, 'audio', AUDIO_DIRECTORY);
  const available = new Set();
  for (const card of cards) {
    const bytes = await optionalRead(join(audioDir, `${card.id}.mp3`));
    if (bytes && isPlausibleMp3(bytes)) available.add(card.id);
  }
  const selected = mode === 'trial' ? selectTrialCards(cards) : cards;
  const pending = selected.filter(card => !available.has(card.id));
  const rawDir = join(workDir, 'raw');
  const deadline = now() + deadlineMinutes * 60000;
  const status = {profile: PROFILE, mode, snapshotCount: selected.length, generated: 0, available: available.size,
    remaining: pending.length, publishedCommits: 0, publishedSha: null, complete: pending.length === 0, stopReason: null};
  const writeStatus = () => atomicWrite(join(workDir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  const writeIndex = () => atomicWrite(join(distDir, INDEX_FILENAME), JSON.stringify({version: 1, voiceId: VOICE_ID, engine: ENGINE, profile: PROFILE,
    cards: cards.filter(card => available.has(card.id)).map(card => card.id)}, null, 2) + '\n');
  const publishIds = async ids => {
    if (!publish || !ids.length) return;
    const sha = await publisher({distDir, workDir, ids});
    if (sha) {
      status.publishedCommits++; status.publishedSha = sha;
      await writeStatus();
      if (status.publishedCommits === 1) await onFirstPublish();
    }
  };
  await mkdir(rawDir, {recursive: true});
  await atomicWrite(join(workDir, 'queue.json'), JSON.stringify({profile: PROFILE, mode, cards: selected.map(card => ({id: card.id, text: speechText(card.word)}))}, null, 2) + '\n');
  await writeStatus();
  try {
    // A restored artifact may contain completed files whose previous push failed.
    await publishIds(selected.filter(card => available.has(card.id)).map(card => card.id));
    for (let offset = 0; offset < pending.length; offset += checkpointSize) {
      if (now() >= deadline) { status.stopReason = 'deadline'; break; }
      const batch = pending.slice(offset, offset + checkpointSize);
      const sourceDir = join(workDir, 'batch-source');
      const outputDir = join(workDir, 'batch-processed');
      await rm(sourceDir, {recursive: true, force: true}); await rm(outputDir, {recursive: true, force: true});
      await mkdir(sourceDir, {recursive: true});
      const ready = [];
      let cursor = 0;
      let failure = null;
      await Promise.all(Array.from({length: Math.min(concurrency, batch.length)}, async () => {
        while (!failure && cursor < batch.length && now() < deadline) {
          const card = batch[cursor++];
          try {
            const saved = await optionalRead(join(rawDir, `${card.id}.mp3`));
            const bytes = saved && isPlausibleMp3(saved) ? saved : await fetchRecording(card, {apiKey: apiKey.trim(), fetchImpl, delay, now, deadline});
            await atomicWrite(join(rawDir, `${card.id}.mp3`), bytes);
            await copyFile(join(rawDir, `${card.id}.mp3`), join(sourceDir, `${card.id}.mp3`));
            ready.push(card);
          } catch (error) { failure = error; }
        }
      }));
      if (ready.length) {
        await processAudio({sourceDir, outputDir});
        // Validate the whole processed batch before adding any entry to the index.
        const processed = await Promise.all(ready.map(async card => ({card, bytes: await readFile(join(outputDir, `${card.id}.mp3`))})));
        if (processed.some(item => !isPlausibleMp3(item.bytes))) throw new Error('Processed batch contains invalid MP3 data.');
        for (const {card, bytes} of processed) {
          await atomicWrite(join(audioDir, `${card.id}.mp3`), bytes);
          available.add(card.id);
        }
        status.generated += ready.length;
        status.available = available.size;
        status.remaining = selected.filter(card => !available.has(card.id)).length;
        await writeIndex();
        await writeStatus();
        await publishIds(ready.map(card => card.id));
        await writeStatus();
      }
      if (failure) throw failure;
      if (ready.length < batch.length) { status.stopReason = 'deadline'; break; }
    }
    status.complete = status.remaining === 0;
    await writeIndex();
    await writeStatus();
    return status;
  } catch (error) {
    status.stopReason = 'error';
    await writeStatus();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const status = await generateFishLibrary({...parseLibraryArgs(process.argv.slice(2)), onFirstPublish: async () => {
      try { await run('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], {cwd: ROOT, maxBuffer: 1024 * 1024}); }
      catch { console.error('First deployment dispatch failed; the workflow will retry deployment after generation.'); }
    }});
    console.log(`English Fish voice: ${status.generated} prepared, ${status.available} available, ${status.remaining} selected recordings remaining.`);
    if (!status.complete) { console.error('Time limit reached; saved recordings are retained. Resume this finite queue with another manual run.'); process.exitCode = 2; }
  } catch (error) {
    const secret = process.env.FISH_API_KEY;
    console.error(secret ? String(error.message).split(secret).join('[REDACTED]') : error.message);
    process.exitCode = 1;
  }
}
