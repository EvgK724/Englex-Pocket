import {appendFile, readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MAX_CONTINUATIONS = 8;

function continuationCount(value = 0) {
  if (!/^[0-8]$/.test(String(value))) throw new Error('Continuation count must be 0..8.');
  return Number(value);
}

export function nextContinuation(status, previous = 0) {
  const count = continuationCount(previous);
  if (count >= MAX_CONTINUATIONS || status?.voice !== 'a' || status.mode !== 'full' ||
      status.stopReason !== 'deadline' || status.complete !== false ||
      !Number.isInteger(status.generated) || status.generated <= 0 ||
      !Number.isInteger(status.remaining) || status.remaining <= 0 ||
      !Number.isInteger(status.publishedCommits) || status.publishedCommits <= 0) return null;
  return count + 1;
}

export function libraryJobs({eventName, event, dictionaryChanged = false}) {
  if (eventName === 'workflow_dispatch') {
    const {voice = 'a', mode = 'full', continuation = 0} = event.inputs || {};
    if (!['a', 'accepted', 'english'].includes(voice) || !['trial', 'full'].includes(mode)) throw new Error('Unsupported generation input.');
    return [{voice, mode, continuation: continuationCount(continuation)}];
  }
  if (eventName !== 'push' || event.ref !== 'refs/heads/main') return [];
  const jobs = [];
  const message = event.head_commit?.message || '';
  if (message.startsWith('Run accepted Fish dictionary [fish-all-v1]')) jobs.push({voice: 'accepted', mode: 'full'});
  if (message.startsWith('Run English accent trial [fish-en-gb-v1]')) jobs.push({voice: 'english', mode: 'trial'});
  if (dictionaryChanged || message.startsWith('Run Chonishvili A dictionary [fish-a-v1]')) jobs.push({voice: 'a', mode: 'full'});
  return jobs.map(job => ({...job, continuation: 0}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--continuation') {
      if (process.argv.length !== 4) throw new Error('Expected one continuation count.');
      let status;
      try { status = JSON.parse(await readFile('.fish-library/status.json', 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const next = nextContinuation(status, process.argv[3]);
      if (next !== null) await appendFile(process.env.GITHUB_OUTPUT, `next=${next}\n`);
    } else {
      if (process.argv.length !== 2) throw new Error('Unexpected generation plan argument.');
      const eventName = process.env.GITHUB_EVENT_NAME;
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      let dictionaryChanged = false;
      if (eventName === 'push' && event.ref === 'refs/heads/main') {
        if (![event.before, event.after].every(sha => /^[a-f0-9]{40}$/.test(sha || ''))) throw new Error('Invalid push revision.');
        const args = /^0+$/.test(event.before)
          ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', event.after, '--', 'dist/dictionary.json']
          : ['diff', '--name-only', event.before, event.after, '--', 'dist/dictionary.json'];
        const result = await promisify(execFile)('git', args);
        dictionaryChanged = result.stdout.trim().split('\n').includes('dist/dictionary.json');
      }
      const jobs = libraryJobs({eventName, event, dictionaryChanged});
      await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({include: jobs})}\nneeded=${jobs.length > 0}\n`);
    }
  } catch {
    console.error('Could not safely determine the requested Fish voice jobs.');
    process.exitCode = 1;
  }
}
