import { readJson, writeJsonAtomic } from "./lib/atomic-json.mjs";
import { criticalContentHash, sha256File, stableJson } from "./lib/content-quality.mjs";
import {
  loadLayoutArchetypes,
  loadQualityContract,
  loadThemeCatalog,
} from "./lib/quality-contract.mjs";
import { assertVisualContractApproval } from "./lib/visual-contract.mjs";
import { currentPrebuildApprovalHashes } from "./lib/prebuild-approval.mjs";
import { validateSchema } from "./lib/schema-validator.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const EMBEDDING_STATUSES = new Set(["embedded", "not-embedded"]);
const CANONICAL_FONT_ROLES = Object.freeze(["cjkTitle", "cjkBody", "latin", "number"]);
const STRICT_SOURCE_HASH = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_GENERATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ZIP_PARSED_MEMBER_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_OPAQUE_MEMBER_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 200;
const MAX_SOURCE_PPTX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const SLIDE_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/slide",
]);
const CONTENT_TYPES_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/content-types",
  "http://purl.oclc.org/ooxml/package/content-types",
]);
const PACKAGE_RELATIONSHIPS_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://purl.oclc.org/ooxml/package/relationships",
]);
const PRESENTATION_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const OFFICE_RELATIONSHIPS_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ARTIFACTS_SCHEMA_PATH = path.resolve(
  SCRIPT_DIR,
  "../schemas/project-artifacts.schema.json",
);

function violation(code, slide, message) {
  return { code, slide, message };
}

function validateEnforcedSlide(slide, contract, layout) {
  const violations = [];
  const blocks = Array.isArray(slide.contentBlocks) ? slide.contentBlocks : [];
  if (blocks.length > layout.maxContentBlocks) {
    violations.push(violation("CONTENT_BLOCK_LIMIT", slide.slide, `maximum ${layout.maxContentBlocks}`));
  }
  const ids = blocks.map((block) => block.contentId);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    violations.push(violation("CONTENT_ID", slide.slide, "contentId values must be unique and nonempty"));
  }
  if (blocks.some((block) => !Number.isInteger(block.estimatedLines)
    || !Number.isInteger(block.maxLines) || block.estimatedLines > block.maxLines
    || block.maxLines > layout.maxLinesPerBlock)) {
    violations.push(violation("LINE_BUDGET", slide.slide, "estimatedLines must not exceed maxLines"));
  }
  const type = slide.typographyBudget || {};
  const floors = contract.typography;
  for (const [role, actual, minimum] of [
    ["title", type.title?.minimumPt, floors.titleMinimumPt],
    ["body", type.body?.minimumPt, floors.bodyMinimumPt],
    ["caption", type.caption?.minimumPt, floors.captionMinimumPt],
    ["source", type.source?.minimumPt, floors.sourceMinimumPt],
    ["pageNumber", type.pageNumber?.minimumPt, floors.pageNumberMinimumPt]
  ]) {
    if (!Number.isFinite(actual) || actual < minimum) {
      violations.push(violation("TYPOGRAPHY_FLOOR", slide.slide, `${role} must be at least ${minimum}pt`));
    }
  }
  if (!Number.isFinite(type.body?.targetPt) || type.body.targetPt < floors.bodyTargetPt) {
    violations.push(violation("BODY_TARGET", slide.slide, `body target must be at least ${floors.bodyTargetPt}pt`));
  }
  const safe = slide.safeZone || {};
  if (safe.unit !== "in" || [safe.top, safe.right, safe.bottom, safe.left]
    .some((value) => !Number.isFinite(value) || value < contract.safeMarginsInches.contentMinimum)) {
    violations.push(violation("SAFE_ZONE", slide.slide, "content safe zone is below the contract"));
  }
  if (!Number.isFinite(safe.pageNumberEdge) || safe.pageNumberEdge < contract.safeMarginsInches.pageNumberMinimum) {
    violations.push(violation("PAGE_NUMBER_EDGE", slide.slide, "page number edge is below the contract"));
  }
  const visual = slide.visualIntent || {};
  const requiredVisualArrays = ["supports", "requiredSubjects", "prohibitedElements", "textFreeZones", "cropFocus"];
  if (requiredVisualArrays.some((key) => !Array.isArray(visual[key]) || visual[key].length === 0)
    || typeof visual.semanticEvidence !== "string" || !visual.semanticEvidence.trim()) {
    violations.push(violation("VISUAL_INTENT", slide.slide, "complete visual intent is required"));
  }
  try {
    for (const item of slide.nativeCriticalContent || []) {
      if (typeof item.objectId !== "string"
        || !new RegExp(`^slide-${slide.slide}:shape-[1-9][0-9]*$`).test(item.objectId)
        || !["title", "body", "caption", "source", "pageNumber"].includes(item.typographyRole)) {
        violations.push(violation(
          "NATIVE_CRITICAL_CONTENT",
          slide.slide,
          "enforced nativeCriticalContent requires a slide-bound OOXML objectId and typographyRole",
        ));
        break;
      }
    }
    if (slide.contentHash !== criticalContentHash(slide.nativeCriticalContent)) {
      violations.push(violation("CONTENT_HASH", slide.slide, "critical content hash mismatch"));
    }
  } catch (error) {
    violations.push(violation("NATIVE_CRITICAL_CONTENT", slide.slide, error.message));
  }
  if (!Array.isArray(slide.overflowPolicy)
    || slide.overflowPolicy.join(",") !== "split-semantic-unit,compress-without-fact-change,switch-verified-layout") {
    violations.push(violation("OVERFLOW_POLICY", slide.slide, "approved overflow policy is required"));
  }
  return violations;
}

