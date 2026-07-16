#!/usr/bin/env python3
"""Build deterministic Skill and Plugin distribution archives.

This module intentionally uses a small, explicit allowlist. Repository metadata,
tests, local documentation, and marketplace configuration are never discovered by
walking the repository root.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable, Sequence


PLUGIN_MANIFEST = PurePosixPath(".codex-plugin/plugin.json")
SKILL_SOURCE = PurePosixPath("skills/visual-first-ppt")
SKILL_ARCHIVE_ROOT = PurePosixPath("visual-first-ppt")
LICENSE_FILE = PurePosixPath("LICENSE")
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
FIXED_FILE_MODE = stat.S_IFREG | 0o644

_SEMVER = re.compile(
    r"^(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

_EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
        ".git",
        ".venv",
        "__pycache__",
        "customer-materials",
        "customer_materials",
        "client-materials",
        "client_materials",
        "local-test-output",
        "local-test-results",
        "test-output",
        "test-results",
        "tests",
        "tmp",
    }
)
_EXCLUDED_FILE_NAMES = frozenset({".DS_Store"})
_EXCLUDED_FILE_SUFFIXES = frozenset({".pyc", ".pyo"})

_UNSUPPORTED_PLUGIN_INTEGRATIONS = ("apps", "hooks", "mcpServers")
_INTERFACE_ASSET_FIELDS = ("composerIcon", "logo", "logoDark")


def _absolute_without_resolving(path: Path) -> Path:
    """Return an absolute path while preserving symlink components."""

    return Path(os.path.abspath(os.fspath(path.expanduser())))


def _trusted_path_without_symlinks(path: Path, purpose: str) -> Path:
    """Map ``path`` below a canonical trusted base and reject symlinks beneath it.

    The current working directory and the runtime-provided temporary directory
    are caller/environment bases, so their own platform aliases are normalized
    once. Outside those bases the filesystem anchor is used. Every component
    below the selected base is then inspected without following symlinks.
    """

    lexical = _absolute_without_resolving(Path(path))
    candidate_bases = {
        _absolute_without_resolving(Path.cwd()),
        _absolute_without_resolving(Path(tempfile.gettempdir())),
    }
    containing_bases = [
        base
        for base in candidate_bases
        if lexical == base or lexical.is_relative_to(base)
    ]
    if containing_bases:
        lexical_base = max(containing_bases, key=lambda base: len(base.parts))
    else:
        lexical_base = Path(lexical.anchor)

    try:
        canonical_base = lexical_base.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"trusted base for {purpose} is unavailable: {lexical_base}") from error

    current = canonical_base
    for part in lexical.relative_to(lexical_base).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"ancestor symlink is not allowed for {purpose}: {current}")
    return current


def _require_repository_root(root: Path) -> Path:
    canonical = _trusted_path_without_symlinks(Path(root), "repository root")
    if not canonical.is_dir():
        raise ValueError(f"repository root is not a directory: {canonical}")
    return canonical


def _prepare_output_directory(output_dir: Path) -> Path:
    """Canonicalize the caller's output base, creating only checked descendants."""

    lexical = _trusted_path_without_symlinks(Path(output_dir), "output directory")
    if lexical.exists() or lexical.is_symlink():
        try:
            canonical = lexical.resolve(strict=True)
        except OSError as error:
            raise ValueError(f"output directory is unavailable: {lexical}") from error
        if not canonical.is_dir():
            raise ValueError(f"output directory is not a directory: {canonical}")
        return canonical

    missing_parts: list[str] = []
    existing = lexical
    while not existing.exists() and not existing.is_symlink():
        if existing == existing.parent:
            raise ValueError(f"output directory has no existing ancestor: {lexical}")
        missing_parts.append(existing.name)
        existing = existing.parent
    try:
        current = existing.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"output directory ancestor is unavailable: {existing}") from error
    if not current.is_dir():
        raise ValueError(f"output directory ancestor is not a directory: {current}")

    for part in reversed(missing_parts):
        current = current / part
        try:
            current.mkdir()
        except FileExistsError:
            pass
        if current.is_symlink():
            raise ValueError(f"ancestor symlink is not allowed for output directory: {current}")
        if not current.is_dir():
            raise ValueError(f"output directory component is not a directory: {current}")
    return current


