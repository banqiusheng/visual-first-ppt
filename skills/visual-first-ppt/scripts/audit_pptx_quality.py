#!/usr/bin/env python3
"""Produce deterministic OOXML quality evidence for an editable PPTX."""

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import posixpath
import re
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from lib.zip_safety import read_zip_member, validate_zip_archive


EMU_PER_INCH = 914400
NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}
CHECK_IDS = (
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
)
RESOLVED_FONT_ROLES = ("cjkTitle", "cjkBody", "latin", "number")
FONT_DECLARATION_QNAMES = {
    role: f"{{{NS['a']}}}{role}"
    for role in ("ea", "latin", "sym")
}
SLIDE_RELATIONSHIP_TYPES = frozenset({
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/slide",
})
DRAWINGML_NAMESPACES = frozenset({
    NS["a"],
    "http://purl.oclc.org/ooxml/drawingml/main",
})
POWERPOINT_2010_NAMESPACE = "http://schemas.microsoft.com/office/powerpoint/2010/main"
MEDIA_MARKER_QNAMES = frozenset({
    *(f"{{{namespace}}}{kind}"
      for namespace in DRAWINGML_NAMESPACES
      for kind in ("audioFile", "videoFile")),
    f"{{{POWERPOINT_2010_NAMESPACE}}}media",
})


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def parse_slide_number(member_name):
    match = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", member_name)
    return int(match.group(1)) if match else None


def normalized(value):
    return "\n".join(" ".join(line.split()) for line in value.splitlines())


def shape_id(shape):
    properties = shape.find(".//p:cNvPr", NS)
    return properties.get("id") if properties is not None else ""


def shape_name(shape):
    properties = shape.find(".//p:cNvPr", NS)
    return properties.get("name", "") if properties is not None else ""


def shape_bounds(shape):
    transform = shape.find("./p:spPr/a:xfrm", NS)
    if transform is None and local_name(shape.tag) == "graphicFrame":
        transform = shape.find("./p:xfrm", NS)
    if transform is None:
        return None
    if transform.get("rot") not in {None, "0"}:
        return None
    if transform.get("flipH") not in {None, "0", "false"}:
        return None
    if transform.get("flipV") not in {None, "0", "false"}:
        return None
    offset = transform.find("a:off", NS)
    extent = transform.find("a:ext", NS)
    if offset is None or extent is None:
        return None
    try:
        bounds = {
            "x": int(offset.get("x")),
            "y": int(offset.get("y")),
            "cx": int(extent.get("cx")),
            "cy": int(extent.get("cy")),
        }
    except (TypeError, ValueError):
        return None
    if bounds["cx"] <= 0 or bounds["cy"] <= 0:
        return None
    return bounds


def identity_transform():
    return {
        "scaleX": Fraction(1),
        "scaleY": Fraction(1),
        "translateX": Fraction(0),
        "translateY": Fraction(0),
    }


def group_child_transform(group):
    transform = group.find("./p:grpSpPr/a:xfrm", NS)
    if transform is None:
        return None
    if transform.get("rot") not in {None, "0"}:
        return None
    if transform.get("flipH") not in {None, "0", "false"}:
        return None
    if transform.get("flipV") not in {None, "0", "false"}:
        return None
    offset = transform.find("a:off", NS)
    extent = transform.find("a:ext", NS)
    child_offset = transform.find("a:chOff", NS)
    child_extent = transform.find("a:chExt", NS)
    if None in {offset, extent, child_offset, child_extent}:
        return None
    try:
        off_x = int(offset.get("x"))
        off_y = int(offset.get("y"))
        ext_cx = int(extent.get("cx"))
        ext_cy = int(extent.get("cy"))
        child_off_x = int(child_offset.get("x"))
        child_off_y = int(child_offset.get("y"))
        child_ext_cx = int(child_extent.get("cx"))
        child_ext_cy = int(child_extent.get("cy"))
    except (TypeError, ValueError):
        return None
    if ext_cx <= 0 or ext_cy <= 0 or child_ext_cx <= 0 or child_ext_cy <= 0:
        return None
    scale_x = Fraction(ext_cx, child_ext_cx)
    scale_y = Fraction(ext_cy, child_ext_cy)
    return {
        "scaleX": scale_x,
        "scaleY": scale_y,
        "translateX": Fraction(off_x) - scale_x * child_off_x,
        "translateY": Fraction(off_y) - scale_y * child_off_y,
    }


def compose_transforms(parent, child):
    if parent is None or child is None:
        return None
    return {
        "scaleX": parent["scaleX"] * child["scaleX"],
        "scaleY": parent["scaleY"] * child["scaleY"],
        "translateX": (
            parent["scaleX"] * child["translateX"] + parent["translateX"]
        ),
        "translateY": (
            parent["scaleY"] * child["translateY"] + parent["translateY"]
        ),
    }


