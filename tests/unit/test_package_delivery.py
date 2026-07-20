import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib
from zipfile import ZIP_STORED, ZipFile


SCRIPT = Path("skills/visual-first-ppt/scripts/package_delivery.py").resolve()
PACKAGE_SPEC = importlib.util.spec_from_file_location("package_delivery_under_test", SCRIPT)
PACKAGE_MODULE = importlib.util.module_from_spec(PACKAGE_SPEC)
PACKAGE_SPEC.loader.exec_module(PACKAGE_MODULE)
VALID_PPTX = Path("tests/fixtures/baseline/template-source.pptx").resolve()
OOXML_CHECK_IDS = {
    "textFramePolicy", "safeMargin", "fontResolution", "contentPresence",
    "hiddenVisualResidue",
}
OUTLINE_APPROVAL_HASH = "sha256:" + ("a" * 64)
VISUAL_APPROVAL_HASH = "sha256:" + ("b" * 64)
EDIT_SCOPE_APPROVAL_HASH = "sha256:" + ("c" * 64)
ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
ECMASCRIPT_WHITESPACE_RE = re.compile(f"[{re.escape(ECMASCRIPT_WHITESPACE)}]+")


def diff_preview_reason_hash(reason):
    normalized = ECMASCRIPT_WHITESPACE_RE.sub(
        " ", str(reason).strip(ECMASCRIPT_WHITESPACE),
    )
    return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def png_bytes(
    width=1600,
    height=900,
    shade=255,
    *,
    bit_depth=8,
    color_type=2,
    compression_method=0,
    filter_method=0,
    interlace_method=0,
    raw_payload=None,
    idat_payload=None,
    corrupt_crc_kind=None,
):
    def chunk(kind, payload):
        body = kind + payload
        checksum = zlib.crc32(body)
        if kind == corrupt_crc_kind:
            checksum ^= 0xFF
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", checksum)

    pixel = bytes([shade, shade, shade])
    row = b"\x00" + (pixel * width)
    raw = row * height if raw_payload is None else raw_payload
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(
            ">IIBBBBB", width, height, bit_depth, color_type,
            compression_method, filter_method, interlace_method,
        )),
        chunk(b"IDAT", zlib.compress(raw, level=9) if idat_payload is None else idat_payload),
        chunk(b"IEND", b""),
    ])


def replace_chunk_type(payload, target_type, raw_type):
    mutated = bytearray(payload)
    offset = 8
    while offset + 12 <= len(mutated):
        length = struct.unpack(">I", mutated[offset:offset + 4])[0]
        kind = bytes(mutated[offset + 4:offset + 8])
        end = offset + 12 + length
        if kind == target_type:
            if len(raw_type) != 4:
                raise ValueError("PNG chunk type must contain four bytes")
            mutated[offset + 4:offset + 8] = raw_type
            body = bytes(mutated[offset + 4:offset + 8 + length])
            mutated[offset + 8 + length:end] = struct.pack(">I", zlib.crc32(body))
            return bytes(mutated)
        offset = end
    raise ValueError(f"PNG chunk not found: {target_type!r}")


def pdf_bytes(page_count, *, content_payload=b"", declared_count=None):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            f"<< /Type /Pages /Kids [{' '.join(f'{3 + (index * 2)} 0 R' for index in range(page_count))}] "
            f"/Count {page_count if declared_count is None else declared_count} >>"
        ).encode(),
    ]
    for index in range(page_count):
        page_object = 3 + (index * 2)
        content_object = page_object + 1
        objects.extend([
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] "
                f"/Resources << >> /Contents {content_object} 0 R >>"
            ).encode(),
            (
                f"<< /Length {len(content_payload)} >>\nstream\n".encode()
                + content_payload
                + b"\nendstream"
            ),
        ])

    payload = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload.extend(f"{number} 0 obj\n".encode())
        payload.extend(body)
        payload.extend(b"\nendobj\n")
    xref_offset = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode())
    payload.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(payload)


class PackageDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="visual-first-ppt-package-"))
        self.prepare_paths(self.root)
        self.write_complete_delivery()
        self.write_qa_report()
        self.write_state(approved=True)

    def prepare_paths(self, root):
        self.root = root
        self.workspace = self.root / "workspace"
        self.delivery = self.root / "delivery"
        self.workspace.mkdir()
        self.delivery.mkdir()
        self.output = self.root / "neutral-delivery.zip"

    def write_state(self, approved):
        deck = self.workspace / "deck.pptx"
        deck_hash = hashlib.sha256(deck.read_bytes()).hexdigest()
        qa_path = self.workspace / "qa-report.json"
        qa_hash = (
            f"sha256:{hashlib.sha256(qa_path.read_bytes()).hexdigest()}"
            if qa_path.is_file()
            else None
        )
        quality_dir = self.workspace / "quality"
        quality_gates = {
            "prebuildEvidenceHash": "sha256:" + hashlib.sha256(
                (quality_dir / "prebuild-evidence.json").read_bytes()
            ).hexdigest(),
            "pptxAuditHash": "sha256:" + hashlib.sha256(
                (quality_dir / "pptx-audit.json").read_bytes()
            ).hexdigest(),
            "qaReportHash": qa_hash,
            "deckHash": f"sha256:{deck_hash}",
        }
        approvals = {
            "outline": {
                "approvedArtifactHash": OUTLINE_APPROVAL_HASH,
                "approvedAt": "2026-07-13T00:00:00.000Z",
                "userMessage": "Approved test outline",
            },
            "visual": {
                "approvedArtifactHash": VISUAL_APPROVAL_HASH,
                "approvedAt": "2026-07-13T00:00:00.000Z",
                "userMessage": "Approved test visual contract",
            },
        }
        if approved:
            approvals["final"] = {
                "approvedArtifactHash": f"sha256:{deck_hash}",
                "approvedAt": "2026-07-13T00:00:00.000Z",
                "userMessage": "Approved test delivery",
            }
        (self.workspace / "state.json").write_text(json.dumps({
            "artifactType": "state",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "qualityGates": quality_gates,
            "projectId": "ppt-package-test",
            "route": "create",
            "status": "DELIVERED",
            "approvals": approvals,
            "blockers": [],
            "completedBatches": [],
            "inputHashes": {"deck": f"sha256:{deck_hash}"},
            "invalidations": [],
            "updatedAt": "2026-07-13T00:00:00.000Z",
        }))
        (self.workspace / "project-manifest.json").write_text(json.dumps({
            "artifactType": "projectManifest",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "qualityGates": quality_gates,
            "projectId": "ppt-package-test",
            "title": "Package test",
            "route": "create",
            "workspace": str(self.workspace),
            "inputHashes": {"deck": f"sha256:{deck_hash}"},
            "toolVersions": {"python": sys.version.split()[0]},
            "createdAt": "2026-07-13T00:00:00.000Z",
            "updatedAt": "2026-07-13T00:00:00.000Z",
            "finalOutputRoot": str(VALID_PPTX.parent),
            "finalOutputPath": str(VALID_PPTX),
        }))

    def write_complete_delivery(self):
        shutil.copyfile(VALID_PPTX, self.delivery / "neutral.pptx")
        with ZipFile(VALID_PPTX) as archive:
            self.slide_count = sum(
                name.startswith("ppt/slides/slide")
                and name.endswith(".xml")
                and name[len("ppt/slides/slide"):-len(".xml")].isdigit()
                for name in archive.namelist()
            )
        (self.delivery / "neutral.pdf").write_bytes(pdf_bytes(self.slide_count))
        previews = self.delivery / "previews"
        previews.mkdir(exist_ok=True)
        for old_preview in previews.glob("*"):
            old_preview.unlink()
        preview = png_bytes()
        for slide in range(1, self.slide_count + 1):
            (previews / f"slide-{slide}.png").write_bytes(
                png_bytes(shade=(240 + slide) % 256)
            )
        (self.delivery / "production-record.txt").write_text("verified production record\n")

    def write_qa_report(self):
        qa_dir = self.workspace / "qa"
        qa_dir.mkdir(exist_ok=True)
        quality_dir = self.workspace / "quality"
        quality_dir.mkdir(exist_ok=True)
        contract = json.loads(Path(
            "skills/visual-first-ppt/assets/quality-contract.json"
        ).read_text())
        required_checks = contract["requiredAutomatedChecks"]
        deck = self.workspace / "deck.pptx"
        shutil.copyfile(self.delivery / "neutral.pptx", deck)
        slide_specs = self.workspace / "slide-specs.json"
        theme_lock = self.workspace / "theme-lock.json"
        font_evidence = self.workspace / "font-evidence.json"
        object_inventory = self.workspace / "object-inventory.json"
        slide_specs.write_text(json.dumps({"slides": list(range(1, self.slide_count + 1))}))
        font_evidence.write_text(json.dumps({"status": "PASS", "fonts": ["Arial"]}))
        object_inventory.write_text(json.dumps({"slides": self.slide_count, "objects": []}))
        theme_lock.write_text(json.dumps({
            "themeId": "neutral",
            "targetClient": "Microsoft PowerPoint",
            "fontEvidencePath": str(font_evidence),
        }))
        input_artifacts = {
            "deck": {
                "path": str(deck),
                "sha256": f"sha256:{hashlib.sha256(deck.read_bytes()).hexdigest()}",
            },
            "slideSpecs": {
                "path": str(slide_specs),
                "sha256": f"sha256:{hashlib.sha256(slide_specs.read_bytes()).hexdigest()}",
            },
            "themeLock": {
                "path": str(theme_lock),
                "sha256": f"sha256:{hashlib.sha256(theme_lock.read_bytes()).hexdigest()}",
            },
        }
        input_hashes = {
            artifact_id: descriptor["sha256"]
            for artifact_id, descriptor in input_artifacts.items()
        }
        (quality_dir / "prebuild-evidence.json").write_text(json.dumps({
            "artifactType": "prebuildEvidence",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": contract["qualityContractVersion"],
            "checker": {"id": "validate-slide-specs", "version": "1.0.0"},
            "projectId": "ppt-package-test",
            "inputHashes": {
                "slideSpecs": input_hashes["slideSpecs"],
                "themeLock": input_hashes["themeLock"],
                "fontEvidence": "sha256:" + hashlib.sha256(
                    font_evidence.read_bytes()
                ).hexdigest(),
            },
            "approvalHashes": {
                "outline": OUTLINE_APPROVAL_HASH,
                "visual": VISUAL_APPROVAL_HASH,
            },
            "violationCounts": {
                "schema": 0,
                "contentBlocks": 0,
                "typography": 0,
                "safeZone": 0,
                "visualIntent": 0,
                "contentHash": 0,
            },
            "finalVerdict": "PASS",
            "generatedAt": "2026-07-17T00:00:00.000Z",
        }))
        automated = []
        evidence_paths = []
        ooxml_evidence = quality_dir / "pptx-audit.json"
        ooxml_checks = {}
        for check_id in required_checks:
            evidence = (
                ooxml_evidence if check_id in OOXML_CHECK_IDS
                else qa_dir / f"{check_id}.json"
            )
            value = self.slide_count if check_id == "pageCountAndCanvas" else (
                0 if check_id in contract["hardZeroChecks"] else 0
            )
            check_payload = {"status": "PASS", "value": value, "violations": []}
            if check_id in OOXML_CHECK_IDS:
                ooxml_checks[check_id] = check_payload
            else:
                evidence.write_text(json.dumps({
                    "artifactType": "perCheckEvidence",
                    "schemaVersion": "1.0.0",
                    "qualityContractVersion": contract["qualityContractVersion"],
                    "checker": {"id": check_id, "version": "1.0.0"},
                    "checkId": check_id,
                    "inputHashes": input_hashes,
                    "check": check_payload,
                    "finalVerdict": "PASS",
                    "generatedAt": "2026-07-17T00:00:00.000Z",
                }))
            evidence_paths.append(str(evidence))
            check = {
                "id": check_id,
                "status": "PASS",
                "value": value,
                "evidencePath": str(evidence),
            }
            automated.append(check)
        ooxml_evidence.write_text(json.dumps({
            "artifactType": "automatedEvidenceBundle",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": contract["qualityContractVersion"],
            "checker": {"id": "audit-pptx-quality", "version": "1.0.0"},
            "inputHashes": {
                **input_hashes,
                "objectInventory": "sha256:" + hashlib.sha256(
                    object_inventory.read_bytes()
                ).hexdigest(),
            },
            "checks": ooxml_checks,
            "finalVerdict": "PASS",
            "generatedAt": "2026-07-17T00:00:00.000Z",
        }))
        for check in automated:
            evidence = Path(check["evidencePath"])
            check["evidenceSha256"] = (
                f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
            )
        manual = []
        review = []
        for slide in range(1, self.slide_count + 1):
            evidence = self.delivery / "previews" / f"slide-{slide}.png"
            evidence_paths.append(str(evidence))
            manual.append({
                "slide": slide,
                "score": 5,
                "dimensions": {
                    dimension: 5 for dimension in contract["requiredManualDimensions"]
                },
                "reviewer": "unit-test",
                "evidencePath": str(evidence),
                "evidenceSha256": f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}",
                "width": 1600,
                "height": 900,
            })
            review.append({
                "slide": slide,
                "reviewer": "unit-test",
                "evidencePath": str(evidence),
                "evidenceSha256": f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}",
                "width": 1600,
                "height": 900,
                "checks": {
                    check_id: {
                        "status": "PASS",
                        "notes": f"{check_id} reviewed on the full slide",
                    }
                    for check_id in contract["requiredReviewChecks"]
                },
            })
        smoke = qa_dir / "client-smoke.json"
        smoke.write_text(json.dumps({
            "artifactType": "clientSmokeEvidence",
            "schemaVersion": "1.0.0",
            "targetClient": "Microsoft PowerPoint",
            "observationMode": "gui-open",
            "openedArtifactHash": input_hashes["deck"],
            "observations": {
                "applicationWindowVisible": True,
                "deckOpened": True,
                "slideCanvasVisible": True,
            },
            "observedAt": "2026-07-17T00:00:00.000Z",
        }))
        smoke_hash = f"sha256:{hashlib.sha256(smoke.read_bytes()).hexdigest()}"
        evidence_paths.append(str(smoke))
        (self.workspace / "qa-report.json").write_text(json.dumps({
            "artifactType": "qaReport",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": contract["qualityContractVersion"],
            "projectId": "ppt-package-test",
            "route": "create",
            "inputArtifacts": input_artifacts,
            "inputHashes": input_hashes,
            "toolVersions": {"python": sys.version.split()[0]},
            "automatedChecks": automated,
            "reviewChecks": review,
            "perSlideManualScores": manual,
            "clientSmokeStatus": "PASS",
            "clientSmoke": {
                "status": "passed",
                "evidencePath": str(smoke),
                "evidenceSha256": smoke_hash,
                "userFinalOpenConfirmation": False,
                "targetClient": "Microsoft PowerPoint",
                "observationMode": "gui-open",
                "openedArtifactHash": input_hashes["deck"],
            },
            "evidencePaths": sorted(set(evidence_paths)),
            "finalVerdict": "PASS",
            "generatedAt": "2026-07-13T00:00:00.000Z",
        }))

    def run_package(self):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--workspace", str(self.workspace),
                "--delivery-dir", str(self.delivery),
                "--output", str(self.output),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def sync_qa_gate_hash(self):
        qa_hash = "sha256:" + hashlib.sha256(
            (self.workspace / "qa-report.json").read_bytes()
        ).hexdigest()
        for name in ("state.json", "project-manifest.json"):
            target = self.workspace / name
            payload = json.loads(target.read_text())
            payload["qualityGates"]["qaReportHash"] = qa_hash
            target.write_text(json.dumps(payload))

    @staticmethod
    def _mutate_json(path, mutate):
        payload = json.loads(path.read_text())
        mutate(payload)
        path.write_text(json.dumps(payload))

    def prepare_fresh_case(self, label):
        root = Path(tempfile.mkdtemp(prefix=f"visual-first-ppt-{label}-"))
        self.prepare_paths(root)
        self.write_complete_delivery()
        self.write_qa_report()
        self.write_state(approved=True)

    def prepare_edit_not_applicable_case(self, label, reason):
        self.prepare_fresh_case(label)
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        contract = json.loads(Path(
            "skills/visual-first-ppt/assets/quality-contract.json"
        ).read_text())
        report["route"] = "edit"
        for check_id in contract["editRequiredChecks"]:
            evidence = self.workspace / "qa" / f"{check_id}.json"
            evidence.write_text(json.dumps({
                "artifactType": "perCheckEvidence",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": contract["qualityContractVersion"],
                "checker": {"id": check_id, "version": "1.0.0"},
                "checkId": check_id,
                "inputHashes": report["inputHashes"],
                "check": {"status": "PASS", "value": 0, "violations": []},
                "finalVerdict": "PASS",
                "generatedAt": "2026-07-17T00:00:00.000Z",
            }))
            descriptor = {
                "id": check_id,
                "status": "PASS",
                "value": 0,
                "evidencePath": str(evidence),
                "evidenceSha256": "sha256:" + hashlib.sha256(
                    evidence.read_bytes()
                ).hexdigest(),
            }
            report["automatedChecks"].append(descriptor)
            report["evidencePaths"].append(str(evidence))
        report["evidencePaths"] = sorted(set(report["evidencePaths"]))
        report_path.write_text(json.dumps(report))

        prebuild_path = self.workspace / "quality" / "prebuild-evidence.json"
        prebuild = json.loads(prebuild_path.read_text())
        prebuild["approvalHashes"] = {
            "scope": EDIT_SCOPE_APPROVAL_HASH,
            "diffPreview": diff_preview_reason_hash(reason),
        }
        prebuild_path.write_text(json.dumps(prebuild))

        for name in ("state.json", "project-manifest.json"):
            target = self.workspace / name
            payload = json.loads(target.read_text())
            payload["route"] = "edit"
            payload["qualityGates"]["prebuildEvidenceHash"] = (
                "sha256:" + hashlib.sha256(prebuild_path.read_bytes()).hexdigest()
            )
            payload["qualityGates"]["qaReportHash"] = (
                "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
            )
            if name == "state.json":
                payload["approvals"] = {
                    "scope": {
                        "approvedArtifactHash": EDIT_SCOPE_APPROVAL_HASH,
                        "approvedAt": "2026-07-13T00:00:00.000Z",
                        "userMessage": "Approved edit scope",
                    },
                    "diffPreview": {
                        "notApplicableReason": reason,
                    },
                    "final": payload["approvals"]["final"],
                }
            target.write_text(json.dumps(payload))

    def replace_preview_and_sync_report(self, payload, slide=1, width=16, height=9):
        preview = self.delivery / "previews" / f"slide-{slide}.png"
        preview.write_bytes(payload)
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        digest = f"sha256:{hashlib.sha256(payload).hexdigest()}"
        for collection in ("reviewChecks", "perSlideManualScores"):
            record = next(item for item in report[collection] if item["slide"] == slide)
            record.update({
                "evidenceSha256": digest,
                "width": width,
                "height": height,
            })
        report_path.write_text(json.dumps(report))

    def test_creates_deterministic_sorted_zip_with_hash_manifest(self):
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)
        with ZipFile(self.output) as archive:
            names = archive.namelist()
            self.assertEqual(names, sorted(names))
            self.assertIn("manifest.json", names)
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
            manifest = json.loads(archive.read("manifest.json"))
            expected = hashlib.sha256((self.delivery / "neutral.pptx").read_bytes()).hexdigest()
            pptx_entry = next(item for item in manifest["files"] if item["path"] == "neutral.pptx")
            self.assertEqual(pptx_entry["sha256"], expected)

    def test_requires_current_manifest_state_and_matching_reviewed_qa_hash(self):
        cases = {
            "missing-manifest": lambda: (self.workspace / "project-manifest.json").unlink(),
            "legacy-state": lambda: self._mutate_json(
                self.workspace / "state.json",
                lambda value: (
                    value.pop("qualityContractVersion", None),
                    value.pop("qualityGates", None),
                ),
            ),
            "mismatched-quality-gates": lambda: self._mutate_json(
                self.workspace / "project-manifest.json",
                lambda value: value["qualityGates"].update({
                    "qaReportHash": "sha256:" + ("0" * 64),
                }),
            ),
            "project-id-mismatch": lambda: self._mutate_json(
                self.workspace / "project-manifest.json",
                lambda value: value.update({"projectId": "ppt-different-project"}),
            ),
            "route-mismatch": lambda: self._mutate_json(
                self.workspace / "project-manifest.json",
                lambda value: value.update({"route": "template"}),
            ),
        }
        for label, mutate in cases.items():
            with self.subTest(case=label):
                self.prepare_fresh_case(f"current-project-{label}")
                mutate()
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, f"{label} unexpectedly packaged")
                self.assertRegex(
                    result.stderr.lower(),
                    r"manifest|quality|gate|project|route|current",
                )

    def test_rejects_qa_only_gate_without_persistent_delivered_output(self):
        state_path = self.workspace / "state.json"
        manifest_path = self.workspace / "project-manifest.json"
        state = json.loads(state_path.read_text())
        manifest = json.loads(manifest_path.read_text())
        qa_only = {"qaReportHash": state["qualityGates"]["qaReportHash"]}
        state["qualityGates"] = qa_only
        manifest["qualityGates"] = qa_only
        manifest.pop("finalOutputRoot", None)
        manifest.pop("finalOutputPath", None)
        state_path.write_text(json.dumps(state))
        manifest_path.write_text(json.dumps(manifest))

        result = self.run_package()

        self.assertNotEqual(result.returncode, 0, "qaReportHash alone forged DELIVERED")
        self.assertFalse(self.output.exists())
        self.assertRegex(result.stderr.lower(), r"gate|prebuild|audit|deck|finaloutput|persistent")

    def test_requires_all_four_canonical_current_delivered_gate_hashes(self):
        gate_ids = (
            "prebuildEvidenceHash", "pptxAuditHash", "qaReportHash", "deckHash",
        )
        for gate_id in gate_ids:
            with self.subTest(gate=gate_id, mutation="missing"):
                self.prepare_fresh_case(f"missing-{gate_id}")
                for name in ("state.json", "project-manifest.json"):
                    self._mutate_json(
                        self.workspace / name,
                        lambda value, gate_id=gate_id: value["qualityGates"].pop(gate_id),
                    )
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, f"missing {gate_id} packaged")
                self.assertFalse(self.output.exists())
                self.assertRegex(result.stderr.lower(), r"gate|hash|prebuild|audit|deck|qa")

            with self.subTest(gate=gate_id, mutation="noncanonical"):
                self.prepare_fresh_case(f"invalid-{gate_id}")
                for name in ("state.json", "project-manifest.json"):
                    self._mutate_json(
                        self.workspace / name,
                        lambda value, gate_id=gate_id: value["qualityGates"].update({
                            gate_id: "not-a-canonical-sha256",
                        }),
                    )
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, f"invalid {gate_id} packaged")
                self.assertFalse(self.output.exists())
                self.assertRegex(result.stderr.lower(), r"gate|hash|sha256|prebuild|audit|deck|qa")

    def test_binds_prebuild_and_pptx_audit_gates_to_current_evidence(self):
        cases = (
            ("prebuildEvidenceHash", "prebuild-evidence.json"),
            ("pptxAuditHash", "pptx-audit.json"),
        )
        for gate_id, evidence_name in cases:
            with self.subTest(gate=gate_id):
                self.prepare_fresh_case(f"stale-{gate_id}")
                for name in ("state.json", "project-manifest.json"):
                    self._mutate_json(
                        self.workspace / name,
                        lambda value, gate_id=gate_id: value["qualityGates"].update({
                            gate_id: "sha256:" + ("0" * 64),
                        }),
                    )
                result = self.run_package()
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{gate_id} was not bound to {evidence_name}",
                )
                self.assertFalse(self.output.exists())
                self.assertRegex(result.stderr.lower(), r"prebuild|audit|evidence|gate|hash|stale")

        self.prepare_fresh_case("mutated-prebuild-bytes")
        prebuild = self.workspace / "quality" / "prebuild-evidence.json"
        prebuild.write_text(prebuild.read_text() + "\n")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0, "mutated prebuild evidence bytes packaged")
        self.assertFalse(self.output.exists())
        self.assertRegex(result.stderr.lower(), r"prebuild|evidence|gate|hash|stale")

    def test_requires_manifest_persistent_output_fields_and_safe_existing_file(self):
        for field in ("finalOutputRoot", "finalOutputPath"):
            with self.subTest(case=f"missing-{field}"):
                self.prepare_fresh_case(f"missing-{field}")
                self._mutate_json(
                    self.workspace / "project-manifest.json",
                    lambda value, field=field: value.pop(field),
                )
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, f"missing {field} packaged")
                self.assertFalse(self.output.exists())
                self.assertRegex(result.stderr.lower(), r"finaloutput|persistent|root|path")

        with tempfile.TemporaryDirectory(
            prefix="package-persistent-", dir=Path.cwd(),
        ) as persistent:
            persistent = Path(persistent)
            root = persistent / "approved-root"
            root.mkdir()
            outside = persistent / "outside.pptx"
            outside.write_bytes(VALID_PPTX.read_bytes())
            empty = root / "empty.pptx"
            empty.write_bytes(b"")
            missing = root / "missing.pptx"
            cases = (
                ("outside-root", root, outside),
                ("missing-file", root, missing),
                ("empty-file", root, empty),
                ("temporary-root", self.root, self.root / "persistent.pptx"),
            )
            (self.root / "persistent.pptx").write_bytes(VALID_PPTX.read_bytes())
            for label, final_root, final_path in cases:
                with self.subTest(case=label):
                    self.prepare_fresh_case(f"persistent-{label}")
                    self._mutate_json(
                        self.workspace / "project-manifest.json",
                        lambda value, final_root=final_root, final_path=final_path: value.update({
                            "finalOutputRoot": str(final_root),
                            "finalOutputPath": str(final_path),
                        }),
                    )
                    result = self.run_package()
                    self.assertNotEqual(result.returncode, 0, f"unsafe {label} packaged")
                    self.assertFalse(self.output.exists())
                    self.assertRegex(
                        result.stderr.lower(),
                        r"finaloutput|persistent|outside|missing|empty|temporary|scratch|root|path",
                    )

    def test_requires_persistent_output_deck_hash_chain(self):
        with tempfile.TemporaryDirectory(
            prefix="package-persistent-", dir=Path.cwd(),
        ) as persistent:
            persistent = Path(persistent)
            wrong_output = persistent / "wrong.pptx"
            wrong_output.write_bytes(b"different persistent deck bytes")
            self._mutate_json(
                self.workspace / "project-manifest.json",
                lambda value: value.update({
                    "finalOutputRoot": str(persistent),
                    "finalOutputPath": str(wrong_output),
                }),
            )
            result = self.run_package()
            self.assertNotEqual(result.returncode, 0, "wrong persistent deck bytes packaged")
            self.assertFalse(self.output.exists())
            self.assertRegex(result.stderr.lower(), r"finaloutput|persistent|deck|approval|qa|hash")

        for label, mutate in (
            (
                "gate-versus-approval",
                lambda state, manifest, report: (
                    state["qualityGates"].update({"deckHash": "sha256:" + ("0" * 64)}),
                    manifest["qualityGates"].update({"deckHash": "sha256:" + ("0" * 64)}),
                ),
            ),
            (
                "gate-versus-qa-deck",
                lambda state, manifest, report: (
                    state["qualityGates"].update({"deckHash": "sha256:" + ("1" * 64)}),
                    manifest["qualityGates"].update({"deckHash": "sha256:" + ("1" * 64)}),
                ),
            ),
        ):
            with self.subTest(case=label):
                self.prepare_fresh_case(label)
                state_path = self.workspace / "state.json"
                manifest_path = self.workspace / "project-manifest.json"
                report_path = self.workspace / "qa-report.json"
                state = json.loads(state_path.read_text())
                manifest = json.loads(manifest_path.read_text())
                report = json.loads(report_path.read_text())
                mutate(state, manifest, report)
                state_path.write_text(json.dumps(state))
                manifest_path.write_text(json.dumps(manifest))
                report_path.write_text(json.dumps(report))
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, f"broken {label} chain packaged")
                self.assertFalse(self.output.exists())
                self.assertRegex(result.stderr.lower(), r"deck|approval|qa|finaloutput|persistent|hash")

    def test_edit_not_applicable_diff_preview_uses_normalized_reason_binding(self):
        self.prepare_edit_not_applicable_case(
            "edit-na-positive",
            "\ufeff  只改文案，\u2003\n  无视觉差异  \ufeff",
        )

        result = self.run_package()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.output.is_file())

    def test_edit_not_applicable_diff_preview_rejects_ecmascript_whitespace_only_reason(self):
        self.prepare_edit_not_applicable_case(
            "edit-na-empty-after-normalization",
            "\ufeff \u2003\n\t\ufeff",
        )

        result = self.run_package()

        self.assertNotEqual(result.returncode, 0, "empty normalized N/A reason packaged")
        self.assertFalse(self.output.exists())
        self.assertRegex(result.stderr.lower(), r"diffpreview|diff-preview|reason|nonempty")

    def test_edit_not_applicable_diff_preview_rejects_reason_or_binding_drift(self):
        self.prepare_edit_not_applicable_case(
            "edit-na-reason-drift",
            "  只改文案，\n  无视觉差异  ",
        )
        self._mutate_json(
            self.workspace / "state.json",
            lambda value: value["approvals"]["diffPreview"].update({
                "notApplicableReason": "改动视觉布局",
            }),
        )
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0, "changed N/A reason reused prebuild binding")
        self.assertFalse(self.output.exists())
        self.assertRegex(result.stderr.lower(), r"diffpreview|diff-preview|reason|approval|prebuild")

        self.prepare_edit_not_applicable_case(
            "edit-na-binding-drift",
            "只改文案， 无视觉差异",
        )
        prebuild_path = self.workspace / "quality" / "prebuild-evidence.json"
        self._mutate_json(
            prebuild_path,
            lambda value: value["approvalHashes"].update({
                "diffPreview": "sha256:" + ("0" * 64),
            }),
        )
        prebuild_hash = "sha256:" + hashlib.sha256(prebuild_path.read_bytes()).hexdigest()
        for name in ("state.json", "project-manifest.json"):
            self._mutate_json(
                self.workspace / name,
                lambda value, prebuild_hash=prebuild_hash: value["qualityGates"].update({
                    "prebuildEvidenceHash": prebuild_hash,
                }),
            )
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0, "forged N/A binding packaged")
        self.assertFalse(self.output.exists())
        self.assertRegex(result.stderr.lower(), r"diffpreview|diff-preview|reason|approval|prebuild")

    def test_rejects_schema_valid_qa_timestamp_tampering_after_review(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["generatedAt"] = "2026-07-20T00:00:00.000Z"
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"qa.*hash|hash.*qa|reviewed")

    def test_rejects_extra_pass_automated_descriptor_with_nan_and_missing_evidence(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["automatedChecks"].append({
            "id": "nonContractExtraCheck",
            "status": "PASS",
            "value": float("nan"),
            "evidencePath": str(self.workspace / "missing-extra-evidence.json"),
            "evidenceSha256": "sha256:" + ("0" * 64),
        })
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(
            result.stderr.lower(),
            r"nan|json|finite|unexpected|automated|evidence",
        )

    def test_python_json_and_schema_adapter_match_finite_integer_semantics(self):
        invalid_json = self.workspace / "nonfinite.json"
        for token in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(token=token):
                invalid_json.write_text('{"value": ' + token + "}")
                with self.assertRaisesRegex(
                    PACKAGE_MODULE.PackagingError,
                    r"invalid.*json|non.?finite|constant",
                ):
                    PACKAGE_MODULE._read_json(invalid_json, "nonfinite JSON")

        integer_schema = {"type": "integer", "minimum": 4, "maximum": 5}
        self.assertEqual(
            PACKAGE_MODULE._validate_schema_value(integer_schema, 4.0, integer_schema),
            [],
        )
        self.assertTrue(
            PACKAGE_MODULE._validate_schema_value(integer_schema, 4.5, integer_schema)
        )
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(nonfinite=value):
                self.assertTrue(PACKAGE_MODULE._validate_schema_value(
                    {"type": "number"}, value, {"type": "number"}
                ))
                self.assertTrue(PACKAGE_MODULE._validate_schema_value(
                    integer_schema, value, integer_schema
                ))

    def test_shared_node_preflight_removes_node_injection_environment(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with (
            mock.patch.object(PACKAGE_MODULE.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(PACKAGE_MODULE.subprocess, "run", return_value=completed) as run,
            mock.patch.dict(
                PACKAGE_MODULE.os.environ,
                {"NODE_OPTIONS": "--require=/tmp/injected.js", "NODE_PATH": "/tmp/injected"},
            ),
        ):
            PACKAGE_MODULE._run_current_qa_preflight(
                self.workspace,
                self.workspace / "qa-report.json",
            )
        environment = run.call_args.kwargs["env"]
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("NODE_PATH", environment)
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_package_accepts_json_integer_spelling_4_point_0_but_rejects_4_point_5(self):
        for value, expected_success in ((4.0, True), (4.5, False)):
            with self.subTest(value=value):
                self.prepare_fresh_case(f"json-integer-{str(value).replace('.', '-')}")
                report_path = self.workspace / "qa-report.json"
                report = json.loads(report_path.read_text())
                record = report["perSlideManualScores"][0]
                record["score"] = value
                record["dimensions"]["readability"] = value
                record["notes"] = "readability reviewed at the contract floor"
                report_path.write_text(json.dumps(report))
                self.sync_qa_gate_hash()
                result = self.run_package()
                if expected_success:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertRegex(result.stderr.lower(), r"integer|schema|score|current")

    def test_pptx_page_count_uses_presentation_relationships_not_orphan_slide_parts(self):
        deck = self.root / "orphan-slide-part.pptx"
        shutil.copyfile(VALID_PPTX, deck)
        with ZipFile(deck, "a") as archive:
            first_slide = next(
                name for name in archive.namelist()
                if name.startswith("ppt/slides/slide") and name.endswith(".xml")
            )
            archive.writestr("ppt/slides/slide999.xml", archive.read(first_slide))
        slide_count, _, _ = PACKAGE_MODULE._pptx_metadata(deck)
        self.assertEqual(slide_count, self.slide_count)

    def test_pptx_metadata_accepts_large_low_compression_opaque_media(self):
        deck = self.root / "large-media.pptx"
        shutil.copyfile(VALID_PPTX, deck)
        large_media = b"opaque-media-0123456789" * (17 * 1024 * 1024 // 23 + 1)
        with ZipFile(deck, "a") as archive:
            archive.writestr(
                "ppt/media/training-video.mp4",
                large_media,
                compress_type=ZIP_STORED,
            )
        slide_count, _, _ = PACKAGE_MODULE._pptx_metadata(deck)
        self.assertEqual(slide_count, self.slide_count)

    def test_pdf_page_count_uses_page_tree_and_ignores_stream_decoys(self):
        pdf = self.root / "stream-decoy.pdf"
        pdf.write_bytes(pdf_bytes(1, content_payload=b"BT (/Type /Page) Tj ET"))
        self.assertEqual(PACKAGE_MODULE._pdf_page_count(pdf), 1)

        malformed = self.root / "page-tree-count-mismatch.pdf"
        malformed.write_bytes(pdf_bytes(1, declared_count=2))
        with self.assertRaisesRegex(PACKAGE_MODULE.PackagingError, r"page tree|Count|page count"):
            PACKAGE_MODULE._pdf_page_count(malformed)

    def test_rejects_plain_or_headless_client_smoke_forgery(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["clientSmoke"]["evidencePath"])

        evidence.write_text("PASS\n")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"client.*smoke.*(?:json|structured|evidence)")

        self.prepare_fresh_case("headless-client-smoke")
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["clientSmoke"]["evidencePath"])
        payload = json.loads(evidence.read_text())
        payload["observationMode"] = "headless-import-export"
        payload["observations"]["applicationWindowVisible"] = False
        payload["observations"]["slideCanvasVisible"] = False
        evidence.write_text(json.dumps(payload))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"headless|gui|client.*smoke")

    def test_not_available_requires_external_deck_bound_user_open_evidence(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["clientSmoke"]["evidencePath"])
        evidence.write_text(json.dumps({
            "artifactType": "userOpenConfirmationEvidence",
            "schemaVersion": "1.0.0",
            "targetClient": "Microsoft PowerPoint",
            "openedArtifactHash": report["inputHashes"]["deck"],
            "userMessage": "I opened the delivered deck in Microsoft PowerPoint.",
            "confirmedAt": "2026-07-17T00:00:00.000Z",
        }))
        report["clientSmokeStatus"] = "NOT_RUN"
        report["clientSmoke"] = {
            "status": "not_available",
            "evidencePath": str(evidence),
            "evidenceSha256": f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}",
            "userFinalOpenConfirmation": True,
            "targetClient": "Microsoft PowerPoint",
            "openedArtifactHash": report["inputHashes"]["deck"],
        }
        report_path.write_text(json.dumps(report))
        self.sync_qa_gate_hash()
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)

        evidence.write_text(json.dumps({
            "artifactType": "clientSmokeUnavailableEvidence",
            "schemaVersion": "1.0.0",
            "targetClient": "Microsoft PowerPoint",
            "reason": "Only headless diagnostics were available",
        }))
        report = json.loads(report_path.read_text())
        report["clientSmoke"]["evidenceSha256"] = (
            f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
        )
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"user.*open|confirmation.*evidence|structured")

    def test_passed_client_target_must_match_hash_bound_theme_lock(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["clientSmoke"]["evidencePath"])
        payload = json.loads(evidence.read_text())
        payload["targetClient"] = "WPS Presentation"
        evidence.write_text(json.dumps(payload))
        report["clientSmoke"]["targetClient"] = "WPS Presentation"
        report["clientSmoke"]["evidenceSha256"] = (
            f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
        )
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"theme.?lock.*target|target.*client.*theme")

    def test_client_smoke_evidence_bytes_are_bound_for_passed_and_not_available(self):
        smoke_path = Path(json.loads(
            (self.workspace / "qa-report.json").read_text()
        )["clientSmoke"]["evidencePath"])
        passed_evidence = json.loads(smoke_path.read_text())
        passed_evidence["observedAt"] = "2026-07-18T00:00:00.000Z"
        smoke_path.write_text(json.dumps(passed_evidence))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"client.*smoke.*(?:hash|stale|evidence)")

        self.prepare_fresh_case("mutated-user-open-confirmation")
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["clientSmoke"]["evidencePath"])
        evidence.write_text(json.dumps({
            "artifactType": "userOpenConfirmationEvidence",
            "schemaVersion": "1.0.0",
            "targetClient": "Microsoft PowerPoint",
            "openedArtifactHash": report["inputHashes"]["deck"],
            "userMessage": "I opened the delivered deck in Microsoft PowerPoint.",
            "confirmedAt": "2026-07-17T00:00:00.000Z",
        }))
        report["clientSmokeStatus"] = "NOT_RUN"
        report["clientSmoke"] = {
            "status": "not_available",
            "evidencePath": str(evidence),
            "evidenceSha256": f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}",
            "userFinalOpenConfirmation": True,
            "targetClient": "Microsoft PowerPoint",
            "openedArtifactHash": report["inputHashes"]["deck"],
        }
        report_path.write_text(json.dumps(report))
        evidence_payload = json.loads(evidence.read_text())
        evidence_payload["userMessage"] = "This confirmation was changed after QA."
        evidence.write_text(json.dumps(evidence_payload))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"client.*smoke.*(?:hash|stale|evidence)")

    def test_rejects_missing_final_approval(self):
        self.write_state(approved=False)
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("final approval", result.stderr.lower())

    def test_rejects_missing_required_delivery_components(self):
        cases = [
            ("pptx", lambda: (self.delivery / "neutral.pptx").unlink()),
            ("pdf", lambda: (self.delivery / "neutral.pdf").unlink()),
            ("previews", lambda: shutil.rmtree(self.delivery / "previews")),
            ("production record", lambda: (self.delivery / "production-record.txt").unlink()),
        ]
        for label, remove in cases:
            case_root = Path(tempfile.mkdtemp(prefix=f"visual-first-ppt-missing-{label.replace(' ', '-')}-"))
            self.workspace = case_root / "workspace"
            self.delivery = case_root / "delivery"
            self.workspace.mkdir()
            self.delivery.mkdir()
            self.output = case_root / "delivery.zip"
            self.write_complete_delivery()
            self.write_qa_report()
            self.write_state(approved=True)
            remove()
            with self.subTest(component=label):
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(label, result.stderr.lower())

    def test_rejects_internal_json_in_delivery_directory(self):
        (self.delivery / "state.json").write_text("{}")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("internal", result.stderr.lower())

    def test_rejects_malformed_pptx_pdf_and_png(self):
        cases = [
            ("pptx", "neutral.pptx", b"not a pptx"),
            ("pdf", "neutral.pdf", b"not a pdf"),
            ("png", "previews/slide-1.png", b"not a png"),
        ]
        for label, relative_path, payload in cases:
            with self.subTest(file_type=label):
                self.prepare_fresh_case(f"malformed-{label}")
                (self.delivery / relative_path).write_bytes(payload)
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(label, result.stderr.lower())

    def test_rejects_empty_production_record(self):
        (self.delivery / "production-record.txt").write_bytes(b"")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("production record", result.stderr.lower())

    def test_rejects_preview_count_that_does_not_match_pptx_slide_count(self):
        (self.delivery / "previews" / "slide-1.png").unlink()
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertRegex(result.stderr.lower(), r"preview.*(?:count|slide)|slide.*preview")

    def test_rejects_duplicate_automated_check_ids(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["automatedChecks"].append(dict(report["automatedChecks"][0]))
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate", result.stderr.lower())

    def test_resolves_relative_and_absolute_evidence_paths(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["automatedChecks"][0]["evidencePath"] = "qa/pptxParse.json"
        report_path.write_text(json.dumps(report))
        self.sync_qa_gate_hash()
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)

        self.prepare_fresh_case("absolute-evidence")
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_resolves_all_relative_input_artifact_paths_from_workspace(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["inputArtifacts"]["deck"]["path"] = "../delivery/neutral.pptx"
        report["inputArtifacts"]["slideSpecs"]["path"] = "slide-specs.json"
        report["inputArtifacts"]["themeLock"]["path"] = "theme-lock.json"
        report_path.write_text(json.dumps(report))
        self.sync_qa_gate_hash()
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_compatibility_input_hash_mismatch(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["inputHashes"]["slideSpecs"] = "sha256:" + ("0" * 64)
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"inputhashes.*slidespecs.*hash")

    def test_rejects_missing_per_slide_review_checks(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report.pop("reviewChecks", None)
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("review", result.stderr.lower())

    def test_package_uses_the_strict_current_qa_contract(self):
        cases = [
            "missing-client-smoke",
            "legacy-client-smoke",
            "missing-review-evidence-hash",
            "missing-review-width",
            "missing-review-height",
            "missing-manual-evidence-hash",
            "missing-manual-width",
            "missing-manual-height",
            "missing-manual-dimension",
            "missing-tool-versions",
            "failed-extra-automated-check",
            "failed-extra-review-check",
            "client-smoke-status-mismatch",
            "user-confirmation-mismatch",
            "failed-final-verdict",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.prepare_fresh_case(f"strict-current-{case}")
                report_path = self.workspace / "qa-report.json"
                report = json.loads(report_path.read_text())
                if case == "missing-client-smoke":
                    report.pop("clientSmoke")
                elif case == "legacy-client-smoke":
                    report["clientSmoke"] = {
                        "status": "passed",
                        "evidencePath": report["clientSmoke"]["evidencePath"],
                        "userFinalOpenConfirmation": False,
                    }
                elif case.startswith("missing-review-"):
                    key = {
                        "missing-review-evidence-hash": "evidenceSha256",
                        "missing-review-width": "width",
                        "missing-review-height": "height",
                    }[case]
                    report["reviewChecks"][0].pop(key)
                elif case.startswith("missing-manual-") and case != "missing-manual-dimension":
                    key = {
                        "missing-manual-evidence-hash": "evidenceSha256",
                        "missing-manual-width": "width",
                        "missing-manual-height": "height",
                    }[case]
                    report["perSlideManualScores"][0].pop(key)
                elif case == "missing-manual-dimension":
                    report["perSlideManualScores"][0]["dimensions"].pop("readability")
                elif case == "missing-tool-versions":
                    report.pop("toolVersions")
                elif case == "failed-extra-automated-check":
                    report["automatedChecks"].append({
                        "id": "non-authorizing-extra-check",
                        "status": "FAIL",
                        "evidencePath": report["automatedChecks"][0]["evidencePath"],
                        "evidenceSha256": report["automatedChecks"][0]["evidenceSha256"],
                        "value": 1,
                    })
                elif case == "failed-extra-review-check":
                    report["reviewChecks"][0]["checks"]["nonAuthorizingExtraCheck"] = {
                        "status": "FAIL",
                        "notes": "must not be ignored",
                    }
                elif case == "client-smoke-status-mismatch":
                    report["clientSmokeStatus"] = "NOT_RUN"
                elif case == "user-confirmation-mismatch":
                    report["clientSmoke"]["userFinalOpenConfirmation"] = True
                else:
                    report["finalVerdict"] = "FAIL"
                report_path.write_text(json.dumps(report))

                result = self.run_package()
                self.assertNotEqual(
                    result.returncode,
                    0,
                    f"{case} unexpectedly passed the current QA packaging gate",
                )
                self.assertRegex(
                    result.stderr.lower(),
                    r"qa|current|schema|client|review|manual|verdict|check",
                )

    def test_rejects_qa_deck_hash_that_differs_from_delivered_pptx(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        report["inputArtifacts"]["deck"]["sha256"] = "sha256:" + ("0" * 64)
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"deck.*hash|hash.*deck|pptx")

    def test_rejects_stale_structured_evidence_hash(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = Path(report["automatedChecks"][0]["evidencePath"])
        evidence.write_text(evidence.read_text() + "\n")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"evidence.*(?:hash|stale)")

    def test_rejects_missing_wrong_and_version_mismatched_checkers(self):
        cases = [
            ("ooxml-missing", "textFramePolicy", None),
            ("ooxml-wrong-id", "textFramePolicy", {"id": "wrong-checker", "version": "1.0.0"}),
            ("ooxml-wrong-version", "textFramePolicy", {"id": "audit-pptx-quality", "version": "9.9.9"}),
            ("generic-missing", "pptxParse", None),
            ("generic-wrong-id", "pptxParse", {"id": "wrong-checker", "version": "1.0.0"}),
            ("generic-wrong-version", "pptxParse", {"id": "pptxParse", "version": "9.9.9"}),
        ]
        for label, check_id, checker in cases:
            with self.subTest(checker=label):
                self.prepare_fresh_case(f"checker-{label}")
                report_path = self.workspace / "qa-report.json"
                report = json.loads(report_path.read_text())
                record = next(
                    item for item in report["automatedChecks"]
                    if item["id"] == check_id
                )
                evidence = Path(record["evidencePath"])
                payload = json.loads(evidence.read_text())
                if checker is None:
                    payload.pop("checker", None)
                else:
                    payload["checker"] = checker
                evidence.write_text(json.dumps(payload))
                digest = f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
                for item in report["automatedChecks"]:
                    if item["evidencePath"] == str(evidence):
                        item["evidenceSha256"] = digest
                report_path.write_text(json.dumps(report))
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr.lower(), r"checker|schema|version")

    def test_rejects_generic_schema_bypasses_and_incomplete_ooxml_bundle(self):
        cases = ("missing-check", "wrong-check-id", "invalid-violations", "top-level-fallback")
        for case in cases:
            with self.subTest(case=case):
                self.prepare_fresh_case(f"generic-schema-{case}")
                report_path = self.workspace / "qa-report.json"
                report = json.loads(report_path.read_text())
                record = next(item for item in report["automatedChecks"] if item["id"] == "pptxParse")
                evidence = Path(record["evidencePath"])
                payload = json.loads(evidence.read_text())
                if case == "missing-check":
                    payload.pop("check")
                elif case == "wrong-check-id":
                    payload["checkId"] = "different-check"
                elif case == "invalid-violations":
                    payload["check"]["violations"] = "none"
                else:
                    payload.pop("check")
                    payload.update({
                        "id": "pptxParse", "status": "PASS", "value": 0,
                        "violations": [],
                    })
                evidence.write_text(json.dumps(payload))
                record["evidenceSha256"] = (
                    f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
                )
                report_path.write_text(json.dumps(report))
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(
                    result.stderr.lower(),
                    r"check|checkid|violations|additional|fields",
                )

        self.prepare_fresh_case("incomplete-ooxml-bundle")
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        record = next(item for item in report["automatedChecks"] if item["id"] == "textFramePolicy")
        evidence = Path(record["evidencePath"])
        payload = json.loads(evidence.read_text())
        payload["checks"].pop("safeMargin")
        evidence.write_text(json.dumps(payload))
        digest = f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}"
        for item in report["automatedChecks"]:
            if item["evidencePath"] == str(evidence):
                item["evidenceSha256"] = digest
        report_path.write_text(json.dumps(report))
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"checks.*missing|missing.*safemargin|fields")

    def test_rejects_mutated_slide_specs_and_theme_lock(self):
        for artifact_id in ("slideSpecs", "themeLock"):
            with self.subTest(artifact=artifact_id):
                self.prepare_fresh_case(f"stale-{artifact_id}")
                report = json.loads((self.workspace / "qa-report.json").read_text())
                artifact = Path(report["inputArtifacts"][artifact_id]["path"])
                artifact.write_text(artifact.read_text() + "\n")
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr.lower(), rf"{artifact_id.lower()}.*hash|hash.*{artifact_id.lower()}")

    def test_rejects_text_wrong_slide_and_reused_full_slide_evidence(self):
        cases = ("text", "wrong-slide", "reused")
        for case in cases:
            with self.subTest(case=case):
                self.prepare_fresh_case(f"full-slide-{case}")
                report_path = self.workspace / "qa-report.json"
                report = json.loads(report_path.read_text())
                if case == "text":
                    evidence = self.workspace / "slide-1.png"
                    evidence.write_text("not a PNG\n")
                    report["reviewChecks"][0]["evidencePath"] = str(evidence)
                elif case == "wrong-slide":
                    evidence = self.workspace / "wrong-page.png"
                    evidence.write_bytes(png_bytes())
                    report["reviewChecks"][0]["evidencePath"] = str(evidence)
                else:
                    report["reviewChecks"][1]["evidencePath"] = report["reviewChecks"][0]["evidencePath"]
                report_path.write_text(json.dumps(report))
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr.lower(), r"png|slide|unique|reuse|mapping")

    def test_rejects_corrupt_png_chunks_and_malformed_scanlines(self):
        short_scanlines = b"\x00" * ((9 * (1 + (16 * 3))) - 1)
        illegal_filter_scanlines = bytearray(b"\x00" * (9 * (1 + (16 * 3))))
        illegal_filter_scanlines[0] = 5
        cases = [
            ("wrong-crc", png_bytes(16, 9, corrupt_crc_kind=b"IDAT")),
            ("invalid-idat", png_bytes(16, 9, idat_payload=b"not-zlib")),
            ("illegal-ihdr", png_bytes(16, 9, color_type=3)),
            ("wrong-scanline-length", png_bytes(16, 9, raw_payload=short_scanlines)),
            ("illegal-filter", png_bytes(16, 9, raw_payload=bytes(illegal_filter_scanlines))),
        ]
        for label, payload in cases:
            with self.subTest(case=label):
                self.prepare_fresh_case(f"invalid-png-{label}")
                self.replace_preview_and_sync_report(payload)
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(
                    result.stderr.lower(),
                    r"png|crc|ihdr|idat|zlib|decompress|scanline|filter",
                )

    def test_rejects_non_ascii_chunk_aliases_and_extra_zlib_input(self):
        width, height = 16, 9
        row = b"\x00" + (b"\xff\xff\xff" * width)
        legal_stream = zlib.compress(row * height)
        cases = [
            (
                "high-bit-idat-alias",
                replace_chunk_type(
                    png_bytes(width, height), b"IDAT", bytes([0xC9, 0x44, 0x41, 0x54])
                ),
            ),
            (
                "garbage-after-zlib-stream",
                png_bytes(width, height, idat_payload=legal_stream + b"junk"),
            ),
            (
                "second-zlib-stream",
                png_bytes(
                    width,
                    height,
                    idat_payload=legal_stream + zlib.compress(b"extra"),
                ),
            ),
        ]
        for label, payload in cases:
            with self.subTest(case=label):
                self.prepare_fresh_case(f"ambiguous-png-{label}")
                self.replace_preview_and_sync_report(payload, width=width, height=height)
                result = self.run_package()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(
                    result.stderr.lower(),
                    r"png|chunk type|ascii|idat|zlib|trailing|stream|compressed input",
                )

    def test_rejects_preview_with_wrong_canvas_aspect_ratio(self):
        self.replace_preview_and_sync_report(png_bytes(1, 1), width=1, height=1)
        self.sync_qa_gate_hash()
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"aspect|canvas")

    def test_rejects_stale_full_slide_evidence_metadata(self):
        (self.delivery / "previews" / "slide-1.png").write_bytes(
            png_bytes(1600, 900, shade=17)
        )
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"evidence.*(?:hash|stale)|metadata")

    def test_rejects_full_slide_evidence_not_bound_to_delivery_preview(self):
        report_path = self.workspace / "qa-report.json"
        report = json.loads(report_path.read_text())
        evidence = self.workspace / "qa" / "slide-1.png"
        evidence.write_bytes(png_bytes(1600, 900, shade=7))
        record = report["reviewChecks"][0]
        record.update({
            "evidencePath": str(evidence),
            "evidenceSha256": f"sha256:{hashlib.sha256(evidence.read_bytes()).hexdigest()}",
            "width": 1600,
            "height": 900,
        })
        report["evidencePaths"] = sorted(set([
            *report["evidencePaths"],
            str(evidence),
        ]))
        report_path.write_text(json.dumps(report))
        self.sync_qa_gate_hash()
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r"delivery.*preview|preview.*evidence|bound")


if __name__ == "__main__":
    unittest.main()