function validateCompatibilitySlide(slide, route) {
  const allowed = route === "template"
    ? new Set(["source-template"])
    : route === "edit"
      ? new Set(["unauthorized-preserve"])
      : new Set();
  if (!allowed.has(slide.authorization)
    || !/^sha256:[0-9a-f]{64}$/.test(slide.sourceObjectHash || "")) {
    return [violation("COMPATIBILITY_PROOF", slide.slide, "route authorization and sourceObjectHash must be a lowercase SHA-256 digest")];
  }
  return [];
}

function validateRouteMatrix(slide, route) {
  if (route === "create") {
    return slide.qualityMode === "enforced"
      ? []
      : [violation("ROUTE_QUALITY_MODE", slide.slide, "create route requires enforced qualityMode")];
  }
  if (route === "template") {
    if (slide.authorization === "source-template") {
      return slide.qualityMode === "compatibility-audit"
        ? []
        : [violation("ROUTE_QUALITY_MODE", slide.slide, "source-template pages require compatibility-audit qualityMode")];
    }
    if (slide.authorization === "new-slide") {
      return slide.qualityMode === "enforced"
        ? []
        : [violation("ROUTE_QUALITY_MODE", slide.slide, "template new pages require enforced qualityMode")];
    }
    return [violation("ROUTE_AUTHORIZATION", slide.slide, "template route requires source-template or new-slide authorization")];
  }
  if (route === "edit") {
    if (slide.authorization === "unauthorized-preserve") {
      return slide.qualityMode === "compatibility-audit"
        ? []
        : [violation("ROUTE_QUALITY_MODE", slide.slide, "unauthorized-preserve pages require compatibility-audit qualityMode")];
    }
    if (slide.authorization === "authorized-modify") {
      return slide.qualityMode === "enforced"
        ? []
        : [violation("ROUTE_QUALITY_MODE", slide.slide, "edit authorized pages require enforced qualityMode")];
    }
    return [violation("ROUTE_AUTHORIZATION", slide.slide, "edit route requires unauthorized-preserve or authorized-modify authorization")];
  }
  return [violation("ROUTE", slide.slide, "unsupported slide-spec route")];
}

function assertCanonicalResolvedFonts(themeLock) {
  if (!themeLock.resolvedFonts || typeof themeLock.resolvedFonts !== "object"
    || Array.isArray(themeLock.resolvedFonts)) {
    throw new Error("themeLock.resolvedFonts must contain exactly the canonical font roles");
  }
  const actualRoles = Object.keys(themeLock.resolvedFonts).sort();
  const expectedRoles = [...CANONICAL_FONT_ROLES].sort();
  if (actualRoles.length !== expectedRoles.length
    || actualRoles.some((role, index) => role !== expectedRoles[index])) {
    const missing = expectedRoles.filter((role) => !actualRoles.includes(role));
    if (missing.length > 0) {
      throw new Error(`themeLock.resolvedFonts.${missing[0]} must be a nonempty resolved font`);
    }
    throw new Error(`themeLock.resolvedFonts must contain exactly: ${CANONICAL_FONT_ROLES.join(", ")}`);
  }
  for (const role of CANONICAL_FONT_ROLES) {
    if (typeof themeLock.resolvedFonts?.[role] !== "string" || !themeLock.resolvedFonts[role].trim()) {
      throw new Error(`themeLock.resolvedFonts.${role} must be a nonempty resolved font`);
    }
  }
}

async function assertOrdinaryNonemptyFile(filePath, label) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`${label} must reference a nonempty file (ordinary file required): ${filePath}`);
  }
  return stats;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafePackageMemberName(name, label) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")) {
    throw new Error(`${label} source contains an unsafe PPTX ZIP member name: ${name}`);
  }
  const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} source contains an unsafe PPTX ZIP member name: ${name}`);
  }
}

function zipMemberOutputLimit(name) {
  return name === "[Content_Types].xml" || name.endsWith(".xml") || name.endsWith(".rels")
    ? MAX_ZIP_PARSED_MEMBER_OUTPUT_BYTES
    : MAX_ZIP_OPAQUE_MEMBER_OUTPUT_BYTES;
}

function readZipDirectory(bytes, label) {
  const endSignature = 0x06054b50;
  const minimumEndSize = 22;
  const earliestEnd = Math.max(0, bytes.length - 0xffff - minimumEndSize);
  let endOffset = -1;
  for (let offset = bytes.length - minimumEndSize; offset >= earliestEnd; offset -= 1) {
    if (bytes.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error(`${label} source must be a PPTX ZIP/OPC container`);
  }
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (endOffset + minimumEndSize + commentLength !== bytes.length
    || diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries
    || totalEntries === 0 || totalEntries === 0xffff
    || centralOffset + centralSize > endOffset) {
    throw new Error(`${label} source has an invalid or unsupported PPTX ZIP directory`);
  }

  const entries = new Map();
  const localRanges = [];
  let totalUncompressedSize = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`${label} source has an invalid PPTX ZIP central entry`);
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > endOffset || localOffset + 30 > centralOffset
      || bytes.readUInt32LE(localOffset) !== 0x04034b50
      || diskStart !== 0
      || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff) {
      throw new Error(`${label} source has an invalid PPTX ZIP entry boundary`);
    }
    if ((flags & 0x0001) !== 0) {
      throw new Error(`${label} source uses unsupported encrypted PPTX ZIP content`);
    }
    if (![0, 8].includes(method)) {
      throw new Error(`${label} source uses unsupported PPTX ZIP compression method ${method}`);
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assertSafePackageMemberName(name, label);
    if (uncompressedSize > zipMemberOutputLimit(name)) {
      throw new Error(`${label} source PPTX ZIP member exceeds its uncompressed member limit`);
    }
    totalUncompressedSize += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedSize)
      || totalUncompressedSize > MAX_ZIP_TOTAL_OUTPUT_BYTES) {
      throw new Error(`${label} source PPTX ZIP exceeds the total uncompressed output limit`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`${label} source has inconsistent stored ZIP sizes`);
    }
    if (uncompressedSize > 0
      && (compressedSize === 0 || uncompressedSize > compressedSize * MAX_ZIP_COMPRESSION_RATIO)) {
      throw new Error(`${label} source PPTX ZIP member exceeds the compression ratio limit`);
    }
    if (entries.has(name)) {
      throw new Error(`${label} source contains duplicate PPTX ZIP member: ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    if (localNameEnd + localExtraLength > centralOffset
      || bytes.subarray(localOffset + 30, localNameEnd).toString("utf8") !== name
      || bytes.readUInt16LE(localOffset + 6) !== flags
      || bytes.readUInt16LE(localOffset + 8) !== method) {
      throw new Error(`${label} source has inconsistent PPTX ZIP entry names`);
    }
    if ((flags & 0x0008) === 0
      && (bytes.readUInt32LE(localOffset + 14) !== expectedCrc32
        || bytes.readUInt32LE(localOffset + 18) !== compressedSize
        || bytes.readUInt32LE(localOffset + 22) !== uncompressedSize)) {
      throw new Error(`${label} source has inconsistent PPTX ZIP entry metadata`);
    }
    const dataOffset = localNameEnd + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) {
      throw new Error(`${label} source has an invalid PPTX ZIP compressed-data boundary`);
    }
    entries.set(name, {
      name,
      flags,
      method,
      expectedCrc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset,
      dataEnd,
    });
    localRanges.push([localOffset, dataEnd, name]);
    cursor = entryEnd;
  }
  if (cursor !== centralOffset + centralSize || cursor !== endOffset) {
    throw new Error(`${label} source has an invalid PPTX ZIP central directory size`);
  }
  localRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index][0] < localRanges[index - 1][1]) {
      throw new Error(`${label} source has overlapping PPTX ZIP members`);
    }
  }
  return entries;
}

