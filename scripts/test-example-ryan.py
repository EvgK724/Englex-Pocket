"""Offline example-generation regressions; never contacts a speech service."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("examples_ryan", Path(__file__).with_name("generate-example-ryan.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
A, B, C = "a" * 20, "b" * 20, "c" * 20


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True).stdout.decode().strip()


class ExamplesRyanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        for name, source in [("speech", "sine=frequency=440:sample_rate=24000"), ("silent", "anullsrc=r=24000:cl=mono")]:
            target = Path(cls.fixture.name) / (name + ".mp3")
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", source,
                            "-t", "0.35", "-ac", "1", "-b:a", "48k", "-write_xing", "0", str(target)], check=True, capture_output=True)
            setattr(cls, name, target.read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name) / "repo"
        self.dist = self.repo / "dist"
        self.dist.mkdir(parents=True)
        self.cards = [{"id": A, "word": "fine", "translation": "штраф"}, {"id": B, "word": "fine", "translation": "прекрасный"}]
        self.examples = {
            A: {"word": "fine", "translation": "штраф", "en": "I paid a fine for parking here.", "ru": "Я заплатил штраф за парковку здесь."},
            B: {"word": "fine", "translation": "прекрасный", "en": "The weather was fine, so we walked home.", "ru": "Погода была прекрасной, и мы пошли домой пешком."}}
        self.save_sources()
        self.spoken = []

    def save_sources(self):
        for row in self.examples.values():
            row["textSha256"] = module.sha256(row["en"].encode())
        module.ryan.atomic_json(self.dist / "dictionary.json", {"cards": self.cards})
        module.ryan.atomic_json(self.dist / module.EXAMPLES,
            {"version": 1, "source": "authored-learning-examples", "level": "B1-B2", "examples": self.examples})

    async def synthesize(self, text):
        self.spoken.append(text)
        return self.speech

    def run_generate(self, **kwargs):
        return asyncio.run(module.generate(repo=self.repo, synthesize=kwargs.pop("synthesize", self.synthesize), **kwargs))

    def test_exact_english_only_complete_coverage_and_idempotence(self):
        dictionary = (self.dist / "dictionary.json").read_bytes()
        examples = (self.dist / module.EXAMPLES).read_bytes()
        self.assertTrue(self.run_generate()["complete"])
        self.assertEqual(self.spoken, [row["en"] for row in self.examples.values()])
        self.assertEqual(self.run_generate()["generated"], 0)
        self.assertEqual(len(self.spoken), 2)
        self.assertEqual((self.dist / "dictionary.json").read_bytes(), dictionary)
        self.assertEqual((self.dist / module.EXAMPLES).read_bytes(), examples)
        records = module.records_from(json.loads((self.dist / module.INDEX).read_text()), {A, B})
        self.assertEqual(len(records), 2)
        for ident, record in records.items():
            self.assertEqual(record["textSha256"], self.examples[ident]["textSha256"])
            self.assertEqual(module.sha256((self.dist / record["path"]).read_bytes()), record["audioSha256"])
            self.assertGreater(record["duration"], .1)

    def test_changed_sentence_gets_new_immutable_path_preserving_old_files(self):
        self.run_generate()
        old = json.loads((self.dist / module.INDEX).read_text())["recordings"]
        self.examples[A]["en"] = "She had to pay a fine yesterday."
        self.save_sources()
        self.assertEqual(self.run_generate()["generated"], 1)
        now = json.loads((self.dist / module.INDEX).read_text())["recordings"]
        self.assertNotEqual(old[A]["path"], now[A]["path"])
        self.assertEqual((self.dist / old[A]["path"]).read_bytes(), self.speech)
        self.assertEqual(old[B], now[B])
        self.examples[A]["ru"] = "Вчера ей пришлось заплатить штраф."
        self.save_sources()
        self.assertEqual(self.run_generate()["generated"], 0)

    def test_rejects_silent_audio_and_meaning_mismatch_before_egress(self):
        self.assertGreater(module.spoken_duration(self.speech), .1)
        with self.assertRaisesRegex(ValueError, "silent"):
            module.spoken_duration(self.silent)
        self.examples[A]["translation"] = "неверный смысл"
        self.save_sources()
        with self.assertRaisesRegex(ValueError, "original dictionary meaning"):
            self.run_generate()
        self.assertEqual(self.spoken, [])
        self.assertFalse((self.dist / module.INDEX).exists())

    def test_missing_examples_and_corrupt_existing_audio_fail_without_overwrite(self):
        removed = self.examples.pop(B)
        self.save_sources()
        with self.assertRaisesRegex(ValueError, "missing for 1"):
            self.run_generate()
        self.examples[B] = removed
        self.save_sources()
        self.run_generate()
        path = self.dist / json.loads((self.dist / module.INDEX).read_text())["recordings"][A]["path"]
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "not overwritten"):
            self.run_generate()
        self.assertEqual(path.read_bytes(), b"corrupt")

    def test_partial_failure_is_checkpointed_without_voice_fallback(self):
        calls, published = [], []
        async def fail_second(text):
            calls.append(text)
            if len(calls) > 1:
                error = RuntimeError("forbidden")
                error.status = 403
                raise error
            return self.speech
        def publish(repo, work, records):
            published.extend(records)
            return "f" * 40
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            self.run_generate(synthesize=fail_second, concurrency=1, publish=True, publisher=publish)
        status = json.loads((self.repo / ".englex-examples-ryan/status.json").read_text())
        self.assertEqual((status["generated"], status["remaining"], status["published_commits"]), (1, 1, 1))
        self.assertEqual([row["id"] for row in published], [A])
        self.assertIsNone(module.ryan.next_continuation(status, 0))

    def test_deadline_continues_only_with_published_progress(self):
        clock = [0]
        async def synthesize(text):
            clock[0] += 60
            return self.speech
        result = self.run_generate(synthesize=synthesize, concurrency=1, deadline_minutes=.5,
                                  now=lambda: clock[0], publish=True, publisher=lambda *args: "f" * 40)
        self.assertEqual((result["generated"], result["remaining"]), (1, 1))
        self.assertEqual(module.ryan.next_continuation(result, 0), 1)
        self.assertIsNone(module.ryan.next_continuation(result, 8))

    def test_failed_publish_resumes_completed_audio_without_resynthesis(self):
        def failure(*args):
            raise RuntimeError("push failed")
        with self.assertRaisesRegex(RuntimeError, "push failed"):
            self.run_generate(publish=True, publisher=failure)
        count = len(self.spoken)
        result = self.run_generate(publish=True, publisher=lambda *args: "f" * 40)
        self.assertEqual(len(self.spoken), count)
        self.assertTrue(result["complete"])
        self.assertEqual(result["generated"], 0)

    def test_checkpoint_merges_latest_main_preserves_sources_and_rejects_stale_text(self):
        self.run_generate()
        records = json.loads((self.dist / module.INDEX).read_text())["recordings"]
        items = [{"id": ident, "record": record, "file": self.dist / record["path"]} for ident, record in records.items()]
        (self.dist / module.INDEX).unlink()
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Offline test")
        git(self.repo, "config", "user.email", "offline@example.invalid")
        git(self.repo, "add", "dist/dictionary.json", "dist/examples.json")
        git(self.repo, "commit", "-m", "Fixture")
        remote = Path(self.temporary.name) / "remote.git"
        git(self.repo, "init", "--bare", str(remote))
        git(self.repo, "remote", "add", "origin", str(remote))
        git(self.repo, "push", "-u", "origin", "main")
        other = Path(self.temporary.name) / "other"
        git(self.repo, "clone", "-b", "main", str(remote), str(other))
        git(other, "config", "user.name", "Other test")
        git(other, "config", "user.email", "other@example.invalid")
        original_head = git(self.repo, "rev-parse", "HEAD")
        def conflict(attempt, **kwargs):
            if not attempt:
                (other / "dist/keep.txt").write_text("concurrent asset")
                git(other, "add", "dist/keep.txt")
                git(other, "commit", "-m", "Concurrent change")
                git(other, "push", "origin", "main")
        commit = module.publish_checkpoint(self.repo, self.repo / ".englex-examples-ryan", items, conflict)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), original_head)
        self.assertEqual(git(self.repo, "show", f"{commit}:dist/keep.txt"), "concurrent asset")
        self.assertEqual(json.loads(git(self.repo, "show", f"{commit}:dist/examples.json"))["examples"], self.examples)
        self.assertIsNone(module.publish_checkpoint(self.repo, self.repo / ".englex-examples-ryan", items))
        git(other, "pull", "--ff-only", "origin", "main")
        changed = json.loads((other / "dist/examples.json").read_text())
        changed["examples"][A]["en"] = "The sentence has changed."
        changed["examples"][A]["textSha256"] = module.sha256(b"The sentence has changed.")
        module.ryan.atomic_json(other / "dist/examples.json", changed)
        git(other, "add", "dist/examples.json")
        git(other, "commit", "-m", "New sentence")
        git(other, "push", "origin", "main")
        with self.assertRaisesRegex(ValueError, "changed before"):
            module.publish_checkpoint(self.repo, self.repo / ".englex-examples-ryan", items)


if __name__ == "__main__":
    unittest.main()
