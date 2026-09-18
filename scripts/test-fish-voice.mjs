import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {FISH_VOICE_URI, FISH_ENGLISH_VOICE_URI, FISH_MODEL_ID, FISH_ENGINE, FISH_PROFILES, isFishVoice, idsForFishVoice, validateFishManifest, recordingFor} from '../dist/fish-voice.mjs';

const a='aaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbb';
const validIds=new Set([a,b]);
const manifest={version:1,voiceId:FISH_MODEL_ID,engine:FISH_ENGINE,cards:[a]};
const state={cardId:a,voiceURI:FISH_VOICE_URI,speechSupported:true,audioIds:new Set([a,b]),fishIds:new Set([a]),failedRecordings:new Set()};

test('only complete, known, unique card manifests can enable the voice',()=>{
  assert.deepEqual([...validateFishManifest(manifest,validIds)],[a]);
  assert.equal(validateFishManifest({...manifest,cards:[a,a]},validIds),null);
  assert.equal(validateFishManifest({...manifest,cards:['../secret']},validIds),null);
  assert.equal(validateFishManifest({...manifest,cards:['cccccccccccccccccccc']},validIds),null);
  assert.equal(validateFishManifest({...manifest,voiceId:'other'},validIds),null);
  assert.equal(validateFishManifest({...manifest,engine:'s2.1-pro'},validIds),null);
  assert.equal(validateFishManifest(null,validIds),null);
  assert.equal(validateFishManifest({...manifest,cards:[]},validIds).size,0);
});

test('Fish selection routes the right card and uses device speech for missing/failed recordings',()=>{
  assert.equal(recordingFor(state).path,`audio/fish-chonishvili/${a}.mp3?v=clean-1`);
  assert.equal(recordingFor({...state,cardId:b}),null);
  assert.equal(recordingFor({...state,failedRecordings:new Set([`${FISH_VOICE_URI}:${a}`])}),null);
  const fallback=recordingFor({...state,cardId:b,speechSupported:false});
  assert.equal(fallback.path,`audio/${b}.mp3`);
  assert.equal(fallback.fallback,true,'original audio must be explicitly marked as fallback');
});

test('existing original and device voices keep their routing and independent failure states',()=>{
  assert.equal(recordingFor({...state,voiceURI:'auto'}).path,`audio/${a}.mp3`);
  assert.equal(recordingFor({...state,voiceURI:'device:auto'}),null);
  assert.equal(recordingFor({...state,voiceURI:'Samantha'}),null);
  assert.equal(recordingFor({...state,failedRecordings:new Set([a])}).path,`audio/fish-chonishvili/${a}.mp3?v=clean-1`);
  assert.equal(recordingFor({...state,voiceURI:'auto',failedRecordings:new Set([`${FISH_VOICE_URI}:${a}`])}).path,`audio/${a}.mp3`);
});


function voiceContext(app, preferred=FISH_VOICE_URI) {
  const selects=Object.fromEntries(['voice-select','card-voice-select'].map(id=>[id,{options:[],replaceChildren(...options){this.options=options;},value:''}]));
  selects['card-voice-note']={textContent:''};
  const context={state:{voiceURI:preferred,cards:[{id:a},{id:b}]},fishIds:new Set(),fishEnglishIds:new Set(),audioIds:new Set([a]),speechSupported:false,voices:[],FISH_VOICE_URI,FISH_ENGLISH_VOICE_URI,FISH_PROFILES,isFishVoice,idsForFishVoice,recordingFor,failedRecordings:new Set(),current:()=>null,byId:new Map([[a,{id:a,word:'First generated card'}],[b,{id:b,word:'Current card'}]]),$:id=>selects[id],Option:function(text,value){this.text=text;this.value=value;}};
  const code=app.slice(app.indexOf('function refreshVoices(){'),app.indexOf('function updateAudioButtons(){'));
  runInNewContext(code,context);
  context.resetSpeech=()=>{context.resets=(context.resets||0)+1;runInNewContext('refreshVoices();',context);};
  context.save=()=>{context.saved=JSON.stringify({voiceURI:context.state.voiceURI});};
  return {context,selects};
}

