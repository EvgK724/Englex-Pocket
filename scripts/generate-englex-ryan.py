"""Approved Microsoft Ryan generation, separate from downloaded Englex audio.

The user approved the Ryan sample and English dictionary text egress for current
and future cards. This module's offline tests do not contact Microsoft or Englex.
"""
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
from email.utils import parsedate_to_datetime

EDGE_TTS_VERSION = "7.2.8"
VOICE = "en-GB-RyanNeural"
INDEX = "englex-ryan-index.json"
AUDIO = "englex-ryan"
MAX_AUDIO = 1024 * 1024
ID = re.compile(r"^[a-f0-9]{20}$")
ROOT = Path(__file__).resolve().parent.parent


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def valid_audio(data):
    """Require a complete mono 24 kHz / 48 kbps MPEG Layer III frame."""
    if not isinstance(data, bytes) or not 24 <= len(data) <= MAX_AUDIO:
        return False
    offset = 0
    if data[:3] == b"ID3":
        if data[3] not in (2, 3, 4) or any(n & 128 for n in data[6:10]):
            return False
        offset = 10 + sum(n << shift for n, shift in zip(data[6:10], (21, 14, 7, 0)))
        if data[3] == 4 and data[5] & 16:
            offset += 10
    if offset + 4 > len(data):
        return False
    a, b, c, d = data[offset:offset + 4]
    return (a == 255 and b & 224 == 224 and (b >> 3) & 3 == 2 and
            (b >> 1) & 3 == 1 and c >> 4 == 6 and (c >> 2) & 3 == 1 and
            d >> 6 == 3 and offset + 144 + ((c >> 1) & 1) <= len(data))


def decodable_audio(data, strict_format=True):
    """Validate the actual stream, not just an MP3-looking response header."""
    if (not isinstance(data, bytes) or not 24 <= len(data) <= MAX_AUDIO or
            (strict_format and not valid_audio(data)) or
            (not strict_format and not (data[:3] == b"ID3" or data[0] == 255 and data[1] & 224 == 224))):
        return False
    with tempfile.TemporaryDirectory(prefix="ryan-mp3-") as temporary:
        path = Path(temporary) / "audio.mp3"
        path.write_bytes(data)
        try:
            result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(path),
                                     "-map", "0:a:0", "-f", "null", "-"],
                                    capture_output=True, timeout=30)
        except (subprocess.SubprocessError, OSError):
            raise RuntimeError("The required offline MP3 decoder failed or is unavailable.") from None
        return result.returncode == 0 and not result.stderr.strip()


def install_audio(path, data):
    if not valid_audio(data):
        raise ValueError("Invalid Ryan MP3 format or size; recording was not installed.")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_bytes(data)
        try:
            os.link(temporary, path)
            return True
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError("Existing Ryan audio differs and was not overwritten.") from None
            return False
    finally:
        temporary.unlink(missing_ok=True)


def dictionary_cards(raw):
    cards = raw.get("cards") if isinstance(raw, dict) else None
    if not isinstance(cards, list):
        raise ValueError("Dictionary must contain a cards array.")
    seen = set()
    for card in cards:
        if (not isinstance(card, dict) or not isinstance(card.get("id"), str) or not ID.fullmatch(card["id"]) or
                card["id"] in seen or not isinstance(card.get("word"), str) or
                not card["word"].strip()):
            raise ValueError("Invalid dictionary ID, word or duplicate card.")
        seen.add(card["id"])
    return cards


def generated_manifest(ids):
    return {"version": 1, "provider": "Microsoft Edge", "source": "generated", "voice": VOICE,
            "count": len(ids), "cards": list(ids)}


def generated_ids(raw, valid_ids):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("provider") != "Microsoft Edge" or
            raw.get("source") != "generated" or raw.get("voice") != VOICE or
            not isinstance(raw.get("cards"), list) or raw.get("count") != len(raw["cards"]) or
            any(not isinstance(i, str) or i not in valid_ids for i in raw["cards"]) or
            len(set(raw["cards"])) != len(raw["cards"])):
        raise ValueError("Incompatible generated Ryan manifest.")
    return set(raw["cards"])


