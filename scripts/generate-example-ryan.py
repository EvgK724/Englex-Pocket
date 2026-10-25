"""Generate immutable Microsoft Ryan recordings for authored B1-B2 examples.

Only English example text is sent to Microsoft. Dictionary and existing MP3 files
are never rewritten. Checkpoints merge onto current main without force pushing.
"""
import argparse
import array
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location("word_ryan", Path(__file__).with_name("generate-englex-ryan.py"))
ryan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ryan)
ROOT = Path(__file__).resolve().parent.parent
INDEX = "englex-examples-ryan-index.json"
EXAMPLES = "examples.json"
VOICE = ryan.VOICE
HEX = re.compile(r"^[a-f0-9]{64}$")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def audio_path(ident, text_hash):
    # v1 fixes Ryan / rate +0% / volume +0% / pitch +0Hz, independently of text.
    return f"audio/englex-examples-ryan/{ident}-{text_hash[:20]}-ryan-v1.mp3"


def examples_from(raw, cards, require_complete=True):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("source") != "authored-learning-examples"
            or raw.get("level") != "B1-B2" or not isinstance(raw.get("examples"), dict)):
        raise ValueError("Invalid authored example manifest.")
    by_id = {card["id"]: card for card in cards}
    for ident, example in raw["examples"].items():
        card = by_id.get(ident)
        if (card is None or not isinstance(example, dict)
                or set(example) != ({"word", "translation", "en", "ru", "textSha256"} | ({"note"} if "note" in example else set()))
                or example["word"] != card["word"] or example["translation"] != card["translation"]):
            raise ValueError(f"Example does not match its original dictionary meaning: {ident}")
        if "note" in example:
            note = example["note"]
            if (not isinstance(note, str) or not 1 <= len(note) <= 300 or note != note.strip()
                    or not re.search("[а-яёА-ЯЁ]", note) or re.search(r"[\x00-\x1f\x7f]", note)):
                raise ValueError(f"Invalid source clarification note: {ident}")
        en, ru = example["en"], example["ru"]
        if (not isinstance(en, str) or not 1 <= len(en) <= 600 or en != en.strip()
                or not re.search("[a-zA-Z]", en) or re.search("[а-яёА-ЯЁ]", en)
                or not isinstance(ru, str) or not 1 <= len(ru) <= 1000 or ru != ru.strip()
                or not re.search("[а-яёА-ЯЁ]", ru)
                or re.search(r"[\x00-\x1f\x7f]", en + ru)
                or example["textSha256"] != sha256(en.encode())):
            raise ValueError(f"Invalid example sentence or hash: {ident}")
    missing = set(by_id) - set(raw["examples"])
    if require_complete and missing:
        raise ValueError(f"Authored B1-B2 examples are missing for {len(missing)} dictionary cards.")
    return raw["examples"]


def manifest(records):
    return {"version": 1, "provider": "Microsoft Edge", "source": "generated", "voice": VOICE,
            "recordings": records}


def records_from(raw, valid_ids):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("provider") != "Microsoft Edge"
            or raw.get("source") != "generated" or raw.get("voice") != VOICE
            or not isinstance(raw.get("recordings"), dict)):
        raise ValueError("Invalid example Ryan manifest.")
    for ident, record in raw["recordings"].items():
        if (ident not in valid_ids or not isinstance(record, dict)
                or set(record) != {"textSha256", "audioSha256", "path", "duration"}
                or not isinstance(record["textSha256"], str) or not HEX.fullmatch(record["textSha256"])
                or not isinstance(record["audioSha256"], str) or not HEX.fullmatch(record["audioSha256"])
                or record["path"] != audio_path(ident, record["textSha256"])
                or type(record["duration"]) not in (int, float) or not .1 <= record["duration"] <= 180):
            raise ValueError(f"Invalid example Ryan recording entry: {ident}")
    return dict(raw["recordings"])


def spoken_duration(data):
    """Require a decodable, non-silent stream rather than a valid-looking header."""
    if not ryan.valid_audio(data):
        raise ValueError("Invalid example MP3 profile or size.")
    result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", "pipe:0",
                             "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "24000", "pipe:1"],
                            input=data, capture_output=True, timeout=30)
    if result.returncode or result.stderr.strip():
        raise ValueError("Example MP3 did not decode cleanly.")
    samples = array.array("h", result.stdout)
    duration = len(samples) / 24000
    if duration < .1 or max(map(abs, samples), default=0) < 128:
        raise ValueError("Example recording is empty or silent.")
    return round(duration, 3)


