import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {assetUrl} from '../dist/paths.mjs';
import {FISH_PROFILES, validateFishManifest} from '../dist/fish-voice.mjs';
import {validateChonishviliAManifest, validateEnglexAIManifest} from '../dist/voice-options.mjs';
import {ORIGINAL_COUNT, validateDictionary, validateAudioIndex} from './dictionary-integrity.mjs';

const root = new URL('../dist/', import.meta.url);
const read = name => readFile(new URL(name, root));
const dictionaryBytes = await read('dictionary.json');
const dictionary = JSON.parse(dictionaryBytes);
const index = JSON.parse(await read('audio-index.json'));
validateDictionary(dictionary);
// New words can use device speech until a recording is available. Every
// recording declared by the index must still belong to a card and exist.
validateAudioIndex(index, dictionary);
let audioBytes = 0;
for (const id of index.cards) {
  assert.match(id, /^[a-f0-9]{20}$/);
  const info = await stat(new URL(`audio/${id}.mp3`, root));
  assert.ok(info.isFile() && info.size > 100, `Missing recording: ${id}`);
  audioBytes += info.size;
}

for(const profile of FISH_PROFILES){
  const fishIds=validateFishManifest(JSON.parse(await read(profile.manifest)),new Set(dictionary.cards.map(c=>c.id)),profile.profile);
  assert.notEqual(fishIds,null,`Invalid optional Fish voice manifest: ${profile.manifest}`);
  for(const id of fishIds){
    const info=await stat(new URL(`${profile.directory}/${id}.mp3`,root));
    assert.ok(info.isFile()&&info.size>100,`Missing Fish recording: ${profile.profile||'original'}/${id}`);
  }
}

const validIds = new Set(dictionary.cards.map(c => c.id));
const aIds = validateChonishviliAManifest(JSON.parse(await read('fish-chonishvili-a-v1-index.json')), validIds);
assert.notEqual(aIds, null, 'Invalid Chonishvili A manifest');
const englexRecords = validateEnglexAIManifest(JSON.parse(await read('englex-ai-index.json')), validIds);
assert.notEqual(englexRecords, null, 'Invalid original Englex AI manifest');
for (const path of [...aIds].map(id => `audio/fish-chonishvili-a-v1/${id}.mp3`).concat([...englexRecords.values()])) {
  const info = await stat(new URL(path, root));
  assert.ok(info.isFile() && info.size > 100, `Missing selected-voice recording: ${path}`);
}

const html = (await read('index.html')).toString();
const manifest = JSON.parse(await read('manifest.webmanifest'));
const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
references.push(...manifest.icons.map(icon => icon.src));
for (const reference of references) {
  if (reference.startsWith('#')) continue;
  assert.ok(reference.startsWith('./'), `Non-portable entrypoint: ${reference}`);
  await stat(new URL(reference, root));
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML id');
const app = (await read('app.js')).toString();
for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing interface element: ${id}`);
for (const module of ['app.js', 'core.mjs', 'recorded-speech.mjs', 'paths.mjs', 'fish-voice.mjs', 'voice-options.mjs']) {
  execFileSync(process.execPath, ['--input-type=module', '--check'], {input: await read(module)});
  for (const [, path] of (await read(module)).toString().matchAll(/from\s+['"]([^'"]+)['"]/g)) await stat(new URL(path, root));
}
for (const base of ['https://example.test/', 'https://example.test/Englex-Pocket/']) {
  const module = new URL('paths.mjs', base).href;
  for (const path of ['dictionary.json', 'audio-index.json', `audio/${index.cards[0]}.mp3`, `audio/${index.cards.at(-1)}.mp3`]) {
    assert.equal(assetUrl(path, module), base + path, `Asset leaves application directory: ${path}`);
  }
  const manifestUrl = new URL('manifest.webmanifest', base);
  assert.equal(new URL(manifest.start_url, manifestUrl).href, base);
  assert.equal(new URL(manifest.scope, manifestUrl).href, base);
  assert.equal(new URL(manifest.id, manifestUrl).href, base);
}
assert.equal(manifest.display, 'standalone');
assert.match(html, /viewport-fit=cover/);
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
  const png = await read(name);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), size, name);
  assert.equal(png.readUInt32BE(20), size, name);
}
console.log(`Ready: ${dictionary.cards.length} cards (${ORIGINAL_COUNT} original cards protected), ${index.count} recordings (${audioBytes} bytes), all assets present; root and repository paths valid.`);