function readZipEntry(bytes, entry, label) {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataEnd);
  let payload;
  try {
    if (entry.method === 0) payload = Buffer.from(compressed);
    else if (entry.method === 8) {
      const inflation = inflateRawSync(compressed, {
        maxOutputLength: Math.min(
          entry.uncompressedSize + 1,
          zipMemberOutputLimit(entry.name) + 1,
        ),
        info: true,
      });
      payload = inflation.buffer;
      if (inflation.engine.bytesWritten !== compressed.length) {
        throw new Error("compressed stream has trailing input");
      }
    }
    else throw new Error(`unsupported compression method ${entry.method}`);
  } catch (error) {
    throw new Error(`${label} source cannot decompress ${entry.name}: ${error.message}`);
  }
  if (payload.length !== entry.uncompressedSize) {
    throw new Error(`${label} source has an invalid uncompressed size for ${entry.name}`);
  }
  if (crc32(payload) !== entry.expectedCrc32) {
    throw new Error(`${label} source has a CRC mismatch for ${entry.name}`);
  }
  return payload;
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/;
const XML_NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["apos", "'"],
  ["quot", '"'],
]);
const XML_DECIMAL_CHARACTER_REFERENCE = /^#([0-9]+)$/;
const XML_HEXADECIMAL_CHARACTER_REFERENCE = /^#x([0-9A-Fa-f]+)$/;

function isLegalXmlCodePoint(codePoint) {
  return codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeXmlEntity(entity) {
  if (XML_NAMED_ENTITIES.has(entity)) return XML_NAMED_ENTITIES.get(entity);
  const decimal = entity.match(XML_DECIMAL_CHARACTER_REFERENCE);
  const hexadecimal = entity.match(XML_HEXADECIMAL_CHARACTER_REFERENCE);
  const digits = decimal?.[1] || hexadecimal?.[1];
  if (!digits) return undefined;
  const codePoint = Number.parseInt(digits, decimal ? 10 : 16);
  if (!Number.isSafeInteger(codePoint) || !isLegalXmlCodePoint(codePoint)) return undefined;
  return String.fromCodePoint(codePoint);
}

function decodeXmlEntities(value, label) {
  let decoded = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("&", cursor);
    if (start < 0) return decoded + value.slice(cursor);
    decoded += value.slice(cursor, start);
    const end = value.indexOf(";", start + 1);
    const replacement = end < 0 ? undefined : decodeXmlEntity(value.slice(start + 1, end));
    if (replacement === undefined) {
      throw new Error(`${label} contains an invalid XML entity`);
    }
    decoded += replacement;
    cursor = end + 1;
  }
  return decoded;
}

function assertXmlEntities(value, label) {
  decodeXmlEntities(value, label);
}

