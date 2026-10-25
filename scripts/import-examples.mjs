// Authored learning examples are a sidecar: original Englex fields and IDs stay intact.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ID = /^[a-f0-9]{20}$/;
export function validSentence(value, language) {
  assert.equal(typeof value, 'string', `${language}: sentence must be text`);
  const text = value.trim();
  assert.ok(text.length > 0 && text.length <= (language === 'en' ? 600 : 1000), `${language}: invalid sentence length`);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(text), `${language}: control characters are not allowed`);
  assert.ok(language === 'en' ? /[a-z]/i.test(text) && !/[а-яё]/i.test(text) : /[а-яё]/i.test(text), `${language}: unexpected sentence language`);
  return text;
}
export function validNote(value) {
  assert.equal(typeof value, 'string', 'Example note must be text');
  const note = value.trim();
  assert.ok(note.length > 0 && note.length <= 300 && /[а-яё]/i.test(note) && !/[\u0000-\u001f\u007f]/.test(note), 'Example note must be Russian text up to 300 characters');
  return note;
}
export function validateExamples(raw, cards) {
  assert.ok(raw && raw.version === 1 && raw.source === 'authored-learning-examples' && raw.level === 'B1-B2', 'Invalid example provenance');
  assert.ok(raw.examples && typeof raw.examples === 'object' && !Array.isArray(raw.examples), 'Examples must be a mapping');
  const byId = new Map(cards.map(card => [card.id, card]));
  for (const [id, example] of Object.entries(raw.examples)) {
    const card = byId.get(id);
    assert.ok(ID.test(id) && card, `Unknown example card: ${id}`);
    assert.ok(example && typeof example === 'object' && !Array.isArray(example), `Invalid example: ${id}`);
    assert.deepEqual(Object.keys(example).sort(), ['word', 'translation', 'en', 'ru', 'textSha256', ...(Object.hasOwn(example, 'note') ? ['note'] : [])].sort(), `Unexpected example fields: ${id}`);
    assert.equal(example.word, card.word, `Example word changed: ${id}`);
    assert.equal(example.translation, card.translation, `Example meaning changed: ${id}`);
    assert.equal(example.en, validSentence(example.en, 'en'));
    assert.equal(example.ru, validSentence(example.ru, 'ru'));
    if (Object.hasOwn(example, 'note')) assert.equal(example.note, validNote(example.note));
    assert.equal(example.textSha256, sha256(example.en), `Example text hash mismatch: ${id}`);
  }
  return raw;
}
export function mergeExamples(dictionary, input, previous = {version: 1, source: 'authored-learning-examples', level: 'B1-B2', examples: {}}) {
  assert.ok(Array.isArray(dictionary?.cards), 'Dictionary cards are required');
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Input must map card IDs to {en,ru}');
  const byId = new Map(dictionary.cards.map(card => [card.id, card]));
  validateExamples(previous, dictionary.cards);
  const next = structuredClone(previous), added = [], updated = [];
  for (const [id, raw] of Object.entries(input)) {
    const card = byId.get(id);
    assert.ok(ID.test(id) && card, `Unknown dictionary card: ${id}`);
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), `Invalid input example: ${id}`);
    assert.deepEqual(Object.keys(raw).sort(), ['en', 'ru', ...(Object.hasOwn(raw, 'note') ? ['note'] : [])].sort(), `Input ${id}: only en, ru and optional note are allowed`);
    const en = validSentence(raw.en, 'en'), ru = validSentence(raw.ru, 'ru');
    const example = {word: card.word, translation: card.translation, en, ru, textSha256: sha256(en), ...(Object.hasOwn(raw, 'note') ? {note: validNote(raw.note)} : {})};
    if (JSON.stringify(previous.examples[id]) === JSON.stringify(example)) continue;
    (Object.hasOwn(previous.examples, id) ? updated : added).push(id);
    next.examples[id] = example;
  }
  // Stable dictionary order makes repeated imports produce no changes.
  next.examples = Object.fromEntries(dictionary.cards.filter(card => next.examples[card.id]).map(card => [card.id, next.examples[card.id]]));
  validateExamples(next, dictionary.cards);
  return {data: next, changed: added.length + updated.length > 0, added, updated};
}
export async function importExamples(inputPath, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const path = resolve(root, 'dist/examples.json');
  const dictionary = JSON.parse(await readFile(resolve(root, 'dist/dictionary.json'), 'utf8'));
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = mergeExamples(dictionary, input, previous);
  if (result.changed) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(result.data, null, 2) + '\n'); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return {changed: result.changed, added: result.added.length, updated: result.updated.length, count: Object.keys(result.data.examples).length};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, ...extra] = process.argv.slice(2);
  assert.ok(input && !extra.length, 'Usage: node scripts/import-examples.mjs /path/to/examples-by-id.json');
  console.log(JSON.stringify(await importExamples(input)));
}