def transformed_shape_bounds(shape, transform):
    bounds = shape_bounds(shape)
    if bounds is None or transform is None:
        return None
    return {
        "x": transform["scaleX"] * bounds["x"] + transform["translateX"],
        "y": transform["scaleY"] * bounds["y"] + transform["translateY"],
        "cx": transform["scaleX"] * bounds["cx"],
        "cy": transform["scaleY"] * bounds["cy"],
    }


def grouped_page_numbers(
    container, bound_roles_by_shape=None, transform=None, inside_group=False,
):
    bound_roles_by_shape = bound_roles_by_shape or {}
    if transform is None and not inside_group:
        transform = identity_transform()
    for child in list(container):
        if local_name(child.tag) == "grpSp":
            yield from grouped_page_numbers(
                child,
                bound_roles_by_shape,
                compose_transforms(transform, group_child_transform(child)),
                True,
            )
        elif inside_group and is_page_number(
            child, bound_roles_by_shape.get(shape_id(child)),
        ):
            yield child, transformed_shape_bounds(child, transform)


def positioned_auditable_shapes(container, transform=None):
    if transform is None:
        transform = identity_transform()
    for child in list(container):
        kind = local_name(child.tag)
        if kind == "grpSp":
            yield from positioned_auditable_shapes(
                child,
                compose_transforms(transform, group_child_transform(child)),
            )
        elif kind in {"sp", "pic", "cxnSp", "graphicFrame"}:
            yield child, transformed_shape_bounds(child, transform)


def json_emu(value):
    if isinstance(value, Fraction):
        if value.denominator == 1:
            return value.numerator
        return value.numerator / value.denominator
    return value


def shape_has_pure_numeric_text(shape):
    text = "".join(node.text or "" for node in shape.findall(".//a:t", NS))
    compact = "".join(text.split())
    return bool(compact) and compact.isdigit()


def is_title_shape(shape):
    placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", NS)
    if placeholder is not None and placeholder.get("type") in {"title", "ctrTitle"}:
        return True
    name = shape_name(shape).strip().casefold()
    return bool(
        re.search(r"(?<![a-z])title(?![a-z])", name)
        or re.fullmatch(r"标题(?:[ _-]*\d+)?", name)
    )


def allowed_resolved_font_roles(shape, declaration_role, typography_role=None):
    role = typography_role or typography_role_for_shape(shape)
    if declaration_role == "latin":
        roles = ["latin"]
        if role == "pageNumber" and shape_has_pure_numeric_text(shape):
            roles.append("number")
        return roles
    if declaration_role == "ea":
        return ["cjkTitle"] if role == "title" else ["cjkBody"]
    return []


def is_east_asian_script(character):
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
        or 0x20000 <= codepoint <= 0x2FA1F
        or 0x3040 <= codepoint <= 0x30FF
        or 0x31F0 <= codepoint <= 0x31FF
        or 0xFF66 <= codepoint <= 0xFF9D
        or 0x1100 <= codepoint <= 0x11FF
        or 0x3130 <= codepoint <= 0x318F
        or 0xA960 <= codepoint <= 0xA97F
        or 0xAC00 <= codepoint <= 0xD7AF
        or 0xD7B0 <= codepoint <= 0xD7FF
    )


def is_latin_letter(character):
    codepoint = ord(character)
    return (
        0x0041 <= codepoint <= 0x005A
        or 0x0061 <= codepoint <= 0x007A
        or 0x00C0 <= codepoint <= 0x02AF
        or 0x1D00 <= codepoint <= 0x1D7F
        or 0x1E00 <= codepoint <= 0x1EFF
        or 0xAB30 <= codepoint <= 0xAB6F
    )


def required_font_roles(text):
    roles = []
    if any(is_east_asian_script(character) for character in text):
        roles.append("ea")
    if any(is_latin_letter(character) for character in text):
        roles.append("latin")
    if not roles and text.strip():
        roles.append("latin")
    return roles


def font_declaration(properties, declaration_role):
    if properties is None:
        return None
    expected_qname = FONT_DECLARATION_QNAMES.get(declaration_role)
    if expected_qname is None:
        return None
    for child in list(properties):
        if child.tag != expected_qname:
            continue
        size = properties.get("sz")
        try:
            size_pt = int(size) / 100 if size is not None else None
        except ValueError:
            size_pt = None
        return {
            "declarationRole": declaration_role,
            "typeface": child.get("typeface"),
            "sizePt": size_pt,
        }
    return None


def shape_text_bodies(shape):
    bodies = []
    direct = shape.find("./p:txBody", NS)
    if direct is not None:
        bodies.append(direct)
    bodies.extend(shape.findall(".//a:tc/a:txBody", NS))
    return bodies


def auditable_shapes(container):
    for child in list(container):
        kind = local_name(child.tag)
        if kind == "grpSp":
            yield from auditable_shapes(child)
        elif kind in {"sp", "cxnSp", "graphicFrame"}:
            yield child