function assertXml10Characters(xml, label) {
  for (let index = 0; index < xml.length;) {
    const codePoint = xml.codePointAt(index);
    if (!isLegalXmlCodePoint(codePoint)) {
      throw new Error(
        `${label} contains an illegal XML 1.0 character U+${codePoint.toString(16).toUpperCase()}`,
      );
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function findXmlTagEnd(xml, start, label) {
  let quote;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error(`${label} is not well-formed XML: unterminated element`);
}

function parseXmlStartTag(raw, label) {
  let source = raw.trim();
  const selfClosing = source.endsWith("/");
  if (selfClosing) source = source.slice(0, -1).trimEnd();
  const nameMatch = source.match(XML_NAME);
  if (!nameMatch || nameMatch.index !== 0) {
    throw new Error(`${label} is not well-formed XML: invalid element name`);
  }
  const name = nameMatch[0];
  const attrs = {};
  let cursor = name.length;
  while (cursor < source.length) {
    if (!/\s/.test(source[cursor])) {
      throw new Error(`${label} is not well-formed XML: invalid attribute boundary`);
    }
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;
    const attributeMatch = source.slice(cursor).match(XML_NAME);
    if (!attributeMatch || attributeMatch.index !== 0) {
      throw new Error(`${label} is not well-formed XML: invalid attribute name`);
    }
    const attributeName = attributeMatch[0];
    if (Object.hasOwn(attrs, attributeName)) {
      throw new Error(`${label} is not well-formed XML: duplicate attribute ${attributeName}`);
    }
    cursor += attributeName.length;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "=") {
      throw new Error(`${label} is not well-formed XML: attribute ${attributeName} lacks '='`);
    }
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const quote = source[cursor];
    if (quote !== "\"" && quote !== "'") {
      throw new Error(`${label} is not well-formed XML: attribute ${attributeName} is not quoted`);
    }
    const end = source.indexOf(quote, cursor + 1);
    if (end < 0) {
      throw new Error(`${label} is not well-formed XML: unterminated attribute ${attributeName}`);
    }
    const value = source.slice(cursor + 1, end);
    if (value.includes("<")) {
      throw new Error(`${label} is not well-formed XML: attribute ${attributeName} contains '<'`);
    }
    attrs[attributeName] = decodeXmlEntities(value, label);
    cursor = end + 1;
  }
  return { name, attrs, selfClosing };
}

function qualifiedNameParts(qualifiedName) {
  const separator = qualifiedName.indexOf(":");
  return separator < 0
    ? { prefix: undefined, localName: qualifiedName }
    : {
      prefix: qualifiedName.slice(0, separator),
      localName: qualifiedName.slice(separator + 1),
    };
}

function resolveExpandedName(qualifiedName, bindings, { attribute, label }) {
  const { prefix, localName: expandedLocalName } = qualifiedNameParts(qualifiedName);
  if (prefix !== undefined) {
    const namespaceUri = bindings.get(prefix);
    if (!namespaceUri) {
      throw new Error(`${label} is not well-formed XML: unbound namespace prefix ${prefix}`);
    }
    return { qualifiedName, prefix, localName: expandedLocalName, namespaceUri };
  }
  return {
    qualifiedName,
    prefix: undefined,
    localName: expandedLocalName,
    namespaceUri: attribute ? null : (bindings.get("") || null),
  };
}

function resolveElementNamespaces(element, parentBindings, label) {
  const bindings = new Map(parentBindings);
  for (const [attributeName, namespaceUri] of Object.entries(element.attrs)) {
    if (attributeName === "xmlns") {
      if (namespaceUri === XMLNS_NAMESPACE || namespaceUri === XML_NAMESPACE) {
        throw new Error(`${label} is not well-formed XML: invalid default namespace binding`);
      }
      bindings.set("", namespaceUri);
      continue;
    }
    const { prefix, localName: declaredPrefix } = qualifiedNameParts(attributeName);
    if (prefix !== "xmlns") continue;
    if (declaredPrefix === "xmlns" || !namespaceUri) {
      throw new Error(`${label} is not well-formed XML: invalid namespace binding for ${declaredPrefix}`);
    }
    if (declaredPrefix === "xml" && namespaceUri !== XML_NAMESPACE) {
      throw new Error(`${label} is not well-formed XML: xml prefix has an invalid namespace`);
    }
    if (declaredPrefix !== "xml" && namespaceUri === XML_NAMESPACE) {
      throw new Error(`${label} is not well-formed XML: XML namespace requires the xml prefix`);
    }
    if (namespaceUri === XMLNS_NAMESPACE) {
      throw new Error(`${label} is not well-formed XML: xmlns namespace cannot be rebound`);
    }
    bindings.set(declaredPrefix, namespaceUri);
  }

  const expandedName = resolveExpandedName(element.name, bindings, {
    attribute: false,
    label,
  });
  const attributes = [];
  const expandedAttributeNames = new Set();
  for (const [attributeName, value] of Object.entries(element.attrs)) {
    const { prefix } = qualifiedNameParts(attributeName);
    if (attributeName === "xmlns" || prefix === "xmlns") continue;
    const expanded = resolveExpandedName(attributeName, bindings, {
      attribute: true,
      label,
    });
    const key = `${expanded.namespaceUri || ""}\0${expanded.localName}`;
    if (expandedAttributeNames.has(key)) {
      throw new Error(
        `${label} is not well-formed XML: duplicate expanded attribute ${attributeName}`,
      );
    }
    expandedAttributeNames.add(key);
    attributes.push({ ...expanded, value });
  }
  return { ...element, expandedName, attributes, namespaceBindings: bindings };
}

function parseXmlDocument(bytes, label) {
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 XML: ${error.message}`);
  }
  if (xml.startsWith("\ufeff")) xml = xml.slice(1);
  assertXml10Characters(xml, label);
  if (!xml.trim()) throw new Error(`${label} XML must be nonempty`);

  const stack = [];
  const elements = [];
  let rootName;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    const text = start < 0 ? xml.slice(cursor) : xml.slice(cursor, start);
    assertXmlEntities(text, label);
    if (stack.length === 0 && text.trim()) {
      throw new Error(`${label} is not well-formed XML: text outside the root element`);
    }
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0 || xml.slice(start + 4, end).includes("--")) {
        throw new Error(`${label} is not well-formed XML: invalid comment`);
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      if (stack.length === 0) {
        throw new Error(`${label} is not well-formed XML: CDATA outside the root element`);
      }
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) throw new Error(`${label} is not well-formed XML: unterminated CDATA`);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) throw new Error(`${label} is not well-formed XML: unterminated processing instruction`);
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) {
      throw new Error(`${label} XML declarations other than comments and CDATA are unsupported`);
    }
    const end = findXmlTagEnd(xml, start + 1, label);
    const raw = xml.slice(start + 1, end);
    if (/^\s/.test(raw)) {
      throw new Error(`${label} is not well-formed XML: whitespace after '<'`);
    }
    if (raw.startsWith("/")) {
      const closingSource = raw.slice(1);
      if (/^\s/.test(closingSource)) {
        throw new Error(`${label} is not well-formed XML: whitespace after '</'`);
      }
      const closingName = closingSource.trimEnd();
      const openElement = stack.pop();
      if (!XML_NAME.test(closingName) || closingName.match(XML_NAME)?.[0] !== closingName
        || openElement?.name !== closingName) {
        throw new Error(`${label} is not well-formed XML: mismatched closing element ${closingName}`);
      }
    } else {
      const parsedElement = parseXmlStartTag(raw, label);
      const parentBindings = stack.at(-1)?.namespaceBindings || new Map([["xml", XML_NAMESPACE]]);
      const element = resolveElementNamespaces(parsedElement, parentBindings, label);
      if (stack.length === 0) {
        if (rootName !== undefined) {
          throw new Error(`${label} is not well-formed XML: multiple root elements`);
        }
        rootName = element.expandedName;
      }
      elements.push({
        ...element,
        ancestors: stack.map((ancestor) => ancestor.expandedName),
      });
      if (!element.selfClosing) stack.push(element);
    }
    cursor = end + 1;
  }
  if (stack.length !== 0 || rootName === undefined) {
    throw new Error(`${label} is not well-formed XML: unclosed or missing root element`);
  }
  return { rootName, elements };
}

function hasExpandedName(value, localName, namespaceUri) {
  return value?.localName === localName && value?.namespaceUri === namespaceUri;
}

function assertXmlRoot(document, expected, namespaces, label) {
  if (document.rootName?.localName !== expected
    || !namespaces.has(document.rootName?.namespaceUri)) {
    throw new Error(`${label} XML root must be ${expected} in a supported namespace`);
  }
  return document.rootName.namespaceUri;
}

function relationshipRecords(document, label) {
  const namespaceUri = assertXmlRoot(
    document,
    "Relationships",
    PACKAGE_RELATIONSHIPS_NAMESPACES,
    label,
  );
  const relationships = [];
  const ids = new Set();
  for (const element of document.elements.filter((item) => (
    hasExpandedName(item.expandedName, "Relationship", namespaceUri)
    && item.ancestors.length === 1
    && hasExpandedName(item.ancestors[0], "Relationships", namespaceUri)
  ))) {
    const { Id: id, Type: type, Target: target, TargetMode: targetMode } = element.attrs;
    if (!id || !type || !target || ids.has(id)) {
      throw new Error(`${label} contains an invalid or duplicate relationship`);
    }
    ids.add(id);
    relationships.push({ id, type, target, targetMode });
  }
  return relationships;
}

function isInternalRelationship(relationship) {
  return relationship.targetMode === undefined || relationship.targetMode === "Internal";
}

function resolvePackageTarget(target, baseDirectory, label) {
  if (typeof target !== "string" || !target || target.includes("\\")
    || target.includes("\0") || target.includes("?") || target.includes("#")) {
    throw new Error(`${label} has an unsafe relationship target`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new Error(`${label} has an unsafe relationship target`);
  }
  if (decoded.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
    throw new Error(`${label} has an unsafe relationship target`);
  }
  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} has an unsafe relationship target`);
  }
  const resolved = decoded.startsWith("/")
    ? relative
    : [...(baseDirectory ? baseDirectory.split("/") : []), ...parts].join("/");
  assertSafePackageMemberName(resolved, label);
  return resolved;
}

