import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BUNDLE_PATH, MAX_BUNDLE_BYTES, MAX_RECORDING_BYTES, decodeEnglexBundle, publishEnglexAudioBundle} from '../scripts/publish-englex-audio-bundle.mjs';

const run = promisify(execFile);
const id = n => n.toString(16).padStart(20, '0');
const card = (n, word = 'recover') => ({id: id(n), word, translation: `translation ${n}`});
const mp3 = n => { const bytes = Buffer.alloc(417, n); bytes.set([0xff, 0xfb, 0x90, 0xc0]); return bytes; };
const bundle = (word, bytes = mp3(1)) => Buffer.from(JSON.stringify({version: 1, recordings: [{word, audioBase64: bytes.toString('base64')}]}));
const index = recordings => JSON.stringify({version: 1, source: 'englex-ai', recordings});
const voicePath = n => `dist/audio/englex-ai/${id(n)}.mp3`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'englex-bundle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repoDir = join(root, 'repo'), remote = join(root, 'remote.git'), workDir = join(root, 'work');
  await mkdir(repoDir);
  const git = async (...args) => (await run('git', args, {cwd: repoDir})).stdout.trim();
  const gitBytes = async (...args) => (await run('git', args, {cwd: repoDir, encoding: 'buffer'})).stdout;
  await run('git', ['init', '--bare', remote]);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Tests'); await git('config', 'user.email', 'tests@example.invalid');
  await git('remote', 'add', 'origin', remote);
  const put = async (path, bytes) => { await mkdir(join(repoDir, path, '..'), {recursive: true}); await writeFile(join(repoDir, path), bytes); };
  const commit = async message => { await git('add', '.'); await git('commit', '-m', message); await git('push', '-u', 'origin', 'main'); return git('rev-parse', 'HEAD'); };
  await put('dist/dictionary.json', JSON.stringify({metadata: {total: 1}, cards: [card(1)]}));
  await put(BUNDLE_PATH, bundle('recover'));
  const sourceCommit = await commit('captured original input');
  return {root, repoDir, remote, workDir, git, gitBytes, put, commit, sourceCommit};
}

test('bundle validation accepts only bounded canonical MP3 payloads and no extra source metadata', () => {
  assert.deepEqual(decodeEnglexBundle(bundle('recover')), [{word: 'recover', audio: mp3(1)}]);
  const valid = {word: 'recover', audioBase64: mp3(1).toString('base64')};
  for (const raw of [
    {version: 1, recordings: [{...valid, url: 'https://example.invalid/?token=secret'}]},
    {version: 1, recordings: [{...valid, audioBase64: valid.audioBase64 + '\n'}]},
    {version: 1, recordings: [{...valid, audioBase64: 'YWJjZA=='}]},
    {version: 1, recordings: [{...valid, audioBase64: Buffer.alloc(MAX_RECORDING_BYTES + 1).toString('base64')}]},
    {version: 1, recordings: Array.from({length: 1001}, () => valid)},
    {version: 2, recordings: [valid]}, {version: 1, recordings: [valid], cookie: 'secret'}
  ]) assert.throws(() => decodeEnglexBundle(Buffer.from(JSON.stringify(raw))));
  assert.throws(() => decodeEnglexBundle(Buffer.alloc(MAX_BUNDLE_BYTES + 1)), /20 MiB/);
  assert.throws(() => decodeEnglexBundle(Buffer.from('not JSON')), /not valid JSON/);
});

test('exact event bundle merges onto newest dictionary and preserves Fish, replacement bundle, local work and original bytes', async t => {
  const f = await fixture(t);
  await f.put('dist/dictionary.json', JSON.stringify({metadata: {total: 3}, cards: [card(1), card(2), card(3, 'doctor')]}));
  await f.put('dist/fish-chonishvili-a-v1-index.json', 'concurrent Fish checkpoint');
  await f.put(BUNDLE_PATH, bundle('doctor', mp3(3)));
  const parent = await f.commit('concurrent dictionary and later bundle');
  await f.git('checkout', '--detach', f.sourceCommit);
  await f.put('local-only.txt', 'must survive');
  const beforeIndex = await readFile(join(f.repoDir, '.git', 'index'));
  const result = await publishEnglexAudioBundle(f);
  assert.equal(result.published, true); assert.equal(result.parent, parent); assert.equal(result.added, 2);
  assert.equal(await f.git('rev-parse', `${result.commit}^`), parent);
  assert.equal(await f.git('show', `${result.commit}:dist/fish-chonishvili-a-v1-index.json`), 'concurrent Fish checkpoint');
  assert.equal(JSON.parse(await f.git('show', `${result.commit}:dist/dictionary.json`)).cards.length, 3);
  assert.equal(JSON.parse(await f.git('show', `${result.commit}:${BUNDLE_PATH}`)).recordings[0].word, 'doctor');
  for (const n of [1, 2]) assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(n)}`), mp3(1));
  assert.deepEqual(JSON.parse(await f.git('show', `${result.commit}:dist/englex-ai-index.json`)).recordings,
    {[id(1)]: voicePath(1).slice(5), [id(2)]: voicePath(2).slice(5)});
  assert.deepEqual((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', result.commit)).split('\n').sort(),
    [voicePath(1), voicePath(2), 'dist/englex-ai-index.json'].sort());
  assert.equal(await f.git('rev-parse', 'HEAD'), f.sourceCommit);
  assert.equal(await readFile(join(f.repoDir, 'local-only.txt'), 'utf8'), 'must survive');
  assert.deepEqual(await readFile(join(f.repoDir, '.git', 'index')), beforeIndex);
  const rerun = await publishEnglexAudioBundle(f);
  assert.equal(rerun.published, false); assert.equal(rerun.changed, false); assert.equal(rerun.unchanged, 2);
  assert.equal(await f.git('rev-parse', 'origin/main'), result.commit);
});

test('push race rebuilds from latest main, retains concurrent entries and reports differing original recordings', async t => {
  const f = await fixture(t);
  await f.put('dist/dictionary.json', JSON.stringify({cards: [card(1), card(2), card(3, 'doctor')]}));
  await f.put(voicePath(1), mp3(9));
  await f.put('dist/englex-ai-index.json', index({[id(1)]: voicePath(1).slice(5)}));
  await f.commit('an existing original must not be replaced');
  let raceCommit;
  let attempts = 0;
  const result = await publishEnglexAudioBundle({...f, beforePush: async ({attempt}) => {
    attempts++;
    if (attempt !== 0) return;
    await f.put(voicePath(3), mp3(3));
    await f.put('dist/englex-ai-index.json', index({[id(1)]: voicePath(1).slice(5), [id(3)]: voicePath(3).slice(5)}));
    await f.put('dist/fish-chonishvili-a-v1-index.json', 'newest Fish progress');
    raceCommit = await f.commit('concurrent original recording and Fish progress');
  }});
  assert.equal(attempts, 2); assert.equal(result.parent, raceCommit); assert.equal(result.added, 1);
  assert.deepEqual(result.conflicts[0].ids, [id(1)]);
  assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(1)}`), mp3(9));
  assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(2)}`), mp3(1));
  assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(3)}`), mp3(3));
  assert.equal(await f.git('show', `${result.commit}:dist/fish-chonishvili-a-v1-index.json`), 'newest Fish progress');
  assert.equal(Object.keys(JSON.parse(await f.git('show', `${result.commit}:dist/englex-ai-index.json`)).recordings).length, 3);
});