def _is_excluded(relative_path: PurePosixPath) -> bool:
    parts = relative_path.parts
    if any(part.casefold() in _EXCLUDED_DIRECTORY_NAMES for part in parts):
        return True
    if not parts:
        return False
    name = parts[-1]
    return name in _EXCLUDED_FILE_NAMES or Path(name).suffix.casefold() in _EXCLUDED_FILE_SUFFIXES


def _reject_symlink_chain(root: Path, relative_path: PurePosixPath) -> Path:
    """Reject a symlink in any included path component and return its source path."""

    current = root
    if current.is_symlink():
        raise ValueError(f"symlink is not allowed in package input: {current}")
    for part in relative_path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink is not allowed in package input: {current}")
    return current


def _validate_archive_path(name: str) -> str:
    if not isinstance(name, str) or not name:
        raise ValueError("archive path must be a non-empty string")
    if "\x00" in name or "\\" in name or name.startswith("/"):
        raise ValueError(f"unsafe archive path: {name!r}")
    if PureWindowsPath(name).drive or PureWindowsPath(name).is_absolute():
        raise ValueError(f"unsafe archive path: {name!r}")
    raw_parts = name.split("/")
    if name.endswith("/") or any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError(f"unsafe archive path: {name!r}")
    normalized = PurePosixPath(name)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError(f"unsafe archive path: {name!r}")
    return normalized.as_posix()


def _validate_manifest_local_path(value: object, field: str) -> PurePosixPath:
    if not isinstance(value, str) or not value.startswith("./"):
        raise ValueError(
            f"manifest field {field} must be a relative local path beginning with './'"
        )
    raw = value[2:]
    if not raw or "\\" in raw or PureWindowsPath(raw).drive:
        raise ValueError(f"manifest field {field} must be a safe relative local path")
    raw_parts = raw.split("/")
    if raw_parts[-1] == "":
        raw_parts = raw_parts[:-1]
    if not raw_parts or any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError(f"manifest field {field} must be a safe relative local path")
    relative = PurePosixPath(*raw_parts)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"manifest field {field} must be a safe relative local path")
    return relative


def _load_manifest(root: Path) -> tuple[Path, dict[str, object]]:
    manifest_path = _reject_symlink_chain(root, PLUGIN_MANIFEST)
    if not manifest_path.is_file():
        raise ValueError(f"missing Plugin manifest: {PLUGIN_MANIFEST.as_posix()}")
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid Plugin manifest: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("invalid Plugin manifest: root value must be an object")
    return manifest_path, value


def _collect_tree(
    root: Path,
    source_relative: PurePosixPath,
    archive_relative: PurePosixPath,
) -> list[tuple[Path, str]]:
    source_root = _reject_symlink_chain(root, source_relative)
    if not source_root.is_dir():
        raise ValueError(f"missing package source directory: {source_relative.as_posix()}")

    entries: list[tuple[Path, str]] = []
    candidates = sorted(
        source_root.rglob("*"),
        key=lambda path: path.relative_to(source_root).as_posix(),
    )
    for source in candidates:
        child_relative = PurePosixPath(source.relative_to(source_root).as_posix())
        if _is_excluded(child_relative):
            continue
        if source.is_symlink():
            raise ValueError(f"symlink is not allowed in package input: {source}")
        if source.is_dir():
            continue
        if not source.is_file():
            raise ValueError(f"package input must be a regular file: {source}")
        archive_name = _validate_archive_path(
            (archive_relative / child_relative).as_posix()
        )
        entries.append((source, archive_name))
    return entries


def _add_unique_entry(
    entries: dict[str, Path], source: Path, archive_name: str
) -> None:
    archive_name = _validate_archive_path(archive_name)
    previous = entries.get(archive_name)
    if previous is not None and previous != source:
        raise ValueError(f"duplicate archive path: {archive_name}")
    entries[archive_name] = source


