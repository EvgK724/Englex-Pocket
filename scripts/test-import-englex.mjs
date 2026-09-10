import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importEnglexFile, mergeEnglex} from './import-englex.mjs';
import {ORIGINAL_COUNT, ORIGINAL_CARDS_SHA256, digest, summarizeCards, validateAudioIndex, validateDictionary} from './dictionary-integrity.mjs';

const repositoryDictionary = JSON.parse(await readFile(new URL('../dist/dictionary.json', import.meta.url), 'utf8'));
// Import scenarios use the fixed original source, so real words added in the
// future cannot invalidate synthetic date/count expectations in this suite.
// The first test below separately validates the complete live dictionary.
const originalCards = repositoryDictionary.cards.slice(0, ORIGINAL_COUNT);
const originalDictionary = {
  metadata: {
    source: 'englex_dictionary_no_audio.csv',
    sha256: 'ae9c91d06d47998f19d8c66089def29d488193ec4fdfeb14ad07eb6bcbde41a9',
    ...summarizeCards(originalCards),
  },
  cards: originalCards,
};
const baseline = () => structuredClone(originalDictionary);
const importedAt = '2026-09-10T12:00:00.000Z';
const incoming = (overrides = {}) => ({word: 'new import test phrase alpha', translation: 'новая тестовая фраза альфа', ipa: '', kind: 'collocation', added: '2026-09-10', lists: '', ...overrides});
const withoutId = ({id, ...card}) => card;

test('current dictionary protects all original cards and has accurate growing metadata', () => {
  validateDictionary(repositoryDictionary);
  assert.equal(digest(JSON.stringify(repositoryDictionary.cards.slice(0, ORIGINAL_COUNT))), ORIGINAL_CARDS_SHA256);
});

test('appending preserves every existing card and progress ID; retry is a no-op', () => {
  const source = baseline();
  const before = structuredClone(source);
  const result = mergeEnglex(source, [incoming()], {importedAt});
  assert.equal(result.report.added, 1);
  assert.deepEqual(source, before, 'Input dictionary must not be mutated');
  assert.deepEqual(result.dictionary.cards.slice(0, source.cards.length), source.cards);
  const savedProgress = Object.fromEntries(source.cards.map(card => [card.id, {reviewed: true}]));
  for (const card of result.dictionary.cards.slice(0, source.cards.length)) assert.ok(savedProgress[card.id].reviewed);
  assert.match(result.dictionary.cards.at(-1).id, /^[a-f0-9]{20}$/);
  const retry = mergeEnglex(result.dictionary, [incoming()], {importedAt: '2026-09-11T12:00:00.000Z'});
  assert.equal(retry.changed, false);
  assert.equal(retry.report.added, 0);
  assert.equal(retry.report.skipped, 1);
  assert.strictEqual(retry.dictionary, result.dictionary, 'No timestamp churn for a duplicate check');
});

test('NFKC, case and whitespace variants match both historical and same-batch duplicates', () => {
  const existing = repositoryDictionary.cards[0];
  const input = [
    withoutId({...existing, word: `  ${existing.word.toUpperCase().replaceAll(' ', '\u00a0  ')} `, translation: ` ${existing.translation.toUpperCase()} `}),
    incoming({word: ' ＦＩＧＵＲＥ\u00a0   ＯＵＴ import test ', translation: 'Понять тест'}),
    incoming({word: 'figure out import test', translation: 'понять\n тест'}),
  ];
  const result = mergeEnglex(baseline(), input, {importedAt});
  assert.equal(result.report.added, 1);
  assert.equal(result.report.skipped, 2);
});

test('same word with a distinct translation is preserved as a separately identified meaning', () => {
  const original = repositoryDictionary.cards[0];
  const candidate = withoutId({...original, translation: 'Другое тестовое значение, которого ранее не было'});
  const result = mergeEnglex(baseline(), [candidate], {importedAt});
  assert.equal(result.report.added, 1);
  assert.deepEqual(result.dictionary.cards[0], original);
  assert.notEqual(result.dictionary.cards.at(-1).id, original.id);
  assert.equal(result.report.conflicts[0].type, 'additional-meaning-appended');
  assert.ok(result.report.conflicts[0].existingIds.includes(original.id));
  assert.equal(mergeEnglex(result.dictionary, [candidate], {importedAt}).report.added, 0);
});

test('changed pronunciation, kind or list on the same meaning is reported and never overwrites it', () => {
  const original = repositoryDictionary.cards[0];
  const result = mergeEnglex(baseline(), [withoutId({...original, ipa: 'changed IPA test', lists: 'Changed list test', kind: original.kind === 'word' ? 'phrasal' : 'word'})], {importedAt});
  assert.equal(result.changed, false);
  assert.deepEqual(result.dictionary.cards[0], original);
  assert.deepEqual(result.report.conflicts[0].fields, ['ipa', 'kind', 'lists']);
  assert.equal(result.report.conflicts[0].type, 'existing-metadata-preserved');
});

