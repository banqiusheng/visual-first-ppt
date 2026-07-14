from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills/visual-first-ppt/scripts/verify_handoff_paths.py"
PERSISTENT_FIXTURE = ROOT / "tests/fixtures/baseline/source-notes.md"


class VerifyHandoffPathsTest(unittest.TestCase):
    def run_verifier(
        self, *paths: Path, persistent_root: Path = ROOT
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--persistent-root",
                str(persistent_root),
                *(str(path) for path in paths),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_accepts_existing_nonempty_file_outside_system_temp(self):
        result = self.run_verifier(PERSISTENT_FIXTURE)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS", result.stdout)
        self.assertIn(str(PERSISTENT_FIXTURE.resolve()), result.stdout)

    def test_rejects_existing_file_below_system_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary_file = Path(directory) / "final.pptx"
            temporary_file.write_bytes(b"not-a-real-pptx-but-nonempty")

            result = self.run_verifier(temporary_file, persistent_root=ROOT)

        self.assertEqual(result.returncode, 1)
        self.assertIn("temporary", result.stderr.lower())

    @unittest.skipUnless(Path("/private/tmp").is_dir(), "macOS /private/tmp alias unavailable")
    def test_rejects_private_tmp_alias_even_when_declared_as_root(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            temporary_file = Path(directory) / "final.pptx"
            temporary_file.write_bytes(b"not-a-real-pptx-but-nonempty")

            result = self.run_verifier(
                temporary_file, persistent_root=Path(directory)
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn("temporary", result.stderr.lower())

    def test_rejects_tool_scratch_directory_under_declared_root(self):
        scratch_directory = Path(
            tempfile.mkdtemp(prefix=".scratch-", dir=ROOT / "tests")
        )
        try:
            scratch_file = scratch_directory / "final.pdf"
            scratch_file.write_bytes(b"nonempty")

            result = self.run_verifier(scratch_file, persistent_root=ROOT)
        finally:
            shutil.rmtree(scratch_directory)

        self.assertEqual(result.returncode, 1)
        self.assertIn("scratch", result.stderr.lower())

    def test_rejects_file_outside_declared_persistent_root(self):
        result = self.run_verifier(
            PERSISTENT_FIXTURE, persistent_root=ROOT / "skills"
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("outside", result.stderr.lower())

    def test_rejects_missing_file(self):
        missing = ROOT / "tests/fixtures/baseline/does-not-exist.pptx"

        result = self.run_verifier(missing)

        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", result.stderr.lower())

    def test_rejects_empty_file_before_temp_location_check(self):
        with tempfile.TemporaryDirectory() as directory:
            empty_file = Path(directory) / "empty.pdf"
            empty_file.touch()

            result = self.run_verifier(empty_file, persistent_root=ROOT)

        self.assertEqual(result.returncode, 1)
        self.assertIn("empty", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
