import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {isPlausibleMp3} from '../scripts/generate-fish-audio.mjs';
import {publishEnglishReview} from '../scripts/publish-english-review.mjs';

const run = promisify(execFile);
const id = '8c7b57756ded59cf6ce7';
const variants = ['a', 'b', 'c'];
const samplePath = variant => `dist/audio/english-review-v3/${variant}/${id}.mp3`;
const sample = marker => {
  const bytes = Buffer.alloc(417, marker);
  bytes.set([0xff, 0xfb, 0x90, 0xc0]);
  assert.equal(isPlausibleMp3(bytes), true);
  return bytes;
};
async function git(cwd, ...args) {
  return (await run('git', args, {cwd, encoding:'utf8'})).stdout.trim();
}
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), {recursive:true});
  await writeFile(join(root, path), content);
}
async function commit(repoDir, message) {
  await git(repoDir, 'add', '.');
  await git(repoDir, '-c', 'user.name=Review test', '-c', 'user.email=review-test@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', message);
  return git(repoDir, 'rev-parse', 'HEAD');
}
async function tree(repoDir, ref) {
  const lines = await git(repoDir, 'ls-tree', '-r', ref);
  return new Map(lines.split('\n').filter(Boolean).map(line => {
    const [metadata, path] = line.split('\t');
    return [path, metadata];
  }));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'english-review-publish-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const remote = join(root, 'origin.git');
  const writer = join(root, 'writer');
  const repoDir = join(root, 'stale-checkout');
  const outputDir = join(root, 'prepared');
  await git(root, 'init', '--bare', '--quiet', '--initial-branch=main', remote);
  await git(root, 'init', '--quiet', '--initial-branch=main', writer);
  await git(writer, 'remote', 'add', 'origin', remote);
  const protectedPaths = {
    'dist/dictionary.json': '{"cards":[{"id":"old","word":"recover"}]}\n',
    'dist/audio-index.json': '{"cards":["old"]}\n',
    'dist/fish-chonishvili-index.json': '{"voice":"accepted","cards":["old"]}\n',
    'dist/fish-chonishvili-en-gb-v1-index.json': '{"profile":"en-gb-v1","cards":["old"]}\n',
    'progress-stand-in.json': '{"stars":["old"],"ratings":{"old":"known"}}\n',
    'dist/index.html': '<p>Existing application</p>\n',
    [`dist/audio/${id}.mp3`]: sample(11),
    [`dist/audio/fish-chonishvili/${id}.mp3`]: sample(12),
    [`dist/audio/fish-chonishvili-en-gb-v1/${id}.mp3`]: sample(13),
    'dist/audio/unrelated.mp3': sample(14)
  };
  for (const [path, content] of Object.entries(protectedPaths)) await put(writer, path, content);
  // Cover an update as well as two additions, without changing any live voice.
  await put(writer, samplePath('a'), sample(1));
  const staleHead = await commit(writer, 'Initial collection and review sample');
  await git(writer, 'push', '--quiet', 'origin', 'main');
  await git(root, 'clone', '--quiet', remote, repoDir);
  // Another process imports words and audio after our checkout was made.
  protectedPaths['dist/dictionary.json'] = '{"cards":[{"id":"old","word":"recover"},{"id":"new","word":"fellowship"}]}\n';
  protectedPaths['dist/audio-index.json'] = '{"cards":["old","new"]}\n';
  protectedPaths['dist/fish-chonishvili-index.json'] = '{"voice":"accepted","cards":["old","new"]}\n';
  protectedPaths['dist/audio/new.mp3'] = sample(15);
  for (const [path, content] of Object.entries(protectedPaths)) await put(writer, path, content);
  const latestHead = await commit(writer, 'Concurrent dictionary and audio import');
  await git(writer, 'push', '--quiet', 'origin', 'main');
  for (const [i, variant] of variants.entries()) {
    await put(outputDir, `processed/${variant}/${id}.mp3`, sample(21 + i));
  }
  return {root, remote, writer, repoDir, outputDir, staleHead, latestHead, protectedPaths};
}

