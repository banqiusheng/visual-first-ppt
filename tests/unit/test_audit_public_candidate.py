from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.audit_public_candidate import (
    Finding,
    audit_paths,
    main,
    render_findings,
    tracked_candidate,
)


class AuditPublicCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name) / "repository"
        self.root.mkdir()

    def _write(self, relative: str, content: str | bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        return path

    def _finding_codes(self, paths: list[Path]) -> set[str]:
        return {finding.code for finding in audit_paths(self.root, paths)}

    def test_content_rules_reject_personal_paths_tokens_and_private_keys(self) -> None:
        personal_path = "/" + "Users" + "/example/private/source"
        private_temp = "/private/" + "var/folders/example/private/source"
        token = "gh" + "p_" + ("A" * 32)
        private_key = "-----BEGIN " + "PRIVATE KEY-----"
        candidate = self._write(
            "notes.txt",
            "\n".join([personal_path, private_temp, token, private_key]),
        )

        findings = audit_paths(self.root, [candidate])

        self.assertEqual(
            {finding.code for finding in findings},
            {
                "PERSONAL_ABSOLUTE_PATH",
                "PRIVATE_TEMP_PATH",
                "POSSIBLE_TOKEN",
                "PRIVATE_KEY",
            },
        )
        rendered = render_findings(findings, as_json=True)
        for sensitive_value in (personal_path, private_temp, token, private_key):
            self.assertNotIn(sensitive_value, rendered)

    def test_binary_content_is_scanned_without_decoding_failures(self) -> None:
        token = b"sk" + b"-" + (b"Z" * 32)
        candidate = self._write("asset.bin", b"\xff\x00prefix" + token + b"suffix")

        findings = audit_paths(self.root, [candidate])

        self.assertIn("POSSIBLE_TOKEN", {finding.code for finding in findings})
        self.assertNotIn(token.decode("ascii"), render_findings(findings, as_json=False))

    def test_redacted_user_placeholder_is_not_a_personal_path(self) -> None:
        placeholder = "/" + "Users" + "/<redacted>/project"
        candidate = self._write("sanitizer.txt", placeholder)

        self.assertEqual(audit_paths(self.root, [candidate]), [])

    def test_unicode_and_space_user_names_are_personal_paths(self) -> None:
        unicode_path = "/" + "Users" + "/张三/private"
        spaced_path = "/" + "Users" + "/Example User/private"
        candidate = self._write("personal-paths.txt", unicode_path + "\n" + spaced_path)

        findings = audit_paths(self.root, [candidate])

        self.assertEqual(
            findings,
            [Finding("PERSONAL_ABSOLUTE_PATH", "personal-paths.txt")],
        )

    def test_forbidden_candidate_artifacts_are_reported_by_rule_code(self) -> None:
        paths = [
            self._write("module.pyc", b"bytecode"),
            self._write("pkg/__pycache__/module.py", "cached\n"),
            self._write(".venv/config.txt", "local environment\n"),
            self._write("dist/release.zip", b"archive"),
        ]

        self.assertEqual(
            self._finding_codes(paths),
            {
                "PYTHON_BYTECODE",
                "PYTHON_CACHE",
                "VIRTUAL_ENVIRONMENT",
                "DISTRIBUTION_ARCHIVE",
            },
        )

    def test_local_planning_raw_agent_evidence_and_logs_are_rejected(self) -> None:
        paths = [
            self._write(".superpowers/sdd/plan.md", "local plan\n"),
            self._write(
                "tests/agent-forward/runs/attempt-99/response.txt",
                "raw response\n",
            ),
            self._write(".jsonl", "{}\n"),
            self._write(".log", "raw log\n"),
            self._write("logs/agent-trace.jsonl", "{}\n"),
            self._write("logs/runner.log", "raw log\n"),
        ]

        findings = audit_paths(self.root, paths)

        self.assertEqual(
            {(finding.path, finding.code) for finding in findings},
            {
                (".superpowers/sdd/plan.md", "LOCAL_PLANNING_RECORD"),
                (".jsonl", "RAW_EXECUTION_LOG"),
                (".log", "RAW_EXECUTION_LOG"),
                ("logs/agent-trace.jsonl", "RAW_EXECUTION_LOG"),
                ("logs/runner.log", "RAW_EXECUTION_LOG"),
                (
                    "tests/agent-forward/runs/attempt-99/response.txt",
                    "RAW_AGENT_EVIDENCE",
                ),
            },
        )

    def test_local_record_path_rules_do_not_match_similarly_named_paths(self) -> None:
        paths = [
            self._write(".superpowers", "publishable fixture\n"),
            self._write(".superpowers-local/plan.md", "publishable fixture\n"),
            self._write(
                "tests/agent-forward/runs",
                "publishable fixture\n",
            ),
            self._write(
                "tests/agent-forward/runs-archive/response.txt",
                "publishable fixture\n",
            ),
            self._write("logs/runner.logger", "publishable fixture\n"),
            self._write("logs/trace.jsonlines", "publishable fixture\n"),
        ]

        self.assertEqual(audit_paths(self.root, paths), [])

    def test_file_larger_than_ten_mib_is_blocked_without_reading_it(self) -> None:
        candidate = self.root / "large.bin"
        with candidate.open("wb") as stream:
            stream.seek(10 * 1024 * 1024)
            stream.write(b"x")

        findings = audit_paths(self.root, [candidate])

        self.assertEqual(findings, [Finding("FILE_TOO_LARGE", "large.bin")])

    def test_file_exactly_ten_mib_is_allowed(self) -> None:
        candidate = self.root / "limit.bin"
        with candidate.open("wb") as stream:
            stream.seek((10 * 1024 * 1024) - 1)
            stream.write(b"\x00")

        self.assertEqual(audit_paths(self.root, [candidate]), [])

    def test_paths_outside_root_and_symlinks_are_rejected_without_following(self) -> None:
        outside = Path(self.temp_dir.name) / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        link = self.root / "linked.txt"
        try:
            link.symlink_to(outside)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        findings = audit_paths(self.root, [outside, link])

        self.assertIn(Finding("PATH_OUTSIDE_ROOT", "<outside-root>"), findings)
        self.assertIn(Finding("SYMLINK", "linked.txt"), findings)
        self.assertNotIn("outside.txt", render_findings(findings, as_json=True))

    def test_symlink_ancestor_inside_root_is_rejected(self) -> None:
        outside_dir = Path(self.temp_dir.name) / "outside-directory"
        outside_dir.mkdir()
        (outside_dir / "secret.txt").write_text("secret\n", encoding="utf-8")
        linked_dir = self.root / "linked-directory"
        try:
            linked_dir.symlink_to(outside_dir, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")

        findings = audit_paths(self.root, [linked_dir / "secret.txt"])

        self.assertEqual(findings, [Finding("SYMLINK", "linked-directory/secret.txt")])

    def test_broken_symlink_missing_file_and_non_regular_file_fail_closed(self) -> None:
        broken = self.root / "broken.txt"
        try:
            broken.symlink_to(self.root / "missing-target.txt")
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")
        missing = self.root / "missing.txt"
        directory = self.root / "directory"
        directory.mkdir()

        findings = audit_paths(self.root, [broken, missing, directory])

        self.assertEqual(
            findings,
            [
                Finding("SYMLINK", "broken.txt"),
                Finding("NOT_REGULAR_FILE", "directory"),
                Finding("MISSING_FILE", "missing.txt"),
            ],
        )

    def test_sensitive_content_under_tests_is_not_exempted(self) -> None:
        personal_path = "/" + "Users" + "/example/private/source"
        candidate = self._write("tests/fixture.txt", personal_path)

        self.assertEqual(
            audit_paths(self.root, [candidate]),
            [Finding("PERSONAL_ABSOLUTE_PATH", "tests/fixture.txt")],
        )

    def test_unicode_and_newline_filename_is_escaped_in_plain_output(self) -> None:
        personal_path = "/" + "Users" + "/example/private/source"
        candidate = self._write("资料\nfixture.txt", personal_path)

        findings = audit_paths(self.root, [candidate])
        rendered = render_findings(findings, as_json=False)

        self.assertEqual(
            findings,
            [Finding("PERSONAL_ABSOLUTE_PATH", "资料\nfixture.txt")],
        )
        self.assertEqual(len(rendered.splitlines()), 2)
        self.assertIn(r"\nfixture.txt", rendered)
        self.assertNotIn(personal_path, rendered)

    def test_token_in_filename_is_blocked_and_redacted_in_every_output(self) -> None:
        token = "gh" + "p_" + ("Q" * 32)
        candidate = self._write(f"artifacts/{token}.txt", "safe content\n")

        findings = audit_paths(self.root, [candidate])
        json_output = render_findings(findings, as_json=True)
        plain_output = render_findings(findings, as_json=False)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].code, "POSSIBLE_TOKEN")
        self.assertIn("<redacted-token-", findings[0].path)
        self.assertNotIn(token, findings[0].path)
        self.assertNotIn(token, json_output)
        self.assertNotIn(token, plain_output)

    def test_tracked_candidate_uses_git_cached_and_untracked_excluding_ignored(self) -> None:
        subprocess.run(
            ["git", "init", "-q"],
            cwd=self.root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._write(".gitignore", "ignored.txt\n")
        tracked = self._write("tracked.txt", "tracked\n")
        untracked = self._write("untracked.txt", "untracked\n")
        self._write("ignored.txt", "ignored\n")
        subprocess.run(
            ["git", "add", ".gitignore", "tracked.txt"],
            cwd=self.root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        paths = tracked_candidate(self.root)

        self.assertEqual(
            paths,
            [self.root.resolve() / ".gitignore", tracked.resolve(), untracked.resolve()],
        )

    def test_tracked_candidate_rejects_git_path_escape_and_root_symlink(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b"../outside.txt\x00", stderr=b""
        )
        with mock.patch(
            "scripts.audit_public_candidate.subprocess.run", return_value=completed
        ) as run:
            with self.assertRaisesRegex(ValueError, "unsafe candidate path"):
                tracked_candidate(self.root)
        self.assertEqual(
            run.call_args.args[0],
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ],
        )

        root_link = Path(self.temp_dir.name) / "repository-link"
        try:
            root_link.symlink_to(self.root, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink unavailable: {error}")
        with self.assertRaisesRegex(ValueError, "repository root.*symlink"):
            tracked_candidate(root_link)

    def test_tracked_candidate_fails_closed_and_deduplicates_nul_paths(self) -> None:
        failed = subprocess.CompletedProcess(
            args=[], returncode=128, stdout=b"", stderr=b"private diagnostic"
        )
        with mock.patch(
            "scripts.audit_public_candidate.subprocess.run", return_value=failed
        ):
            with self.assertRaisesRegex(ValueError, "candidate enumeration failed") as error:
                tracked_candidate(self.root)
        self.assertNotIn("private diagnostic", str(error.exception))

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=b"z.txt\x00a.txt\x00z.txt\x00",
            stderr=b"",
        )
        with mock.patch(
            "scripts.audit_public_candidate.subprocess.run", return_value=completed
        ):
            paths = tracked_candidate(self.root)
        self.assertEqual(
            paths,
            [self.root.resolve() / "a.txt", self.root.resolve() / "z.txt"],
        )

    def test_findings_are_sorted_deduplicated_and_paths_are_safe(self) -> None:
        personal_path = "/" + "Users" + "/example/private/source"
        candidate = self._write("b.txt", personal_path)

        findings = audit_paths(self.root, [candidate, candidate])

        self.assertEqual(
            findings,
            [Finding("PERSONAL_ABSOLUTE_PATH", "b.txt")],
        )
        for unsafe_path in ("/absolute.txt", "../escape.txt", "folder\\file.txt"):
            with self.subTest(unsafe_path=unsafe_path):
                with self.assertRaisesRegex(ValueError, "safe relative POSIX"):
                    Finding("UNSAFE", unsafe_path)

    def test_render_and_cli_have_deterministic_pass_fail_contracts(self) -> None:
        self.assertEqual(render_findings([], as_json=False), "PASS")
        self.assertEqual(
            json.loads(render_findings([], as_json=True)),
            {"status": "PASS", "findings": []},
        )
        findings = [Finding("POSSIBLE_TOKEN", "b.txt"), Finding("SYMLINK", "a.txt")]
        payload = json.loads(render_findings(findings, as_json=True))
        self.assertEqual(payload["status"], "FAIL")
        self.assertEqual(
            payload["findings"],
            [
                {"code": "SYMLINK", "path": "a.txt"},
                {"code": "POSSIBLE_TOKEN", "path": "b.txt"},
            ],
        )

        subprocess.run(
            ["git", "init", "-q"],
            cwd=self.root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._write("safe.txt", "safe\n")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = main(
                ["--root", os.fspath(self.root), "--candidate", "tracked", "--json"]
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"status": "PASS", "findings": []},
        )

    def test_cli_reports_enumeration_failure_as_fail_without_diagnostics(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=128, stdout=b"", stderr=b"sensitive git failure"
        )
        output = io.StringIO()
        with mock.patch(
            "scripts.audit_public_candidate.subprocess.run", return_value=completed
        ), contextlib.redirect_stdout(output):
            exit_code = main(
                ["--root", os.fspath(self.root), "--candidate", "tracked", "--json"]
            )

        self.assertEqual(exit_code, 1)
        payload = json.loads(output.getvalue())
        self.assertEqual(
            payload,
            {
                "status": "FAIL",
                "findings": [
                    {"code": "CANDIDATE_ENUMERATION_FAILED", "path": "<repository>"}
                ],
            },
        )
        self.assertNotIn("sensitive git failure", output.getvalue())


if __name__ == "__main__":
    unittest.main()
