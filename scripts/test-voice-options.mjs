import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {RecordedSpeech} from '../dist/recorded-speech.mjs';
import {sanitizeProgress} from '../dist/core.mjs';
import {
  VOICE_OPTIONS,VOICE_PREFERENCE_VERSION,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,
  migrateVoicePreference,validateEnglexAIManifest,validateEnglexRyanManifest,validateChonishviliAManifest,validateChonishviliCleanManifest,validateSoftVoiceManifest,ENGLEX_RYAN_VOICE,ENGLEX_RYAN_MANIFEST,
  CHONISHVILI_CLEAN_MANIFEST,voiceCardIds,recordingForVoice
} from '../dist/voice-options.mjs';

const a='aaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbb',c='cccccccccccccccccccc';
const validIds=new Set([a,b]);
const data={softIds:new Set([a,b]),chonishviliAIds:new Set([a]),englexRecordings:new Map([[b,`audio/englex-ai/${b}.mp3`]])};

test('Ryan default migrates old preferences once and retains every later explicit choice without changing progress',()=>{
  assert.equal(migrateVoicePreference(null),ENGLEX_AI_VOICE_URI);
  for(const recordedVoiceVersion of [undefined,1,2]){
    for(const voiceURI of ['auto','device:auto','Samantha',CHONISHVILI_A_VOICE_URI,ENGLEX_AI_VOICE_URI])
      assert.equal(migrateVoicePreference({voiceURI,recordedVoiceVersion}),ENGLEX_AI_VOICE_URI);
  }
  for(const uri of VOICE_OPTIONS.map(voice=>voice.uri)){
    assert.equal(migrateVoicePreference({voiceURI:uri,recordedVoiceVersion:VOICE_PREFERENCE_VERSION}),uri);
    assert.equal(migrateVoicePreference({voiceURI:uri,recordedVoiceVersion:VOICE_PREFERENCE_VERSION+1}),uri);
  }
  assert.equal(migrateVoicePreference({voiceURI:'removed-voice',recordedVoiceVersion:VOICE_PREFERENCE_VERSION}),ENGLEX_AI_VOICE_URI);
  const progress={voiceURI:'auto',recordedVoiceVersion:2,stars:[a],ratings:{[b]:'known'},currentId:b,rate:.8};
  const before=structuredClone(progress);
  assert.equal(migrateVoicePreference(progress),ENGLEX_AI_VOICE_URI);
  assert.deepEqual(progress,before,'migration must not mutate learning progress');
});

