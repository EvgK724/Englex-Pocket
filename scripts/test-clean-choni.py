"""Offline clean-A integrity checks using invented text and synthetic audio only."""
import array
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import math
import subprocess
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location("clean_choni", Path(__file__).with_name("clean-choni.py"))
clean = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clean)
A, B, C = "a" * 20, "b" * 20, "c" * 20
VOICE = "089f2e853e064d6fb15f5b5882914b52"


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def card(ident, word):
    return {"id": ident, "word": word, "translation": "unchanged invented fixture", "added": "2026-01-01"}


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True).stdout.decode().strip()


def blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def decoded(path):
    raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path),
                          "-f", "f32le", "-ac", "1", "-ar", "44100", "pipe:1"],
                         check=True, capture_output=True).stdout
    result = array.array("f")
    result.frombytes(raw)
    return result


def rms(signal, begin, end):
    values = signal[int(begin * 44100):int(end * 44100)]
    return math.sqrt(sum(float(v) ** 2 for v in values) / len(values))


def component(signal, hz, begin=0.7, end=1.3):
    first, last = int(begin * 44100), int(end * 44100)
    real = sum(signal[i] * math.cos(2 * math.pi * hz * i / 44100) for i in range(first, last))
    imag = sum(signal[i] * math.sin(2 * math.pi * hz * i / 44100) for i in range(first, last))
    return math.hypot(real, imag) * 2 / (last - first)


class CleanChoniTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        folder = Path(cls.fixture.name)
        wav, mp3 = folder / "invented-tone.wav", folder / "invented-tone.mp3"
        rng = random.Random(742)
        signal = array.array("h")
        for i in range(88200):
            t = i / 44100
            value = rng.uniform(-0.0025, 0.0025)
            if 0.45 <= t <= 1.5:
                envelope = min(1, (t - 0.45) / 0.05, (1.5 - t) / 0.05)
                value += envelope * (0.16 * math.sin(2 * math.pi * 55 * t)
                                     + 0.075 * math.sin(2 * math.pi * 110 * t)
                                     + 0.035 * math.sin(2 * math.pi * 220 * t))
            signal.append(round(value * 32767))
        with wave.open(str(wav), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(44100)
            writer.writeframes(signal.tobytes())
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(wav),
                        "-ac", "1", "-ar", "44100", "-b:a", "128k", str(mp3)],
                       check=True, capture_output=True)
        cls.mp3 = mp3.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name) / "repo"
        self.dist = self.repo / "dist"
        self.dist.mkdir(parents=True)

    def fixture_cards(self, cards):
        write_json(self.dist / "dictionary.json", {"metadata": {"count": len(cards)}, "cards": cards})
        write_json(self.dist / clean.SOURCE_INDEX, {"version": 1, "voiceId": VOICE,
                   "engine": "s2.1-pro-free", "profile": "a-v1", "cards": [c["id"] for c in cards]})
        for c in cards:
            path = self.dist / "audio" / clean.SOURCE_AUDIO / (c["id"] + ".mp3")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.mp3)

    def record(self, ident, word):
        source = self.dist / "audio" / clean.SOURCE_AUDIO / (ident + ".mp3")
        target = self.dist / "audio" / clean.AUDIO / (ident + ".mp3")
        clean.clean_recording(source, target)
        return {"id": ident, "word": word, "sourceBlob": blob(source.read_bytes()), "file": target}

    def remote_fixture(self):
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Offline fixture")
        git(self.repo, "config", "user.email", "offline@example.invalid")
        git(self.repo, "add", "dist")
        git(self.repo, "commit", "-m", "Invented fixture")
        remote = Path(self.temporary.name) / "remote.git"
        git(self.repo, "init", "--bare", str(remote))
        git(self.repo, "remote", "add", "origin", str(remote))
        git(self.repo, "push", "-u", "origin", "main")
        other = Path(self.temporary.name) / "other"
        git(self.repo, "clone", "-b", "main", str(remote), str(other))
        git(other, "config", "user.name", "Offline concurrent writer")
        git(other, "config", "user.email", "other@example.invalid")
        return other

    def test_signal_duration_quiet_reduction_low_body_and_original_bytes(self):
        self.fixture_cards([card(A, "An invented fixture.")])
        source = self.dist / "audio" / clean.SOURCE_AUDIO / (A + ".mp3")
        target = self.dist / "audio" / clean.AUDIO / (A + ".mp3")
        metadata = clean.clean_recording(source, target)
        before, after = decoded(source), decoded(target)
        self.assertEqual(source.read_bytes(), self.mp3)
        self.assertEqual(len(before), len(after), "Cleaning must preserve the exact decoded duration")
        self.assertEqual(metadata["samples"], len(before))
        self.assertEqual(metadata["sourceBlob"], blob(self.mp3))
        self.assertEqual(metadata["outputBlob"], blob(target.read_bytes()))
        self.assertLess(rms(after, 0.1, 0.35), rms(before, 0.1, 0.35) * 0.92)
        for hz in (55, 110, 220):
            ratio = component(after, hz) / component(before, hz)
            self.assertGreater(ratio, 0.75, f"The {hz} Hz body of the voice must remain")
            self.assertLess(ratio, 1.27, "Cleaning must not strongly amplify the voice")

    def test_append_only_idempotent_and_future_card(self):
        self.fixture_cards([card(A, "Invented first"), card(B, "Invented second")])
        dictionary = (self.dist / "dictionary.json").read_bytes()
        source_index = (self.dist / clean.SOURCE_INDEX).read_bytes()
        result = clean.run_collection(repo=self.repo, workers=2, batch_size=2)
        self.assertEqual((result["generated"], result["available"], result["remaining"]), (2, 2, 0))
        self.assertTrue(result["complete"])
        self.assertEqual((self.dist / "dictionary.json").read_bytes(), dictionary)
        self.assertEqual((self.dist / clean.SOURCE_INDEX).read_bytes(), source_index)
        first_output = (self.dist / "audio" / clean.AUDIO / (A + ".mp3")).read_bytes()
        self.assertEqual(clean.run_collection(repo=self.repo)["generated"], 0)
        self.fixture_cards([card(A, "Invented first"), card(B, "Invented second"), card(C, "Invented future")])
        result = clean.run_collection(repo=self.repo)
        self.assertEqual(result["generated"], 1)
        self.assertEqual((self.dist / "audio" / clean.AUDIO / (A + ".mp3")).read_bytes(), first_output)
        manifest = json.loads((self.dist / clean.INDEX).read_text())
        self.assertEqual(manifest["count"], 3)
        self.assertEqual(manifest["cards"], [A, B, C])
        self.assertEqual(manifest["sourceBlobs"], {i: blob(self.mp3) for i in (A, B, C)})

    def test_failed_publication_restart_reconciles_already_indexed_files(self):
        self.fixture_cards([card(A, "Invented first")])
        def failure(*args):
            raise RuntimeError("Simulated publication failure")
        with self.assertRaisesRegex(RuntimeError, "publication failure"):
            clean.run_collection(repo=self.repo, publish=True, publisher=failure)
        output = (self.dist / "audio" / clean.AUDIO / (A + ".mp3")).read_bytes()
        offered = []
        def publisher(repo, work, records):
            offered.extend(records)
            return "f" * 40
        result = clean.run_collection(repo=self.repo, publish=True, publisher=publisher)
        self.assertEqual([record["id"] for record in offered], [A])
        self.assertEqual(result["generated"], 0)
        self.assertEqual(result["published_commits"], 1)
        self.assertTrue(result["complete"])
        self.assertEqual((self.dist / "audio" / clean.AUDIO / (A + ".mp3")).read_bytes(), output)

    def test_incomplete_original_library_is_reported_without_synthesis_or_false_completion(self):
        self.fixture_cards([card(A, "Invented available")])
        write_json(self.dist / "dictionary.json", {"metadata": {"count": 2}, "cards": [
            card(A, "Invented available"), card(B, "Invented awaiting original")]})
        result = clean.run_collection(repo=self.repo)
        self.assertEqual((result["available"], result["remaining"], result["awaiting_source"]), (1, 1, 1))
        self.assertFalse(result["complete"])
        self.assertEqual(result["stop_reason"], "awaiting_source")
        self.assertIsNone(clean.next_continuation(result, 0))
        self.assertFalse((self.dist / "audio" / clean.AUDIO / (B + ".mp3")).exists())

    def test_publication_retries_on_fresh_main_and_preserves_other_paths(self):
        self.fixture_cards([card(A, "Invented first"), card(B, "Invented second")])
        (self.dist / "keep.txt").write_text("Initial unrelated asset")
        other = self.remote_fixture()
        original_head = git(self.repo, "rev-parse", "HEAD")
        original_index = git(self.repo, "ls-files", "-s")
        records = [self.record(A, "Invented first"), self.record(B, "Invented second")]
        attempts = []
        def concurrent_change(attempt, **kwargs):
            attempts.append(attempt)
            if attempt:
                return
            write_json(other / "dist/dictionary.json", {"metadata": {"count": 3}, "cards": [
                card(A, "Invented first"), card(B, "Invented second"), card(C, "Concurrent new phrase")]})
            (other / "dist/keep.txt").write_text("Concurrent unrelated asset")
            git(other, "add", "dist")
            git(other, "commit", "-m", "Concurrent dictionary update")
            git(other, "push", "origin", "main")
        commit = clean.publish_checkpoint(self.repo, self.repo / ".clean-work", records, concurrent_change)
        self.assertEqual(attempts, [0, 1])
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), original_head)
        self.assertEqual(git(self.repo, "ls-files", "-s"), original_index)
        self.assertEqual(git(self.repo, "show", f"{commit}:dist/keep.txt"), "Concurrent unrelated asset")
        self.assertEqual(len(json.loads(git(self.repo, "show", f"{commit}:dist/dictionary.json"))["cards"]), 3)
        self.assertEqual(git(self.repo, "rev-parse", f"{commit}:dist/audio/{clean.SOURCE_AUDIO}/{A}.mp3"), blob(self.mp3))
        manifest = json.loads(git(self.repo, "show", f"{commit}:dist/{clean.INDEX}"))
        self.assertEqual(manifest["count"], 2)
        self.assertEqual(manifest["cards"], [A, B])
        changed = set(git(self.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines())
        self.assertEqual(changed, {f"dist/{clean.INDEX}", f"dist/audio/{clean.AUDIO}/{A}.mp3", f"dist/audio/{clean.AUDIO}/{B}.mp3"})
        self.assertIsNone(clean.publish_checkpoint(self.repo, self.repo / ".clean-work", records))

    def test_concurrent_source_replacement_is_rejected(self):
        self.fixture_cards([card(A, "Invented first")])
        other = self.remote_fixture()
        record = self.record(A, "Invented first")
        def replace_source(attempt, **kwargs):
            if attempt:
                return
            (other / "dist/audio" / clean.SOURCE_AUDIO / (A + ".mp3")).write_bytes(self.mp3 + b"changed source")
            git(other, "add", "dist")
            git(other, "commit", "-m", "Concurrent source replacement")
            git(other, "push", "origin", "main")
        with self.assertRaises(ValueError):
            clean.publish_checkpoint(self.repo, self.repo / ".clean-work", [record], replace_source)
        git(self.repo, "fetch", "origin", "main")
        self.assertEqual(git(self.repo, "ls-tree", "--name-only", "origin/main", "--", f"dist/audio/{clean.AUDIO}/{A}.mp3"), "")


if __name__ == "__main__":
    unittest.main()
