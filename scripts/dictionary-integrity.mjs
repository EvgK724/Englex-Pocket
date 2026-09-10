import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Canonical JSON of the original cards, in their original order. Adding cards
// is allowed; editing/removing/reordering these cards would lose saved progress.
export const ORIGINAL_COUNT = 8132;
export const ORIGINAL_CARDS_SHA256 = '9ccee37e30ac6715fcb86d52b7289415096b438ab22250c6766f79ae4914a230';
export const KINDS = new Set(['word', 'collocation', 'phrasal']);
export const CARD_FIELDS = ['word', 'translation', 'ipa', 'kind', 'added', 'lists'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const meaningKey = card => JSON.stringify([normalized(card.word), normalized(card.translation)]);

export function validateCard(card, label = 'Card', requireId = true) {
  assert.ok(card && typeof card === 'object' && !Array.isArray(card), `${label}: expected an object`);
  for (const key of CARD_FIELDS) assert.equal(typeof card[key], 'string', `${label}.${key}: expected a string`);
  assert.ok(card.word.trim() && card.translation.trim(), `${label}: word and translation are required`);
  for (const key of CARD_FIELDS) {
    assert.ok(card[key].length <= 10000, `${label}.${key}: too long`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(card[key]), `${label}.${key}: invalid control character`);
  }
  assert.ok(KINDS.has(card.kind), `${label}.kind: expected word, collocation, or phrasal`);
  assert.match(card.added, /^\d{4}-\d{2}-\d{2}$/, `${label}.added: expected YYYY-MM-DD`);
  const date = new Date(`${card.added}T00:00:00.000Z`);
  assert.ok(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === card.added, `${label}.added: invalid date`);
  if (requireId) assert.match(card.id, /^[a-f0-9]{20}$/, `${label}.id: expected 20 hexadecimal characters`);
}

export function summarizeCards(cards) {
  const kinds = {};
  let from = null;
  let through = null;
  let withIPA = 0;
  for (const card of cards) {
    kinds[card.kind] = (kinds[card.kind] || 0) + 1;
    if (from === null || card.added < from) from = card.added;
    if (through === null || card.added > through) through = card.added;
    if (card.ipa.trim()) withIPA++;
  }
  return {count: cards.length, kinds, from, through, withIPA};
}

export function validateDictionary(dictionary) {
  assert.ok(dictionary && typeof dictionary === 'object', 'Expected a dictionary object');
  assert.ok(Array.isArray(dictionary.cards), 'Dictionary cards must be an array');
  assert.ok(dictionary.cards.length >= ORIGINAL_COUNT, 'Original cards were removed');
  assert.equal(digest(JSON.stringify(dictionary.cards.slice(0, ORIGINAL_COUNT))), ORIGINAL_CARDS_SHA256, 'Original dictionary cards or IDs changed');
  const ids = new Set();
  const meanings = new Set();
  for (const [i, card] of dictionary.cards.entries()) {
    validateCard(card, `Card ${i + 1}`);
    assert.ok(!ids.has(card.id), `Duplicate card ID: ${card.id}`);
    ids.add(card.id);
    const key = meaningKey(card);
    // The source CSV already had one duplicate pair. Preserve it as-is, but
    // don't introduce new pairs with the same normalized word and meaning.
    if (i >= ORIGINAL_COUNT) assert.ok(!meanings.has(key), `Duplicate imported meaning: ${card.word}`);
    meanings.add(key);
  }
  assert.ok(dictionary.metadata && typeof dictionary.metadata === 'object', 'Missing dictionary metadata');
  const summary = summarizeCards(dictionary.cards);
  for (const key of Object.keys(summary)) assert.deepEqual(dictionary.metadata[key], summary[key], `Incorrect metadata.${key}`);
  return dictionary;
}

export function validateAudioIndex(index, dictionary) {
  assert.ok(index && Array.isArray(index.cards), 'Audio index cards must be an array');
  assert.equal(index.count, index.cards.length, 'Audio index count is incorrect');
  assert.equal(new Set(index.cards).size, index.cards.length, 'Duplicate audio ID');
  const cardIds = new Set(dictionary.cards.map(card => card.id));
  for (const id of index.cards) {
    assert.match(id, /^[a-f0-9]{20}$/);
    assert.ok(cardIds.has(id), `Audio recording has no dictionary card: ${id}`);
  }
}