test('primary menus and runtime labels are exactly Ryan, Choni and Doris with Ryan initially selected',async()=>{
  assert.deepEqual(VOICE_OPTIONS.map(voice=>voice.label),['Ryan','Choni','Doris']);
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const menus=[...html.matchAll(/<select id="(voice-select|card-voice-select)"[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(menus.length,2);
  for(const [,id,markup] of menus){
    assert.deepEqual([...markup.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map(match=>match[1]),['Ryan','Choni','Doris'],id);
    assert.match(markup,/<option value="englex-ai" selected>Ryan<\/option>/);
    assert.equal((markup.match(/\bselected\b/g)||[]).length,1);
  }
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('const state='),app.indexOf('let byId='));
  assert.equal(runInNewContext(`${source}\nstate.voiceURI`,{ENGLEX_AI_VOICE_URI}),ENGLEX_AI_VOICE_URI);
  assert.doesNotMatch(html,/Englex · AI|Чонишвили · вариант A|AI Voice · мягкий голос/);
});

test('actual progress load/save records the one-time Ryan migration without resetting learning state',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const original={version:1,recordedVoiceVersion:2,voiceURI:CHONISHVILI_A_VOICE_URI,stars:[a],ratings:{[a]:'review',[b]:'known'},currentId:b,rate:1.05,kind:'phrasal',sort:'alphabetical'};
  let stored=JSON.stringify(original);
  const context={state:{stars:new Set(),ratings:{},voiceURI:ENGLEX_AI_VOICE_URI},currentId:null,byId:new Map([[a,{id:a}],[b,{id:b}]]),STORAGE_KEY:'englex-pocket-v1',VOICE_PREFERENCE_VERSION,VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,migrateVoicePreference,sanitizeProgress,storageWarning:false,toast:()=>assert.fail('valid progress should load'),resetSpeech(){},localStorage:{getItem:()=>stored,setItem:(key,value)=>{assert.equal(key,'englex-pocket-v1');stored=value;}}};
  context.current=()=>context.byId.get(context.currentId)||null;
  runInNewContext(app.slice(app.indexOf('function progress(){'),app.indexOf('function updateCounts(){')),context);
  runInNewContext(app.slice(app.indexOf('function selectVoice(value){'),app.indexOf('function updateAudioButtons(){')),context);
  runInNewContext('loadProgress();save();',context);
  const migrated=JSON.parse(stored);
  assert.deepEqual(migrated,{...original,recordedVoiceVersion:VOICE_PREFERENCE_VERSION,voiceURI:ENGLEX_AI_VOICE_URI});
  for(const uri of [CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI]){
    context.requestedURI=uri;
    runInNewContext('selectVoice(requestedURI);',context);
    assert.equal(JSON.parse(stored).recordedVoiceVersion,VOICE_PREFERENCE_VERSION);
    context.state.voiceURI=ENGLEX_AI_VOICE_URI;
    runInNewContext('loadProgress();save();',context);
    assert.deepEqual(JSON.parse(stored),{...original,recordedVoiceVersion:VOICE_PREFERENCE_VERSION,voiceURI:uri},'subsequent explicit choice and every learning field survive reload');
  }
});

test('Englex index accepts only dictionary IDs with their own local recording path',()=>{
  const manifest={version:1,source:'englex-ai',recordings:{[b]:`audio/englex-ai/${b}.mp3`}};
  assert.deepEqual([...validateEnglexAIManifest(manifest,validIds)],[[b,`audio/englex-ai/${b}.mp3`]]);
  assert.equal(validateEnglexAIManifest({...manifest,source:'device'},validIds),null);
  assert.equal(validateEnglexAIManifest({...manifest,recordings:[]},validIds),null);
  assert.equal(validateEnglexAIManifest({...manifest,recordings:{[c]:`audio/englex-ai/${c}.mp3`}},validIds),null);
  for(const path of [`audio/englex-ai/${a}.mp3`,`audio/${b}.mp3`,'../private.mp3','https://englex.example/audio?token=secret'])
    assert.equal(validateEnglexAIManifest({...manifest,recordings:{[b]:path}},validIds),null);
  assert.equal(validateEnglexAIManifest({...manifest,recordings:{}},validIds).size,0);
});

test('Ryan supplement requires generated Microsoft Edge provenance, exact voice and complete known IDs',()=>{
  const manifest={version:1,provider:'Microsoft Edge',source:'generated',voice:ENGLEX_RYAN_VOICE,count:2,cards:[a,b]};
  assert.deepEqual([...validateEnglexRyanManifest(manifest,validIds)],[a,b]);
  for(const change of [{provider:'Englex'},{source:'englex-ai'},{voice:'en-GB-SoniaNeural'},{count:1},{count:undefined},{cards:[a,a]},{cards:[a,c]},{cards:['../audio',b]},{version:2}])
    assert.equal(validateEnglexRyanManifest({...manifest,...change},validIds),null);
  assert.equal(validateEnglexRyanManifest({...manifest,count:0,cards:[]},validIds).size,0);
});

test('Englex coverage is the union, originals take priority and generated files never masquerade as originals',()=>{
  const voices={...data,englexRecordings:new Map([[a,`audio/englex-ai/${a}.mp3`]]),englexRyanIds:new Set([a,b])};
  assert.deepEqual([...voiceCardIds(ENGLEX_AI_VOICE_URI,voices)],[a,b]);
  assert.equal(VOICE_OPTIONS.length,3);
  const original=recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI});
  const generated=recordingForVoice({...voices,cardId:b,voiceURI:ENGLEX_AI_VOICE_URI});
  assert.equal(original.path,`audio/englex-ai/${a}.mp3`);assert.equal(original.source,'englex-ai');
  assert.equal(generated.path,`audio/englex-ryan/${b}.mp3?v=ryan-v1`);assert.equal(generated.source,'generated');
  assert.equal(generated.label,'Ryan');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI,failedRecordings:new Set([original.key])}),null,'failed original is not silently exchanged for generated audio');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI,failedRecordings:new Set([`${ENGLEX_AI_VOICE_URI}:generated:${a}`])}).source,'englex-ai','an original added later is not blocked by a previous generated-recording failure');
  assert.equal(recordingForVoice({...voices,cardId:b,voiceURI:SOFT_VOICE_URI}).path,`audio/${b}.mp3`,'other two choices keep their own voice');
});