function contentTypeOverrides(document, label) {
  const namespaceUri = assertXmlRoot(document, "Types", CONTENT_TYPES_NAMESPACES, label);
  const overrides = new Map();
  for (const element of document.elements.filter((item) => (
    hasExpandedName(item.expandedName, "Override", namespaceUri)
    && item.ancestors.length === 1
    && hasExpandedName(item.ancestors[0], "Types", namespaceUri)
  ))) {
    const partName = element.attrs.PartName;
    const contentType = element.attrs.ContentType;
    if (!partName?.startsWith("/") || !contentType) {
      throw new Error(`${label} contains an invalid content-type Override`);
    }
    const normalized = resolvePackageTarget(partName, "", label);
    if (overrides.has(normalized)) {
      throw new Error(`${label} contains a duplicate content-type declaration for ${normalized}`);
    }
    overrides.set(normalized, contentType);
  }
  return overrides;
}

function requiredEntry(entries, name, label) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`${label} source PPTX OPC container is missing ${name}`);
  return entry;
}

async function assertPptxOpcContainer(sourcePath, label, sourceStats) {
  const stats = sourceStats || await fs.stat(sourcePath);
  if (stats.size > MAX_SOURCE_PPTX_COMPRESSED_BYTES) {
    throw new Error(`${label} compressed source exceeds the PPTX source file size limit`);
  }
  const bytes = await fs.readFile(sourcePath);
  const entries = readZipDirectory(bytes, label);
  const missing = ["[Content_Types].xml", "ppt/presentation.xml"]
    .filter((name) => !entries.has(name));
  if (missing.length > 0) {
    throw new Error(`${label} source PPTX OPC container is missing ${missing.join(", ")}`);
  }
  if (![...entries.keys()].some((name) => /^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(name))) {
    throw new Error(`${label} source PPTX OPC container must contain a presentation slide part`);
  }
  const relationshipParts = ["_rels/.rels", "ppt/_rels/presentation.xml.rels"];
  const missingRelationships = relationshipParts.filter((name) => !entries.has(name));
  if (missingRelationships.length > 0) {
    throw new Error(`${label} source PPTX OPC container is missing relationship part ${missingRelationships.join(", ")}`);
  }

  const contentTypes = parseXmlDocument(
    readZipEntry(bytes, requiredEntry(entries, "[Content_Types].xml", label), label),
    `${label} [Content_Types].xml`,
  );
  const overrides = contentTypeOverrides(contentTypes, `${label} [Content_Types].xml`);
  if (overrides.get("ppt/presentation.xml")
    !== "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml") {
    throw new Error(`${label} source content types must declare ppt/presentation.xml`);
  }

  const rootRelationships = relationshipRecords(parseXmlDocument(
    readZipEntry(bytes, requiredEntry(entries, "_rels/.rels", label), label),
    `${label} _rels/.rels`,
  ), `${label} _rels/.rels`);
  const officeDocuments = rootRelationships.filter((relationship) => (
    OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type)
  ));
  if (officeDocuments.length !== 1
    || !isInternalRelationship(officeDocuments[0])
    || resolvePackageTarget(officeDocuments[0].target, "", `${label} officeDocument`) !== "ppt/presentation.xml") {
    throw new Error(`${label} root relationships must contain one internal officeDocument targeting ppt/presentation.xml`);
  }

  const presentation = parseXmlDocument(
    readZipEntry(bytes, requiredEntry(entries, "ppt/presentation.xml", label), label),
    `${label} ppt/presentation.xml`,
  );
  const presentationNamespace = assertXmlRoot(
    presentation,
    "presentation",
    PRESENTATION_NAMESPACES,
    `${label} ppt/presentation.xml`,
  );
  const slideIds = presentation.elements.filter((element) => (
    hasExpandedName(element.expandedName, "sldId", presentationNamespace)
    && element.ancestors.length === 2
    && hasExpandedName(element.ancestors[0], "presentation", presentationNamespace)
    && hasExpandedName(element.ancestors[1], "sldIdLst", presentationNamespace)
  )).map((element) => element.attributes.find((attribute) => (
    attribute.localName === "id"
    && OFFICE_RELATIONSHIPS_NAMESPACES.has(attribute.namespaceUri)
  ))?.value);
  if (slideIds.length === 0 || slideIds.some((id) => !id) || new Set(slideIds).size !== slideIds.length) {
    throw new Error(`${label} presentation sldIdLst must reference at least one unique slide relationship`);
  }

  const presentationRelationships = relationshipRecords(parseXmlDocument(
    readZipEntry(bytes, requiredEntry(entries, "ppt/_rels/presentation.xml.rels", label), label),
    `${label} ppt/_rels/presentation.xml.rels`,
  ), `${label} ppt/_rels/presentation.xml.rels`);
  const relationshipById = new Map(presentationRelationships.map((relationship) => [
    relationship.id,
    relationship,
  ]));
  const linkedSlides = new Set();
  for (const slideId of slideIds) {
    const relationship = relationshipById.get(slideId);
    if (!relationship || !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)
      || !isInternalRelationship(relationship)) {
      throw new Error(`${label} presentation slide relationship ${slideId} is missing or invalid`);
    }
    const slidePart = resolvePackageTarget(
      relationship.target,
      "ppt",
      `${label} presentation slide relationship ${slideId}`,
    );
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(slidePart) || !entries.has(slidePart)) {
      throw new Error(`${label} presentation slide relationship ${slideId} targets a missing slide part`);
    }
    if (overrides.get(slidePart)
      !== "application/vnd.openxmlformats-officedocument.presentationml.slide+xml") {
      throw new Error(`${label} source content types must declare slide part ${slidePart}`);
    }
    const slideDocument = parseXmlDocument(
      readZipEntry(bytes, requiredEntry(entries, slidePart, label), label),
      `${label} ${slidePart}`,
    );
    assertXmlRoot(
      slideDocument,
      "sld",
      PRESENTATION_NAMESPACES,
      `${label} ${slidePart}`,
    );
    linkedSlides.add(slidePart);
  }
  if (linkedSlides.size === 0) {
    throw new Error(`${label} presentation must resolve at least one actual slide part`);
  }
}