def effective_font_size(run_properties, default_properties):
    for properties in (run_properties, default_properties):
        if properties is None:
            continue
        raw = properties.get("sz")
        if raw is None:
            continue
        try:
            return int(raw) / 100
        except (TypeError, ValueError):
            return None
    return None


def typography_role_for_shape(shape):
    if is_page_number(shape):
        return "pageNumber"
    if is_title_shape(shape):
        return "title"
    name = shape_name(shape).strip().casefold()
    if re.search(r"caption|图注|表注", name):
        return "caption"
    if re.search(r"source|来源|出处|脚注|footnote", name):
        return "source"
    return "body"


def font_violations_for_shape(
    shape, slide_number, expected_fonts, slide_spec, bound_typography_role=None,
):
    violations = []
    identifier = shape_id(shape)
    typography_budget = slide_spec.get("typographyBudget")
    role = bound_typography_role or typography_role_for_shape(shape)
    role_budget = typography_budget.get(role) if isinstance(typography_budget, dict) else None
    minimum_pt = role_budget.get("minimumPt") if isinstance(role_budget, dict) else None
    size_violation_reported = False
    for text_body in shape_text_bodies(shape):
        for paragraph in text_body.findall("./a:p", NS):
            default_properties = paragraph.find("./a:pPr/a:defRPr", NS)
            for run in list(paragraph):
                text_kind = local_name(run.tag)
                if text_kind not in {"r", "fld"}:
                    continue
                text = "".join(node.text or "" for node in run.findall(".//a:t", NS))
                if not text.strip():
                    continue
                run_properties = run.find("./a:rPr", NS)
                if isinstance(minimum_pt, (int, float)) and not isinstance(minimum_pt, bool):
                    actual_pt = effective_font_size(run_properties, default_properties)
                    if not size_violation_reported and (actual_pt is None or actual_pt < minimum_pt):
                        details = {
                            "shapeId": identifier,
                            "textKind": text_kind,
                            "typographyRole": role,
                            "minimumPt": minimum_pt,
                        }
                        if actual_pt is not None:
                            details["actualPt"] = actual_pt
                        violations.append(violation(
                            "FONT_SIZE_BELOW_SPEC", slide_number,
                            "effective OOXML font size is below the declared slide-spec minimum",
                            **details,
                        ))
                        size_violation_reported = True
                for required_role in required_font_roles(text):
                    declaration = font_declaration(run_properties, required_role)
                    if declaration is None:
                        declaration = font_declaration(default_properties, required_role)
                    if declaration is None:
                        violations.append(violation(
                            "MISSING_FONT_DECLARATION", slide_number,
                            "nonempty text has no effective font declaration for its script",
                            shapeId=identifier,
                            textKind=text_kind,
                            requiredDeclarationRole=required_role,
                            missingRunCount=1,
                        ))
                        continue
                    typeface = declaration["typeface"]
                    if not isinstance(typeface, str) or not typeface.strip():
                        violations.append(violation(
                            "INVALID_FONT_DECLARATION", slide_number,
                            "font declaration typeface is missing or empty",
                            shapeId=identifier,
                            textKind=text_kind,
                            requiredDeclarationRole=required_role,
                            declarationRole=declaration["declarationRole"],
                            typeface=typeface,
                            sizePt=declaration["sizePt"],
                        ))
                        continue
                    allowed_roles = allowed_resolved_font_roles(
                        shape, required_role, role,
                    )
                    if typeface.strip().casefold() not in {
                        expected_fonts[role] for role in allowed_roles
                    }:
                        violations.append(violation(
                            "UNRESOLVED_FONT", slide_number,
                            "text font differs from the resolved theme-lock role",
                            shapeId=identifier,
                            textKind=text_kind,
                            requiredDeclarationRole=required_role,
                            declarationRole=declaration["declarationRole"],
                            allowedResolvedRoles=allowed_roles,
                            typeface=typeface,
                            sizePt=declaration["sizePt"],
                        ))
    return violations


def canonical_resolved_fonts(theme_lock):
    if not isinstance(theme_lock, dict):
        raise ValueError("themeLock must be an object with canonical resolvedFonts")
    fonts = theme_lock.get("resolvedFonts")
    if not isinstance(fonts, dict):
        raise ValueError(
            "themeLock.resolvedFonts must be an object with exactly canonical font roles: "
            + ", ".join(RESOLVED_FONT_ROLES)
        )
    missing = [role for role in RESOLVED_FONT_ROLES if role not in fonts]
    extra = sorted(set(fonts) - set(RESOLVED_FONT_ROLES))
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unsupported {', '.join(extra)}")
        raise ValueError(
            "themeLock.resolvedFonts must contain exactly the canonical font roles "
            f"({', '.join(RESOLVED_FONT_ROLES)}): {'; '.join(details)}"
        )
    names = {}
    for role in RESOLVED_FONT_ROLES:
        value = fonts[role]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(
                f"themeLock.resolvedFonts.{role} must be a nonempty resolved font string"
            )
        names[role] = value.strip().casefold()
    return names