def original_ids(raw, valid_ids):
    if (not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("source") != "englex-ai" or
            not isinstance(raw.get("recordings"), dict)):
        raise ValueError("Valid downloaded Englex AI manifest is required.")
    for ident, path in raw["recordings"].items():
        if ident not in valid_ids or path != f"audio/englex-ai/{ident}.mp3":
            raise ValueError("Invalid downloaded Englex AI recording entry.")
    return set(raw["recordings"])


def retry_delay(error, attempt, wall_time=time.time):
    if getattr(error, "status", None) not in (429, 503):
        return None
    raw = (getattr(error, "headers", None) or {}).get("Retry-After")
    delay = 5 * (2 ** attempt)
    if raw:
        try:
            instructed = float(raw) if re.fullmatch(r"\d+(?:\.\d+)?", raw) else parsedate_to_datetime(raw).timestamp() - wall_time()
        except (ValueError, TypeError, OverflowError):
            raise ValueError("Invalid service retry delay; generation stopped.") from None
        if instructed > 60:
            raise ValueError("Service requested a long retry delay; resume later.")
        delay = max(delay, instructed)
    return delay


async def synthesize_edge(text):
    # Use the standard client unchanged; no private Englex API, custom headers,
    # proxy rotation, certificate weakening, paid fallback or voice substitution.
    if importlib.metadata.version("edge-tts") != EDGE_TTS_VERSION:
        raise ValueError("Install the reviewed edge-tts==7.2.8 version.")
    import edge_tts
    voice = edge_tts.Communicate(text, VOICE, rate="+0%", volume="+0%", pitch="+0Hz",
                                connect_timeout=15, receive_timeout=45)
    chunks = []
    size = 0
    async with asyncio.timeout(60):
        async for chunk in voice.stream():
            if chunk["type"] == "audio":
                size += len(chunk["data"])
                if size > MAX_AUDIO:
                    raise ValueError("Ryan audio exceeds the size limit.")
                chunks.append(chunk["data"])
    return b"".join(chunks)


async def fetch_audio(text, synthesize, deadline, now, sleep, validate=decodable_audio):
    for attempt in range(3):
        try:
            data = await synthesize(text)
            if not validate(data):
                raise ValueError("Service returned invalid Ryan MP3 audio.")
            return data
        except Exception as error:
            delay = retry_delay(error, attempt)
            if delay is None or attempt == 2:
                status = getattr(error, "status", None)
                detail = f"HTTP {status}" if isinstance(status, int) else type(error).__name__
                raise RuntimeError(f"Microsoft Edge synthesis stopped ({detail}); no alternate voice or access route was attempted.") from None
            if now() + delay >= deadline:
                raise RuntimeError("Retry would exceed the generation deadline.") from None
            await sleep(delay)


def git_bytes(repo, args, index=None):
    env = os.environ.copy()
    if index:
        env["GIT_INDEX_FILE"] = str(index)
    try:
        return subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True, timeout=120).stdout
    except (subprocess.SubprocessError, OSError):
        raise RuntimeError("Git operation failed; no forced update was attempted.") from None


