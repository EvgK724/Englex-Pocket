import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BUNDLE_PATH, publishSoftAudioBundle} from '../scripts/publish-soft-audio-bundle.mjs';

const run = promisify(execFile);
const id = n => n.toString(16).padStart(20, '0');
const card = (n, word = 'recover') => ({id: id(n), word, translation: `translation ${n}`});
const mp3 = n => { const audio = Buffer.alloc(417, n); audio.set([0xff, 0xfb, 0x90, 0xc0]); return audio; };
const bundle = (n, word = 'recover', audio = mp3(n)) => JSON.stringify({version: 1, provider: 'AI Voice Generator', voice: 'delicate',
  recordings: [{id: id(n), word, audioBase64: audio.toString('base64')}]});
const override = {[id(1)]: {voice: 'childlike-robot-trial-v1', sourceVoice: 'crisp', sourceText: 'Signature.', pitchScale: 1.3}};
const index = cards => JSON.stringify({version: 1, provider: 'AI Voice Generator', voice: 'delicate', count: cards.length, cards, voiceOverrides: override});
const voicePath = n => `dist/audio/${id(n)}.mp3`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'soft-audio-publish-'));
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
  await put('dist/dictionary.json', JSON.stringify({metadata: {count: 2}, cards: [card(1, 'Signature.'), card(2)]}));
  await put('dist/audio-index.json', index([id(1)])); await put(voicePath(1), mp3(9));
  await put(BUNDLE_PATH, bundle(2));
  const sourceCommit = await commit('captured soft input');
  return {root, repoDir, remote, workDir, git, gitBytes, put, commit, sourceCommit};
}

test('exact event bundle merges current main, keeps existing bytes/overrides, and touches only soft additions', async t => {
  const f = await fixture(t);
  await f.put('dist/dictionary.json', JSON.stringify({metadata: {count: 3}, cards: [card(1, 'Signature.'), card(2), card(3, 'doctor')]}));
  await f.put('dist/englex-ai-index.json', 'current Englex checkpoint');
  await f.put('dist/fish-chonishvili-a-v1-index.json', 'current A checkpoint');
  await f.put(BUNDLE_PATH, bundle(3, 'doctor'));
  const parent = await f.commit('concurrent dictionary and newer bundle');
  await f.git('checkout', '--detach', f.sourceCommit);
  await f.put('local-only.txt', 'preserve local work');
  const beforeIndex = await readFile(join(f.repoDir, '.git', 'index'));
  const result = await publishSoftAudioBundle(f);
  assert.equal(result.published, true); assert.equal(result.parent, parent); assert.equal(result.added, 1);
  assert.equal(await f.git('rev-parse', `${result.commit}^`), parent);
  assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(1)}`), mp3(9));
  assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(2)}`), mp3(2));
  assert.deepEqual(JSON.parse(await f.git('show', `${result.commit}:dist/audio-index.json`)), JSON.parse(index([id(1), id(2)])));
  assert.equal(JSON.parse(await f.git('show', `${result.commit}:dist/dictionary.json`)).cards.length, 3);
  assert.equal(await f.git('show', `${result.commit}:dist/englex-ai-index.json`), 'current Englex checkpoint');
  assert.equal(await f.git('show', `${result.commit}:dist/fish-chonishvili-a-v1-index.json`), 'current A checkpoint');
  assert.equal(JSON.parse(await f.git('show', `${result.commit}:${BUNDLE_PATH}`)).recordings[0].id, id(3));
  assert.deepEqual((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', result.commit)).split('\n').sort(), [voicePath(2), 'dist/audio-index.json'].sort());
  assert.equal(await f.git('rev-parse', 'HEAD'), f.sourceCommit);
  assert.equal(await readFile(join(f.repoDir, 'local-only.txt'), 'utf8'), 'preserve local work');
  assert.deepEqual(await readFile(join(f.repoDir, '.git', 'index')), beforeIndex);
  const second = await publishSoftAudioBundle(f);
  assert.equal(second.published, false); assert.equal(second.changed, false);
  assert.equal(await f.git('rev-parse', 'origin/main'), result.commit);
});

test('nonforced push conflict remerges a concurrent soft recording and unrelated updates', async t => {
  const f = await fixture(t);
  await f.put('dist/dictionary.json', JSON.stringify({cards: [card(1, 'Signature.'), card(2), card(3, 'doctor')]}));
  await f.commit('new dictionary');
  let raceCommit, attempts = 0;
  const result = await publishSoftAudioBundle({...f, beforePush: async ({attempt}) => {
    attempts++;
    if (attempt) return;
    await f.put(voicePath(3), mp3(3)); await f.put('dist/audio-index.json', index([id(1), id(3)]));
    await f.put('dist/fish-chonishvili-a-v1-index.json', 'newest A coverage');
    raceCommit = await f.commit('concurrent soft import');
  }});
  assert.equal(attempts, 2); assert.equal(result.parent, raceCommit); assert.equal(result.added, 1);
  assert.deepEqual(JSON.parse(await f.git('show', `${result.commit}:dist/audio-index.json`)), JSON.parse(index([id(1), id(3), id(2)])));
  for (const n of [1, 2, 3]) assert.deepEqual(await f.gitBytes('show', `${result.commit}:${voicePath(n)}`), mp3(n === 1 ? 9 : n));
  assert.equal(await f.git('show', `${result.commit}:dist/fish-chonishvili-a-v1-index.json`), 'newest A coverage');
});

test('stale word and wrong provider bundles cannot publish or mutate current main', async t => {
  const f = await fixture(t);
  await f.put('dist/dictionary.json', JSON.stringify({cards: [card(1, 'Signature.'), card(2, 'Recover')]}));
  const parent = await f.commit('word changed after capture');
  await assert.rejects(publishSoftAudioBundle(f), /exactly match/);
  assert.equal(await f.git('rev-parse', 'origin/main'), parent);
  await f.put(BUNDLE_PATH, JSON.stringify({...JSON.parse(bundle(2)), provider: 'Fish'}));
  const invalidCommit = await f.commit('invalid source provenance');
  await assert.rejects(publishSoftAudioBundle({...f, sourceCommit: invalidCommit}), /AI Voice Generator/);
  assert.equal(await f.git('rev-parse', 'origin/main'), invalidCommit);
});

test('concurrent same-ID audio wins and is never replaced by a retry', async t => {
  const f = await fixture(t);
  let winner;
  const result = await publishSoftAudioBundle({...f, beforePush: async ({attempt}) => {
    if (attempt) return;
    await f.put(voicePath(2), mp3(88)); await f.put('dist/audio-index.json', index([id(1), id(2)]));
    winner = await f.commit('another original-provider capture won');
  }});
  assert.equal(result.published, false); assert.equal(result.parent, winner); assert.equal(result.changed, false);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(await f.gitBytes('show', `${winner}:${voicePath(2)}`), mp3(88));
  assert.equal(await f.git('rev-parse', 'origin/main'), winner);
});
