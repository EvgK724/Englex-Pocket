import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ENGINE, VOICE_ID, ENDPOINT} from '../scripts/generate-fish-audio.mjs';
import {AUDIO_DIRECTORY, INDEX_FILENAME, PREFIX, PROFILE, generateFishLibrary, parseLibraryArgs, publishCheckpoint, retryDelay, selectTrialCards, voiceConfiguration} from '../scripts/generate-fish-library.mjs';

const run = promisify(execFile);
const mp3 = Buffer.alloc(417);
mp3.set([0xff, 0xfb, 0x90, 0xc0]);
const words = ['recover', 'doctor', 'teacher', 'fever', 'a bit more', 'healthcare', 'look after', 'cure', 'far away', 'take care of'];
const card = n => ({id: n.toString(16).padStart(20, '0'), word: words[n - 1] || `word ${n}`});
const index = cards => ({version: 1, voiceId: VOICE_ID, engine: ENGINE, profile: PROFILE, cards});
const response = () => new Response(mp3, {headers: {'content-type': 'audio/mpeg'}});
async function processAudio({sourceDir, outputDir}) {
  await mkdir(outputDir, {recursive: true});
  for (const name of await readdir(sourceDir)) await copyFile(join(sourceDir, name), join(outputDir, name));
}
async function fixture(t, count = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-library-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const distDir = join(dir, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'dictionary.json'), JSON.stringify({cards: Array.from({length: count}, (_, i) => card(i + 1))}));
  return {distDir, workDir: join(dir, 'work'), apiKey: 'fake-test-key', processAudio, fetchImpl: async () => response()};
}

test('CLI is default-trial, finite and cannot choose an engine or arbitrary command', () => {
  assert.deepEqual(parseLibraryArgs([]), {mode: 'trial', voice: 'english', publish: false, deadlineMinutes: 250});
  assert.deepEqual(parseLibraryArgs(['--mode', 'full', '--voice', 'accepted', '--publish', '--deadline-minutes', '20']), {mode: 'full', voice: 'accepted', publish: true, deadlineMinutes: 20});
  for (const args of [['--mode', 'everything'], ['--voice'], ['--voice', 'other'], ['--deadline-minutes', '251'], ['--deadline-minutes', '0'], ['--engine', 's2.1-pro'], ['--publish', '--publish'], ['--mode', 'full;echo']]) assert.throws(() => parseLibraryArgs(args));
  const cards = Array.from({length: 15}, (_, i) => card(i + 1));
  assert.deepEqual(selectTrialCards(cards).map(c => c.word), words);
});

test('credentials, free model and worker bounds are checked before mutation', async t => {
  const options = await fixture(t);
  for (const overrides of [{apiKey: ''}, {engine: 's2.1-pro'}, {concurrency: 5}, {deadlineMinutes: 251}, {mode: 'other'}, {voice: 'other'}, {checkpointSize: 51}]) {
    await assert.rejects(generateFishLibrary({...options, ...overrides}));
  }
  assert.deepEqual(await readdir(options.distDir), ['dictionary.json']);
  await assert.rejects(readFile(join(options.workDir, 'status.json')), {code: 'ENOENT'});
});

test('trial sends unchanged normalized text with experimental prefix, fixed free engine and at most four workers', async t => {
  const options = await fixture(t, 15);
  let active = 0, maximum = 0, calls = 0;
  const payloads = [];
  const status = await generateFishLibrary({...options, fetchImpl: async (url, init) => {
    calls++; active++; maximum = Math.max(maximum, active);
    assert.equal(url, ENDPOINT);
    assert.equal(init.headers.model, ENGINE);
    assert.equal(init.headers.Authorization, 'Bearer fake-test-key');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.reference_id, VOICE_ID);
    assert.equal(body.latency, 'normal');
    payloads.push(body.text);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    return response();
  }});
  assert.equal(calls, 10);
  assert.equal(maximum, 4);
  assert.deepEqual(new Set(payloads), new Set(words.map(word => PREFIX + word)));
  assert.equal(status.complete, true);
  assert.equal(status.available, 10);
  assert.equal(status.snapshotCount, 10);
  assert.deepEqual(JSON.parse(await readFile(join(options.distDir, INDEX_FILENAME))), index(Array.from({length: 10}, (_, i) => card(i + 1).id)));
  assert.equal((await readdir(join(options.workDir, 'raw', 'english'))).length, 10);
  await assert.rejects(readFile(join(options.distDir, 'fish-chonishvili-index.json')), {code: 'ENOENT'});
});

