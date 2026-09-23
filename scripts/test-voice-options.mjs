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

test('Ryan is the only preference for fresh installs and all previous voice versions without changing progress',()=>{
  assert.equal(VOICE_PREFERENCE_VERSION,4);
  assert.equal(migrateVoicePreference(null),ENGLEX_AI_VOICE_URI);
  for(const recordedVoiceVersion of [undefined,1,2,3,4,5]){
    for(const voiceURI of ['auto','device:auto','Samantha',CHONISHVILI_A_VOICE_URI,ENGLEX_AI_VOICE_URI,'removed-voice'])
      assert.equal(migrateVoicePreference({voiceURI,recordedVoiceVersion}),ENGLEX_AI_VOICE_URI);
  }
  const progress={voiceURI:'auto',recordedVoiceVersion:3,stars:[a],ratings:{[b]:'known'},currentId:b,rate:.8};
  const before=structuredClone(progress);
  assert.equal(migrateVoicePreference(progress),ENGLEX_AI_VOICE_URI);
  assert.deepEqual(progress,before,'migration must not mutate learning progress');
});

test('card button and settings menu expose only Ryan',async()=>{
  assert.deepEqual(VOICE_OPTIONS.map(voice=>voice.label),['Ryan']);
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const menus=[...html.matchAll(/<select id="(voice-select)"[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(menus.length,1);
  for(const [,id,markup] of menus){
    assert.deepEqual([...markup.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map(match=>match[1]),['Ryan'],id);
    assert.match(markup,/<option value="englex-ai" selected>Ryan<\/option>/);
    assert.equal((markup.match(/\bselected\b/g)||[]).length,1);
  }
  assert.doesNotMatch(html,/id="card-voice-select"/);
  const group=html.match(/<[^>]+id="card-voice-buttons"[^>]*>/)?.[0];
  assert.ok(group,'card voice controls have a labelled group');
  assert.match(group,/role="group"/);
  assert.match(group,/aria-label="Голос для карточек"/);
  const buttons=[...html.matchAll(/<button\b([^>]*\bdata-card-voice="([^"]+)"[^>]*)>([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map(match=>[match[2],match[3]]),VOICE_OPTIONS.map(voice=>[voice.uri,voice.label]));
  for(const [,attributes,uri] of buttons){
    assert.match(attributes,/type="button"/);
    assert.match(attributes,new RegExp(`aria-pressed="${uri===ENGLEX_AI_VOICE_URI}"`));
  }
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('const state='),app.indexOf('let byId='));
  assert.equal(runInNewContext(`${source}\nstate.voiceURI`,{ENGLEX_AI_VOICE_URI}),ENGLEX_AI_VOICE_URI);
  assert.doesNotMatch(html,/Englex · AI|Чонишвили · вариант A|AI Voice · мягкий голос|Choni|Doris|выберите другой из трёх/i);
  const css=await readFile(new URL('../dist/comfort.css',import.meta.url),'utf8');
  assert.match(css,/grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css,/min-height: 44px/);
});

test('actual progress load/save migrates Choni and Doris to Ryan without resetting learning state',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const original={version:1,recordedVoiceVersion:3,voiceURI:CHONISHVILI_A_VOICE_URI,stars:[a],ratings:{[a]:'review',[b]:'known'},currentId:b,rate:1.05,kind:'phrasal',sort:'alphabetical'};
  let stored=JSON.stringify(original);
  const context={state:{stars:new Set(),ratings:{},voiceURI:ENGLEX_AI_VOICE_URI},searchBookmark:null,currentId:null,byId:new Map([[a,{id:a}],[b,{id:b}]]),STORAGE_KEY:'englex-pocket-v1',VOICE_PREFERENCE_VERSION,VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,migrateVoicePreference,sanitizeProgress,storageWarning:false,toast:()=>assert.fail('valid progress should load'),resetSpeech(){},localStorage:{getItem:()=>stored,setItem:(key,value)=>{assert.equal(key,'englex-pocket-v1');stored=value;}}};
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
    assert.equal(context.state.voiceURI,ENGLEX_AI_VOICE_URI,'old controls cannot select a retired voice');
    stored=JSON.stringify({...original,voiceURI:uri,recordedVoiceVersion:3});
    runInNewContext('loadProgress();save();',context);
    assert.deepEqual(JSON.parse(stored),{...original,recordedVoiceVersion:VOICE_PREFERENCE_VERSION,voiceURI:ENGLEX_AI_VOICE_URI},'retired choices are ignored and every learning field survives reload');
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
  assert.equal(VOICE_OPTIONS.length,1);
  const original=recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI});
  const generated=recordingForVoice({...voices,cardId:b,voiceURI:ENGLEX_AI_VOICE_URI});
  assert.equal(original.path,`audio/englex-ai/${a}.mp3`);assert.equal(original.source,'englex-ai');
  assert.equal(generated.path,`audio/englex-ryan/${b}.mp3?v=ryan-v1`);assert.equal(generated.source,'generated');
  assert.equal(generated.label,'Ryan');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI,failedRecordings:new Set([original.key])}),null,'failed original is not silently exchanged for generated audio');
  assert.equal(recordingForVoice({...voices,cardId:a,voiceURI:ENGLEX_AI_VOICE_URI,failedRecordings:new Set([`${ENGLEX_AI_VOICE_URI}:generated:${a}`])}).source,'englex-ai','an original added later is not blocked by a previous generated-recording failure');
  assert.equal(recordingForVoice({...voices,cardId:b,voiceURI:SOFT_VOICE_URI}),null,'archived Doris is not an active choice');
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