def publish_checkpoint(repo, work, records, before_push=lambda **kwargs: None):
    if not records:
        return None
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="publish-", dir=work) as temporary:
        index = Path(temporary) / "index"
        def git(*args):
            return git_bytes(repo, args, index).decode().strip()
        for attempt in range(3):
            git("fetch", "--quiet", "origin", "main")
            parent = git("rev-parse", "origin/main")
            cards = dictionary_cards(json.loads(git_bytes(repo, ["show", f"{parent}:dist/dictionary.json"])))
            by_id = {card["id"]: card for card in cards}
            originals = original_ids(json.loads(git_bytes(repo, ["show", f"{parent}:dist/englex-ai-index.json"])), by_id)
            manifest_path = "dist/" + INDEX
            existing_manifest = git("ls-tree", "--name-only", parent, "--", manifest_path)
            existing = generated_ids(json.loads(git_bytes(repo, ["show", f"{parent}:{manifest_path}"])), by_id) if existing_manifest else set()
            additions = []
            for record in records:
                ident = record["id"]
                if ident not in by_id or by_id[ident]["word"] != record["word"]:
                    raise ValueError("Dictionary ID or text changed before Ryan publication.")
                if ident in originals and not git("ls-tree", "--name-only", parent, "--", f"dist/audio/englex-ai/{ident}.mp3"):
                    raise ValueError("Indexed original Englex MP3 is missing; publication stopped.")
                if ident not in existing and ident not in originals:
                    additions.append(record)
            if not additions:
                return None
            index.unlink(missing_ok=True)
            git("read-tree", parent)
            for record in additions:
                data = Path(record["file"]).read_bytes()
                if not decodable_audio(data):
                    raise ValueError("Prepared Ryan MP3 failed validation.")
                expected = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
                blob = git("hash-object", "-w", str(Path(record["file"]).resolve()))
                if blob != expected:
                    raise ValueError("Prepared Ryan MP3 changed before publication.")
                path = f"dist/audio/{AUDIO}/{record['id']}.mp3"
                if git("ls-tree", "--name-only", parent, "--", path) and git("rev-parse", f"{parent}:{path}") != blob:
                    raise ValueError("Existing remote Ryan MP3 differs and was not overwritten.")
                git("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")
            combined = existing | {record["id"] for record in additions}
            manifest = generated_manifest([card["id"] for card in cards if card["id"] in combined])
            manifest_file = Path(temporary) / INDEX
            atomic_json(manifest_file, manifest)
            manifest_data = manifest_file.read_bytes()
            blob = git("hash-object", "-w", str(manifest_file))
            if blob != hashlib.sha1(f"blob {len(manifest_data)}\0".encode() + manifest_data).hexdigest():
                raise ValueError("Prepared Ryan manifest changed before publication.")
            git("update-index", "--add", "--cacheinfo", f"100644,{blob},{manifest_path}")
            tree = git("write-tree")
            commit = git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                         "commit-tree", tree, "-p", parent, "-m", f"Add {len(additions)} generated Microsoft Ryan recordings")
            before_push(attempt=attempt, parent=parent, commit=commit)
            try:
                git("push", "--quiet", "origin", f"{commit}:refs/heads/main")
                return commit
            except RuntimeError:
                if attempt == 2:
                    raise RuntimeError("Ryan checkpoint publication failed; rerun to merge on latest main.") from None


