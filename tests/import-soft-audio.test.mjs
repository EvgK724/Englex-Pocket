import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeSoftAudioBundle, importSoftAudio, MAX_BUNDLE_BYTES, MAX_RECORDING_BYTES} from '../scripts/import-soft-audio.mjs';

const id = n => n.toString(16).padStart(20, '0');
const mp3 = n => { const audio = Buffer.alloc(417, n); audio.set([0xff, 0xfb, 0x90, 0xc0]); return audio; };
const row = (n, word, audio = mp3(n)) => ({id: id(n), word, audioBase64: audio.toString('base64')});
const raw = recordings => ({version: 1, provider: 'AI Voice Generator', voice: 'delicate', recordings});
const bundle = recordings => Buffer.from(JSON.stringify(raw(recordings)));
const audioPath = n => `audio/${id(n)}.mp3`;
const dictionary = {metadata: {count: 3}, cards: [
  {id: id(1), word: 'Signature.'}, {id: id(2), word: 'recover'}, {id: id(3), word: 'work {v}'}
]};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'soft-audio-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const distDir = join(root, 'dist');
  await mkdir(join(distDir, 'audio'), {recursive: true});
  const dictionaryBytes = JSON.stringify(dictionary);
  await writeFile(join(distDir, 'dictionary.json'), dictionaryBytes);
  const previous = {version: 1, provider: 'AI Voice Generator', voice: 'delicate', count: 1, cards: [id(1)],
    voiceOverrides: {[id(1)]: {voice: 'childlike-robot-trial-v1', sourceVoice: 'crisp', sourceText: 'Signature.', pitchScale: 1.3}},
    preservedMetadata: {note: 'Keep original metadata byte values'}};
  const indexBytes = JSON.stringify(previous);
  await writeFile(join(distDir, 'audio-index.json'), indexBytes);
  await writeFile(join(distDir, audioPath(1)), mp3(9));
  await writeFile(join(distDir, 'englex-ai-index.json'), 'unrelated Englex metadata');
  return {root, distDir, previous, indexBytes, dictionaryBytes};
}

test('bounded bundle validation rejects false provenance, URL fields, noncanonical payloads and ambiguous IDs', () => {
  const valid = row(2, 'recover');
  assert.deepEqual(decodeSoftAudioBundle(bundle([valid])), [{id: id(2), word: 'recover', audio: mp3(2)}]);
  assert.equal(decodeSoftAudioBundle(bundle([valid, valid])).length, 1);
  for (const invalid of [
    {...raw([valid]), provider: 'Fish'}, {...raw([valid]), voice: 'crisp'}, {...raw([valid]), version: 2},
    {...raw([valid]), cookie: 'never accepted'}, raw([{...valid, id: '../audio'}]), raw([{...valid, word: ''}]),
    raw([{...valid, url: 'https://example.invalid/?token=secret'}]), raw([{...valid, audioBase64: valid.audioBase64 + '\n'}]),
    raw([{...valid, audioBase64: 'YWJjZA=='}]), raw([{...valid, audioBase64: Buffer.alloc(MAX_RECORDING_BYTES + 1).toString('base64')}]),
    raw(Array.from({length: 1001}, () => valid)), raw([valid, row(2, 'recover', mp3(4))]), raw([valid, row(2, 'Recover')])
  ]) assert.throws(() => decodeSoftAudioBundle(Buffer.from(JSON.stringify(invalid))));
  assert.throws(() => decodeSoftAudioBundle(Buffer.alloc(MAX_BUNDLE_BYTES + 1)), /20 MiB/);
  assert.throws(() => decodeSoftAudioBundle(Buffer.from('broken JSON')), /not valid JSON/);
});

