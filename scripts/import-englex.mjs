import assert from 'node:assert/strict';
import {open, readFile, rename, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {CARD_FIELDS, digest, meaningKey, normalized, summarizeCards, validateCard, validateDictionary} from './dictionary-integrity.mjs';

export const defaultDictionaryPath = fileURLToPath(new URL('../dist/dictionary.json', import.meta.url));

export function validateInput(input) {
  assert.ok(Array.isArray(input), 'Import must be a JSON array of cards');
  return input.map((card, i) => {
    validateCard(card, `Input ${i + 1}`, false);
    assert.deepEqual(Object.keys(card).sort(), [...CARD_FIELDS].sort(), `Input ${i + 1}: only word, translation, ipa, kind, added, lists are allowed`);
    // Preserve capitalization and punctuation; only normalize presentation
    // whitespace/Unicode. Matching is independently case insensitive.
    return Object.fromEntries(CARD_FIELDS.map(key => [key, card[key].normalize('NFKC').trim().replace(/\s+/gu, ' ')]));
  });
}

export function mergeEnglex(dictionary, input, {importedAt = new Date().toISOString()} = {}) {
  const incoming = validateInput(input);
  validateDictionary(dictionary);
  assert.ok(typeof importedAt === 'string' && new Date(importedAt).toISOString() === importedAt, 'importedAt must be an ISO timestamp');
  const cards = [...dictionary.cards];
  const byMeaning = new Map();
  const byWord = new Map();
  const ids = new Set();
  const indexCard = card => {
    const key = meaningKey(card);
    const word = normalized(card.word);
    if (!byMeaning.has(key)) byMeaning.set(key, card);
    if (!byWord.has(word)) byWord.set(word, []);
    byWord.get(word).push(card);
    ids.add(card.id);
  };
  cards.forEach(indexCard);
  const report = {received: incoming.length, added: 0, skipped: 0, conflicts: [], addedIds: []};
  for (const [i, candidate] of incoming.entries()) {
    const key = meaningKey(candidate);
    const existing = byMeaning.get(key);
    if (existing) {
      report.skipped++;
      const differingFields = ['ipa', 'kind', 'lists'].filter(field => normalized(existing[field]) !== normalized(candidate[field]));
      if (differingFields.length) report.conflicts.push({type: 'existing-metadata-preserved', inputIndex: i, word: candidate.word, existingId: existing.id, fields: differingFields});
      continue;
    }
    // Stable across retries, input ordering, lists, and the time of import.
    const id = digest(`englex-pocket:v1:${key}`).slice(0, 20);
    assert.ok(!ids.has(id), `Generated ID collision for ${candidate.word}; nothing was written`);
    const sameWord = byWord.get(normalized(candidate.word));
    if (sameWord) report.conflicts.push({type: 'additional-meaning-appended', inputIndex: i, word: candidate.word, translation: candidate.translation, existingIds: sameWord.map(card => card.id), newId: id});
    const card = {id, ...candidate};
    cards.push(card);
    indexCard(card);
    report.added++;
    report.addedIds.push(id);
  }
  if (!report.added) return {dictionary, changed: false, report};
  const metadata = {...dictionary.metadata, ...summarizeCards(cards)};
  if (!metadata.originalImport) metadata.originalImport = {source: metadata.source, ...(metadata.sha256 ? {sha256: metadata.sha256} : {})};
  metadata.source = 'Englex student dictionary + initial CSV import';
  // The original CSV checksum describes the initial source, not live content.
  delete metadata.sha256;
  metadata.sync = {source: 'Englex student dictionary', mode: 'append-only', kindSource: 'application classification', lastImportedAt: importedAt, lastImportAdded: report.added};
  const merged = {...dictionary, metadata, cards};
  validateDictionary(merged);
  return {dictionary: merged, changed: true, report};
}

export async function importEnglexFile(input, {dictionaryPath = defaultDictionaryPath, importedAt} = {}) {
  // Validate the complete input before taking a lock or touching any output.
  validateInput(input);
  dictionaryPath = resolve(dictionaryPath);
  const lockPath = `${dictionaryPath}.import.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another dictionary import is running; retry after it finishes');
    throw error;
  }
  const temporaryPath = `${dictionaryPath}.${randomUUID()}.tmp`;
  try {
    const before = await readFile(dictionaryPath);
    const result = mergeEnglex(JSON.parse(before), input, {importedAt});
    if (!result.changed) return result;
    const output = `${JSON.stringify(result.dictionary)}\n`;
    const handle = await open(temporaryPath, 'wx', 0o644);
    try { await handle.writeFile(output, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    assert.ok(before.equals(await readFile(dictionaryPath)), 'Dictionary changed during import; retry using the current version');
    // Same-directory rename is atomic; readers see either complete version.
    await rename(temporaryPath, dictionaryPath);
    return result;
  } finally {
    await unlink(temporaryPath).catch(error => {if (error.code !== 'ENOENT') throw error;});
    await lock.close();
    await unlink(lockPath);
  }
}

async function main() {
  const [inputPath, ...extra] = process.argv.slice(2);
  assert.ok(inputPath && !extra.length, 'Usage: node scripts/import-englex.mjs /path/to/englex-new-words.json');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const {changed, report} = await importEnglexFile(input);
  console.log(JSON.stringify({changed, ...report}, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });
}