test('A index cannot enable accepted or English trial audio, unknown IDs or paid engine data',()=>{
  const manifest={version:1,profile:'a-v1',voiceId:'089f2e853e064d6fb15f5b5882914b52',engine:'s2.1-pro-free',cards:[a]};
  assert.deepEqual([...validateChonishviliAManifest(manifest,validIds)],[a]);
  for(const changes of [{profile:null},{profile:'en-gb-v1'},{voiceId:'other'},{engine:'s2.1-pro'},{cards:[a,a]},{cards:[c]},{cards:['../a']}])
    assert.equal(validateChonishviliAManifest({...manifest,...changes},validIds),null);
});

function cleanManifest(cards=[a]){
  return {version:1,profile:'a-clean-v1',sourceProfile:'a-v1',voiceId:'089f2e853e064d6fb15f5b5882914b52',engine:'s2.1-pro-free',count:cards.length,cards,sourceBlobs:Object.fromEntries(cards.map(id=>[id,'1'.repeat(40)]))};
}

test('clean Choni index binds each known ID to the approved original profile and a Git source hash',()=>{
  const manifest=cleanManifest([a,b]);
  assert.deepEqual([...validateChonishviliCleanManifest(manifest,validIds)],[a,b]);
  assert.deepEqual([...validateChonishviliCleanManifest(cleanManifest([]),validIds)],[]);
  for(const changes of [{version:2},{profile:'a-v1'},{sourceProfile:'accepted'},{voiceId:'other'},{engine:'s2.1-pro'},{count:1},{count:undefined},{cards:[a,a]},{cards:[a,c]},{sourceBlobs:{}},{sourceBlobs:null},{sourceBlobs:[]},{sourceBlobs:{[a]:'x'.repeat(40),[b]:'1'.repeat(40)}},{sourceBlobs:{[a]:'1'.repeat(40),[b]:'1'.repeat(40),[c]:'1'.repeat(40)}}])
    assert.equal(validateChonishviliCleanManifest({...manifest,...changes},validIds),null,JSON.stringify(changes));
});

