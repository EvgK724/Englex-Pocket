import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeText, selectCards} from '../dist/core.mjs';

function cards(rows) {
  return rows.map((row, order) => {
    const card = {id: String(order), word: '', translation: '', lists: '', kind: 'word', added: '2026-09-19', ...row, order};
    return {...card, search: normalizeText(`${card.word} ${card.translation} ${card.lists}`)};
  });
}

const state = overrides => ({query: '', kind: 'all', deck: 'all', sort: 'newest', stars: new Set(), ratings: {}, ...overrides});
const ids = (collection, overrides) => selectCards(collection, state(overrides)).map(card => card.id);

test('work, look and recover appear before newer phrases and list-only matches', () => {
  for (const word of ['work', 'look', 'recover']) {
    const collection = cards([
      {id: 'list', word: 'relevant experience', lists: word, added: '2026-09-19'},
      {id: 'phrase', word: `${word} with somebody`, kind: 'collocation', added: '2026-09-18'},
      {id: 'exact', word, added: '2020-01-01'},
      {id: 'translation', word: 'other', translation: word, added: '2026-09-20'}
    ]);
    assert.deepEqual(ids(collection, {query: word}), ['exact', 'phrase', 'translation', 'list']);
  }
});

test('exact phrases share the existing case, apostrophe, brace and whitespace normalization', () => {
  const collection = cards([
    {id: 'phrase', word: 'it is somebody’s work today'},
    {id: 'exact', word: '  [Somebody’s]   {Work}  ', added: '2020-01-01'},
    {id: 'list', word: 'other', lists: "somebody's work"}
  ]);
  for (const query of ["SOMEBODY'S WORK", ' somebody‘s  work ', '[somebody’s] {work}']) {
    assert.deepEqual(ids(collection, {query}), ['exact', 'phrase', 'list']);
  }
});

test('multiple tokens favor English, then English/translation, then matches requiring a list', () => {
  const collection = cards([
    {id: 'list', word: 'other', lists: 'medical work', added: '2026-09-23'},
    {id: 'word-list', word: 'work hard', lists: 'medical', added: '2026-09-22'},
    {id: 'translation', word: 'other', translation: 'medical work', added: '2026-09-21'},
    {id: 'word-translation', word: 'medical advice', translation: 'work', added: '2026-09-20'},
    {id: 'english', word: 'work in a medical team', added: '2026-09-19'},
    {id: 'exact', word: 'medical work', added: '2020-01-01'},
    {id: 'missing-token', word: 'medical'}
  ]);
  assert.deepEqual(ids(collection, {query: 'medical work'}), ['exact', 'english', 'translation', 'word-translation', 'list', 'word-list']);
  assert.deepEqual(ids(collection, {query: 'work medical'}), ['english', 'exact', 'translation', 'word-translation', 'list', 'word-list']);
});

test('Russian search retains ё normalization and translation relevance over list-only matches', () => {
  const collection = cards([
    {id: 'list', word: 'other', lists: 'медицинский учет', added: '2026-09-22'},
    {id: 'translation', word: 'medical record', translation: 'медицинский учёт', added: '2020-01-01'},
    {id: 'partial', word: 'account', translation: 'учёт'}
  ]);
  assert.deepEqual(ids(collection, {query: 'МЕДИЦИНСКИЙ УЧЁТ'}), ['translation', 'list']);
});

test('newest, oldest and alphabetical are respected inside every relevance tier', () => {
  const collection = cards([
    {id: 'exact-old', word: 'work', added: '2020-01-01'},
    {id: 'z-new', word: 'work zebra', added: '2026-09-19'},
    {id: 'a-old', word: 'work alpha', added: '2020-01-01'},
    {id: 'a-tie', word: 'work alpha', added: '2020-01-01'},
    {id: 'exact-new', word: 'work', added: '2026-09-19'},
    {id: 'list-z-new', word: 'zebra', lists: 'work', added: '2026-09-19'},
    {id: 'list-a-old', word: 'alpha', lists: 'work', added: '2020-01-01'}
  ]);
  assert.deepEqual(ids(collection, {query: 'work', sort: 'newest'}), ['exact-new', 'exact-old', 'z-new', 'a-old', 'a-tie', 'list-z-new', 'list-a-old']);
  assert.deepEqual(ids(collection, {query: 'work', sort: 'oldest'}), ['exact-old', 'exact-new', 'a-old', 'a-tie', 'z-new', 'list-a-old', 'list-z-new']);
  assert.deepEqual(ids(collection, {query: 'work', sort: 'alphabetical'}), ['exact-old', 'exact-new', 'a-old', 'a-tie', 'z-new', 'list-a-old', 'list-z-new']);
});

test('empty and whitespace-only search keep the existing selected order and do not mutate cards', () => {
  const collection = cards([
    {id: 'old', word: 'zebra', added: '2020-01-01'},
    {id: 'new', word: 'alpha', added: '2026-09-19'},
    {id: 'tie', word: 'alpha', added: '2026-09-19'}
  ]);
  const before = structuredClone(collection);
  for (const query of ['', '  \n\t  ']) {
    assert.deepEqual(ids(collection, {query, sort: 'newest'}), ['new', 'tie', 'old']);
    assert.deepEqual(ids(collection, {query, sort: 'oldest'}), ['old', 'new', 'tie']);
    assert.deepEqual(ids(collection, {query, sort: 'alphabetical'}), ['new', 'tie', 'old']);
  }
  selectCards(collection, state({query: 'alpha'}));
  assert.deepEqual(collection, before);
});

test('kind, starred and review filters continue to restrict exact and partial matches', () => {
  const collection = cards([
    {id: 'exact', word: 'work', kind: 'word'},
    {id: 'phrase', word: 'work hard', kind: 'collocation'},
    {id: 'phrasal', word: 'work out', kind: 'phrasal'},
    {id: 'unmatched', word: 'rest', kind: 'word'}
  ]);
  const stars = new Set(['phrase', 'unmatched']);
  const ratings = {phrasal: 'review', exact: 'known'};
  assert.deepEqual(ids(collection, {query: 'work', kind: 'phrasal'}), ['phrasal']);
  assert.deepEqual(ids(collection, {query: 'work', deck: 'starred', stars}), ['phrase']);
  assert.deepEqual(ids(collection, {query: 'work', deck: 'review', ratings}), ['phrasal']);
  assert.deepEqual(ids(collection, {query: 'work', kind: 'word', deck: 'starred', stars}), []);
  assert.deepEqual(ids(collection, {query: 'work absent'}), []);
});
