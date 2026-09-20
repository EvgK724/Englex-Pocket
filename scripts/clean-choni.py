"""Create reversible, quieter derivatives of the approved Choni A recordings.

Offline DSP only: no synthesis, provider calls, pitch shift, EQ or bass cut.
Original A files remain untouched. Quiet background is reduced; artifacts that
overlap speech cannot be promised to disappear without changing the voice.
"""
import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
VOICE_ID = "089f2e853e064d6fb15f5b5882914b52"
ENGINE = "s2.1-pro-free"
PROFILE = "a-clean-v1"
SOURCE_PROFILE = "a-v1"
AUDIO = "fish-chonishvili-a-clean-v1"
INDEX = AUDIO + "-index.json"
SOURCE_AUDIO = "fish-chonishvili-a-v1"
SOURCE_INDEX = SOURCE_AUDIO + "-index.json"
SAMPLE_RATE = 44100
DENOISE_DELAY = 1102
DSP = "afftdn=nr=4:nf=-45:tn=0:gs=20"
EXPANDER = "agate=threshold=0.0050118723:ratio=3:range=0.2511886432:attack=2:release=40:knee=2:detection=rms"
MAX_MP3 = 10 * 1024 * 1024
MAX_SITE_BYTES = 950_000_000
ID = re.compile(r"^[a-f0-9]{20}$")
SHA = re.compile(r"^[a-f0-9]{40}$")


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def git_blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def plausible_mp3(data):
    return (isinstance(data, bytes) and 24 <= len(data) <= MAX_MP3 and
            (data[:3] == b"ID3" or data[0] == 255 and data[1] & 224 == 224))


def decode(path):
    try:
        result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-threads", "1",
                                 "-protocol_whitelist", "file", "-f", "mp3", "-i", str(path),
                                 "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE),
                                 "-f", "f32le", "pipe:1"], check=True, capture_output=True, timeout=60)
    except (subprocess.SubprocessError, OSError):
        raise RuntimeError("An MP3 could not be fully decoded; original recording preserved.") from None
    if result.stderr.strip() or not result.stdout or len(result.stdout) % 4 or len(result.stdout) > 200 * 1024 * 1024:
        raise ValueError("Invalid, truncated or excessive decoded audio.")
    return result.stdout


def clean_recording(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target:
        raise ValueError("Clean output must be separate from the original A recording.")
    before = source.read_bytes()
    if not plausible_mp3(before):
        raise ValueError("Original A recording is not a valid MP3 candidate.")
    pcm = decode(source)
    samples = len(pcm) // 4
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name("." + target.stem + "." + uuid.uuid4().hex + ".mp3")
    # afftdn has a fixed two-hop delay at 44.1 kHz. Preserve every input sample,
    # including quiet word endings, by padding and compensating that delay.
    filters = (f"apad=pad_dur=0.1,{DSP},atrim=start_sample={DENOISE_DELAY}:"
               f"end_sample={samples + DENOISE_DELAY},asetpts=PTS-STARTPTS,{EXPANDER}")
    try:
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "1", "-filter_threads", "1",
                            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
                            "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-af", filters,
                            "-c:a", "libmp3lame", "-b:a", "96k", "-ar", str(SAMPLE_RATE), "-ac", "1", str(temporary)],
                           input=pcm, check=True, capture_output=True, timeout=90)
        except (subprocess.SubprocessError, OSError):
            raise RuntimeError("Conservative Choni processing failed; original recording preserved.") from None
        data = temporary.read_bytes()
        processed = decode(temporary)
        if not plausible_mp3(data) or len(processed) != len(pcm):
            raise ValueError("Cleaned audio lost samples or failed MP3 validation.")
        a, b = array("f"), array("f")
        a.frombytes(pcm)
        b.frombytes(processed)
        energy_in = sum(float(x) * x for x in a)
        energy_out = sum(float(x) * x for x in b)
        if not all(math.isfinite(value) for value in (energy_in, energy_out)) or energy_in <= 1e-12:
            raise ValueError("Original audio is silent or invalid; processing stopped.")
        # The -12 dB expander floor and -4 dB denoiser intentionally affect only
        # quiet material. Reject a catastrophic mute, gain jump or clipping.
        energy_db = 10 * math.log10(max(energy_out, 1e-30) / energy_in)
        if not -18 <= energy_db <= 0.5 or max(abs(x) for x in b) >= 1:
            raise ValueError("Cleaned audio failed loudness/clipping preservation checks.")
        # Speech-bearing frames must retain their energy. Define the mask from
        # the original's own peak frame so this also protects quieter speakers.
        frame_size = SAMPLE_RATE // 100
        input_frames = [sum(float(x) * x for x in a[start:start + frame_size])
                        for start in range(0, len(a), frame_size)]
        floor = max(input_frames) * 10 ** (-15 / 10)
        active = [number for number, energy in enumerate(input_frames) if energy >= floor]
        active_input = sum(input_frames[number] for number in active)
        active_output = sum(sum(float(x) * x for x in b[number * frame_size:(number + 1) * frame_size])
                            for number in active)
        if active_input <= 0 or 10 * math.log10(max(active_output, 1e-30) / active_input) < -2:
            raise ValueError("Cleaned audio attenuated speech by more than2dB; original recording preserved.")
        if source.read_bytes() != before:
            raise ValueError("Original A recording changed during processing.")
        if target.exists():
            # A crash between an MP3 write and manifest write is recoverable if
            # reprocessing reproduces exactly the existing unindexed file.
            if target.read_bytes() != data:
                raise ValueError("Existing clean audio differs and was not overwritten.")
        else:
            os.link(temporary, target)
        return {"samples": samples, "sourceBlob": git_blob(before), "outputBlob": git_blob(data)}
    finally:
        temporary.unlink(missing_ok=True)


