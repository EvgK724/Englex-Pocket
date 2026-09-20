"""Offline Ryan pipeline regressions. No speech service or dictionary egress."""
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ryan", Path(__file__).with_name("generate-englex-ryan.py"))
ryan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ryan)
A, B, C = "a" * 20, "b" * 20, "c" * 20


def card(ident, word):
    return {"id": ident, "word": word, "translation": "unchanged fixture", "added": "2026-01-01"}


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True).stdout.decode().strip()


class ServiceError(Exception):
    def __init__(self, status, headers=None):
        self.status = status
        self.headers = headers


class RyanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_dir = tempfile.TemporaryDirectory()
        path = Path(cls.fixture_dir.name) / "tone.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
                        "sine=frequency=440:sample_rate=24000", "-t", "0.3", "-ac", "1",
                        "-b:a", "48k", "-write_xing", "0", str(path)], check=True, capture_output=True)
        cls.mp3 = path.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixture_dir.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name) / "repo"
        self.dist = self.repo / "dist"
        self.dist.mkdir(parents=True)

    def write_fixture(self, cards, originals=()):
        ryan.atomic_json(self.dist / "dictionary.json", {"metadata": {"count": len(cards)}, "cards": cards})
        ryan.atomic_json(self.dist / "englex-ai-index.json", {"version": 1, "source": "englex-ai", "recordings": {
            ident: f"audio/englex-ai/{ident}.mp3" for ident in originals}})
        for ident in originals:
            ryan.install_audio(self.dist / "audio" / "englex-ai" / (ident + ".mp3"), self.mp3)

    def test_real_decode_rejects_header_only_and_fixed_profile(self):
        self.assertTrue(ryan.valid_audio(self.mp3))
        self.assertTrue(ryan.decodable_audio(self.mp3))
        header_only = bytes([255, 243, 100, 192]) + bytes(140)
        self.assertTrue(ryan.valid_audio(header_only))
        self.assertFalse(ryan.decodable_audio(header_only))
        self.assertFalse(ryan.valid_audio(b'{"error":"quota"}'))
        manifest = ryan.generated_manifest([A])
        self.assertEqual(manifest, {"version": 1, "provider": "Microsoft Edge", "source": "generated",
                                    "voice": "en-GB-RyanNeural", "count": 1, "cards": [A]})
        with self.assertRaises(ValueError):
            ryan.generated_ids({**manifest, "voice": "other"}, {A})
        self.assertEqual(len(ryan.dictionary_cards({"cards": [card(A, "x" * 600)]})[0]["word"]), 600)

    def test_append_only_exact_text_originals_idempotence_and_future_card(self):
        self.write_fixture([card(A, "Original fixture"), card(B, "  Synthetic {phrase} & punctuation!  ")], [A])
        dictionary = (self.dist / "dictionary.json").read_bytes()
        original = (self.dist / "audio" / "englex-ai" / (A + ".mp3")).read_bytes()
        spoken = []
        async def synthesize(text):
            spoken.append(text)
            return self.mp3
        result = asyncio.run(ryan.generate(repo=self.repo, synthesize=synthesize))
        self.assertEqual(spoken, ["  Synthetic {phrase} & punctuation!  "])
        self.assertTrue(result["complete"])
        self.assertEqual(result["generated"], 1)
        self.assertEqual((self.dist / "dictionary.json").read_bytes(), dictionary)
        self.assertEqual((self.dist / "audio" / "englex-ai" / (A + ".mp3")).read_bytes(), original)
        self.assertEqual(json.loads((self.dist / ryan.INDEX).read_text())["cards"], [B])
        self.assertEqual(asyncio.run(ryan.generate(repo=self.repo, synthesize=synthesize))["generated"], 0)
        updated = json.loads(dictionary)
        updated["cards"].append(card(C, "An invented later phrase."))
        ryan.atomic_json(self.dist / "dictionary.json", updated)
        result = asyncio.run(ryan.generate(repo=self.repo, synthesize=synthesize))
        self.assertEqual(result["generated"], 1)
        self.assertEqual(spoken, ["  Synthetic {phrase} & punctuation!  ", "An invented later phrase."])
        self.assertEqual(json.loads((self.dist / ryan.INDEX).read_text())["cards"], [B, C])

    def test_missing_original_stops_without_replacement_or_service_call(self):
        self.write_fixture([card(A, "Original fixture")], [A])
        (self.dist / "audio" / "englex-ai" / (A + ".mp3")).unlink()
        async def must_not_run(text):
            self.fail("Missing original must not silently become a generated replacement")
        with self.assertRaisesRegex(ValueError, "original Englex MP3 is missing"):
            asyncio.run(ryan.generate(repo=self.repo, synthesize=must_not_run))

    def test_retry_is_bounded_and_forbidden_stops(self):
        calls, delays = [], []
        async def limited(text):
            calls.append(text)
            if len(calls) < 3:
                raise ServiceError(429, {"Retry-After": "6"})
            return self.mp3
        async def sleep(delay):
            delays.append(delay)
        self.assertEqual(asyncio.run(ryan.fetch_audio("New neutral text", limited, 1000, lambda: 0, sleep)), self.mp3)
        self.assertEqual(delays, [6, 10])
        calls.clear()
        async def forbidden(text):
            calls.append(text)
            raise ServiceError(403)
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            asyncio.run(ryan.fetch_audio("New neutral text", forbidden, 1000, lambda: 0, sleep))
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(ValueError, "long retry"):
            ryan.retry_delay(ServiceError(429, {"Retry-After": "120"}), 0)

    def test_failed_push_then_same_workspace_resume_publishes_without_regeneration(self):
        self.write_fixture([card(A, "An invented test sentence.")])
        spoken = []
        async def synthesize(text):
            spoken.append(text)
            return self.mp3
        def failure(*args):
            raise RuntimeError("Simulated publication failure")
        with self.assertRaisesRegex(RuntimeError, "publication failure"):
            asyncio.run(ryan.generate(repo=self.repo, synthesize=synthesize, publish=True, publisher=failure))
        status = json.loads((self.repo / ".englex-ryan/status.json").read_text())
        self.assertFalse(status["complete"])
        self.assertIsNone(ryan.next_continuation(status, 0))
        published = []
        def publisher(repo, work, records):
            published.extend(records)
            return "f" * 40
        result = asyncio.run(ryan.generate(repo=self.repo, synthesize=synthesize, publish=True, publisher=publisher))
        self.assertEqual(len(spoken), 1)
        self.assertEqual([record["id"] for record in published], [A])
        self.assertEqual(result["published_commits"], 1)
        self.assertTrue(result["complete"])

    def test_deadline_continues_only_with_positive_published_progress(self):
        self.write_fixture([card(A, "Invented one"), card(B, "Invented two"), card(C, "Invented three")])
        clock = [0]
        async def synthesize(text):
            clock[0] += 60
            return self.mp3
        result = asyncio.run(ryan.generate(repo=self.repo, concurrency=1, deadline_minutes=1.5,
                                          synthesize=synthesize, now=lambda: clock[0], publish=True,
                                          publisher=lambda *args: "f" * 40))
        self.assertEqual((result["generated"], result["remaining"], result["stop_reason"]), (2, 1, "deadline"))
        self.assertEqual(ryan.next_continuation(result, 0), 1)
        for amended in ({"generated": 0}, {"published_commits": 0}, {"stop_reason": "error"}, {"complete": True}):
            self.assertIsNone(ryan.next_continuation({**result, **amended}, 0))
        self.assertIsNone(ryan.next_continuation(result, 8))

    def test_partial_success_is_checkpointed_before_service_error(self):
        self.write_fixture([card(A, "Invented first"), card(B, "Invented second")])
        calls, commits = [], []
        async def synthesize(text):
            calls.append(text)
            if len(calls) == 2:
                raise ServiceError(403)
            return self.mp3
        def publisher(repo, work, records):
            commits.extend(record["id"] for record in records)
            return "f" * 40
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            asyncio.run(ryan.generate(repo=self.repo, concurrency=1, synthesize=synthesize, publish=True, publisher=publisher))
        status = json.loads((self.repo / ".englex-ryan/status.json").read_text())
        self.assertEqual(commits, [A])
        self.assertEqual(status["remaining"], 1)
        self.assertIn("HTTP 403", status["error"])
        self.assertIsNone(ryan.next_continuation(status, 0))

    def test_nonforce_checkpoint_merges_latest_dictionary_originals_and_unrelated_files(self):
        self.write_fixture([card(A, "Invented first"), card(B, "Invented second")])
        (self.dist / "keep.txt").write_text("preserve initial asset")
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Offline test")
        git(self.repo, "config", "user.email", "offline@example.invalid")
        git(self.repo, "add", "dist")
        git(self.repo, "commit", "-m", "Fixture")
        remote = Path(self.temporary.name) / "remote.git"
        git(self.repo, "init", "--bare", str(remote))
        git(self.repo, "remote", "add", "origin", str(remote))
        git(self.repo, "push", "-u", "origin", "main")
        other = Path(self.temporary.name) / "other"
        git(self.repo, "clone", "-b", "main", str(remote), str(other))
        git(other, "config", "user.name", "Offline other")
        git(other, "config", "user.email", "other@example.invalid")
        original_head, original_index = git(self.repo, "rev-parse", "HEAD"), git(self.repo, "ls-files", "-s")
        records = []
        for ident, word in [(A, "Invented first"), (B, "Invented second")]:
            path = self.dist / "audio" / ryan.AUDIO / (ident + ".mp3")
            ryan.install_audio(path, self.mp3)
            records.append({"id": ident, "word": word, "file": path})
        attempts = []
        def concurrent_update(attempt, **kwargs):
            attempts.append(attempt)
            if attempt:
                return
            dictionary = json.loads((other / "dist/dictionary.json").read_text())
            dictionary["cards"].append(card(C, "Concurrent new phrase"))
            ryan.atomic_json(other / "dist/dictionary.json", dictionary)
            ryan.atomic_json(other / "dist/englex-ai-index.json", {"version": 1, "source": "englex-ai",
                "recordings": {B: f"audio/englex-ai/{B}.mp3"}})
            ryan.install_audio(other / "dist/audio/englex-ai" / (B + ".mp3"), self.mp3)
            (other / "dist/keep.txt").write_text("preserve concurrent asset")
            git(other, "add", "dist")
            git(other, "commit", "-m", "Concurrent originals and dictionary")
            git(other, "push", "origin", "main")
        commit = ryan.publish_checkpoint(self.repo, self.repo / ".englex-ryan", records, concurrent_update)
        self.assertEqual(attempts, [0, 1])
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), original_head)
        self.assertEqual(git(self.repo, "ls-files", "-s"), original_index)
        self.assertEqual(git(self.repo, "show", f"{commit}:dist/keep.txt"), "preserve concurrent asset")
        self.assertEqual(len(json.loads(git(self.repo, "show", f"{commit}:dist/dictionary.json"))["cards"]), 3)
        self.assertEqual(json.loads(git(self.repo, "show", f"{commit}:dist/{ryan.INDEX}"))["cards"], [A])
        self.assertEqual(git(self.repo, "ls-tree", "--name-only", commit, "--", f"dist/audio/{ryan.AUDIO}/{B}.mp3"), "")
        self.assertIsNone(ryan.publish_checkpoint(self.repo, self.repo / ".englex-ryan", records))
        changed = git(self.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
        self.assertEqual(set(changed), {f"dist/audio/{ryan.AUDIO}/{A}.mp3", f"dist/{ryan.INDEX}"})


if __name__ == "__main__":
    unittest.main()