def is_page_number(shape, bound_typography_role=None):
    if bound_typography_role is not None:
        return bound_typography_role == "pageNumber"
    placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph[@type='sldNum']", NS)
    return placeholder is not None or "page number" in shape_name(shape).casefold()


def is_opaque_shape(shape):
    if local_name(shape.tag) != "sp":
        return False
    fill = shape.find("./p:spPr/a:solidFill", NS)
    if fill is None or not list(fill):
        return False
    alpha_transforms = [
        node for node in fill.iter()
        if node is not fill and local_name(node.tag).casefold().startswith("alpha")
    ]
    if not alpha_transforms:
        return True
    return all(
        local_name(node.tag) == "alpha" and node.get("val") == "100000"
        for node in alpha_transforms
    )


def is_ordinary_content_shape(
    shape, bounds, slide_width, slide_height, critical_shape_ids=frozenset(),
    bound_typography_role=None,
):
    if is_page_number(shape, bound_typography_role):
        return False
    identifier = shape_id(shape)
    has_text = any(
        (node.text or "").strip()
        for node in shape.findall(".//a:t", NS)
    )
    if has_text or identifier in critical_shape_ids:
        return True
    name = shape_name(shape).strip().casefold()
    if re.search(r"background|decorative|decoration|full.slide|背景|装饰|底图", name):
        return False
    if bounds is not None and (
        bounds["x"] <= 0
        and bounds["y"] <= 0
        and bounds["x"] + bounds["cx"] >= slide_width
        and bounds["y"] + bounds["cy"] >= slide_height
    ):
        return False
    return True


def fully_covers(cover, target):
    return (
        cover["x"] <= target["x"]
        and cover["y"] <= target["y"]
        and cover["x"] + cover["cx"] >= target["x"] + target["cx"]
        and cover["y"] + cover["cy"] >= target["y"] + target["cy"]
    )


def violation(code, slide, message, **details):
    return {"code": code, "slide": slide, "message": message, **details}


def slide_spec_by_number(slide_specs):
    return {
        slide.get("slide"): slide
        for slide in slide_specs.get("slides", [])
        if isinstance(slide, dict) and isinstance(slide.get("slide"), int)
    }


def validated_native_critical_content(slide_spec, slide_number):
    raw_entries = slide_spec.get("nativeCriticalContent", [])
    if not isinstance(raw_entries, list):
        return [], [violation(
            "INVALID_CRITICAL_CONTENT", slide_number,
            "nativeCriticalContent must be an array",
            field="nativeCriticalContent",
        )]

    entries = []
    violations = []
    seen_ids = set()
    for item_index, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            violations.append(violation(
                "INVALID_CRITICAL_CONTENT", slide_number,
                "nativeCriticalContent items must be objects",
                itemIndex=item_index,
            ))
            continue

        content_id = entry.get("contentId")
        text = entry.get("text")
        object_id = entry.get("objectId")
        typography_role = entry.get("typographyRole")
        invalid_fields = []
        normalized_id = None
        if not isinstance(content_id, str) or not content_id.strip():
            invalid_fields.append("contentId")
        else:
            normalized_id = content_id.strip()
            if normalized_id in seen_ids:
                invalid_fields.append("duplicate contentId")
            else:
                seen_ids.add(normalized_id)
        if not isinstance(text, str) or not text.strip():
            invalid_fields.append("text")
        if slide_spec.get("qualityMode") == "enforced":
            if (
                not isinstance(object_id, str)
                or re.fullmatch(
                    rf"slide-{slide_number}:shape-[1-9][0-9]*", object_id,
                ) is None
            ):
                invalid_fields.append("objectId")
            if typography_role not in {
                "title", "body", "caption", "source", "pageNumber",
            }:
                invalid_fields.append("typographyRole")

        if invalid_fields:
            details = {
                "itemIndex": item_index,
                "invalidFields": invalid_fields,
            }
            if isinstance(content_id, str):
                details["contentId"] = content_id
            violations.append(violation(
                "INVALID_CRITICAL_CONTENT", slide_number,
                "nativeCriticalContent item has invalid fields",
                **details,
            ))
            continue
        entries.append(entry)
    return entries, violations


