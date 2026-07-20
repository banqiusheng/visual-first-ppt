"""Bounded ZIP reads for untrusted PPTX inputs."""

from __future__ import annotations

import hashlib
import os
from pathlib import PurePosixPath
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo


MAX_ZIP_PARSED_MEMBER_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_ZIP_OPAQUE_MEMBER_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_ZIP_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 200
MAX_ZIP_MEMBERS = 10000
MAX_SOURCE_PPTX_COMPRESSED_BYTES = 256 * 1024 * 1024
STREAM_CHUNK_BYTES = 1024 * 1024


def _safe_member_name(name: str) -> bool:
    if not name or "\\" in name or "\0" in name or name.startswith("/"):
        return False
    parts = PurePosixPath(name.rstrip("/")).parts
    return bool(parts) and all(part not in {"", ".", ".."} for part in parts)


def _member_output_limit(name: str) -> int:
    if name == "[Content_Types].xml" or name.endswith((".xml", ".rels")):
        return MAX_ZIP_PARSED_MEMBER_OUTPUT_BYTES
    return MAX_ZIP_OPAQUE_MEMBER_OUTPUT_BYTES


def _archive_source_size(archive: ZipFile) -> int | None:
    source = getattr(archive, "fp", None)
    if source is None:
        return None
    try:
        return os.fstat(source.fileno()).st_size
    except (AttributeError, OSError):
        try:
            position = source.tell()
            source.seek(0, os.SEEK_END)
            size = source.tell()
            source.seek(position)
            return size
        except (AttributeError, OSError, ValueError):
            return None


def validate_zip_archive(archive: ZipFile, label: str) -> dict[str, ZipInfo]:
    source_size = _archive_source_size(archive)
    if source_size is not None and source_size > MAX_SOURCE_PPTX_COMPRESSED_BYTES:
        raise ValueError(f"{label} compressed source exceeds the PPTX source file size limit")
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ZIP_MEMBERS:
        raise ValueError(f"{label} ZIP member count is invalid or exceeds the limit")
    by_name: dict[str, ZipInfo] = {}
    total_output = 0
    for info in infos:
        if not _safe_member_name(info.filename):
            raise ValueError(f"{label} contains an unsafe ZIP member name: {info.filename}")
        if info.filename in by_name:
            raise ValueError(f"duplicate ZIP member names are not allowed: {info.filename}")
        if info.flag_bits & 0x1:
            raise ValueError(f"{label} contains encrypted ZIP content")
        if info.compress_type not in {ZIP_STORED, ZIP_DEFLATED}:
            raise ValueError(f"{label} uses an unsupported ZIP compression method")
        if info.file_size < 0 or info.compress_size < 0:
            raise ValueError(f"{label} contains invalid ZIP size metadata")
        if info.file_size > _member_output_limit(info.filename):
            raise ValueError(f"{label} ZIP member exceeds the uncompressed member limit")
        total_output += info.file_size
        if total_output > MAX_ZIP_TOTAL_OUTPUT_BYTES:
            raise ValueError(f"{label} ZIP exceeds the total uncompressed output limit")
        if info.compress_type == ZIP_STORED and info.compress_size != info.file_size:
            raise ValueError(f"{label} contains inconsistent stored ZIP sizes")
        if info.file_size > 0 and (
            info.compress_size == 0
            or info.file_size > info.compress_size * MAX_ZIP_COMPRESSION_RATIO
        ):
            raise ValueError(f"{label} ZIP member exceeds the compression ratio limit")
        by_name[info.filename] = info
    return by_name


def read_zip_member(
    archive: ZipFile,
    member: str,
    label: str,
    members: dict[str, ZipInfo] | None = None,
) -> bytes:
    known = members if members is not None else validate_zip_archive(archive, label)
    info = known.get(member)
    if info is None or info.is_dir():
        raise ValueError(f"{label} is missing ZIP member: {member}")
    output_limit = _member_output_limit(member)
    try:
        with archive.open(info, "r") as source:
            payload = source.read(output_limit + 1)
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError(f"{label} cannot read ZIP member {member}: {error}") from error
    if len(payload) > output_limit:
        raise ValueError(f"{label} ZIP member exceeds the uncompressed member limit")
    if len(payload) != info.file_size:
        raise ValueError(
            f"{label} ZIP member declared size mismatch for {member}: "
            f"expected {info.file_size}, received {len(payload)}"
        )
    return payload


def hash_zip_member(
    archive: ZipFile,
    member: str,
    label: str,
    members: dict[str, ZipInfo] | None = None,
) -> str:
    """Hash an opaque member incrementally without materializing it in memory."""
    known = members if members is not None else validate_zip_archive(archive, label)
    info = known.get(member)
    if info is None or info.is_dir():
        raise ValueError(f"{label} is missing ZIP member: {member}")
    limit = _member_output_limit(member)
    digest = hashlib.sha256()
    total = 0
    try:
        with archive.open(info, "r") as source:
            while True:
                chunk = source.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise ValueError(
                        f"{label} ZIP member exceeds the uncompressed member limit"
                    )
                digest.update(chunk)
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError(f"{label} cannot read ZIP member {member}: {error}") from error
    if total != info.file_size:
        raise ValueError(
            f"{label} ZIP member declared size mismatch for {member}: "
            f"expected {info.file_size}, received {total}"
        )
    return digest.hexdigest()