async function assertVisualSampleBindings(themeLock, themeLockPath, route) {
  const isVisualApprovalRoute = route === "create" || route === "template";
  const hasPaths = themeLock.samplePaths !== undefined;
  const hasHashes = themeLock.sampleHashes !== undefined;
  if (!isVisualApprovalRoute && !hasPaths && !hasHashes) return;
  if (isVisualApprovalRoute
    && (!Array.isArray(themeLock.samplePaths) || !Array.isArray(themeLock.sampleHashes)
      || themeLock.samplePaths.length !== 2 || themeLock.sampleHashes.length !== 2)) {
    throw new Error("themeLock.samplePaths and sampleHashes must contain exactly two visual samples");
  }
  if (!isVisualApprovalRoute
    && (!Array.isArray(themeLock.samplePaths) || !Array.isArray(themeLock.sampleHashes)
      || themeLock.samplePaths.length !== 2 || themeLock.sampleHashes.length !== 2)) {
    throw new Error(
      "themeLock.samplePaths and sampleHashes must contain exactly two visual samples when present",
    );
  }
  const seenPaths = new Set();
  for (let index = 0; index < themeLock.samplePaths.length; index += 1) {
    const declaredPath = themeLock.samplePaths[index];
    const declaredHash = themeLock.sampleHashes[index];
    if (typeof declaredPath !== "string" || !declaredPath.trim()) {
      throw new Error(`themeLock.samplePaths[${index}] must be a nonempty path`);
    }
    if (!STRICT_SOURCE_HASH.test(declaredHash || "")) {
      throw new Error(`themeLock.sampleHashes[${index}] must be a lowercase SHA-256 digest`);
    }
    const samplePath = path.isAbsolute(declaredPath)
      ? path.resolve(declaredPath)
      : path.resolve(path.dirname(themeLockPath), declaredPath);
    if (seenPaths.has(samplePath)) {
      throw new Error("themeLock.samplePaths must identify unique visual sample files");
    }
    seenPaths.add(samplePath);
    await assertOrdinaryNonemptyFile(samplePath, `visual sample samplePaths[${index}]`);
    const actualHash = await sha256File(samplePath);
    if (actualHash !== declaredHash) {
      throw new Error(
        `visual sample hash mismatch for samplePaths[${index}]: expected ${declaredHash}, received ${actualHash}`,
      );
    }
  }
}