test('Choni prefers cleaned IDs, retains originals during the build, and only retries its own original on failure',()=>{
  const voices={...data,chonishviliAIds:new Set([a,b]),chonishviliCleanIds:new Set([a,c])};
  assert.deepEqual([...voiceCardIds(CHONISHVILI_A_VOICE_URI,voices)],[a,b,c]);
  assert.equal(VOICE_OPTIONS.length,3,'cleaned audio does not add a voice');
  const route=(cardId,failedRecordings=new Set())=>recordingForVoice({...voices,cardId,voiceURI:CHONISHVILI_A_VOICE_URI,failedRecordings});
  const clean=route(a),original=route(b);
  assert.equal(clean.path,`audio/fish-chonishvili-a-clean-v1/${a}.mp3?v=a-clean-v1`);assert.equal(clean.label,'Choni');assert.equal(clean.source,'choni-clean');
  assert.equal(original.path,`audio/fish-chonishvili-a-v1/${b}.mp3?v=a-v1`);assert.equal(original.source,'choni-original');assert.equal(original.fallback,false);
  const failed=new Set([clean.key]);
  const retry=route(a,failed);
  assert.equal(retry.source,'choni-original');assert.equal(retry.fallback,true);assert.equal(retry.label,'Choni');
  failed.add(retry.key);assert.equal(route(a,failed),null,'both sources failed: do not substitute Doris');
  assert.equal(route(c,new Set([route(c).key])),null,'missing original cannot be replaced by another card');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:SOFT_VOICE_URI}).path,`audio/${a}.mp3`,'Doris ignores the clean Choni manifest');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI}),null,'Ryan ignores the clean Choni manifest');
});

test('each option routes only its own recording and an unavailable voice has no fallback',()=>{
  const route=(voiceURI,cardId=a,failedRecordings=new Set())=>recordingForVoice({voiceURI,cardId,...data,failedRecordings});
  assert.equal(route(CHONISHVILI_A_VOICE_URI).path,`audio/fish-chonishvili-a-v1/${a}.mp3?v=a-v1`);
  assert.equal(route(SOFT_VOICE_URI).path,`audio/${a}.mp3`);
  assert.equal(route(ENGLEX_AI_VOICE_URI,b).path,`audio/englex-ai/${b}.mp3`);
  assert.equal(route(CHONISHVILI_A_VOICE_URI,b),null,'soft recording must not masquerade as A');
  assert.equal(route(ENGLEX_AI_VOICE_URI,a),null,'A recording must not masquerade as Englex');
  assert.equal(route('device:auto'),null);
  assert.equal(route(CHONISHVILI_A_VOICE_URI,a,new Set([`${CHONISHVILI_A_VOICE_URI}:${a}`])),null);
  assert.ok(route(SOFT_VOICE_URI,a,new Set([`${CHONISHVILI_A_VOICE_URI}:${a}`])),'failed A does not disable soft');
});

async function uiContext(preferred=ENGLEX_AI_VOICE_URI){
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,options:[],attrs:new Map(),replaceChildren(...options){this.options=options;},getAttribute(key){return this.attrs.get(key);},setAttribute(key,value){this.attrs.set(key,value);},removeAttribute(key){this.attrs.delete(key);}});
    return nodes.get(id);
  };
  const context={state:{voiceURI:preferred,cards:[{id:a},{id:b}],rate:.9},audioIds:new Set([a,b]),chonishviliAIds:new Set(),chonishviliCleanIds:new Set(),englexRecordings:new Map(),englexRyanIds:new Set(),voiceLoadStatus:new Map(),failedRecordings:new Set(),VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,voiceCardIds,recordingForVoice,
    byId:new Map([[a,{id:a,word:'First recording'}],[b,{id:b,word:'Current phrase'}]]),current:()=>({id:b,word:'Current phrase'}),$:node,Option:function(label,value){this.label=label;this.value=value;},assetUrl:path=>path,speechText:word=>word,
    save(){this.savedURI=this.state.voiceURI;},recordedSpeech:{stop(){},play(path,callbacks){context.played=path;context.playbackCallbacks=callbacks;}}
  };
  context.save=()=>{context.savedURI=context.state.voiceURI;};
  runInNewContext(app.slice(app.indexOf('function voiceData(){'),app.indexOf('function bindEvents(){')),context);
  return {context,node};
}

