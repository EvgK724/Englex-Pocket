// The three choices are stable even while their optional audio indexes load.
export const ENGLEX_AI_VOICE_URI = 'englex-ai';
export const CHONISHVILI_A_VOICE_URI = 'fish:089f2e853e064d6fb15f5b5882914b52:a-v1';
export const SOFT_VOICE_URI = 'auto';
export const VOICE_OPTIONS = Object.freeze([
  Object.freeze({uri:ENGLEX_AI_VOICE_URI,label:'Englex · AI'}),
  Object.freeze({uri:CHONISHVILI_A_VOICE_URI,label:'Чонишвили · вариант A'}),
  Object.freeze({uri:SOFT_VOICE_URI,label:'AI Voice · мягкий голос'})
]);
export const CHONISHVILI_A_MANIFEST = 'fish-chonishvili-a-v1-index.json';
export const ENGLEX_AI_MANIFEST = 'englex-ai-index.json';
export const SOFT_VOICE_MANIFEST = 'audio-index.json';

export function migrateVoicePreference(raw) {
  const uri=raw?.voiceURI;
  if(uri===ENGLEX_AI_VOICE_URI||uri===CHONISHVILI_A_VOICE_URI)return uri;
  // Only an explicit recorded-soft preference survives the old auto/device era.
  if(uri===SOFT_VOICE_URI&&[1,2].includes(raw?.recordedVoiceVersion))return SOFT_VOICE_URI;
  return CHONISHVILI_A_VOICE_URI;
}

export function validateEnglexAIManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.source!=='englex-ai'||!raw.recordings||
      typeof raw.recordings!=='object'||Array.isArray(raw.recordings))return null;
  const records=new Map();
  for(const [id,path] of Object.entries(raw.recordings)){
    if(!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id)||path!==`audio/englex-ai/${id}.mp3`)return null;
    records.set(id,path);
  }
  return records;
}

export function validateChonishviliAManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.voiceId!=='089f2e853e064d6fb15f5b5882914b52'||
      raw.engine!=='s2.1-pro-free'||raw.profile!=='a-v1'||!Array.isArray(raw.cards)||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length)return null;
  return new Set(raw.cards);
}

export function validateSoftVoiceManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.provider!=='AI Voice Generator'||raw.voice!=='delicate'||
      !Array.isArray(raw.cards)||raw.count!==raw.cards.length||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length)return null;
  return new Set(raw.cards);
}

export function voiceCardIds(voiceURI,{softIds=new Set(),chonishviliAIds=new Set(),englexRecordings=new Map()}={}) {
  if(voiceURI===SOFT_VOICE_URI)return softIds;
  if(voiceURI===CHONISHVILI_A_VOICE_URI)return chonishviliAIds;
  if(voiceURI===ENGLEX_AI_VOICE_URI)return new Set(englexRecordings.keys());
  return new Set();
}

export function recordingForVoice({cardId,voiceURI,softIds=new Set(),chonishviliAIds=new Set(),englexRecordings=new Map(),failedRecordings=new Set()}) {
  if(typeof cardId!=='string'||!/^[a-f0-9]{20}$/.test(cardId))return null;
  const option=VOICE_OPTIONS.find(voice=>voice.uri===voiceURI),key=`${voiceURI}:${cardId}`;
  if(!option||failedRecordings.has(key))return null;
  let path=null;
  if(voiceURI===SOFT_VOICE_URI&&softIds.has(cardId))path=`audio/${cardId}.mp3`;
  if(voiceURI===CHONISHVILI_A_VOICE_URI&&chonishviliAIds.has(cardId))path=`audio/fish-chonishvili-a-v1/${cardId}.mp3?v=a-v1`;
  if(voiceURI===ENGLEX_AI_VOICE_URI)path=englexRecordings.get(cardId)||null;
  // No voice substitutes for another: an absent record is genuinely unavailable.
  return path?{path,key,label:option.label}:null;
}
