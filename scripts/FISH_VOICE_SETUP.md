# Fish voice recordings

The browser plays prepared MP3 files. The Fish key is used only by this Node.js script or the manual GitHub Actions workflow. Never put the key in `dist/`, browser code, a URL, a commit or a workflow input.

The fixed voice is `089f2e853e064d6fb15f5b5882914b52`. Every request explicitly sets `model: s2.1-pro-free`. The generator never retries with another engine. A five-card trial was generated successfully on 2026-09-18 and its MP3 files were decoded and checked before publication. Future account access and free-tier availability still depend on Fish Audio.

## First sample through GitHub

The workflow must first be merged into the repository's default branch to become available in Actions. The initial empty index keeps the Fish option hidden until reviewed recordings are published.

1. In the repository, open **Settings → Secrets and variables → Actions → New repository secret**. Name it `FISH_API_KEY` and paste the Fish API key as its value.
2. Open **Actions → Prepare Fish voice recordings → Run workflow**. Keep `limit` at `5`, or use `1` for the smallest sample. Optionally enter comma-separated card IDs from `dist/dictionary.json`.
3. Download the `fish-chonishvili-recordings-…` artifact, listen to the MP3 files and review the index. The workflow uploads an artifact only; it does not commit files or publish the website.
4. After review, place the MP3 files in `dist/audio/fish-chonishvili/` and the index at `dist/fish-chonishvili-index.json` in a separate reviewed change. Commit them together before publication.

Each run starts from the chosen repository revision. Downloaded artifacts from earlier runs are not automatically restored; merge reviewed files before requesting the next missing batch. A failed run stops immediately; earlier complete recordings and their checkpointed index are still uploaded for review when available.

## Local generation

### Accepted voice, English pronunciation trial and complete dictionary

The card view and settings share one saved voice choice. Each card reports whether the selected Fish recording is ready; missing recordings use the device voice. The original five `clean-1` recordings remain separate and unchanged.

The independent `en-gb-v1` profile adds `[British English accent, non-rhotic pronunciation] ` before the normalized synthesis text. This is an experimental S2.1 natural-language cue, not a guaranteed accent setting. Dictionary spelling is unchanged. In particular, the generator does not delete final `r` or alter linking `r` in phrases. Listen to the trial before judging the accent; a valid MP3 alone does not establish pronunciation quality.

**Actions → Prepare Fish voice library → Run workflow** has a separate voice selector:

- `accepted`: the approved voice and gentle processing, with no accent instruction. It fills `audio/fish-chonishvili/` and the original `fish-chonishvili-index.json`; the five existing approved recordings are kept byte-for-byte.
- `english` (default): the separate experimental `en-gb-v1` profile. Its files and raw recordings are isolated from the accepted voice. Keep this at `trial` until listening to the pronunciation comparison.

Both voices offer two finite modes:

- `trial`: ten existing entries, including `doctor`, `teacher`, `far away` and `take care of`.
- `full`: the current dictionary snapshot, with at most 10,000 cards, four simultaneous requests and a 250-minute deadline. It skips valid existing profile recordings and publishes completed batches of up to 50. Rerun `full` to resume a partial run.

The exact commit prefix `Run English accent trial [fish-en-gb-v1]` starts only the English trial. The separate prefix `Run accepted Fish dictionary [fish-all-v1]` starts only the full accepted voice. Ordinary pushes do not synthesize audio. There is no recurring schedule or paid-model fallback. HTTP 429/503 receive at most three attempts with bounded delay; other errors stop the run and preserve completed work.

New originals receive the existing gentle EQ and denoising once, without stronger noise treatment. Processed MP3s and their index are committed together on top of the latest `main`, preserving concurrent dictionary imports. The first, every tenth and final successful checkpoints request a Pages deployment, so completed recordings become available during a long run. Raw recordings, queue and run status are retained in the workflow artifact for 14 days. Coverage is refreshed in the app while it is open and online. A no-op rerun also requests Pages deployment when recordings already exist, allowing recovery from a deployment failure without resynthesis.

```sh
node --test tests/fish-library.test.mjs
node scripts/generate-fish-library.mjs --voice english --mode trial
node scripts/generate-fish-library.mjs --voice accepted --mode full --publish --deadline-minutes 250
```

Local publishing requires an authenticated Git remote. The API key remains server-side. English profile files are stored only under `audio/fish-chonishvili-en-gb-v1/` and `fish-chonishvili-en-gb-v1-index.json`.

### Softer trial recordings

The five published trial recordings retain the accepted `soft-1` tone adjustment: a broad +0.5 dB at 250 Hz, -1.5 dB at 3.2 kHz and -1.5 dB high shelf at 6 kHz. The `clean-1` revision adds conservative FFT hiss reduction (`afftdn=nr=6:nf=-50:tn=0:gs=12`) after that EQ. There is no gate, compression, pitch shift or tempo change. The app's saved playback speed is preserved.

The denoiser runs at 44.1 kHz with 100 ms of padding; its measured 1,102-sample processing delay is removed and the output retains the original sample count. This protects the ends of words. Checks show reduced quiet high-frequency energy with minimal overall speech-level change, but these short clips have no reliable noise-only reference and subjective voice quality still needs listener review. The accepted version before denoising remains in commit `f5372ae8f0fb07dff78dec45ad2c7012ffa82eeb`.

The original trial files are retained in commit `e5f213e3782519d290093fd553475cbbec7f5ef7`. Apply the profile once from untouched source recordings, using Python 3 and FFmpeg:

```sh
python3 scripts/soften-fish-audio.py --denoise --source /path/to/original-mp3s --output dist/audio/fish-chonishvili
```

Source and output directories must differ. For future batches, download the generated artifact, put only the newly generated raw recordings in the source directory, apply this step, then review the audio before publication. Do not reprocess already softened recordings. Omit `--denoise` to reproduce the earlier EQ-only treatment. MP3 encoding uses 192 kb/s to limit additional encoding loss. The browser's `clean-1` URL revision prevents reuse of the earlier cached recordings.

### Generate raw recordings

Use Node.js 22 or newer, with `FISH_API_KEY` supplied securely in the process environment:

```sh
node --test tests/fish-audio.test.mjs
node scripts/generate-fish-audio.mjs --limit 5
node scripts/generate-fish-audio.mjs --limit 1 --ids 0123456789abcdef0123
```

The example ID is a placeholder; use IDs from the dictionary. Without options, at most five missing recordings are generated, ordered by newest `added` date first with dictionary order breaking ties. `--limit` accepts 1–50 and counts new requests, not already available recordings. Valid existing MP3s are retained; corrupt files count as missing. Unknown IDs, invalid options, missing keys and incompatible index metadata fail before any API request. There are no automatic retries.

Audio is validated for a complete MP3 frame and written atomically before its ID is added to the atomic manifest. A resumed run can recover complete files written before an interrupted index update. The manifest contains `version`, `voiceId`, `engine` and the array `cards`; it contains no key or synthesis text. Text uses the same `speechText` function as browser speech: remove bracket markers and expand `sb` / `sth`.

API reference: [Fish text-to-speech endpoint](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech). Fish documents that omitted or unrecognized model headers can fall back to a paid engine, so this script fixes the header and rejects a different `FISH_ENGINE` value.