def _collect_manifest_reference(
    root: Path,
    relative: PurePosixPath,
) -> list[tuple[Path, str]]:
    if _is_excluded(relative):
        raise ValueError(
            f"manifest references an excluded local path: {relative.as_posix()}"
        )
    source = _reject_symlink_chain(root, relative)
    if source.is_dir():
        return _collect_tree(root, relative, relative)
    if not source.is_file():
        raise ValueError(
            f"manifest references a missing local path: {relative.as_posix()}"
        )
    return [(source, _validate_archive_path(relative.as_posix()))]


def _manifest_references(manifest: dict[str, object]) -> list[PurePosixPath]:
    references: list[PurePosixPath] = []

    for field in _UNSUPPORTED_PLUGIN_INTEGRATIONS:
        if field in manifest:
            raise ValueError(
                f"unsupported integration field {field!r} cannot expand the Plugin package allowlist"
            )

    skills_value = manifest.get("skills")
    if skills_value is not None:
        skills_path = _validate_manifest_local_path(skills_value, "skills")
        if skills_path not in {
            PurePosixPath("skills"),
            PurePosixPath("skills/visual-first-ppt"),
        }:
            raise ValueError(
                "manifest field skills must reference the repository's ./skills/ source"
            )

    interface = manifest.get("interface")
    if interface is None:
        interface = {}
    if not isinstance(interface, dict):
        raise ValueError("manifest field interface must be an object")

    asset_values: list[tuple[str, object]] = []
    for field in _INTERFACE_ASSET_FIELDS:
        if field in interface:
            asset_values.append((f"interface.{field}", interface[field]))

    screenshots = interface.get("screenshots")
    if screenshots is not None:
        if not isinstance(screenshots, list):
            raise ValueError("manifest field interface.screenshots must be an array")
        asset_values.extend(
            (f"interface.screenshots[{index}]", value)
            for index, value in enumerate(screenshots)
        )

    for field, value in asset_values:
        relative = _validate_manifest_local_path(value, field)
        if not relative.parts or relative.parts[0] != "assets":
            raise ValueError(f"manifest field {field} must reference ./assets/")
        references.append(relative)

    return references


def collect_skill_files(root: Path) -> list[tuple[Path, str]]:
    """Collect the unique Skill source into a top-level ``visual-first-ppt/``."""

    repository_root = _require_repository_root(Path(root))
    entries = _collect_tree(repository_root, SKILL_SOURCE, SKILL_ARCHIVE_ROOT)
    if not any(name == "visual-first-ppt/SKILL.md" for _, name in entries):
        raise ValueError("missing required Skill entrypoint: skills/visual-first-ppt/SKILL.md")
    return sorted(entries, key=lambda entry: entry[1])


def collect_plugin_files(root: Path) -> list[tuple[Path, str]]:
    """Collect only the Plugin manifest, Skill, license, and referenced local files."""

    repository_root = _require_repository_root(Path(root))
    manifest_path, manifest = _load_manifest(repository_root)
    entries: dict[str, Path] = {}
    _add_unique_entry(entries, manifest_path, PLUGIN_MANIFEST.as_posix())

    license_path = _reject_symlink_chain(repository_root, LICENSE_FILE)
    if not license_path.is_file():
        raise ValueError(f"missing Plugin license: {LICENSE_FILE.as_posix()}")
    _add_unique_entry(entries, license_path, LICENSE_FILE.as_posix())

    for source, archive_name in _collect_tree(
        repository_root, SKILL_SOURCE, SKILL_SOURCE
    ):
        _add_unique_entry(entries, source, archive_name)
    if "skills/visual-first-ppt/SKILL.md" not in entries:
        raise ValueError("missing required Skill entrypoint: skills/visual-first-ppt/SKILL.md")

    for relative in _manifest_references(manifest):
        for source, archive_name in _collect_manifest_reference(
            repository_root, relative
        ):
            _add_unique_entry(entries, source, archive_name)

    return [(entries[name], name) for name in sorted(entries)]