def is_compatibility_audit_exempt(slide_specs, slide_spec):
    if slide_spec.get("qualityMode") != "compatibility-audit":
        return False
    source_hash = slide_spec.get("sourceObjectHash")
    if not isinstance(source_hash, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", source_hash) is None:
        return False
    route = slide_specs.get("route")
    authorization = slide_spec.get("authorization")
    return (
        (route == "template" and authorization == "source-template")
        or (route == "edit" and authorization == "unauthorized-preserve")
    )


INVENTORY_OBJECT_TYPES = frozenset({
    "text", "shape", "image", "connector", "group", "table", "chart", "media",
})


def ooxml_object_type(shape):
    kind = local_name(shape.tag)
    if kind == "sp":
        return "text" if any((node.text or "").strip() for node in shape.findall(".//a:t", NS)) else "shape"
    if kind == "pic":
        nonvisual_properties = shape.find("./p:nvPicPr/p:nvPr", NS)
        if nonvisual_properties is not None and any(
            node.tag in MEDIA_MARKER_QNAMES
            for node in nonvisual_properties.iter()
        ):
            return "media"
        return "image"
    if kind == "cxnSp":
        return "connector"
    if kind == "grpSp":
        return "group"
    if kind == "graphicFrame":
        graphic_data = shape.find(".//a:graphicData", NS)
        uri = graphic_data.get("uri", "") if graphic_data is not None else ""
        if uri.endswith("/table"):
            return "table"
        if uri.endswith("/chart"):
            return "chart"
        return "media"
    raise ValueError(f"unsupported OOXML object kind: {kind}")


def displayed_ooxml_objects(pptx_path):
    objects_by_slide = {}
    with ZipFile(pptx_path) as archive:
        members = validate_zip_archive(archive, "PPTX")
        presentation = ET.fromstring(read_zip_member(
            archive, "ppt/presentation.xml", "PPTX", members,
        ))
        slide_members = slides_in_display_order(archive, presentation, members)
        for slide_number, member in enumerate(slide_members, start=1):
            slide = ET.fromstring(read_zip_member(archive, member, "PPTX", members))
            tree = slide.find(".//p:spTree", NS)
            actual = {}
            if tree is not None:
                for shape in list(tree):
                    if local_name(shape.tag) not in {"sp", "pic", "cxnSp", "graphicFrame", "grpSp"}:
                        continue
                    identifier = shape_id(shape)
                    if not identifier:
                        raise ValueError(
                            f"displayed PPTX slide {slide_number} has an object without cNvPr id"
                        )
                    object_id = f"slide-{slide_number}:shape-{identifier}"
                    if object_id in actual:
                        raise ValueError(
                            f"displayed PPTX slide {slide_number} has duplicate OOXML shape id {identifier}"
                        )
                    actual[object_id] = ooxml_object_type(shape)
            objects_by_slide[slide_number] = actual
    return objects_by_slide


def load_object_inventory(path, slide_specs, deck_objects_by_slide):
    try:
        inventory = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"object inventory must be valid JSON: {error.msg}") from error
    if not isinstance(inventory, dict):
        raise ValueError("object inventory must be a JSON object")
    if set(inventory) != {"artifactType", "schemaVersion", "projectId", "slides"}:
        raise ValueError(
            "object inventory requires exactly artifactType, schemaVersion, projectId, and slides"
        )
    if inventory.get("artifactType") != "objectInventory":
        raise ValueError("object inventory artifactType must be objectInventory")
    if inventory.get("schemaVersion") != "1.0.0":
        raise ValueError("object inventory schemaVersion must be 1.0.0")
    project_id = slide_specs.get("projectId") if isinstance(slide_specs, dict) else None
    if not isinstance(project_id, str) or not project_id.strip():
        raise ValueError("slide specs projectId must be a nonempty string")
    if inventory.get("projectId") != project_id:
        raise ValueError("object inventory projectId must match slide specs projectId")
    slides = inventory.get("slides")
    if not isinstance(slides, list) or not slides:
        raise ValueError("object inventory slides must be a nonempty array")
    slide_numbers = []
    seen_object_ids = set()
    for entry in slides:
        if not isinstance(entry, dict):
            raise ValueError("each object inventory slides entry must be an object")
        if set(entry) != {"slide", "objects"}:
            raise ValueError("object inventory slide entries require exactly slide and objects")
        number = entry.get("slide")
        if type(number) is not int or number < 1:
            raise ValueError("object inventory slide numbers must be positive integers")
        slide_numbers.append(number)
        objects = entry.get("objects")
        if not isinstance(objects, list) or not objects:
            raise ValueError(
                f"object inventory slide {number} objects must be a nonempty array"
            )
        actual_objects = deck_objects_by_slide.get(number, {})
        inventory_ids = set()
        for item in objects:
            if not isinstance(item, dict) or set(item) != {
                "objectId", "type", "native", "flattened",
            }:
                raise ValueError(
                    "object inventory objects require exactly objectId, type, native, and flattened"
                )
            object_id = item.get("objectId")
            object_type = item.get("type")
            native = item.get("native")
            flattened = item.get("flattened")
            if not isinstance(object_id, str) or not object_id.strip():
                raise ValueError("object inventory objectId must be a nonempty string")
            if object_id in seen_object_ids:
                raise ValueError(f"object inventory objectId must be globally unique: {object_id}")
            seen_object_ids.add(object_id)
            inventory_ids.add(object_id)
            if object_type not in INVENTORY_OBJECT_TYPES:
                raise ValueError(f"object inventory type is unsupported: {object_type}")
            if type(native) is not bool or type(flattened) is not bool:
                raise ValueError("object inventory native and flattened must be booleans")
            if native and flattened:
                raise ValueError("object inventory object cannot be both native and flattened")
            actual_type = actual_objects.get(object_id)
            if actual_type is None:
                raise ValueError(f"object inventory objectId is not bound to displayed OOXML: {object_id}")
            if object_type != actual_type:
                flattened_semantic = (
                    actual_type == "image"
                    and object_type in {"table", "chart"}
                    and flattened is True
                    and native is False
                )
                if not flattened_semantic:
                    raise ValueError(
                        f"object inventory type does not match OOXML for {object_id}: "
                        f"inventory={object_type}, OOXML={actual_type}"
                    )
            elif actual_type == "image":
                if native or flattened:
                    raise ValueError(
                        f"plain image inventory object must use native=false and flattened=false: {object_id}"
                    )
            elif not native or flattened:
                raise ValueError(
                    f"native OOXML object must use native=true and flattened=false: {object_id}"
                )
        if inventory_ids != set(actual_objects):
            missing = sorted(set(actual_objects) - inventory_ids)
            extra = sorted(inventory_ids - set(actual_objects))
            raise ValueError(
                f"object inventory slide {number} must bind every displayed OOXML object "
                f"(missing={missing}, extra={extra})"
            )
    if len(set(slide_numbers)) != len(slide_numbers):
        raise ValueError("object inventory slide numbers must be unique")
    spec_slides = slide_specs.get("slides")
    if not isinstance(spec_slides, list) or not spec_slides:
        raise ValueError("slide specs slides must be a nonempty array")
    spec_numbers = []
    for entry in spec_slides:
        if not isinstance(entry, dict) or type(entry.get("slide")) is not int or entry["slide"] < 1:
            raise ValueError("slide specs slide numbers must be positive integers")
        spec_numbers.append(entry["slide"])
    if len(set(spec_numbers)) != len(spec_numbers):
        raise ValueError("slide specs slide numbers must be unique")
    inventory_set = set(slide_numbers)
    spec_set = set(spec_numbers)
    if inventory_set != spec_set:
        raise ValueError(
            "object inventory slide set must exactly match slide specs "
            f"(inventory={sorted(inventory_set)}, specs={sorted(spec_set)})"
        )
    if inventory_set != set(deck_objects_by_slide):
        raise ValueError(
            "object inventory slide set must exactly match the displayed PPTX deck "
            f"(inventory={sorted(inventory_set)}, deck={sorted(deck_objects_by_slide)})"
        )
    return inventory