test('full run checkpoints every fifty, preserves other voice and resumes without resynthesis or processing', async t => {
  const options = await fixture(t, 53);
  await mkdir(join(options.distDir, 'audio', 'fish-chonishvili'), {recursive: true});
  await writeFile(join(options.distDir, 'audio', 'fish-chonishvili', `${card(1).id}.mp3`), 'accepted-old-voice');
  const published = [];
  let firstDeploys = 0;
  const status = await generateFishLibrary({...options, mode: 'full', publish: true,
    publisher: async ({ids}) => { published.push(ids); return 'a'.repeat(40); }, onPublish: async () => { firstDeploys++; }});
  assert.deepEqual(published.map(ids => ids.length), [50, 3]);
  assert.equal(firstDeploys, 1);
  assert.equal(status.available, 53);
  assert.equal(status.publishedCommits, 2);
  assert.equal(await readFile(join(options.distDir, 'audio', 'fish-chonishvili', `${card(1).id}.mp3`), 'utf8'), 'accepted-old-voice');
  const resumed = await generateFishLibrary({...options, mode: 'full', fetchImpl: () => assert.fail('must skip existing recordings'), processAudio: () => assert.fail('must not process accepted audio again')});
  assert.equal(resumed.generated, 0);
  assert.equal(resumed.complete, true);
});

test('accepted voice keeps five approved recordings, sends no accent prefix and stays separate from English files and originals', async t => {
  const options = await fixture(t, 8);
  const accepted = voiceConfiguration('accepted');
  const originalIds = [1, 2, 3, 4, 5].map(n => card(n).id);
  await mkdir(join(options.distDir, 'audio', accepted.audioDirectory), {recursive: true});
  const approved = Buffer.from(mp3); approved[approved.length - 1] = 9;
  for (const id of originalIds) await writeFile(join(options.distDir, 'audio', accepted.audioDirectory, `${id}.mp3`), approved);
  await writeFile(join(options.distDir, accepted.indexFilename), JSON.stringify({version: 1, voiceId: VOICE_ID, engine: ENGINE, cards: originalIds}));
  await mkdir(join(options.distDir, 'audio', AUDIO_DIRECTORY), {recursive: true});
  await writeFile(join(options.distDir, 'audio', AUDIO_DIRECTORY, `${card(8).id}.mp3`), approved);
  const previousEnglishIndex = JSON.stringify(index([card(8).id]));
  await writeFile(join(options.distDir, INDEX_FILENAME), previousEnglishIndex);
  await mkdir(join(options.workDir, 'raw', 'english'), {recursive: true});
  await writeFile(join(options.workDir, 'raw', 'english', `${card(6).id}.mp3`), approved);
  const requests = [];
  const processed = [];
  const result = await generateFishLibrary({...options, mode: 'full', voice: 'accepted',
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body).text); assert.equal(init.headers.model, ENGINE); return response(); },
    processAudio: async args => { processed.push(...await readdir(args.sourceDir)); await processAudio(args); }});
  assert.deepEqual(new Set(requests), new Set(['healthcare', 'look after', 'cure']));
  assert.deepEqual(new Set(processed), new Set([6, 7, 8].map(n => `${card(n).id}.mp3`)));
  assert.equal(result.voice, 'accepted');
  assert.equal(result.generated, 3);
  assert.equal(result.available, 8);
  const manifest = JSON.parse(await readFile(join(options.distDir, accepted.indexFilename)));
  assert.equal('profile' in manifest, false);
  assert.equal(manifest.cards.length, 8);
  for (const id of originalIds) assert.deepEqual(await readFile(join(options.distDir, 'audio', accepted.audioDirectory, `${id}.mp3`)), approved);
  assert.equal(await readFile(join(options.distDir, INDEX_FILENAME), 'utf8'), previousEnglishIndex);
  assert.deepEqual(await readFile(join(options.distDir, 'audio', AUDIO_DIRECTORY, `${card(8).id}.mp3`)), approved);
  assert.deepEqual(await readFile(join(options.workDir, 'raw', 'accepted', `${card(6).id}.mp3`)), mp3);
  assert.deepEqual(await readFile(join(options.workDir, 'raw', 'english', `${card(6).id}.mp3`)), approved);
});