def write_deterministic_zip(
    entries: Iterable[tuple[Path, str]], output: Path
) -> str:
    """Write a byte-stable ZIP and return its lowercase SHA-256 digest."""

    prepared: list[tuple[Path, str, bytes]] = []
    seen: set[str] = set()
    for source_value, archive_value in entries:
        source = _trusted_path_without_symlinks(Path(source_value), "package input")
        archive_name = _validate_archive_path(archive_value)
        if archive_name in seen:
            raise ValueError(f"duplicate archive path: {archive_name}")
        seen.add(archive_name)
        if source.is_symlink():
            raise ValueError(f"symlink is not allowed in package input: {source}")
        if not source.is_file():
            raise ValueError(f"package input must be a regular file: {source}")
        prepared.append((source, archive_name, source.read_bytes()))
    prepared.sort(key=lambda entry: entry[1])

    output = _trusted_path_without_symlinks(Path(output), "archive output")
    output.parent.mkdir(parents=True, exist_ok=True)
    output = _trusted_path_without_symlinks(output, "archive output")
    if output.is_symlink():
        raise ValueError(f"archive output must not be a symlink: {output}")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary_path,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            archive.comment = b""
            for _source, archive_name, content in prepared:
                info = zipfile.ZipInfo(archive_name, date_time=FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.create_version = 20
                info.extract_version = 20
                info.external_attr = FIXED_FILE_MODE << 16
                info.internal_attr = 0
                info.extra = b""
                info.comment = b""
                archive.writestr(
                    info,
                    content,
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
        digest = hashlib.sha256(temporary_path.read_bytes()).hexdigest()
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, output)
        return digest
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_checksum_file(
    hashes: dict[str, str], output: Path
) -> None:
    content = "".join(
        f"{hashes[name]}  {name}\n" for name in sorted(hashes)
    ).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        temporary_path.write_bytes(content)
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, output)
    finally:
        temporary_path.unlink(missing_ok=True)


def build_distribution(root: Path, output_dir: Path, version: str) -> list[Path]:
    """Build the two archives and checksum file into ``output_dir``."""

    if not isinstance(version, str) or not _SEMVER.fullmatch(version):
        raise ValueError(f"version must be valid semantic version text: {version!r}")

    repository_root = _require_repository_root(Path(root))
    _manifest_path, manifest = _load_manifest(repository_root)
    manifest_version = manifest.get("version")
    if manifest_version != version:
        raise ValueError(
            f"manifest version {manifest_version!r} does not match requested version {version!r}"
        )

    # Fully validate and read the fixed input sets before creating output_dir.
    skill_entries = collect_skill_files(repository_root)
    plugin_entries = collect_plugin_files(repository_root)

    output_dir = _prepare_output_directory(Path(output_dir))

    names = [
        f"visual-first-ppt-skill-v{version}.zip",
        f"visual-first-ppt-plugin-v{version}.zip",
        "SHA256SUMS",
    ]
    final_paths = [output_dir / name for name in names]
    for path in final_paths:
        if path.is_symlink():
            raise ValueError(f"distribution output must not be a symlink: {path}")
        if path.exists() and not path.is_file():
            raise ValueError(f"distribution output is not a regular file: {path}")

    staging = Path(tempfile.mkdtemp(prefix=".visual-first-ppt-build-", dir=output_dir))
    try:
        staged_skill = staging / names[0]
        staged_plugin = staging / names[1]
        hashes = {
            names[0]: write_deterministic_zip(skill_entries, staged_skill),
            names[1]: write_deterministic_zip(plugin_entries, staged_plugin),
        }
        staged_sums = staging / names[2]
        _write_checksum_file(hashes, staged_sums)

        # Each complete artifact is atomically replaced; checksums publish last.
        for staged, final in zip(
            (staged_skill, staged_plugin, staged_sums), final_paths, strict=True
        ):
            os.replace(staged, final)
        return final_paths
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build deterministic Visual-First PPT Skill and Plugin archives."
    )
    parser.add_argument("--root", required=True, type=Path, help="repository root")
    parser.add_argument(
        "--output-dir", required=True, type=Path, help="directory for release assets"
    )
    parser.add_argument("--version", required=True, help="manifest version to package")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        outputs = build_distribution(args.root, args.output_dir, args.version)
    except (OSError, ValueError) as error:
        print(f"BUILD_FAILED: {error}", file=sys.stderr)
        return 1
    for output in outputs:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
