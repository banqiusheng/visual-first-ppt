#!/usr/bin/env python3
"""Audit the exact public Git candidate without echoing sensitive content."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable, Sequence


DEFAULT_MAX_BYTES = 10 * 1024 * 1024

# Build signatures from fragments so this scanner and its tests can audit their
# own source without embedding a complete forbidden sample.
_PERSONAL_USER_PATH = re.compile(
    rb"/"
    + rb"Users/"
    + rb"(?!(?:<redacted>)(?:/|$))[^/\x00\r\n]+(?:/|$)"
)
_PRIVATE_TEMP_PATH = re.compile(
    rb"/private/" + rb"var/folders(?:/|$)"
)
_PRIVATE_KEY = re.compile(
    rb"-----BEGIN[ \t]+"
    rb"(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)[ \t]+)?"
    rb"PRIVATE[ \t]+KEY-----"
)
_TOKEN_PATTERNS = (
    re.compile(rb"gh" + rb"[opsu]_[A-Za-z0-9]{20,}"),
    re.compile(rb"github_" + rb"pat_[A-Za-z0-9_]{20,}"),
    re.compile(rb"sk" + rb"-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"xox" + rb"[abprs]-[A-Za-z0-9-]{20,}"),
    re.compile(rb"AK" + rb"IA[0-9A-Z]{16}"),
)

_PLACEHOLDERS = frozenset({"<outside-root>", "<repository>"})
_CODE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _redact_sensitive_path(path: str) -> str:
    encoded = os.fsencode(path)

    def redact_token(match: re.Match[bytes]) -> bytes:
        digest = hashlib.sha256(match.group(0)).hexdigest()[:12].encode("ascii")
        return b"<redacted-token-" + digest + b">"

    for pattern in _TOKEN_PATTERNS:
        encoded = pattern.sub(redact_token, encoded)
    encoded = _PRIVATE_KEY.sub(b"<redacted-private-key>", encoded)
    return os.fsdecode(encoded)


@dataclass(frozen=True)
class Finding:
    code: str
    path: str

    def __post_init__(self) -> None:
        if not isinstance(self.code, str) or not _CODE.fullmatch(self.code):
            raise ValueError("finding code must be an uppercase rule identifier")
        if self.path in _PLACEHOLDERS:
            return
        if not isinstance(self.path, str) or not self.path or "\x00" in self.path:
            raise ValueError("finding path must be a safe relative POSIX path")
        if "\\" in self.path or self.path.startswith("/"):
            raise ValueError("finding path must be a safe relative POSIX path")
        if PureWindowsPath(self.path).drive:
            raise ValueError("finding path must be a safe relative POSIX path")
        parts = self.path.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("finding path must be a safe relative POSIX path")
        object.__setattr__(self, "path", _redact_sensitive_path(self.path))


def _absolute_without_resolving(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path.expanduser())))


def _trusted_repository_root(root: Path) -> Path:
    """Normalize trusted platform aliases, but reject symlinks below that base."""

    lexical = _absolute_without_resolving(Path(root))
    candidate_bases = {
        _absolute_without_resolving(Path.cwd()),
        _absolute_without_resolving(Path(tempfile.gettempdir())),
    }
    containing = [
        base for base in candidate_bases if lexical == base or lexical.is_relative_to(base)
    ]
    lexical_base = max(containing, key=lambda value: len(value.parts)) if containing else Path(lexical.anchor)
    try:
        current = lexical_base.resolve(strict=True)
    except OSError as error:
        raise ValueError("repository root is unavailable") from error
    for part in lexical.relative_to(lexical_base).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("repository root must not contain a symlink")
    if not current.is_dir():
        raise ValueError("repository root is not a directory")
    return current


def _safe_git_relative(raw_name: bytes) -> PurePosixPath:
    name = os.fsdecode(raw_name)
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        raise ValueError("unsafe candidate path returned by Git")
    if PureWindowsPath(name).drive:
        raise ValueError("unsafe candidate path returned by Git")
    parts = name.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("unsafe candidate path returned by Git")
    relative = PurePosixPath(*parts)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("unsafe candidate path returned by Git")
    return relative


def tracked_candidate(root: Path) -> list[Path]:
    """Return tracked and non-ignored untracked files from Git's NUL stream."""

    repository_root = _trusted_repository_root(Path(root))
    completed = subprocess.run(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ],
        cwd=repository_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("candidate enumeration failed")
    raw_names = completed.stdout.split(b"\x00")
    if raw_names and raw_names[-1] == b"":
        raw_names.pop()
    elif raw_names:
        raise ValueError("candidate enumeration returned a malformed NUL stream")

    unique = sorted(set(raw_names))
    return [repository_root / Path(_safe_git_relative(raw)) for raw in unique]


def _relative_candidate(
    lexical_root: Path,
    canonical_root: Path,
    candidate: Path,
) -> tuple[Path | None, str]:
    raw = Path(candidate)
    lexical = _absolute_without_resolving(
        raw if raw.is_absolute() else lexical_root / raw
    )
    relative: Path | None = None
    for base in (lexical_root, canonical_root):
        try:
            relative = lexical.relative_to(base)
            break
        except ValueError:
            continue
    if relative is None:
        return None, "<outside-root>"
    if relative == Path("."):
        return lexical, "<repository>"
    return lexical, PurePosixPath(relative.as_posix()).as_posix()