def dictionary_cards(raw):
    cards = raw.get("cards") if isinstance(raw, dict) else None
    if not isinstance(cards, list):
        raise ValueError("Dictionary cards are missing.")
    seen = set()
    for card in cards:
        if (not isinstance(card, dict) or not isinstance(card.get("id"), str) or not ID.fullmatch(card["id"]) or
                card["id"] in seen or not isinstance(card.get("word"), str) or not card["word"].strip()):
            raise ValueError("Invalid or duplicate dictionary card.")
        seen.add(card["id"])
    return cards


def validate_source(raw, ids):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("voiceId") != VOICE_ID or
            raw.get("engine") != ENGINE or raw.get("profile") != SOURCE_PROFILE or
            not isinstance(raw.get("cards"), list) or len(set(raw["cards"])) != len(raw["cards"]) or
            any(not isinstance(ident, str) or ident not in ids for ident in raw["cards"])):
        raise ValueError("The approved A source manifest is incompatible.")
    return set(raw["cards"])


def manifest_for(cards, source_blobs):
    ordered = [card["id"] for card in cards if card["id"] in source_blobs]
    return {"version": 1, "voiceId": VOICE_ID, "engine": ENGINE, "profile": PROFILE,
            "sourceProfile": SOURCE_PROFILE, "count": len(ordered), "cards": ordered,
            "sourceBlobs": {ident: source_blobs[ident] for ident in ordered}}


def validate_clean(raw, ids):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("voiceId") != VOICE_ID or
            raw.get("engine") != ENGINE or raw.get("profile") != PROFILE or raw.get("sourceProfile") != SOURCE_PROFILE or
            not isinstance(raw.get("cards"), list) or raw.get("count") != len(raw["cards"]) or
            len(set(raw["cards"])) != len(raw["cards"]) or not isinstance(raw.get("sourceBlobs"), dict) or
            set(raw["cards"]) != set(raw["sourceBlobs"]) or
            any(not isinstance(ident, str) or ident not in ids or not isinstance(raw["sourceBlobs"][ident], str) or
                not SHA.fullmatch(raw["sourceBlobs"][ident]) for ident in raw["cards"])):
        raise ValueError("Incompatible clean Choni manifest.")
    return dict(raw["sourceBlobs"])


def git(repo, *args, index=None, binary=False):
    env = os.environ.copy()
    if index:
        env["GIT_INDEX_FILE"] = str(index)
    try:
        result = subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        raise RuntimeError("Git operation failed; no forced update was attempted.") from None
    return result.stdout if binary else result.stdout.decode().strip()


