// Ryan is the sole active voice. Legacy manifest validators preserve archive checks.
export const ENGLEX_AI_VOICE_URI = 'englex-ai';
export const CHONISHVILI_A_VOICE_URI = 'fish:089f2e853e064d6fb15f5b5882914b52:a-v1';
export const SOFT_VOICE_URI = 'auto';
export const VOICE_PREFERENCE_VERSION = 4;
export const VOICE_OPTIONS = Object.freeze([
  Object.freeze({uri:ENGLEX_AI_VOICE_URI,label:'Ryan'})
]);
export const CHONISHVILI_A_MANIFEST = 'fish-chonishvili-a-v1-index.json';
export const CHONISHVILI_CLEAN_MANIFEST = 'fish-chonishvili-a-clean-v1-index.json';
export const ENGLEX_AI_MANIFEST = 'englex-ai-index.json';
export const ENGLEX_RYAN_MANIFEST = 'englex-ryan-index.json';
export const ENGLEX_RYAN_VOICE = 'en-GB-RyanNeural';
export const SOFT_VOICE_MANIFEST = 'audio-index.json';

export function migrateVoicePreference(_raw) {
  // Retire every previous voice selection without mutating learning progress.
  return ENGLEX_AI_VOICE_URI;
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

export function validateEnglexRyanManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.provider!=='Microsoft Edge'||raw.source!=='generated'||raw.voice!==ENGLEX_RYAN_VOICE||
      !Array.isArray(raw.cards)||raw.count!==raw.cards.length||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length)return null;
  return new Set(raw.cards);
}

export function validateChonishviliAManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.voiceId!=='089f2e853e064d6fb15f5b5882914b52'||
      raw.engine!=='s2.1-pro-free'||raw.profile!=='a-v1'||!Array.isArray(raw.cards)||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length)return null;
  return new Set(raw.cards);
}

export function validateChonishviliCleanManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.voiceId!=='089f2e853e064d6fb15f5b5882914b52'||
      raw.engine!=='s2.1-pro-free'||raw.profile!=='a-clean-v1'||raw.sourceProfile!=='a-v1'||
      !Array.isArray(raw.cards)||raw.count!==raw.cards.length||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length||!raw.sourceBlobs||
      typeof raw.sourceBlobs!=='object'||Array.isArray(raw.sourceBlobs)||
      Object.keys(raw.sourceBlobs).length!==raw.cards.length||
      raw.cards.some(id=>!Object.hasOwn(raw.sourceBlobs,id)||
        typeof raw.sourceBlobs[id]!=='string'||!/^[a-f0-9]{40}$/.test(raw.sourceBlobs[id])))return null;
  return new Set(raw.cards);
}

export function validateSoftVoiceManifest(raw,validIds) {
  if(!raw||raw.version!==1||raw.provider!=='AI Voice Generator'||raw.voice!=='delicate'||
      !Array.isArray(raw.cards)||raw.count!==raw.cards.length||
      raw.cards.some(id=>typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validIds.has(id))||
      new Set(raw.cards).size!==raw.cards.length)return null;
  return new Set(raw.cards);
}

export function voiceCardIds(voiceURI,{englexRecordings=new Map(),englexRyanIds=new Set()}={}) {
  if(voiceURI===ENGLEX_AI_VOICE_URI)return new Set([...englexRecordings.keys(),...englexRyanIds]);
  return new Set();
}

export function recordingForVoice({cardId,voiceURI,englexRecordings=new Map(),englexRyanIds=new Set(),failedRecordings=new Set()}) {
  if(typeof cardId!=='string'||!/^[a-f0-9]{20}$/.test(cardId)||voiceURI!==ENGLEX_AI_VOICE_URI)return null;
  let path=null,key=null,source=null;
  if(englexRecordings.has(cardId)){
    path=englexRecordings.get(cardId);key=`${voiceURI}:original:${cardId}`;source='englex-ai';
  }else if(englexRyanIds.has(cardId)){
    path=`audio/englex-ryan/${cardId}.mp3?v=ryan-v1`;key=`${voiceURI}:generated:${cardId}`;source='generated';
  }
  // Missing or failed Ryan audio must never silently select a different voice.
  return path&&!failedRecordings.has(key)?{path,key,label:'Ryan',source,fallback:false}:null;
}
