import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importEnglexAudio} from '../scripts/import-englex-audio.mjs';

const id = n => n.toString(16).padStart(20, '0');
const recordingPath = n => `audio/englex-ai/${id(n)}.mp3`;
const mp3 = n => { const data = Buffer.alloc(417, n); data.set([0xff, 0xfb, 0x90, 0xc0]); return data; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'englex-ai-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const distDir = join(root, 'dist');
  const captures = join(root, 'captures');
  await mkdir(distDir); await mkdir(captures);
  const dictionary = {metadata: {through: '2026-09-19', total: 3}, cards: [
    {id: id(1), word: 'recover', translation: 'выздороветь'},
    {id: id(2), word: 'Recover', translation: 'вернуть'},
    {id: id(3), word: 'work {v}', translation: 'работать'}
  ]};
  const dictionaryBytes = JSON.stringify(dictionary);
  await writeFile(join(distDir, 'dictionary.json'), dictionaryBytes);
  await writeFile(join(distDir, 'audio-index.json'), 'original soft voice index');
  await writeFile(join(captures, 'recover.mp3'), mp3(1));
  await writeFile(join(captures, 'other.mp3'), mp3(2));
  const inputFile = join(captures, 'captured-ai.json');
  const input = async rows => writeFile(inputFile, JSON.stringify(rows));
  return {root, distDir, captures, dictionary, dictionaryBytes, inputFile, input};
}