async def generate(repo=ROOT, dist=None, work=None, publish=False, concurrency=2, batch_size=50,
                   deadline_minutes=250, synthesize=synthesize_edge, publisher=publish_checkpoint,
                   now=time.monotonic, sleep=asyncio.sleep, on_publish=lambda: None):
    if not isinstance(concurrency, int) or not 1 <= concurrency <= 4 or not isinstance(batch_size, int) or not 1 <= batch_size <= 50:
        raise ValueError("Concurrency must be 1..4 and batch size 1..50.")
    if not 0 < deadline_minutes <= 250:
        raise ValueError("Deadline must be positive and at most 250 minutes.")
    repo = Path(repo).resolve()
    dist = Path(dist or repo / "dist").resolve()
    work = Path(work or repo / ".englex-ryan").resolve()
    cards = dictionary_cards(json.loads((dist / "dictionary.json").read_text()))
    valid_ids = {card["id"] for card in cards}
    originals = original_ids(json.loads((dist / "englex-ai-index.json").read_text()), valid_ids)
    for ident in originals:
        original_file = dist / "audio" / "englex-ai" / (ident + ".mp3")
        if not original_file.is_file() or not decodable_audio(original_file.read_bytes(), strict_format=False):
            raise ValueError("Indexed original Englex MP3 is missing or invalid; originals were not replaced.")
    indexed = generated_ids(json.loads((dist / INDEX).read_text()), valid_ids) if (dist / INDEX).exists() else set()
    available = set()
    for card in cards:
        path = dist / "audio" / AUDIO / (card["id"] + ".mp3")
        if path.exists():
            data = path.read_bytes()
            if not valid_audio(data) or card["id"] not in indexed and not decodable_audio(data):
                raise ValueError("Existing Ryan MP3 is invalid; it was not overwritten.")
            available.add(card["id"])
        elif card["id"] in indexed:
            raise ValueError("Indexed Ryan MP3 is missing; generation stopped.")
    covered = originals | available
    pending = [card for card in cards if card["id"] not in covered]
    deadline = now() + deadline_minutes * 60
    status = {"voice": VOICE, "snapshot_count": len(cards), "originals": len(originals), "generated": 0,
              "available": len(available), "remaining": len(pending), "complete": not pending,
              "published_commits": 0, "published_sha": None, "stop_reason": None}
    def save():
        atomic_json(work / "status.json", status)
    def write_index():
        atomic_json(dist / INDEX, generated_manifest([card["id"] for card in cards if card["id"] in available]))
    def publish_cards(selected):
        if not publish or not selected:
            return
        records = [{"id": c["id"], "word": c["word"], "file": str(dist / "audio" / AUDIO / (c["id"] + ".mp3"))} for c in selected]
        sha = publisher(repo, work, records)
        if sha:
            status["published_commits"] += 1
            status["published_sha"] = sha
            save()
            if status["published_commits"] == 1 or status["published_commits"] % 10 == 0:
                on_publish()
    save()
    try:
        # Recover completed but previously unpublished files without resynthesis.
        # A prior failed push can leave a complete local manifest. Reconcile all
        # local recordings with authoritative latest main; the publisher skips
        # remote entries and never re-synthesizes or overwrites them.
        publish_cards([card for card in cards if card["id"] in available])
        for offset in range(0, len(pending), batch_size):
            if now() >= deadline:
                status["stop_reason"] = "deadline"
                break
            batch = pending[offset:offset + batch_size]
            queue = iter(batch)
            ready, failures = [], []
            async def worker():
                while not failures and now() < deadline:
                    card = next(queue, None)
                    if card is None:
                        return
                    try:
                        data = await fetch_audio(card["word"], synthesize, deadline, now, sleep)
                        install_audio(dist / "audio" / AUDIO / (card["id"] + ".mp3"), data)
                        available.add(card["id"])
                        ready.append(card)
                    except Exception as error:
                        failures.append(error)
            await asyncio.gather(*(worker() for _ in range(min(concurrency, len(batch)))))
            if ready:
                status["generated"] += len(ready)
                status["available"] = len(available)
                covered = originals | available
                status["remaining"] = sum(c["id"] not in covered for c in pending)
                write_index()
                save()
                publish_cards(ready)
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
        status["stop_reason"] = "error"
        status["complete"] = False
        status["error_type"] = type(error).__name__
        # Service errors were sanitized by fetch_audio; never record their raw
        # URLs, headers, credentials, or subprocess stdout/stderr.
        if isinstance(error, RuntimeError) and str(error).startswith("Microsoft Edge synthesis stopped ("):
            status["error"] = str(error)
        save()
        raise


def next_continuation(status, previous):
    if type(previous) is not int or not 0 <= previous <= 8:
        raise ValueError("Continuation must be 0..8.")
    if (previous < 8 and status.get("voice") == VOICE and status.get("stop_reason") == "deadline" and
            status.get("complete") is False and status.get("generated", 0) > 0 and
            status.get("remaining", 0) > 0 and status.get("published_commits", 0) > 0):
        return previous + 1
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--deadline-minutes", type=float, default=250)
    parser.add_argument("--continuation", type=int, default=0)
    parser.add_argument("--approved-dictionary-egress", action="store_true",
                        help="Use only after explicit approval to send dictionary text to Microsoft Edge.")
    args = parser.parse_args()
    if not args.approved_dictionary_egress:
        parser.error("Dictionary text egress must be explicitly approved before generation.")
    next_continuation({}, args.continuation)
    def deploy_progress():
        try:
            result = subprocess.run(["gh", "workflow", "run", "pages.yml", "--ref", "main"], cwd=ROOT,
                                    capture_output=True, timeout=30)
            failed = result.returncode != 0
        except (subprocess.SubprocessError, OSError):
            failed = True
        if failed:
            print("Progress Pages dispatch failed; final workflow step will retry deployment.")
    result = asyncio.run(generate(publish=args.publish, deadline_minutes=args.deadline_minutes, on_publish=deploy_progress))
    print(json.dumps(result))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"deploy={str(result['available'] > 0).lower()}\n")
            continuation = next_continuation(result, args.continuation)
            if continuation is not None:
                output.write(f"continuation={continuation}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print raw service/subprocess exceptions or signed URLs.
        print(f"Ryan generation failed ({type(error).__name__}); completed files remain preserved. See the non-sensitive status report.")
        raise SystemExit(1) from None
