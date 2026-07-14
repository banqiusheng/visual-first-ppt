import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from zipfile import ZipFile


SCRIPT = Path("skills/visual-first-ppt/scripts/package_delivery.py").resolve()
VALID_PPTX = Path("tests/fixtures/baseline/template-source.pptx").resolve()


def png_bytes(width=1600, height=900):
    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\x00" + (b"\xff\xff\xff" * width)
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(row * height, level=9)),
        chunk(b"IEND", b""),
    ])


def pdf_bytes(page_count):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            f"<< /Type /Pages /Kids [{' '.join(f'{3 + (index * 2)} 0 R' for index in range(page_count))}] "
            f"/Count {page_count} >>"
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
            b"<< /Length 0 >>\nstream\n\nendstream",
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
        self.write_state(approved=True)
        self.write_qa_report()

    def prepare_paths(self, root):
        self.root = root
        self.workspace = self.root / "workspace"
        self.delivery = self.root / "delivery"
        self.workspace.mkdir()
        self.delivery.mkdir()
        self.output = self.root / "neutral-delivery.zip"

    def write_state(self, approved):
        deck_hash = hashlib.sha256((self.delivery / "neutral.pptx").read_bytes()).hexdigest()
        approvals = {
            "final": {
                "approvedArtifactHash": f"sha256:{deck_hash}",
                "approvedAt": "2026-07-13T00:00:00.000Z",
                "userMessage": "Approved test delivery",
            }
        } if approved else {}
        (self.workspace / "state.json").write_text(json.dumps({
            "artifactType": "state",
            "schemaVersion": "1.0.0",
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
            (previews / f"slide-{slide}.png").write_bytes(preview)
        (self.delivery / "production-record.txt").write_text("verified production record\n")

    def write_qa_report(self):
        qa_dir = self.workspace / "qa"
        qa_dir.mkdir(exist_ok=True)
        required_checks = [
            "pptxParse", "pdfParse", "pageCountAndCanvas", "overflow",
            "unexpectedOverlap", "unresolvedPlaceholder", "brokenRelationship",
            "fontAvailability", "nativeObjectTypes", "dataMismatch",
            "pptxPdfPreviewParity",
        ]
        automated = []
        evidence_paths = []
        for check_id in required_checks:
            evidence = qa_dir / f"{check_id}.txt"
            evidence.write_text("PASS\n")
            evidence_paths.append(str(evidence))
            check = {"id": check_id, "status": "PASS", "evidencePath": str(evidence)}
            if check_id in {
                "overflow", "unexpectedOverlap", "unresolvedPlaceholder",
                "brokenRelationship", "dataMismatch",
            }:
                check["value"] = 0
            automated.append(check)
        manual = []
        for slide in range(1, self.slide_count + 1):
            evidence = self.delivery / "previews" / f"slide-{slide}.png"
            evidence_paths.append(str(evidence))
            manual.append({
                "slide": slide,
                "score": 5,
                "dimensions": {
                    "readability": 5,
                    "visualConsistency": 5,
                    "imageIntegrity": 5,
                    "visualContractFidelity": 5,
                },
                "reviewer": "unit-test",
                "evidencePath": str(evidence),
            })
        smoke = qa_dir / "client-smoke.txt"
        smoke.write_text("PASS\n")
        evidence_paths.append(str(smoke))
        (self.workspace / "qa-report.json").write_text(json.dumps({
            "artifactType": "qaReport",
            "schemaVersion": "1.0.0",
            "projectId": "ppt-package-test",
            "route": "create",
            "inputHashes": {
                "deck": f"sha256:{hashlib.sha256((self.delivery / 'neutral.pptx').read_bytes()).hexdigest()}"
            },
            "toolVersions": {"python": sys.version.split()[0]},
            "automatedChecks": automated,
            "perSlideManualScores": manual,
            "clientSmokeStatus": "PASS",
            "clientSmoke": {
                "status": "passed",
                "evidencePath": str(smoke),
                "userFinalOpenConfirmation": False,
            },
            "evidencePaths": evidence_paths,
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

    def prepare_fresh_case(self, label):
        root = Path(tempfile.mkdtemp(prefix=f"visual-first-ppt-{label}-"))
        self.prepare_paths(root)
        self.write_complete_delivery()
        self.write_state(approved=True)
        self.write_qa_report()

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
            self.write_state(approved=True)
            self.write_qa_report()
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


if __name__ == "__main__":
    unittest.main()
