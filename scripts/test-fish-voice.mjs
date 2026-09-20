import assert from 'node:assert/strict';
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


test('English trial requires its own manifest, files and failures without altering accepted clean audio',()=>{
  const english={...manifest,profile:'en-gb-v1',cards:[b]};
  assert.equal(validateFishManifest(english,validIds),null);
  assert.equal(validateFishManifest(manifest,validIds,'en-gb-v1'),null);
  assert.deepEqual([...validateFishManifest(english,validIds,'en-gb-v1')],[b]);
  assert.equal(validateFishManifest({...english,profile:'en-gb-v2'},validIds,'en-gb-v1'),null);
  const selected={...state,voiceURI:FISH_ENGLISH_VOICE_URI,fishEnglishIds:new Set([b]),cardId:b};
  assert.equal(recordingFor(selected).path,`audio/fish-chonishvili-en-gb-v1/${b}.mp3?v=recover-phonemes-2`);
  assert.equal(recordingFor({...selected,cardId:a}),null,'accepted voice must not masquerade as English trial');
  assert.equal(recordingFor({...state,fishEnglishIds:new Set([a]),failedRecordings:new Set([`${FISH_ENGLISH_VOICE_URI}:${a}`])}).path,`audio/fish-chonishvili/${a}.mp3?v=clean-1`);
});

