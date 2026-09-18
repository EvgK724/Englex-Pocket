// Public metadata only. Fish API credentials and synthesis stay off the website.
export const FISH_MODEL_ID = '089f2e853e064d6fb15f5b5882914b52';
export const FISH_VOICE_URI = `fish:${FISH_MODEL_ID}`;
export const FISH_ENGLISH_VOICE_URI = `${FISH_VOICE_URI}:en-gb-v1`;
export const FISH_ENGINE = 's2.1-pro-free';
export const FISH_PROFILES = [
  {uri:FISH_VOICE_URI,label:'Чонишвили · Fish AI',manifest:'fish-chonishvili-index.json',directory:'audio/fish-chonishvili',profile:null,version:'clean-1'},
  {uri:FISH_ENGLISH_VOICE_URI,label:'Чонишвили · английская проба',manifest:'fish-chonishvili-en-gb-v1-index.json',directory:'audio/fish-chonishvili-en-gb-v1',profile:'en-gb-v1',version:'en-gb-v1'}
];
export const isFishVoice = uri => FISH_PROFILES.some(profile => profile.uri === uri);
export const idsForFishVoice = (uri, fishIds, fishEnglishIds) => uri === FISH_ENGLISH_VOICE_URI ? fishEnglishIds : fishIds;

export function validateFishManifest(raw, validIds, profile = null) {
  if (!raw || raw.version !== 1 || raw.voiceId !== FISH_MODEL_ID ||
      raw.engine !== FISH_ENGINE || (raw.profile ?? null) !== profile || !Array.isArray(raw.cards) ||
      raw.cards.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id) || !validIds.has(id)) ||
      new Set(raw.cards).size !== raw.cards.length) return null;
  return new Set(raw.cards);
}

export function recordingFor({cardId, voiceURI, speechSupported, audioIds, fishIds, fishEnglishIds = new Set(), failedRecordings}) {
  if (!cardId) return null;
  const profile = FISH_PROFILES.find(profile => profile.uri === voiceURI);
  const fishKey = `${voiceURI}:${cardId}`;
  const selectedIds = idsForFishVoice(voiceURI, fishIds, fishEnglishIds);
  if (profile && selectedIds.has(cardId) && !failedRecordings.has(fishKey)) {
    return {path:`${profile.directory}/${cardId}.mp3?v=${profile.version}`, key:fishKey, label:profile.label, fallback:false};
  }
  if ((voiceURI === 'auto' || !speechSupported) &&
      audioIds.has(cardId) && !failedRecordings.has(cardId)) {
    return {path:`audio/${cardId}.mp3`, key:cardId, label:'AI Voice', fallback:!!profile};
  }
  return null;
}
