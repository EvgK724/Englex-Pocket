import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENGINE, VOICE_ID, ENDPOINT, generateFishAudio, isPlausibleMp3, parseArgs} from '../scripts/generate-fish-audio.mjs';

const mp3 = Buffer.alloc(417);
mp3.set([0xff, 0xfb, 0x90, 0xc0]); // Complete MPEG-1 Layer III, 128 kbps, 44.1 kHz frame.
const card = n => ({id: n.toString(16).padStart(20, '0'), word: n === 1 ? '{give} [sb] sth' : `word ${n}`});
const manifest = cards => ({version: 1, voiceId: VOICE_ID, engine: ENGINE, cards});
async function fixture(t, count = 2) {
  const distDir = await mkdtemp(join(tmpdir(), 'fish-audio-test-'));
  t.after(() => rm(distDir, {recursive: true, force: true}));
  await writeFile(join(distDir, 'dictionary.json'), JSON.stringify({metadata: {}, cards: Array.from({length: count}, (_, i) => card(i + 1))}));
  return {distDir, apiKey: 'test-secret-never-real', engine: ENGINE};
}
const audioPath = (dir, id) => join(dir, 'audio', 'fish-chonishvili', `${id}.mp3`);
const indexPath = dir => join(dir, 'fish-chonishvili-index.json');
const readIndex = async dir => JSON.parse(await readFile(indexPath(dir), 'utf8'));
const audioResponse = () => new Response(mp3, {headers: {'content-type': 'audio/mpeg'}});

test('CLI defaults are bounded and reject invalid IDs, overrides and injected options', () => {
  assert.deepEqual(parseArgs([]), {limit: 5});
  assert.deepEqual(parseArgs(['--limit', '50', '--ids', `${card(1).id},${card(1).id}`]), {limit: 50, ids: [card(1).id]});
  for (const args of [['--limit', '0'], ['--limit', '51'], ['--limit', '1e1'], ['--limit', '1;echo nope'], ['--ids', '../bad'], ['--ids'], ['--engine', 's2.1-pro'], ['--limit', '1', '--limit', '2']]) assert.throws(() => parseArgs(args));
});

test('MP3 validation rejects JSON, a tag alone and a truncated frame', () => {
  assert.equal(isPlausibleMp3(mp3), true);
  const tag = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  assert.equal(isPlausibleMp3(Buffer.concat([tag, mp3])), true);
  for (const bytes of [Buffer.alloc(0), Buffer.from('{"error":"quota"}'), tag, mp3.subarray(0, 200), Buffer.alloc(500)]) assert.equal(isPlausibleMp3(bytes), false);
});

test('missing key fails before filesystem reads, writes or requests', async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(generateFishAudio({...options, distDir: join(options.distDir, 'absent'), apiKey: '', fetchImpl: () => { calls++; }}), /FISH_API_KEY/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(options.distDir), ['dictionary.json']);
});

test('unsupported engine and unknown IDs fail before requests or outputs', async t => {
  const options = await fixture(t);
  let calls = 0;
  const fetchImpl = () => { calls++; };
  await assert.rejects(generateFishAudio({...options, engine: 's2.1-pro', fetchImpl}), /Only s2.1-pro-free/);
  await assert.rejects(generateFishAudio({...options, ids: [card(99).id], fetchImpl}), /not in the dictionary/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(options.distDir), ['dictionary.json']);
});

test('default batch uses fixed endpoint, free header, voice and normalized speech; writes five complete files before indexing', async t => {
  const options = await fixture(t, 7);
  let calls = 0;
  const result = await generateFishAudio({...options, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, ENDPOINT);
    assert.equal(init.headers.model, ENGINE);
    assert.equal(init.headers.Authorization, `Bearer ${options.apiKey}`);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.reference_id, VOICE_ID);
    assert.equal(body.format, 'mp3');
    if (calls === 1) assert.equal(body.text, 'give somebody something');
    if (calls > 1) {
      const index = await readIndex(options.distDir);
      assert.equal(index.cards.length, calls - 1);
      for (const id of index.cards) assert.equal(isPlausibleMp3(await readFile(audioPath(options.distDir, id))), true);
    }
    return audioResponse();
  }});
  assert.deepEqual(result, {generated: 5, available: 5, remaining: 2});
  assert.equal(calls, 5);
  assert.deepEqual(await readIndex(options.distDir), manifest([1,2,3,4,5].map(n => card(n).id)));
  assert.equal((await readFile(indexPath(options.distDir), 'utf8')).includes(options.apiKey), false);
  assert.equal((await readdir(join(options.distDir, 'audio', 'fish-chonishvili'))).some(name => name.endsWith('.tmp')), false);
});