test('both menus always expose exactly three choices, including a selected voice with pending audio',async()=>{
  const {context,node}=await uiContext(CHONISHVILI_A_VOICE_URI);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  for(const id of ['voice-select','card-voice-select']){
    assert.deepEqual(node(id).options.map(option=>option.value),VOICE_OPTIONS.map(voice=>voice.uri));
    assert.equal(node(id).value,CHONISHVILI_A_VOICE_URI);
  }
  assert.equal(node('speak-front').disabled,true);
  assert.equal(node('test-voice').disabled,true);
  context.chonishviliAIds.add(a);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('speak-front').disabled,true,'current phrase is not recorded as A');
  assert.equal(node('test-voice').disabled,false,'another A recording can be previewed');
  assert.match(node('voice-test-note').textContent,/First recording/,'preview identifies the actual word before clicking');
  runInNewContext('selectVoice(SOFT_VOICE_URI);',context);
  assert.equal(context.savedURI,SOFT_VOICE_URI);
  assert.equal(node('speak-front').disabled,false);
  assert.equal(node('voice-select').value,SOFT_VOICE_URI);
  assert.equal(node('card-voice-select').value,SOFT_VOICE_URI);
});

test('card readiness stays concise while Settings and previews preserve original and generated provenance',async()=>{
  const {context,node}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(a,`audio/englex-ai/${a}.mp3`);context.englexRyanIds.add(a);context.englexRyanIds.add(b);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('card-voice-select').options.length,3);
  assert.equal(node('card-voice-select').value,ENGLEX_AI_VOICE_URI);
  assert.equal(node('card-voice-note').textContent,'Выбран для всей коллекции.');
  assert.match(node('voice-test-note').textContent,/Current phrase · синтез Ryan/);
  assert.match(node('englex-voice-provenance').textContent,/1 оригинальных.*1 дополнительных/);
  context.englexRecordings.set(b,`audio/englex-ai/${b}.mp3`);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('card-voice-note').textContent,'Выбран для всей коллекции.');
  assert.match(node('englex-voice-provenance').textContent,/2 оригинальных.*0 дополнительных/);
});

test('play starts synchronously from the click handler and failure never plays another voice',async()=>{
  const {context,node}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(b,`audio/englex-ai/${b}.mp3`);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  assert.equal(context.played,`audio/englex-ai/${b}.mp3`);
  context.playbackCallbacks.onStart();
  assert.match(node('audio-status').textContent,/Ryan: Current phrase/);
  context.playbackCallbacks.onFinish();
  context.playbackCallbacks.onError();
  assert.equal(node('speak-front').disabled,true);
  assert.equal(context.played,`audio/englex-ai/${b}.mp3`,'soft recording available but not substituted');
  assert.equal(node('audio-reset').hidden,false);
});

function attachRealPlayer(context){
  const media=[];
  const clock={setTimeout:()=>1,clearTimeout:()=>{}};
  context.recordedSpeech=new RecordedSpeech(()=>{
    const audio={duration:1,pause(){},removeAttribute(){},load(){},play(){return new Promise((resolve,reject)=>{audio.reject=reject;});}};
    media.push(audio);return audio;
  },clock);
  return media;
}

test('real player failure clears busy state and reset makes the same speaker retryable',async()=>{
  const {context,node}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(b,`audio/englex-ai/${b}.mp3`);
  const media=attachRealPlayer(context);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  assert.equal(node('speak-front').getAttribute('aria-busy'),'true');
  media[0].onerror();
  assert.equal(node('speak-front').getAttribute('aria-busy'),undefined,'RecordedSpeech calls onFinish before onError');
  assert.equal(node('speak-front').disabled,true,'failed record is unavailable until reset');
  runInNewContext('resetSpeech();',context);
  assert.equal(node('speak-front').getAttribute('aria-busy'),undefined);
  assert.equal(node('speak-front').disabled,false);
  assert.equal(context.failedRecordings.size,0);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  assert.equal(media.length,2);
  media[1].onplaying();
  assert.match(node('audio-status').textContent,/Ryan: Current phrase/);
  media[1].onended();
  assert.equal(node('speak-front').disabled,false);
  assert.equal(node('speak-front').getAttribute('aria-busy'),undefined);
});