def validate_spoken(data):
    spoken_duration(data)
    return True


def publish_checkpoint(repo, work, completed, before_push=lambda **kwargs: None):
    if not completed:
        return None
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="publish-", dir=work) as temporary:
        index = Path(temporary) / "index"
        def git(*args):
            return ryan.git_bytes(repo, args, index).decode().strip()
        for attempt in range(3):
            git("fetch", "--quiet", "origin", "main")
            parent = git("rev-parse", "origin/main")
            cards = ryan.dictionary_cards(json.loads(ryan.git_bytes(repo, ["show", f"{parent}:dist/dictionary.json"])))
            # A concurrent importer may have committed dictionary before examples;
            # only this checkpoint's exact sentences must still be current.
            examples = examples_from(json.loads(ryan.git_bytes(repo, ["show", f"{parent}:dist/{EXAMPLES}"])), cards, require_complete=False)
            manifest_path = "dist/" + INDEX
            existing = (records_from(json.loads(ryan.git_bytes(repo, ["show", f"{parent}:{manifest_path}"])), {c["id"] for c in cards})
                        if git("ls-tree", "--name-only", parent, "--", manifest_path) else {})
            remote_audio_paths = set(git("ls-tree", "-r", "--name-only", parent, "--", "dist/audio/englex-examples-ryan").splitlines())
            additions = []
            for item in completed:
                ident, metadata = item["id"], item["record"]
                if ident not in examples or examples[ident]["textSha256"] != metadata["textSha256"]:
                    raise ValueError("Example changed before Ryan publication; retry with current source.")
                if existing.get(ident) == metadata and "dist/" + metadata["path"] in remote_audio_paths:
                    continue
                additions.append(item)
            if not additions:
                return None
            index.unlink(missing_ok=True)
            git("read-tree", parent)
            for item in additions:
                data = Path(item["file"]).read_bytes()
                if sha256(data) != item["record"]["audioSha256"]:
                    raise ValueError("Example audio changed before publication.")
                spoken_duration(data)
                blob = git("hash-object", "-w", str(Path(item["file"]).resolve()))
                path = "dist/" + item["record"]["path"]
                if git("ls-tree", "--name-only", parent, "--", path) and git("rev-parse", f"{parent}:{path}") != blob:
                    raise ValueError("Existing immutable example MP3 differs; not overwritten.")
                git("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")
                existing[item["id"]] = item["record"]
            ordered = {c["id"]: existing[c["id"]] for c in cards if c["id"] in existing}
            manifest_file = Path(temporary) / INDEX
            ryan.atomic_json(manifest_file, manifest(ordered))
            blob = git("hash-object", "-w", str(manifest_file))
            git("update-index", "--add", "--cacheinfo", f"100644,{blob},{manifest_path}")
            tree = git("write-tree")
            commit = git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                         "commit-tree", tree, "-p", parent, "-m", f"Add {len(additions)} Ryan example recordings")
            before_push(attempt=attempt, parent=parent, commit=commit)
            try:
                git("push", "--quiet", "origin", f"{commit}:refs/heads/main")
                return commit
            except RuntimeError:
                if attempt == 2:
                    raise RuntimeError("Example checkpoint publication failed; rerun to merge latest main.") from None