test('progress deployment runs for the first and every tenth successful checkpoint', async t => {
  const options = await fixture(t, 21);
  let published = 0;
  const deployedAt = [];
  await generateFishLibrary({...options, mode: 'full', voice: 'accepted', checkpointSize: 1, publish: true,
    publisher: async ({voice}) => { assert.equal(voice, 'accepted'); published++; return 'c'.repeat(40); },
    onPublish: async () => { deployedAt.push(published); }});
  assert.deepEqual(deployedAt, [1, 10, 20]);
});

test('only 429/503 retry with bounded backoff and Retry-After, and retries stop after three attempts', async t => {
  const options = await fixture(t, 1);
  const delays = [];
  let calls = 0;
  await generateFishLibrary({...options, delay: async ms => { delays.push(ms); }, fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('', {status: 429, headers: {'retry-after': '3'}});
    if (calls === 2) return new Response('', {status: 503});
    return response();
  }});
  assert.deepEqual(delays, [3000, 2000]);
  assert.equal(calls, 3);
  assert.throws(() => retryDelay(new Response('', {status: 429, headers: {'retry-after': '3600'}}), 0), /long retry delay/);
  const failure = await fixture(t, 1);
  calls = 0;
  await assert.rejects(generateFishLibrary({...failure, delay: async () => {}, fetchImpl: async () => { calls++; return new Response('secret response body', {status: 503}); }}), /Fish HTTP 503/);
  assert.equal(calls, 3);
});

test('401/402 stop without retry, while completed recordings checkpoint before the error', async t => {
  for (const code of [401, 402]) {
    const options = await fixture(t, 5);
    let calls = 0;
    const published = [];
    await assert.rejects(generateFishLibrary({...options, concurrency: 1, publish: true,
      publisher: async ({ids}) => { published.push(ids); return 'b'.repeat(40); },
      fetchImpl: async () => ++calls === 1 ? response() : new Response('fake-test-key sensitive body', {status: code})}), new RegExp(`^Error: Fish HTTP ${code};`));
    assert.equal(calls, 2);
    assert.deepEqual(published, [[card(1).id]]);
    const status = JSON.parse(await readFile(join(options.workDir, 'status.json')));
    assert.equal(status.stopReason, 'error');
    assert.equal(status.publishedCommits, 1);
    assert.equal(status.available, 1);
    assert.equal(JSON.stringify(status).includes('fake-test-key'), false);
  }
});

test('invalid synthesis never enters public manifest, and deadline retains a finite partial checkpoint', async t => {
  const options = await fixture(t, 4);
  await assert.rejects(generateFishLibrary({...options, fetchImpl: async () => new Response('{"error":"bad"}', {headers: {'content-type': 'application/json'}})}), /non-audio/);
  await assert.rejects(readFile(join(options.distDir, INDEX_FILENAME)), {code: 'ENOENT'});
  let clock = 0;
  const partial = await generateFishLibrary({...options, now: () => clock, concurrency: 1, deadlineMinutes: 1,
    fetchImpl: async () => { clock += 60001; return response(); }});
  assert.equal(partial.generated, 1);
  assert.equal(partial.remaining, 3);
  assert.equal(partial.complete, false);
  assert.equal(partial.stopReason, 'deadline');
  assert.equal(JSON.parse(await readFile(join(options.workDir, 'queue.json'))).cards.length, 4);
});