test('cleaned recording failure offers an honest original Choni retry in a new click, then reset retries clean',async()=>{
  const {context,node}=await uiContext(CHONISHVILI_A_VOICE_URI);
  context.chonishviliAIds.add(b);context.chonishviliCleanIds.add(b);
  const media=attachRealPlayer(context);
  runInNewContext('refreshVoices();updateAudioButtons();pronounce(current(),$("speak-front"));',context);
  assert.match(media[0].src,/audio\/fish-chonishvili-a-clean-v1\//);
  assert.match(node('voice-test-note').textContent,/очищенная запись/);
  media[0].onerror();
  assert.equal(media.length,1,'asynchronous failure does not start audio outside the user gesture');
  assert.equal(node('speak-front').getAttribute('aria-busy'),undefined);
  assert.equal(node('speak-front').disabled,false,'same Choni original is ready for a user retry');
  assert.match(node('audio-status').textContent,/Нажмите на динамик.*исходную запись Choni/);
  assert.match(node('card-voice-note').textContent,/Очищенная запись не загрузилась.*исходную/);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  assert.match(media[1].src,/audio\/fish-chonishvili-a-v1\//);
  media[1].onplaying();assert.match(node('audio-status').textContent,/Choni: Current phrase · исходная запись/);
  media[1].onerror();
  assert.equal(node('speak-front').disabled,true,'failed original is unavailable until reset');
  assert.match(node('card-voice-note').textContent,/Перезапустить звук/);
  runInNewContext('resetSpeech();pronounce(current(),$("speak-front"));',context);
  assert.equal(node('speak-front').getAttribute('aria-busy'),'true');
  assert.match(media[2].src,/audio\/fish-chonishvili-a-clean-v1\//);
  assert.equal(context.state.voiceURI,CHONISHVILI_A_VOICE_URI);
});

test('unbuilt cleaned audio keeps original Choni available and makes the current source visible',async()=>{
  const {context,node}=await uiContext(CHONISHVILI_A_VOICE_URI);
  context.chonishviliAIds.add(b);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('speak-front').disabled,false);
  assert.match(node('card-voice-note').textContent,/доступна исходная запись/);
  assert.match(node('voice-test-note').textContent,/исходная запись/);
  assert.equal(node('fish-coverage').hidden,false);
  assert.match(node('fish-coverage').textContent,/0 очищенных/);
  context.chonishviliCleanIds.add(b);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('card-voice-note').textContent,'Выбран для всей коллекции.');
  assert.match(node('fish-coverage').textContent,/1 очищенных/);
});

test('late failure from a stopped card cannot clear busy state or disable a new card using the same speaker',async()=>{
  const {context,node}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(a,`audio/englex-ai/${a}.mp3`);
  context.englexRecordings.set(b,`audio/englex-ai/${b}.mp3`);
  const media=attachRealPlayer(context);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  context.current=()=>context.byId.get(a);
  // renderCard stops the previous media request before using this same button.
  runInNewContext('recordedSpeech.stop();updateAudioButtons();pronounce(current(),$("speak-front"));',context);
  media[1].onplaying();
  media[0].reject(new Error('Old card failed after navigation'));
  await Promise.resolve();
  assert.equal(context.failedRecordings.size,0);
  assert.equal(node('speak-front').getAttribute('aria-busy'),'true');
  assert.match(node('audio-status').textContent,/First recording/);
  media[1].onended();
  assert.equal(node('speak-front').getAttribute('aria-busy'),undefined);
  assert.equal(node('speak-front').disabled,false);
});



test('soft manifest verifies provider, complete count and dictionary IDs while preserving existing voice overrides',()=>{
  const manifest={version:1,provider:'AI Voice Generator',voice:'delicate',count:2,cards:[a,b],voiceOverrides:{[a]:{voice:'childlike-robot-trial-v1'}}};
  const before=structuredClone(manifest);
  assert.deepEqual([...validateSoftVoiceManifest(manifest,validIds)],[a,b]);
  assert.deepEqual(manifest,before);
  for(const changed of [{count:3},{cards:[a,a]},{cards:[a,c]},{voice:'clear'},{provider:'Englex'}])
    assert.equal(validateSoftVoiceManifest({...manifest,...changed},validIds),null);
});

test('soft audio refresh enables new recordings and rejects stale smaller indexes',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  let manifest={version:1,provider:'AI Voice Generator',voice:'delicate',count:2,cards:[a,b]};
  const context={audioIds:new Set([a]),chonishviliAIds:new Set(),chonishviliCleanIds:new Set(),englexRecordings:new Map(),englexRyanIds:new Set(),voiceLoadStatus:new Map([[SOFT_VOICE_URI,'ready']]),byId:new Map([[a,{}],[b,{}]]),SOFT_VOICE_URI,SOFT_VOICE_MANIFEST:'audio-index.json',CHONISHVILI_A_VOICE_URI,CHONISHVILI_A_MANIFEST:'a-index.json',CHONISHVILI_CLEAN_MANIFEST,validateChonishviliCleanManifest,ENGLEX_AI_VOICE_URI,ENGLEX_AI_MANIFEST:'englex-index.json',ENGLEX_RYAN_MANIFEST,validateEnglexRyanManifest,validateSoftVoiceManifest,validateChonishviliAManifest,validateEnglexAIManifest,voiceCardIds,assetUrl:path=>path,AbortController,setTimeout,clearTimeout,refreshVoices(){},updateAudioButtons(){},fetch:async path=>({ok:true,json:async()=>path.startsWith('audio-index')?manifest:null})};
  context.voiceData=()=>({softIds:context.audioIds,chonishviliAIds:context.chonishviliAIds,chonishviliCleanIds:context.chonishviliCleanIds,englexRecordings:context.englexRecordings,englexRyanIds:context.englexRyanIds});
  runInNewContext(app.slice(app.indexOf('let voiceManifestRequest=null;'),app.indexOf('function refreshCollection(')),context);
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.audioIds],[a,b]);
  manifest={...manifest,count:1,cards:[a]};
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.audioIds],[a,b],'old CDN response must not remove the new recording');
});