test('archived Choni and Doris metadata cannot reactivate playback or coverage',()=>{
  const voices={...data,chonishviliAIds:new Set([a,b]),chonishviliCleanIds:new Set([a,b]),englexRyanIds:new Set([a,b])};
  for(const voiceURI of [CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,'device:auto','removed-voice']){
    assert.equal(voiceCardIds(voiceURI,voices).size,0);
    for(const cardId of [a,b])assert.equal(recordingForVoice({...voices,cardId,voiceURI}),null);
  }
});

test('Ryan unavailable or failed recordings never fall back to another voice',()=>{
  const route=(cardId=a,failedRecordings=new Set())=>recordingForVoice({voiceURI:ENGLEX_AI_VOICE_URI,cardId,...data,failedRecordings});
  assert.equal(route(a),null,'archived Choni or Doris cannot masquerade as Ryan');
  const recording=route(b);
  assert.equal(recording.path,`audio/englex-ai/${b}.mp3`);
  assert.equal(route(b,new Set([recording.key])),null);
  assert.equal(route('../invalid'),null);
});

async function uiContext(preferred=ENGLEX_AI_VOICE_URI){
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,options:[],dataset:{},attrs:new Map(),listeners:new Map(),replaceChildren(...options){this.options=options;},getAttribute(key){return this.attrs.get(key);},setAttribute(key,value){this.attrs.set(key,String(value));},removeAttribute(key){this.attrs.delete(key);},addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(handler);},dispatch(type){for(const handler of this.listeners.get(type)||[])handler({target:this,currentTarget:this});},click(){this.dispatch('click');}});
    return nodes.get(id);
  };
  const voiceButtons=VOICE_OPTIONS.map(voice=>Object.assign(node(`voice-button:${voice.uri}`),{dataset:{cardVoice:voice.uri},textContent:voice.label}));
  const document={activeElement:null,querySelectorAll:selector=>selector==='[data-card-voice]'?voiceButtons:[],addEventListener(){}};
  for(const button of voiceButtons)button.focus=()=>{document.activeElement=button;};
  node('card-voice-buttons').querySelectorAll=selector=>selector==='[data-card-voice]'?voiceButtons:[];
  const context={state:{voiceURI:preferred,cards:[{id:a},{id:b}],rate:.9},audioIds:new Set([a,b]),chonishviliAIds:new Set(),chonishviliCleanIds:new Set(),englexRecordings:new Map(),englexRyanIds:new Set(),voiceLoadStatus:new Map(),failedRecordings:new Set(),VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,voiceCardIds,recordingForVoice,
    byId:new Map([[a,{id:a,word:'First recording'}],[b,{id:b,word:'Current phrase'}]]),current:()=>({id:b,word:'Current phrase'}),$:node,document,Option:function(label,value){this.label=label;this.value=value;},assetUrl:path=>path,speechText:word=>word,
    save(){this.savedURI=this.state.voiceURI;},recordedSpeech:{stop(){},play(path,callbacks){context.played=path;context.playbackCallbacks=callbacks;}}
  };
  context.save=()=>{context.savedURI=context.state.voiceURI;};
  runInNewContext(app.slice(app.indexOf('function voiceData(){'),app.indexOf('function bindEvents(){')),context);
  return {context,node,voiceButtons,app};
}

