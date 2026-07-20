#!/usr/bin/env python3
"""Build source-backed QA inputs for Task 10 presentation forward tests."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any
from zipfile import ZipFile
from xml.etree import ElementTree as ET

import numpy as np
from PIL import Image
from pypdf import PdfReader


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
HARD_ZERO = {"overflow", "unexpectedOverlap", "unresolvedPlaceholder", "brokenRelationship", "dataMismatch"}
REQUIRED = [
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
]
EDIT_REQUIRED = ["sourceHashPreserved", "authorizedScope", "unauthorizedSlideComparison"]
QUALITY_AUDIT_CHECKS = [
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
]
REVIEW_CHECKS = ["contentVisibility", "generatedImageTextReview", "visualSemanticMatch"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def evidence(path: Path, check_id: str, passed: bool, **details: Any) -> dict[str, Any]:
    record = {"check": check_id, "status": "PASS" if passed else "FAIL", **details}
    write_json(path, record)
    return record


def slide_parts(archive: ZipFile) -> list[str]:
    parts = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    return sorted(parts, key=lambda name: int(re.search(r"(\d+)", Path(name).stem).group(1)))


def pptx_canvas(archive: ZipFile) -> tuple[int, int]:
    root = ET.fromstring(archive.read("ppt/presentation.xml"))
    size = root.find(f"{{{P_NS}}}sldSz")
    if size is None:
        raise ValueError("ppt/presentation.xml has no p:sldSz")
    return int(size.attrib["cx"]), int(size.attrib["cy"])


def render_map(directory: Path) -> dict[int, Path]:
    result: dict[int, Path] = {}
    for path in directory.glob("*.png"):
        match = re.search(r"slide-(\d+)\.png$", path.name)
        if match:
            result[int(match.group(1))] = path.resolve()
    return result


def layout_files(directory: Path) -> dict[int, Path]:
    result: dict[int, Path] = {}
    for path in directory.glob("*.layout.json"):
        value = json.loads(path.read_text(encoding="utf-8"))
        number = int(value["slide"]["slide"])
        result[number] = path.resolve()
    return result


def text_overlap_pairs(layout_path: Path) -> list[dict[str, Any]]:
    value = json.loads(layout_path.read_text(encoding="utf-8"))
    candidates = []
    for element in value.get("elements", []):
        bbox = element.get("bbox")
        text = str(element.get("text", "")).strip()
        if text and isinstance(bbox, list) and len(bbox) == 4:
            candidates.append((element.get("name") or element.get("aid") or element.get("id"), text, [float(v) for v in bbox]))
    overlaps = []
    for index, left in enumerate(candidates):
        for right in candidates[index + 1 :]:
            ax, ay, aw, ah = left[2]
            bx, by, bw, bh = right[2]
            iw = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
            ih = max(0.0, min(ay + ah, by + bh) - max(ay, by))
            intersection = iw * ih
            smaller_area = min(aw * ah, bw * bh)
            overlap_fraction = intersection / smaller_area if smaller_area else 0.0
            # Text boxes often have deliberately generous bounding boxes. Treat a
            # pair as unexpected only when the intersection consumes at least 20%
            # of the smaller text frame; small edge-sharing is not glyph overlap.
            if intersection > 1.0 and overlap_fraction >= 0.20:
                overlaps.append({"left": left[0], "right": right[0], "intersectionArea": intersection, "smallerFrameFraction": overlap_fraction})
    return overlaps


def owner_directory(rels_name: str) -> PurePosixPath:
    path = PurePosixPath(rels_name)
    if path.parent.name != "_rels":
        raise ValueError(f"unexpected relationships path: {rels_name}")
    return path.parent.parent


def broken_relationships(archive: ZipFile) -> list[dict[str, str]]:
    names = set(archive.namelist())
    broken = []
    for rels_name in sorted(name for name in names if name.endswith(".rels")):
        root = ET.fromstring(archive.read(rels_name))
        base = owner_directory(rels_name)
        for rel in root.findall(f"{{{REL_NS}}}Relationship"):
            if rel.attrib.get("TargetMode") == "External":
                continue
            target = rel.attrib.get("Target", "")
            if not target:
                broken.append({"rels": rels_name, "target": target})
                continue
            if target.startswith("/"):
                resolved = target.lstrip("/")
            else:
                resolved = os.path.normpath((base / target).as_posix()).replace("\\", "/")
            if resolved not in names:
                broken.append({"rels": rels_name, "target": target, "resolved": resolved})
    return broken


def resolved_fonts(layouts: dict[int, Path]) -> list[str]:
    fonts = set()
    for path in layouts.values():
        value = json.loads(path.read_text(encoding="utf-8"))
        for element in value.get("elements", []):
            style = element.get("resolvedTextStyle") or {}
            font = style.get("typeface")
            if isinstance(font, str) and font and not font.startswith("+"):
                fonts.add(font)
            for paragraph in element.get("paragraphs", []):
                pfont = (paragraph.get("resolvedTextStyle") or {}).get("typeface")
                if isinstance(pfont, str) and pfont and not pfont.startswith("+"):
                    fonts.add(pfont)
    return sorted(fonts)


def font_matches(font: str) -> str:
    result = subprocess.run(
        ["fc-match", "-f", "%{family}", font],
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip()


def native_counts(archive: ZipFile, parts: list[str]) -> dict[str, int]:
    table = chart = text = 0
    for part in parts:
        payload = archive.read(part)
        table += payload.count(b"<a:tbl")
        chart += payload.count(b"<c:chart")
        text += payload.count(b"<a:t")
    return {"nativeTables": table, "nativeCharts": chart, "nativeTextRuns": text}


def chart_values(archive: ZipFile) -> list[list[str]]:
    result = []
    for name in archive.namelist():
        if "chart" not in name or not name.endswith(".xml"):
            continue
        try:
            root = ET.fromstring(archive.read(name))
        except ET.ParseError:
            continue
        values = [node.text for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "v" and node.text is not None]
        if values:
            result.append(values)
    return result


def contains_sequence(values: list[str], expected: list[Any]) -> bool:
    target = [str(item) for item in expected]
    return any(values[index : index + len(target)] == target for index in range(len(values) - len(target) + 1))


def visual_parity(pptx_renders: dict[int, Path], pdf_renders: dict[int, Path]) -> list[dict[str, float]]:
    metrics = []
    for slide in sorted(pptx_renders):
        pptx_image = Image.open(pptx_renders[slide]).convert("RGB")
        pdf_image = Image.open(pdf_renders[slide]).convert("RGB").resize(pptx_image.size, Image.Resampling.LANCZOS)
        left = np.asarray(pptx_image, dtype=np.float32)
        right = np.asarray(pdf_image, dtype=np.float32)
        delta = np.abs(left - right)
        metrics.append({"slide": slide, "mae": round(float(delta.mean()), 4), "p95": round(float(np.percentile(delta, 95)), 4)})
    return metrics


def require_nonempty(path: Path, label: str) -> None:
    if not path.is_file() or path.stat().st_size <= 0:
        raise ValueError(f"{label} must be a nonempty file: {path}")


def canonical_generated_at() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_current_quality_args(args: argparse.Namespace) -> bool:
    names = ["slide_specs", "theme_lock", "object_inventory", "quality_audit", "review_checks"]
    supplied = [getattr(args, name) is not None for name in names]
    if any(supplied) and not all(supplied):
        missing = [f"--{name.replace('_', '-')}" for name in names if getattr(args, name) is None]
        raise ValueError(f"current quality evidence mode requires all quality inputs; missing: {', '.join(missing)}")
    return all(supplied)


def load_user_open_confirmation(
    args: argparse.Namespace, pptx: Path, current_quality: dict[str, Any] | None,
) -> tuple[Path, dict[str, Any]]:
    if args.user_open_confirmation_evidence is None:
        raise ValueError(
            "--user-open-confirmation-evidence is required; this helper cannot mint user confirmation"
        )
    evidence_path = args.user_open_confirmation_evidence.resolve()
    require_nonempty(evidence_path, "user-open confirmation evidence")
    payload = json.loads(evidence_path.read_text(encoding="utf-8"))
    required = {
        "artifactType", "schemaVersion", "targetClient", "openedArtifactHash",
        "userMessage", "confirmedAt",
    }
    if not isinstance(payload, dict) or set(payload) != required:
        raise ValueError("--user-open-confirmation-evidence has an invalid structured schema")
    if payload.get("artifactType") != "userOpenConfirmationEvidence" or payload.get("schemaVersion") != "1.0.0":
        raise ValueError("--user-open-confirmation-evidence has an invalid artifact identity")
    if payload.get("openedArtifactHash") != f"sha256:{sha256(pptx)}":
        raise ValueError("--user-open-confirmation-evidence is not bound to the current PPTX hash")
    if payload.get("targetClient") not in {"Microsoft PowerPoint", "WPS Presentation"}:
        raise ValueError("--user-open-confirmation-evidence targetClient is unsupported")
    if not isinstance(payload.get("userMessage"), str) or not payload["userMessage"].strip():
        raise ValueError("--user-open-confirmation-evidence userMessage is required")
    if current_quality is not None:
        theme_lock = json.loads(current_quality["themeLock"].read_text(encoding="utf-8"))
        if payload["targetClient"] != theme_lock.get("targetClient"):
            raise ValueError("--user-open-confirmation-evidence targetClient must match theme-lock")
    return evidence_path, payload


def load_current_quality_inputs(args: argparse.Namespace, pptx: Path) -> dict[str, Any] | None:
    if not require_current_quality_args(args):
        return None
    slide_specs = args.slide_specs.resolve()
    theme_lock = args.theme_lock.resolve()
    object_inventory = args.object_inventory.resolve()
    quality_audit = args.quality_audit.resolve()
    review_checks = args.review_checks.resolve()
    for value, label in [
        (slide_specs, "slide specs"),
        (theme_lock, "theme lock"),
        (object_inventory, "object inventory"),
        (quality_audit, "quality audit"),
        (review_checks, "review checks"),
    ]:
        require_nonempty(value, label)
    expected_hashes = {
        "deck": f"sha256:{sha256(pptx)}",
        "slideSpecs": f"sha256:{sha256(slide_specs)}",
        "themeLock": f"sha256:{sha256(theme_lock)}",
        "objectInventory": f"sha256:{sha256(object_inventory)}",
    }
    audit = json.loads(quality_audit.read_text(encoding="utf-8"))
    if audit.get("artifactType") != "automatedEvidenceBundle" or audit.get("finalVerdict") != "PASS":
        raise ValueError("--quality-audit must be a PASS automatedEvidenceBundle")
    if audit.get("inputHashes") != expected_hashes:
        raise ValueError("--quality-audit input hashes do not match current deck/spec/theme/inventory bytes")
    audit_checks = audit.get("checks")
    if not isinstance(audit_checks, dict) or set(audit_checks) != set(QUALITY_AUDIT_CHECKS):
        raise ValueError("--quality-audit does not contain the exact current OOXML quality checks")
    for check_id in QUALITY_AUDIT_CHECKS:
        check = audit_checks[check_id]
        if check.get("status") != "PASS" or check.get("value") != 0 or check.get("violations") != []:
            raise ValueError(f"--quality-audit check must be hard-zero PASS: {check_id}")
    reviews = json.loads(review_checks.read_text(encoding="utf-8"))
    if not isinstance(reviews, list) or not reviews:
        raise ValueError("--review-checks must contain one or more slide review records")
    return {
        "slideSpecs": slide_specs,
        "themeLock": theme_lock,
        "objectInventory": object_inventory,
        "qualityAudit": quality_audit,
        "reviewChecks": review_checks,
        "reviews": reviews,
        "inputHashes": {key: expected_hashes[key] for key in ["deck", "slideSpecs", "themeLock"]},
    }


def normalize_review_checks(current: dict[str, Any], slide_count: int) -> list[dict[str, Any]]:
    source = current["reviewChecks"]
    normalized = []
    for entry in current["reviews"]:
        if not isinstance(entry, dict):
            raise ValueError("--review-checks entries must be objects")
        slide = entry.get("slide")
        if not isinstance(slide, int) or slide < 1:
            raise ValueError("--review-checks slide must be a positive integer")
        declared_path = entry.get("evidencePath")
        if not isinstance(declared_path, str) or not declared_path:
            raise ValueError(f"--review-checks slide {slide} requires evidencePath")
        evidence_path = Path(declared_path)
        if not evidence_path.is_absolute():
            evidence_path = source.parent / evidence_path
        evidence_path = evidence_path.resolve()
        require_nonempty(evidence_path, f"review evidence for slide {slide}")
        checks = entry.get("checks")
        if not isinstance(checks, dict) or set(checks) != set(REVIEW_CHECKS):
            raise ValueError(f"--review-checks slide {slide} must contain the exact review checks")
        normalized_checks = {}
        for check_id in REVIEW_CHECKS:
            check = checks[check_id]
            if not isinstance(check, dict) or check.get("status") != "PASS" or not str(check.get("notes", "")).strip():
                raise ValueError(f"--review-checks slide {slide} {check_id} must PASS with notes")
            normalized_checks[check_id] = {"status": "PASS", "notes": str(check["notes"]).strip()}
        reviewer = str(entry.get("reviewer", "")).strip()
        if not reviewer:
            raise ValueError(f"--review-checks slide {slide} requires reviewer")
        normalized.append({
            "slide": slide,
            "reviewer": reviewer,
            "evidencePath": str(evidence_path),
            "checks": normalized_checks,
        })
    normalized.sort(key=lambda item: item["slide"])
    if [item["slide"] for item in normalized] != list(range(1, slide_count + 1)):
        raise ValueError(f"--review-checks must cover every consecutive slide 1-{slide_count}")
    return normalized


def write_structured_per_check(
    path: Path,
    check_id: str,
    check: dict[str, Any],
    input_hashes: dict[str, str],
    generated_at: str,
    slide_count: int,
) -> None:
    passed = check.get("status") == "PASS"
    raw_value = check.get("value")
    value = raw_value if isinstance(raw_value, int) and raw_value >= 0 else (0 if passed else 1)
    structured_check = {
        "status": "PASS" if passed else "FAIL",
        "value": value,
        "violations": [] if passed else [{"message": f"{check_id} failed in route evidence producer"}],
    }
    if check_id == "pageCountAndCanvas":
        structured_check["value"] = slide_count
    write_json(path, {
        "artifactType": "perCheckEvidence",
        "schemaVersion": "1.0.0",
        "qualityContractVersion": "1.0.0",
        "checker": {"id": check_id, "version": "1.0.0"},
        "checkId": check_id,
        "inputHashes": input_hashes,
        "check": structured_check,
        "finalVerdict": "PASS" if passed else "FAIL",
        "generatedAt": generated_at,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--route", choices=["create", "template", "edit"], required=True)
    parser.add_argument("--pptx", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--pptx-render-dir", type=Path, required=True)
    parser.add_argument("--pdf-render-dir", type=Path, required=True)
    parser.add_argument("--layout-dir", type=Path, required=True)
    parser.add_argument("--data-contract", type=Path, required=True)
    parser.add_argument("--manual-review", type=Path, required=True)
    parser.add_argument("--slides-test", type=Path, required=True)
    parser.add_argument("--presentations-version", default="26.709.11516")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--scope", type=Path)
    parser.add_argument("--comparison", type=Path)
    parser.add_argument("--patch-report", type=Path)
    parser.add_argument("--slide-specs", type=Path)
    parser.add_argument("--theme-lock", type=Path)
    parser.add_argument("--object-inventory", type=Path)
    parser.add_argument("--quality-audit", type=Path)
    parser.add_argument("--review-checks", type=Path)
    parser.add_argument("--user-open-confirmation-evidence", type=Path)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    pptx = args.pptx.resolve()
    pdf = args.pdf.resolve()
    pptx_render_dir = args.pptx_render_dir.resolve()
    pdf_render_dir = args.pdf_render_dir.resolve()
    layouts = layout_files(args.layout_dir.resolve())
    contract = json.loads(args.data_contract.resolve().read_text(encoding="utf-8"))
    manual_config = json.loads(args.manual_review.resolve().read_text(encoding="utf-8"))
    qa_dir = workspace / "qa"
    evidence_dir = qa_dir / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    require_nonempty(pptx, "PPTX")
    require_nonempty(pdf, "PDF")
    current_quality = load_current_quality_inputs(args, pptx)
    user_open_path, user_open = load_user_open_confirmation(args, pptx, current_quality)
    with ZipFile(pptx) as archive:
        bad_member = archive.testzip()
        parts = slide_parts(archive)
        for part in parts:
            ET.fromstring(archive.read(part))
        canvas = pptx_canvas(archive)
        broken = broken_relationships(archive)
        natives = native_counts(archive, parts)
        xml_text = "\n".join(archive.read(name).decode("utf-8", errors="ignore") for name in archive.namelist() if name.endswith(".xml"))
        slide_xml_text = "\n".join(archive.read(name).decode("utf-8", errors="ignore") for name in parts)
        placeholder_count = sum(archive.read(part).count(b"<p:ph") for part in parts)
        prompt_patterns = ["Click to add title", "Click to add text", "Slide Number", "Title goes here", "Lorem ipsum"]
        prompt_hits = [pattern for pattern in prompt_patterns if pattern in slide_xml_text]
        chart_payloads = chart_values(archive)

    reader = PdfReader(str(pdf))
    pdf_pages = len(reader.pages)
    first_box = reader.pages[0].mediabox
    pdf_ratio = float(first_box.width) / float(first_box.height)
    pptx_ratio = canvas[0] / canvas[1]
    slide_count = len(parts)
    pptx_renders = render_map(pptx_render_dir)
    pdf_renders = render_map(pdf_render_dir)

    if sorted(pptx_renders) != list(range(1, slide_count + 1)):
        raise ValueError("PPTX render directory does not cover every slide continuously")
    if sorted(pdf_renders) != list(range(1, slide_count + 1)):
        raise ValueError("PDF render directory does not cover every slide continuously")
    if sorted(layouts) != list(range(1, slide_count + 1)):
        raise ValueError("layout directory does not cover every slide continuously")

    checks: dict[str, dict[str, Any]] = {}
    checks["pptxParse"] = evidence(evidence_dir / "pptxParse.json", "pptxParse", bad_member is None and slide_count > 0, slideCount=slide_count, badMember=bad_member, parsedSlideParts=parts)
    checks["pdfParse"] = evidence(evidence_dir / "pdfParse.json", "pdfParse", pdf_pages > 0, pageCount=pdf_pages, metadata={str(k): str(v) for k, v in (reader.metadata or {}).items()})
    canvas_ok = pdf_pages == slide_count and abs(pptx_ratio - 16 / 9) < 0.002 and abs(pdf_ratio - 16 / 9) < 0.002
    checks["pageCountAndCanvas"] = evidence(evidence_dir / "pageCountAndCanvas.json", "pageCountAndCanvas", canvas_ok, slideCount=slide_count, pdfPageCount=pdf_pages, pptxCanvasEmu=list(canvas), pptxRatio=pptx_ratio, pdfRatio=pdf_ratio, pptxRenderCount=len(pptx_renders), pdfRenderCount=len(pdf_renders))

    overflow_run = subprocess.run([sys.executable, str(args.slides_test.resolve()), str(pptx)], text=True, capture_output=True, check=False)
    overflow_output = (overflow_run.stdout + "\n" + overflow_run.stderr).strip()
    overflow_value = 0 if overflow_run.returncode == 0 and "No overflow detected" in overflow_output else 1
    checks["overflow"] = evidence(evidence_dir / "overflow.json", "overflow", overflow_value == 0, value=overflow_value, command=[sys.executable, str(args.slides_test.resolve()), str(pptx)], output=overflow_output)

    overlap_by_slide = {str(slide): text_overlap_pairs(path) for slide, path in layouts.items()}
    overlap_count = sum(len(items) for items in overlap_by_slide.values())
    checks["unexpectedOverlap"] = evidence(evidence_dir / "unexpectedOverlap.json", "unexpectedOverlap", overlap_count == 0, value=overlap_count, method="pairwise intersection of resolved text bounding boxes from layout JSON", bySlide=overlap_by_slide)
    unresolved = placeholder_count + len(prompt_hits)
    checks["unresolvedPlaceholder"] = evidence(evidence_dir / "unresolvedPlaceholder.json", "unresolvedPlaceholder", unresolved == 0, value=unresolved, structuralPlaceholderCount=placeholder_count, visiblePromptHits=prompt_hits)
    checks["brokenRelationship"] = evidence(evidence_dir / "brokenRelationship.json", "brokenRelationship", len(broken) == 0, value=len(broken), broken=broken)

    fonts = resolved_fonts(layouts)
    matches = {font: font_matches(font) for font in fonts}
    allowed_fallbacks = {str(key): str(value) for key, value in contract.get("fontFallbacks", {}).items()}
    missing_fonts = [
        font
        for font, match in matches.items()
        if font.casefold() not in match.casefold()
        and allowed_fallbacks.get(font, "").casefold() not in match.casefold()
    ]
    checks["fontAvailability"] = evidence(evidence_dir / "fontAvailability.json", "fontAvailability", bool(fonts) and not missing_fonts, resolvedFonts=fonts, fcMatches=matches, approvedFallbacks=allowed_fallbacks, missing=missing_fonts)
    native_ok = natives["nativeTextRuns"] > 0 and natives["nativeTables"] >= int(contract.get("minimumNativeTables", 0)) and natives["nativeCharts"] >= int(contract.get("minimumNativeCharts", 0))
    checks["nativeObjectTypes"] = evidence(evidence_dir / "nativeObjectTypes.json", "nativeObjectTypes", native_ok, **natives, required={"minimumNativeTables": contract.get("minimumNativeTables", 0), "minimumNativeCharts": contract.get("minimumNativeCharts", 0)})

    missing_text = [text for text in contract.get("requiredText", []) if text not in xml_text]
    forbidden_text = [text for text in contract.get("forbiddenText", []) if text in xml_text]
    missing_sequences = [sequence for sequence in contract.get("chartValueSequences", []) if not any(contains_sequence(values, sequence) for values in chart_payloads)]
    mismatch_count = len(missing_text) + len(forbidden_text) + len(missing_sequences)
    checks["dataMismatch"] = evidence(evidence_dir / "dataMismatch.json", "dataMismatch", mismatch_count == 0, value=mismatch_count, requiredTextMissing=missing_text, forbiddenTextPresent=forbidden_text, missingChartValueSequences=missing_sequences, chartPayloads=chart_payloads)

    parity = visual_parity(pptx_renders, pdf_renders)
    parity_ok = len(parity) == slide_count and max(item["mae"] for item in parity) < 12 and max(item["p95"] for item in parity) < 50
    checks["pptxPdfPreviewParity"] = evidence(evidence_dir / "pptxPdfPreviewParity.json", "pptxPdfPreviewParity", parity_ok, pageCount=slide_count, resizeMethod="PDF render resized to installed PPTX renderer dimensions with Lanczos", thresholds={"maxMaeExclusive": 12, "maxP95Exclusive": 50}, perSlide=parity)

    if current_quality:
        for check_id in QUALITY_AUDIT_CHECKS:
            checks[check_id] = {
                "check": check_id,
                "status": "PASS",
                "value": 0,
            }

    if args.route == "edit":
        for value, label in [(args.source, "source"), (args.scope, "scope"), (args.comparison, "comparison"), (args.patch_report, "patch report")]:
            if value is None:
                raise ValueError(f"edit route requires --{label.replace(' ', '-')}")
        source = args.source.resolve()
        scope = json.loads(args.scope.resolve().read_text(encoding="utf-8"))
        comparison = json.loads(args.comparison.resolve().read_text(encoding="utf-8"))
        patch_report = json.loads(args.patch_report.resolve().read_text(encoding="utf-8"))
        source_ok = patch_report.get("sourcePreserved") is True and patch_report.get("sourceHashBefore") == patch_report.get("sourceHashAfter") == sha256(source) and source != pptx
        checks["sourceHashPreserved"] = evidence(evidence_dir / "sourceHashPreserved.json", "sourceHashPreserved", source_ok, source=str(source), output=str(pptx), sourceHash=sha256(source), outputHash=sha256(pptx), patchReport=str(args.patch_report.resolve()))
        scope_ok = scope.get("authorizedSlides") == [4, 7] and scope.get("globalImpact") == "none" and scope.get("sourceMustRemainUnchanged") is True
        checks["authorizedScope"] = evidence(evidence_dir / "authorizedScope.json", "authorizedScope", scope_ok, scope=scope, scopePath=str(args.scope.resolve()))
        comparison_ok = comparison.get("finalVerdict") == "PASS" and comparison.get("authorizedSlides") == [4, 7] and not comparison.get("changedUnauthorizedSlides")
        checks["unauthorizedSlideComparison"] = evidence(evidence_dir / "unauthorizedSlideComparison.json", "unauthorizedSlideComparison", comparison_ok, comparisonPath=str(args.comparison.resolve()), finalVerdict=comparison.get("finalVerdict"), authorizedSlides=comparison.get("authorizedSlides"), changedUnauthorizedSlides=comparison.get("changedUnauthorizedSlides"))

    required_ids = REQUIRED + (QUALITY_AUDIT_CHECKS if current_quality else []) + (EDIT_REQUIRED if args.route == "edit" else [])
    failures = [check_id for check_id in required_ids if checks[check_id]["status"] != "PASS"]
    if failures:
        raise ValueError(f"QA evidence failed: {', '.join(failures)}")

    automated = []
    if current_quality:
        generated_at = canonical_generated_at()
        for check_id in required_ids:
            if check_id in QUALITY_AUDIT_CHECKS:
                evidence_path = current_quality["qualityAudit"]
            else:
                evidence_path = (evidence_dir / f"{check_id}.json").resolve()
                write_structured_per_check(
                    evidence_path,
                    check_id,
                    checks[check_id],
                    current_quality["inputHashes"],
                    generated_at,
                    slide_count,
                )
            automated.append({"id": check_id, "evidencePath": str(evidence_path)})
        write_json(qa_dir / "input-artifacts.json", {
            "deck": {"path": str(pptx)},
            "slideSpecs": {"path": str(current_quality["slideSpecs"])},
            "themeLock": {"path": str(current_quality["themeLock"])},
        })
        write_json(qa_dir / "review-checks.json", normalize_review_checks(current_quality, slide_count))
    else:
        for check_id in required_ids:
            entry: dict[str, Any] = {"id": check_id, "result": "passed", "evidencePath": str((evidence_dir / f"{check_id}.json").resolve())}
            if check_id in HARD_ZERO:
                entry["value"] = int(checks[check_id]["value"])
            elif check_id == "pageCountAndCanvas":
                entry["value"] = slide_count
            automated.append(entry)
    write_json(qa_dir / "automated-checks.json", automated)

    default_scores = manual_config["defaultScores"]
    overrides = manual_config.get("overrides", {})
    reviewer = manual_config["reviewer"]
    manual_scores = []
    for slide in range(1, slide_count + 1):
        scores = {**default_scores, **overrides.get(str(slide), {})}
        manual_scores.append({"slide": slide, "reviewer": reviewer, "scores": scores, "evidencePath": str(pptx_renders[slide])})
    write_json(qa_dir / "manual-scores.json", manual_scores)

    input_hashes = {"pptx": f"sha256:{sha256(pptx)}", "pdf": f"sha256:{sha256(pdf)}", "dataContract": f"sha256:{sha256(args.data_contract.resolve())}"}
    if args.source:
        input_hashes["sourcePptx"] = f"sha256:{sha256(args.source.resolve())}"
    write_json(qa_dir / "input-hashes.json", input_hashes)
    producer = str((reader.metadata or {}).get("/Producer", ""))
    creator = str((reader.metadata or {}).get("/Creator", ""))
    write_json(qa_dir / "tool-versions.json", {"python": sys.version.split()[0], "node": subprocess.run(["node", "--version"], text=True, capture_output=True).stdout.strip(), "presentationsBundle": args.presentations_version, "pptxRenderer": "Presentations render_slides.py via bundled LibreOffice", "pdfProducer": producer, "pdfCreator": creator})
    write_json(qa_dir / "client-smoke.json", {
        "status": "not_available",
        "evidencePath": str(user_open_path),
        "targetClient": user_open["targetClient"],
    })
    print(json.dumps({"route": args.route, "slideCount": slide_count, "automatedChecks": len(automated), "manualSlides": len(manual_scores), "qualityEvidenceMode": "current" if current_quality else "legacy", "status": "PASS"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
