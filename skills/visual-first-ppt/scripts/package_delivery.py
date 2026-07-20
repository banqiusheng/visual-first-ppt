"""Validate and build a deterministic visual-first PPT delivery archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from typing import Any
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo
import xml.etree.ElementTree as ET
import zlib

SCRIPT_LIBRARY_DIR = Path(__file__).resolve().parent
if str(SCRIPT_LIBRARY_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_LIBRARY_DIR))
from lib.zip_safety import read_zip_member, validate_zip_archive


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
EPHEMERAL_OUTPUT_COMPONENTS = frozenset({
    ".cache", ".scratch", ".temp", ".tmp", "cache", "caches", "scratch",
    "temp", "temporaryitems", "tmp",
})
EPHEMERAL_OUTPUT_PREFIXES = (
    ".cache-", ".scratch-", ".temp-", ".tmp-", "cache-", "scratch-",
    "temp-", "tmp-",
)
ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
ECMASCRIPT_WHITESPACE_RE = re.compile(f"[{re.escape(ECMASCRIPT_WHITESPACE)}]+")
QUALITY_CONTRACT_PATH = Path(__file__).resolve().parent.parent / "assets" / "quality-contract.json"
QUALITY_EVIDENCE_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "quality-evidence.schema.json"
PROJECT_ARTIFACTS_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "schemas" / "project-artifacts.schema.json"
)
CURRENT_QA_VALIDATOR_PATH = Path(__file__).resolve().parent / "validate-current-qa.mjs"
SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
SLIDE_RELATIONSHIP_TYPES = frozenset({
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/slide",
})
RELATIONSHIP_ID_QNAMES = (
    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id",
    "{http://purl.oclc.org/ooxml/officeDocument/relationships}id",
)


class PackagingError(ValueError):
    """Raised when delivery evidence or contents are not safe to package."""


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is forbidden: {value}")


def _parse_finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"JSON number must be finite: {value}")
    return parsed


def _strict_json_loads(value: str) -> Any:
    return json.loads(
        value,
        parse_constant=_reject_json_constant,
        parse_float=_parse_finite_float,
    )


def _read_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise PackagingError(f"missing {label}: {path}")
    try:
        value = _strict_json_loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise PackagingError(f"invalid {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise PackagingError(f"invalid {label}: expected a JSON object")
    return value


def _load_quality_contract() -> dict[str, Any]:
    contract = _read_json(QUALITY_CONTRACT_PATH, "quality contract")
    required_fields = {
        "qualityContractVersion",
        "requiredAutomatedChecks",
        "editRequiredChecks",
        "hardZeroChecks",
        "requiredReviewChecks",
        "requiredManualDimensions",
        "minimumManualScore",
    }
    missing = required_fields - set(contract)
    if missing:
        raise PackagingError(f"quality contract is missing fields: {', '.join(sorted(missing))}")
    return contract


def _load_quality_evidence_schema() -> dict[str, Any]:
    schema = _read_json(QUALITY_EVIDENCE_SCHEMA_PATH, "quality evidence schema")
    definitions = schema.get("$defs")
    required = {
        "prebuildEvidence", "automatedEvidenceBundle", "perCheckEvidence",
        "automatedCheck", "clientSmokeEvidence",
    }
    if not isinstance(definitions, dict) or required - set(definitions):
        raise PackagingError("quality evidence schema is missing required definitions")
    return schema


def _load_project_artifacts_schema() -> dict[str, Any]:
    schema = _read_json(PROJECT_ARTIFACTS_SCHEMA_PATH, "project artifacts schema")
    definitions = schema.get("$defs")
    required = {
        "projectManifest", "state", "qaReport", "qaReportCurrent", "qaReportLegacy",
    }
    if not isinstance(definitions, dict) or required - set(definitions):
        raise PackagingError("project artifacts schema is missing current/legacy QA definitions")
    return schema


def _matches_schema_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "integer":
        return _is_json_integer(value)
    if expected == "number":
        return _is_json_number(value)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return False


def _is_json_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _is_json_integer(value: Any) -> bool:
    return _is_json_number(value) and float(value).is_integer()


def _validate_schema_value(
    schema: dict[str, Any],
    value: Any,
    root: dict[str, Any],
    instance_path: str = "$",
    active_refs: frozenset[str] = frozenset(),
) -> list[str]:
    errors: list[str] = []
    reference = schema.get("$ref")
    if reference is not None:
        prefix = "#/$defs/"
        if not isinstance(reference, str) or not reference.startswith(prefix):
            return [f"{instance_path}: unsupported schema reference {reference!r}"]
        definition_name = reference[len(prefix):]
        definition = root.get("$defs", {}).get(definition_name)
        if not isinstance(definition, dict):
            return [f"{instance_path}: missing schema definition {definition_name}"]
        if reference in active_refs:
            return [f"{instance_path}: recursive schema reference {reference}"]
        return _validate_schema_value(
            definition,
            value,
            root,
            instance_path,
            active_refs | {reference},
        )

    candidates = schema.get("oneOf")
    if isinstance(candidates, list):
        matches = sum(
            not _validate_schema_value(candidate, value, root, instance_path, active_refs)
            for candidate in candidates
        )
        if matches != 1:
            errors.append(
                f"{instance_path}: expected exactly one oneOf schema match, received {matches}"
            )

    expected_types = schema.get("type")
    if expected_types is not None:
        expected = expected_types if isinstance(expected_types, list) else [expected_types]
        if not any(_matches_schema_type(value, item) for item in expected):
            errors.append(f"{instance_path}: expected {' or '.join(expected)}")
            return errors

    if "const" in schema and value != schema["const"]:
        errors.append(f"{instance_path}: expected constant {schema['const']!r}")
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        errors.append(f"{instance_path}: value is not in enum {schema['enum']!r}")
    pattern = schema.get("pattern")
    if isinstance(pattern, str) and isinstance(value, str) and re.search(pattern, value) is None:
        errors.append(f"{instance_path}: string does not match pattern {pattern}")
    minimum = schema.get("minimum")
    if isinstance(minimum, (int, float)) and not isinstance(minimum, bool):
        if _is_json_number(value) and value < minimum:
            errors.append(f"{instance_path}: value is below minimum {minimum}")
    maximum = schema.get("maximum")
    if isinstance(maximum, (int, float)) and not isinstance(maximum, bool):
        if _is_json_number(value) and value > maximum:
            errors.append(f"{instance_path}: value is above maximum {maximum}")
    min_items = schema.get("minItems")
    if isinstance(min_items, int) and isinstance(value, list) and len(value) < min_items:
        errors.append(f"{instance_path}: array has fewer than {min_items} items")

    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{instance_path}: missing required property {key}")
        for key, property_value in value.items():
            property_schema = properties.get(key)
            if isinstance(property_schema, dict):
                errors.extend(_validate_schema_value(
                    property_schema,
                    property_value,
                    root,
                    f"{instance_path}.{key}",
                    active_refs,
                ))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{instance_path}: additional property not allowed: {key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(_validate_schema_value(
                    schema["additionalProperties"],
                    property_value,
                    root,
                    f"{instance_path}.{key}",
                    active_refs,
                ))

    item_schema = schema.get("items")
    if isinstance(value, list) and isinstance(item_schema, dict):
        for index, item in enumerate(value):
            errors.extend(_validate_schema_value(
                item_schema,
                item,
                root,
                f"{instance_path}[{index}]",
                active_refs,
            ))
    return errors


def _require_current_qa_report(
    qa_report: dict[str, Any],
    project_schema: dict[str, Any],
) -> None:
    errors = _validate_schema_value(
        {"$ref": "#/$defs/qaReportCurrent"},
        qa_report,
        project_schema,
    )
    if errors:
        detail = "; ".join(errors[:8])
        raise PackagingError(
            f"QA report must satisfy qaReportCurrent; legacy QA is read-only: {detail}"
        )


def _require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"additional {', '.join(extra)}")
        raise PackagingError(f"{label} fields are invalid: {'; '.join(details)}")


def _run_current_qa_preflight(workspace: Path, qa_report_path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise PackagingError("Node.js is required for the shared current QA preflight")
    if not CURRENT_QA_VALIDATOR_PATH.is_file():
        raise PackagingError(
            f"shared current QA validator is missing: {CURRENT_QA_VALIDATOR_PATH}"
        )
    environment = os.environ.copy()
    environment.pop("NODE_OPTIONS", None)
    environment.pop("NODE_PATH", None)
    try:
        result = subprocess.run(
            [
                node,
                str(CURRENT_QA_VALIDATOR_PATH),
                "--qa-report",
                str(qa_report_path),
                "--workspace",
                str(workspace),
            ],
            text=True,
            capture_output=True,
            check=False,
            shell=False,
            timeout=60,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PackagingError(f"shared current QA preflight could not run: {error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise PackagingError(f"shared current QA preflight failed: {detail}")


def _is_within_path(candidate: Path, parent: Path) -> bool:
    try:
        candidate.relative_to(parent)
    except ValueError:
        return False
    return True


def _resolved_temp_roots() -> tuple[Path, ...]:
    candidates = (
        tempfile.gettempdir(),
        os.environ.get("TMPDIR"),
        os.environ.get("TEMP"),
        os.environ.get("TMP"),
        "/tmp",
        "/var/tmp",
        "/private/tmp",
        "/private/var/tmp",
    )
    roots: list[Path] = []
    for raw in candidates:
        if not raw:
            continue
        candidate = Path(raw)
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            resolved = candidate.resolve(strict=False)
        if resolved not in roots:
            roots.append(resolved)
    return tuple(roots)


def _is_ephemeral_output_path(candidate: Path, temp_roots: tuple[Path, ...]) -> bool:
    normalized_parts = [part.casefold() for part in candidate.parts if part not in ("/", "")]
    has_scratch_component = any(
        part in EPHEMERAL_OUTPUT_COMPONENTS
        or any(part.startswith(prefix) for prefix in EPHEMERAL_OUTPUT_PREFIXES)
        for part in normalized_parts
    )
    return has_scratch_component or any(
        _is_within_path(candidate, root) for root in temp_roots
    )


def _resolve_manifest_path(workspace: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise PackagingError(f"project manifest requires nonempty {label}")
    declared = Path(value.strip())
    return declared if declared.is_absolute() else workspace / declared


def _require_persistent_final_output(workspace: Path, manifest: dict[str, Any]) -> Path:
    requested_root = _resolve_manifest_path(
        workspace, manifest.get("finalOutputRoot"), "finalOutputRoot",
    )
    try:
        final_root = requested_root.resolve(strict=True)
    except FileNotFoundError as error:
        raise PackagingError(f"finalOutputRoot does not exist: {requested_root}") from error
    except OSError as error:
        raise PackagingError(f"finalOutputRoot cannot be resolved: {requested_root}: {error}") from error
    if not final_root.is_dir():
        raise PackagingError(f"finalOutputRoot is not a directory: {final_root}")

    temp_roots = _resolved_temp_roots()
    if _is_ephemeral_output_path(final_root, temp_roots):
        raise PackagingError(
            f"finalOutputRoot is an operating-system temporary or tool scratch directory: {final_root}"
        )

    requested_path = _resolve_manifest_path(
        workspace, manifest.get("finalOutputPath"), "finalOutputPath",
    )
    try:
        final_path = requested_path.resolve(strict=True)
    except FileNotFoundError as error:
        raise PackagingError(f"finalOutputPath does not exist: {requested_path}") from error
    except OSError as error:
        raise PackagingError(f"finalOutputPath cannot be resolved: {requested_path}: {error}") from error
    if not final_path.is_file():
        raise PackagingError(f"finalOutputPath is not a regular file: {final_path}")
    try:
        size = final_path.stat().st_size
    except OSError as error:
        raise PackagingError(f"finalOutputPath cannot be inspected: {final_path}: {error}") from error
    if size <= 0:
        raise PackagingError(f"finalOutputPath is empty: {final_path}")
    if _is_ephemeral_output_path(final_path, temp_roots):
        raise PackagingError(
            f"finalOutputPath is inside an operating-system temporary or tool scratch directory: {final_path}"
        )
    if not _is_within_path(final_path, final_root):
        raise PackagingError(
            f"finalOutputPath is outside finalOutputRoot {final_root}: {final_path}"
        )
    return final_path


def _require_gate_hash(gates: dict[str, Any], gate_id: str) -> str:
    value = gates.get(gate_id)
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise PackagingError(
            f"current DELIVERED quality gate {gate_id} must be a canonical sha256 hash"
        )
    return value


def _normalize_approval_reason(reason: str) -> str:
    return ECMASCRIPT_WHITESPACE_RE.sub(
        " ", reason.strip(ECMASCRIPT_WHITESPACE),
    )


def _diff_preview_approval_hash(
    approval: Any,
    *,
    required: bool = False,
) -> str | None:
    if approval is not None and not isinstance(approval, dict):
        raise PackagingError(
            "diff-preview approval requires approvedArtifactHash or notApplicableReason"
        )
    has_hash = isinstance(approval, dict) and "approvedArtifactHash" in approval
    has_reason = isinstance(approval, dict) and "notApplicableReason" in approval
    if has_hash:
        approved_hash = approval["approvedArtifactHash"]
        if not isinstance(approved_hash, str) or not SHA256_PATTERN.fullmatch(approved_hash):
            raise PackagingError(
                "diff-preview approvedArtifactHash must be a lowercase SHA-256 digest"
            )
    if has_reason:
        reason = approval["notApplicableReason"]
        if not isinstance(reason, str) or not reason.strip():
            raise PackagingError("diff-preview notApplicableReason must be a nonempty string")
    if has_hash and has_reason:
        raise PackagingError(
            "diff-preview approval must use approvedArtifactHash or notApplicableReason, not both"
        )
    if has_hash:
        return approval["approvedArtifactHash"]
    if has_reason:
        normalized = _normalize_approval_reason(approval["notApplicableReason"])
        if not normalized:
            raise PackagingError("diff-preview notApplicableReason must be a nonempty string")
        return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    if required or approval is not None:
        raise PackagingError(
            "diff-preview approval requires approvedArtifactHash or notApplicableReason"
        )
    return None


def _resolve_qa_input_path(workspace: Path, qa_report: dict[str, Any], artifact_id: str) -> Path:
    descriptor = qa_report.get("inputArtifacts", {}).get(artifact_id)
    if not isinstance(descriptor, dict):
        raise PackagingError(f"QA input artifact {artifact_id} is missing")
    raw_path = descriptor.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise PackagingError(f"QA input artifact {artifact_id} path is missing")
    declared = Path(raw_path.strip())
    return (declared if declared.is_absolute() else workspace / declared).resolve()


def _validate_prebuild_gate(
    workspace: Path,
    state: dict[str, Any],
    qa_report: dict[str, Any],
    quality_schema: dict[str, Any],
    expected_hash: str,
) -> None:
    evidence_path = workspace / "quality" / "prebuild-evidence.json"
    evidence = _read_json(evidence_path, "current prebuild evidence")
    errors = _validate_schema_value(
        {"$ref": "#/$defs/prebuildEvidence"}, evidence, quality_schema,
    )
    if errors:
        raise PackagingError(
            f"current prebuild evidence schema is invalid: {'; '.join(errors[:8])}"
        )
    if _sha256_path(evidence_path) != expected_hash:
        raise PackagingError("prebuild evidence hash is stale relative to the recorded quality gate")
    if evidence.get("projectId") != state.get("projectId"):
        raise PackagingError("prebuild evidence projectId does not match delivered state")
    for artifact_id in ("slideSpecs", "themeLock"):
        if evidence.get("inputHashes", {}).get(artifact_id) != qa_report.get("inputHashes", {}).get(artifact_id):
            raise PackagingError(f"prebuild evidence {artifact_id} hash is stale")

    route_approvals = (
        ("outline", "visual") if state.get("route") in ("create", "template")
        else ("scope", "diffPreview")
    )
    approval_hashes = evidence.get("approvalHashes")
    if not isinstance(approval_hashes, dict) or set(approval_hashes) != set(route_approvals):
        raise PackagingError("prebuild evidence approval hashes do not match the delivered route")
    approvals = state.get("approvals", {})
    for approval_id in route_approvals:
        recorded = approvals.get(approval_id)
        recorded_hash = (
            _diff_preview_approval_hash(recorded, required=True)
            if approval_id == "diffPreview"
            else recorded.get("approvedArtifactHash") if isinstance(recorded, dict) else None
        )
        if approval_hashes.get(approval_id) != recorded_hash:
            raise PackagingError(f"prebuild evidence {approval_id} approval hash is stale")

    theme_lock_path = _resolve_qa_input_path(workspace, qa_report, "themeLock")
    theme_lock = _read_json(theme_lock_path, "QA theme-lock input")
    font_path_raw = theme_lock.get("fontEvidencePath")
    if not isinstance(font_path_raw, str) or not font_path_raw.strip():
        raise PackagingError("QA theme-lock input requires fontEvidencePath for current prebuild")
    font_path = Path(font_path_raw.strip())
    if not font_path.is_absolute():
        font_path = theme_lock_path.parent / font_path
    if not font_path.is_file() or font_path.stat().st_size <= 0:
        raise PackagingError("current prebuild font evidence is missing or empty")
    if evidence.get("inputHashes", {}).get("fontEvidence") != _sha256_path(font_path):
        raise PackagingError("prebuild font evidence hash is stale")


def _validate_pptx_audit_gate(
    workspace: Path,
    state: dict[str, Any],
    qa_report: dict[str, Any],
    quality_schema: dict[str, Any],
    expected_hash: str,
    deck_hash: str,
) -> None:
    evidence_path = workspace / "quality" / "pptx-audit.json"
    evidence = _read_json(evidence_path, "current PPTX audit evidence")
    errors = _validate_schema_value(
        {"$ref": "#/$defs/automatedEvidenceBundle"}, evidence, quality_schema,
    )
    if errors:
        raise PackagingError(
            f"current PPTX audit evidence schema is invalid: {'; '.join(errors[:8])}"
        )
    if _sha256_path(evidence_path) != expected_hash:
        raise PackagingError("PPTX audit evidence hash is stale relative to the recorded quality gate")
    if expected_hash in state.get("qualityGates", {}).get("invalidatedPptxAuditHashes", []):
        raise PackagingError("PPTX audit evidence hash was invalidated")
    audit_hashes = evidence.get("inputHashes", {})
    for artifact_id in ("deck", "slideSpecs", "themeLock"):
        if audit_hashes.get(artifact_id) != qa_report.get("inputHashes", {}).get(artifact_id):
            raise PackagingError(f"PPTX audit {artifact_id} hash is stale")
    if audit_hashes.get("deck") != deck_hash:
        raise PackagingError("PPTX audit deck hash does not match the delivered deck gate")

    inventory_path = workspace / "object-inventory.json"
    if not inventory_path.is_file() or inventory_path.stat().st_size <= 0:
        raise PackagingError("current PPTX audit object-inventory is missing or empty")
    if audit_hashes.get("objectInventory") != _sha256_path(inventory_path):
        raise PackagingError("PPTX audit object-inventory hash is stale")

    resolved_evidence = evidence_path.resolve()
    binds_current_audit = False
    for descriptor in qa_report.get("automatedChecks", []):
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("evidencePath"), str):
            continue
        declared = Path(descriptor["evidencePath"])
        resolved = (declared if declared.is_absolute() else workspace / declared).resolve()
        if resolved == resolved_evidence and descriptor.get("evidenceSha256") == expected_hash:
            binds_current_audit = True
            break
    if not binds_current_audit:
        raise PackagingError("QA report is not bound to the recorded current PPTX audit gate")


def _require_release_evidence(
    workspace: Path,
    project_schema: dict[str, Any],
    contract: dict[str, Any],
    quality_schema: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not workspace.is_dir():
        raise PackagingError(f"workspace directory does not exist: {workspace}")

    state = _read_json(workspace / "state.json", "approved state")
    manifest = _read_json(workspace / "project-manifest.json", "project manifest")
    for definition, value, label in (
        ("state", state, "approved state"),
        ("projectManifest", manifest, "project manifest"),
    ):
        errors = _validate_schema_value(
            {"$ref": f"#/$defs/{definition}"}, value, project_schema,
        )
        if errors:
            raise PackagingError(
                f"{label} schema is invalid: {'; '.join(errors[:8])}"
            )
    if state.get("status") != "DELIVERED":
        raise PackagingError("approved state must have status DELIVERED")
    current_version = contract["qualityContractVersion"]
    if (
        state.get("qualityContractVersion") != current_version
        or manifest.get("qualityContractVersion") != current_version
    ):
        raise PackagingError(
            "state and project manifest must both use the current quality contract"
        )
    state_gates = state.get("qualityGates")
    manifest_gates = manifest.get("qualityGates")
    if not isinstance(state_gates, dict) or not isinstance(manifest_gates, dict):
        raise PackagingError("state and project manifest must both contain current qualityGates")
    if state_gates != manifest_gates:
        raise PackagingError("state and project manifest qualityGates must match exactly")
    gate_hashes = {
        gate_id: _require_gate_hash(state_gates, gate_id)
        for gate_id in (
            "prebuildEvidenceHash", "pptxAuditHash", "qaReportHash", "deckHash",
        )
    }
    if (
        state.get("projectId") != manifest.get("projectId")
        or state.get("route") != manifest.get("route")
    ):
        raise PackagingError("state and project manifest projectId/route must match")

    approvals = state.get("approvals")
    final_approval = approvals.get("final") if isinstance(approvals, dict) else None
    approved_hash = (
        final_approval.get("approvedArtifactHash")
        if isinstance(final_approval, dict)
        else None
    )
    if not isinstance(approved_hash, str) or not SHA256_PATTERN.fullmatch(approved_hash):
        raise PackagingError("final approval must include a canonical approvedArtifactHash")

    qa_report_path = workspace / "qa-report.json"
    qa_report = _read_json(qa_report_path, "QA report")
    _require_current_qa_report(qa_report, project_schema)
    if qa_report.get("finalVerdict") != "PASS":
        raise PackagingError("QA report finalVerdict must be PASS")
    if qa_report.get("projectId") != state.get("projectId"):
        raise PackagingError("QA report projectId must match delivered state")
    if qa_report.get("route") != state.get("route"):
        raise PackagingError("QA report route must match delivered state")
    _run_current_qa_preflight(workspace, qa_report_path)
    qa_report_hash = _sha256_path(qa_report_path)
    if (
        gate_hashes["qaReportHash"] != qa_report_hash
        or manifest_gates.get("qaReportHash") != qa_report_hash
    ):
        raise PackagingError("QA report hash is stale or does not match the reviewed quality gate")
    invalidated = state_gates.get("invalidatedQaReportHashes", [])
    if isinstance(invalidated, list) and qa_report_hash in invalidated:
        raise PackagingError("QA report hash was invalidated and cannot authorize packaging")

    deck_hash = gate_hashes["deckHash"]
    qa_deck_hash = qa_report.get("inputHashes", {}).get("deck")
    qa_deck_descriptor_hash = qa_report.get("inputArtifacts", {}).get("deck", {}).get("sha256")
    if qa_deck_hash != deck_hash or qa_deck_descriptor_hash != deck_hash:
        raise PackagingError("QA deck hash does not match the delivered deck quality gate")
    if approved_hash != deck_hash:
        raise PackagingError("final approval hash does not match the delivered deck quality gate")

    final_output_path = _require_persistent_final_output(workspace, manifest)
    if _sha256_path(final_output_path) != deck_hash:
        raise PackagingError("persistent finalOutputPath hash does not match the delivered deck gate")

    _validate_prebuild_gate(
        workspace,
        state,
        qa_report,
        quality_schema,
        gate_hashes["prebuildEvidenceHash"],
    )
    _validate_pptx_audit_gate(
        workspace,
        state,
        qa_report,
        quality_schema,
        gate_hashes["pptxAuditHash"],
        deck_hash,
    )
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


def _safe_relationship_target(source_member: str, target: str) -> str | None:
    if not isinstance(target, str) or not target or "\\" in target:
        return None
    if ":" in target.split("/", 1)[0] or target.startswith("//"):
        return None
    candidate = target.lstrip("/") if target.startswith("/") else posixpath.join(
        posixpath.dirname(source_member), target,
    )
    candidate = posixpath.normpath(candidate)
    if candidate in {"", ".", ".."} or candidate.startswith("../"):
        return None
    return candidate


def _pptx_metadata(path: Path) -> tuple[int, int, int]:
    try:
        with ZipFile(path) as archive:
            members = validate_zip_archive(archive, "PPTX")
            required = {
                "[Content_Types].xml", "ppt/presentation.xml",
                "ppt/_rels/presentation.xml.rels",
            }
            if not required.issubset(members):
                missing = ", ".join(sorted(required - set(members)))
                raise PackagingError(f"invalid PPTX package; missing {missing}")
            content_types = read_zip_member(
                archive, "[Content_Types].xml", "PPTX", members,
            )
            ET.fromstring(content_types)
            presentation = ET.fromstring(read_zip_member(
                archive, "ppt/presentation.xml", "PPTX", members,
            ))
            relationships = ET.fromstring(read_zip_member(
                archive, "ppt/_rels/presentation.xml.rels", "PPTX", members,
            ))
            targets: dict[str, str] = {}
            seen_relationship_ids: set[str] = set()
            for relationship in list(relationships):
                if relationship.tag.rsplit("}", 1)[-1] != "Relationship":
                    continue
                relationship_id = relationship.get("Id")
                if not relationship_id or relationship_id in seen_relationship_ids:
                    raise PackagingError("invalid PPTX presentation relationship Id")
                seen_relationship_ids.add(relationship_id)
                relationship_type = relationship.get("Type", "")
                if relationship_type not in SLIDE_RELATIONSHIP_TYPES:
                    if relationship_type.endswith("/slide"):
                        raise PackagingError("unsupported PPTX slide relationship type")
                    continue
                if relationship.get("TargetMode") not in {None, "Internal"}:
                    raise PackagingError("PPTX slide relationships must be internal")
                member = _safe_relationship_target(
                    "ppt/presentation.xml", relationship.get("Target", ""),
                )
                if member is None or member not in members:
                    raise PackagingError("unresolved PPTX slide relationship target")
                targets[relationship_id] = member
            slide_id_list = next(
                (
                    child for child in list(presentation)
                    if child.tag.rsplit("}", 1)[-1] == "sldIdLst"
                ),
                None,
            )
            slides = []
            if slide_id_list is not None:
                for slide_id in list(slide_id_list):
                    if slide_id.tag.rsplit("}", 1)[-1] != "sldId":
                        continue
                    relationship_id = next(
                        (slide_id.get(qname) for qname in RELATIONSHIP_ID_QNAMES if slide_id.get(qname)),
                        None,
                    )
                    member = targets.get(relationship_id)
                    if member is None:
                        raise PackagingError(
                            f"unresolved displayed PPTX slide relationship: {relationship_id}"
                        )
                    slides.append(member)
            if not slides:
                raise PackagingError("invalid PPTX package; no displayed slide relationships")
            if len(slides) != len(set(slides)):
                raise PackagingError("displayed PPTX slide relationships must be unique")
            for slide in slides:
                payload = read_zip_member(archive, slide, "PPTX", members).lstrip()
                if not payload.startswith(b"<"):
                    raise PackagingError(f"invalid PPTX slide XML: {slide}")
                ET.fromstring(payload)
            slide_size = next(
                (
                    child for child in list(presentation)
                    if child.tag.rsplit("}", 1)[-1] == "sldSz"
                ),
                None,
            )
            if slide_size is None:
                raise PackagingError("invalid PPTX package; missing slide canvas")
            try:
                canvas_width = int(slide_size.get("cx", "0"))
                canvas_height = int(slide_size.get("cy", "0"))
            except ValueError as error:
                raise PackagingError("invalid PPTX slide canvas dimensions") from error
            if canvas_width < 1 or canvas_height < 1:
                raise PackagingError("invalid PPTX slide canvas dimensions")
            return len(slides), canvas_width, canvas_height
    except (BadZipFile, OSError, ValueError, ET.ParseError) as error:
        if isinstance(error, PackagingError):
            raise
        raise PackagingError(f"invalid PPTX: {path}: {error}") from error


PDF_MAX_BYTES = 128 * 1024 * 1024


class _PdfValueParser:
    """Minimal structural parser for PDF dictionaries, arrays, names, numbers, and refs."""

    def __init__(self, payload: bytes, offset: int = 0):
        self.payload = payload
        self.offset = offset

    def _skip_space(self) -> None:
        while self.offset < len(self.payload):
            byte = self.payload[self.offset]
            if byte in b"\x00\t\n\x0c\r ":
                self.offset += 1
                continue
            if byte == ord("%"):
                newline = self.payload.find(b"\n", self.offset)
                self.offset = len(self.payload) if newline < 0 else newline + 1
                continue
            break

    def _word(self) -> bytes:
        self._skip_space()
        start = self.offset
        delimiters = b"\x00\t\n\x0c\r ()<>[]{}/%"
        while self.offset < len(self.payload) and self.payload[self.offset] not in delimiters:
            self.offset += 1
        if self.offset == start:
            raise PackagingError("invalid PDF token")
        return self.payload[start:self.offset]

    def _name(self) -> str:
        if self.payload[self.offset:self.offset + 1] != b"/":
            raise PackagingError("invalid PDF name")
        self.offset += 1
        raw = self._word()
        try:
            return raw.decode("ascii")
        except UnicodeDecodeError as error:
            raise PackagingError("non-ASCII PDF structural name") from error

    def _literal_string(self) -> bytes:
        self.offset += 1
        depth = 1
        output = bytearray()
        while self.offset < len(self.payload) and depth:
            byte = self.payload[self.offset]
            self.offset += 1
            if byte == ord("\\"):
                if self.offset < len(self.payload):
                    output.append(self.payload[self.offset])
                    self.offset += 1
            elif byte == ord("("):
                depth += 1
                output.append(byte)
            elif byte == ord(")"):
                depth -= 1
                if depth:
                    output.append(byte)
            else:
                output.append(byte)
        if depth:
            raise PackagingError("unterminated PDF string")
        return bytes(output)

    def parse(self) -> Any:
        self._skip_space()
        marker = self.payload[self.offset:self.offset + 2]
        if marker == b"<<":
            self.offset += 2
            value: dict[str, Any] = {}
            while True:
                self._skip_space()
                if self.payload[self.offset:self.offset + 2] == b">>":
                    self.offset += 2
                    return value
                key = self._name()
                if key in value:
                    raise PackagingError(f"duplicate PDF dictionary key: {key}")
                value[key] = self.parse()
        if marker[:1] == b"[":
            self.offset += 1
            values = []
            while True:
                self._skip_space()
                if self.payload[self.offset:self.offset + 1] == b"]":
                    self.offset += 1
                    return values
                values.append(self.parse())
        if marker[:1] == b"/":
            return ("name", self._name())
        if marker[:1] == b"(":
            return self._literal_string()
        if marker[:1] == b"<":
            end = self.payload.find(b">", self.offset + 1)
            if end < 0:
                raise PackagingError("unterminated PDF hex string")
            raw = self.payload[self.offset + 1:end]
            self.offset = end + 1
            return raw
        word = self._word()
        if re.fullmatch(rb"[+-]?\d+", word):
            first = int(word)
            saved = self.offset
            try:
                second_word = self._word()
                if re.fullmatch(rb"\d+", second_word):
                    second = int(second_word)
                    third = self._word()
                    if third == b"R":
                        return ("ref", first, second)
            except PackagingError:
                pass
            self.offset = saved
            return first
        if re.fullmatch(rb"[+-]?(?:\d+\.\d*|\.\d+)", word):
            return float(word)
        if word == b"true":
            return True
        if word == b"false":
            return False
        if word == b"null":
            return None
        raise PackagingError(f"unsupported PDF structural token: {word[:32]!r}")


def _pdf_name(value: Any) -> str | None:
    return value[1] if isinstance(value, tuple) and len(value) == 2 and value[0] == "name" else None


def _pdf_ref(value: Any, label: str) -> tuple[int, int]:
    if not (
        isinstance(value, tuple) and len(value) == 3 and value[0] == "ref"
        and isinstance(value[1], int) and isinstance(value[2], int)
    ):
        raise PackagingError(f"invalid PDF {label} reference")
    return value[1], value[2]


def _pdf_classic_xref(payload: bytes) -> tuple[dict[tuple[int, int], int], dict[str, Any]]:
    markers = list(re.finditer(rb"startxref\s+(\d+)\s+%%EOF", payload[-65536:]))
    if not markers:
        raise PackagingError("invalid PDF startxref trailer")
    xref_offset = int(markers[-1].group(1))
    if xref_offset < 0 or xref_offset >= len(payload) or payload[xref_offset:xref_offset + 4] != b"xref":
        raise PackagingError("unsupported PDF xref stream or invalid xref offset")
    cursor = xref_offset + 4
    offsets: dict[tuple[int, int], int] = {}
    while True:
        while cursor < len(payload) and payload[cursor] in b"\x00\t\n\x0c\r ":
            cursor += 1
        if payload[cursor:cursor + 7] == b"trailer":
            cursor += 7
            trailer_parser = _PdfValueParser(payload, cursor)
            trailer = trailer_parser.parse()
            if not isinstance(trailer, dict):
                raise PackagingError("invalid PDF trailer dictionary")
            return offsets, trailer
        header = re.match(rb"(\d+)\s+(\d+)", payload[cursor:])
        if header is None:
            raise PackagingError("invalid PDF xref subsection")
        first = int(header.group(1))
        count = int(header.group(2))
        if count < 1 or count > 1_000_000:
            raise PackagingError("invalid PDF xref subsection count")
        cursor += header.end()
        for index in range(count):
            while cursor < len(payload) and payload[cursor] in b"\r\n":
                cursor += 1
            entry = re.match(rb"(\d{10})\s(\d{5})\s([nf])(?:\s|\r|\n)", payload[cursor:])
            if entry is None:
                raise PackagingError("invalid PDF xref entry")
            object_offset = int(entry.group(1))
            generation = int(entry.group(2))
            cursor += entry.end()
            if entry.group(3) == b"n":
                key = (first + index, generation)
                if key in offsets:
                    raise PackagingError("duplicate PDF xref object")
                offsets[key] = object_offset


def _pdf_page_count(path: Path) -> int:
    try:
        with path.open("rb") as source:
            payload = source.read(PDF_MAX_BYTES + 1)
    except OSError as error:
        raise PackagingError(f"invalid PDF: {path}: {error}") from error
    if len(payload) > PDF_MAX_BYTES:
        raise PackagingError(f"invalid PDF; file exceeds {PDF_MAX_BYTES} bytes: {path}")
    if not payload.startswith(b"%PDF-") or b"%%EOF" not in payload[-2048:]:
        raise PackagingError(f"invalid PDF header or trailer: {path}")
    offsets, trailer = _pdf_classic_xref(payload)

    cache: dict[tuple[int, int], dict[str, Any]] = {}

    def load_object(reference: tuple[int, int]) -> dict[str, Any]:
        if reference in cache:
            return cache[reference]
        offset = offsets.get(reference)
        if offset is None or offset < 0 or offset >= len(payload):
            raise PackagingError(f"PDF xref is missing object {reference[0]} {reference[1]}")
        header = re.match(rb"(\d+)\s+(\d+)\s+obj\b", payload[offset:])
        if header is None or (int(header.group(1)), int(header.group(2))) != reference:
            raise PackagingError("PDF xref object header mismatch")
        parser = _PdfValueParser(payload, offset + header.end())
        value = parser.parse()
        if not isinstance(value, dict):
            raise PackagingError(f"PDF object {reference[0]} is not a dictionary")
        cache[reference] = value
        return value

    root = load_object(_pdf_ref(trailer.get("Root"), "catalog"))
    if _pdf_name(root.get("Type")) != "Catalog":
        raise PackagingError("invalid PDF catalog")
    pages_reference = _pdf_ref(root.get("Pages"), "page tree root")
    visited: set[tuple[int, int]] = set()
    page_leaves: set[tuple[int, int]] = set()

    def walk(reference: tuple[int, int]) -> int:
        if reference in visited:
            raise PackagingError("invalid PDF page tree cycle or duplicate kid")
        visited.add(reference)
        node = load_object(reference)
        node_type = _pdf_name(node.get("Type"))
        if node_type == "Page":
            page_leaves.add(reference)
            return 1
        if node_type != "Pages":
            raise PackagingError("invalid PDF page tree node type")
        kids = node.get("Kids")
        declared_count = node.get("Count")
        if not isinstance(kids, list) or not kids:
            raise PackagingError("invalid PDF page tree Kids")
        if not isinstance(declared_count, int) or isinstance(declared_count, bool) or declared_count < 1:
            raise PackagingError("invalid PDF page tree Count")
        actual_count = sum(walk(_pdf_ref(kid, "page tree kid")) for kid in kids)
        if actual_count != declared_count:
            raise PackagingError(
                f"PDF page tree Count mismatch: declared {declared_count}, actual {actual_count}"
            )
        return actual_count

    page_count = walk(pages_reference)
    if page_count < 1 or page_count != len(page_leaves):
        raise PackagingError("invalid PDF page tree page count")
    return page_count


def _validate_png(path: Path) -> tuple[int, int]:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise PackagingError(f"invalid PNG preview {path}: {error}") from error
    signature = b"\x89PNG\r\n\x1a\n"
    if len(payload) < 45 or not payload.startswith(signature):
        raise PackagingError(f"invalid PNG preview: {path}")
    offset = len(signature)
    width = height = 0
    channels = 0
    saw_ihdr = False
    saw_iend = False
    saw_plte = False
    idat_ended = False
    idat_chunks = []
    while offset + 12 <= len(payload):
        length = struct.unpack(">I", payload[offset:offset + 4])[0]
        kind_bytes = payload[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(payload):
            raise PackagingError(f"invalid truncated PNG chunk: {path}")
        if any(
            not (0x41 <= byte <= 0x5A or 0x61 <= byte <= 0x7A)
            for byte in kind_bytes
        ):
            raise PackagingError(f"invalid PNG chunk type: {path}")
        kind = kind_bytes.decode("ascii")
        chunk_body = payload[offset + 4:offset + 8 + length]
        expected_crc = struct.unpack(">I", payload[offset + 8 + length:end])[0]
        if zlib.crc32(chunk_body) != expected_crc:
            raise PackagingError(f"invalid PNG {kind} CRC: {path}")
        if not saw_ihdr:
            if kind != "IHDR" or length != 13:
                raise PackagingError(f"invalid PNG IHDR: {path}")
            width, height = struct.unpack(">II", payload[offset + 8:offset + 16])
            if width < 1 or height < 1:
                raise PackagingError(f"invalid PNG dimensions: {path}")
            bit_depth, color_type, compression, filter_method, interlace = payload[
                offset + 16:offset + 21
            ]
            if (
                bit_depth != 8
                or color_type not in {2, 6}
                or compression != 0
                or filter_method != 0
                or interlace != 0
            ):
                raise PackagingError(
                    f"PNG IHDR must be non-interlaced 8-bit RGB or RGBA: {path}"
                )
            channels = 3 if color_type == 2 else 4
            saw_ihdr = True
        elif kind == "IHDR":
            raise PackagingError(f"PNG must contain exactly one IHDR chunk: {path}")
        if kind == "PLTE":
            if saw_plte or idat_chunks:
                raise PackagingError(f"invalid PNG PLTE chunk order: {path}")
            saw_plte = True
        if kind == "IDAT":
            if idat_ended:
                raise PackagingError(f"PNG IDAT chunks must be consecutive: {path}")
            idat_chunks.append(payload[offset + 8:offset + 8 + length])
        elif idat_chunks and kind != "IEND":
            idat_ended = True
        if (
            kind not in {"IHDR", "PLTE", "IDAT", "IEND"}
            and kind[0].isupper()
        ):
            raise PackagingError(f"unsupported critical PNG chunk {kind}: {path}")
        if kind == "IEND":
            if not idat_chunks:
                raise PackagingError(f"PNG must contain at least one IDAT chunk: {path}")
            if length != 0 or end != len(payload):
                raise PackagingError(f"invalid PNG IEND trailer: {path}")
            saw_iend = True
            break
        offset = end
    if not saw_ihdr or not idat_chunks or not saw_iend:
        raise PackagingError(f"invalid PNG data or trailer: {path}")
    row_length = 1 + (width * channels)
    expected_length = height * row_length
    if expected_length < 1 or expected_length > sys.maxsize:
        raise PackagingError(f"PNG scanline size cannot be safely validated: {path}")
    decompressor = zlib.decompressobj()
    try:
        scanlines = decompressor.decompress(
            b"".join(idat_chunks), expected_length + 1
        )
        if len(scanlines) > expected_length or decompressor.unconsumed_tail:
            raise PackagingError(f"PNG scanline length exceeds expected size: {path}")
        scanlines += decompressor.flush(expected_length + 1 - len(scanlines))
    except zlib.error as error:
        raise PackagingError(f"PNG IDAT zlib decompression failed: {path}: {error}") from error
    if not decompressor.eof or decompressor.unused_data:
        raise PackagingError(f"PNG IDAT zlib stream is incomplete or has trailing data: {path}")
    if len(scanlines) != expected_length:
        raise PackagingError(
            f"PNG scanline length mismatch: expected {expected_length}, "
            f"received {len(scanlines)}: {path}"
        )
    for row in range(height):
        filter_byte = scanlines[row * row_length]
        if filter_byte > 4:
            raise PackagingError(f"invalid PNG scanline filter byte {filter_byte}: {path}")
    return width, height


def _resolve_evidence_path(workspace: Path, declared: Any, label: str) -> Path:
    if not isinstance(declared, str) or not declared.strip():
        raise PackagingError(f"{label} path is missing")
    candidate = Path(declared.strip())
    return candidate.resolve() if candidate.is_absolute() else (workspace / candidate).resolve()


def _require_nonempty_evidence(workspace: Path, declared: Any, label: str) -> Path:
    evidence = _resolve_evidence_path(workspace, declared, label)
    if not evidence.is_file() or evidence.stat().st_size <= 0:
        raise PackagingError(f"{label} file is missing or empty: {evidence}")
    return evidence


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _validate_check_payload(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PackagingError(f"{label} must be an object")
    _require_exact_keys(value, {"status", "value", "violations"}, label)
    if value.get("status") not in {"PASS", "FAIL"}:
        raise PackagingError(f"{label} status is invalid")
    check_value = value.get("value")
    if not _is_json_integer(check_value) or check_value < 0:
        raise PackagingError(f"{label} value must be a nonnegative integer")
    violations = value.get("violations")
    if not isinstance(violations, list) or any(not isinstance(item, dict) for item in violations):
        raise PackagingError(f"{label} violations must be an array of objects")
    return value


def _validate_timestamp(value: Any, label: str) -> None:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        raise PackagingError(f"{label} generatedAt is invalid")


def _materialize_input_artifacts(
    qa_report: dict[str, Any], workspace: Path, delivered_pptx: Path
) -> tuple[dict[str, str], dict[str, Path]]:
    descriptors = qa_report.get("inputArtifacts")
    if not isinstance(descriptors, dict):
        raise PackagingError("QA inputArtifacts are required for structured evidence")
    compatibility_hashes = qa_report.get("inputHashes")
    if not isinstance(compatibility_hashes, dict):
        raise PackagingError("QA inputHashes are required for structured evidence")
    actual_hashes: dict[str, str] = {}
    resolved_paths: dict[str, Path] = {}
    for artifact_id in ("deck", "slideSpecs", "themeLock"):
        descriptor = descriptors.get(artifact_id)
        if not isinstance(descriptor, dict):
            raise PackagingError(f"QA input artifact descriptor is missing: {artifact_id}")
        _require_exact_keys(descriptor, {"path", "sha256"}, f"QA input artifact {artifact_id}")
        artifact = _require_nonempty_evidence(
            workspace, descriptor.get("path"), f"QA input artifact {artifact_id}"
        )
        actual_hash = _sha256_path(artifact)
        declared_hash = descriptor.get("sha256")
        if not isinstance(declared_hash, str) or not SHA256_PATTERN.fullmatch(declared_hash):
            raise PackagingError(f"QA input artifact hash is missing: {artifact_id}")
        if declared_hash != actual_hash:
            raise PackagingError(f"QA input artifact {artifact_id} hash is stale")
        if compatibility_hashes.get(artifact_id) != actual_hash:
            raise PackagingError(f"QA inputHashes {artifact_id} hash is stale")
        actual_hashes[artifact_id] = actual_hash
        resolved_paths[artifact_id] = artifact
    if actual_hashes["deck"] != _sha256_path(delivered_pptx):
        raise PackagingError("QA deck input bytes do not match delivered PPTX")
    return actual_hashes, resolved_paths


def _structured_check(
    workspace: Path,
    report_check: dict[str, Any],
    check_id: str,
    expected_hashes: dict[str, str],
    contract: dict[str, Any],
    quality_schema: dict[str, Any],
) -> dict[str, Any]:
    evidence = _require_nonempty_evidence(
        workspace, report_check.get("evidencePath"), f"QA structured evidence for {check_id}"
    )
    expected_evidence_hash = report_check.get("evidenceSha256")
    if not isinstance(expected_evidence_hash, str) or _sha256_path(evidence) != expected_evidence_hash:
        raise PackagingError(f"QA structured evidence hash is missing or stale: {check_id}")
    try:
        payload = _strict_json_loads(evidence.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise PackagingError(f"QA structured evidence must be JSON: {check_id}: {error}") from error
    if not isinstance(payload, dict):
        raise PackagingError(f"QA structured evidence is incomplete: {check_id}")
    definitions = quality_schema["$defs"]
    bundle_schema = definitions["automatedEvidenceBundle"]
    generic_schema = definitions["perCheckEvidence"]
    ooxml_check_ids = bundle_schema["properties"]["checks"]["required"]
    is_ooxml = check_id in ooxml_check_ids
    expected_top_level = {
        "artifactType", "schemaVersion", "qualityContractVersion", "checker",
        "inputHashes", "checks", "finalVerdict", "generatedAt",
    } if is_ooxml else {
        "artifactType", "schemaVersion", "qualityContractVersion", "checker",
        "checkId", "inputHashes", "check", "finalVerdict", "generatedAt",
    }
    _require_exact_keys(payload, expected_top_level, f"QA structured evidence {check_id}")
    selected_schema = bundle_schema if is_ooxml else generic_schema
    properties = selected_schema["properties"]
    if payload.get("artifactType") != properties["artifactType"]["const"]:
        raise PackagingError(f"QA structured evidence artifact type is invalid: {check_id}")
    schema_version = properties["schemaVersion"]["const"]
    if payload.get("schemaVersion") != schema_version:
        raise PackagingError(f"QA structured evidence schema version is invalid: {check_id}")
    contract_version = payload.get("qualityContractVersion")
    schema_contract_version = properties["qualityContractVersion"]["const"]
    if (
        contract_version != schema_contract_version
        or contract_version != contract["qualityContractVersion"]
    ):
        raise PackagingError(f"QA structured evidence contract version is stale: {check_id}")
    checker = payload.get("checker")
    if not isinstance(checker, dict):
        raise PackagingError(f"QA structured evidence checker is missing: {check_id}")
    _require_exact_keys(checker, {"id", "version"}, f"QA structured evidence checker {check_id}")
    if is_ooxml:
        checker_schema = properties["checker"]["properties"]
        if (
            checker.get("id") != checker_schema["id"]["const"]
            or checker.get("version") != checker_schema["version"]["const"]
        ):
            raise PackagingError(f"QA structured evidence checker is invalid: {check_id}")
    else:
        if checker.get("id") != check_id:
            raise PackagingError(f"QA structured evidence checker ID mismatch: {check_id}")
        checker_version = checker.get("version")
        if (
            not isinstance(checker_version, str)
            or not VERSION_PATTERN.fullmatch(checker_version)
            or checker_version != schema_version
        ):
            raise PackagingError(f"QA structured evidence checker version mismatch: {check_id}")
        if payload.get("checkId") != check_id:
            raise PackagingError(f"QA structured evidence checkId mismatch: {check_id}")
    if payload.get("finalVerdict") != "PASS":
        raise PackagingError(f"QA structured evidence final verdict must PASS: {check_id}")
    _validate_timestamp(payload.get("generatedAt"), f"QA structured evidence {check_id}")
    evidence_hashes = payload.get("inputHashes")
    if not isinstance(evidence_hashes, dict):
        raise PackagingError(f"QA structured evidence input hashes are missing: {check_id}")
    expected_input_ids = {"deck", "slideSpecs", "themeLock", "objectInventory"} if is_ooxml else {
        "deck", "slideSpecs", "themeLock"
    }
    _require_exact_keys(evidence_hashes, expected_input_ids, f"QA structured evidence inputHashes {check_id}")
    for artifact_id, artifact_hash in evidence_hashes.items():
        if not isinstance(artifact_hash, str) or not SHA256_PATTERN.fullmatch(artifact_hash):
            raise PackagingError(f"QA structured evidence input hash is invalid: {check_id} {artifact_id}")
    for artifact_id, expected_hash in expected_hashes.items():
        if evidence_hashes.get(artifact_id) != expected_hash:
            raise PackagingError(
                f"QA structured evidence input mismatch for {artifact_id} hash: {check_id}"
            )
    if is_ooxml:
        nested = payload.get("checks")
        if not isinstance(nested, dict):
            raise PackagingError(f"QA structured evidence checks are missing: {check_id}")
        _require_exact_keys(nested, set(ooxml_check_ids), f"QA structured evidence checks {check_id}")
        for nested_id, nested_check in nested.items():
            _validate_check_payload(nested_check, f"QA structured evidence check {nested_id}")
        evidence_check = nested[check_id]
    else:
        evidence_check = _validate_check_payload(
            payload.get("check"), f"QA structured evidence check {check_id}"
        )
    if evidence_check.get("status") != report_check.get("status"):
        raise PackagingError(f"QA structured evidence status is stale: {check_id}")
    if "value" in report_check and evidence_check.get("value") != report_check.get("value"):
        raise PackagingError(f"QA structured evidence value is stale: {check_id}")
    return evidence_check


def _validate_full_slide_records(
    records: list[Any],
    label: str,
    slide_count: int,
    workspace: Path,
    previews: dict[int, Path],
) -> None:
    seen_paths: set[Path] = set()
    for item in records:
        if not isinstance(item, dict):
            raise PackagingError(f"QA {label} record must be an object")
        slide = item.get("slide")
        if not _is_json_integer(slide) or not 1 <= slide <= slide_count:
            raise PackagingError(f"QA {label} slide is invalid: {slide}")
        evidence = _require_nonempty_evidence(
            workspace, item.get("evidencePath"), f"QA {label} evidence for slide {slide}"
        )
        expected_name = f"slide-{slide}.png"
        if evidence.name != expected_name:
            raise PackagingError(f"QA {label} evidence must map slide {slide} to {expected_name}")
        if evidence in seen_paths:
            raise PackagingError(f"QA {label} evidence paths must be unique; reused {evidence}")
        seen_paths.add(evidence)
        width, height = _validate_png(evidence)
        evidence_hash = _sha256_path(evidence)
        if item.get("evidenceSha256") != evidence_hash:
            raise PackagingError(f"QA {label} evidence hash is missing or stale: slide {slide}")
        reported_width = item.get("width")
        reported_height = item.get("height")
        if (
            not _is_json_integer(reported_width)
            or not _is_json_integer(reported_height)
            or reported_width != width
            or reported_height != height
        ):
            raise PackagingError(f"QA {label} evidence dimensions are stale: slide {slide}")
        preview = previews[slide]
        if evidence.read_bytes() != preview.read_bytes():
            raise PackagingError(f"QA {label} evidence is not bound to delivery preview: slide {slide}")


def _validate_qa_evidence(
    qa_report: dict[str, Any],
    slide_count: int,
    workspace: Path,
    state: dict[str, Any],
    contract: dict[str, Any],
    quality_schema: dict[str, Any],
    delivered_pptx: Path,
    previews: dict[int, Path],
) -> None:
    if qa_report.get("qualityContractVersion") != contract["qualityContractVersion"]:
        raise PackagingError("QA quality contract version is missing or stale")
    expected_hashes, input_paths = _materialize_input_artifacts(
        qa_report, workspace, delivered_pptx,
    )
    try:
        theme_lock = _strict_json_loads(input_paths["themeLock"].read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise PackagingError(f"QA theme-lock input must be valid JSON: {error}") from error
    if not isinstance(theme_lock, dict) or not isinstance(theme_lock.get("targetClient"), str):
        raise PackagingError("QA theme-lock targetClient is missing")
    expected_target_client = theme_lock["targetClient"].strip()
    canonical_target_clients = quality_schema["$defs"]["targetClient"]["enum"]
    if expected_target_client not in canonical_target_clients:
        raise PackagingError("QA theme-lock targetClient must be canonical")

    checks = qa_report.get("automatedChecks")
    if not isinstance(checks, list):
        raise PackagingError("QA report automatedChecks must be an array")
    by_id: dict[str, dict[str, Any]] = {}
    for item in checks:
        check_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(check_id, str) or not check_id:
            raise PackagingError("QA automated check ID is missing")
        if check_id in by_id:
            raise PackagingError(f"duplicate QA automated check ID: {check_id}")
        by_id[check_id] = item
    required = set(contract["requiredAutomatedChecks"])
    if state.get("route") == "edit":
        required.update(contract["editRequiredChecks"])
    hard_zero = set(contract["hardZeroChecks"])
    actual = set(by_id)
    if actual != required:
        missing = required - actual
        unexpected = actual - required
        raise PackagingError(
            "QA automated check IDs must match the exact contract set; "
            f"missing: {', '.join(sorted(missing)) or 'none'}; "
            f"unexpected: {', '.join(sorted(unexpected)) or 'none'}"
        )
    for check_id in sorted(actual):
        check = by_id[check_id]
        if check.get("status") != "PASS":
            raise PackagingError(f"QA automated check must PASS: {check_id}")
        evidence_check = _structured_check(
            workspace, check, check_id, expected_hashes, contract, quality_schema
        )
        if check_id in hard_zero and (check.get("value") != 0 or evidence_check.get("value") != 0):
            raise PackagingError(f"QA hard-zero check must be 0: {check_id}")

    expected_slides = list(range(1, slide_count + 1))
    review = qa_report.get("reviewChecks")
    if not isinstance(review, list):
        raise PackagingError("QA per-slide review checks are required")
    review_slides = [item.get("slide") for item in review if isinstance(item, dict)]
    if sorted(review_slides) != expected_slides or len(review_slides) != len(set(review_slides)):
        raise PackagingError(
            f"QA review slide coverage must be continuous 1-{slide_count}; received {review_slides}"
        )
    required_review = set(contract["requiredReviewChecks"])
    for item in review:
        checks_by_id = item.get("checks")
        if not isinstance(checks_by_id, dict):
            raise PackagingError(f"QA review checks are missing for slide {item.get('slide')}")
        actual_review = set(checks_by_id)
        if actual_review != required_review:
            missing_review = required_review - actual_review
            unexpected_review = actual_review - required_review
            raise PackagingError(
                f"QA review checks must match the exact set for slide {item.get('slide')}; "
                f"missing: {', '.join(sorted(missing_review)) or 'none'}; "
                f"unexpected: {', '.join(sorted(unexpected_review)) or 'none'}"
            )
        for review_id in required_review:
            review_check = checks_by_id[review_id]
            if not isinstance(review_check, dict) or review_check.get("status") != "PASS":
                raise PackagingError(f"QA review check must PASS: slide {item.get('slide')} {review_id}")
            if not isinstance(review_check.get("notes"), str) or not review_check["notes"].strip():
                raise PackagingError(f"QA review check notes are missing: slide {item.get('slide')} {review_id}")
    _validate_full_slide_records(review, "full-slide review", slide_count, workspace, previews)

    manual = qa_report.get("perSlideManualScores")
    if not isinstance(manual, list):
        raise PackagingError("QA manual scores must be an array")
    manual_slides = [item.get("slide") for item in manual if isinstance(item, dict)]
    if sorted(manual_slides) != expected_slides or len(manual_slides) != len(set(manual_slides)):
        raise PackagingError(
            f"QA manual slide coverage must be continuous 1-{slide_count}; received {manual_slides}"
        )
    required_dimensions = set(contract["requiredManualDimensions"])
    minimum_score = contract["minimumManualScore"]
    for item in manual:
        dimensions = item.get("dimensions")
        if not isinstance(dimensions, dict) or required_dimensions - set(dimensions):
            raise PackagingError(f"QA manual dimensions are incomplete for slide {item.get('slide')}")
        for dimension in required_dimensions:
            score = dimensions.get(dimension)
            if not _is_json_integer(score) or score < minimum_score or score > 5:
                raise PackagingError(f"QA manual score is below contract: slide {item.get('slide')} {dimension}")
        if any(dimensions[dimension] == minimum_score for dimension in required_dimensions):
            if not isinstance(item.get("notes"), str) or not item["notes"].strip():
                raise PackagingError(f"QA score 4 requires a page-level note: slide {item.get('slide')}")
    _validate_full_slide_records(manual, "manual", slide_count, workspace, previews)

    client_smoke = qa_report.get("clientSmoke")
    if not isinstance(client_smoke, dict):
        raise PackagingError("QA client smoke evidence is missing")
    status = client_smoke.get("status")
    evidence_path = _require_nonempty_evidence(
        workspace, client_smoke.get("evidencePath"), "QA client smoke evidence"
    )
    declared_evidence_hash = client_smoke.get("evidenceSha256")
    if (
        not isinstance(declared_evidence_hash, str)
        or not SHA256_PATTERN.fullmatch(declared_evidence_hash)
        or _sha256_path(evidence_path) != declared_evidence_hash
    ):
        raise PackagingError("QA client smoke evidence hash is missing or stale")
    if status == "not_available":
        _require_exact_keys(
            client_smoke,
            {
                "status", "evidencePath", "evidenceSha256", "userFinalOpenConfirmation",
                "targetClient", "openedArtifactHash",
            },
            "QA client smoke not_available",
        )
        if (
            qa_report.get("clientSmokeStatus") != "NOT_RUN"
            or client_smoke.get("userFinalOpenConfirmation") is not True
        ):
            raise PackagingError(
                "QA client smoke not_available requires NOT_RUN and user final-open confirmation"
            )
        try:
            evidence = _strict_json_loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            raise PackagingError(
                f"QA user-open confirmation evidence must be structured JSON: {error}"
            ) from error
        schema = quality_schema["$defs"]["userOpenConfirmationEvidence"]
        _require_exact_keys(
            evidence, set(schema["required"]), "QA user-open confirmation evidence",
        )
        properties = schema["properties"]
        if (
            evidence.get("artifactType") != properties["artifactType"]["const"]
            or evidence.get("schemaVersion") != properties["schemaVersion"]["const"]
            or evidence.get("targetClient") not in canonical_target_clients
            or not isinstance(evidence.get("userMessage"), str)
            or not evidence["userMessage"].strip()
        ):
            raise PackagingError("QA user-open confirmation evidence schema is invalid")
        _validate_timestamp(evidence.get("confirmedAt"), "QA user-open confirmation confirmedAt")
        if evidence.get("openedArtifactHash") != expected_hashes["deck"]:
            raise PackagingError("QA user-open confirmation opened artifact hash is stale")
        if (
            evidence.get("targetClient") != expected_target_client
            or client_smoke.get("targetClient") != expected_target_client
        ):
            raise PackagingError(
                "QA user-open confirmation target client does not match theme-lock targetClient"
            )
        if client_smoke.get("openedArtifactHash") != expected_hashes["deck"]:
            raise PackagingError("QA user-open confirmation descriptor deck hash is stale")
        return
    if status != "passed" or qa_report.get("clientSmokeStatus") != "PASS":
        raise PackagingError("QA client smoke must be passed GUI evidence or confirmed not_available")
    _require_exact_keys(
        client_smoke,
        {
            "status", "evidencePath", "evidenceSha256", "userFinalOpenConfirmation",
            "targetClient", "observationMode", "openedArtifactHash",
        },
        "QA client smoke passed descriptor",
    )
    try:
        evidence = _strict_json_loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise PackagingError(f"QA client smoke structured evidence must be JSON: {error}") from error
    if not isinstance(evidence, dict):
        raise PackagingError("QA client smoke structured evidence must be a JSON object")
    schema = quality_schema["$defs"]["clientSmokeEvidence"]
    expected_keys = set(schema["required"])
    _require_exact_keys(evidence, expected_keys, "QA client smoke structured evidence")
    properties = schema["properties"]
    if (
        evidence.get("artifactType") != properties["artifactType"]["const"]
        or evidence.get("schemaVersion") != properties["schemaVersion"]["const"]
    ):
        raise PackagingError("QA client smoke structured evidence schema is invalid")
    target_client = evidence.get("targetClient")
    if target_client not in canonical_target_clients:
        raise PackagingError("QA client smoke target client is unsupported")
    if evidence.get("observationMode") != "gui-open":
        raise PackagingError("QA client smoke must record a visible GUI open, not headless evidence")
    observations = evidence.get("observations")
    if not isinstance(observations, dict):
        raise PackagingError("QA client smoke GUI observations are missing")
    _require_exact_keys(
        observations,
        {"applicationWindowVisible", "deckOpened", "slideCanvasVisible"},
        "QA client smoke GUI observations",
    )
    if any(observations.get(key) is not True for key in observations):
        raise PackagingError("QA client smoke GUI observations must all be true")
    _validate_timestamp(evidence.get("observedAt"), "QA client smoke observedAt")
    if evidence.get("openedArtifactHash") != expected_hashes["deck"]:
        raise PackagingError("QA client smoke opened artifact hash is stale")
    if target_client != expected_target_client:
        raise PackagingError("QA client smoke target client does not match theme-lock targetClient")
    if (
        client_smoke.get("targetClient") != target_client
        or client_smoke.get("observationMode") != "gui-open"
        or client_smoke.get("openedArtifactHash") != expected_hashes["deck"]
        or client_smoke.get("userFinalOpenConfirmation") is not False
    ):
        raise PackagingError("QA client smoke descriptor does not match structured GUI evidence")


def _validate_delivery_artifacts(
    delivery_dir: Path,
    files: list[Path],
    workspace: Path,
    state: dict[str, Any],
    qa_report: dict[str, Any],
    contract: dict[str, Any],
    quality_schema: dict[str, Any],
) -> None:
    pptx = next(path for path in files if path.suffix.casefold() == ".pptx")
    pdf = next(path for path in files if path.suffix.casefold() == ".pdf")
    slide_count, canvas_width, canvas_height = _pptx_metadata(pptx)
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
    expected_preview_names = {f"slide-{slide}.png" for slide in range(1, slide_count + 1)}
    actual_preview_names = {
        preview.name for preview in preview_files if preview.parent == previews_dir
    }
    if actual_preview_names != expected_preview_names or any(
        preview.parent != previews_dir for preview in preview_files
    ):
        raise PackagingError("preview files must map exactly to previews/slide-N.png")
    previews: dict[int, Path] = {}
    canvas_aspect = canvas_width / canvas_height
    for slide in range(1, slide_count + 1):
        preview = previews_dir / f"slide-{slide}.png"
        width, height = _validate_png(preview)
        preview_aspect = width / height
        tolerance = max(0.001, min(0.01, 2.5 / height))
        if abs(preview_aspect - canvas_aspect) > tolerance:
            raise PackagingError(
                f"preview aspect does not match PPTX canvas: slide {slide} "
                f"{width}x{height} versus {canvas_width}x{canvas_height}"
            )
        previews[slide] = preview

    approved_hash = state["approvals"]["final"]["approvedArtifactHash"].strip()
    actual_hash = _sha256_path(pptx).removeprefix("sha256:")
    if approved_hash.removeprefix("sha256:") != actual_hash:
        raise PackagingError("final approval hash does not match delivered PPTX")
    _validate_qa_evidence(
        qa_report, slide_count, workspace, state, contract, quality_schema, pptx, previews
    )


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

    contract = _load_quality_contract()
    quality_schema = _load_quality_evidence_schema()
    project_schema = _load_project_artifacts_schema()
    state, qa_report = _require_release_evidence(
        workspace, project_schema, contract, quality_schema,
    )
    files = _collect_delivery_files(delivery_dir, output)
    _validate_delivery_artifacts(
        delivery_dir, files, workspace, state, qa_report, contract, quality_schema
    )
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