test('review publication uses newest main and changes exactly the three sample MP3 paths', async t => {
  const f = await fixture(t);
  await put(f.repoDir, 'local-staged.txt', 'Keep my staged work.\n');
  await git(f.repoDir, 'add', 'local-staged.txt');
  await put(f.repoDir, 'dist/index.html', '<p>Unsaved local application work</p>\n');
  const localStatus = await git(f.repoDir, 'status', '--porcelain=v1');
  const localIndex = await readFile(join(f.repoDir, '.git', 'index'));
  const before = await tree(f.remote, f.latestHead);

  const published = await publishEnglishReview({repoDir:f.repoDir, outputDir:f.outputDir});

  assert.match(published, /^[a-f0-9]{40}$/);
  assert.equal(await git(f.remote, 'rev-parse', 'main'), published);
  assert.equal(await git(f.remote, 'rev-parse', `${published}^`), f.latestHead,
    'the publication must extend current remote main, not stale local HEAD');
  const changed = (await git(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', published)).split('\n').sort();
  assert.deepEqual(changed, variants.map(samplePath).sort());
  const after = await tree(f.remote, published);
  for (const [path, blob] of before) {
    if (!variants.map(samplePath).includes(path)) assert.equal(after.get(path), blob, `${path} must retain its exact Git blob and mode`);
  }
  for (const [i, variant] of variants.entries()) {
    const {stdout} = await run('git', ['show', `${published}:${samplePath(variant)}`], {cwd:f.remote, encoding:'buffer'});
    assert.deepEqual(stdout, sample(21 + i));
  }
  assert.equal(await git(f.repoDir, 'rev-parse', 'HEAD'), f.staleHead, 'publishing must not reset the checkout');
  assert.equal(await git(f.repoDir, 'status', '--porcelain=v1'), localStatus);
  assert.deepEqual(await readFile(join(f.repoDir, '.git', 'index')), localIndex, 'the caller staging index must remain unchanged');
  assert.equal(await readFile(join(f.repoDir, 'dist/index.html'), 'utf8'), '<p>Unsaved local application work</p>\n');
  assert.equal((await readdir(f.outputDir)).some(name => name.startsWith('publish-index-')), false);

  const count = await git(f.remote, 'rev-list', '--count', 'main');
  assert.equal(await publishEnglishReview({repoDir:f.repoDir, outputDir:f.outputDir}), published);
  assert.equal(await git(f.remote, 'rev-parse', 'main'), published);
  assert.equal(await git(f.remote, 'rev-list', '--count', 'main'), count, 'identical samples must not create an empty commit');
});

test('an invalid or missing sample prevents all publication', async t => {
  const f = await fixture(t);
  await writeFile(join(f.outputDir, 'processed', 'b', `${id}.mp3`), Buffer.from('{"error":"not audio"}'));
  await assert.rejects(publishEnglishReview({repoDir:f.repoDir, outputDir:f.outputDir}), /missing or invalid/);
  assert.equal(await git(f.remote, 'rev-parse', 'main'), f.latestHead);
  assert.equal(await git(f.repoDir, 'rev-parse', 'HEAD'), f.staleHead);
  assert.equal((await readdir(f.outputDir)).some(name => name.startsWith('publish-index-')), false);
  await writeFile(join(f.outputDir, 'processed', 'b', `${id}.mp3`), sample(22));
  await rm(join(f.outputDir, 'processed', 'c', `${id}.mp3`));
  await assert.rejects(publishEnglishReview({repoDir:f.repoDir, outputDir:f.outputDir}));
  assert.equal(await git(f.remote, 'rev-parse', 'main'), f.latestHead);
});

test('combined review extends fresh main with D alone and preserves A, B, C and every live asset', async t => {
  const f = await fixture(t);
  // All original comparison recordings already exist on the remote.
  await put(f.writer, samplePath('b'), sample(2));
  await put(f.writer, samplePath('c'), sample(3));
  const currentHead = await commit(f.writer, 'Complete the original comparison');
  await git(f.writer, 'push', '--quiet', 'origin', 'main');
  const before = await tree(f.remote, currentHead);
  const outputDir = join(f.root, '.english-review-combined');
  const combinedPath = `dist/audio/english-review-v4/d/${id}.mp3`;
  await put(outputDir, `processed/d/${id}.mp3`, sample(31));
  // Unrelated prepared files must never widen the publication allowlist.
  await put(outputDir, `processed/a/${id}.mp3`, sample(99));
  await put(f.repoDir, 'local-staged.txt', 'Unrelated staged work.\n');
  await git(f.repoDir, 'add', 'local-staged.txt');
  const localStatus = await git(f.repoDir, 'status', '--porcelain=v1');
  const localIndex = await readFile(join(f.repoDir, '.git', 'index'));

  const published = await publishEnglishReview({repoDir: f.repoDir, outputDir, review: 'combined'});

  assert.equal(await git(f.remote, 'rev-parse', 'main'), published);
  assert.equal(await git(f.remote, 'rev-parse', `${published}^`), currentHead);
  const changed = (await git(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', published)).split('\n');
  assert.deepEqual(changed, [combinedPath]);
  const after = await tree(f.remote, published);
  for (const [path, blob] of before) {
    assert.equal(after.get(path), blob, `${path} must preserve its exact Git blob and mode`);
  }
  assert.ok(variants.every(variant => after.has(samplePath(variant))));
  const {stdout} = await run('git', ['show', `${published}:${combinedPath}`], {cwd: f.remote, encoding: 'buffer'});
  assert.deepEqual(stdout, sample(31));
  assert.equal(await git(f.repoDir, 'rev-parse', 'HEAD'), f.staleHead);
  assert.equal(await git(f.repoDir, 'status', '--porcelain=v1'), localStatus);
  assert.deepEqual(await readFile(join(f.repoDir, '.git', 'index')), localIndex);
  assert.equal((await readdir(outputDir)).some(name => name.startsWith('publish-index-')), false);

  const count = await git(f.remote, 'rev-list', '--count', 'main');
  assert.equal(await publishEnglishReview({repoDir: f.repoDir, outputDir, review: 'combined'}), published);
  assert.equal(await git(f.remote, 'rev-list', '--count', 'main'), count,
    'repeating the same prepared sample creates no empty commit');
});

test('combined publication requires a valid D sample even if original comparison files are present', async t => {
  const f = await fixture(t);
  await assert.rejects(publishEnglishReview({repoDir: f.repoDir, outputDir: f.outputDir, review: 'combined'}), /missing or invalid/);
  await put(f.outputDir, `processed/d/${id}.mp3`, Buffer.from('not audio'));
  await assert.rejects(publishEnglishReview({repoDir: f.repoDir, outputDir: f.outputDir, review: 'combined'}), /missing or invalid/);
  assert.equal(await git(f.remote, 'rev-parse', 'main'), f.latestHead);
  assert.equal(await git(f.repoDir, 'rev-parse', 'HEAD'), f.staleHead);
});

test('unknown publication review mode is rejected before accessing git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'english-review-invalid-mode-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const review of ['unknown', '../combined', null]) {
    await assert.rejects(publishEnglishReview({repoDir: join(root, 'nonexistent-repository'),
      outputDir: join(root, 'nonexistent-output'), review}), error =>
      /review/i.test(error.message) && !/git|ENOENT/i.test(error.message),
    'bad modes must be validated before filesystem or git operations');
  }
  assert.deepEqual(await readdir(root), []);
});