def publish_checkpoint(repo, work, records, before_push=lambda **kwargs: None):
    if not records:
        return None
    Path(work).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="publish-", dir=work) as directory:
        index = Path(directory) / "index"
        for attempt in range(3):
            git(repo, "fetch", "--quiet", "origin", "main")
            parent = git(repo, "rev-parse", "origin/main")
            cards = dictionary_cards(json.loads(git(repo, "show", f"{parent}:dist/dictionary.json")))
            by_id = {card["id"]: card for card in cards}
            source_ids = validate_source(json.loads(git(repo, "show", f"{parent}:dist/{SOURCE_INDEX}")), by_id)
            manifest_path = f"dist/{INDEX}"
            existing = (validate_clean(json.loads(git(repo, "show", f"{parent}:{manifest_path}")), by_id)
                        if git(repo, "ls-tree", "--name-only", parent, "--", manifest_path) else {})
            additions = []
            for record in records:
                ident = record["id"]
                if ident not in by_id or by_id[ident]["word"] != record["word"] or ident not in source_ids:
                    raise ValueError("Dictionary or approved A source changed before publication.")
                source_path = f"dist/audio/{SOURCE_AUDIO}/{ident}.mp3"
                if git(repo, "rev-parse", f"{parent}:{source_path}") != record["sourceBlob"]:
                    raise ValueError("Original A blob changed; stale cleaned audio was not published.")
                if ident in existing:
                    if existing[ident] != record["sourceBlob"]:
                        raise ValueError("Existing cleaned recording has different source provenance.")
                    continue
                additions.append(record)
            if not additions:
                return None
            index.unlink(missing_ok=True)
            git(repo, "read-tree", parent, index=index)
            size_lines = git(repo, "ls-tree", "-r", "-l", parent, "--", "dist").splitlines()
            site_size = sum(int(line.split("\t", 1)[0].split()[-1]) for line in size_lines)
            for record in additions:
                file = Path(record["file"])
                data = file.read_bytes()
                if not plausible_mp3(data):
                    raise ValueError("Prepared clean MP3 is invalid.")
                blob = git(repo, "hash-object", "-w", str(file.resolve()))
                if blob != git_blob(data):
                    raise ValueError("Prepared clean MP3 changed before publication.")
                path = f"dist/audio/{AUDIO}/{record['id']}.mp3"
                present = git(repo, "ls-tree", "--name-only", parent, "--", path)
                if present and git(repo, "rev-parse", f"{parent}:{path}") != blob:
                    raise ValueError("Existing remote clean audio differs and was not overwritten.")
                if not present:
                    site_size += len(data)
                git(repo, "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", index=index)
                existing[record["id"]] = record["sourceBlob"]
            temporary_manifest = Path(directory) / INDEX
            atomic_json(temporary_manifest, manifest_for(cards, existing))
            manifest_data = temporary_manifest.read_bytes()
            # Reserve room for the whole updated manifest instead of subtracting
            # its previous size. Stay safely below the public Pages 1 GB limit.
            if site_size + len(manifest_data) > MAX_SITE_BYTES:
                raise ValueError("Pages size safety limit reached; original files were not removed.")
            manifest_blob = git(repo, "hash-object", "-w", str(temporary_manifest))
            if manifest_blob != git_blob(manifest_data):
                raise ValueError("Prepared clean manifest changed before publication.")
            git(repo, "update-index", "--add", "--cacheinfo", f"100644,{manifest_blob},{manifest_path}", index=index)
            tree = git(repo, "write-tree", index=index)
            commit = git(repo, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                         "commit-tree", tree, "-p", parent, "-m", f"Add {len(additions)} quieter Choni A recordings", index=index)
            before_push(attempt=attempt, parent=parent, commit=commit)
            try:
                git(repo, "push", "--quiet", "origin", f"{commit}:refs/heads/main")
                return commit
            except RuntimeError:
                if attempt == 2:
                    raise RuntimeError("Clean Choni publication failed; prepared files remain recoverable.") from None