test('valid existing recordings are retained; orphaned audio is indexed and corrupt audio is regenerated', async t => {
  const options = await fixture(t, 3);
  await mkdir(join(options.distDir, 'audio', 'fish-chonishvili'), {recursive: true});
  await writeFile(audioPath(options.distDir, card(1).id), mp3);
  await writeFile(audioPath(options.distDir, card(2).id), 'corrupt');
  let calls = 0;
  const result = await generateFishAudio({...options, ids: [card(1).id, card(2).id], fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).text, 'word 2');
    return audioResponse();
  }});
  assert.equal(calls, 1);
  assert.deepEqual(result, {generated: 1, available: 2, remaining: 0});
  assert.deepEqual(await readFile(audioPath(options.distDir, card(1).id)), mp3);
  assert.deepEqual(await readIndex(options.distDir), manifest([card(1).id, card(2).id]));
  await generateFishAudio({...options, ids: [card(1).id, card(2).id], fetchImpl: () => { throw new Error('Must not request existing audio'); }});
});

test('authorization and transfer errors stop without leaking response text or advertising audio', async t => {
  for (const kind of ['auth', 'json', 'truncated', 'network']) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateFishAudio({...options, fetchImpl: async () => {
      calls++;
      if (kind === 'auth') return new Response(options.apiKey, {status: 401});
      if (kind === 'json') return new Response(`{"secret":"${options.apiKey}"}`, {headers: {'content-type': 'application/json'}});
      if (kind === 'network') throw new Error(options.apiKey);
      return new Response(mp3.subarray(0, 200), {headers: {'content-type': 'audio/mpeg'}});
    }}), error => !error.message.includes(options.apiKey));
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(options.distDir), ['dictionary.json']);
  }
});

test('a later failure preserves only completed audio and a resumable, correct index', async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(generateFishAudio({...options, fetchImpl: async () => ++calls === 1 ? audioResponse() : new Response('quota', {status: 402})}), /HTTP 402/);
  assert.deepEqual(await readIndex(options.distDir), manifest([card(1).id]));
  assert.deepEqual(await readdir(join(options.distDir, 'audio', 'fish-chonishvili')), [`${card(1).id}.mp3`]);
  const result = await generateFishAudio({...options, fetchImpl: async () => audioResponse()});
  assert.equal(result.generated, 1);
  assert.deepEqual(await readIndex(options.distDir), manifest([card(1).id, card(2).id]));
});

test('an incompatible index is not relabeled or overwritten', async t => {
  const options = await fixture(t);
  const previous = JSON.stringify({...manifest([]), voiceId: 'different-voice'});
  await writeFile(indexPath(options.distDir), previous);
  let calls = 0;
  await assert.rejects(generateFishAudio({...options, fetchImpl: () => { calls++; }}), /incompatible/);
  assert.equal(calls, 0);
  assert.equal(await readFile(indexPath(options.distDir), 'utf8'), previous);
});

test('sample selects newest missing cards first with stable ties', async t => {
  const options = await fixture(t, 3);
  await writeFile(join(options.distDir, 'dictionary.json'), JSON.stringify({metadata: {}, cards: [
    {...card(1), added: '2020-01-01'}, {...card(2), added: '2026-09-18'}, {...card(3), added: '2026-09-18'}
  ]}));
  const spoken = [];
  await generateFishAudio({...options, limit: 2, fetchImpl: async (_url, init) => { spoken.push(JSON.parse(init.body).text); return audioResponse(); }});
  assert.deepEqual(spoken, ['word 2', 'word 3']);
});

test('401 preserves existing audio and index byte for byte', async t => {
  const options = await fixture(t);
  await generateFishAudio({...options, limit: 1, fetchImpl: async () => audioResponse()});
  const previous = await readFile(indexPath(options.distDir));
  await assert.rejects(generateFishAudio({...options, fetchImpl: async () => new Response('unauthorized', {status: 401})}), /HTTP 401/);
  assert.deepEqual(await readFile(indexPath(options.distDir)), previous);
  assert.deepEqual(await readFile(audioPath(options.distDir, card(1).id)), mp3);
});

test('oversized streamed responses are cancelled without an audio file or index', async t => {
  const options = await fixture(t);
  let cancelled = false;
  const body = new ReadableStream({pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; }});
  await assert.rejects(generateFishAudio({...options, fetchImpl: async () => new Response(body, {headers: {'content-type': 'audio/mpeg'}})}), /transfer failed/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(options.distDir), ['dictionary.json']);
});