function assertVoiceSelection(context,node,voiceButtons,selected){
  assert.deepEqual(node('voice-select').options.map(option=>option.value),VOICE_OPTIONS.map(voice=>voice.uri));
  assert.deepEqual(voiceButtons.map(button=>button.dataset.cardVoice),VOICE_OPTIONS.map(voice=>voice.uri));
  assert.equal(node('voice-select').value,selected);
  assert.equal(context.state.voiceURI,selected);
  assert.equal(voiceButtons.filter(button=>button.getAttribute('aria-pressed')==='true').length,1,'one active card voice');
  for(const button of voiceButtons)assert.equal(button.getAttribute('aria-pressed'),String(button.dataset.cardVoice===selected));
}

test('both controls expose only Ryan while its audio is pending; another Ryan sample can be previewed',async()=>{
  const {context,node,voiceButtons}=await uiContext();
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assertVoiceSelection(context,node,voiceButtons,ENGLEX_AI_VOICE_URI);
  assert.equal(node('speak-front').disabled,true);
  assert.equal(node('test-voice').disabled,true);
  assert.match(node('card-voice-note').textContent,/Ryan.*пока недоступна/);
  assert.doesNotMatch(node('card-voice-note').textContent,/другой голос/);
  context.englexRyanIds.add(a);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('speak-front').disabled,true,'current phrase is not recorded as Ryan');
  assert.equal(node('test-voice').disabled,false,'another Ryan recording can be previewed');
  assert.match(node('voice-test-note').textContent,/First recording/);
  runInNewContext('selectVoice(SOFT_VOICE_URI);',context);
  assert.equal(context.savedURI,undefined,'retired choice must not persist');
  assertVoiceSelection(context,node,voiceButtons,ENGLEX_AI_VOICE_URI);
  context.englexRyanIds.add(b);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assert.equal(node('speak-front').disabled,false);
});

test('card button clicks and settings changes sync both controls, keep focus, and save all learning state',async()=>{
  const {context,node,voiceButtons,app}=await uiContext();
  const original={version:1,recordedVoiceVersion:VOICE_PREFERENCE_VERSION,voiceURI:ENGLEX_AI_VOICE_URI,stars:[a],ratings:{[a]:'review',[b]:'known'},currentId:a,rate:1.05,kind:'phrasal',sort:'alphabetical'};
  let stored=JSON.stringify(original);
  Object.assign(context,{searchBookmark:{id:a},currentId:b,STORAGE_KEY:'englex-pocket-v1',VOICE_PREFERENCE_VERSION,migrateVoicePreference,sanitizeProgress,storageWarning:false,toast:()=>assert.fail('valid progress should save'),navigator:{userAgent:'test desktop'},toggleStar(){},openCollection(){},closeCollection(){},localStorage:{getItem:()=>stored,setItem:(key,value)=>{assert.equal(key,'englex-pocket-v1');stored=value;}}});
  Object.assign(context.state,{stars:new Set(original.stars),ratings:{...original.ratings},rate:original.rate,kind:original.kind,sort:original.sort});
  runInNewContext(app.slice(app.indexOf('function progress(){'),app.indexOf('function updateCounts(){')),context);
  runInNewContext(app.slice(app.indexOf('function bindEvents(){'),app.indexOf('\nbindEvents();')),context);
  runInNewContext('bindEvents();refreshVoices();updateAudioButtons();',context);
  const stableButtons=[...voiceButtons];
  for(const button of voiceButtons){
    button.focus();button.click();
    assertVoiceSelection(context,node,voiceButtons,button.dataset.cardVoice);
    assert.equal(context.document.activeElement,button,'refresh leaves the clicked button focused');
    assert.deepEqual(JSON.parse(stored),{...original,voiceURI:button.dataset.cardVoice},'voice selection preserves bookmark, stars, ratings, rate and filters');
  }
  for(const voice of [...VOICE_OPTIONS].reverse()){
    node('voice-select').value=voice.uri;node('voice-select').dispatch('change');
    assertVoiceSelection(context,node,voiceButtons,voice.uri);
    assert.deepEqual(JSON.parse(stored),{...original,voiceURI:voice.uri});
  }
  assert.deepEqual(context.document.querySelectorAll('[data-card-voice]'),stableButtons,'refresh never replaces the buttons');
});

