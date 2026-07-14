"""Verify final handoff files below an explicit persistent destination root."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile


class HandoffPathError(ValueError):
    """Raised when a final handoff path is missing, empty, or ephemeral."""


def _is_within(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


_EPHEMERAL_COMPONENTS = {
    ".cache",
    ".scratch",
    ".temp",
    ".tmp",
    "cache",
    "caches",
    "scratch",
    "temp",
    "temporaryitems",
    "tmp",
}
_EPHEMERAL_PREFIXES = (
    ".cache-",
    ".scratch-",
    ".temp-",
    ".tmp-",
    "cache-",
    "scratch-",
    "temp-",
    "tmp-",
)


def _system_temp_roots() -> list[Path]:
    candidates = [
        Path(tempfile.gettempdir()),
        Path("/tmp"),
        Path("/var/tmp"),
        Path("/private/tmp"),
        Path("/private/var/tmp"),
    ]
    candidates.extend(
        Path(value)
        for key in ("TMPDIR", "TEMP", "TMP")
        if (value := os.environ.get(key))
    )
    unique: list[Path] = []
    for candidate in candidates:
        resolved = candidate.expanduser().resolve(strict=False)
        if resolved not in unique:
            unique.append(resolved)
    return unique


def _has_ephemeral_component(path: Path) -> bool:
    for part in path.parts:
        normalized = part.casefold()
        if normalized in _EPHEMERAL_COMPONENTS:
            return True
        if normalized.startswith(_EPHEMERAL_PREFIXES):
            return True
    return False


def is_ephemeral_handoff_path(
    path: Path, temp_roots: list[Path] | None = None
) -> bool:
    """Return whether a resolved path is under OS temp or named tool scratch."""

    resolved = Path(path).expanduser().resolve(strict=False)
    roots = temp_roots if temp_roots is not None else _system_temp_roots()
    return _has_ephemeral_component(resolved) or any(
        _is_within(resolved, Path(root).expanduser().resolve(strict=False))
        for root in roots
    )


def validate_handoff_paths(
    paths: list[Path], persistent_root: Path
) -> list[Path]:
    """Return resolved handoff files or fail when any path is unsafe."""

    requested_root = Path(persistent_root).expanduser()
    try:
        resolved_persistent_root = requested_root.resolve(strict=True)
    except FileNotFoundError as error:
        raise HandoffPathError(
            f"persistent root does not exist: {requested_root}"
        ) from error
    if not resolved_persistent_root.is_dir():
        raise HandoffPathError(
            f"persistent root is not a directory: {resolved_persistent_root}"
        )
    if is_ephemeral_handoff_path(resolved_persistent_root):
        raise HandoffPathError(
            "persistent root is an operating-system temporary or tool scratch "
            f"directory: {resolved_persistent_root}"
        )

    validated: list[Path] = []

    for candidate in paths:
        expanded = Path(candidate).expanduser()
        try:
            resolved = expanded.resolve(strict=True)
        except FileNotFoundError as error:
            raise HandoffPathError(f"handoff file does not exist: {expanded}") from error
        if not resolved.is_file():
            raise HandoffPathError(f"handoff path is not a regular file: {resolved}")
        if resolved.stat().st_size <= 0:
            raise HandoffPathError(f"handoff file is empty: {resolved}")
        if is_ephemeral_handoff_path(resolved):
            raise HandoffPathError(
                "handoff file is inside an operating-system temporary or tool "
                "scratch directory: "
                f"{resolved}"
            )
        if not _is_within(resolved, resolved_persistent_root):
            raise HandoffPathError(
                "handoff file is outside the declared persistent root "
                f"{resolved_persistent_root}: {resolved}"
            )
        validated.append(resolved)

    return validated


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--persistent-root",
        required=True,
        type=Path,
        help="Existing user-accessible directory that must contain every handoff file",
    )
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Final PPTX, PDF, ZIP, or other handoff files to validate",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        validated = validate_handoff_paths(args.paths, args.persistent_root)
    except HandoffPathError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for path in validated:
        print(f"PASS {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