def run_collection(repo=ROOT, publish=False, batch_size=200, workers=4, publisher=publish_checkpoint,
                   deadline_minutes=250, on_publish=lambda: None):
    if type(batch_size) is not int or not 1 <= batch_size <= 200 or type(workers) is not int or not 1 <= workers <= 4:
        raise ValueError("Batch size must be1..200 and workers1..4.")
    if not 0 < deadline_minutes <= 250:
        raise ValueError("Deadline must be positive and at most250 minutes.")
    repo = Path(repo).resolve()
    dist, work = repo / "dist", repo / ".choni-clean"
    cards = dictionary_cards(json.loads((dist / "dictionary.json").read_text()))
    by_id = {card["id"]: card for card in cards}
    source_ids = validate_source(json.loads((dist / SOURCE_INDEX).read_text()), by_id)
    source_blobs = {}
    for ident in source_ids:
        data = (dist / "audio" / SOURCE_AUDIO / (ident + ".mp3")).read_bytes()
        if not plausible_mp3(data):
            raise ValueError("An indexed original A MP3 is invalid; it was not replaced.")
        source_blobs[ident] = git_blob(data)
    clean = validate_clean(json.loads((dist / INDEX).read_text()), by_id) if (dist / INDEX).exists() else {}
    for ident, source_blob in clean.items():
        output = dist / "audio" / AUDIO / (ident + ".mp3")
        if source_blobs.get(ident) != source_blob or not output.is_file() or not plausible_mp3(output.read_bytes()):
            raise ValueError("A clean recording is missing or its source changed; no files were overwritten.")
    deadline = time.monotonic() + deadline_minutes * 60
    status = {"profile": PROFILE, "dictionary": len(cards), "snapshot_count": len(cards), "source_available": len(source_ids),
              "generated": 0, "available": len(clean), "remaining": len(cards) - len(clean),
              "awaiting_source": len(cards) - len(source_ids), "complete": False,
              "published_commits": 0, "published_sha": None, "stop_reason": None}
    def save():
        atomic_json(work / "status.json", status)
    def publish_ids(ids):
        if not publish or not ids:
            return
        records = [{"id": ident, "word": by_id[ident]["word"], "sourceBlob": clean[ident],
                    "file": str(dist / "audio" / AUDIO / (ident + ".mp3"))} for ident in ids]
        sha = publisher(repo, work, records)
        if sha:
            status["published_commits"] += 1
            status["published_sha"] = sha
            save()
            if status["published_commits"] == 1:
                on_publish()
    save()
    try:
        # Reconcile with remote even if a previous push failed after local save.
        publish_ids(list(clean))
        pending = [card for card in cards if card["id"] in source_ids and card["id"] not in clean]
        for offset in range(0, len(pending), batch_size):
            if time.monotonic() >= deadline:
                status["stop_reason"] = "deadline"
                break
            batch, ready, failures = pending[offset:offset + batch_size], [], []
            def process(card):
                ident = card["id"]
                result = clean_recording(dist / "audio" / SOURCE_AUDIO / (ident + ".mp3"),
                                         dist / "audio" / AUDIO / (ident + ".mp3"))
                if result["sourceBlob"] != source_blobs[ident]:
                    raise ValueError("Original A changed during the batch.")
                return ident
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = [executor.submit(process, card) for card in batch]
                for future in as_completed(futures):
                    try:
                        ready.append(future.result())
                    except Exception as error:
                        failures.append(error)
            if ready:
                clean.update({ident: source_blobs[ident] for ident in ready})
                atomic_json(dist / INDEX, manifest_for(cards, clean))
                status["generated"] += len(ready)
                status["available"] = len(clean)
                status["remaining"] = len(cards) - len(clean)
                save()
                publish_ids(ready)
            if failures:
                raise failures[0]
        status["complete"] = status["remaining"] == 0
        if not status["complete"] and status["stop_reason"] is None:
            status["stop_reason"] = "awaiting_source"
        save()
        return status
    except Exception as error:
        status["stop_reason"] = "error"
        status["error_type"] = type(error).__name__
        status["complete"] = False
        save()
        raise


def next_continuation(status, previous):
    if type(previous) is not int or not 0 <= previous <= 8:
        raise ValueError("Continuation must be0..8.")
    if (previous < 8 and status.get("profile") == PROFILE and status.get("stop_reason") == "deadline" and
            status.get("generated", 0) > 0 and status.get("published_commits", 0) > 0 and status.get("remaining", 0) > 0):
        return previous + 1
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--deadline-minutes", type=float, default=250)
    parser.add_argument("--continuation", type=int, default=0)
    args = parser.parse_args()
    next_continuation({}, args.continuation)
    def deploy():
        try:
            result = subprocess.run(["gh", "workflow", "run", "pages.yml", "--ref", "main"], cwd=ROOT,
                                    capture_output=True, timeout=30)
            if result.returncode:
                print("Progress Pages dispatch failed; the final workflow step will retry.")
        except (OSError, subprocess.SubprocessError):
            print("Progress Pages dispatch failed; the final workflow step will retry.")
    print(json.dumps(run_collection(publish=args.publish, deadline_minutes=args.deadline_minutes, on_publish=deploy)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid logging subprocess commands, tokens or source URLs.
        print(f"Clean Choni failed ({type(error).__name__}); originals and completed recordings remain preserved.")
        raise SystemExit(1) from None
