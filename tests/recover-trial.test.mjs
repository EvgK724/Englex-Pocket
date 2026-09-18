import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFile, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENGINE, VOICE_ID, ENDPOINT} from '../scripts/generate-fish-audio.mjs';
import {RECOVER_ID, TRIAL_SPECS, generateRecoverTrial, retryDelay} from '../scripts/generate-recover-trial.mjs';

const mp3 = Buffer.alloc(417);
mp3.set([0xff, 0xfb, 0x90, 0xc0]);
const response = () => new Response(mp3, {headers: {'content-type': 'audio/mpeg'}});
async function fixture(t) {
  const outputDir = await mkdtemp(join(tmpdir(), 'recover-trial-'));
  t.after(() => rm(outputDir, {recursive: true, force: true}));
  return {outputDir, apiKey: 'fake-secret-for-test', fetchImpl: async () => response(),
    processAudio: async ({sourceDir, outputDir}) => {
      await mkdir(outputDir, {recursive: true});
      await copyFile(join(sourceDir, `${RECOVER_ID}.mp3`), join(outputDir, `${RECOVER_ID}.mp3`));
    }};
}

test('exactly two fixed phoneme trials are sequential, free and preserve raw recordings', async t => {
  const options = await fixture(t);
  const payloads = [];
  let active = 0, maximum = 0;
  const metadata = await generateRecoverTrial({...options, fetchImpl: async (url, init) => {
    active++; maximum = Math.max(maximum, active);
    assert.equal(url, ENDPOINT);
    assert.equal(init.headers.model, ENGINE);
    assert.equal(ENGINE, 's2.1-pro-free');
    assert.equal(init.headers.Authorization, 'Bearer fake-secret-for-test');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.reference_id, VOICE_ID);
    payloads.push(body.text);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return response();
  }});
  assert.equal(maximum, 1);
  assert.deepEqual(payloads, [
    '<|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.',
    '[British English, Received Pronunciation] <|phoneme_start|>R IH0 K AH1 V AH0<|phoneme_end|>.'
  ]);
  assert.equal(metadata.complete, true);
  assert.equal(metadata.variants.length, 2);
  for (const item of metadata.variants) {
    assert.equal(item.ready, true);
    assert.deepEqual(await readFile(join(options.outputDir, item.raw)), mp3);
    assert.deepEqual(await readFile(join(options.outputDir, item.processed)), mp3);
  }
  assert.equal((await readFile(join(options.outputDir, 'metadata.json'), 'utf8')).includes(options.apiKey), false);
  assert.ok(Object.isFrozen(TRIAL_SPECS) && TRIAL_SPECS.every(Object.isFrozen));
});

test('authorization and credit errors stop immediately with no body or secret disclosure', async t => {
  for (const status of [401, 402]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateRecoverTrial({...options, fetchImpl: async () => {
      calls++; return new Response(`sensitive ${options.apiKey}`, {status});
    }}), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(options.apiKey));
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(options.outputDir, 'raw', 'A', `${RECOVER_ID}.mp3`)), {code: 'ENOENT'});
  }
});

test('transient failures retry only up to three attempts and respect Retry-After', async t => {
  const options = await fixture(t);
  let calls = 0;
  const waits = [];
  await generateRecoverTrial({...options, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('', {status: 429, headers: {'retry-after': '3'}});
    if (calls === 2) return new Response('', {status: 503});
    return response();
  }});
  assert.equal(calls, 4);
  assert.deepEqual(waits, [3000, 2000]);
  calls = 0;
  await assert.rejects(generateRecoverTrial({...options, sleep: async () => {}, fetchImpl: async () => {
    calls++; return new Response('', {status: 503});
  }}), /HTTP 503/);
  assert.equal(calls, 3);
  assert.throws(() => retryDelay('31', 0), /longer than 30/);
  assert.equal(retryDelay('Wed, 01 Jan 2025 00:00:05 GMT', 0, Date.parse('2025-01-01T00:00:00Z')), 5000);
});

test('invalid payloads and oversized streams never become recordings', async t => {
  for (const makeResponse of [
    () => new Response('{"error":"secret"}', {headers: {'content-type': 'application/json'}}),
    () => new Response('not audio', {headers: {'content-type': 'audio/mpeg'}}),
    () => new Response(mp3.subarray(0, 10), {headers: {'content-type': 'audio/mpeg'}}),
    () => new Response(mp3, {headers: {'content-length': String(11 * 1024 * 1024)}}),
    () => new Response(new Uint8Array(10 * 1024 * 1024 + 1))
  ]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(generateRecoverTrial({...options, fetchImpl: async () => { calls++; return makeResponse(); }}));
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(options.outputDir, 'raw', 'A', `${RECOVER_ID}.mp3`)), {code: 'ENOENT'});
  }
});

test('failed network request does not disclose thrown credentials or trigger retries', async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(generateRecoverTrial({...options, fetchImpl: async () => {
    calls++; throw new Error(options.apiKey);
  }}), error => /failed or timed out/.test(error.message) && !error.message.includes(options.apiKey));
  assert.equal(calls, 1);
});
