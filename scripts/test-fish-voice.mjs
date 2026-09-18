import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {FISH_VOICE_URI, FISH_MODEL_ID, FISH_ENGINE, validateFishManifest, recordingFor} from '../dist/fish-voice.mjs';

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

test('a saved Fish preference survives startup before its optional manifest finishes loading',async()=>{
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const refresh=app.slice(app.indexOf('function refreshVoices(){'),app.indexOf('function getRecording('));
  const select={options:[],replaceChildren(...options){this.options=options;},add(option){this.options.push(option);},value:''};
  const context={state:{voiceURI:FISH_VOICE_URI},fishIds:new Set(),audioIds:new Set([a]),speechSupported:false,voices:[],FISH_VOICE_URI,$:()=>select,Option:function(text,value){this.text=text;this.value=value;}};
  runInNewContext(`${refresh}\nrefreshVoices();`,context);
  assert.equal(context.state.voiceURI,FISH_VOICE_URI);
  assert.equal(select.options.some(o=>o.value===FISH_VOICE_URI),false,'empty voice must not be offered');
  context.fishIds.add(a);
  runInNewContext('refreshVoices();',context);
  assert.equal(select.value,FISH_VOICE_URI);
  assert.equal(select.options.some(o=>o.value===FISH_VOICE_URI),true);
  const testCard=app.slice(app.indexOf('function voiceTestCard(){'),app.indexOf('function updateAudioButtons(){'));
  context.byId=new Map([[a,{id:a,word:'First generated card'}]]);
  runInNewContext(`${testCard}\nresult=voiceTestCard();`,context);
  assert.equal(context.result.id,a,'preview must use a generated Fish card, not a fixed unavailable word');
});
