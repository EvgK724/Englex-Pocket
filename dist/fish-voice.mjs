// Public metadata only. Fish API credentials and synthesis stay off the website.
export const FISH_MODEL_ID = '089f2e853e064d6fb15f5b5882914b52';
export const FISH_VOICE_URI = `fish:${FISH_MODEL_ID}`;
export const FISH_ENGINE = 's2.1-pro-free';

export function validateFishManifest(raw, validIds) {
  if (!raw || raw.version !== 1 || raw.voiceId !== FISH_MODEL_ID ||
      raw.engine !== FISH_ENGINE || !Array.isArray(raw.cards) ||
      raw.cards.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id) || !validIds.has(id)) ||
      new Set(raw.cards).size !== raw.cards.length) return null;
  return new Set(raw.cards);
}

export function recordingFor({cardId, voiceURI, speechSupported, audioIds, fishIds, failedRecordings}) {
  if (!cardId) return null;
  const fishSelected = voiceURI === FISH_VOICE_URI;
  const fishKey = `${FISH_VOICE_URI}:${cardId}`;
  if (fishSelected && fishIds.has(cardId) && !failedRecordings.has(fishKey)) {
    return {path:`audio/fish-chonishvili/${cardId}.mp3`, key:fishKey, label:'Чонишвили · Fish Audio', fallback:false};
  }
  if ((voiceURI === 'auto' || !speechSupported) &&
      audioIds.has(cardId) && !failedRecordings.has(cardId)) {
    return {path:`audio/${cardId}.mp3`, key:cardId, label:'AI Voice', fallback:fishSelected};
  }
  return null;
}
