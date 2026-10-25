// Publish active Ryan assets only. Legacy and superseded MP3s remain unchanged in Git.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, rm, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateExamples} from './import-examples.mjs';
import {validateEnglexAIManifest, validateEnglexRyanManifest} from '../dist/voice-options.mjs';
const digest = data => createHash('sha256').update(data).digest('hex');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function activeAssets(root, {requireReady=true}={}) {
  const json = async name => JSON.parse(await readFile(join(root,name),'utf8'));
  const dictionary = await json('dictionary.json'), validIds = new Set(dictionary.cards.map(card=>card.id));
  const originals=validateEnglexAIManifest(await json('englex-ai-index.json'),validIds);
  const generated=validateEnglexRyanManifest(await json('englex-ryan-index.json'),validIds);
  assert.notEqual(originals,null,'Invalid original Englex audio index');
  assert.notEqual(generated,null,'Invalid generated Ryan audio index');
  const examples=validateExamples(await json('examples.json'),dictionary.cards).examples;
  assert.equal(Object.keys(examples).length,dictionary.cards.length,'Every card needs an authored B1-B2 example before publication');
  const index=await json('englex-examples-ryan-index.json');
  assert.ok(index&&index.version===1&&index.provider==='Microsoft Edge'&&index.source==='generated'&&index.voice==='en-GB-RyanNeural'&&index.recordings&&typeof index.recordings==='object'&&!Array.isArray(index.recordings),'Invalid example Ryan index');
  const assets=new Set(), missingWords=[], missingExamples=[];
  for(const [id,record] of Object.entries(index.recordings)) {
    assert.ok(validIds.has(id)&&record&&typeof record==='object'&&!Array.isArray(record),`Unknown example recording: ${id}`);
    assert.deepEqual(Object.keys(record).sort(),['textSha256','audioSha256','path','duration'].sort(),`Invalid example recording fields: ${id}`);
    assert.match(record.textSha256,/^[a-f0-9]{64}$/); assert.match(record.audioSha256,/^[a-f0-9]{64}$/);
    assert.equal(record.path,`audio/englex-examples-ryan/${id}-${record.textSha256.slice(0,20)}-ryan-v1.mp3`);
    assert.ok(Number.isFinite(record.duration)&&record.duration>=.1&&record.duration<=180,`Invalid example duration: ${id}`);
    const bytes=await readFile(join(root,record.path));
    assert.ok(bytes.length>100,`Empty example audio: ${id}`);
    assert.equal(digest(bytes),record.audioSha256,`Example audio hash mismatch: ${id}`);
  }
  for(const card of dictionary.cards) {
    const word=originals.get(card.id)||(generated.has(card.id)?`audio/englex-ryan/${card.id}.mp3`:null);
    if(word) { const info=await stat(join(root,word)); assert.ok(info.isFile()&&info.size>100,`Missing active Ryan recording: ${card.id}`); assets.add(word); }
    else missingWords.push(card.id);
    const record=index.recordings[card.id];
    if(record?.textSha256===examples[card.id].textSha256) assets.add(record.path);
    else missingExamples.push(card.id);
  }
  if(requireReady) assert.ok(!missingWords.length&&!missingExamples.length,`Ryan publication not ready: ${missingWords.length} words and ${missingExamples.length} examples need audio`);
  return {assets:[...assets].sort(),missingWords,missingExamples,cards:dictionary.cards.length};
}
async function totalBytes(path) {
  const info=await stat(path);
  if(info.isFile()) return info.size;
  let total=0;
  for(const entry of await readdir(path)) total+=await totalBytes(join(path,entry));
  return total;
}
export async function preparePages(dist, destination) {
  dist=resolve(dist); destination=resolve(destination);
  assert.ok(destination!==dist&&!dist.startsWith(destination+'/')&&!destination.startsWith(dist+'/'),'Pages staging must be separate from dist');
  const coverage=await activeAssets(dist);
  const selected=new Set(coverage.assets);
  // Keep the few explicitly linked standalone preview samples working; bulk
  // retired libraries and superseded example recordings are not deployed.
  for(const name of await readdir(dist)) if(name.endsWith('.html')) {
    const html=await readFile(join(dist,name),'utf8');
    for(const match of html.matchAll(/(?:src|href)=["'](\.\/audio\/[^"'?#]+\.mp3)(?:[?#][^"']*)?["']/g)) {
      const asset=match[1].slice(2);
      assert.ok(/^audio\/[a-zA-Z0-9_./-]+\.mp3$/.test(asset)&&!asset.split('/').includes('..'),`Unsafe static audio reference: ${asset}`);
      const info=await stat(join(dist,asset)); assert.ok(info.isFile()&&info.size>100,`Missing preview audio: ${asset}`);
      selected.add(asset);
    }
  }
  await rm(destination,{recursive:true,force:true});
  await mkdir(destination,{recursive:true});
  for(const entry of await readdir(dist)) if(entry!=='audio') await cp(join(dist,entry),join(destination,entry),{recursive:true});
  for(const asset of selected) { await mkdir(dirname(join(destination,asset)),{recursive:true}); await cp(join(dist,asset),join(destination,asset)); }
  const bytes=await totalBytes(destination);
  assert.ok(bytes<950_000_000,`Active Pages artifact too large: ${bytes} bytes; publication stopped`);
  return {cards:coverage.cards,audioFiles:selected.size,bytes,destination};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2); assert.ok(args.length<=1,'Usage: node scripts/prepare-pages.mjs [staging-directory]');
  console.log(JSON.stringify(await preparePages(join(projectRoot,'dist'),resolve(args[0]||join(projectRoot,'.pages-site')))));
}