def _inspect_regular_file(root: Path, relative: PurePosixPath) -> tuple[Path | None, str | None]:
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return None, "MISSING_FILE"
        except OSError:
            return None, "FILE_READ_ERROR"
        if stat.S_ISLNK(metadata.st_mode):
            return None, "SYMLINK"
        is_leaf = index == len(relative.parts) - 1
        if not is_leaf and not stat.S_ISDIR(metadata.st_mode):
            return None, "NOT_REGULAR_FILE"
        if is_leaf and not stat.S_ISREG(metadata.st_mode):
            return None, "NOT_REGULAR_FILE"
    return current, None


def _path_rule_codes(relative: PurePosixPath) -> set[str]:
    parts = relative.parts
    name = parts[-1]
    codes: set[str] = set()
    if Path(name).suffix.casefold() in {".pyc", ".pyo"}:
        codes.add("PYTHON_BYTECODE")
    if "__pycache__" in parts:
        codes.add("PYTHON_CACHE")
    if ".venv" in parts:
        codes.add("VIRTUAL_ENVIRONMENT")
    if "dist" in parts[:-1] and Path(name).suffix.casefold() == ".zip":
        codes.add("DISTRIBUTION_ARCHIVE")
    return codes


def _content_rule_codes(content: bytes) -> set[str]:
    codes: set[str] = set()
    if _PERSONAL_USER_PATH.search(content):
        codes.add("PERSONAL_ABSOLUTE_PATH")
    if _PRIVATE_TEMP_PATH.search(content):
        codes.add("PRIVATE_TEMP_PATH")
    if _PRIVATE_KEY.search(content):
        codes.add("PRIVATE_KEY")
    if any(pattern.search(content) for pattern in _TOKEN_PATTERNS):
        codes.add("POSSIBLE_TOKEN")
    return codes


def _read_bounded_regular_file(path: Path, max_bytes: int) -> tuple[bytes | None, str | None]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None, "FILE_READ_ERROR"
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return None, "NOT_REGULAR_FILE"
        if metadata.st_size > max_bytes:
            return None, "FILE_TOO_LARGE"
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(max_bytes + 1)
        if len(content) > max_bytes:
            return None, "FILE_TOO_LARGE"
        return content, None
    except OSError:
        return None, "FILE_READ_ERROR"
    finally:
        os.close(descriptor)


def audit_paths(
    root: Path,
    paths: list[Path],
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> list[Finding]:
    """Audit candidate paths and return only stable rule IDs plus safe paths."""

    if not isinstance(max_bytes, int) or max_bytes < 0:
        raise ValueError("max_bytes must be a non-negative integer")
    lexical_root = _absolute_without_resolving(Path(root))
    repository_root = _trusted_repository_root(Path(root))
    findings: set[Finding] = set()

    for candidate in paths:
        lexical, display = _relative_candidate(
            lexical_root,
            repository_root,
            Path(candidate),
        )
        if lexical is None:
            findings.add(Finding("PATH_OUTSIDE_ROOT", display))
            continue
        if display == "<repository>":
            findings.add(Finding("NOT_REGULAR_FILE", display))
            continue

        relative = PurePosixPath(display)
        for code in _content_rule_codes(os.fsencode(display)):
            findings.add(Finding(code, display))
        source, structural_error = _inspect_regular_file(repository_root, relative)
        if structural_error is not None:
            findings.add(Finding(structural_error, display))
            continue
        assert source is not None

        for code in _path_rule_codes(relative):
            findings.add(Finding(code, display))

        try:
            size = source.lstat().st_size
        except OSError:
            findings.add(Finding("FILE_READ_ERROR", display))
            continue
        if size > max_bytes:
            findings.add(Finding("FILE_TOO_LARGE", display))
            continue

        content, read_error = _read_bounded_regular_file(source, max_bytes)
        if read_error is not None:
            findings.add(Finding(read_error, display))
            continue
        assert content is not None
        for code in _content_rule_codes(content):
            findings.add(Finding(code, display))

    return sorted(findings, key=lambda finding: (finding.path, finding.code))


def _ordered_findings(findings: Iterable[Finding]) -> list[Finding]:
    return sorted(set(findings), key=lambda finding: (finding.path, finding.code))


def render_findings(findings: list[Finding], as_json: bool) -> str:
    ordered = _ordered_findings(findings)
    status = "FAIL" if ordered else "PASS"
    if as_json:
        return json.dumps(
            {
                "status": status,
                "findings": [
                    {"code": finding.code, "path": finding.path}
                    for finding in ordered
                ],
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
    if not ordered:
        return "PASS"
    return "\n".join(
        [
            "FAIL",
            *(
                f"{finding.code}  {json.dumps(finding.path, ensure_ascii=True)}"
                for finding in ordered
            ),
        ]
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Audit the public Visual-First PPT Git candidate."
    )
    parser.add_argument("--root", required=True, type=Path, help="repository root")
    parser.add_argument("--candidate", required=True, choices=("tracked",))
    parser.add_argument("--json", action="store_true", help="emit JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        paths = tracked_candidate(args.root)
        findings = audit_paths(args.root, paths)
    except (OSError, ValueError):
        findings = [Finding("CANDIDATE_ENUMERATION_FAILED", "<repository>")]
    print(render_findings(findings, as_json=args.json))
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