test('both selectors preserve a saved optional preference until its manifest loads',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  for(const preferred of [FISH_VOICE_URI,FISH_ENGLISH_VOICE_URI]){
    const {context,selects}=voiceContext(app,preferred);
    runInNewContext('refreshVoices();',context);
    assert.equal(context.state.voiceURI,preferred);
    runInNewContext('pendingRecording=getRecording(byId.get(\"'+a+'\"));',context);
    assert.equal(context.pendingRecording.path,`audio/${a}.mp3`,'while metadata is unavailable playback matches the displayed auto voice');
    for(const id of ['voice-select','card-voice-select'])assert.equal(selects[id].options.some(o=>o.value===preferred),false,'empty voice must not be offered');
    idsForFishVoice(preferred,context.fishIds,context.fishEnglishIds).add(a);
    runInNewContext('refreshVoices();',context);
    for(const id of ['voice-select','card-voice-select']){
      assert.equal(selects[id].value,preferred);
      assert.equal(selects[id].options.some(o=>o.value===preferred),true);
    }
    runInNewContext('result=voiceTestCard();',context);
    assert.equal(context.result.id,a,'preview must use an available recording');
  }
});

test('changing either selector synchronizes the other and persists globally across cards',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const {context,selects}=voiceContext(app,'auto');
  context.fishIds.add(a);context.fishEnglishIds.add(b);
  runInNewContext('selectVoice(FISH_ENGLISH_VOICE_URI);',context);
  assert.equal(JSON.parse(context.saved).voiceURI,FISH_ENGLISH_VOICE_URI);
  assert.equal(selects['voice-select'].value,FISH_ENGLISH_VOICE_URI);
  assert.equal(selects['card-voice-select'].value,FISH_ENGLISH_VOICE_URI);
  context.current=()=>context.byId.get(b);
  runInNewContext('refreshVoices();result=voiceTestCard();',context);
  assert.equal(context.result.id,b);
  assert.equal(context.state.voiceURI,FISH_ENGLISH_VOICE_URI);
  runInNewContext('selectVoice(FISH_VOICE_URI);result=voiceTestCard();',context);
  assert.equal(context.result.id,a,'uncovered current card uses first available preview of selected profile');
  assert.equal(selects['card-voice-select'].value,FISH_VOICE_URI);
  assert.equal(context.resets,2,'switching stops old playback');
  context.failedRecordings.add(`${FISH_VOICE_URI}:${a}`);
  runInNewContext('result=voiceTestCard();',context);
  assert.equal(context.result,null,'preview must not silently substitute a different voice');
});

test('English trial requires its own manifest, files and failures without altering accepted clean audio',()=>{
  const english={...manifest,profile:'en-gb-v1',cards:[b]};
  assert.equal(validateFishManifest(english,validIds),null);
  assert.equal(validateFishManifest(manifest,validIds,'en-gb-v1'),null);
  assert.deepEqual([...validateFishManifest(english,validIds,'en-gb-v1')],[b]);
  assert.equal(validateFishManifest({...english,profile:'en-gb-v2'},validIds,'en-gb-v1'),null);
  const selected={...state,voiceURI:FISH_ENGLISH_VOICE_URI,fishEnglishIds:new Set([b]),cardId:b};
  assert.equal(recordingFor(selected).path,`audio/fish-chonishvili-en-gb-v1/${b}.mp3?v=en-gb-v1`);
  assert.equal(recordingFor({...selected,cardId:a}),null,'accepted voice must not masquerade as English trial');
  assert.equal(recordingFor({...state,fishEnglishIds:new Set([a]),failedRecordings:new Set([`${FISH_ENGLISH_VOICE_URI}:${a}`])}).path,`audio/fish-chonishvili/${a}.mp3?v=clean-1`);
});
