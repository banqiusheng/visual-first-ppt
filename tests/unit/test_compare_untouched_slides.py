import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


SCRIPT = Path("skills/visual-first-ppt/scripts/compare_untouched_slides.py").resolve()


def slide_xml(text, attributes='a="1" b="2"'):
    return (
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        f'<p:cSld {attributes}><p:sp><p:txBody>{text}</p:txBody></p:sp></p:cSld>'
        '</p:sld>'
    )


def rel_xml(target):
    return (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="image" Target="{target}"/>'
        '</Relationships>'
    )


class CompareUntouchedSlidesTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="visual-first-ppt-compare-"))
        self.source = self.root / "source.pptx"
        self.output = self.root / "output.pptx"
        self.source_render = self.root / "source-render"
        self.output_render = self.root / "output-render"
        self.source_render.mkdir()
        self.output_render.mkdir()

    def write_deck(
        self, target, slides, relationships=None, package_parts=None,
        package_compression=ZIP_DEFLATED,
    ):
        relationships = relationships or {}
        package_parts = package_parts or {}
        with ZipFile(target, "w", ZIP_DEFLATED) as archive:
            for number, xml in slides.items():
                archive.writestr(f"ppt/slides/slide{number}.xml", xml)
                archive.writestr(
                    f"ppt/slides/_rels/slide{number}.xml.rels",
                    relationships.get(number, rel_xml(f"../media/image{number}.png")),
                )
            for member, content in package_parts.items():
                archive.writestr(member, content, compress_type=package_compression)

    def write_renders(self, source_bytes=None, output_bytes=None):
        source_bytes = source_bytes or {1: b"one", 2: b"two", 3: b"three"}
        output_bytes = output_bytes or dict(source_bytes)
        for number, content in source_bytes.items():
            (self.source_render / f"slide-{number}.png").write_bytes(content)
        for number, content in output_bytes.items():
            (self.output_render / f"slide-{number}.png").write_bytes(content)

    def run_compare(self, authorized="2"):
        report = self.root / "comparison.json"
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--source", str(self.source),
                "--output", str(self.output),
                "--source-render-dir", str(self.source_render),
                "--output-render-dir", str(self.output_render),
                "--authorized-slides", authorized,
                "--report", str(report),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        payload = json.loads(report.read_text()) if report.exists() else None
        return result, payload

    def baseline_slides(self):
        return {1: slide_xml("Alpha"), 2: slide_xml("Beta"), 3: slide_xml("Gamma")}

    def baseline_global_parts(self):
        return {
            "ppt/presentation.xml": b'<p:presentation xmlns:p="urn:p"><p:sldIdLst/></p:presentation>',
            "ppt/theme/theme1.xml": b'<a:theme xmlns:a="urn:a" name="blue"/>',
            "ppt/slideMasters/slideMaster1.xml": b'<p:sldMaster xmlns:p="urn:p" name="master-a"/>',
            "ppt/media/image1.png": b"shared-media-a",
        }

    def test_identical_unauthorized_slides_pass_and_authorized_changes_are_ignored(self):
        source_slides = self.baseline_slides()
        output_slides = dict(source_slides)
        output_slides[2] = slide_xml("Authorized rewrite")
        self.write_deck(self.source, source_slides)
        self.write_deck(self.output, output_slides, {2: rel_xml("../media/revised.png")})
        self.write_renders(output_bytes={1: b"one", 2: b"changed", 3: b"three"})

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["finalVerdict"], "PASS")
        self.assertEqual(report["changedUnauthorizedSlides"], [])
        self.assertEqual(report["authorizedSlides"], [2])

    def test_xml_whitespace_and_attribute_order_are_canonicalized(self):
        source_slides = self.baseline_slides()
        output_slides = dict(source_slides)
        output_slides[1] = slide_xml("  Alpha  ", 'b="2" a="1"')
        self.write_deck(self.source, source_slides)
        self.write_deck(self.output, output_slides)
        self.write_renders()

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["slides"][0]["xmlMatch"], True)

    def test_semantic_xml_change_fails(self):
        source_slides = self.baseline_slides()
        output_slides = dict(source_slides)
        output_slides[3] = slide_xml("Different conclusion")
        self.write_deck(self.source, source_slides)
        self.write_deck(self.output, output_slides)
        self.write_renders()

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["changedUnauthorizedSlides"], [3])
        self.assertFalse(report["slides"][2]["xmlMatch"])

    def test_relationship_target_change_fails(self):
        slides = self.baseline_slides()
        self.write_deck(self.source, slides)
        self.write_deck(self.output, slides, {1: rel_xml("../media/other.png")})
        self.write_renders()

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(report["slides"][0]["relationshipsMatch"])

    def test_any_png_byte_change_fails(self):
        slides = self.baseline_slides()
        self.write_deck(self.source, slides)
        self.write_deck(self.output, slides)
        self.write_renders(output_bytes={1: b"one-modified", 2: b"two", 3: b"three"})

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(report["slides"][0]["renderMatch"])

    def test_global_theme_master_presentation_and_shared_part_changes_fail(self):
        changed_parts = [
            "ppt/theme/theme1.xml",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/presentation.xml",
            "ppt/media/image1.png",
        ]
        for member in changed_parts:
            with self.subTest(member=member):
                source_parts = self.baseline_global_parts()
                output_parts = dict(source_parts)
                output_parts[member] = source_parts[member] + b"-changed"
                slides = self.baseline_slides()
                self.write_deck(self.source, slides, package_parts=source_parts)
                self.write_deck(self.output, slides, package_parts=output_parts)
                self.write_renders()

                result, report = self.run_compare()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(report["finalVerdict"], "FAIL")
                self.assertIn(member, report.get("changedGlobalParts", []))

    def test_report_records_source_and_output_deck_hashes(self):
        slides = self.baseline_slides()
        parts = self.baseline_global_parts()
        self.write_deck(self.source, slides, package_parts=parts)
        self.write_deck(self.output, slides, package_parts=parts)
        self.write_renders()

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report.get("deckHashes"), {
            "source": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "output": hashlib.sha256(self.output.read_bytes()).hexdigest(),
        })

    def test_identical_large_opaque_media_is_stream_hashed_without_rejection(self):
        slides = self.baseline_slides()
        large_media = b"opaque-media-0123456789" * (17 * 1024 * 1024 // 23 + 1)
        parts = {
            **self.baseline_global_parts(),
            "ppt/media/training-video.mp4": large_media,
        }
        self.write_deck(
            self.source, slides, package_parts=parts, package_compression=ZIP_STORED,
        )
        self.write_deck(
            self.output, slides, package_parts=parts, package_compression=ZIP_STORED,
        )
        self.write_renders()

        result, report = self.run_compare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["finalVerdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