test('one captured original reaches every exact normalized sense while annotations remain significant', async t => {
  const f = await fixture(t);
  await f.input([{word: '  ＲＥＣＯＶＥＲ  ', file: 'recover.mp3'}, {word: 'recover', file: 'recover.mp3'},
    {word: 'work', file: 'other.mp3'}]);
  const result = await importEnglexAudio(f);
  assert.deepEqual(result, {changed: true, capturedWords: 2, matchedCards: 2, added: 2, writtenFiles: 2,
    unchanged: 0, unmatchedWords: ['work'], conflicts: [], total: 2});
  for (const n of [1, 2]) assert.deepEqual(await readFile(join(f.distDir, recordingPath(n))), mp3(1));
  await assert.rejects(readFile(join(f.distDir, recordingPath(3))), {code: 'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(join(f.distDir, 'englex-ai-index.json'))),
    {version: 1, source: 'englex-ai', recordings: {[id(1)]: recordingPath(1), [id(2)]: recordingPath(2)}});
  assert.equal(await readFile(join(f.distDir, 'dictionary.json'), 'utf8'), f.dictionaryBytes);
  assert.equal(await readFile(join(f.distDir, 'audio-index.json'), 'utf8'), 'original soft voice index');
  assert.deepEqual(await readFile(join(f.captures, 'recover.mp3')), mp3(1));
});

test('reruns are byte-identical no-ops and a later sense reuses captured audio without changing card IDs', async t => {
  const f = await fixture(t);
  await f.input([{word: 'recover', file: join(f.captures, 'recover.mp3')}]);
  await importEnglexAudio(f);
  const manifestBytes = await readFile(join(f.distDir, 'englex-ai-index.json'));
  const second = await importEnglexAudio(f);
  assert.equal(second.changed, false); assert.equal(second.added, 0); assert.equal(second.unchanged, 2);
  assert.deepEqual(await readFile(join(f.distDir, 'englex-ai-index.json')), manifestBytes);
  f.dictionary.cards.push({id: id(4), word: 'recover', translation: 'восстановиться'});
  const futureBytes = JSON.stringify(f.dictionary);
  await writeFile(join(f.distDir, 'dictionary.json'), futureBytes);
  const future = await importEnglexAudio(f);
  assert.equal(future.added, 1); assert.equal(future.writtenFiles, 1); assert.equal(future.total, 3);
  assert.deepEqual(await readFile(join(f.distDir, recordingPath(4))), mp3(1));
  assert.equal(await readFile(join(f.distDir, 'dictionary.json'), 'utf8'), futureBytes);
});

test('existing different MP3s and unrelated manifest entries survive with explicit conflict reports', async t => {
  const f = await fixture(t);
  await mkdir(join(f.distDir, 'audio', 'englex-ai'), {recursive: true});
  await writeFile(join(f.distDir, recordingPath(1)), mp3(9));
  await writeFile(join(f.distDir, recordingPath(3)), mp3(3));
  const previous = {version: 1, source: 'englex-ai', recordings: {[id(1)]: recordingPath(1), [id(3)]: recordingPath(3)}};
  await writeFile(join(f.distDir, 'englex-ai-index.json'), JSON.stringify(previous));
  await f.input([{word: 'recover', file: 'recover.mp3'}]);
  const result = await importEnglexAudio(f);
  assert.equal(result.added, 1); assert.equal(result.total, 3);
  assert.deepEqual(result.conflicts, [{word: 'recover', ids: [id(1)], reason: 'Existing MP3 differs; it was preserved.'}]);
  assert.deepEqual(await readFile(join(f.distDir, recordingPath(1))), mp3(9));
  assert.deepEqual(await readFile(join(f.distDir, recordingPath(3))), mp3(3));
  assert.deepEqual(JSON.parse(await readFile(join(f.distDir, 'englex-ai-index.json'))).recordings,
    {...previous.recordings, [id(2)]: recordingPath(2)});
});

test('ambiguous source captures never select one recording arbitrarily', async t => {
  const f = await fixture(t);
  await f.input([{word: 'recover', file: 'recover.mp3'}, {word: 'RECOVER', file: 'other.mp3'}]);
  const result = await importEnglexAudio(f);
  assert.equal(result.changed, false); assert.equal(result.total, 0);
  assert.deepEqual(result.conflicts[0].ids, [id(1), id(2)]);
  await assert.rejects(readFile(join(f.distDir, 'englex-ai-index.json')), {code: 'ENOENT'});
  await assert.rejects(readdir(join(f.distDir, 'audio')), {code: 'ENOENT'});
});

test('all sources validate before writing; URLs, credentials fields, and fake audio are rejected', async t => {
  const f = await fixture(t);
  await writeFile(join(f.captures, 'fake.mp3'), 'not MP3');
  for (const row of [
    {word: 'recover', file: 'https://example.invalid/audio.mp3?token=secret'},
    {word: 'recover', file: 'file:///tmp/audio.mp3'},
    {word: 'recover', file: '//example.invalid/audio.mp3'},
    {word: 'recover', file: 'recover.mp3', token: 'secret'},
    {word: 'recover', file: 'fake.mp3'}
  ]) {
    await f.input([{word: 'work {v}', file: 'other.mp3'}, row]);
    await assert.rejects(importEnglexAudio(f));
    await assert.rejects(readFile(join(f.distDir, 'englex-ai-index.json')), {code: 'ENOENT'});
    await assert.rejects(readdir(join(f.distDir, 'audio')), {code: 'ENOENT'});
  }
});

test('invalid manifest or duplicate IDs abort without replacing any prior data', async t => {
  const f = await fixture(t);
  await f.input([{word: 'recover', file: 'recover.mp3'}]);
  const foreign = JSON.stringify({version: 1, source: 'englex-ai', recordings: {[id(99)]: recordingPath(99)}});
  await writeFile(join(f.distDir, 'englex-ai-index.json'), foreign);
  await assert.rejects(importEnglexAudio(f), /foreign/);
  assert.equal(await readFile(join(f.distDir, 'englex-ai-index.json'), 'utf8'), foreign);
  f.dictionary.cards.push({...f.dictionary.cards[0]});
  await writeFile(join(f.distDir, 'dictionary.json'), JSON.stringify(f.dictionary));
  await assert.rejects(importEnglexAudio(f), /duplicate ID/);
  await assert.rejects(readdir(join(f.distDir, 'audio')), {code: 'ENOENT'});
});
