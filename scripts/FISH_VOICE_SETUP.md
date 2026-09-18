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

### Softer trial recordings

The five published trial recordings use the `soft-1` tone adjustment requested after listening: a broad +0.5 dB at 250 Hz, -1.5 dB at 3.2 kHz and -1.5 dB high shelf at 6 kHz. There is no denoising, compression, pitch shift or tempo change. This may reduce sharpness; it does not guarantee removal of synthesis artifacts. The app's saved playback speed is preserved.

The original trial files are retained in commit `e5f213e3782519d290093fd553475cbbec7f5ef7`. Apply the profile once from untouched source recordings, using Python 3 and FFmpeg:

```sh
python3 scripts/soften-fish-audio.py --source /path/to/original-mp3s --output dist/audio/fish-chonishvili
```

Source and output directories must differ. For future batches, download the generated artifact, put only the newly generated raw recordings in the source directory, apply this step, then review the audio before publication. Do not reprocess already softened recordings. MP3 encoding uses 192 kb/s to limit additional encoding loss. The browser's `soft-1` URL revision prevents reuse of the earlier cached recordings.

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