test('original and generated manifests grow independently and stale replies cannot reduce either source',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  let original={version:1,source:'englex-ai',recordings:{[a]:`audio/englex-ai/${a}.mp3`,[c]:`audio/englex-ai/${c}.mp3`}};
  let generated={version:1,provider:'Microsoft Edge',source:'generated',voice:ENGLEX_RYAN_VOICE,count:2,cards:[a,b]};
  const context={audioIds:new Set(),chonishviliAIds:new Set(),chonishviliCleanIds:new Set(),englexRecordings:new Map([[a,`audio/englex-ai/${a}.mp3`]]),englexRyanIds:new Set([b]),voiceLoadStatus:new Map([[ENGLEX_AI_VOICE_URI,'ready']]),byId:new Map([[a,{}],[b,{}],[c,{}]]),SOFT_VOICE_URI,SOFT_VOICE_MANIFEST:'audio-index.json',CHONISHVILI_A_VOICE_URI,CHONISHVILI_A_MANIFEST:'a-index.json',CHONISHVILI_CLEAN_MANIFEST,validateChonishviliCleanManifest,ENGLEX_AI_VOICE_URI,ENGLEX_AI_MANIFEST:'englex-index.json',ENGLEX_RYAN_MANIFEST,validateEnglexRyanManifest,validateSoftVoiceManifest,validateChonishviliAManifest,validateEnglexAIManifest,voiceCardIds,assetUrl:path=>path,AbortController,setTimeout,clearTimeout,refreshVoices(){},updateAudioButtons(){},fetch:async path=>({ok:true,json:async()=>path.startsWith('englex-index')?original:path.startsWith(ENGLEX_RYAN_MANIFEST)?generated:null})};
  context.voiceData=()=>({softIds:context.audioIds,chonishviliAIds:context.chonishviliAIds,chonishviliCleanIds:context.chonishviliCleanIds,englexRecordings:context.englexRecordings,englexRyanIds:context.englexRyanIds});
  runInNewContext(app.slice(app.indexOf('let voiceManifestRequest=null;'),app.indexOf('function refreshCollection(')),context);
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.englexRecordings.keys()],[a,c]);
  assert.deepEqual([...context.englexRyanIds],[a,b]);
  assert.equal(voiceCardIds(ENGLEX_AI_VOICE_URI,context.voiceData()).size,3,'source-specific stale checks must not compare a partial source with the union');
  original={...original,recordings:{[a]:`audio/englex-ai/${a}.mp3`}};generated={...generated,count:1,cards:[b]};
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.englexRecordings.keys()],[a,c]);assert.deepEqual([...context.englexRyanIds],[a,b]);
  assert.equal(context.voiceLoadStatus.get(ENGLEX_AI_VOICE_URI),'ready');
});

