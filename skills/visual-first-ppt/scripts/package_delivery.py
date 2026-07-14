"""Validate and build a deterministic visual-first PPT delivery archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
from typing import Any
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo


FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
INTERNAL_FILE_NAMES = {
    ".ds_store",
    "artifact-summary.json",
    "comparison.json",
    "desktop.ini",
    "project-manifest.json",
    "qa-report.json",
    "state.json",
    "thumbs.db",
}
INTERNAL_DIRECTORY_NAMES = {"__pycache__", ".git", ".svn", "node_modules"}
TEMPORARY_SUFFIXES = {
    ".bak",
    ".crdownload",
    ".lock",
    ".log",
    ".ndjson",
    ".part",
    ".pyc",
    ".swo",
    ".swp",
    ".temp",
    ".tmp",
}
REQUIRED_AUTOMATED_CHECKS = {
    "pptxParse",
    "pdfParse",
    "pageCountAndCanvas",
    "overflow",
    "unexpectedOverlap",
    "unresolvedPlaceholder",
    "brokenRelationship",
    "fontAvailability",
    "nativeObjectTypes",
    "dataMismatch",
    "pptxPdfPreviewParity",
}
HARD_ZERO = {
    "overflow",
    "unexpectedOverlap",
    "unresolvedPlaceholder",
    "brokenRelationship",
    "dataMismatch",
}


class PackagingError(ValueError):
    """Raised when delivery evidence or contents are not safe to package."""


def _read_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise PackagingError(f"missing {label}: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PackagingError(f"invalid {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise PackagingError(f"invalid {label}: expected a JSON object")
    return value


def _require_release_evidence(workspace: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    if not workspace.is_dir():
        raise PackagingError(f"workspace directory does not exist: {workspace}")

    state = _read_json(workspace / "state.json", "approved state")
    if state.get("status") != "DELIVERED":
        raise PackagingError("approved state must have status DELIVERED")

    approvals = state.get("approvals")
    final_approval = approvals.get("final") if isinstance(approvals, dict) else None
    approved_hash = (
        final_approval.get("approvedArtifactHash")
        if isinstance(final_approval, dict)
        else None
    )
    if not isinstance(approved_hash, str) or not approved_hash.strip():
        raise PackagingError("final approval must include a nonempty approvedArtifactHash")

    qa_report = _read_json(workspace / "qa-report.json", "QA report")
    if qa_report.get("finalVerdict") != "PASS":
        raise PackagingError("QA report finalVerdict must be PASS")
    if qa_report.get("projectId") != state.get("projectId"):
        raise PackagingError("QA report projectId must match delivered state")
    if qa_report.get("route") != state.get("route"):
        raise PackagingError("QA report route must match delivered state")
    return state, qa_report


def _looks_internal_or_temporary(relative_path: Path) -> bool:
    lowered_parts = [part.casefold() for part in relative_path.parts]
    name = lowered_parts[-1]

    if any(part.startswith(".") for part in lowered_parts):
        return True
    if any(part in INTERNAL_DIRECTORY_NAMES for part in lowered_parts[:-1]):
        return True
    if name in INTERNAL_FILE_NAMES or name.startswith("~$") or name.endswith("~"):
        return True
    if Path(name).suffix.casefold() in TEMPORARY_SUFFIXES:
        return True
    return any(
        name.startswith(prefix)
        for prefix in ("scratch-", "scratch_", "temp-", "temp_", "tmp-", "tmp_")
    )


def _collect_delivery_files(delivery_dir: Path, output: Path) -> list[Path]:
    if not delivery_dir.is_dir():
        raise PackagingError(f"delivery directory does not exist: {delivery_dir}")

    delivery_resolved = delivery_dir.resolve()
    output_resolved = output.resolve()
    if output_resolved == delivery_resolved or delivery_resolved in output_resolved.parents:
        raise PackagingError("output ZIP must be outside the delivery directory")

    files: list[Path] = []
    for path in sorted(delivery_dir.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(delivery_dir)
        if path.is_symlink():
            raise PackagingError(f"internal or unsafe symlink in delivery directory: {relative}")
        if _looks_internal_or_temporary(relative):
            raise PackagingError(f"internal or temporary file in delivery directory: {relative}")
        if path.is_file():
            if path.suffix.casefold() == ".json":
                raise PackagingError(f"internal JSON is not allowed in delivery directory: {relative}")
            files.append(path)

    pptx_files = [path for path in files if path.suffix.casefold() == ".pptx"]
    if len(pptx_files) != 1:
        raise PackagingError(
            f"delivery directory must contain exactly one PPTX file; found {len(pptx_files)}"
        )

    pdf_files = [path for path in files if path.suffix.casefold() == ".pdf"]
    if len(pdf_files) != 1:
        raise PackagingError(
            f"delivery directory must contain exactly one PDF file; found {len(pdf_files)}"
        )

    previews_dir = delivery_dir / "previews"
    preview_files = [
        path for path in files if previews_dir in path.parents and path.is_file()
    ]
    if not previews_dir.is_dir() or not preview_files:
        raise PackagingError("previews directory must exist and contain at least one file")

    production_record = delivery_dir / "production-record.txt"
    if not production_record.is_file():
        raise PackagingError("production record is missing: production-record.txt")
    try:
        production_text = production_record.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise PackagingError(f"invalid production record: {error}") from error
    if not production_text.strip():
        raise PackagingError("production record must be nonempty")

    relative_names = [path.relative_to(delivery_dir).as_posix() for path in files]
    casefolded = [name.casefold() for name in relative_names]
    if len(casefolded) != len(set(casefolded)):
        raise PackagingError("delivery directory contains case-insensitive duplicate paths")

    return files


def _pptx_slide_count(path: Path) -> int:
    try:
        with ZipFile(path) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise PackagingError(f"invalid PPTX ZIP member: {bad_member}")
            names = set(archive.namelist())
            required = {"[Content_Types].xml", "ppt/presentation.xml"}
            if not required.issubset(names):
                missing = ", ".join(sorted(required - names))
                raise PackagingError(f"invalid PPTX package; missing {missing}")
            slides = [
                name
                for name in names
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
            ]
            if not slides:
                raise PackagingError("invalid PPTX package; no slide XML parts")
            for slide in slides:
                payload = archive.read(slide).lstrip()
                if not payload.startswith(b"<"):
                    raise PackagingError(f"invalid PPTX slide XML: {slide}")
            return len(slides)
    except (BadZipFile, OSError, ValueError) as error:
        if isinstance(error, PackagingError):
            raise
        raise PackagingError(f"invalid PPTX: {path}: {error}") from error


def _pdf_page_count(path: Path) -> int:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise PackagingError(f"invalid PDF: {path}: {error}") from error
    if not payload.startswith(b"%PDF-") or b"%%EOF" not in payload[-2048:]:
        raise PackagingError(f"invalid PDF header or trailer: {path}")
    page_count = len(re.findall(rb"/Type\s*/Page\b", payload))
    if page_count < 1:
        raise PackagingError(f"invalid PDF; no page objects: {path}")
    return page_count


def _validate_png(path: Path) -> tuple[int, int]:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise PackagingError(f"invalid PNG preview {path}: {error}") from error
    signature = b"\x89PNG\r\n\x1a\n"
    if len(payload) < 33 or not payload.startswith(signature):
        raise PackagingError(f"invalid PNG preview: {path}")
    length = struct.unpack(">I", payload[8:12])[0]
    if length != 13 or payload[12:16] != b"IHDR":
        raise PackagingError(f"invalid PNG IHDR: {path}")
    width, height = struct.unpack(">II", payload[16:24])
    if width < 1 or height < 1 or b"IEND" not in payload[-32:]:
        raise PackagingError(f"invalid PNG dimensions or trailer: {path}")
    return width, height


def _validate_qa_evidence(qa_report: dict[str, Any], slide_count: int) -> None:
    checks = qa_report.get("automatedChecks")
    if not isinstance(checks, list):
        raise PackagingError("QA report automatedChecks must be an array")
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    missing = REQUIRED_AUTOMATED_CHECKS - set(by_id)
    if missing:
        raise PackagingError(f"QA report is missing automated checks: {', '.join(sorted(missing))}")
    for check_id in REQUIRED_AUTOMATED_CHECKS:
        check = by_id[check_id]
        if check.get("status") != "PASS":
            raise PackagingError(f"QA automated check must PASS: {check_id}")
        if check_id in HARD_ZERO and check.get("value") != 0:
            raise PackagingError(f"QA hard-zero check must be 0: {check_id}")
        evidence_path = check.get("evidencePath")
        if not isinstance(evidence_path, str) or not evidence_path.strip():
            raise PackagingError(f"QA evidence path is missing: {check_id}")
        evidence = Path(evidence_path)
        if not evidence.is_file() or evidence.stat().st_size <= 0:
            raise PackagingError(f"QA evidence file is missing or empty: {evidence}")

    manual = qa_report.get("perSlideManualScores")
    if not isinstance(manual, list):
        raise PackagingError("QA manual scores must be an array")
    slides = sorted(item.get("slide") for item in manual if isinstance(item, dict))
    expected = list(range(1, slide_count + 1))
    if slides != expected:
        raise PackagingError(
            f"QA manual slide coverage must be continuous 1-{slide_count}; received {slides}"
        )
    for item in manual:
        evidence = Path(str(item.get("evidencePath", "")))
        if not evidence.is_file() or evidence.stat().st_size <= 0:
            raise PackagingError(f"QA manual evidence file is missing or empty: {evidence}")


def _validate_delivery_artifacts(
    delivery_dir: Path,
    files: list[Path],
    state: dict[str, Any],
    qa_report: dict[str, Any],
) -> None:
    pptx = next(path for path in files if path.suffix.casefold() == ".pptx")
    pdf = next(path for path in files if path.suffix.casefold() == ".pdf")
    slide_count = _pptx_slide_count(pptx)
    pdf_count = _pdf_page_count(pdf)
    if pdf_count != slide_count:
        raise PackagingError(
            f"PDF page count {pdf_count} does not match PPTX slide count {slide_count}"
        )

    previews_dir = delivery_dir / "previews"
    preview_files = sorted(path for path in files if previews_dir in path.parents)
    if any(path.suffix.casefold() != ".png" for path in preview_files):
        raise PackagingError("previews directory may contain only PNG files")
    if len(preview_files) != slide_count:
        raise PackagingError(
            f"preview count {len(preview_files)} does not match PPTX slide count {slide_count}"
        )
    for preview in preview_files:
        _validate_png(preview)

    approved_hash = state["approvals"]["final"]["approvedArtifactHash"].strip()
    actual_hash = hashlib.sha256(pptx.read_bytes()).hexdigest()
    if approved_hash.removeprefix("sha256:") != actual_hash:
        raise PackagingError("final approval hash does not match delivered PPTX")
    input_hashes = qa_report.get("inputHashes")
    if not isinstance(input_hashes, dict) or f"sha256:{actual_hash}" not in input_hashes.values():
        raise PackagingError("QA input hashes do not bind the delivered PPTX")
    _validate_qa_evidence(qa_report, slide_count)


def _zip_info(member_name: str) -> ZipInfo:
    info = ZipInfo(member_name, date_time=FIXED_ZIP_TIMESTAMP)
    info.compress_type = ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def _build_payloads(delivery_dir: Path, files: list[Path]) -> dict[str, bytes]:
    payloads: dict[str, bytes] = {}
    for path in files:
        member_name = path.relative_to(delivery_dir).as_posix()
        try:
            payloads[member_name] = path.read_bytes()
        except OSError as error:
            raise PackagingError(f"could not read delivery file {member_name}: {error}") from error
    return payloads


def _manifest_bytes(payloads: dict[str, bytes]) -> bytes:
    manifest = {
        "files": [
            {
                "path": member_name,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
            }
            for member_name, payload in sorted(payloads.items())
        ]
    }
    return (
        json.dumps(
            manifest,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def package_delivery(workspace: Path, delivery_dir: Path, output: Path) -> None:
    """Validate evidence and write a deterministic delivery ZIP."""

    state, qa_report = _require_release_evidence(workspace)
    files = _collect_delivery_files(delivery_dir, output)
    _validate_delivery_artifacts(delivery_dir, files, state, qa_report)
    payloads = _build_payloads(delivery_dir, files)
    payloads["manifest.json"] = _manifest_bytes(payloads)

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix=f".{output.name}.", suffix=".tmp", dir=output.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with ZipFile(
                temporary_path,
                mode="w",
                compression=ZIP_DEFLATED,
                compresslevel=9,
            ) as archive:
                for member_name in sorted(payloads):
                    archive.writestr(_zip_info(member_name), payloads[member_name])
            os.replace(temporary_path, output)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
    except (OSError, ValueError) as error:
        raise PackagingError(f"could not write output ZIP {output}: {error}") from error


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--delivery-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        package_delivery(args.workspace, args.delivery_dir, args.output)
    except PackagingError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
