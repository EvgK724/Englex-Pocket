// Authored practice material is separate from the original Englex dictionary.
export const EXAMPLES_MANIFEST = 'examples.json';
export const EXAMPLES_AUDIO_MANIFEST = 'englex-examples-ryan-index.json';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{20}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export async function textHash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function exampleForCard(card, examples) {
  const example = examples.get(card?.id);
  return example && example.word === card.word && example.translation === card.translation ? example : null;
}

export async function validateExamples(raw, cards) {
  if (!object(raw) || raw.version !== 1 || raw.source !== 'authored-learning-examples' ||
      raw.level !== 'B1-B2' || !object(raw.examples)) return null;
  const examples = new Map();
  const rows = Object.entries(raw.examples);
  for (let start = 0; start < rows.length; start += 64) {
    await Promise.all(rows.slice(start, start + 64).map(async ([id, value]) => {
      const card = cards.get(id);
      // A newer manifest may arrive before the dictionary, or an old example
      // may remain while its meaning is edited. Never attach it to another sense.
      if (!ID.test(id) || !card || !object(value) || value.word !== card.word ||
          value.translation !== card.translation || typeof value.en !== 'string' ||
          !value.en.trim() || value.en !== value.en.trim() || typeof value.ru !== 'string' ||
          !value.ru.trim() || (value.note !== undefined && (typeof value.note !== 'string' ||
          !value.note.trim() || value.note !== value.note.trim() || value.note.length > 300 ||
          !/[а-яё]/i.test(value.note) || /[\u0000-\u001f\u007f]/.test(value.note))) ||
          !HASH.test(value.textSha256 || '')) return;
      if (await textHash(value.en) !== value.textSha256) return;
      examples.set(id, {...value});
    }));
  }
  return examples;
}

export function validateExampleAudio(raw, examples) {
  if (!object(raw) || raw.version !== 1 || raw.provider !== 'Microsoft Edge' ||
      raw.source !== 'generated' || raw.voice !== 'en-GB-RyanNeural' || !object(raw.recordings)) return null;
  const recordings = new Map();
  for (const [id, value] of Object.entries(raw.recordings)) {
    const example = examples.get(id);
    if (!ID.test(id) || !example || !object(value) || value.textSha256 !== example.textSha256 ||
        !HASH.test(value.audioSha256 || '') || !Number.isFinite(value.duration) || value.duration <= 0 ||
        value.path !== `audio/englex-examples-ryan/${id}-${example.textSha256.slice(0, 20)}-ryan-v1.mp3`) continue;
    recordings.set(id, {...value, key: `example:${id}:${value.textSha256}`, label: 'Ryan'});
  }
  return recordings;
}