test('clean and original Choni manifests grow independently; stale or unavailable clean data never removes audio',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  let original={version:1,profile:'a-v1',voiceId:'089f2e853e064d6fb15f5b5882914b52',engine:'s2.1-pro-free',cards:[a,b,c]};
  let cleaned=cleanManifest([a,b]);
  const context={audioIds:new Set(),chonishviliAIds:new Set([a,b]),chonishviliCleanIds:new Set([a]),englexRecordings:new Map(),englexRyanIds:new Set(),voiceLoadStatus:new Map([[CHONISHVILI_A_VOICE_URI,'ready']]),byId:new Map([[a,{}],[b,{}],[c,{}]]),SOFT_VOICE_URI,SOFT_VOICE_MANIFEST:'audio-index.json',CHONISHVILI_A_VOICE_URI,CHONISHVILI_A_MANIFEST:'a-index.json',CHONISHVILI_CLEAN_MANIFEST,validateChonishviliCleanManifest,ENGLEX_AI_VOICE_URI,ENGLEX_AI_MANIFEST:'englex-index.json',ENGLEX_RYAN_MANIFEST,validateEnglexRyanManifest,validateSoftVoiceManifest,validateChonishviliAManifest,validateEnglexAIManifest,voiceCardIds,assetUrl:path=>path,AbortController,setTimeout,clearTimeout,refreshVoices(){},updateAudioButtons(){},fetch:async path=>({ok:true,json:async()=>path.startsWith('a-index')?original:path.startsWith(CHONISHVILI_CLEAN_MANIFEST)?cleaned:null})};
  context.voiceData=()=>({softIds:context.audioIds,chonishviliAIds:context.chonishviliAIds,chonishviliCleanIds:context.chonishviliCleanIds,englexRecordings:context.englexRecordings,englexRyanIds:context.englexRyanIds});
  runInNewContext(app.slice(app.indexOf('let voiceManifestRequest=null;'),app.indexOf('function refreshCollection(')),context);
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.chonishviliAIds],[a,b,c]);assert.deepEqual([...context.chonishviliCleanIds],[a,b]);
  assert.equal(voiceCardIds(CHONISHVILI_A_VOICE_URI,context.voiceData()).size,3);
  original={...original,cards:[a]};cleaned=cleanManifest([a]);
  await runInNewContext('refreshVoiceManifests()',context);
  assert.deepEqual([...context.chonishviliAIds],[a,b,c]);assert.deepEqual([...context.chonishviliCleanIds],[a,b]);
  cleaned=null;
  await runInNewContext('refreshVoiceManifests()',context);
  assert.equal(context.voiceLoadStatus.get(CHONISHVILI_A_VOICE_URI),'ready');
  assert.deepEqual([...context.chonishviliCleanIds],[a,b]);
});
