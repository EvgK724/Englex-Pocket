import {appendFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {importEnglexAudio, normalizeEnglexAudioWord} from './import-englex-audio.mjs';
import {atomicWrite, isPlausibleMp3} from './generate-fish-audio.mjs';

// A bundle contains only original downloads of visible Englex AI playback.
// No network/audio-generation code, source URLs or credentials are accepted.
export const BUNDLE_PATH = '.englex-audio-import/batch.json';
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 1024 * 1024;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const manifestPath = 'dist/englex-ai-index.json';
const voicePath = id => `dist/audio/englex-ai/${id}.mp3`;

export function decodeEnglexBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BUNDLE_BYTES) throw new Error('Englex AI bundle exceeds 20 MiB.');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Englex AI bundle is not valid JSON.'); }
  if (raw?.version !== 1 || !Array.isArray(raw.recordings) || raw.recordings.length > 1000 ||
      Object.keys(raw).some(key => !['version', 'recordings'].includes(key))) throw new Error('Englex AI bundle must contain version 1 and at most 1000 recordings.');
  let totalBytes = 0;
  return raw.recordings.map(row => {
    if (!row || typeof row.word !== 'string' || !normalizeEnglexAudioWord(row.word) || row.word.length > 500 ||
        typeof row.audioBase64 !== 'string' || Object.keys(row).some(key => !['word', 'audioBase64'].includes(key)) ||
        row.audioBase64.length > 4 * Math.ceil(MAX_RECORDING_BYTES / 3) ||
        row.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.audioBase64)) throw new Error('Invalid Englex AI word or canonical base64 recording.');
    const audio = Buffer.from(row.audioBase64, 'base64');
    totalBytes += audio.length;
    if (audio.length > MAX_RECORDING_BYTES || totalBytes > MAX_BUNDLE_BYTES || audio.toString('base64') !== row.audioBase64 ||
        !isPlausibleMp3(audio)) throw new Error('Englex AI bundle contains invalid or oversized MP3 audio.');
    return {word: row.word, audio};
  });
}

