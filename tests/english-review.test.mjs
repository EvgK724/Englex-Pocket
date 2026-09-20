import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENGINE, VOICE_ID, ENDPOINT} from '../scripts/generate-fish-audio.mjs';
import {RECOVER_ID, REVIEW_SPECS, generateEnglishReview} from '../scripts/generate-english-review.mjs';

const mp3 = Buffer.alloc(417);
mp3.set([0xff, 0xfb, 0x90, 0xc0]);
const response = () => new Response(mp3, {headers: {'content-type': 'audio/mpeg'}});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'english-review-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const distDir = join(root, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'dictionary.json'), JSON.stringify({cards: [
    {id: RECOVER_ID, word: 'recover', translation: 'выздоравливать'},
    {id: '1234567890abcdef1234', word: 'another word'}
  ]}));
  await writeFile(join(distDir, 'fish-chonishvili-index.json'), '{"sentinel":"accepted-index"}\n');
  await writeFile(join(distDir, 'audio-index.json'), '{"sentinel":"original-index"}\n');
  await writeFile(join(distDir, `${RECOVER_ID}.mp3`), mp3);
  return {distDir, outputDir: join(root, '.english-review'), apiKey: 'fake-secret-for-test', engine: ENGINE,
    fetchImpl: async () => response(),
    processAudio: async ({sourceDir, outputDir}) => {
      await mkdir(outputDir, {recursive: true});
      await copyFile(join(sourceDir, `${RECOVER_ID}.mp3`), join(outputDir, `${RECOVER_ID}.mp3`));
    }};
}
async function snapshot(dir) {
  return Promise.all((await readdir(dir)).sort().map(async name => [name, await readFile(join(dir, name))]));
}

test('three new same-voice specimens use exact free model, cues, phones and temperatures without editing app data', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.distDir);
  const payloads = [];
  let active = 0, maximum = 0;
  const metadata = await generateEnglishReview({...options, fetchImpl: async (url, init) => {
    active++; maximum = Math.max(maximum, active);
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.model, 's2.1-pro-free');
    assert.equal(init.headers.Authorization, 'Bearer fake-secret-for-test');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.reference_id, '089f2e853e064d6fb15f5b5882914b52');
    assert.equal(body.reference_id, VOICE_ID);
    assert.equal(body.format, 'mp3');
    assert.equal(body.mp3_bitrate, 128);
    assert.equal(body.latency, 'normal');
    payloads.push({text: body.text, temperature: body.temperature});
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return response();
  }});
  assert.equal(maximum, 1);
  const cue = '[Native British English pronunciation, clear neutral English vowels] ';
  const phones = '<|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.';
  assert.deepEqual(payloads, [
    {text: cue + 'Recover.', temperature: 0.3},
    {text: cue + phones, temperature: 0.3},
    {text: cue + phones, temperature: 0.5}
  ]);
  assert.equal(metadata.complete, true);
  assert.equal(metadata.processing, 'accepted clean-1');
  assert.deepEqual(metadata.variants.map(item => item.name), ['a', 'b', 'c']);
  for (const item of metadata.variants) {
    assert.equal(item.ready, true);
    assert.deepEqual(await readFile(join(options.outputDir, item.raw)), mp3);
    assert.deepEqual(await readFile(join(options.outputDir, item.processed)), mp3);
  }
  const stored = await readFile(join(options.outputDir, 'metadata.json'), 'utf8');
  assert.equal(stored.includes(options.apiKey), false);
  assert.deepEqual(JSON.parse(stored), metadata);
  assert.deepEqual(await snapshot(options.distDir), before);
  assert.ok(Object.isFrozen(REVIEW_SPECS) && REVIEW_SPECS.every(Object.isFrozen));
});

test('checks current recover identity before any API call or output write', async t => {
  for (const cards of [[], [{id: RECOVER_ID, word: 'recovery'}],
    [{id: RECOVER_ID, word: 'recover'}, {id: RECOVER_ID, word: 'recover'}],
    [{id: RECOVER_ID, word: null}], [{id: '1234567890abcdef1234', word: 'recover'}]]) {
    const options = await fixture(t);
    await writeFile(join(options.distDir, 'dictionary.json'), JSON.stringify({cards}));
    let calls = 0;
    await assert.rejects(generateEnglishReview({...options, fetchImpl: async () => { calls++; return response(); }}), /matching recover card/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(options.outputDir, 'metadata.json')), {code: 'ENOENT'});
  }
  const options = await fixture(t);
  await writeFile(join(options.distDir, 'dictionary.json'), JSON.stringify({cards: [{id: RECOVER_ID, word: '  RECOVER  '}]}));
  assert.equal((await generateEnglishReview(options)).complete, true);
});

