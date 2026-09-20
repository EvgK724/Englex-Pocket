import {readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {isPlausibleMp3} from './generate-fish-audio.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = '8c7b57756ded59cf6ce7';

// Publish only three review samples. The live profile, dictionary and audio
// indexes remain untouched until the learner has assessed the pronunciation.
export async function publishEnglishReview({repoDir = ROOT, outputDir, review = 'original'} = {}) {
  if (!['original', 'combined'].includes(review)) throw new Error('Review must be original or combined.');
  const variants = review === 'combined' ? ['d'] : ['a', 'b', 'c'];
  const directory = review === 'combined' ? 'english-review-v4' : 'english-review-v3';
  outputDir = outputDir || join(ROOT, review === 'combined' ? '.english-review-combined' : '.english-review');
  const entries = await Promise.all(variants.map(async variant => {
    const bytes = await readFile(join(outputDir, 'processed', variant, `${ID}.mp3`)).catch(() => { throw new Error('A review sample is missing or invalid.'); });
    if (!isPlausibleMp3(bytes)) throw new Error('A review sample is missing or invalid.');
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return {path: `dist/audio/${directory}/${variant}/${ID}.mp3`, sha};
  }));
  const indexPath = join(outputDir, `publish-index-${randomUUID()}`);
  const git = async args => (await run('git', args, {
    cwd: repoDir, env: {...process.env, GIT_INDEX_FILE: indexPath}, maxBuffer: 1024 * 1024
  })).stdout.trim();
  // hash-object accepts the already validated file path, never shell text.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await git(['fetch', '--quiet', 'origin', 'main']);
      const parent = await git(['rev-parse', 'origin/main']);
      await rm(indexPath, {force:true});
      await git(['read-tree', parent]);
      for (let i = 0; i < entries.length; i++) {
        const blob = await git(['hash-object', '-w', join(outputDir, 'processed', variants[i], `${ID}.mp3`)]);
        if (blob !== entries[i].sha) throw new Error('Review sample changed after validation.');
        await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${entries[i].path}`]);
      }
      const tree = await git(['write-tree']);
      if (tree === await git(['rev-parse', `${parent}^{tree}`])) return parent;
      const commit = await git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit-tree', tree, '-p', parent, '-m', `Publish ${variants.length} same-voice English pronunciation sample(s) (${review})`]);
      try { await git(['push', '--quiet', 'origin', `${commit}:refs/heads/main`]); return commit; }
      catch { if (attempt === 2) throw new Error('Publication failed.'); }
    }
  } catch { throw new Error('Review publication failed; prepared samples remain in the workflow artifact.'); }
  finally { await rm(indexPath, {force:true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--combined')) throw new Error('Use no arguments or --combined only.');
    console.log(`Published pronunciation review: ${await publishEnglishReview({review: args.length ? 'combined' : 'original'})}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