async function assertSourceBinding(themeLock, themeLockPath, {
  pathField,
  hashField,
  label,
}) {
  if (!STRICT_SOURCE_HASH.test(themeLock[hashField] || "")) {
    throw new Error(`${label} fontResolutionMode requires ${hashField} as a lowercase SHA-256 digest`);
  }
  if (typeof themeLock[pathField] !== "string" || !themeLock[pathField].trim()) {
    throw new Error(`${label} fontResolutionMode requires ${pathField} as a nonempty path`);
  }
  const sourcePath = path.isAbsolute(themeLock[pathField])
    ? path.resolve(themeLock[pathField])
    : path.resolve(path.dirname(themeLockPath), themeLock[pathField]);
  const sourceStats = await assertOrdinaryNonemptyFile(sourcePath, `${label} source`);
  await assertPptxOpcContainer(sourcePath, label, sourceStats);
  const actualHash = await sha256File(sourcePath);
  if (actualHash !== themeLock[hashField]) {
    throw new Error(`${label} source hash mismatch: expected ${themeLock[hashField]}, received ${actualHash}`);
  }
  return sourcePath;
}

async function assertFontResolutionMode(themeLock, themeLockPath, route, themeCatalog) {
  const mode = themeLock.fontResolutionMode;
  if (route === "create" && mode !== "theme-catalog") {
    throw new Error("create route fontResolutionMode must be theme-catalog");
  }
  if (mode === "theme-catalog") {
    const theme = themeCatalog.themes.find((candidate) => candidate.id === themeLock.themeId);
    if (!theme) throw new Error(`theme-catalog font resolution requires a known themeId: ${themeLock.themeId}`);
    const candidatesByRole = {
      cjkTitle: theme.typography?.cjkTitleCandidates,
      cjkBody: theme.typography?.cjkBodyCandidates,
      latin: theme.typography?.latinCandidates,
      number: theme.typography?.numberCandidates,
    };
    for (const role of CANONICAL_FONT_ROLES) {
      const candidates = candidatesByRole[role];
      if (!Array.isArray(candidates) || !candidates.includes(themeLock.resolvedFonts[role])) {
        throw new Error(
          `themeLock.resolvedFonts.${role} must match a ${themeLock.themeId} ${role} candidate`,
        );
      }
    }
    return;
  }
  if (mode === "source-template") {
    if (route !== "template") {
      throw new Error("source-template fontResolutionMode is allowed only on the template route");
    }
    await assertSourceBinding(themeLock, themeLockPath, {
      pathField: "templatePath",
      hashField: "templateHash",
      label: "source-template",
    });
    return;
  }
  if (mode === "source-edit") {
    if (route !== "edit") {
      throw new Error("source-edit fontResolutionMode is allowed only on the edit route");
    }
    await assertSourceBinding(themeLock, themeLockPath, {
      pathField: "sourcePptPath",
      hashField: "sourcePptHash",
      label: "source-edit",
    });
    return;
  }
  throw new Error("themeLock.fontResolutionMode must be theme-catalog, source-template, or source-edit");
}

async function resolveFontEvidence(themeLock, themeLockPath, route, themeCatalog, schema) {
  assertCanonicalResolvedFonts(themeLock);
  await assertFontResolutionMode(themeLock, themeLockPath, route, themeCatalog);
  if (!EMBEDDING_STATUSES.has(themeLock.embeddingStatus)) {
    throw new Error("themeLock.embeddingStatus must be embedded or not-embedded");
  }
  if (typeof themeLock.targetClient !== "string" || !themeLock.targetClient.trim()) {
    throw new Error("themeLock.targetClient must be a nonempty target client");
  }
  if (typeof themeLock.fontEvidencePath !== "string" || !themeLock.fontEvidencePath.trim()) {
    throw new Error("themeLock.fontEvidencePath must be a nonempty path");
  }
  const fontEvidencePath = path.isAbsolute(themeLock.fontEvidencePath)
    ? themeLock.fontEvidencePath
    : path.resolve(path.dirname(themeLockPath), themeLock.fontEvidencePath);
  await assertOrdinaryNonemptyFile(fontEvidencePath, "themeLock.fontEvidencePath");
  let evidence;
  try {
    evidence = await readJson(fontEvidencePath);
  } catch (error) {
    throw new Error(`themeLock font evidence must be structured JSON: ${error.message}`);
  }
  const validation = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/fontResolutionEvidence" },
    evidence,
  );
  if (!validation.valid) {
    throw new Error(`themeLock font evidence failed schema validation: ${validation.errors.join("; ")}`);
  }
  if (stableJson(evidence.resolvedFonts) !== stableJson(themeLock.resolvedFonts)) {
    throw new Error("themeLock font evidence resolvedFonts mismatch");
  }
  if (evidence.targetClient !== themeLock.targetClient) {
    throw new Error("themeLock font evidence targetClient mismatch");
  }
  if (evidence.embeddingStatus !== themeLock.embeddingStatus) {
    throw new Error("themeLock font evidence embeddingStatus mismatch");
  }
  return { path: fontEvidencePath, sha256: await sha256File(fontEvidencePath) };
}

