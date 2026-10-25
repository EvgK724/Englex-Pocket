import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeExamples, validateExamples, importExamples, sha256} from './import-examples.mjs';
import {preparePages, activeAssets} from './prepare-pages.mjs';
const A='a'.repeat(20), B='b'.repeat(20);
const dictionary={cards:[{id:A,word:'fine',translation:'штраф',kind:'word'},{id:B,word:'fine',translation:'прекрасный',kind:'word'}]};
const sample={en:'He paid a fine for parking outside the hospital.',ru:'Он заплатил штраф за парковку у больницы.'};
test('examples retain exact source meaning and original dictionary; repeated imports are idempotent',()=>{
  const before=structuredClone(dictionary), input={[A]:sample};
  const result=mergeExamples(dictionary,input);
  assert.equal(result.added.length,1); assert.equal(result.data.examples[A].translation,'штраф');
  assert.equal(result.data.examples[A].textSha256,sha256(sample.en));
  assert.deepEqual(dictionary,before); assert.equal(mergeExamples(dictionary,input,result.data).changed,false);
  const different=mergeExamples(dictionary,{[B]:{en:'The weather was fine, so we walked home.',ru:'Погода была прекрасной, поэтому мы пошли домой пешком.'}},result.data);
  assert.equal(Object.keys(different.data.examples).length,2); assert.deepEqual(different.data.examples[A],result.data.examples[A]);
});
test('sentence edits change spoken hash but translation-only edits do not',()=>{
  const first=mergeExamples(dictionary,{[A]:sample}).data;
  const edited=mergeExamples(dictionary,{[A]:{...sample,en:'I had to pay a fine for parking here.'}},first);
  assert.equal(edited.updated.length,1); assert.notEqual(edited.data.examples[A].textSha256,first.examples[A].textSha256);
  const translated=mergeExamples(dictionary,{[A]:{...sample,ru:'Ему пришлось заплатить штраф за парковку у больницы.'}},first);
  assert.equal(translated.data.examples[A].textSha256,first.examples[A].textSha256);
});
test('invalid IDs, source mismatch, language, injected fields and bad hashes are rejected',()=>{
  assert.throws(()=>mergeExamples(dictionary,{['c'.repeat(20)]:sample}),/Unknown/);
  assert.throws(()=>mergeExamples(dictionary,{[A]:{...sample,word:'rewritten'}}),/only en, ru/);
  for(const bad of [{...sample,en:'  '},{...sample,en:'Это не английский пример.'},{...sample,ru:'No Russian translation'},{...sample,en:'Hello\nworld.'}])assert.throws(()=>mergeExamples(dictionary,{[A]:bad}));
  const data=mergeExamples(dictionary,{[A]:sample}).data;
  assert.throws(()=>validateExamples({...data,examples:{[A]:{...data.examples[A],word:'other'}}},dictionary.cards),/word changed/);
  assert.throws(()=>validateExamples({...data,examples:{[A]:{...data.examples[A],textSha256:'0'.repeat(64)}}},dictionary.cards),/hash mismatch/);
});
test('optional source clarification stays Russian, bounded and separate from spoken text',()=>{
  const note='В исходном словаре перевод требует проверки.';
  const result=mergeExamples(dictionary,{[A]:{...sample,note}});
  assert.equal(result.data.examples[A].note,note); assert.equal(result.data.examples[A].textSha256,sha256(sample.en));
  assert.throws(()=>mergeExamples(dictionary,{[A]:{...sample,note:'x'.repeat(301)}}));
  assert.throws(()=>mergeExamples(dictionary,{[A]:{...sample,note:'English note'}}));
});
test('file import changes only examples.json and fails atomically before overwriting good examples',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pocket-examples-'));
  try{
    await mkdir(join(root,'dist')); const original=JSON.stringify(dictionary); await writeFile(join(root,'dist/dictionary.json'),original);
    const input=join(root,'input.json'); await writeFile(input,JSON.stringify({[A]:sample}));
    assert.equal((await importExamples(input,root)).added,1);
    const good=await readFile(join(root,'dist/examples.json'),'utf8');
    await writeFile(input,JSON.stringify({[A]:{...sample,ru:''}})); await assert.rejects(importExamples(input,root));
    assert.equal(await readFile(join(root,'dist/examples.json'),'utf8'),good);
    assert.equal(await readFile(join(root,'dist/dictionary.json'),'utf8'),original);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Pages stages only active word and example audio; archived MP3 bytes remain in source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pocket-pages-')), dist=join(root,'dist'), output=join(root,'published');
  try{
    await mkdir(dist); const write=async(path,data)=>{await mkdir(join(dist,path,'..'),{recursive:true});await writeFile(join(dist,path),data);};
    const writeJson=async(path,value)=>write(path,JSON.stringify(value));
    const current={cards:[dictionary.cards[0]]};
    const examples=mergeExamples(current,{[A]:sample}).data;
    const audio=Buffer.alloc(300,7), audioSha=sha256(audio), path=`audio/englex-examples-ryan/${A}-${examples.examples[A].textSha256.slice(0,20)}-ryan-v1.mp3`;
    await writeJson('dictionary.json',current); await writeJson('examples.json',examples);
    await writeJson('englex-ai-index.json',{version:1,source:'englex-ai',recordings:{}});
    await writeJson('englex-ryan-index.json',{version:1,provider:'Microsoft Edge',source:'generated',voice:'en-GB-RyanNeural',count:1,cards:[A]});
    await writeJson('englex-examples-ryan-index.json',{version:1,provider:'Microsoft Edge',source:'generated',voice:'en-GB-RyanNeural',recordings:{[A]:{textSha256:examples.examples[A].textSha256,audioSha256:audioSha,path,duration:2}}});
    await write(`audio/englex-ryan/${A}.mp3`,audio);await write(path,audio);await write('audio/archive/old.mp3','untouched archive');await write('index.html','app');await write('preview.html','<audio src="./audio/previews/current.mp3"></audio>');await write('audio/previews/current.mp3',audio);
    const result=await preparePages(dist,output); assert.equal(result.audioFiles,3);
    assert.equal(await readFile(join(dist,'audio/archive/old.mp3'),'utf8'),'untouched archive');
    await assert.rejects(readFile(join(output,'audio/archive/old.mp3')), {code:'ENOENT'});
    assert.deepEqual(await readFile(join(output,path)),audio);
    await writeJson('englex-examples-ryan-index.json',{version:1,provider:'Microsoft Edge',source:'generated',voice:'en-GB-RyanNeural',recordings:{}});
    assert.equal((await activeAssets(dist,{requireReady:false})).missingExamples.length,1);
    await assert.rejects(preparePages(dist,output),/not ready/);
    assert.equal(await readFile(join(output,'index.html'),'utf8'),'app');
  }finally{await rm(root,{recursive:true,force:true});}
});