async def generate(repo=ROOT, dist=None, work=None, publish=False, concurrency=2, batch_size=50,
                   deadline_minutes=200, synthesize=ryan.synthesize_edge, publisher=publish_checkpoint,
                   now=time.monotonic, sleep=asyncio.sleep):
    if type(concurrency) is not int or not 1 <= concurrency <= 4 or type(batch_size) is not int or not 1 <= batch_size <= 50:
        raise ValueError("Concurrency must be 1..4; batch size 1..50.")
    if not 0 < deadline_minutes <= 250:
        raise ValueError("Deadline must be positive and at most 250 minutes.")
    repo = Path(repo).resolve()
    dist = Path(dist or repo / "dist").resolve()
    work = Path(work or repo / ".englex-examples-ryan").resolve()
    cards = ryan.dictionary_cards(json.loads((dist / "dictionary.json").read_text()))
    examples = examples_from(json.loads((dist / EXAMPLES).read_text()), cards)
    records = records_from(json.loads((dist / INDEX).read_text()), set(examples)) if (dist / INDEX).exists() else {}
    available, pending = {}, []
    for card in cards:
        ident = card["id"]
        example = examples[ident]
        path = dist / audio_path(ident, example["textSha256"])
        existing = records.get(ident)
        if path.exists():
            data = path.read_bytes()
            if existing and existing["textSha256"] == example["textSha256"]:
                if sha256(data) != existing["audioSha256"] or not ryan.valid_audio(data):
                    raise ValueError("Existing immutable example audio is corrupt; it was not overwritten.")
                metadata = existing
            else:
                duration = spoken_duration(data)  # recover a previously completed local file
                metadata = {"textSha256": example["textSha256"], "audioSha256": sha256(data),
                            "path": audio_path(ident, example["textSha256"]), "duration": duration}
            available[ident] = metadata
        else:
            pending.append(ident)
    deadline = now() + deadline_minutes * 60
    status = {"voice": VOICE, "snapshot_count": len(cards), "generated": 0, "available": len(available),
              "remaining": len(pending), "complete": not pending, "published_commits": 0,
              "published_sha": None, "stop_reason": None}
    def save():
        ryan.atomic_json(work / "status.json", status)
    def write_index():
        # Keep stale entries for changed examples until their replacements are ready;
        # clients enable only records matching the current example hash.
        combined = {**records, **available}
        ryan.atomic_json(dist / INDEX, manifest({c["id"]: combined[c["id"]] for c in cards if c["id"] in combined}))
    def publish_ids(ids):
        if not publish or not ids:
            return
        items = [{"id": ident, "record": available[ident], "file": str(dist / available[ident]["path"])} for ident in ids]
        sha = publisher(repo, work, items)
        if sha:
            status["published_commits"] += 1
            status["published_sha"] = sha
            save()
    save()
    try:
        publish_ids(list(available))
        for offset in range(0, len(pending), batch_size):
            if now() >= deadline:
                status["stop_reason"] = "deadline"
                break
            batch = pending[offset:offset + batch_size]
            queue, ready, failures = iter(batch), [], []
            async def worker():
                while not failures and now() < deadline:
                    ident = next(queue, None)
                    if ident is None:
                        return
                    try:
                        example = examples[ident]
                        data = await ryan.fetch_audio(example["en"], synthesize, deadline, now, sleep, validate=validate_spoken)
                        path = audio_path(ident, example["textSha256"])
                        ryan.install_audio(dist / path, data)
                        available[ident] = {"textSha256": example["textSha256"], "audioSha256": sha256(data),
                                            "path": path, "duration": spoken_duration(data)}
                        ready.append(ident)
                    except Exception as error:
                        failures.append(error)
            await asyncio.gather(*(worker() for _ in range(min(concurrency, len(batch)))))
            if ready:
                status["generated"] += len(ready)
                status["available"] = len(available)
                status["remaining"] = len(cards) - len(available)
                write_index()
                save()
                publish_ids(ready)
            if failures:
                raise failures[0]
            if len(ready) < len(batch):
                status["stop_reason"] = "deadline"
                break
        status["complete"] = status["remaining"] == 0
        write_index()
        save()
        return status
    except Exception as error:
        status.update(complete=False, stop_reason="error", error_type=type(error).__name__)
        if isinstance(error, RuntimeError) and str(error).startswith("Microsoft Edge synthesis stopped ("):
            status["error"] = str(error)
        save()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--deadline-minutes", type=float, default=200)
    parser.add_argument("--continuation", type=int, default=0)
    parser.add_argument("--approved-example-egress", action="store_true")
    args = parser.parse_args()
    if not args.approved_example_egress:
        parser.error("Use --approved-example-egress only for user-authorized English learning examples.")
    ryan.next_continuation({}, args.continuation)
    result = asyncio.run(generate(publish=args.publish, deadline_minutes=args.deadline_minutes))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Example Ryan generation failed ({type(error).__name__}); completed files and sanitized status are preserved.")
        raise SystemExit(1) from None