test('IDs are independent of batch order, date, list and import time', () => {
  const a = incoming();
  const b = incoming({word: 'new import test phrase beta', translation: 'новая тестовая фраза бета'});
  const first = mergeEnglex(baseline(), [a, b], {importedAt});
  const second = mergeEnglex(baseline(), [{...b, lists: 'other', added: '2026-09-09'}, {...a, ipa: 'test'}], {importedAt: '2026-09-11T12:00:00.000Z'});
  assert.deepEqual(new Set(first.report.addedIds), new Set(second.report.addedIds));
});

test('derived metadata covers additions and original CSV checksum remains explicitly historical', () => {
  const result = mergeEnglex(baseline(), [incoming({ipa: 'test', added: '2026-09-12', kind: 'word'})], {importedAt});
  const metadata = result.dictionary.metadata;
  for (const [key, expected] of Object.entries(summarizeCards(result.dictionary.cards))) assert.deepEqual(metadata[key], expected);
  assert.equal(metadata.through, '2026-09-12');
  assert.equal(metadata.sha256, undefined);
  assert.equal(metadata.originalImport.source, 'englex_dictionary_no_audio.csv');
  assert.equal(metadata.originalImport.sha256, 'ae9c91d06d47998f19d8c66089def29d488193ec4fdfeb14ad07eb6bcbde41a9');
  assert.equal(metadata.sync.lastImportedAt, importedAt);
  assert.equal(metadata.sync.lastImportAdded, 1);
  assert.equal(metadata.sync.mode, 'append-only');
});

test('removed, reordered, edited historical cards, duplicate IDs, bad metadata and duplicate imports fail integrity checks', () => {
  const edits = [
    d => {d.cards.pop();},
    d => {[d.cards[0], d.cards[1]] = [d.cards[1], d.cards[0]];},
    d => {d.cards[0].translation = 'changed';},
    d => {d.cards[0].id = '00000000000000000000';},
    d => {d.metadata.count++;},
    d => {d.cards.push({...incoming(), id: d.cards[0].id}); Object.assign(d.metadata, summarizeCards(d.cards));},
    d => {d.cards.push({...d.cards[0], id: '00000000000000000000'}); Object.assign(d.metadata, summarizeCards(d.cards));},
  ];
  for (const edit of edits) {const dictionary = baseline(); edit(dictionary); assert.throws(() => validateDictionary(dictionary));}
});

test('audio may cover a subset of cards, but unknown or repeated IDs are invalid', () => {
  const dictionary = mergeEnglex(baseline(), [incoming()], {importedAt}).dictionary;
  validateAudioIndex({count: 2, cards: dictionary.cards.slice(0, 2).map(card => card.id)}, dictionary);
  assert.throws(() => validateAudioIndex({count: 1, cards: ['00000000000000000000']}, dictionary));
  assert.throws(() => validateAudioIndex({count: 2, cards: [dictionary.cards[0].id, dictionary.cards[0].id]}, dictionary));
  assert.throws(() => validateAudioIndex({count: 2, cards: [dictionary.cards[0].id]}, dictionary));
});

test('invalid input writes nothing; a valid append and a retry leave no locks or temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'englex-import-test-'));
  const dictionaryPath = join(directory, 'dictionary.json');
  try {
    const originalBytes = `${JSON.stringify(baseline())}\n`;
    await writeFile(dictionaryPath, originalBytes);
    const invalidInputs = [
      {cards: [incoming()]}, [incoming({word: ''})], [incoming({translation: null})],
      [incoming({added: '2026-02-30'})], [incoming({kind: 'noun'})],
      [incoming({word: 'control\u0000character'})], [incoming({id: '00000000000000000000'})],
      [incoming(), incoming({translation: ''})],
    ];
    for (const input of invalidInputs) {
      await assert.rejects(importEnglexFile(input, {dictionaryPath, importedAt}));
      assert.equal(await readFile(dictionaryPath, 'utf8'), originalBytes);
      assert.deepEqual(await readdir(directory), ['dictionary.json']);
    }
    const result = await importEnglexFile([incoming()], {dictionaryPath, importedAt});
    assert.equal(result.report.added, 1);
    const bytesAfterImport = await readFile(dictionaryPath, 'utf8');
    validateDictionary(JSON.parse(bytesAfterImport));
    assert.equal((await importEnglexFile([incoming()], {dictionaryPath, importedAt})).changed, false);
    assert.equal(await readFile(dictionaryPath, 'utf8'), bytesAfterImport);
    assert.deepEqual(await readdir(directory), ['dictionary.json']);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('another importer lock blocks writes without deleting the existing lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'englex-import-lock-test-'));
  const dictionaryPath = join(directory, 'dictionary.json');
  try {
    const bytes = JSON.stringify(baseline());
    await writeFile(dictionaryPath, bytes);
    await writeFile(`${dictionaryPath}.import.lock`, 'other process');
    await assert.rejects(importEnglexFile([incoming()], {dictionaryPath, importedAt}), /Another dictionary import/);
    assert.equal(await readFile(dictionaryPath, 'utf8'), bytes);
    assert.equal(await readFile(`${dictionaryPath}.import.lock`, 'utf8'), 'other process');
  } finally {await rm(directory, {recursive: true, force: true});}
});