test('existing raw original is reused and processed once after a failed processing attempt', async t => {
  const options = await fixture(t, 1);
  await assert.rejects(generateFishLibrary({...options, processAudio: async () => { throw new Error('processor failed'); }}), /processor failed/);
  assert.deepEqual(await readFile(join(options.workDir, 'raw', 'english', `${card(1).id}.mp3`)), mp3);
  const result = await generateFishLibrary({...options, fetchImpl: async () => assert.fail('raw recovery must not synthesize again')});
  assert.equal(result.available, 1);
});

test('publisher commits only Fish paths on newest main, preserves dictionary changes, and never resets working copy', async t => {
  for (const voice of ['english', 'accepted']) {
  const config = voiceConfiguration(voice);
  const expectedIndex = cards => ({version: 1, voiceId: VOICE_ID, engine: ENGINE, ...(voice === 'english' ? {profile: PROFILE} : {}), cards});
  const options = await fixture(t, 2);
  const repoDir = join(options.workDir, 'repo');
  const remote = join(options.workDir, 'remote.git');
  await mkdir(repoDir, {recursive: true});
  const git = async (...args) => (await run('git', args, {cwd: repoDir})).stdout.trim();
  await run('git', ['init', '--bare', remote]);
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'tests@example.invalid'); await git('config', 'user.name', 'Tests');
  await git('remote', 'add', 'origin', remote);
  await mkdir(join(repoDir, 'dist'));
  await writeFile(join(repoDir, 'dist', 'dictionary.json'), JSON.stringify({cards: [card(1), card(2)]}));
  await writeFile(join(repoDir, 'dist', config.indexFilename), JSON.stringify(expectedIndex([])));
  await writeFile(join(repoDir, 'unrelated.txt'), 'original');
  await git('add', '.'); await git('commit', '-m', 'initial'); await git('push', '-u', 'origin', 'main');
  const firstHead = await git('rev-parse', 'HEAD');
  await writeFile(join(repoDir, 'dist', 'dictionary.json'), JSON.stringify({cards: [card(1), card(2), card(3)]}));
  await writeFile(join(repoDir, 'unrelated.txt'), 'concurrent Englex import');
  await git('add', '.'); await git('commit', '-m', 'concurrent dictionary sync'); await git('push', 'origin', 'main');
  const newMain = await git('rev-parse', 'HEAD');
  await git('checkout', '--detach', firstHead);
  await writeFile(join(repoDir, 'local-only.txt'), 'local changes must survive');
  await mkdir(join(options.distDir, 'audio', config.audioDirectory), {recursive: true});
  await writeFile(join(options.distDir, 'audio', config.audioDirectory, `${card(1).id}.mp3`), mp3);
  const sha = await publishCheckpoint({repoDir, distDir: options.distDir, workDir: options.workDir, ids: [card(1).id], voice});
  assert.equal(await git('rev-parse', `${sha}^`), newMain);
  assert.equal(await git('show', `${sha}:unrelated.txt`), 'concurrent Englex import');
  assert.equal(JSON.parse(await git('show', `${sha}:dist/dictionary.json`)).cards.length, 3);
  assert.deepEqual(JSON.parse(await git('show', `${sha}:dist/${config.indexFilename}`)), expectedIndex([card(1).id]));
  assert.equal(await git('rev-parse', 'HEAD'), firstHead);
  assert.equal(await readFile(join(repoDir, 'local-only.txt'), 'utf8'), 'local changes must survive');
  const changed = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', sha)).split('\n');
  assert.deepEqual(changed.sort(), [`dist/audio/${config.audioDirectory}/${card(1).id}.mp3`, `dist/${config.indexFilename}`].sort());
  }
});