def shape_text_candidates(shapes):
    candidates = []
    for shape in shapes:
        for text_body in shape_text_bodies(shape):
            paragraphs = []
            for paragraph in text_body.findall("a:p", NS):
                paragraph_text = "".join(node.text or "" for node in paragraph.findall(".//a:t", NS))
                paragraphs.append(" ".join(paragraph_text.split()))
            candidates.append("\n".join(paragraphs))
    return candidates


def safe_relationship_target(source_member, target):
    parsed = urlsplit(unquote(target))
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or "\\" in parsed.path:
        return None
    if parsed.path.startswith("/"):
        candidate = parsed.path.lstrip("/")
    else:
        candidate = posixpath.join(posixpath.dirname(source_member), parsed.path)
    candidate = posixpath.normpath(candidate)
    if candidate in {"", ".", ".."} or candidate.startswith("../"):
        return None
    return candidate


def slides_in_display_order(archive, presentation, members=None):
    members = members if members is not None else validate_zip_archive(archive, "PPTX")
    relationships_member = "ppt/_rels/presentation.xml.rels"
    relationships = ET.fromstring(read_zip_member(
        archive, relationships_member, "PPTX", members,
    ))
    targets = {}
    relationship_ids = set()
    for relationship in relationships.findall("pr:Relationship", NS):
        relationship_id = relationship.get("Id")
        if not isinstance(relationship_id, str) or not relationship_id:
            raise ValueError("presentation relationship Id must be a nonempty string")
        if relationship_id in relationship_ids:
            raise ValueError(f"duplicate presentation relationship Id: {relationship_id}")
        relationship_ids.add(relationship_id)

        relationship_type = relationship.get("Type", "")
        if relationship_type not in SLIDE_RELATIONSHIP_TYPES:
            if relationship_type.endswith("/slide"):
                raise ValueError(
                    f"slide relationship Type is not a supported exact URI: {relationship_type}"
                )
            continue
        target_mode = relationship.get("TargetMode")
        if target_mode not in {None, "Internal"}:
            raise ValueError(
                f"slide relationship TargetMode must be absent or Internal: {target_mode}"
            )
        member = safe_relationship_target("ppt/presentation.xml", relationship.get("Target", ""))
        if member is not None and member in members:
            targets[relationship_id] = member

    members = []
    for slide_id in presentation.findall("./p:sldIdLst/p:sldId", NS):
        relationship_id = slide_id.get(f"{{{NS['r']}}}id")
        member = targets.get(relationship_id)
        if member is None:
            raise ValueError(f"unresolved slide relationship: {relationship_id}")
        members.append(member)
    return members


