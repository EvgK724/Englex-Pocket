import {appendFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {decodeSoftAudioBundle, importSoftAudio, MAX_BUNDLE_BYTES} from './import-soft-audio.mjs';
import {atomicWrite} from './generate-fish-audio.mjs';

export {decodeSoftAudioBundle, MAX_BUNDLE_BYTES, MAX_RECORDING_BYTES} from './import-soft-audio.mjs';
export const BUNDLE_PATH = '.soft-audio-import/batch.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const manifestPath = 'dist/audio-index.json';
const voicePath = id => `dist/audio/${id}.mp3`;

export async function publishSoftAudioBundle({repoDir = ROOT, sourceCommit, workDir = join(ROOT, '.soft-ai-publish'), beforePush = async () => {}} = {}) {
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
    // Read the triggering commit, even if a later push replaces the input file.
    const size = Number(await text(['cat-file', '-s', `${sourceCommit}:${BUNDLE_PATH}`]));
    if (!Number.isInteger(size) || size < 0 || size > MAX_BUNDLE_BYTES) throw new Error('Soft AI Voice bundle exceeds 20 MiB.');
    const bundle = await git(['show', `${sourceCommit}:${BUNDLE_PATH}`], true);
    const recordings = decodeSoftAudioBundle(bundle);
    for (let attempt = 0; attempt < 3; attempt++) {
      await text(['fetch', '--quiet', 'origin', 'main']);
      const parent = await text(['rev-parse', 'origin/main']);
      const distDir = join(temporary, `snapshot-${attempt}`, 'dist');
      await mkdir(distDir, {recursive: true});
      await writeFile(join(distDir, 'dictionary.json'), await git(['show', `${parent}:dist/dictionary.json`], true));
      const previousManifest = await git(['show', `${parent}:${manifestPath}`], true);
      await writeFile(join(distDir, 'audio-index.json'), previousManifest);
      const audioTree = await text(['ls-tree', '-r', '--format=%(objectname) %(path)', parent, '--', 'dist/audio']);
      const currentAudio = new Map(audioTree ? audioTree.split('\n').map(line => [line.slice(41), line.slice(0, 40)]) : []);
      // Copy existing requested files even if they are absent from the index.
      for (const row of recordings) {
        const existing = currentAudio.get(voicePath(row.id));
        if (existing) await atomicWrite(join(distDir, 'audio', `${row.id}.mp3`), await git(['cat-file', 'blob', existing], true));
      }
      const report = await importSoftAudio({bundle, distDir});
      if (!report.changed) return status({sourceCommit, parent, published: false, commit: null, ...report});
      await rm(gitIndex, {force: true});
      await text(['read-tree', parent]);
      const mergedManifest = await readFile(join(distDir, 'audio-index.json'));
      const indexed = new Set(JSON.parse(mergedManifest).cards);
      for (const row of recordings) {
        if (!indexed.has(row.id)) continue;
        const path = voicePath(row.id), file = join(distDir, 'audio', `${row.id}.mp3`);
        const bytes = await readFile(file), expected = blobSha(bytes), existing = currentAudio.get(path);
        if (existing) {
          if (existing !== expected) throw new Error('Existing soft AI Voice MP3 was not preserved.');
          continue;
        }
        const blob = await text(['hash-object', '-w', file]);
        if (blob !== expected) throw new Error('Prepared soft AI Voice MP3 changed before publication.');
        await text(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      }
      if (!previousManifest.equals(mergedManifest)) {
        const blob = await text(['hash-object', '-w', join(distDir, 'audio-index.json')]);
        if (blob !== blobSha(mergedManifest)) throw new Error('Prepared soft AI Voice index changed before publication.');
        await text(['update-index', '--add', '--cacheinfo', `100644,${blob},${manifestPath}`]);
      }
      const tree = await text(['write-tree']);
      if (tree === await text(['rev-parse', `${parent}^{tree}`])) return status({sourceCommit, parent, published: false, commit: null, ...report, changed: false});
      const commit = await text(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit-tree', tree, '-p', parent, '-m', `Add ${report.added} soft AI Voice recordings`]);
      await beforePush({attempt, parent, commit});
      try {
        await text(['push', '--quiet', 'origin', `${commit}:refs/heads/main`]);
        return status({sourceCommit, parent, published: true, commit, ...report});
      } catch {
        if (attempt === 2) throw new Error('Soft AI Voice publication conflicted or failed; rerun the same event to merge again.');
      }
    }
  } catch (error) {
    // Never surface subprocess output that may contain Git authentication data.
    if (error.code || error instanceof SyntaxError) throw new Error('Soft AI Voice bundle could not be safely read or published; no forced update was attempted.');
    throw error;
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--source-commit') throw new Error('Use --source-commit followed by the push event SHA.');
    const result = await publishSoftAudioBundle({sourceCommit: process.argv[3]});
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.total > 0}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Soft AI Voice (AI Voice Generator, delicate): ${result.added} indexed, ${result.writtenFiles} MP3s added, ` +
      `${result.unchanged} preserved, ${result.conflicts.length} conflicts. Published: ${result.published}.\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
