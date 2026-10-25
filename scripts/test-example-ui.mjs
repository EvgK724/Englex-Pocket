import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {textHash,validateExamples,validateExampleAudio,exampleForCard} from '../dist/examples.mjs';
import {sanitizeProgress} from '../dist/core.mjs';

const a='aaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbb';
const card={id:a,word:'workshop',translation:'практическое занятие',kind:'word'};
const en='The workshop helped me learn a useful skill.';
const hash=await textHash(en);
const example={word:card.word,translation:card.translation,en,ru:'Практическое занятие помогло мне освоить полезный навык.',textSha256:hash};
const textManifest=entries=>({version:1,source:'authored-learning-examples',level:'B1-B2',examples:entries});
const audioRecord={textSha256:hash,audioSha256:'c'.repeat(64),path:`audio/englex-examples-ryan/${a}-${hash.slice(0,20)}-ryan-v1.mp3`,duration:3.8};
const audioManifest=entries=>({version:1,provider:'Microsoft Edge',source:'generated',voice:'en-GB-RyanNeural',recordings:entries});

test('examples bind exact English and original meaning to their own card without changing the dictionary',async()=>{
  const cards=new Map([[a,card]]), before=structuredClone(card);
  const examples=await validateExamples(textManifest({[a]:example}),cards);
  assert.deepEqual(examples.get(a),example);
  assert.equal(exampleForCard(card,examples),examples.get(a));
  assert.equal(exampleForCard({...card,translation:'другое значение'},examples),null);
  assert.deepEqual(card,before);
  for(const change of [{word:'different'},{translation:'other'},{en:en+' Changed.'},{textSha256:'d'.repeat(64)},{ru:''},
    {note:4},{note:''},{note:'English only'},{note:' Примечание'},{note:'Примечание\nещё'},{note:'я'.repeat(301)}]) {
    assert.equal((await validateExamples(textManifest({[a]:{...example,...change}}),cards)).size,0);
  }
  assert.equal(await validateExamples({...textManifest({}),source:'englex-original'},cards),null);
  const withNote=await validateExamples(textManifest({[a]:{...example,note:'Перевод в исходном словаре требует уточнения.'}}),cards);
  assert.equal(withNote.get(a).note,'Перевод в исходном словаре требует уточнения.');
});

test('stale or unrecognized records never enable another example or a fallback voice',async()=>{
  const examples=await validateExamples(textManifest({[a]:example}),new Map([[a,card]]));
  assert.equal(validateExampleAudio(audioManifest({[a]:audioRecord}),examples).get(a).path,audioRecord.path);
  for(const change of [{textSha256:'f'.repeat(64)},{audioSha256:'invalid'},{path:'https://example.test/private.mp3'},{path:'../audio.mp3'},{duration:0}])
    assert.equal(validateExampleAudio(audioManifest({[a]:{...audioRecord,...change}}),examples).size,0);
  assert.equal(validateExampleAudio({...audioManifest({[a]:audioRecord}),voice:'en-US-AndrewNeural'},examples),null);
  assert.equal(validateExampleAudio(audioManifest({[a]:audioRecord,[b]:{...audioRecord,textSha256:'f'.repeat(64)}}),examples).size,1,'an old sibling record does not disable valid audio');
});

test('all card kinds can have independent examples; newer dictionary entries wait safely',async()=>{
  const cards=new Map([[a,{...card,kind:'collocation'}]]);
  const examples=await validateExamples(textManifest({[a]:example,[b]:example}),cards);
  assert.equal(examples.size,1);
  assert.equal(exampleForCard(cards.get(a),examples).en,en);
});

test('older backups default to all cards; valid pending IDs survive a stale dictionary without admitting invalid IDs',()=>{
  const raw={version:1,stars:[a,b,'../bad'],ratings:{[a]:'review',[b]:'known','../bad':'known'},currentId:b,rate:.85,kind:'word',sort:'oldest'};
  const restored=sanitizeProgress(raw,new Set([a]),{preserveUnknown:true});
  assert.deepEqual(restored.stars,[a,b]);assert.equal(restored.ratings[b],'known');assert.equal(restored.currentId,b);
  assert.equal(restored.deck,'all');assert.equal(restored.rate,.85);
  assert.equal(sanitizeProgress({...raw,deck:'review'},new Set([a]),{preserveUnknown:true}).deck,'review');
  assert.equal(sanitizeProgress(raw,new Set([a])).currentId,null,'strict consumers retain their prior filtering contract');
});

test('actual initial load/save retains pending progress and chosen deck until the dictionary catches up',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const original={version:1,stars:[a,b],ratings:{[b]:'known'},currentId:b,deck:'starred',kind:'word',sort:'oldest',rate:.85};
  let saved=JSON.stringify(original);
  const context={state:{},searchBookmark:null,currentId:null,byId:new Map([[a,card]]),sanitizeProgress,migrateVoicePreference:()=> 'englex-ai',VOICE_PREFERENCE_VERSION:4,STORAGE_KEY:'englex-pocket-v1',storageWarning:false,toast:()=>assert.fail('valid progress must load'),current:()=>card,localStorage:{getItem:()=>saved,setItem:(_,value)=>{saved=value;}}};
  runInNewContext(app.slice(app.indexOf('function progress(){'),app.indexOf('function updateCounts(){')),context);
  runInNewContext('loadProgress();save()',context);
  const result=JSON.parse(saved);
  assert.deepEqual(result.stars,[a,b]);assert.deepEqual(result.ratings,original.ratings);
  assert.equal(result.currentId,b);assert.equal(result.deck,'starred');assert.equal(result.rate,.85);
});