def displayed_slide_numbers(pptx_path):
    with ZipFile(pptx_path) as archive:
        members = validate_zip_archive(archive, "PPTX")
        presentation = ET.fromstring(read_zip_member(
            archive, "ppt/presentation.xml", "PPTX", members,
        ))
        slide_members = slides_in_display_order(archive, presentation, members)
    return set(range(1, len(slide_members) + 1))


def audit_pptx(pptx_path, slide_specs, theme_lock):
    results = {check_id: [] for check_id in CHECK_IDS}
    expected_fonts = canonical_resolved_fonts(theme_lock)
    specs = slide_spec_by_number(slide_specs)

    with ZipFile(pptx_path) as archive:
        members = validate_zip_archive(archive, "PPTX")
        presentation = ET.fromstring(read_zip_member(
            archive, "ppt/presentation.xml", "PPTX", members,
        ))
        slide_size = presentation.find("p:sldSz", NS)
        if slide_size is None:
            raise ValueError("ppt/presentation.xml is missing p:sldSz")
        slide_width = int(slide_size.get("cx"))
        slide_height = int(slide_size.get("cy"))
        slide_members = slides_in_display_order(archive, presentation, members)

        for slide_number, member in enumerate(slide_members, start=1):
            slide = ET.fromstring(read_zip_member(archive, member, "PPTX", members))
            slide_spec = specs.get(slide_number, {})
            critical_content, critical_violations = validated_native_critical_content(
                slide_spec,
                slide_number,
            )
            results["contentPresence"].extend(critical_violations)
            if is_compatibility_audit_exempt(slide_specs, slide_spec):
                continue
            tree = slide.find(".//p:spTree", NS)
            if tree is None:
                continue
            top_level_shapes = [
                child for child in list(tree)
                if local_name(child.tag) in {"sp", "pic", "cxnSp", "graphicFrame"}
            ]
            text_shapes = list(auditable_shapes(tree))
            shapes_by_object_id = {
                f"slide-{slide_number}:shape-{shape_id(shape)}": shape
                for shape in text_shapes
                if shape_id(shape)
            }
            bound_roles_by_shape = {}
            critical_shape_ids = set()
            for critical in critical_content:
                object_id = critical.get("objectId")
                role = critical.get("typographyRole")
                if not isinstance(object_id, str) or not isinstance(role, str):
                    continue
                identifier = object_id.rsplit(":shape-", 1)[-1]
                critical_shape_ids.add(identifier)
                previous_role = bound_roles_by_shape.get(identifier)
                if previous_role is not None and previous_role != role:
                    results["contentPresence"].append(violation(
                        "INVALID_CRITICAL_CONTENT", slide_number,
                        "one OOXML object cannot bind conflicting typography roles",
                        objectId=object_id,
                    ))
                    continue
                bound_roles_by_shape[identifier] = role
            for shape in text_shapes:
                identifier = shape_id(shape)
                for text_body in shape_text_bodies(shape):
                    body_properties = text_body.find("./a:bodyPr", NS)
                    if body_properties is None:
                        continue
                    if body_properties.find("a:spAutoFit", NS) is not None:
                        results["textFramePolicy"].append(violation(
                            "SHAPE_AUTOFIT", slide_number,
                            "spAutoFit can grow text outside its shape bounds",
                            shapeId=identifier,
                        ))
                results["fontResolution"].extend(
                    font_violations_for_shape(
                        shape, slide_number, expected_fonts, slide_spec,
                        bound_roles_by_shape.get(identifier),
                    )
                )

            safe_zone = slide_spec.get("safeZone")
            if isinstance(safe_zone, dict):
                margins = {}
                for side in ("top", "right", "bottom", "left"):
                    raw = safe_zone.get(side, 0.35)
                    try:
                        margins[side] = int(float(raw) * EMU_PER_INCH)
                    except (TypeError, ValueError):
                        margins[side] = int(0.35 * EMU_PER_INCH)
                for shape, bounds in positioned_auditable_shapes(tree):
                    if not is_ordinary_content_shape(
                        shape, bounds, slide_width, slide_height, critical_shape_ids,
                        bound_roles_by_shape.get(shape_id(shape)),
                    ):
                        continue
                    if bounds is None:
                        results["safeMargin"].append(violation(
                            "CONTENT_BOUNDS_UNRESOLVED", slide_number,
                            "ordinary content bounds cannot be resolved from OOXML",
                            shapeId=shape_id(shape),
                        ))
                        continue
                    if (
                        bounds["x"] < margins["left"]
                        or bounds["y"] < margins["top"]
                        or bounds["x"] + bounds["cx"] > slide_width - margins["right"]
                        or bounds["y"] + bounds["cy"] > slide_height - margins["bottom"]
                    ):
                        results["safeMargin"].append(violation(
                            "CONTENT_SAFE_MARGIN", slide_number,
                            "ordinary content crosses the declared content safe margin",
                            shapeId=shape_id(shape),
                            boundsEmu={key: json_emu(value) for key, value in bounds.items()},
                            requiredMarginsEmu=margins,
                        ))

            page_numbers = [
                (shape, shape_bounds(shape), False)
                for shape in top_level_shapes
                if is_page_number(
                    shape, bound_roles_by_shape.get(shape_id(shape)),
                )
            ]
            page_numbers.extend(
                (shape, bounds, True)
                for shape, bounds in grouped_page_numbers(tree, bound_roles_by_shape)
            )
            for shape, bounds, is_grouped in page_numbers:
                identifier = shape_id(shape)
                edge_inches = slide_spec.get("safeZone", {}).get("pageNumberEdge", 0.3)
                try:
                    required_edge = int(float(edge_inches) * EMU_PER_INCH)
                except (TypeError, ValueError):
                    required_edge = int(0.3 * EMU_PER_INCH)
                if bounds is None:
                    results["safeMargin"].append(violation(
                        "PAGE_NUMBER_BOUNDS_UNRESOLVED", slide_number,
                        "page number bounds cannot be resolved from valid OOXML transforms",
                        shapeId=identifier,
                        requiredEdgeEmu=required_edge,
                    ))
                    continue
                actual_edge = min(
                    bounds["x"], bounds["y"],
                    slide_width - (bounds["x"] + bounds["cx"]),
                    slide_height - (bounds["y"] + bounds["cy"]),
                )
                if actual_edge < required_edge:
                    results["safeMargin"].append(violation(
                        "PAGE_NUMBER_MARGIN", slide_number,
                        "page number is inside the required edge margin",
                        shapeId=identifier,
                        actualEdgeEmu=json_emu(actual_edge),
                        requiredEdgeEmu=required_edge,
                    ))

            for critical in critical_content:
                expected = normalized(critical["text"])
                object_id = critical.get("objectId")
                if isinstance(object_id, str):
                    bound_shape = shapes_by_object_id.get(object_id)
                    bound_candidates = (
                        shape_text_candidates([bound_shape])
                        if bound_shape is not None else []
                    )
                else:
                    bound_candidates = shape_text_candidates(text_shapes)
                if expected and not any(expected in candidate for candidate in bound_candidates):
                    results["contentPresence"].append(violation(
                        "MISSING_CRITICAL_TEXT", slide_number,
                        "critical text is missing from its bound OOXML object",
                        contentId=critical.get("contentId", ""),
                        objectId=object_id,
                        text=critical["text"],
                    ))

            for image_index, image in enumerate(top_level_shapes):
                if local_name(image.tag) != "pic":
                    continue
                image_bounds = shape_bounds(image)
                if image_bounds is None:
                    continue
                for cover in top_level_shapes[image_index + 1:]:
                    cover_bounds = shape_bounds(cover)
                    if cover_bounds is not None and is_opaque_shape(cover) and fully_covers(cover_bounds, image_bounds):
                        results["hiddenVisualResidue"].append(violation(
                            "FULL_IMAGE_HIDDEN", slide_number,
                            "a later fully opaque shape covers the complete image bounds",
                            imageShapeId=shape_id(image),
                            coveringShapeId=shape_id(cover),
                        ))
                        break

    for check_id in results:
        results[check_id].sort(key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True))
    return results