export async function publishEnglexAudioBundle({repoDir = ROOT, sourceCommit, workDir = join(ROOT, '.englex-ai-publish'), beforePush = async () => {}} = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('A full source commit SHA is required.');
  repoDir = resolve(repoDir); workDir = resolve(workDir);
  await mkdir(workDir, {recursive: true});
  const temporary = await mkdtemp(join(workDir, 'batch-'));
  const gitIndex = join(temporary, 'git-index');
  const git = async (args, binary = false) => (await run('git', args, {cwd: repoDir,
    env: {...process.env, GIT_INDEX_FILE: gitIndex}, encoding: binary ? 'buffer' : 'utf8', maxBuffer: MAX_BUNDLE_BYTES + 1024 * 1024})).stdout;
  const text = async args => (await git(args)).trim();
  const status = async result => { await atomicWrite(join(workDir, 'last-result.json'), JSON.stringify(result, null, 2) + '\n'); return result; };
  try {
    // The event's exact input must survive later pushes replacing batch.json.
    const size = Number(await text(['cat-file', '-s', `${sourceCommit}:${BUNDLE_PATH}`]));
    if (!Number.isInteger(size) || size < 0 || size > MAX_BUNDLE_BYTES) throw new Error('Englex AI bundle exceeds 20 MiB.');
    const recordings = decodeEnglexBundle(await git(['show', `${sourceCommit}:${BUNDLE_PATH}`], true));
    const input = [];
    for (let n = 0; n < recordings.length; n++) {
      const file = join(temporary, `capture-${n}.mp3`);
      await writeFile(file, recordings[n].audio, {flag: 'wx'});
      input.push({word: recordings[n].word, file});
    }
    const inputFile = join(temporary, 'captured-ai.json');
    await writeFile(inputFile, JSON.stringify(input));
    const requestedWords = new Set(recordings.map(item => normalizeEnglexAudioWord(item.word)));
    for (let attempt = 0; attempt < 3; attempt++) {
      await text(['fetch', '--quiet', 'origin', 'main']);
      const parent = await text(['rev-parse', 'origin/main']);
      const distDir = join(temporary, `snapshot-${attempt}`, 'dist');
      await mkdir(distDir, {recursive: true});
      const dictionaryBytes = await git(['show', `${parent}:dist/dictionary.json`], true);
      const dictionary = JSON.parse(dictionaryBytes);
      if (!Array.isArray(dictionary.cards)) throw new Error('Current dictionary is invalid.');
      const matchedIds = new Set(dictionary.cards.filter(card => typeof card?.word === 'string' && requestedWords.has(normalizeEnglexAudioWord(card.word))).map(card => card.id));
      await writeFile(join(distDir, 'dictionary.json'), dictionaryBytes);
      const hasManifest = await text(['ls-tree', '--name-only', parent, '--', manifestPath]);
      const previousManifest = hasManifest ? await git(['show', `${parent}:${manifestPath}`], true) : null;
      if (previousManifest) await writeFile(join(distDir, 'englex-ai-index.json'), previousManifest);
      const audioTree = await text(['ls-tree', '-r', '--format=%(objectname) %(path)', parent, '--', 'dist/audio/englex-ai']);
      const currentAudio = new Map(audioTree ? audioTree.split('\n').map(line => [line.slice(41), line.slice(0, 40)]) : []);
      // Include even unindexed existing files so the importer cannot replace them.
      for (const id of matchedIds) {
        if (!/^[a-f0-9]{20}$/.test(id || '')) throw new Error('Current dictionary ID is invalid.');
        const existing = currentAudio.get(voicePath(id));
        if (existing) await atomicWrite(join(distDir, 'audio', 'englex-ai', `${id}.mp3`), await git(['cat-file', 'blob', existing], true));
      }
      const report = await importEnglexAudio({inputFile, distDir});
      if (!report.changed) return status({sourceCommit, parent, published: false, commit: null, ...report});
      await rm(gitIndex, {force: true});
      await text(['read-tree', parent]);
      const mergedManifest = await readFile(join(distDir, 'englex-ai-index.json'));
      const merged = JSON.parse(mergedManifest);
      for (const id of matchedIds) {
        if (!Object.hasOwn(merged.recordings, id)) continue;
        const path = voicePath(id);
        const file = join(distDir, 'audio', 'englex-ai', `${id}.mp3`);
        const bytes = await readFile(file);
        const expected = blobSha(bytes);
        const existing = currentAudio.get(path);
        if (existing) {
          if (existing !== expected) throw new Error('Existing Englex AI audio was not preserved.');
          continue;
        }
        const blob = await text(['hash-object', '-w', file]);
        if (blob !== expected) throw new Error('Prepared Englex AI audio changed before publication.');
        await text(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      }
      if (!previousManifest?.equals(mergedManifest)) {
        const blob = await text(['hash-object', '-w', join(distDir, 'englex-ai-index.json')]);
        if (blob !== blobSha(mergedManifest)) throw new Error('Prepared Englex AI manifest changed before publication.');
        await text(['update-index', '--add', '--cacheinfo', `100644,${blob},${manifestPath}`]);
      }
      const tree = await text(['write-tree']);
      if (tree === await text(['rev-parse', `${parent}^{tree}`])) return status({sourceCommit, parent, published: false, commit: null, ...report, changed: false});
      const commit = await text(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit-tree', tree, '-p', parent, '-m', `Add ${report.added} original Englex AI recordings`]);
      await beforePush({attempt, parent, commit});
      try {
        await text(['push', '--quiet', 'origin', `${commit}:refs/heads/main`]);
        return status({sourceCommit, parent, published: true, commit, ...report});
      } catch {
        if (attempt === 2) throw new Error('Englex AI publication conflicted or failed; rerun the same event to merge again.');
      }
    }
  } catch (error) {
    // Subprocess output can contain configured Git authentication details.
    if (error.code || error instanceof SyntaxError) throw new Error('Englex AI bundle could not be safely read or published; no forced update was attempted.');
    throw error;
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--source-commit') throw new Error('Use --source-commit followed by the push event SHA.');
    const result = await publishEnglexAudioBundle({sourceCommit: process.argv[3]});
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.total > 0}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Original Englex AI: ${result.added} indexed, ${result.writtenFiles} files added, ${result.unchanged} unchanged, ` +
      `${result.unmatchedWords.length} unmatched words, ${result.conflicts.length} conflicts. Published: ${result.published}.\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