test('missing credentials and paid engine are rejected without requests or writes', async t => {
  for (const override of [{apiKey: ''}, {engine: 's2-pro'}]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateEnglishReview({...options, ...override, fetchImpl: async () => { calls++; return response(); }}), /secret|free/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(options.outputDir, 'metadata.json')), {code: 'ENOENT'});
  }
});

test('authentication, credit and other nontransient errors stop without revealing response bodies or secrets', async t => {
  for (const status of [401, 402, 500]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateEnglishReview({...options, fetchImpl: async () => {
      calls++; return new Response(`sensitive ${options.apiKey}`, {status});
    }}), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(options.apiKey));
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(join(options.outputDir, 'metadata.json'), 'utf8')).complete, false);
    await assert.rejects(readFile(join(options.outputDir, 'raw', 'a', `${RECOVER_ID}.mp3`)), {code: 'ENOENT'});
  }
});

test('only 429 and 503 retry, respecting Retry-After and a three-attempt bound', async t => {
  const options = await fixture(t);
  let calls = 0;
  const waits = [];
  await generateEnglishReview({...options, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('', {status: 429, headers: {'retry-after': '3'}});
    if (calls === 2) return new Response('', {status: 503});
    return response();
  }});
  assert.equal(calls, 5);
  assert.deepEqual(waits, [3000, 2000]);
  const failing = await fixture(t);
  calls = 0;
  await assert.rejects(generateEnglishReview({...failing, sleep: async () => {}, fetchImpl: async () => {
    calls++; return new Response('', {status: 503});
  }}), /HTTP 503/);
  assert.equal(calls, 3);
  const delayed = await fixture(t);
  calls = 0;
  await assert.rejects(generateEnglishReview({...delayed, fetchImpl: async () => {
    calls++; return new Response('', {status: 429, headers: {'retry-after': '31'}});
  }}), /longer than 30/);
  assert.equal(calls, 1);
});

test('non-audio, truncated, oversized and interrupted responses do not become MP3 files', async t => {
  for (const makeResponse of [
    () => new Response('{"error":"secret"}', {headers: {'content-type': 'application/json'}}),
    () => new Response('not audio', {headers: {'content-type': 'audio/mpeg'}}),
    () => new Response(mp3.subarray(0, 10), {headers: {'content-type': 'audio/mpeg'}}),
    () => new Response(mp3, {headers: {'content-length': String(11 * 1024 * 1024)}}),
    () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
    () => new Response(new ReadableStream({start(controller) { controller.error(new Error('private-body-error')); }}))
  ]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateEnglishReview({...options, fetchImpl: async () => { calls++; return makeResponse(); }}),
      error => !error.message.includes('private-body-error'));
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(options.outputDir, 'raw', 'a', `${RECOVER_ID}.mp3`)), {code: 'ENOENT'});
  }
});

test('network failures expose no thrown credentials and never trigger retries', async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(generateEnglishReview({...options, fetchImpl: async () => {
    calls++; throw new Error(options.apiKey);
  }}), error => /failed or timed out/.test(error.message) && !error.message.includes(options.apiKey));
  assert.equal(calls, 1);
});

test('processing failure keeps raw audio but never marks a variant ready or alters existing recordings', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.distDir);
  let calls = 0;
  await assert.rejects(generateEnglishReview({...options,
    fetchImpl: async () => { calls++; return response(); },
    processAudio: async () => { throw new Error(options.apiKey); }
  }), error => /processing failed/.test(error.message) && !error.message.includes(options.apiKey));
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(join(options.outputDir, 'raw', 'a', `${RECOVER_ID}.mp3`)), mp3);
  const metadata = JSON.parse(await readFile(join(options.outputDir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.complete, false);
  assert.equal(metadata.variants[0].ready, false);
  assert.deepEqual(await snapshot(options.distDir), before);
});