def build_report(args):
    slide_specs = json.loads(Path(args.slide_specs).read_text(encoding="utf-8"))
    theme_lock = json.loads(Path(args.theme_lock).read_text(encoding="utf-8"))
    deck_objects = displayed_ooxml_objects(args.pptx)
    load_object_inventory(args.object_inventory, slide_specs, deck_objects)
    results = audit_pptx(args.pptx, slide_specs, theme_lock)
    return {
        "artifactType": "automatedEvidenceBundle",
        "schemaVersion": "1.0.0",
        "qualityContractVersion": "1.0.0",
        "checker": {"id": "audit-pptx-quality", "version": "1.0.0"},
        "inputHashes": {
            "deck": sha256_file(args.pptx),
            "slideSpecs": sha256_file(args.slide_specs),
            "themeLock": sha256_file(args.theme_lock),
            "objectInventory": sha256_file(args.object_inventory),
        },
        "checks": {
            check_id: {
                "status": "PASS" if not violations else "FAIL",
                "value": len(violations),
                "violations": violations,
            }
            for check_id, violations in results.items()
        },
        "finalVerdict": "PASS" if all(not violations for violations in results.values()) else "FAIL",
        "generatedAt": utc_now(),
    }


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pptx", required=True)
    parser.add_argument("--slide-specs", required=True)
    parser.add_argument("--theme-lock", required=True)
    parser.add_argument("--object-inventory", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    report = build_report(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
