import json
from pathlib import Path
import posixpath
import subprocess
import sys
import tempfile
import unittest
import warnings
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills/visual-first-ppt/scripts/audit_pptx_quality.py"
OBJECT_INVENTORY = ROOT / "tests/fixtures/visual-quality/valid-object-inventory.json"
EMU_PER_INCH = 914400
SLIDE_WIDTH = 12192000
SLIDE_HEIGHT = 6858000
CHECK_IDS = (
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
)
CANONICAL_RESOLVED_FONTS = {
    "cjkTitle": "PingFang SC",
    "cjkBody": "PingFang SC",
    "latin": "PingFang SC",
    "number": "PingFang SC",
}
TRANSITIONAL_SLIDE_RELATIONSHIP_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
)
STRICT_SLIDE_RELATIONSHIP_TYPE = (
    "http://purl.oclc.org/ooxml/officeDocument/relationships/slide"
)
TRANSITIONAL_DRAWINGML_NAMESPACE = (
    "http://schemas.openxmlformats.org/drawingml/2006/main"
)
STRICT_DRAWINGML_NAMESPACE = "http://purl.oclc.org/ooxml/drawingml/main"
POWERPOINT_2010_NAMESPACE = "http://schemas.microsoft.com/office/powerpoint/2010/main"


class AuditPptxQualityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="audit-pptx-quality-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_pptx(
        self,
        *,
        body_pr="<a:noAutofit/>",
        page_number_right_margin_inches=0.5,
        page_number_placeholder=True,
        latin_typeface="PingFang SC",
        ea_typeface="PingFang SC",
        text_font_children_xml=None,
        text_include_run_properties=True,
        page_number_latin_typeface="PingFang SC",
        page_number_ea_typeface="PingFang SC",
        paragraphs=None,
        extra_shapes="",
        hidden_cover_alpha_xml=None,
        text_shape_name="Critical text",
        text_placeholder_type=None,
        text_font_size_pt=24,
        text_x_inches=1.0,
    ):
        if paragraphs is None:
            paragraphs = [["君不见", "黄河之水天上来"]]
        deck = self.root / "minimal.pptx"
        text_shape = self.shape_xml(
            shape_id=2,
            name=text_shape_name,
            x=int(text_x_inches * EMU_PER_INCH),
            y=EMU_PER_INCH,
            cx=5 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr=body_pr,
            paragraphs=paragraphs,
            latin_typeface=latin_typeface,
            ea_typeface=ea_typeface,
            font_children_xml=text_font_children_xml,
            include_run_properties=text_include_run_properties,
            placeholder_type=text_placeholder_type,
            font_size_pt=text_font_size_pt,
        )
        page_width = int(0.25 * EMU_PER_INCH)
        page_height = int(0.25 * EMU_PER_INCH)
        page_x = SLIDE_WIDTH - page_width - int(page_number_right_margin_inches * EMU_PER_INCH)
        page_y = SLIDE_HEIGHT - page_height - int(0.5 * EMU_PER_INCH)
        page_number = self.shape_xml(
            shape_id=3,
            name="Slide numeral" if page_number_placeholder else "Page Number",
            x=page_x,
            y=page_y,
            cx=page_width,
            cy=page_height,
            body_pr="<a:noAutofit/>",
            paragraphs=[["1"]],
            latin_typeface=page_number_latin_typeface,
            ea_typeface=page_number_ea_typeface,
            placeholder_type="sldNum" if page_number_placeholder else None,
        )
        residue = ""
        if hidden_cover_alpha_xml is not None:
            residue = self.full_slide_image_xml() + self.full_slide_cover_xml(hidden_cover_alpha_xml)
        slide = self.slide_xml(text_shape + extra_shapes + page_number + residue)
        self.write_pptx(deck, {"ppt/slides/slide1.xml": slide}, [("rId1", "slides/slide1.xml")])
        return deck

    def make_reordered_pptx(self):
        deck = self.root / "reordered.pptx"
        slide1 = self.slide_xml(self.shape_xml(
            shape_id=2,
            name="Part one",
            x=EMU_PER_INCH,
            y=EMU_PER_INCH,
            cx=5 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr="<a:noAutofit/>",
            paragraphs=[["Displayed second"]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
        ))
        slide2 = self.slide_xml(self.shape_xml(
            shape_id=2,
            name="Part two",
            x=EMU_PER_INCH,
            y=EMU_PER_INCH,
            cx=5 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr="<a:noAutofit/>",
            paragraphs=[["Displayed first"]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
        ))
        self.write_pptx(
            deck,
            {
                "ppt/slides/slide1.xml": slide1,
                "ppt/slides/slide2.xml": slide2,
            },
            [
                ("rId2", "./slides/../slides/slide2.xml"),
                ("rId1", "slides/slide1.xml"),
            ],
        )
        return deck

    def make_relationship_pptx(self, name, relationships, texts):
        deck = self.root / name
        slides = {}
        for slide_number, text in enumerate(texts, start=1):
            shape = self.shape_xml(
                shape_id=2,
                name=f"Slide {slide_number} text",
                x=EMU_PER_INCH,
                y=EMU_PER_INCH,
                cx=5 * EMU_PER_INCH,
                cy=EMU_PER_INCH,
                body_pr="<a:noAutofit/>",
                paragraphs=[[text]],
                latin_typeface="PingFang SC",
                ea_typeface="PingFang SC",
            )
            slides[f"ppt/slides/slide{slide_number}.xml"] = self.slide_xml(shape)
        self.write_pptx(deck, slides, relationships)
        return deck

    def policy_broken_slide_xml(self):
        broken_text = self.shape_xml(
            shape_id=2,
            name="Broken native text",
            x=EMU_PER_INCH,
            y=EMU_PER_INCH,
            cx=5 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr="<a:spAutoFit/>",
            paragraphs=[["Wrong visible text"]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
            include_run_properties=False,
        )
        page_width = int(0.25 * EMU_PER_INCH)
        page_height = int(0.25 * EMU_PER_INCH)
        page_number = self.shape_xml(
            shape_id=3,
            name="Slide numeral",
            x=SLIDE_WIDTH - page_width - int(0.10 * EMU_PER_INCH),
            y=SLIDE_HEIGHT - page_height - int(0.5 * EMU_PER_INCH),
            cx=page_width,
            cy=page_height,
            body_pr="<a:noAutofit/>",
            paragraphs=[["1"]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
            placeholder_type="sldNum",
        )
        return self.slide_xml(
            broken_text
            + page_number
            + self.full_slide_image_xml()
            + self.full_slide_cover_xml("")
        )

    @staticmethod
    def slide_xml(shapes):
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    {shapes}
  </p:spTree></p:cSld>
</p:sld>'''

    @staticmethod
    def shape_xml(
        *,
        shape_id,
        name,
        x,
        y,
        cx,
        cy,
        body_pr,
        paragraphs,
        latin_typeface,
        ea_typeface,
        placeholder_type=None,
        font_children_xml=None,
        include_run_properties=True,
        font_size_pt=24,
    ):
        placeholder = f'<p:ph type="{escape(placeholder_type)}"/>' if placeholder_type else ""
        paragraph_xml = []
        for runs in paragraphs:
            if font_children_xml is None:
                font_children = (
                    f'<a:latin typeface="{escape(latin_typeface)}"/>'
                    f'<a:ea typeface="{escape(ea_typeface)}"/>'
                )
            else:
                font_children = font_children_xml
            run_properties = (
                f'<a:rPr sz="{int(font_size_pt * 100)}">{font_children}</a:rPr>'
                if include_run_properties else ""
            )
            run_xml = "".join(
                f'''<a:r>{run_properties}<a:t>{escape(text)}</a:t></a:r>'''
                for text in runs
            )
            paragraph_xml.append(f"<a:p>{run_xml}</a:p>")
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="{shape_id}" name="{escape(name)}"/><p:cNvSpPr/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr>{body_pr}</a:bodyPr><a:lstStyle/>{''.join(paragraph_xml)}</p:txBody>
</p:sp>'''

    @staticmethod
    def full_slide_image_xml():
        return f'''<p:pic>
  <p:nvPicPr><p:cNvPr id="4" name="Full slide image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{SLIDE_WIDTH}" cy="{SLIDE_HEIGHT}"/></a:xfrm></p:spPr>
</p:pic>'''

    @staticmethod
    def media_picture_xml(
        kind="videoFile", shape_id=30, namespace=TRANSITIONAL_DRAWINGML_NAMESPACE,
    ):
        if namespace == TRANSITIONAL_DRAWINGML_NAMESPACE:
            marker = f'<a:{kind} r:link="rIdMedia"/>'
        else:
            marker = (
                f'<m:{kind} xmlns:m="{namespace}" r:link="rIdMedia"/>'
            )
        return f'''<p:pic>
  <p:nvPicPr><p:cNvPr id="{shape_id}" name="{kind} frame"/><p:cNvPicPr/><p:nvPr>{marker}</p:nvPr></p:nvPicPr>
  <p:blipFill><a:blip r:embed="rIdPoster"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{2 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{2 * EMU_PER_INCH}"/></a:xfrm></p:spPr>
</p:pic>'''

    @staticmethod
    def default_run_properties_shape_xml(
        latin_typeface="Source Han Serif SC",
        ea_typeface="PingFang SC",
    ):
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="7" name="Default run properties"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{4 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800"><a:latin typeface="{escape(latin_typeface)}"/><a:ea typeface="{escape(ea_typeface)}"/></a:defRPr></a:pPr><a:r><a:t>Default 字体 sample</a:t></a:r></a:p></p:txBody>
</p:sp>'''

    @staticmethod
    def mixed_explicit_and_missing_run_font_shape_xml():
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="8" name="Mixed run fonts"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{4 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p>
    <a:r><a:rPr sz="1800"><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/></a:rPr><a:t>Declared</a:t></a:r>
    <a:r><a:t>Missing</a:t></a:r>
  </a:p></p:txBody>
</p:sp>'''

    @staticmethod
    def default_and_override_font_shape_xml(
        *,
        text,
        default_latin="PingFang SC",
        default_ea="PingFang SC",
        run_font_children="",
        placeholder_type=None,
    ):
        placeholder = f'<p:ph type="{escape(placeholder_type)}"/>' if placeholder_type else ""
        run_properties = f'<a:rPr sz="1800">{run_font_children}</a:rPr>' if run_font_children else ""
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="9" name="Default plus override"/><p:cNvSpPr/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{4 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800"><a:latin typeface="{escape(default_latin)}"/><a:ea typeface="{escape(default_ea)}"/></a:defRPr></a:pPr><a:r>{run_properties}<a:t>{escape(text)}</a:t></a:r></a:p></p:txBody>
</p:sp>'''

    @staticmethod
    def field_shape_xml(*, text, font_children_xml):
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="10" name="Text field"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{4 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:spPr>
  <p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:fld id="{{00000000-0000-0000-0000-000000000001}}" type="custom"><a:rPr sz="1800">{font_children_xml}</a:rPr><a:t>{escape(text)}</a:t></a:fld></a:p></p:txBody>
</p:sp>'''

    @staticmethod
    def full_slide_cover_xml(alpha_xml):
        return f'''<p:sp>
  <p:nvSpPr><p:cNvPr id="5" name="Cover"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{SLIDE_WIDTH}" cy="{SLIDE_HEIGHT}"/></a:xfrm><a:solidFill><a:srgbClr val="FFFFFF">{alpha_xml}</a:srgbClr></a:solidFill></p:spPr>
</p:sp>'''

    @staticmethod
    def native_table_xml(
        *,
        text="表格关键文字",
        body_pr="<a:noAutofit/>",
        latin_typeface="PingFang SC",
        ea_typeface="PingFang SC",
    ):
        return f'''<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="11" name="Native table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="{EMU_PER_INCH}" y="{3 * EMU_PER_INCH}"/><a:ext cx="{5 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></p:xfrm>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
    <a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="{5 * EMU_PER_INCH}"/></a:tblGrid>
    <a:tr h="{EMU_PER_INCH}"><a:tc>
      <a:txBody><a:bodyPr>{body_pr}</a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr sz="1800"><a:latin typeface="{escape(latin_typeface)}"/><a:ea typeface="{escape(ea_typeface)}"/></a:rPr><a:t>{escape(text)}</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc></a:tr>
  </a:tbl></a:graphicData></a:graphic>
</p:graphicFrame>'''

    @classmethod
    def nested_group_text_xml(
        cls,
        *,
        text="组内关键文字",
        body_pr="<a:noAutofit/>",
        latin_typeface="PingFang SC",
        ea_typeface="PingFang SC",
    ):
        child = cls.shape_xml(
            shape_id=14,
            name="Nested group body text",
            x=0,
            y=0,
            cx=4 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr=body_pr,
            paragraphs=[[text]],
            latin_typeface=latin_typeface,
            ea_typeface=ea_typeface,
        )
        inner = f'''<p:grpSp>
  <p:nvGrpSpPr><p:cNvPr id="13" name="Inner group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/><a:chOff x="0" y="0"/><a:chExt cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:grpSpPr>
  {child}
</p:grpSp>'''
        return f'''<p:grpSp>
  <p:nvGrpSpPr><p:cNvPr id="12" name="Outer group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr><a:xfrm><a:off x="{EMU_PER_INCH}" y="{3 * EMU_PER_INCH}"/><a:ext cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/><a:chOff x="0" y="0"/><a:chExt cx="{4 * EMU_PER_INCH}" cy="{EMU_PER_INCH}"/></a:xfrm></p:grpSpPr>
  {inner}
</p:grpSp>'''

    @classmethod
    def page_number_shape_xml(
        cls,
        *,
        shape_id=20,
        x,
        y,
        cx,
        cy,
        transform_xml=None,
    ):
        shape = cls.shape_xml(
            shape_id=shape_id,
            name=f"Grouped Page Number {shape_id}",
            x=x,
            y=y,
            cx=cx,
            cy=cy,
            body_pr="<a:noAutofit/>",
            paragraphs=[[str(shape_id)]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
            placeholder_type="sldNum",
        )
        if transform_xml is None:
            return shape
        start = shape.index("<p:spPr>")
        end = shape.index("</p:spPr>", start) + len("</p:spPr>")
        return shape[:start] + f"<p:spPr>{transform_xml}</p:spPr>" + shape[end:]

    @staticmethod
    def group_xml(
        *,
        group_id,
        children,
        off_x=0,
        off_y=0,
        ext_cx=EMU_PER_INCH,
        ext_cy=EMU_PER_INCH,
        ch_off_x=0,
        ch_off_y=0,
        ch_ext_cx=EMU_PER_INCH,
        ch_ext_cy=EMU_PER_INCH,
        transform_xml=None,
    ):
        if transform_xml is None:
            transform_xml = f'''<a:xfrm>
    <a:off x="{off_x}" y="{off_y}"/><a:ext cx="{ext_cx}" cy="{ext_cy}"/>
    <a:chOff x="{ch_off_x}" y="{ch_off_y}"/><a:chExt cx="{ch_ext_cx}" cy="{ch_ext_cy}"/>
  </a:xfrm>'''
        return f'''<p:grpSp>
  <p:nvGrpSpPr><p:cNvPr id="{group_id}" name="Group {group_id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr>{transform_xml}</p:grpSpPr>
  {children}
</p:grpSp>'''

    @staticmethod
    def presentation_xml(relationship_ids):
        slide_ids = "".join(
            f'<p:sldId id="{256 + index}" r:id="{escape(rel_id)}"/>'
            for index, rel_id in enumerate(relationship_ids)
        )
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>{slide_ids}</p:sldIdLst>
  <p:sldSz cx="{SLIDE_WIDTH}" cy="{SLIDE_HEIGHT}" type="wide"/>
</p:presentation>'''

    @staticmethod
    def relationships_xml(relationships):
        items = []
        for relationship in relationships:
            rel_id, target, *options = relationship
            relationship_type = (
                options[0] if options else TRANSITIONAL_SLIDE_RELATIONSHIP_TYPE
            )
            target_mode = options[1] if len(options) > 1 else None
            target_mode_xml = (
                f' TargetMode="{escape(target_mode)}"' if target_mode is not None else ""
            )
            items.append(
                f'<Relationship Id="{escape(rel_id)}" Type="{escape(relationship_type)}" '
                f'Target="{escape(target)}"{target_mode_xml}/>'
            )
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{''.join(items)}</Relationships>'''

    def write_pptx(self, deck, slides, relationships):
        with ZipFile(deck, "w", ZIP_DEFLATED) as archive:
            archive.writestr(
                "ppt/presentation.xml",
                self.presentation_xml([relationship[0] for relationship in relationships]),
            )
            archive.writestr(
                "ppt/_rels/presentation.xml.rels",
                self.relationships_xml(relationships),
            )
            for member, xml in slides.items():
                archive.writestr(member, xml)

    @staticmethod
    def inventory_object_type(shape):
        kind = shape.tag.rsplit("}", 1)[-1]
        if kind == "sp":
            return "text" if any((node.text or "").strip() for node in shape.findall(".//a:t", {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"})) else "shape"
        if kind == "pic":
            return "image"
        if kind == "cxnSp":
            return "connector"
        if kind == "grpSp":
            return "group"
        if kind == "graphicFrame":
            graphic_data = shape.find(".//a:graphicData", {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"})
            uri = graphic_data.get("uri", "") if graphic_data is not None else ""
            if uri.endswith("/table"):
                return "table"
            if uri.endswith("/chart"):
                return "chart"
            return "media"
        raise AssertionError(f"unsupported test inventory shape kind: {kind}")

    def object_inventory_for_deck(self, pptx, project_id):
        with ZipFile(pptx) as archive:
            presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
            relationships = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
            targets = {
                relationship.get("Id"): posixpath.normpath(
                    posixpath.join("ppt", relationship.get("Target", ""))
                )
                for relationship in relationships
                if relationship.get("Type", "").endswith("/slide")
            }
            slides = []
            for slide_number, slide_id in enumerate(
                presentation.findall("./p:sldIdLst/p:sldId", {
                    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
                }),
                start=1,
            ):
                relationship_id = slide_id.get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
                )
                slide = ET.fromstring(archive.read(targets[relationship_id]))
                tree = slide.find(".//p:spTree", {
                    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
                })
                objects = []
                for shape in list(tree) if tree is not None else []:
                    if shape.tag.rsplit("}", 1)[-1] not in {
                        "sp", "pic", "cxnSp", "graphicFrame", "grpSp",
                    }:
                        continue
                    properties = shape.find(".//p:cNvPr", {
                        "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
                    })
                    shape_identifier = properties.get("id")
                    object_type = self.inventory_object_type(shape)
                    objects.append({
                        "objectId": f"slide-{slide_number}:shape-{shape_identifier}",
                        "type": object_type,
                        "native": object_type != "image",
                        "flattened": False,
                    })
                slides.append({"slide": slide_number, "objects": objects})
        return {
            "artifactType": "objectInventory",
            "schemaVersion": "1.0.0",
            "projectId": project_id,
            "slides": slides,
        }

    def run_audit(
        self,
        pptx,
        *,
        resolved_fonts=None,
        expected_by_slide=None,
        theme_lock_payload=None,
        slide_specs_payload=None,
        object_inventory_payload=None,
        object_inventory_text=None,
    ):
        if resolved_fonts is None:
            resolved_fonts = dict(CANONICAL_RESOLVED_FONTS)
        if expected_by_slide is None:
            expected_by_slide = {1: "君不见黄河之水天上来"}
        slide_specs = self.root / "slide-specs.json"
        theme_lock = self.root / "theme-lock.json"
        output = self.root / "report.json"
        if slide_specs_payload is None:
            slide_specs_payload = {
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [
                    {
                        "slide": slide_number,
                        "safeZone": {"pageNumberEdge": 0.3},
                        "nativeCriticalContent": [{"contentId": f"critical-{slide_number}", "text": text}],
                    }
                    for slide_number, text in sorted(expected_by_slide.items())
                ],
            }
        slide_specs.write_text(json.dumps(slide_specs_payload), encoding="utf-8")
        if theme_lock_payload is None:
            theme_lock_payload = {
                "artifactType": "themeLock",
                "schemaVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "resolvedFonts": resolved_fonts,
            }
        theme_lock.write_text(json.dumps(theme_lock_payload), encoding="utf-8")
        object_inventory = self.root / "object-inventory.json"
        if object_inventory_text is not None:
            object_inventory.write_text(object_inventory_text, encoding="utf-8")
        else:
            if object_inventory_payload is None:
                object_inventory_payload = self.object_inventory_for_deck(
                    pptx,
                    slide_specs_payload["projectId"],
                )
            object_inventory.write_text(json.dumps(object_inventory_payload), encoding="utf-8")
        output.unlink(missing_ok=True)
        completed = subprocess.run([
            sys.executable, str(SCRIPT),
            "--pptx", str(pptx),
            "--slide-specs", str(slide_specs),
            "--theme-lock", str(theme_lock),
            "--object-inventory", str(object_inventory),
            "--output", str(output),
        ], cwd=ROOT, text=True, capture_output=True, check=False)
        return completed, output

    def audit(
        self,
        pptx,
        *,
        resolved_fonts=None,
        expected_by_slide=None,
        slide_specs_payload=None,
        object_inventory_payload=None,
    ):
        completed, output = self.run_audit(
            pptx,
            resolved_fonts=resolved_fonts,
            expected_by_slide=expected_by_slide,
            slide_specs_payload=slide_specs_payload,
            object_inventory_payload=object_inventory_payload,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(output.read_text(encoding="utf-8"))

    def assert_theme_lock_rejected(self, theme_lock_payload):
        completed, _ = self.run_audit(
            self.make_pptx(),
            theme_lock_payload=theme_lock_payload,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertRegex(completed.stderr, r"resolvedFonts|resolved font|canonical font")

    def assert_clean_pass(self, report):
        for check_id in CHECK_IDS:
            with self.subTest(check_id=check_id):
                self.assertEqual(report["checks"][check_id]["status"], "PASS")
                self.assertEqual(report["checks"][check_id]["value"], 0)
                self.assertEqual(report["checks"][check_id]["violations"], [])
        self.assertEqual(report["finalVerdict"], "PASS")

    def assert_only_failure(self, report, target, value=1):
        for check_id in CHECK_IDS:
            with self.subTest(check_id=check_id):
                expected_status = "FAIL" if check_id == target else "PASS"
                expected_value = value if check_id == target else 0
                self.assertEqual(report["checks"][check_id]["status"], expected_status)
                self.assertEqual(report["checks"][check_id]["value"], expected_value)
        self.assertEqual(report["finalVerdict"], "FAIL")

    @staticmethod
    def slide_specs_with_native_critical_content(native_critical_content):
        return {
            "artifactType": "slideSpecs",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "route": "create",
            "slides": [{
                "slide": 1,
                "safeZone": {"pageNumberEdge": 0.3},
                "nativeCriticalContent": native_critical_content,
            }],
        }

    def test_accepts_clean_realistic_ooxml(self):
        report = self.audit(self.make_pptx())
        self.assert_clean_pass(report)

    def test_rejects_shape_autofit_that_can_grow_outside_canvas(self):
        report = self.audit(self.make_pptx(body_pr="<a:spAutoFit/>"))
        self.assert_only_failure(report, "textFramePolicy")

    def test_rejects_actual_body_text_below_declared_slide_spec_floor(self):
        report = self.audit(
            self.make_pptx(text_font_size_pt=8),
            slide_specs_payload={
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [{
                    "slide": 1,
                    "qualityMode": "enforced",
                    "typographyBudget": {
                        "title": {"minimumPt": 28},
                        "body": {"minimumPt": 18, "targetPt": 20},
                        "caption": {"minimumPt": 14},
                        "source": {"minimumPt": 10},
                        "pageNumber": {"minimumPt": 10},
                    },
                    "safeZone": {
                        "unit": "in", "top": 0.35, "right": 0.35,
                        "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                    },
                    "nativeCriticalContent": [{
                        "contentId": "critical-1",
                        "text": "君不见黄河之水天上来",
                        "objectId": "slide-1:shape-2",
                        "typographyRole": "body",
                    }],
                }],
            },
        )
        self.assert_only_failure(report, "fontResolution")
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["code"], "FONT_SIZE_BELOW_SPEC")
        self.assertEqual(violation["actualPt"], 8.0)

    def test_bound_title_role_cannot_hide_in_an_ordinary_textbox(self):
        report = self.audit(
            self.make_pptx(text_font_size_pt=20, text_shape_name="Critical text"),
            slide_specs_payload={
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [{
                    "slide": 1,
                    "qualityMode": "enforced",
                    "typographyBudget": {
                        "title": {"minimumPt": 28},
                        "body": {"minimumPt": 18, "targetPt": 20},
                        "caption": {"minimumPt": 14},
                        "source": {"minimumPt": 10},
                        "pageNumber": {"minimumPt": 10},
                    },
                    "safeZone": {
                        "unit": "in", "top": 0.35, "right": 0.35,
                        "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                    },
                    "nativeCriticalContent": [{
                        "contentId": "critical-title",
                        "text": "君不见黄河之水天上来",
                        "objectId": "slide-1:shape-2",
                        "typographyRole": "title",
                    }],
                }],
            },
        )
        self.assert_only_failure(report, "fontResolution")
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["typographyRole"], "title")
        self.assertEqual(violation["actualPt"], 20.0)

    def test_bound_title_role_controls_the_resolved_east_asian_font_family(self):
        resolved_fonts = {
            "cjkTitle": "Source Han Serif SC",
            "cjkBody": "PingFang SC",
            "latin": "PingFang SC",
            "number": "PingFang SC",
        }
        slide_specs = {
            "artifactType": "slideSpecs",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "route": "create",
            "slides": [{
                "slide": 1,
                "qualityMode": "enforced",
                "typographyBudget": {
                    "title": {"minimumPt": 28},
                    "body": {"minimumPt": 18, "targetPt": 20},
                    "caption": {"minimumPt": 14},
                    "source": {"minimumPt": 10},
                    "pageNumber": {"minimumPt": 10},
                },
                "safeZone": {
                    "unit": "in", "top": 0.35, "right": 0.35,
                    "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                },
                "nativeCriticalContent": [{
                    "contentId": "critical-title",
                    "text": "君不见黄河之水天上来",
                    "objectId": "slide-1:shape-2",
                    "typographyRole": "title",
                }],
            }],
        }
        title_font_report = self.audit(
            self.make_pptx(ea_typeface="Source Han Serif SC", text_font_size_pt=28),
            resolved_fonts=resolved_fonts,
            slide_specs_payload=slide_specs,
        )
        self.assert_clean_pass(title_font_report)

        body_font_report = self.audit(
            self.make_pptx(ea_typeface="PingFang SC", text_font_size_pt=28),
            resolved_fonts=resolved_fonts,
            slide_specs_payload=slide_specs,
        )
        self.assert_only_failure(body_font_report, "fontResolution", value=2)
        self.assertEqual(
            body_font_report["checks"]["fontResolution"]["violations"][0][
                "allowedResolvedRoles"
            ],
            ["cjkTitle"],
        )

    def test_bound_body_role_overrides_page_number_name_and_uses_content_margin(self):
        report = self.audit(
            self.make_pptx(text_x_inches=0.31, text_shape_name="Page Number"),
            slide_specs_payload={
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [{
                    "slide": 1,
                    "qualityMode": "enforced",
                    "safeZone": {
                        "unit": "in", "top": 0.35, "right": 0.35,
                        "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                    },
                    "nativeCriticalContent": [{
                        "contentId": "critical-body",
                        "text": "君不见黄河之水天上来",
                        "objectId": "slide-1:shape-2",
                        "typographyRole": "body",
                    }],
                }],
            },
        )
        self.assert_only_failure(report, "safeMargin")
        violation = report["checks"]["safeMargin"]["violations"][0]
        self.assertEqual(violation["code"], "CONTENT_SAFE_MARGIN")
        self.assertEqual(violation["shapeId"], "2")

    def test_decorative_name_cannot_exempt_bound_text_from_safe_margin(self):
        report = self.audit(
            self.make_pptx(text_x_inches=0.10, text_shape_name="Decorative title"),
            slide_specs_payload={
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [{
                    "slide": 1,
                    "qualityMode": "enforced",
                    "safeZone": {
                        "unit": "in", "top": 0.35, "right": 0.35,
                        "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                    },
                    "nativeCriticalContent": [{
                        "contentId": "critical-title",
                        "text": "君不见黄河之水天上来",
                        "objectId": "slide-1:shape-2",
                        "typographyRole": "title",
                    }],
                }],
            },
        )
        self.assert_only_failure(report, "safeMargin")
        self.assertEqual(
            report["checks"]["safeMargin"]["violations"][0]["shapeId"],
            "2",
        )

    def test_rejects_ordinary_text_inside_declared_content_safe_margin(self):
        report = self.audit(
            self.make_pptx(text_x_inches=0.10),
            slide_specs_payload={
                "artifactType": "slideSpecs",
                "schemaVersion": "1.0.0",
                "qualityContractVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "route": "create",
                "slides": [{
                    "slide": 1,
                    "qualityMode": "enforced",
                    "safeZone": {
                        "unit": "in", "top": 0.35, "right": 0.35,
                        "bottom": 0.35, "left": 0.35, "pageNumberEdge": 0.3,
                    },
                    "nativeCriticalContent": [{
                        "contentId": "critical-1",
                        "text": "君不见黄河之水天上来",
                        "objectId": "slide-1:shape-2",
                        "typographyRole": "body",
                    }],
                }],
            },
        )
        self.assert_only_failure(report, "safeMargin")
        self.assertEqual(
            report["checks"]["safeMargin"]["violations"][0]["code"],
            "CONTENT_SAFE_MARGIN",
        )

    def test_audits_native_table_text_for_autofit_fonts_and_critical_content(self):
        table = self.native_table_xml(
            text="表格关键文字",
            body_pr="<a:spAutoFit/>",
            ea_typeface="Comic Sans MS",
        )
        report = self.audit(
            self.make_pptx(extra_shapes=table),
            expected_by_slide={1: "表格关键文字"},
        )
        self.assertEqual(report["checks"]["textFramePolicy"]["status"], "FAIL")
        self.assertEqual(report["checks"]["textFramePolicy"]["value"], 1)
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 1)
        self.assertEqual(report["checks"]["contentPresence"]["status"], "PASS")
        self.assertEqual(report["checks"]["contentPresence"]["value"], 0)

    def test_accepts_critical_content_inside_a_native_table_cell(self):
        report = self.audit(
            self.make_pptx(extra_shapes=self.native_table_xml(text="表格关键文字")),
            expected_by_slide={1: "表格关键文字"},
        )
        self.assert_clean_pass(report)

    def test_recursively_audits_text_inside_nested_group_shapes(self):
        grouped = self.nested_group_text_xml(
            text="组内关键文字",
            body_pr="<a:spAutoFit/>",
            ea_typeface="Comic Sans MS",
        )
        report = self.audit(
            self.make_pptx(extra_shapes=grouped),
            expected_by_slide={1: "组内关键文字"},
        )
        self.assertEqual(report["checks"]["textFramePolicy"]["status"], "FAIL")
        self.assertEqual(report["checks"]["textFramePolicy"]["value"], 1)
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 1)
        self.assertEqual(report["checks"]["contentPresence"]["status"], "PASS")
        self.assertEqual(report["checks"]["contentPresence"]["value"], 0)

    def test_rejects_standard_slide_number_placeholder_inside_safe_margin(self):
        report = self.audit(self.make_pptx(page_number_right_margin_inches=0.10))
        self.assert_only_failure(report, "safeMargin")

    def test_keeps_english_page_number_name_as_compatibility_fallback(self):
        report = self.audit(self.make_pptx(
            page_number_right_margin_inches=0.10,
            page_number_placeholder=False,
        ))
        self.assert_only_failure(report, "safeMargin")

    def test_rejects_grouped_page_number_near_actual_canvas_edge(self):
        grouped_page_number = self.group_xml(
            group_id=21,
            off_x=SLIDE_WIDTH - EMU_PER_INCH,
            off_y=3 * EMU_PER_INCH,
            ext_cx=EMU_PER_INCH,
            ext_cy=EMU_PER_INCH,
            ch_ext_cx=EMU_PER_INCH,
            ch_ext_cy=EMU_PER_INCH,
            children=self.page_number_shape_xml(
                x=int(0.65 * EMU_PER_INCH),
                y=int(0.35 * EMU_PER_INCH),
                cx=int(0.25 * EMU_PER_INCH),
                cy=int(0.25 * EMU_PER_INCH),
            ),
        )
        report = self.audit(self.make_pptx(extra_shapes=grouped_page_number))
        self.assert_only_failure(report, "safeMargin")
        violation = report["checks"]["safeMargin"]["violations"][0]
        self.assertEqual(violation["shapeId"], "20")
        self.assertEqual(violation["actualEdgeEmu"], int(0.10 * EMU_PER_INCH))

    def test_accepts_grouped_page_number_transformed_away_from_local_edge(self):
        grouped_page_number = self.group_xml(
            group_id=22,
            off_x=2 * EMU_PER_INCH,
            off_y=EMU_PER_INCH,
            ext_cx=2 * EMU_PER_INCH,
            ext_cy=2 * EMU_PER_INCH,
            ch_ext_cx=EMU_PER_INCH,
            ch_ext_cy=EMU_PER_INCH,
            children=self.page_number_shape_xml(
                x=int(0.05 * EMU_PER_INCH),
                y=int(0.20 * EMU_PER_INCH),
                cx=int(0.25 * EMU_PER_INCH),
                cy=int(0.25 * EMU_PER_INCH),
            ),
        )
        self.assert_clean_pass(self.audit(self.make_pptx(extra_shapes=grouped_page_number)))

    def test_combines_nested_group_transforms_before_page_number_margin_check(self):
        page_number = self.page_number_shape_xml(
            x=int(10.25 * EMU_PER_INCH),
            y=int(0.50 * EMU_PER_INCH),
            cx=int(0.10 * EMU_PER_INCH),
            cy=int(0.20 * EMU_PER_INCH),
        )
        inner_group = self.group_xml(
            group_id=24,
            off_x=int(7.10 * EMU_PER_INCH),
            off_y=EMU_PER_INCH,
            ext_cx=EMU_PER_INCH,
            ext_cy=EMU_PER_INCH,
            ch_off_x=10 * EMU_PER_INCH,
            ch_ext_cx=int(0.50 * EMU_PER_INCH),
            ch_ext_cy=EMU_PER_INCH,
            children=page_number,
        )
        nested_group = self.group_xml(
            group_id=23,
            off_x=SLIDE_WIDTH - 2 * EMU_PER_INCH,
            off_y=EMU_PER_INCH,
            ext_cx=2 * EMU_PER_INCH,
            ext_cy=4 * EMU_PER_INCH,
            ch_off_x=4 * EMU_PER_INCH,
            ch_ext_cx=4 * EMU_PER_INCH,
            ch_ext_cy=4 * EMU_PER_INCH,
            children=inner_group,
        )
        report = self.audit(self.make_pptx(extra_shapes=nested_group))
        self.assert_only_failure(report, "safeMargin")
        violation = report["checks"]["safeMargin"]["violations"][0]
        self.assertEqual(violation["shapeId"], "20")
        self.assertEqual(violation["actualEdgeEmu"], int(0.10 * EMU_PER_INCH))

    def test_fails_closed_when_grouped_page_number_transform_is_missing_or_invalid(self):
        invalid_transforms = {
            "missing": "",
            "missing-child-extent": (
                f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{EMU_PER_INCH}" cy="{EMU_PER_INCH}"/>'
                '<a:chOff x="0" y="0"/></a:xfrm>'
            ),
            "zero-child-width": (
                f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{EMU_PER_INCH}" cy="{EMU_PER_INCH}"/>'
                f'<a:chOff x="0" y="0"/><a:chExt cx="0" cy="{EMU_PER_INCH}"/></a:xfrm>'
            ),
            "zero-child-height": (
                f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{EMU_PER_INCH}" cy="{EMU_PER_INCH}"/>'
                f'<a:chOff x="0" y="0"/><a:chExt cx="{EMU_PER_INCH}" cy="0"/></a:xfrm>'
            ),
        }
        for case, transform_xml in invalid_transforms.items():
            with self.subTest(case=case):
                grouped_page_number = self.group_xml(
                    group_id=25,
                    transform_xml=transform_xml,
                    children=self.page_number_shape_xml(
                        x=int(0.50 * EMU_PER_INCH),
                        y=int(0.50 * EMU_PER_INCH),
                        cx=int(0.25 * EMU_PER_INCH),
                        cy=int(0.25 * EMU_PER_INCH),
                    ),
                )
                report = self.audit(self.make_pptx(extra_shapes=grouped_page_number))
                self.assert_only_failure(report, "safeMargin")
                violation = report["checks"]["safeMargin"]["violations"][0]
                self.assertEqual(violation["code"], "PAGE_NUMBER_BOUNDS_UNRESOLVED")
                self.assertEqual(violation["shapeId"], "20")

    def test_fails_closed_when_top_level_page_number_bounds_are_unresolved(self):
        page_number = self.page_number_shape_xml(
            shape_id=26,
            x=EMU_PER_INCH,
            y=EMU_PER_INCH,
            cx=int(0.25 * EMU_PER_INCH),
            cy=int(0.25 * EMU_PER_INCH),
            transform_xml="",
        )
        report = self.audit(self.make_pptx(extra_shapes=page_number))
        self.assert_only_failure(report, "safeMargin")
        violation = report["checks"]["safeMargin"]["violations"][0]
        self.assertEqual(violation["code"], "PAGE_NUMBER_BOUNDS_UNRESOLVED")
        self.assertEqual(violation["shapeId"], "26")

    def test_fails_closed_on_unsupported_group_child_page_number_transform(self):
        base = (
            f'<a:off x="{EMU_PER_INCH}" y="{EMU_PER_INCH}"/>'
            f'<a:ext cx="{int(0.25 * EMU_PER_INCH)}" cy="{int(0.25 * EMU_PER_INCH)}"/>'
        )
        invalid_transforms = {
            "missing": "",
            "rotation": f'<a:xfrm rot="60000">{base}</a:xfrm>',
            "horizontal-flip": f'<a:xfrm flipH="1">{base}</a:xfrm>',
            "vertical-flip": f'<a:xfrm flipV="true">{base}</a:xfrm>',
            "zero-width": (
                f'<a:xfrm><a:off x="{EMU_PER_INCH}" y="{EMU_PER_INCH}"/>'
                f'<a:ext cx="0" cy="{int(0.25 * EMU_PER_INCH)}"/></a:xfrm>'
            ),
            "negative-height": (
                f'<a:xfrm><a:off x="{EMU_PER_INCH}" y="{EMU_PER_INCH}"/>'
                f'<a:ext cx="{int(0.25 * EMU_PER_INCH)}" cy="-1"/></a:xfrm>'
            ),
        }
        for case, child_transform in invalid_transforms.items():
            with self.subTest(case=case):
                page_number = self.page_number_shape_xml(
                    shape_id=27,
                    x=EMU_PER_INCH,
                    y=EMU_PER_INCH,
                    cx=int(0.25 * EMU_PER_INCH),
                    cy=int(0.25 * EMU_PER_INCH),
                    transform_xml=child_transform,
                )
                grouped_page_number = self.group_xml(
                    group_id=28,
                    children=page_number,
                )
                report = self.audit(self.make_pptx(extra_shapes=grouped_page_number))
                self.assert_only_failure(report, "safeMargin")
                violation = report["checks"]["safeMargin"]["violations"][0]
                self.assertEqual(violation["code"], "PAGE_NUMBER_BOUNDS_UNRESOLVED")
                self.assertEqual(violation["shapeId"], "27")

    def test_rejects_real_latin_font_that_differs_from_resolved_theme_lock(self):
        report = self.audit(self.make_pptx(
            latin_typeface="Source Han Serif SC",
            paragraphs=[["OpenAI"]],
        ), expected_by_slide={1: "OpenAI"})
        self.assert_only_failure(report, "fontResolution")
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["typeface"], "Source Han Serif SC")
        self.assertEqual(violation["sizePt"], 24.0)

    def test_rejects_real_east_asian_font_that_differs_from_resolved_theme_lock(self):
        report = self.audit(self.make_pptx(
            ea_typeface="Source Han Serif SC",
            paragraphs=[["君不见黄河之水天上来"]],
        ))
        self.assert_only_failure(report, "fontResolution")

    def test_accepts_distinct_real_latin_and_east_asian_resolved_fonts(self):
        report = self.audit(
            self.make_pptx(latin_typeface="Aptos", ea_typeface="PingFang SC"),
            resolved_fonts={
                "cjkTitle": "PingFang SC",
                "cjkBody": "PingFang SC",
                "latin": "Aptos",
                "number": "PingFang SC",
            },
        )
        self.assert_clean_pass(report)

    def test_rejects_latin_and_east_asian_role_swap_even_when_both_names_are_resolved(self):
        report = self.audit(
            self.make_pptx(
                latin_typeface="PingFang SC",
                ea_typeface="Aptos",
                page_number_latin_typeface="DIN Alternate",
                page_number_ea_typeface="PingFang SC",
                paragraphs=[["OpenAI 君不见"]],
            ),
            resolved_fonts={
                "cjkTitle": "PingFang SC",
                "cjkBody": "Source Han Serif SC",
                "latin": "Aptos",
                "number": "DIN Alternate",
            },
            expected_by_slide={1: "OpenAI 君不见"},
        )
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 2)
        violations = report["checks"]["fontResolution"]["violations"]
        self.assertEqual(
            {item["declarationRole"] for item in violations},
            {"latin", "ea"},
        )

    def test_accepts_numeric_slide_number_using_number_role_font(self):
        report = self.audit(
            self.make_pptx(
                latin_typeface="Aptos",
                ea_typeface="PingFang SC",
                page_number_latin_typeface="DIN Alternate",
                page_number_ea_typeface="Source Han Serif SC",
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "Aptos",
                "number": "DIN Alternate",
            },
        )
        self.assert_clean_pass(report)

    def test_rejects_nonempty_text_without_explicit_or_default_font_declaration(self):
        report = self.audit(self.make_pptx(text_include_run_properties=False))
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 2)
        for violation in report["checks"]["fontResolution"]["violations"]:
            self.assertEqual(violation["code"], "MISSING_FONT_DECLARATION")
            self.assertEqual(violation["requiredDeclarationRole"], "ea")

    def test_rejects_a_nonempty_run_without_font_even_when_a_sibling_run_declares_one(self):
        report = self.audit(self.make_pptx(
            extra_shapes=self.mixed_explicit_and_missing_run_font_shape_xml(),
        ))
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 1)
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["code"], "MISSING_FONT_DECLARATION")

    def assert_invalid_latin_typeface_declaration(self, font_children):
        report = self.audit(self.make_pptx(
            text_font_children_xml=font_children,
            paragraphs=[["OpenAI"]],
        ), expected_by_slide={1: "OpenAI"})
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 1)
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["code"], "INVALID_FONT_DECLARATION")
        self.assertEqual(violation["declarationRole"], "latin")

    def test_rejects_font_declaration_without_typeface(self):
        self.assert_invalid_latin_typeface_declaration(
            '<a:latin/><a:ea typeface="PingFang SC"/>',
        )

    def test_rejects_font_declaration_with_blank_typeface(self):
        self.assert_invalid_latin_typeface_declaration(
            '<a:latin typeface="   "/><a:ea typeface="PingFang SC"/>',
        )

    def test_accepts_valid_default_run_font_declarations_for_nonempty_text(self):
        report = self.audit(self.make_pptx(
            extra_shapes=self.default_run_properties_shape_xml(
                latin_typeface="PingFang SC",
                ea_typeface="PingFang SC",
            ),
        ))
        self.assert_clean_pass(report)

    def test_requires_east_asian_declaration_for_han_hiragana_katakana_and_hangul(self):
        for text in ("汉字", "ひらがな", "カタカナ", "한글"):
            with self.subTest(text=text):
                report = self.audit(self.make_pptx(
                    text_font_children_xml='<a:latin typeface="PingFang SC"/>',
                    paragraphs=[[text]],
                ), expected_by_slide={1: text})
                self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
                self.assertEqual(
                    report["checks"]["fontResolution"]["violations"][0]["requiredDeclarationRole"],
                    "ea",
                )

    def test_requires_latin_declaration_for_latin_letters(self):
        report = self.audit(self.make_pptx(
            text_font_children_xml='<a:ea typeface="PingFang SC"/>',
            paragraphs=[["OpenAI"]],
        ), expected_by_slide={1: "OpenAI"})
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(
            report["checks"]["fontResolution"]["violations"][0]["requiredDeclarationRole"],
            "latin",
        )

    def test_sym_and_complex_script_declarations_do_not_replace_required_font_roles(self):
        report = self.audit(self.make_pptx(
            text_font_children_xml=(
                '<a:cs typeface="PingFang SC"/>'
                '<a:sym typeface="PingFang SC"/>'
            ),
            paragraphs=[["OpenAI 汉字"]],
        ), expected_by_slide={1: "OpenAI 汉字"})
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(report["checks"]["fontResolution"]["value"], 2)
        self.assertEqual(
            {item["requiredDeclarationRole"] for item in report["checks"]["fontResolution"]["violations"]},
            {"latin", "ea"},
        )

    def test_rejects_font_declaration_local_name_from_the_wrong_namespace(self):
        cases = (
            (
                "latin",
                "OpenAI",
                '<evil:latin xmlns:evil="urn:evil" typeface="PingFang SC"/>'
                '<a:ea typeface="PingFang SC"/>',
            ),
            (
                "ea",
                "汉字",
                '<a:latin typeface="PingFang SC"/>'
                '<evil:ea xmlns:evil="urn:evil" typeface="PingFang SC"/>',
            ),
        )
        for required_role, text, font_children in cases:
            with self.subTest(required_role=required_role):
                report = self.audit(
                    self.make_pptx(
                        text_font_children_xml=font_children,
                        paragraphs=[[text]],
                    ),
                    expected_by_slide={1: text},
                )
                self.assert_only_failure(report, "fontResolution")
                violation = report["checks"]["fontResolution"]["violations"][0]
                self.assertEqual(violation["code"], "MISSING_FONT_DECLARATION")
                self.assertEqual(violation["requiredDeclarationRole"], required_role)

    def test_requires_script_font_declaration_for_nonempty_field(self):
        report = self.audit(self.make_pptx(
            extra_shapes=self.field_shape_xml(
                text="字段汉字",
                font_children_xml='<a:latin typeface="PingFang SC"/>',
            ),
        ))
        self.assertEqual(report["checks"]["fontResolution"]["status"], "FAIL")
        self.assertEqual(
            report["checks"]["fontResolution"]["violations"][0]["requiredDeclarationRole"],
            "ea",
        )

    def test_title_placeholder_uses_only_the_cjk_title_role(self):
        report = self.audit(
            self.make_pptx(
                text_placeholder_type="title",
                ea_typeface="PingFang SC",
                paragraphs=[["标题"]],
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
            expected_by_slide={1: "标题"},
        )
        self.assert_only_failure(report, "fontResolution")
        violations = report["checks"]["fontResolution"]["violations"]
        self.assertTrue(violations)
        if violations:
            self.assertEqual(violations[0]["allowedResolvedRoles"], ["cjkTitle"])

    def test_unknown_non_title_shape_uses_only_the_cjk_body_role(self):
        report = self.audit(
            self.make_pptx(
                text_shape_name="Unknown text role",
                ea_typeface="Source Han Serif SC",
                paragraphs=[["正文"]],
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
            expected_by_slide={1: "正文"},
        )
        self.assert_only_failure(report, "fontResolution")
        violations = report["checks"]["fontResolution"]["violations"]
        self.assertTrue(violations)
        if violations:
            self.assertEqual(violations[0]["allowedResolvedRoles"], ["cjkBody"])

    def test_accepts_title_placeholder_using_the_cjk_title_role(self):
        report = self.audit(
            self.make_pptx(
                text_placeholder_type="ctrTitle",
                ea_typeface="Source Han Serif SC",
                paragraphs=[["标题"]],
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
            expected_by_slide={1: "标题"},
        )
        self.assert_clean_pass(report)

    def test_explicitly_named_title_shape_uses_the_cjk_title_role(self):
        report = self.audit(
            self.make_pptx(
                text_shape_name="Title 1",
                ea_typeface="Named Title Font",
                paragraphs=[["标题"]],
            ),
            resolved_fonts={
                "cjkTitle": "Named Title Font",
                "cjkBody": "Body Font",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
            expected_by_slide={1: "标题"},
        )
        self.assert_clean_pass(report)

    def test_default_font_is_inherited_until_the_run_overrides_that_script_role(self):
        inherited = self.audit(self.make_pptx(
            extra_shapes=self.default_and_override_font_shape_xml(
                text="正文",
                default_ea="PingFang SC",
                run_font_children='<a:latin typeface="PingFang SC"/>',
            ),
        ))
        self.assert_clean_pass(inherited)

        rejected_override = self.audit(
            self.make_pptx(
                extra_shapes=self.default_and_override_font_shape_xml(
                    text="正文",
                    default_ea="PingFang SC",
                    run_font_children='<a:ea typeface="Source Han Serif SC"/>',
                ),
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
        )
        self.assert_only_failure(rejected_override, "fontResolution")

        accepted_override = self.audit(
            self.make_pptx(
                extra_shapes=self.default_and_override_font_shape_xml(
                    text="正文",
                    default_ea="Source Han Serif SC",
                    run_font_children='<a:ea typeface="PingFang SC"/>',
                ),
            ),
            resolved_fonts={
                "cjkTitle": "Source Han Serif SC",
                "cjkBody": "PingFang SC",
                "latin": "PingFang SC",
                "number": "PingFang SC",
            },
        )
        self.assert_clean_pass(accepted_override)

    def test_does_not_require_font_declarations_for_shape_without_text(self):
        report = self.audit(self.make_pptx(
            extra_shapes=self.full_slide_cover_xml(""),
        ))
        self.assert_clean_pass(report)

    def test_rejects_theme_lock_without_resolved_fonts_object(self):
        self.assert_theme_lock_rejected({
            "artifactType": "themeLock",
            "schemaVersion": "1.0.0",
            "projectId": "ppt-quality-test",
        })

    def test_rejects_partial_resolved_fonts_object(self):
        partial = dict(CANONICAL_RESOLVED_FONTS)
        del partial["cjkBody"]
        self.assert_theme_lock_rejected({
            "artifactType": "themeLock",
            "schemaVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "resolvedFonts": partial,
        })

    def test_rejects_empty_or_non_string_resolved_font_values(self):
        for invalid in ("", "   ", None, 42):
            with self.subTest(invalid=invalid):
                resolved = dict(CANONICAL_RESOLVED_FONTS)
                resolved["cjkBody"] = invalid
                self.assert_theme_lock_rejected({
                    "artifactType": "themeLock",
                    "schemaVersion": "1.0.0",
                    "projectId": "ppt-quality-test",
                    "resolvedFonts": resolved,
                })

    def test_rejects_extra_resolved_font_keys_and_never_uses_them_as_roles(self):
        substitutes_number = dict(CANONICAL_RESOLVED_FONTS)
        del substitutes_number["number"]
        substitutes_number["font-3"] = "PingFang SC"
        includes_rogue_role = {
            **CANONICAL_RESOLVED_FONTS,
            "decorative": "PingFang SC",
        }
        for resolved in (substitutes_number, includes_rogue_role):
            with self.subTest(keys=sorted(resolved)):
                self.assert_theme_lock_rejected({
                    "artifactType": "themeLock",
                    "schemaVersion": "1.0.0",
                    "projectId": "ppt-quality-test",
                    "resolvedFonts": resolved,
                })

    def test_rejects_real_font_child_beneath_default_run_properties(self):
        report = self.audit(self.make_pptx(extra_shapes=self.default_run_properties_shape_xml()))
        self.assert_only_failure(report, "fontResolution")
        violation = report["checks"]["fontResolution"]["violations"][0]
        self.assertEqual(violation["typeface"], "Source Han Serif SC")
        self.assertEqual(violation["sizePt"], 18.0)

    def test_rejects_critical_text_present_in_spec_but_missing_from_ooxml(self):
        report = self.audit(
            self.make_pptx(),
            expected_by_slide={1: "奔流到海不复回"},
        )
        self.assert_only_failure(report, "contentPresence")

    def test_records_invalid_native_critical_content_items_as_violations(self):
        cases = (
            ("collection-is-not-an-array", {"contentId": "critical-1", "text": "君不见"}),
            ("item-is-not-an-object", ["not-an-object"]),
            ("content-id-is-missing", [{"text": "君不见"}]),
            ("content-id-is-blank", [{"contentId": "   ", "text": "君不见"}]),
            ("text-is-not-a-string", [{"contentId": "critical-1", "text": 42}]),
            ("text-is-empty", [{"contentId": "critical-1", "text": ""}]),
            ("text-is-blank", [{"contentId": "critical-1", "text": "   "}]),
        )
        for case, native_critical_content in cases:
            with self.subTest(case=case):
                report = self.audit(
                    self.make_pptx(),
                    slide_specs_payload=self.slide_specs_with_native_critical_content(
                        native_critical_content,
                    ),
                )
                self.assert_only_failure(report, "contentPresence")
                violation = report["checks"]["contentPresence"]["violations"][0]
                self.assertEqual(violation["code"], "INVALID_CRITICAL_CONTENT")

    def test_records_duplicate_native_critical_content_ids_as_a_violation(self):
        native_critical_content = [
            {"contentId": "duplicate", "text": "君不见"},
            {"contentId": "duplicate", "text": "黄河之水天上来"},
        ]
        report = self.audit(
            self.make_pptx(),
            slide_specs_payload=self.slide_specs_with_native_critical_content(
                native_critical_content,
            ),
        )
        self.assert_only_failure(report, "contentPresence")
        violation = report["checks"]["contentPresence"]["violations"][0]
        self.assertEqual(violation["code"], "INVALID_CRITICAL_CONTENT")
        self.assertEqual(violation["contentId"], "duplicate")

    def test_accepts_runs_joined_within_one_paragraph(self):
        report = self.audit(self.make_pptx(paragraphs=[["君不见", "黄河之水天上来"]]))
        self.assert_clean_pass(report)

    def test_rejects_critical_text_falsely_joined_across_shapes(self):
        second_shape = self.shape_xml(
            shape_id=6,
            name="Second critical fragment",
            x=EMU_PER_INCH,
            y=3 * EMU_PER_INCH,
            cx=5 * EMU_PER_INCH,
            cy=EMU_PER_INCH,
            body_pr="<a:noAutofit/>",
            paragraphs=[["黄河之水天上来"]],
            latin_typeface="PingFang SC",
            ea_typeface="PingFang SC",
        )
        report = self.audit(self.make_pptx(
            paragraphs=[["君不见"]],
            extra_shapes=second_shape,
        ))
        self.assert_only_failure(report, "contentPresence")

    def test_rejects_critical_text_falsely_joined_across_paragraphs(self):
        report = self.audit(self.make_pptx(paragraphs=[["君不见"], ["黄河之水天上来"]]))
        self.assert_only_failure(report, "contentPresence")

    def test_rejects_full_slide_image_hidden_by_later_proven_opaque_shape(self):
        report = self.audit(self.make_pptx(hidden_cover_alpha_xml=""))
        self.assert_only_failure(report, "hiddenVisualResidue")

    def test_rejects_full_slide_image_hidden_by_explicit_full_opacity_shape(self):
        report = self.audit(self.make_pptx(hidden_cover_alpha_xml='<a:alpha val="100000"/>'))
        self.assert_only_failure(report, "hiddenVisualResidue")

    def test_does_not_count_semitransparent_full_slide_cover_as_hidden_residue(self):
        report = self.audit(self.make_pptx(hidden_cover_alpha_xml='<a:alpha val="50000"/>'))
        self.assert_clean_pass(report)

    def test_does_not_count_unresolved_alpha_transform_as_hidden_residue(self):
        report = self.audit(self.make_pptx(hidden_cover_alpha_xml='<a:alphaMod val="100000"/>'))
        self.assert_clean_pass(report)

    def test_does_not_count_alpha_offset_transform_as_hidden_residue(self):
        report = self.audit(self.make_pptx(hidden_cover_alpha_xml='<a:alphaOff val="0"/>'))
        self.assert_clean_pass(report)

    def test_template_compatibility_source_slide_is_exempt_but_enforced_slide_still_fails(self):
        deck = self.root / "template-mixed-policy.pptx"
        broken_slide = self.policy_broken_slide_xml()
        self.write_pptx(
            deck,
            {
                "ppt/slides/slide1.xml": broken_slide,
                "ppt/slides/slide2.xml": broken_slide,
            },
            [("rId1", "slides/slide1.xml"), ("rId2", "slides/slide2.xml")],
        )
        slide_specs = {
            "artifactType": "slideSpecs",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "route": "template",
            "slides": [
                {
                    "slide": 1,
                    "qualityMode": "compatibility-audit",
                    "authorization": "source-template",
                    "sourceObjectHash": f"sha256:{'a' * 64}",
                    "safeZone": {"pageNumberEdge": 0.3},
                    "nativeCriticalContent": [
                        {"contentId": "source-1", "text": "Required source text"},
                    ],
                },
                {
                    "slide": 2,
                    "qualityMode": "enforced",
                    "authorization": "new-slide",
                    "safeZone": {"pageNumberEdge": 0.3},
                    "nativeCriticalContent": [
                        {"contentId": "new-2", "text": "Required new text"},
                    ],
                },
            ],
        }
        report = self.audit(deck, slide_specs_payload=slide_specs)
        for check_id in CHECK_IDS:
            with self.subTest(check_id=check_id):
                self.assertEqual(report["checks"][check_id]["status"], "FAIL")
                self.assertEqual(
                    {item["slide"] for item in report["checks"][check_id]["violations"]},
                    {2},
                )

    def test_edit_unauthorized_compatibility_slide_does_not_receive_new_page_hard_zero_checks(self):
        deck = self.root / "edit-compatibility.pptx"
        self.write_pptx(
            deck,
            {"ppt/slides/slide1.xml": self.policy_broken_slide_xml()},
            [("rId1", "slides/slide1.xml")],
        )
        slide_specs = {
            "artifactType": "slideSpecs",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "route": "edit",
            "slides": [
                {
                    "slide": 1,
                    "qualityMode": "compatibility-audit",
                    "authorization": "unauthorized-preserve",
                    "sourceObjectHash": f"sha256:{'b' * 64}",
                    "safeZone": {"pageNumberEdge": 0.3},
                    "nativeCriticalContent": [
                        {"contentId": "preserved-1", "text": "Preserved source text"},
                    ],
                },
            ],
        }
        self.assert_clean_pass(self.audit(deck, slide_specs_payload=slide_specs))

    def test_compatibility_label_without_the_route_authorization_pair_remains_enforced(self):
        deck = self.root / "invalid-compatibility-pair.pptx"
        self.write_pptx(
            deck,
            {"ppt/slides/slide1.xml": self.policy_broken_slide_xml()},
            [("rId1", "slides/slide1.xml")],
        )
        slide_specs = {
            "artifactType": "slideSpecs",
            "schemaVersion": "1.0.0",
            "qualityContractVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "route": "edit",
            "slides": [
                {
                    "slide": 1,
                    "qualityMode": "compatibility-audit",
                    "authorization": "authorized-modify",
                    "safeZone": {"pageNumberEdge": 0.3},
                    "nativeCriticalContent": [
                        {"contentId": "modified-1", "text": "Required modified text"},
                    ],
                },
            ],
        }
        report = self.audit(deck, slide_specs_payload=slide_specs)
        for check_id in CHECK_IDS:
            with self.subTest(check_id=check_id):
                self.assertEqual(report["checks"][check_id]["status"], "FAIL")

    def assert_object_inventory_rejected(self, *, payload=None, text=None):
        completed, output = self.run_audit(
            self.make_pptx(),
            object_inventory_payload=payload,
            object_inventory_text=text,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(
            completed.stderr,
            r"object.?inventory|projectId|slides|JSON|Expecting",
        )

    def test_rejects_object_inventory_that_is_not_valid_json_object(self):
        self.assert_object_inventory_rejected(text="{")
        self.assert_object_inventory_rejected(text="[]")

    def test_rejects_object_inventory_project_id_mismatch(self):
        self.assert_object_inventory_rejected(payload={
            "artifactType": "objectInventory",
            "schemaVersion": "1.0.0",
            "projectId": "another-project",
            "slides": [{"slide": 1, "objects": []}],
        })

    def test_rejects_empty_object_inventory_for_a_nonempty_ooxml_slide(self):
        self.assert_object_inventory_rejected(payload={
            "artifactType": "objectInventory",
            "schemaVersion": "1.0.0",
            "projectId": "ppt-quality-test",
            "slides": [{"slide": 1, "objects": []}],
        })

    def test_rejects_malformed_duplicate_and_unbound_inventory_objects(self):
        valid = self.object_inventory_for_deck(self.make_pptx(), "ppt-quality-test")
        cases = []

        malformed = json.loads(json.dumps(valid))
        malformed["slides"][0]["objects"][0]["native"] = "yes"
        cases.append(("malformed-native", malformed))

        illegal_type = json.loads(json.dumps(valid))
        illegal_type["slides"][0]["objects"][0]["type"] = "unknown"
        cases.append(("illegal-type", illegal_type))

        duplicate = json.loads(json.dumps(valid))
        duplicate["slides"][0]["objects"][1]["objectId"] = duplicate["slides"][0]["objects"][0]["objectId"]
        cases.append(("duplicate-object-id", duplicate))

        unbound = json.loads(json.dumps(valid))
        unbound["slides"][0]["objects"][0]["objectId"] = "slide-1:shape-9999"
        cases.append(("unbound-ooxml-id", unbound))

        wrong_type = json.loads(json.dumps(valid))
        wrong_type["slides"][0]["objects"][0]["type"] = "chart"
        cases.append(("wrong-ooxml-type", wrong_type))

        for label, payload in cases:
            with self.subTest(case=label):
                self.assert_object_inventory_rejected(payload=payload)

    def test_rejects_high_compression_ratio_pptx_member_before_audit(self):
        deck = self.make_pptx()
        with ZipFile(deck, "a", ZIP_DEFLATED, compresslevel=9) as archive:
            archive.writestr("ppt/media/compression-bomb.bin", b"0" * (1024 * 1024))
        completed, output = self.run_audit(deck)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"compression ratio|ZIP.*limit|unsafe.*ZIP")

    def test_video_and_audio_picture_frames_bind_as_media_objects(self):
        for kind in ("videoFile", "audioFile"):
            with self.subTest(kind=kind):
                deck = self.make_pptx(extra_shapes=self.media_picture_xml(kind))
                inventory = self.object_inventory_for_deck(deck, "ppt-quality-test")
                media = next(
                    item for item in inventory["slides"][0]["objects"]
                    if item["objectId"] == "slide-1:shape-30"
                )
                media.update({"type": "media", "native": True, "flattened": False})
                self.assert_clean_pass(self.audit(deck, object_inventory_payload=inventory))

    def test_known_strict_drawingml_and_powerpoint_media_qnames_are_media(self):
        cases = (
            ("videoFile", STRICT_DRAWINGML_NAMESPACE),
            ("audioFile", STRICT_DRAWINGML_NAMESPACE),
            ("media", POWERPOINT_2010_NAMESPACE),
        )
        for kind, namespace in cases:
            with self.subTest(kind=kind, namespace=namespace):
                deck = self.make_pptx(
                    extra_shapes=self.media_picture_xml(kind, namespace=namespace),
                )
                inventory = self.object_inventory_for_deck(deck, "ppt-quality-test")
                media = next(
                    item for item in inventory["slides"][0]["objects"]
                    if item["objectId"] == "slide-1:shape-30"
                )
                media.update({"type": "media", "native": True, "flattened": False})
                self.assert_clean_pass(self.audit(deck, object_inventory_payload=inventory))

    def test_unknown_namespace_media_local_name_remains_a_plain_image(self):
        deck = self.make_pptx(
            extra_shapes=self.media_picture_xml("media", namespace="urn:not-office"),
        )
        inventory = self.object_inventory_for_deck(deck, "ppt-quality-test")
        self.assert_clean_pass(self.audit(deck, object_inventory_payload=inventory))

    def test_accepts_large_low_compression_opaque_media_member(self):
        deck = self.make_pptx()
        with ZipFile(deck, "a") as archive:
            archive.writestr(
                "ppt/media/large-video.mp4",
                b"media-frame-0123456789" * (17 * 1024 * 1024 // 22 + 1),
                compress_type=0,
            )
        self.assert_clean_pass(self.audit(deck))

    def test_rejects_malformed_object_inventory_slide_number_structure(self):
        invalid_slides_values = (
            [],
            "not-an-array",
            ["not-an-object"],
            [{"slide": 0, "objects": []}],
            [{"slide": True, "objects": []}],
            [{"slide": "1", "objects": []}],
            [
                {"slide": 1, "objects": []},
                {"slide": 1, "objects": []},
            ],
        )
        for slides in invalid_slides_values:
            with self.subTest(slides=slides):
                self.assert_object_inventory_rejected(payload={
                    "artifactType": "objectInventory",
                    "schemaVersion": "1.0.0",
                    "projectId": "ppt-quality-test",
                    "slides": slides,
                })

    def test_rejects_object_inventory_missing_a_slide_from_specs_and_displayed_deck(self):
        completed, output = self.run_audit(
            self.make_reordered_pptx(),
            expected_by_slide={1: "Displayed first", 2: "Displayed second"},
            object_inventory_payload={
                "artifactType": "objectInventory",
                "schemaVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "slides": [{"slide": 1, "objects": []}],
            },
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"object.?inventory.*slide|slide.*set|missing")

    def test_rejects_object_inventory_with_a_slide_absent_from_specs_and_deck(self):
        completed, output = self.run_audit(
            self.make_pptx(),
            object_inventory_payload={
                "artifactType": "objectInventory",
                "schemaVersion": "1.0.0",
                "projectId": "ppt-quality-test",
                "slides": [
                    {"slide": 1, "objects": []},
                    {"slide": 2, "objects": []},
                ],
            },
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"object.?inventory.*slide|slide.*set|extra")

    def test_rejects_duplicate_zip_member_names_before_reading_the_deck(self):
        deck = self.make_pptx()
        with ZipFile(deck, "a", ZIP_DEFLATED) as archive:
            duplicate_payload = archive.read("ppt/slides/slide1.xml")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr("ppt/slides/slide1.xml", duplicate_payload)
        completed, output = self.run_audit(deck)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"duplicate.*ZIP|ZIP.*duplicate")

    def test_rejects_duplicate_presentation_relationship_ids(self):
        text = "相同展示内容"
        deck = self.make_relationship_pptx(
            "duplicate-relationship-id.pptx",
            [
                ("rId1", "slides/slide1.xml"),
                ("rId1", "slides/slide2.xml"),
            ],
            [text, text],
        )
        completed, output = self.run_audit(
            deck,
            expected_by_slide={1: text, 2: text},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"duplicate.*relationship.*Id|relationship.*Id.*duplicate")

    def test_accepts_only_standard_slide_relationship_types_and_internal_modes(self):
        text = "标准关系"
        for relationship_type in (
            TRANSITIONAL_SLIDE_RELATIONSHIP_TYPE,
            STRICT_SLIDE_RELATIONSHIP_TYPE,
        ):
            for target_mode in (None, "Internal"):
                with self.subTest(
                    relationship_type=relationship_type,
                    target_mode=target_mode,
                ):
                    deck = self.make_relationship_pptx(
                        f"standard-{len(relationship_type)}-{target_mode or 'default'}.pptx",
                        [("rId1", "slides/slide1.xml", relationship_type, target_mode)],
                        [text],
                    )
                    self.assert_clean_pass(
                        self.audit(deck, expected_by_slide={1: text}),
                    )

    def test_rejects_slide_like_relationship_type_from_an_untrusted_namespace(self):
        text = "伪造关系类型"
        deck = self.make_relationship_pptx(
            "untrusted-slide-relationship-type.pptx",
            [("rId1", "slides/slide1.xml", "https://attacker.invalid/slide")],
            [text],
        )
        completed, output = self.run_audit(deck, expected_by_slide={1: text})
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())
        self.assertRegex(completed.stderr, r"slide.*relationship.*Type|unresolved.*relationship")

    def test_rejects_noncanonical_slide_relationship_target_modes(self):
        text = "关系模式"
        for target_mode in ("External", "external", "internal", "Bogus", " Internal "):
            with self.subTest(target_mode=target_mode):
                deck = self.make_relationship_pptx(
                    f"invalid-target-mode-{target_mode.strip()}.pptx",
                    [(
                        "rId1",
                        "slides/slide1.xml",
                        TRANSITIONAL_SLIDE_RELATIONSHIP_TYPE,
                        target_mode,
                    )],
                    [text],
                )
                completed, output = self.run_audit(deck, expected_by_slide={1: text})
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(output.exists())
                self.assertRegex(completed.stderr, r"TargetMode|unresolved.*relationship")

    def test_maps_slide_specs_by_presentation_display_order(self):
        report = self.audit(
            self.make_reordered_pptx(),
            expected_by_slide={1: "Displayed first", 2: "Displayed second"},
        )
        self.assert_clean_pass(report)


if __name__ == "__main__":
    unittest.main()
