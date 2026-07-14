#!/usr/bin/env python3

import argparse
import hashlib
import json
import pathlib
import zipfile
import xml.etree.ElementTree as ElementTree


SLIDE_PREFIX = "ppt/slides/slide"
SLIDE_SUFFIX = ".xml"


def _sha256(content):
    return hashlib.sha256(content).hexdigest()


def _deck_hash(path):
    return _sha256(path.read_bytes())


def _normalized_text(value):
    return "" if value is None else value.strip()


def _element_signature(element):
    return [
        element.tag,
        [[name, value] for name, value in sorted(element.attrib.items())],
        _normalized_text(element.text),
        [
            [_element_signature(child), _normalized_text(child.tail)]
            for child in list(element)
        ],
    ]


def _canonical_xml(content):
    root = ElementTree.fromstring(content)
    signature = _element_signature(root)
    return json.dumps(
        signature,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _parse_authorized_slides(value):
    if not value.strip():
        return []

    slide_numbers = set()
    for item in value.split(","):
        item = item.strip()
        if not item:
            raise argparse.ArgumentTypeError(
                "authorized slides must be a comma-separated list of positive integers"
            )
        try:
            slide_number = int(item)
        except ValueError as error:
            raise argparse.ArgumentTypeError(
                "authorized slides must be a comma-separated list of positive integers"
            ) from error
        if slide_number < 1:
            raise argparse.ArgumentTypeError(
                "authorized slide numbers must be positive integers"
            )
        slide_numbers.add(slide_number)
    return sorted(slide_numbers)


def _slide_numbers(archive):
    numbers = set()
    for member in archive.namelist():
        if not member.startswith(SLIDE_PREFIX) or not member.endswith(SLIDE_SUFFIX):
            continue
        number_text = member[len(SLIDE_PREFIX) : -len(SLIDE_SUFFIX)]
        if number_text.isdigit():
            numbers.add(int(number_text))
    return numbers


def _is_slide_scoped_member(member):
    if member.startswith("ppt/slides/slide") and member.endswith(".xml"):
        number = member[len("ppt/slides/slide") : -len(".xml")]
        return number.isdigit()
    prefix = "ppt/slides/_rels/slide"
    suffix = ".xml.rels"
    if member.startswith(prefix) and member.endswith(suffix):
        number = member[len(prefix) : -len(suffix)]
        return number.isdigit()
    return False


def _global_member_hash(archive, member):
    payload = archive.read(member)
    if member.endswith(".xml") or member.endswith(".rels"):
        try:
            payload = _canonical_xml(payload)
        except (ElementTree.ParseError, ValueError):
            pass
    return _sha256(payload)


def _changed_global_parts(source_archive, output_archive):
    source_members = {
        name
        for name in source_archive.namelist()
        if not name.endswith("/") and not _is_slide_scoped_member(name)
    }
    output_members = {
        name
        for name in output_archive.namelist()
        if not name.endswith("/") and not _is_slide_scoped_member(name)
    }
    changed = []
    for member in sorted(source_members | output_members):
        if member not in source_members or member not in output_members:
            changed.append(member)
            continue
        if _global_member_hash(source_archive, member) != _global_member_hash(output_archive, member):
            changed.append(member)
    return changed


def _archive_evidence_path(deck_path, member):
    return f"{deck_path.resolve()}!/{member}"


def _xml_evidence(archive, deck_path, member):
    evidence = {
        "path": _archive_evidence_path(deck_path, member),
        "exists": member in archive.namelist(),
        "valid": False,
        "sha256": None,
        "error": None,
    }
    if not evidence["exists"]:
        evidence["error"] = "missing"
        return evidence

    try:
        evidence["sha256"] = _sha256(_canonical_xml(archive.read(member)))
        evidence["valid"] = True
    except (ElementTree.ParseError, ValueError) as error:
        evidence["error"] = str(error)
    return evidence


def _render_evidence(render_dir, slide_number):
    candidates = [
        render_dir / f"slide-{slide_number}.png",
        render_dir / f"slide{slide_number}.png",
        render_dir / f"{slide_number}.png",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return {
                "path": str(candidate.resolve()),
                "exists": True,
                "sha256": _sha256(candidate.read_bytes()),
            }
    return {
        "path": str(candidates[0].resolve()),
        "exists": False,
        "sha256": None,
    }


def _xml_match(source, output):
    return (
        source["exists"]
        and output["exists"]
        and source["valid"]
        and output["valid"]
        and source["sha256"] == output["sha256"]
    )


def _relationships_match(source, output):
    if not source["exists"] and not output["exists"]:
        return True
    return _xml_match(source, output)


def _render_match(source, output):
    return (
        source["exists"]
        and output["exists"]
        and source["sha256"] == output["sha256"]
    )


def _compare_slide(
    slide_number,
    authorized,
    source_archive,
    output_archive,
    source_path,
    output_path,
    source_render_dir,
    output_render_dir,
):
    slide_member = f"ppt/slides/slide{slide_number}.xml"
    relationships_member = (
        f"ppt/slides/_rels/slide{slide_number}.xml.rels"
    )

    source_xml = _xml_evidence(source_archive, source_path, slide_member)
    output_xml = _xml_evidence(output_archive, output_path, slide_member)
    source_relationships = _xml_evidence(
        source_archive, source_path, relationships_member
    )
    output_relationships = _xml_evidence(
        output_archive, output_path, relationships_member
    )
    source_render = _render_evidence(source_render_dir, slide_number)
    output_render = _render_evidence(output_render_dir, slide_number)

    xml_match = _xml_match(source_xml, output_xml)
    relationships_match = _relationships_match(
        source_relationships, output_relationships
    )
    render_match = _render_match(source_render, output_render)

    return {
        "slide": slide_number,
        "authorized": authorized,
        "xmlMatch": xml_match,
        "relationshipsMatch": relationships_match,
        "renderMatch": render_match,
        "hashes": {
            "sourceXml": source_xml["sha256"],
            "outputXml": output_xml["sha256"],
            "sourceRelationships": source_relationships["sha256"],
            "outputRelationships": output_relationships["sha256"],
            "sourceRender": source_render["sha256"],
            "outputRender": output_render["sha256"],
        },
        "evidencePaths": {
            "sourceXml": source_xml["path"],
            "outputXml": output_xml["path"],
            "sourceRelationships": source_relationships["path"],
            "outputRelationships": output_relationships["path"],
            "sourceRender": source_render["path"],
            "outputRender": output_render["path"],
        },
    }


def _comparison_report(arguments):
    authorized_slides = arguments.authorized_slides
    authorized = set(authorized_slides)
    slides = []
    errors = []
    changed_global_parts = []

    try:
        with zipfile.ZipFile(arguments.source, "r") as source_archive:
            with zipfile.ZipFile(arguments.output, "r") as output_archive:
                slide_numbers = sorted(
                    _slide_numbers(source_archive) | _slide_numbers(output_archive)
                )
                if not slide_numbers:
                    errors.append("source and output contain no slide XML files")
                changed_global_parts = _changed_global_parts(source_archive, output_archive)
                for slide_number in slide_numbers:
                    slides.append(
                        _compare_slide(
                            slide_number,
                            slide_number in authorized,
                            source_archive,
                            output_archive,
                            arguments.source,
                            arguments.output,
                            arguments.source_render_dir,
                            arguments.output_render_dir,
                        )
                    )
    except (OSError, zipfile.BadZipFile) as error:
        errors.append(str(error))

    changed_unauthorized = [
        slide["slide"]
        for slide in slides
        if not slide["authorized"]
        and not (
            slide["xmlMatch"]
            and slide["relationshipsMatch"]
            and slide["renderMatch"]
        )
    ]
    verdict = "PASS" if not changed_unauthorized and not changed_global_parts and not errors else "FAIL"
    report = {
        "finalVerdict": verdict,
        "authorizedSlides": authorized_slides,
        "changedUnauthorizedSlides": changed_unauthorized,
        "changedGlobalParts": changed_global_parts,
        "deckHashes": {
            "source": _deck_hash(arguments.source),
            "output": _deck_hash(arguments.output),
        },
        "slides": slides,
    }
    if errors:
        report["errors"] = errors
    return report


def _write_report(report_path, report):
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _parser():
    parser = argparse.ArgumentParser(
        description="Compare XML, relationships, and renders for untouched PPTX slides."
    )
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--source-render-dir", required=True, type=pathlib.Path)
    parser.add_argument("--output-render-dir", required=True, type=pathlib.Path)
    parser.add_argument(
        "--authorized-slides",
        required=True,
        type=_parse_authorized_slides,
    )
    parser.add_argument("--report", required=True, type=pathlib.Path)
    return parser


def main():
    arguments = _parser().parse_args()
    report = _comparison_report(arguments)
    _write_report(arguments.report, report)
    print(f"{report['finalVerdict']}: {arguments.report}")
    return 0 if report["finalVerdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