test('fills absent recordings while preserving existing MP3, special override and every unrelated field', async t => {
  const f = await fixture(t);
  const result = await importSoftAudio({...f, bundle: bundle([row(1, 'Signature.'), row(3, 'work {v}'), row(2, 'recover')])});
  assert.equal(result.added, 2); assert.equal(result.writtenFiles, 2); assert.equal(result.total, 3);
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].id, id(1));
  assert.deepEqual(await readFile(join(f.distDir, audioPath(1))), mp3(9));
  assert.deepEqual(await readFile(join(f.distDir, audioPath(2))), mp3(2));
  assert.deepEqual(await readFile(join(f.distDir, audioPath(3))), mp3(3));
  const updated = JSON.parse(await readFile(join(f.distDir, 'audio-index.json')));
  assert.deepEqual(updated, {...f.previous, count: 3, cards: [id(1), id(2), id(3)]});
  assert.equal(await readFile(join(f.distDir, 'dictionary.json'), 'utf8'), f.dictionaryBytes);
  assert.equal(await readFile(join(f.distDir, 'englex-ai-index.json'), 'utf8'), 'unrelated Englex metadata');
  const bytes = await readFile(join(f.distDir, 'audio-index.json'));
  const second = await importSoftAudio({...f, bundle: bundle([row(2, 'recover'), row(3, 'work {v}')])});
  assert.equal(second.changed, false); assert.equal(second.unchanged, 2);
  assert.deepEqual(await readFile(join(f.distDir, 'audio-index.json')), bytes);
});

test('all IDs and words must match exactly before any writes, including already indexed cards', async t => {
  const f = await fixture(t);
  for (const bad of [row(2, 'Recover'), row(2, 'recover '), row(3, 'work'), row(99, 'recover'), row(1, 'signature')]) {
    await assert.rejects(importSoftAudio({...f, bundle: bundle([row(2, 'recover'), bad])}), /exactly match|Conflicting/);
    assert.deepEqual(await readdir(join(f.distDir, 'audio')), [`${id(1)}.mp3`]);
    assert.equal(await readFile(join(f.distDir, 'audio-index.json'), 'utf8'), f.indexBytes);
  }
});

test('existing unindexed different MP3 never acquires false delicate provenance', async t => {
  const f = await fixture(t);
  await writeFile(join(f.distDir, audioPath(2)), mp3(99));
  const result = await importSoftAudio({...f, bundle: bundle([row(2, 'recover')])});
  assert.equal(result.changed, false); assert.equal(result.added, 0); assert.equal(result.conflicts.length, 1);
  assert.deepEqual(await readFile(join(f.distDir, audioPath(2))), mp3(99));
  assert.equal(await readFile(join(f.distDir, 'audio-index.json'), 'utf8'), f.indexBytes);
});

test('identical unindexed audio can be indexed without replacement and indexed missing audio can be restored', async t => {
  const f = await fixture(t);
  await writeFile(join(f.distDir, audioPath(2)), mp3(2));
  let result = await importSoftAudio({...f, bundle: bundle([row(2, 'recover')])});
  assert.equal(result.added, 1); assert.equal(result.writtenFiles, 0);
  await rm(join(f.distDir, audioPath(2)));
  const indexBytes = await readFile(join(f.distDir, 'audio-index.json'));
  result = await importSoftAudio({...f, bundle: bundle([row(2, 'recover')])});
  assert.equal(result.added, 0); assert.equal(result.writtenFiles, 1); assert.equal(result.total, 2);
  assert.deepEqual(await readFile(join(f.distDir, 'audio-index.json')), indexBytes);
});

test('invalid current index is never replaced', async t => {
  const f = await fixture(t);
  for (const bad of [{...f.previous, count: 0}, {...f.previous, voice: 'other'}, {...f.previous, cards: [id(1), id(1)], count: 2},
    {...f.previous, voiceOverrides: {[id(99)]: {voice: 'foreign'}}}]) {
    const bytes = JSON.stringify(bad);
    await writeFile(join(f.distDir, 'audio-index.json'), bytes);
    await assert.rejects(importSoftAudio({...f, bundle: bundle([row(2, 'recover')])}), /index|overrides/);
    assert.equal(await readFile(join(f.distDir, 'audio-index.json'), 'utf8'), bytes);
    await assert.rejects(readFile(join(f.distDir, audioPath(2))), {code: 'ENOENT'});
  }
});

test('delicate audio cannot restore a missing file labeled as a different voice override', async t => {
  const f = await fixture(t);
  await rm(join(f.distDir, audioPath(1)));
  await assert.rejects(importSoftAudio({...f, bundle: bundle([row(2, 'recover'), row(1, 'Signature.')])}), /different voice override/);
  assert.deepEqual(await readdir(join(f.distDir, 'audio')), []);
  assert.equal(await readFile(join(f.distDir, 'audio-index.json'), 'utf8'), f.indexBytes);
});