function assertCanonicalGeneratedAt(generatedAt) {
  if (typeof generatedAt !== "string" || !CANONICAL_GENERATED_AT.test(generatedAt)) {
    throw new Error("prebuild generatedAt must be a canonical UTC ISO-8601 timestamp");
  }
  if (Number.isNaN(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("prebuild generatedAt must be a real canonical UTC ISO-8601 timestamp");
  }
}

function artifactSchemaFailure(label, artifact, errors) {
  const detail = errors.join("; ");
  const missing = detail.match(/^(\$[^:]*): missing required property ([A-Za-z0-9_-]+)/);
  if (missing) {
    return `${label} failed schema validation: ${missing[1]}.${missing[2]}: missing required property ${missing[2]}`;
  }
  if (label === "themeLock" && detail.includes("$.sourcePptHash")) {
    return "themeLock sourcePptHash must be a strict lowercase SHA-256 digest";
  }
  if (label === "themeLock" && detail.includes("$.sampleHashes") && detail.includes("fewer than")) {
    if (artifact.samplePaths?.length === 1 && artifact.sampleHashes?.length === 1) {
      return "themeLock requires exactly two visual samples in samplePaths and sampleHashes";
    }
    return "themeLock samplePaths and sampleHashes must have the same approved sample count";
  }
  if (label === "slideSpecs" && detail.includes(".contentHash")) {
    return `slideSpecs content hash failed schema validation: ${detail}`;
  }
  if (label === "slideSpecs" && detail.includes(".authorization")) {
    return `${artifact.route || "slide"} authorization failed schema validation: ${detail}`;
  }
  return `${label} failed schema validation: ${detail}`;
}

export async function computePrebuildEvidence({
  slideSpecsPath,
  themeLockPath,
  state,
  generatedAt,
  prospectiveDiffPreview,
}) {
  assertCanonicalGeneratedAt(generatedAt);
  const [slideSpecs, themeLock, contract, layoutCatalog, themeCatalog, artifactSchema] = await Promise.all([
    readJson(slideSpecsPath),
    readJson(themeLockPath),
    loadQualityContract(),
    loadLayoutArchetypes(),
    loadThemeCatalog(),
    readJson(PROJECT_ARTIFACTS_SCHEMA_PATH),
  ]);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state is required for deterministic prebuild computation");
  }
  for (const [label, definition, artifact] of [
    ["slideSpecs", "slideSpecs", slideSpecs],
    ["themeLock", "themeLock", themeLock],
  ]) {
    const validation = validateSchema(
      { $defs: artifactSchema.$defs, $ref: `#/$defs/${definition}` },
      artifact,
    );
    if (!validation.valid) {
      throw new Error(artifactSchemaFailure(label, artifact, validation.errors));
    }
  }
  const stateValidation = validateSchema(
    { $defs: artifactSchema.$defs, $ref: "#/$defs/state" },
    state,
  );
  if (!stateValidation.valid) {
    throw new Error(`state failed schema validation: ${stateValidation.errors.join("; ")}`);
  }
  if (slideSpecs.route !== state.route) {
    throw new Error("route mismatch between slide specs and state");
  }
  if (slideSpecs.projectId !== state.projectId || themeLock.projectId !== state.projectId) {
    throw new Error("projectId mismatch across slide specs, theme lock, and state");
  }
  if (slideSpecs.qualityContractVersion !== contract.qualityContractVersion) {
    throw new Error("qualityContractVersion mismatch");
  }
  const fontEvidence = await resolveFontEvidence(
    themeLock,
    themeLockPath,
    slideSpecs.route,
    themeCatalog,
    artifactSchema,
  );
  await assertVisualSampleBindings(themeLock, themeLockPath, slideSpecs.route);
  assertVisualContractApproval({
    themeLock,
    route: slideSpecs.route,
    stateVisualApproval: state.approvals?.visual,
    label: "prebuild visual contract",
  });
  const violations = slideSpecs.slides.flatMap((slide) => {
    const routeViolations = validateRouteMatrix(slide, slideSpecs.route);
    if (routeViolations.length) return routeViolations;
    if (slide.qualityMode === "enforced") {
      const layout = layoutCatalog.layouts.find((candidate) => candidate.id === slide.layoutArchetype);
      if (!layout || !layout.pageRoles.includes(slide.pageRole)) {
        return [violation("LAYOUT_ARCHETYPE", slide.slide, "layout archetype is unknown or incompatible with pageRole")];
      }
      return validateEnforcedSlide(slide, contract, layout);
    }
    if (slide.qualityMode === "compatibility-audit") return validateCompatibilitySlide(slide, slideSpecs.route);
    return [violation("QUALITY_MODE", slide.slide, "unsupported qualityMode")];
  });
  if (violations.length) {
    throw new Error(violations.map((item) => `${item.code} slide ${item.slide}: ${item.message}`).join("; "));
  }
  const approvalHashes = currentPrebuildApprovalHashes(state, prospectiveDiffPreview);
  return {
    artifactType: "prebuildEvidence",
    schemaVersion: "1.0.0",
    qualityContractVersion: contract.qualityContractVersion,
    checker: { id: "validate-slide-specs", version: "1.0.0" },
    projectId: state.projectId,
    inputHashes: {
      slideSpecs: await sha256File(slideSpecsPath),
      themeLock: await sha256File(themeLockPath),
      fontEvidence: fontEvidence.sha256
    },
    approvalHashes,
    violationCounts: { schema: 0, contentBlocks: 0, typography: 0, safeZone: 0, visualIntent: 0, contentHash: 0 },
    finalVerdict: "PASS",
    generatedAt,
  };
}

export async function validateSlideSpecs({
  slideSpecsPath,
  themeLockPath,
  statePath,
  outputPath,
  prospectiveDiffPreview,
  generatedAt = new Date().toISOString(),
}) {
  const state = await readJson(statePath);
  const evidence = await computePrebuildEvidence({
    slideSpecsPath,
    themeLockPath,
    state,
    generatedAt,
    prospectiveDiffPreview,
  });
  await writeJsonAtomic(outputPath, evidence);
  return evidence;
}