test('card readiness stays concise while Settings and previews preserve original and generated provenance',async()=>{
  const {context,node,voiceButtons}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(a,`audio/englex-ai/${a}.mp3`);context.englexRyanIds.add(a);context.englexRyanIds.add(b);
  runInNewContext('refreshVoices();updateAudioButtons();',context);
  assertVoiceSelection(context,node,voiceButtons,ENGLEX_AI_VOICE_URI);
  assert.equal(node('card-voice-note').textContent,'Выбран для всей коллекции.');
  assert.equal(node('card-voice-note').hidden,true,'normal readiness does not take vertical card space');
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

test('dictionary refresh requests only dictionary data, never archived voice indexes',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const requested=[];
  const dictionary={metadata:{count:0},cards:[]};
  const context={AbortController,setTimeout,clearTimeout,assetUrl:path=>path,fetch:async(path,options)=>{
    requested.push(path);assert.equal(options.cache,'no-store');
    return {ok:true,json:async()=>dictionary};
  }};
  runInNewContext(app.slice(app.indexOf('async function fetchCollection(){'),app.indexOf('function installCollection(')),context);
  assert.equal(await runInNewContext('fetchCollection()',context),dictionary);
  assert.equal(requested.length,1);
  assert.match(requested[0],/^dictionary\.json\?sync=/);
  assert.doesNotMatch(app,/audio-index\.json|CHONISHVILI|SOFT_VOICE|Choni|Doris/);
});

test('original and generated manifests grow independently and stale replies cannot reduce either source',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const requested=[];
  let original={version:1,source:'englex-ai',recordings:{[a]:`audio/englex-ai/${a}.mp3`,[c]:`audio/englex-ai/${c}.mp3`}};
  let generated={version:1,provider:'Microsoft Edge',source:'generated',voice:ENGLEX_RYAN_VOICE,count:2,cards:[a,b]};
  const context={audioIds:new Set(),chonishviliAIds:new Set(),chonishviliCleanIds:new Set(),englexRecordings:new Map([[a,`audio/englex-ai/${a}.mp3`]]),englexRyanIds:new Set([b]),voiceLoadStatus:new Map([[ENGLEX_AI_VOICE_URI,'ready']]),byId:new Map([[a,{}],[b,{}],[c,{}]]),SOFT_VOICE_URI,SOFT_VOICE_MANIFEST:'audio-index.json',CHONISHVILI_A_VOICE_URI,CHONISHVILI_A_MANIFEST:'a-index.json',CHONISHVILI_CLEAN_MANIFEST,validateChonishviliCleanManifest,ENGLEX_AI_VOICE_URI,ENGLEX_AI_MANIFEST:'englex-index.json',ENGLEX_RYAN_MANIFEST,validateEnglexRyanManifest,validateSoftVoiceManifest,validateChonishviliAManifest,validateEnglexAIManifest,voiceCardIds,assetUrl:path=>path,AbortController,setTimeout,clearTimeout,refreshVoices(){},updateAudioButtons(){},fetch:async path=>{requested.push(path.split('?')[0]);return {ok:true,json:async()=>path.startsWith('englex-index')?original:path.startsWith(ENGLEX_RYAN_MANIFEST)?generated:null};}};
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
  assert.deepEqual([...new Set(requested)].sort(),['englex-index.json',ENGLEX_RYAN_MANIFEST].sort(),'only Ryan sources are fetched');
});


