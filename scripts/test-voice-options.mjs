import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {RecordedSpeech} from '../dist/recorded-speech.mjs';
import {
  VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,
  migrateVoicePreference,validateEnglexAIManifest,validateChonishviliAManifest,
  voiceCardIds,recordingForVoice
} from '../dist/voice-options.mjs';

const a='aaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbb',c='cccccccccccccccccccc';
const validIds=new Set([a,b]);
const data={softIds:new Set([a,b]),chonishviliAIds:new Set([a]),englexRecordings:new Map([[b,`audio/englex-ai/${b}.mp3`]])};

test('voice preference migrates removed choices while keeping explicit soft and new selections',()=>{
  assert.equal(migrateVoicePreference(null),CHONISHVILI_A_VOICE_URI);
  for(const uri of ['auto','device:auto','Samantha','fish:089f2e853e064d6fb15f5b5882914b52','fish:089f2e853e064d6fb15f5b5882914b52:en-gb-v1'])
    assert.equal(migrateVoicePreference({voiceURI:uri}),CHONISHVILI_A_VOICE_URI);
  for(const uri of VOICE_OPTIONS.map(voice=>voice.uri))
    assert.equal(migrateVoicePreference({voiceURI:uri,recordedVoiceVersion:2}),uri);
  const progress={voiceURI:'auto',recordedVoiceVersion:1,stars:[a],ratings:{[b]:'known'},currentId:b,rate:.8};
  const before=structuredClone(progress);
  assert.equal(migrateVoicePreference(progress),SOFT_VOICE_URI);
  assert.deepEqual(progress,before,'migration does not mutate learning progress');
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

test('A index cannot enable accepted or English trial audio, unknown IDs or paid engine data',()=>{
  const manifest={version:1,profile:'a-v1',voiceId:'089f2e853e064d6fb15f5b5882914b52',engine:'s2.1-pro-free',cards:[a]};
  assert.deepEqual([...validateChonishviliAManifest(manifest,validIds)],[a]);
  for(const changes of [{profile:null},{profile:'en-gb-v1'},{voiceId:'other'},{engine:'s2.1-pro'},{cards:[a,a]},{cards:[c]},{cards:['../a']}])
    assert.equal(validateChonishviliAManifest({...manifest,...changes},validIds),null);
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

async function uiContext(preferred=CHONISHVILI_A_VOICE_URI){
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,options:[],attrs:new Map(),replaceChildren(...options){this.options=options;},getAttribute(key){return this.attrs.get(key);},setAttribute(key,value){this.attrs.set(key,value);},removeAttribute(key){this.attrs.delete(key);}});
    return nodes.get(id);
  };
  const context={state:{voiceURI:preferred,cards:[{id:a},{id:b}],rate:.9},audioIds:new Set([a,b]),chonishviliAIds:new Set(),englexRecordings:new Map(),voiceLoadStatus:new Map(),failedRecordings:new Set(),VOICE_OPTIONS,ENGLEX_AI_VOICE_URI,CHONISHVILI_A_VOICE_URI,SOFT_VOICE_URI,voiceCardIds,recordingForVoice,
    byId:new Map([[a,{id:a,word:'First recording'}],[b,{id:b,word:'Current phrase'}]]),current:()=>({id:b,word:'Current phrase'}),$:node,Option:function(label,value){this.label=label;this.value=value;},assetUrl:path=>path,speechText:word=>word,
    save(){this.savedURI=this.state.voiceURI;},recordedSpeech:{stop(){},play(path,callbacks){context.played=path;context.playbackCallbacks=callbacks;}}
  };
  context.save=()=>{context.savedURI=context.state.voiceURI;};
  runInNewContext(app.slice(app.indexOf('function voiceData(){'),app.indexOf('function bindEvents(){')),context);
  return {context,node};
}

test('both menus always expose exactly three choices, including a selected voice with pending audio',async()=>{
  const {context,node}=await uiContext();
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

test('play starts synchronously from the click handler and failure never plays another voice',async()=>{
  const {context,node}=await uiContext(ENGLEX_AI_VOICE_URI);
  context.englexRecordings.set(b,`audio/englex-ai/${b}.mp3`);
  runInNewContext('pronounce(current(),$("speak-front"));',context);
  assert.equal(context.played,`audio/englex-ai/${b}.mp3`);
  context.playbackCallbacks.onStart();
  assert.match(node('audio-status').textContent,/Englex · AI: Current phrase/);
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
  assert.match(node('audio-status').textContent,/Englex · AI: Current phrase/);
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
