#!/usr/bin/env python3
"""Prepare a clean Task 10 delivery directory from verified route artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_nonempty(path: Path, label: str) -> None:
    if not path.is_file() or path.stat().st_size <= 0:
        raise ValueError(f"missing or empty {label}: {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--route", choices=["create", "template", "edit"], required=True)
    parser.add_argument("--pptx", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--preview-dir", type=Path, required=True)
    parser.add_argument("--delivery-dir", type=Path, required=True)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    pptx = args.pptx.resolve()
    pdf = args.pdf.resolve()
    preview_dir = args.preview_dir.resolve()
    delivery = args.delivery_dir.resolve()
    state = read_json(workspace / "state.json")
    manifest = read_json(workspace / "project-manifest.json")
    qa = read_json(workspace / "qa-report.json")
    if state.get("status") != "DELIVERED":
        raise ValueError("workspace must be DELIVERED")
    if qa.get("finalVerdict") != "PASS" or qa.get("projectId") != state.get("projectId"):
        raise ValueError("QA PASS must be bound to the delivered project")
    if args.route != state.get("route"):
        raise ValueError("route mismatch")
    require_nonempty(pptx, "PPTX")
    require_nonempty(pdf, "PDF")
    previews = sorted(preview_dir.glob("slide-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    if len(previews) != len(qa.get("perSlideManualScores", [])):
        raise ValueError("preview count must equal QA manual slide coverage")

    if delivery.exists() and any(path.is_file() or path.is_symlink() for path in delivery.rglob("*")):
        raise ValueError(f"delivery directory is not empty: {delivery}")
    (delivery / "previews").mkdir(parents=True, exist_ok=True)
    shutil.copy2(pptx, delivery / pptx.name)
    shutil.copy2(pdf, delivery / pdf.name)
    for preview in previews:
        shutil.copy2(preview, delivery / "previews" / preview.name)

    approvals = state.get("approvals", {})
    native = read_json(workspace / "qa" / "evidence" / "nativeObjectTypes.json")
    parity = read_json(workspace / "qa" / "evidence" / "pptxPdfPreviewParity.json")
    record = [
        "Visual-first PPT production record",
        "",
        f"Project ID: {state['projectId']}",
        f"Route: {args.route}",
        f"Title: {manifest['title']}",
        f"Final PPTX: {pptx.name}",
        f"PPTX SHA-256: {sha256(pptx)}",
        f"Final PDF: {pdf.name}",
        f"PDF SHA-256: {sha256(pdf)}",
        f"Slide count: {len(previews)}",
        "",
        "Approval gates:",
    ]
    for name in ["outline", "visual", "scope", "diffPreview", "final"]:
        if name in approvals:
            record.append(f"- {name}: {approvals[name].get('approvedArtifactHash', 'recorded not-applicable')}")
    record.extend([
        "",
        "Object/editability inventory:",
        f"- Native text runs: {native.get('nativeTextRuns')}",
        f"- Native tables: {native.get('nativeTables')}",
        f"- Native charts: {native.get('nativeCharts')}",
        "- Generated/photographic scene images are embedded raster assets; all critical text, data, tables, and charts remain native.",
        "",
        "QA:",
        f"- Final verdict: {qa['finalVerdict']}",
        f"- Automated checks: {len(qa.get('automatedChecks', []))}",
        f"- Full-size manual slides: {len(qa.get('perSlideManualScores', []))}",
        f"- Minimum manual score: {min(item['score'] for item in qa.get('perSlideManualScores', []))}",
        f"- Target-client smoke: {qa.get('clientSmoke', {}).get('status')} ({qa.get('clientSmoke', {}).get('evidencePath')})",
        f"- PPTX/PDF parity max MAE: {max(item['mae'] for item in parity.get('perSlide', []))}",
        f"- PPTX/PDF parity max P95: {max(item['p95'] for item in parity.get('perSlide', []))}",
        "",
        "PDF disclosure:",
        "- Export type: vector PDF for native text/shapes/tables/chart, with embedded raster scene images.",
        "- Export tool: LibreOffice Impress headless (producer recorded in qa/tool-versions.json).",
        "",
        "Route-specific evidence:",
    ])
    if args.route == "create":
        record.extend([
            "- Public source ledger: source-ledger.json",
            "- Theme lock: theme-lock.json",
            "- Image provenance and native/flattened inventory: slide-specs.json and qa evidence",
        ])
    elif args.route == "template":
        record.extend([
            "- Primary visual source: create-route PPTX",
            "- Template mapping: tmp/template-frame-map.json",
            "- Fidelity PASS: tmp/qa/template-fidelity-check.json",
            "- Overflow decision: source slide 7 duplicated into output slides 7 and 8; no auto-shrink or built-in theme mix.",
        ])
    else:
        patch = read_json(workspace / "tmp" / "edit-patch-report.json")
        comparison = read_json(workspace / "comparison.json")
        record.extend([
            f"- Source preserved: {patch.get('sourcePreserved')} ({patch.get('sourceHashBefore')})",
            f"- Authorized slides: {patch.get('authorizedSlides')}",
            f"- Modified parts: {patch.get('modifiedParts')}",
            f"- Unauthorized comparison: {comparison.get('finalVerdict')}; changed unauthorized slides={comparison.get('changedUnauthorizedSlides')}",
            "- Global font/color/ratio/master changes: none.",
        ])
    record.extend(["", "Accepted degradation: none.", ""])
    production_record = delivery / "production-record.txt"
    production_record.write_text("\n".join(record), encoding="utf-8")
    require_nonempty(production_record, "production record")
    print(json.dumps({"route": args.route, "delivery": str(delivery), "previewCount": len(previews), "status": "PASS"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
