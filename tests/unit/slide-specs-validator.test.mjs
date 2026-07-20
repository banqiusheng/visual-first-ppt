import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { validateSlideSpecs } from "../../skills/visual-first-ppt/scripts/validate-slide-specs.mjs";
import { validateSchema } from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const QUALITY_EVIDENCE_SCHEMA_PATH = "skills/visual-first-ppt/schemas/quality-evidence.schema.json";
const PROJECT_ARTIFACTS_SCHEMA_PATH = "skills/visual-first-ppt/schemas/project-artifacts.schema.json";
const VISUAL_SAMPLE_ARTIFACTS = Object.freeze([
  {
    relativePath: "visual-samples/cover.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  },
  {
    relativePath: "visual-samples/content.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nNwAAAAASUVORK5CYII=", "base64"),
  },
]);
const EDIT_SCOPE_HASH = `sha256:${"3".repeat(64)}`;
const EDIT_DIFF_PREVIEW = Object.freeze({
  notApplicableReason: "只改文案，无视觉差异",
});

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedVisualContractHash(themeLock) {
  const projection = JSON.parse(JSON.stringify(themeLock));
  delete projection.approval;
  delete projection.approvalHash;
  return `sha256:${crypto.createHash("sha256").update(stableJson(projection), "utf8").digest("hex")}`;
}

function legacyCriticalContentHash(items) {
  const canonical = [...items]
    .map((item) => {
      const { contentId, text } = Object(item);
      const normalized = String(text)
        .normalize("NFC")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .join("\n");
      return [contentId, normalized];
    })
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return `sha256:${crypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

async function fixture(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ppt-quality-${name}-`));
  const slideSpecs = JSON.parse(await fs.readFile("tests/fixtures/visual-quality/valid-slide-specs.json", "utf8"));
  const themeLock = JSON.parse(await fs.readFile("tests/fixtures/visual-quality/valid-theme-lock.json", "utf8"));
  themeLock.themeId = "education-training";
  themeLock.primary_visual_source = "builtin:education-training";
  themeLock.fontResolutionMode = "theme-catalog";
  themeLock.resolvedFonts = {
    cjkTitle: "Microsoft YaHei",
    cjkBody: "Microsoft YaHei",
    latin: "Aptos",
    number: "Arial"
  };
  themeLock.fontEvidencePath = "font-evidence.json";
  themeLock.embeddingStatus = "not-embedded";
  themeLock.targetClient = "Microsoft PowerPoint";
  themeLock.samplePaths = VISUAL_SAMPLE_ARTIFACTS.map(({ relativePath }) => relativePath);
  themeLock.sampleHashes = VISUAL_SAMPLE_ARTIFACTS.map(({ bytes }) => sha256Bytes(bytes));
  const visualContractHash = expectedVisualContractHash(themeLock);
  themeLock.approval = {
    approvedArtifactHash: visualContractHash,
    approvedAt: "2026-07-17T00:00:00.000Z",
    userMessage: "批准测试视觉契约",
  };
  const state = {
    artifactType: "state",
    schemaVersion: "1.0.0",
    qualityContractVersion: "1.0.0",
    projectId: slideSpecs.projectId,
    route: slideSpecs.route,
    status: "VISUAL_LOCKED",
    approvals: {
      outline: { approvedArtifactHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
      visual: { approvedArtifactHash: visualContractHash }
    },
    blockers: [],
    completedBatches: [],
    inputHashes: {},
    invalidations: [],
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  return {
    slideSpecs,
    themeLock,
    state,
    paths: {
      slideSpecsPath: path.join(dir, "slide-specs.json"),
      themeLockPath: path.join(dir, "theme-lock.json"),
      statePath: path.join(dir, "state.json"),
      outputPath: path.join(dir, "quality", "prebuild-evidence.json")
    }
  };
}

async function writeInputs(input) {
  await fs.mkdir(path.dirname(input.paths.outputPath), { recursive: true });
  for (const { relativePath, bytes } of VISUAL_SAMPLE_ARTIFACTS) {
    const samplePath = path.join(path.dirname(input.paths.themeLockPath), relativePath);
    await fs.mkdir(path.dirname(samplePath), { recursive: true });
    await fs.writeFile(samplePath, bytes);
  }
  const fontEvidencePath = path.join(path.dirname(input.paths.themeLockPath), "font-evidence.json");
  await fs.writeFile(fontEvidencePath, `${JSON.stringify({
    artifactType: "fontResolutionEvidence",
    schemaVersion: "1.0.0",
    resolvedFonts: input.themeLock.resolvedFonts,
    targetClient: input.themeLock.targetClient,
    embeddingStatus: input.themeLock.embeddingStatus,
    fontAvailability: { status: "PASS", unavailableFonts: [] },
    glyphCoverage: { status: "PASS", missingGlyphs: [] },
    finalVerdict: "PASS",
  }, null, 2)}\n`);
  await Promise.all([
    fs.writeFile(input.paths.slideSpecsPath, `${JSON.stringify(input.slideSpecs, null, 2)}\n`),
    fs.writeFile(input.paths.themeLockPath, `${JSON.stringify(input.themeLock, null, 2)}\n`),
    fs.writeFile(input.paths.statePath, `${JSON.stringify(input.state, null, 2)}\n`)
  ]);
}

async function bindSourceFile(input, {
  mode,
  filename = mode === "source-template" ? "source-template.pptx" : "source-edit.pptx",
  bytes,
  absolute = false,
} = {}) {
  const sourcePath = path.join(path.dirname(input.paths.themeLockPath), filename);
  if (bytes === undefined) {
    const fixturePath = path.resolve(
      mode === "source-template"
        ? "tests/fixtures/baseline/template-source.pptx"
        : "tests/fixtures/baseline/edit-source.pptx",
    );
    await fs.copyFile(fixturePath, sourcePath);
  } else {
    await fs.writeFile(sourcePath, bytes);
  }
  const sourceBytes = await fs.readFile(sourcePath);
  const hash = sha256Bytes(sourceBytes);
  if (mode === "source-template") {
    input.themeLock.templatePath = absolute ? sourcePath : filename;
    input.themeLock.templateHash = hash;
  } else {
    input.themeLock.sourcePptPath = absolute ? sourcePath : filename;
    input.themeLock.sourcePptHash = hash;
  }
  return { sourcePath, hash };
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

function storedZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [entryName, rawPayload] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const payload = Buffer.isBuffer(rawPayload) ? rawPayload : Buffer.from(rawPayload, "utf8");
    const checksum = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function deflatedZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [entryName, rawPayload] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const payload = Buffer.isBuffer(rawPayload) ? rawPayload : Buffer.from(rawPayload, "utf8");
    const compressed = zlib.deflateRawSync(payload, { level: 9 });
    const checksum = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function storedZip(entryNames) {
  return storedZipEntries(entryNames.map((entryName) => [entryName, Buffer.alloc(0)]));
}

const VALID_CONTENT_TYPES = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
  '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  '</Types>',
].join("");
const VALID_ROOT_RELS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
  '</Relationships>',
].join("");
const VALID_PRESENTATION = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>',
  '</p:presentation>',
].join("");
const VALID_PRESENTATION_RELS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
  '</Relationships>',
].join("");
const VALID_SLIDE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
  '<p:cSld><p:spTree/></p:cSld>',
  '</p:sld>',
].join("");
const TRANSITIONAL_NAMESPACES = Object.freeze({
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types",
  packageRelationships: "http://schemas.openxmlformats.org/package/2006/relationships",
  presentation: "http://schemas.openxmlformats.org/presentationml/2006/main",
  officeRelationships: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
});
const STRICT_NAMESPACES = Object.freeze({
  contentTypes: "http://purl.oclc.org/ooxml/package/content-types",
  packageRelationships: "http://purl.oclc.org/ooxml/package/relationships",
  presentation: "http://purl.oclc.org/ooxml/presentationml/main",
  officeRelationships: "http://purl.oclc.org/ooxml/officeDocument/relationships",
});

function replaceNamespace(source, from, to) {
  return source.split(from).join(to);
}

function strictMinimalPptx() {
  return minimalPptx({
    contentTypes: replaceNamespace(
      VALID_CONTENT_TYPES,
      TRANSITIONAL_NAMESPACES.contentTypes,
      STRICT_NAMESPACES.contentTypes,
    ),
    rootRels: replaceNamespace(
      replaceNamespace(
        VALID_ROOT_RELS,
        TRANSITIONAL_NAMESPACES.packageRelationships,
        STRICT_NAMESPACES.packageRelationships,
      ),
      TRANSITIONAL_NAMESPACES.officeRelationships,
      STRICT_NAMESPACES.officeRelationships,
    ),
    presentation: replaceNamespace(
      replaceNamespace(
        VALID_PRESENTATION,
        TRANSITIONAL_NAMESPACES.presentation,
        STRICT_NAMESPACES.presentation,
      ),
      TRANSITIONAL_NAMESPACES.officeRelationships,
      STRICT_NAMESPACES.officeRelationships,
    ),
    presentationRels: replaceNamespace(
      replaceNamespace(
        VALID_PRESENTATION_RELS,
        TRANSITIONAL_NAMESPACES.packageRelationships,
        STRICT_NAMESPACES.packageRelationships,
      ),
      TRANSITIONAL_NAMESPACES.officeRelationships,
      STRICT_NAMESPACES.officeRelationships,
    ),
    slide: replaceNamespace(
      VALID_SLIDE,
      TRANSITIONAL_NAMESPACES.presentation,
      STRICT_NAMESPACES.presentation,
    ),
  });
}

function minimalPptx({
  contentTypes = VALID_CONTENT_TYPES,
  rootRels = VALID_ROOT_RELS,
  presentation = VALID_PRESENTATION,
  presentationRels = VALID_PRESENTATION_RELS,
  slide = VALID_SLIDE,
  duplicatePresentation = false,
} = {}) {
  const entries = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["ppt/presentation.xml", presentation],
    ["ppt/_rels/presentation.xml.rels", presentationRels],
    ["ppt/slides/slide1.xml", slide],
  ].filter(([, payload]) => payload !== null);
  if (duplicatePresentation) entries.push(["ppt/presentation.xml", presentation]);
  return storedZipEntries(entries);
}

function replaceUtf8Marker(source, marker, replacement) {
  const bytes = Buffer.from(source, "utf8");
  const markerBytes = Buffer.from(marker, "utf8");
  const offset = bytes.indexOf(markerBytes);
  assert.notEqual(offset, -1, `missing UTF-8 marker ${marker}`);
  return Buffer.concat([
    bytes.subarray(0, offset),
    replacement,
    bytes.subarray(offset + markerBytes.length),
  ]);
}

function corruptZipEntry(bytes, entryName) {
  const corrupted = Buffer.from(bytes);
  const name = Buffer.from(entryName, "utf8");
  for (let offset = 0; offset + 46 + name.length <= corrupted.length; offset += 1) {
    if (corrupted.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = corrupted.readUInt16LE(offset + 28);
    if (nameLength !== name.length) continue;
    if (!corrupted.subarray(offset + 46, offset + 46 + nameLength).equals(name)) continue;
    const localOffset = corrupted.readUInt32LE(offset + 42);
    const localNameLength = corrupted.readUInt16LE(localOffset + 26);
    const localExtraLength = corrupted.readUInt16LE(localOffset + 28);
    const compressedSize = corrupted.readUInt32LE(offset + 20);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (compressedSize === 0) throw new Error(`cannot corrupt empty ZIP entry ${entryName}`);
    corrupted[dataOffset + Math.floor(compressedSize / 2)] ^= 0xff;
    return corrupted;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

function mutateZipDeclaredUncompressedSize(bytes, entryName, declaredSize) {
  const mutated = Buffer.from(bytes);
  const name = Buffer.from(entryName, "utf8");
  for (let offset = 0; offset + 46 + name.length <= mutated.length; offset += 1) {
    if (mutated.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = mutated.readUInt16LE(offset + 28);
    if (nameLength !== name.length) continue;
    if (!mutated.subarray(offset + 46, offset + 46 + nameLength).equals(name)) continue;
    const localOffset = mutated.readUInt32LE(offset + 42);
    mutated.writeUInt32LE(declaredSize, offset + 24);
    mutated.writeUInt32LE(declaredSize, localOffset + 22);
    return mutated;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

async function configureTemplateSource(input, bytes) {
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  const source = await bindSourceFile(input, { mode: "source-template", bytes });
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  return source;
}

function configureEditPrebuild(input, {
  status = "CHANGE_PREVIEW",
  blockedFrom,
  blockerType,
  includeDiffPreview = true,
} = {}) {
  input.slideSpecs.route = "edit";
  input.state.route = "edit";
  input.state.status = status;
  input.slideSpecs.slides[0].authorization = "authorized-modify";
  input.state.approvals = {
    scope: { approvedArtifactHash: EDIT_SCOPE_HASH },
    ...(includeDiffPreview ? { diffPreview: { ...EDIT_DIFF_PREVIEW } } : {}),
  };
  if (blockedFrom !== undefined) input.state.blockedFrom = blockedFrom;
  if (blockerType !== undefined) {
    input.state.blockers = [{
      type: blockerType,
      reason: "测试阻塞",
      createdAt: "2026-07-17T00:00:00.000Z",
    }];
  }
  return input;
}

async function configureValidEditSource(input, { includeDiffPreview = false } = {}) {
  configureEditPrebuild(input, { includeDiffPreview });
  input.themeLock.fontResolutionMode = "source-edit";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Edit CJK",
    cjkBody: "Source Edit CJK",
    latin: "Source Edit Latin",
    number: "Source Edit Number",
  };
  await bindSourceFile(input, { mode: "source-edit" });
  delete input.themeLock.approval;
  return input;
}

test("rejects a theme lock without every resolved font", async () => {
  const input = await fixture("missing-resolved-font");
  delete input.themeLock.resolvedFonts?.cjkBody;
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /resolvedFonts\.cjkBody/i);
});

test("rejects extra resolved-font roles before producing prebuild evidence", async () => {
  const input = await fixture("extra-resolved-font-role");
  input.themeLock.resolvedFonts.decorative = "Comic Sans MS";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /resolvedFonts.*exactly|extra.*font|decorative/i);
});

test("theme-catalog mode rejects fonts outside every role-specific candidate list", async () => {
  const input = await fixture("catalog-rejects-comic-sans");
  input.themeLock.resolvedFonts = {
    cjkTitle: "Comic Sans MS",
    cjkBody: "Comic Sans MS",
    latin: "Comic Sans MS",
    number: "Comic Sans MS",
  };
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /candidate|theme.*font|Comic Sans/i);
});

test("neo-chinese accepts the verified Arial Unicode MS body fallback", async () => {
  const input = await fixture("neo-chinese-arial-unicode-body");
  input.themeLock.themeId = "neo-chinese";
  input.themeLock.primary_visual_source = "builtin:neo-chinese";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Songti SC",
    cjkBody: "Arial Unicode MS",
    latin: "Arial",
    number: "Arial",
  };
  const visualContractHash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = visualContractHash;
  input.state.approvals.visual.approvedArtifactHash = visualContractHash;
  await writeInputs(input);

  const evidence = await validateSlideSpecs(input.paths);

  assert.equal(evidence.finalVerdict, "PASS");
  assert.match(evidence.inputHashes.fontEvidence, /^sha256:[0-9a-f]{64}$/);
});

test("create cannot use source-template or source-edit font exceptions", async () => {
  for (const mode of ["source-template", "source-edit"]) {
    const input = await fixture(`create-rejects-${mode}`);
    input.themeLock.fontResolutionMode = mode;
    input.themeLock.templateHash = `sha256:${"e".repeat(64)}`;
    input.themeLock.sourcePptHash = `sha256:${"f".repeat(64)}`;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /fontResolutionMode|create.*theme-catalog|source-(?:template|edit)/i,
    );
  }
});

test("source-template font mode is template-only and requires a strict template hash", async () => {
  const input = await fixture("source-template-hash");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.templateHash = "sha256:short";
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /templateHash.*SHA-256|source-template.*hash/i);
});

test("source-template accepts canonical source fonts only on a template route with a strict hash", async () => {
  const input = await fixture("source-template-valid");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  await bindSourceFile(input, { mode: "source-template" });
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  await writeInputs(input);
  assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
});

test("source-edit font mode is edit-only and requires a strict source PPT hash without a visual approval", async () => {
  const input = await fixture("source-edit-hash");
  configureEditPrebuild(input);
  input.themeLock.fontResolutionMode = "source-edit";
  input.themeLock.sourcePptHash = "sha256:short";
  delete input.themeLock.approval;
  delete input.state.approvals.visual;
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /sourcePptHash.*SHA-256|source-edit.*hash/i);
});

test("source-edit accepts canonical source fonts and does not invent a visual approval gate", async () => {
  const input = await fixture("source-edit-valid");
  configureEditPrebuild(input);
  input.themeLock.fontResolutionMode = "source-edit";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Edit CJK",
    cjkBody: "Source Edit CJK",
    latin: "Source Edit Latin",
    number: "Source Edit Number",
  };
  await bindSourceFile(input, { mode: "source-edit" });
  delete input.themeLock.approval;
  delete input.state.approvals.visual;
  await writeInputs(input);
  const evidence = await validateSlideSpecs(input.paths);
  assert.equal(evidence.finalVerdict, "PASS");
  assert.equal(Object.hasOwn(evidence.approvalHashes, "visual"), false);
});

test("source-template font exception is bound to the actual nonempty template PPTX", async () => {
  const input = await fixture("source-template-actual-hash");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  await bindSourceFile(input, { mode: "source-template" });
  input.themeLock.templateHash = `sha256:${"e".repeat(64)}`;
  const visualHash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = visualHash;
  input.state.approvals.visual.approvedArtifactHash = visualHash;
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /template.*hash.*(?:stale|mismatch)|source.*hash/i,
  );
});

test("source-edit font exception accepts an absolute source PPTX path and rejects an empty source", async () => {
  const input = await fixture("source-edit-absolute");
  configureEditPrebuild(input);
  input.themeLock.fontResolutionMode = "source-edit";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Edit CJK",
    cjkBody: "Source Edit CJK",
    latin: "Source Edit Latin",
    number: "Source Edit Number",
  };
  delete input.themeLock.approval;
  delete input.state.approvals.visual;
  const { sourcePath } = await bindSourceFile(input, { mode: "source-edit", absolute: true });
  await writeInputs(input);
  assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");

  await fs.writeFile(sourcePath, "");
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /source.*nonempty|sourcePptPath.*nonempty/i,
  );
});

test("source-template rejects a non-ZIP file even when its declared SHA matches", async () => {
  const input = await fixture("source-template-non-zip");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  await bindSourceFile(input, {
    mode: "source-template",
    bytes: Buffer.from("plain text is not a PPTX OPC package\n", "utf8"),
  });
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /source-template.*PPTX|ZIP|OPC|container/i,
  );
});

test("source-template rejects a ZIP package missing a presentation slide part", async () => {
  const input = await fixture("source-template-missing-slide-part");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  await bindSourceFile(input, {
    mode: "source-template",
    bytes: storedZip(["[Content_Types].xml", "ppt/presentation.xml"]),
  });
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /source-template.*slide|PPTX.*slide|OPC.*slide/i,
  );
});

test("source-template accepts the real baseline fixture and a fully linked minimal PPTX", async () => {
  const realInput = await fixture("source-template-real-baseline");
  await configureTemplateSource(realInput);
  await writeInputs(realInput);
  assert.equal((await validateSlideSpecs(realInput.paths)).finalVerdict, "PASS");

  const minimalInput = await fixture("source-template-linked-minimal");
  await configureTemplateSource(minimalInput, minimalPptx());
  await writeInputs(minimalInput);
  assert.equal((await validateSlideSpecs(minimalInput.paths)).finalVerdict, "PASS");
});

test("source-template accepts transitional and strict OOXML namespace families", async (t) => {
  for (const [label, bytes] of [
    ["transitional", minimalPptx()],
    ["strict", strictMinimalPptx()],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-${label}-namespaces`);
      await configureTemplateSource(input, bytes);
      await writeInputs(input);
      assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
    });
  }
});

test("source-template accepts only exact Internal TargetMode for required relationships", async () => {
  const input = await fixture("source-template-explicit-internal-target-mode");
  const bytes = minimalPptx({
    rootRels: VALID_ROOT_RELS.replace(
      ' Target="ppt/presentation.xml"',
      ' Target="ppt/presentation.xml" TargetMode="Internal"',
    ),
    presentationRels: VALID_PRESENTATION_RELS.replace(
      ' Target="slides/slide1.xml"',
      ' Target="slides/slide1.xml" TargetMode="Internal"',
    ),
  });
  await configureTemplateSource(input, bytes);
  await writeInputs(input);
  assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
});

test("source-template decodes legal XML entities before OOXML comparisons", async () => {
  const input = await fixture("source-template-decoded-xml-entities");
  const contentTypes = VALID_CONTENT_TYPES
    .replace('xmlns="http://', 'xmlns="http&#58;//')
    .replace('ContentType="application/', 'ContentType="application&#47;')
    .replace("<Override ", '<Override Note="&amp;&lt;&gt;&apos;&quot;" ');
  const rootRels = VALID_ROOT_RELS
    .replace('Type="http://', 'Type="http&#x3A;//')
    .replace(
      ' Target="ppt/presentation.xml"',
      ' Target="ppt/presentation.xml" TargetMode="&#x49;nternal"',
    );
  const presentationRels = VALID_PRESENTATION_RELS
    .replace('Type="http://', 'Type="http&#58;//')
    .replace('Target="slides/slide1.xml"', 'Target="slides&#47;slide1.xml"')
    .replace('/>', ' TargetMode="&#73;nternal"/>');
  const bytes = minimalPptx({ contentTypes, rootRels, presentationRels });
  await configureTemplateSource(input, bytes);
  await writeInputs(input);
  assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
});

test("source-template validates expanded XML names instead of local-name lookalikes", async (t) => {
  const evil = "https://attacker.invalid/ooxml";
  const cases = [
    ["content types root namespace", minimalPptx({
      contentTypes: replaceNamespace(
        VALID_CONTENT_TYPES,
        TRANSITIONAL_NAMESPACES.contentTypes,
        evil,
      ),
    })],
    ["content type Override namespace", minimalPptx({
      contentTypes: VALID_CONTENT_TYPES.replace(
        '<Override PartName="/ppt/presentation.xml"',
        `<evil:Override xmlns:evil="${evil}" PartName="/ppt/presentation.xml"`,
      ).replace(
        '<Override PartName="/ppt/slides/slide1.xml"',
        `<evil:Override xmlns:evil="${evil}" PartName="/ppt/slides/slide1.xml"`,
      ),
    })],
    ["Relationships root namespace", minimalPptx({
      rootRels: replaceNamespace(
        VALID_ROOT_RELS,
        TRANSITIONAL_NAMESPACES.packageRelationships,
        evil,
      ),
    })],
    ["Relationship child namespace", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace(
        "<Relationship Id=",
        `<evil:Relationship xmlns:evil="${evil}" Id=`,
      ).replace("</Relationships>", "</Relationships>"),
    })],
    ["presentation root namespace", minimalPptx({
      presentation: replaceNamespace(
        VALID_PRESENTATION,
        TRANSITIONAL_NAMESPACES.presentation,
        evil,
      ),
    })],
    ["sldIdLst namespace", minimalPptx({
      presentation: VALID_PRESENTATION
        .replace("<p:sldIdLst>", `<evil:sldIdLst xmlns:evil="${evil}">`)
        .replace("</p:sldIdLst>", "</evil:sldIdLst>"),
    })],
    ["sldIdLst hierarchy", minimalPptx({
      presentation: VALID_PRESENTATION
        .replace("<p:sldIdLst>", "<p:extLst><p:sldIdLst>")
        .replace("</p:sldIdLst>", "</p:sldIdLst></p:extLst>"),
    })],
    ["sldId namespace", minimalPptx({
      presentation: VALID_PRESENTATION.replace(
        "<p:sldId id=",
        `<evil:sldId xmlns:evil="${evil}" id=`,
      ),
    })],
    ["r:id attribute namespace", minimalPptx({
      presentation: replaceNamespace(
        VALID_PRESENTATION,
        TRANSITIONAL_NAMESPACES.officeRelationships,
        evil,
      ),
    })],
    ["slide root namespace", minimalPptx({
      slide: replaceNamespace(
        VALID_SLIDE,
        TRANSITIONAL_NAMESPACES.presentation,
        evil,
      ),
    })],
    ["unbound r prefix", minimalPptx({
      presentation: VALID_PRESENTATION.replace(
        ` xmlns:r="${TRANSITIONAL_NAMESPACES.officeRelationships}"`,
        "",
      ),
    })],
  ];

  for (const [label, bytes] of cases) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-expanded-name-${label.replaceAll(" ", "-")}`);
      await configureTemplateSource(input, bytes);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /namespace|unbound|content.?type|relationship|presentation|sldId|slide/i,
      );
    });
  }
});

test("source-template rejects empty or malformed required XML members", async (t) => {
  for (const [label, bytes] of [
    ["empty content types", minimalPptx({ contentTypes: "" })],
    ["malformed presentation", minimalPptx({
      presentation: '<p:presentation xmlns:p="urn:test"><p:sldIdLst></p:presentation>',
    })],
    ["empty slide", minimalPptx({ slide: "" })],
    ["opening element has whitespace after less-than", minimalPptx({
      presentation: VALID_PRESENTATION.replace("<p:presentation", "< p:presentation"),
    })],
    ["closing element has whitespace after slash", minimalPptx({
      presentation: VALID_PRESENTATION.replace("</p:presentation>", "</ p:presentation>"),
    })],
    ["attribute contains a raw less-than sign", minimalPptx({
      presentation: VALID_PRESENTATION.replace(
        "<p:presentation ",
        '<p:presentation Invalid="raw<value" ',
      ),
    })],
    ["numeric character reference is null", minimalPptx({
      presentation: VALID_PRESENTATION.replace('id="256"', 'id="256&#0;"'),
    })],
    ["numeric character reference is a surrogate", minimalPptx({
      presentation: VALID_PRESENTATION.replace('id="256"', 'id="256&#xD800;"'),
    })],
    ["numeric character reference exceeds Unicode", minimalPptx({
      presentation: VALID_PRESENTATION.replace('id="256"', 'id="256&#x110000;"'),
    })],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-${label.replaceAll(" ", "-")}`);
      await configureTemplateSource(input, bytes);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /XML|empty|well-formed|parse|content types|slide/i,
      );
    });
  }
});

test("source-template rejects raw XML 1.0 illegal characters in every lexical region", async (t) => {
  const surrogateBytes = replaceUtf8Marker(
    VALID_PRESENTATION.replace("<p:sldIdLst>", "SURROGATE<p:sldIdLst>"),
    "SURROGATE",
    Buffer.from([0xed, 0xa0, 0x80]),
  );
  const outOfRangeBytes = replaceUtf8Marker(
    VALID_PRESENTATION.replace("<p:sldIdLst>", "OUTOFRANGE<p:sldIdLst>"),
    "OUTOFRANGE",
    Buffer.from([0xf4, 0x90, 0x80, 0x80]),
  );
  for (const [label, presentation] of [
    ["attribute NUL", VALID_PRESENTATION.replace(
      "<p:presentation ",
      '<p:presentation Invalid="a\u0000b" ',
    )],
    ["text control", VALID_PRESENTATION.replace("<p:sldIdLst>", "\u0001<p:sldIdLst>")],
    ["CDATA control", VALID_PRESENTATION.replace(
      "<p:sldIdLst>",
      "<![CDATA[\u000b]]><p:sldIdLst>",
    )],
    ["comment control", VALID_PRESENTATION.replace(
      "<p:sldIdLst>",
      "<!--\u001f--><p:sldIdLst>",
    )],
    ["noncharacter", VALID_PRESENTATION.replace("<p:sldIdLst>", "\ufffe<p:sldIdLst>")],
    ["UTF-8 surrogate", surrogateBytes],
    ["UTF-8 beyond Unicode", outOfRangeBytes],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-illegal-xml-${label.replaceAll(" ", "-")}`);
      await configureTemplateSource(input, minimalPptx({ presentation }));
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /XML|UTF-8|character|well-formed/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }
});

test("source-template rejects missing root officeDocument and broken slide relationships", async (t) => {
  for (const [label, bytes] of [
    ["missing root relationships", minimalPptx({ rootRels: null })],
    ["root relationship is not officeDocument", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace("/officeDocument\"", "/theme\""),
    })],
    ["root relationship uses an untrusted officeDocument namespace", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
        "https://attacker.invalid/officeDocument",
      ),
    })],
    ["root officeDocument relationship is external", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace(
        ' Target="ppt/presentation.xml"',
        ' Target="ppt/presentation.xml" TargetMode="External"',
      ),
    })],
    ["root officeDocument relationship uses lowercase internal", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace(
        ' Target="ppt/presentation.xml"',
        ' Target="ppt/presentation.xml" TargetMode="internal"',
      ),
    })],
    ["root officeDocument relationship pads Internal", minimalPptx({
      rootRels: VALID_ROOT_RELS.replace(
        ' Target="ppt/presentation.xml"',
        ' Target="ppt/presentation.xml" TargetMode=" Internal "',
      ),
    })],
    ["presentation relationship missing", minimalPptx({ presentationRels: null })],
    ["presentation slide relationship ID is broken", minimalPptx({
      presentationRels: VALID_PRESENTATION_RELS.replace('Id="rId1"', 'Id="rIdMissing"'),
    })],
    ["presentation slide target escapes the package", minimalPptx({
      presentationRels: VALID_PRESENTATION_RELS.replace(
        'Target="slides/slide1.xml"',
        'Target="../../outside.xml"',
      ),
    })],
    ["presentation relationship uses an untrusted slide namespace", minimalPptx({
      presentationRels: VALID_PRESENTATION_RELS.replace(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
        "https://attacker.invalid/slide",
      ),
    })],
    ["presentation slide relationship is external", minimalPptx({
      presentationRels: VALID_PRESENTATION_RELS.replace(
        ' Target="slides/slide1.xml"',
        ' Target="slides/slide1.xml" TargetMode="External"',
      ),
    })],
    ["presentation slide relationship uses unknown TargetMode", minimalPptx({
      presentationRels: VALID_PRESENTATION_RELS.replace(
        ' Target="slides/slide1.xml"',
        ' Target="slides/slide1.xml" TargetMode="Bogus"',
      ),
    })],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-${label.replaceAll(" ", "-")}`);
      await configureTemplateSource(input, bytes);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /officeDocument|relationship|slide|target|unsafe|missing/i,
      );
    });
  }
});

test("source-template rejects missing content-type declarations and duplicate critical members", async (t) => {
  for (const [label, bytes] of [
    ["missing presentation content type", minimalPptx({
      contentTypes: VALID_CONTENT_TYPES.replace(
        /<Override PartName="\/ppt\/presentation\.xml"[^>]*\/>/,
        "",
      ),
    })],
    ["missing slide content type", minimalPptx({
      contentTypes: VALID_CONTENT_TYPES.replace(
        /<Override PartName="\/ppt\/slides\/slide1\.xml"[^>]*\/>/,
        "",
      ),
    })],
    ["duplicate presentation part", minimalPptx({ duplicatePresentation: true })],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`source-template-${label.replaceAll(" ", "-")}`);
      await configureTemplateSource(input, bytes);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /content.?type|duplicate|presentation|slide/i,
      );
    });
  }
});

test("source-template rejects damaged compressed bytes even when the whole-file hash is current", async () => {
  const input = await fixture("source-template-corrupt-compressed-entry");
  const baseline = await fs.readFile("tests/fixtures/baseline/template-source.pptx");
  const corrupted = corruptZipEntry(baseline, "ppt/presentation.xml");
  await configureTemplateSource(input, corrupted);
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /decompress|CRC|compressed|corrupt|presentation.*XML/i,
  );
});

test("source-template rejects high-ratio and oversized declared ZIP members before extraction", async (t) => {
  const packageEntries = [
    ["[Content_Types].xml", VALID_CONTENT_TYPES],
    ["_rels/.rels", VALID_ROOT_RELS],
    ["ppt/presentation.xml", VALID_PRESENTATION],
    ["ppt/_rels/presentation.xml.rels", VALID_PRESENTATION_RELS],
    ["ppt/slides/slide1.xml", VALID_SLIDE],
  ];

  await t.test("high compression ratio", async () => {
    const input = await fixture("source-template-high-ratio-member");
    const bytes = deflatedZipEntries([
      ...packageEntries,
      ["ppt/media/high-ratio.bin", Buffer.alloc(1024 * 1024)],
    ]);
    await configureTemplateSource(input, bytes);
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /compression ratio|ZIP.*limit|unsafe.*ZIP/i,
    );
  });

  await t.test("oversized declared member", async () => {
    const input = await fixture("source-template-oversized-declared-member");
    const baseline = storedZipEntries([
      ...packageEntries,
      ["ppt/media/oversized.bin", Buffer.from("x")],
    ]);
    const bytes = mutateZipDeclaredUncompressedSize(
      baseline,
      "ppt/media/oversized.bin",
      80 * 1024 * 1024,
    );
    await configureTemplateSource(input, bytes);
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /uncompressed|member.*limit|ZIP.*limit|declared/i,
    );
  });
});

test("source-template applies a compressed source cap before reading the PPTX", async () => {
  const input = await fixture("source-template-pre-read-cap");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.themeLock.fontResolutionMode = "source-template";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Template CJK",
    cjkBody: "Source Template CJK",
    latin: "Source Template Latin",
    number: "Source Template Number",
  };
  const filename = "unreadable-oversized-source.pptx";
  const sourcePath = path.join(path.dirname(input.paths.themeLockPath), filename);
  const handle = await fs.open(sourcePath, "w");
  await handle.truncate(256 * 1024 * 1024 + 1);
  await handle.close();
  await fs.chmod(sourcePath, 0o000);
  input.themeLock.templatePath = filename;
  input.themeLock.templateHash = `sha256:${"a".repeat(64)}`;
  const visualHash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = visualHash;
  input.state.approvals.visual.approvedArtifactHash = visualHash;
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /compressed source|source file.*limit|256.*MiB|too large/i,
  );
});

test("source-template accepts large low-compression media but rejects the same-size bomb", async () => {
  const packageEntries = [
    ["[Content_Types].xml", VALID_CONTENT_TYPES],
    ["_rels/.rels", VALID_ROOT_RELS],
    ["ppt/presentation.xml", VALID_PRESENTATION],
    ["ppt/_rels/presentation.xml.rels", VALID_PRESENTATION_RELS],
    ["ppt/slides/slide1.xml", VALID_SLIDE],
  ];
  const mediaBytes = Buffer.alloc(20 * 1024 * 1024, 0x5a);

  const accepted = await fixture("source-template-large-stored-media");
  await configureTemplateSource(accepted, storedZipEntries([
    ...packageEntries,
    ["ppt/media/training-video.mp4", mediaBytes],
  ]));
  await writeInputs(accepted);
  assert.equal((await validateSlideSpecs(accepted.paths)).finalVerdict, "PASS");

  const rejected = await fixture("source-template-large-compression-bomb");
  await configureTemplateSource(rejected, deflatedZipEntries([
    ...packageEntries,
    ["ppt/media/training-video.mp4", mediaBytes],
  ]));
  await writeInputs(rejected);
  await assert.rejects(
    () => validateSlideSpecs(rejected.paths),
    /compression ratio|ZIP.*limit|unsafe.*ZIP/i,
  );
});

test("a changed locked font invalidates prebuild until both visual approvals bind the new contract hash", async () => {
  const input = await fixture("visual-contract-font-change");
  await writeInputs(input);
  const approved = await validateSlideSpecs(input.paths);
  assert.equal(approved.approvalHashes.visual, expectedVisualContractHash(input.themeLock));

  input.themeLock.resolvedFonts.latin = "Arial";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /visual contract|visual approval|approvedArtifactHash/i);

  const renewedHash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = renewedHash;
  input.state.approvals.visual.approvedArtifactHash = renewedHash;
  await writeInputs(input);
  const renewed = await validateSlideSpecs(input.paths);
  assert.equal(renewed.finalVerdict, "PASS");
  assert.equal(renewed.approvalHashes.visual, renewedHash);
});

test("visual contract hashing excludes approval payloads but includes sample, font, and layout fields", async () => {
  const { visualContractHash } = await import(
    "../../skills/visual-first-ppt/scripts/lib/visual-contract.mjs"
  );
  const input = await fixture("visual-contract-projection");
  const baseline = visualContractHash(input.themeLock);
  input.themeLock.approval.userMessage = "不同审批说明";
  input.themeLock.approvalHash = `sha256:${"9".repeat(64)}`;
  assert.equal(visualContractHash(input.themeLock), baseline);
  const mutations = new Map([
    ["resolvedFonts", (lock) => { lock.resolvedFonts.latin = "Arial"; }],
    ["fontResolutionMode", (lock) => { lock.fontResolutionMode = "source-template"; }],
    ["fontEvidencePath", (lock) => { lock.fontEvidencePath = "evidence/new-fonts.json"; }],
    ["embeddingStatus", (lock) => { lock.embeddingStatus = "embedded"; }],
    ["targetClient", (lock) => { lock.targetClient = "WPS Presentation"; }],
    ["sampleHashes", (lock) => { lock.sampleHashes[0] = `sha256:${"8".repeat(64)}`; }],
    ["palette", (lock) => { lock.palette = { accent: "#B44A3C" }; }],
    ["composition", (lock) => { lock.composition = { grid: "asymmetric" }; }],
  ]);
  for (const [field, mutate] of mutations) {
    const changed = JSON.parse(JSON.stringify(input.themeLock));
    mutate(changed);
    assert.notEqual(visualContractHash(changed), baseline, `${field} must affect visualContractHash`);
  }
});

test("prebuild rejects unequal visual sample path and hash counts before PASS", async () => {
  const input = await fixture("visual-sample-count-mismatch");
  input.themeLock.sampleHashes.pop();
  const hash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = hash;
  input.state.approvals.visual.approvedArtifactHash = hash;
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /samplePaths.*sampleHashes|sample.*count|one.*hash/i,
  );
  await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
});

test("create and template prebuild require exactly two unique visual samples", async (t) => {
  await t.test("one sample is rejected", async () => {
    const input = await fixture("visual-sample-exactly-one");
    input.themeLock.samplePaths.pop();
    input.themeLock.sampleHashes.pop();
    const hash = expectedVisualContractHash(input.themeLock);
    input.themeLock.approval.approvedArtifactHash = hash;
    input.state.approvals.visual.approvedArtifactHash = hash;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /exactly two|2 visual samples|samplePaths.*2|sampleHashes.*2/i,
    );
  });

  await t.test("three samples are rejected", async () => {
    const input = await fixture("visual-sample-exactly-three");
    const relativePath = "visual-samples/third.png";
    const bytes = Buffer.from("third approved visual sample\n", "utf8");
    input.themeLock.samplePaths.push(relativePath);
    input.themeLock.sampleHashes.push(sha256Bytes(bytes));
    const hash = expectedVisualContractHash(input.themeLock);
    input.themeLock.approval.approvedArtifactHash = hash;
    input.state.approvals.visual.approvedArtifactHash = hash;
    await writeInputs(input);
    await fs.writeFile(path.join(path.dirname(input.paths.themeLockPath), relativePath), bytes);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /exactly two|2 visual samples|samplePaths.*2|sampleHashes.*2/i,
    );
  });
});

test("edit prebuild keeps visual samples optional", async () => {
  const input = await fixture("edit-visual-samples-optional");
  input.slideSpecs.route = "edit";
  input.state.route = "edit";
  input.state.status = "CHANGE_PREVIEW";
  input.slideSpecs.slides[0].authorization = "authorized-modify";
  input.themeLock.fontResolutionMode = "source-edit";
  input.themeLock.resolvedFonts = {
    cjkTitle: "Source Edit CJK",
    cjkBody: "Source Edit CJK",
    latin: "Source Edit Latin",
    number: "Source Edit Number",
  };
  await bindSourceFile(input, { mode: "source-edit" });
  delete input.themeLock.samplePaths;
  delete input.themeLock.sampleHashes;
  delete input.themeLock.approval;
  input.state.approvals = {
    scope: { approvedArtifactHash: `sha256:${"3".repeat(64)}` },
  };
  await writeInputs(input);
  const evidence = await validateSlideSpecs({
    ...input.paths,
    prospectiveDiffPreview: { notApplicableReason: "只改文案，无视觉差异" },
  });
  assert.equal(evidence.finalVerdict, "PASS");
});

test("edit prebuild requires exactly two visual samples when samples are present", async (t) => {
  for (const count of [1, 3]) {
    await t.test(`${count} sample${count === 1 ? "" : "s"} rejected`, async () => {
      const input = await fixture(`edit-visual-samples-${count}`);
      configureEditPrebuild(input);
      if (count === 1) {
        input.themeLock.samplePaths.pop();
        input.themeLock.sampleHashes.pop();
      } else {
        const relativePath = "visual-samples/third-edit.png";
        const bytes = Buffer.from("third edit visual sample\n", "utf8");
        input.themeLock.samplePaths.push(relativePath);
        input.themeLock.sampleHashes.push(sha256Bytes(bytes));
        await fs.mkdir(path.dirname(input.paths.themeLockPath), { recursive: true });
        await fs.mkdir(
          path.join(path.dirname(input.paths.themeLockPath), "visual-samples"),
          { recursive: true },
        );
        await fs.writeFile(path.join(path.dirname(input.paths.themeLockPath), relativePath), bytes);
      }
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /exactly two|2 visual samples|samplePaths.*2|sampleHashes.*2/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }
});

test("changing an approved visual sample byte invalidates prebuild", async () => {
  const input = await fixture("visual-sample-byte-drift");
  await writeInputs(input);
  const samplePath = path.join(
    path.dirname(input.paths.themeLockPath),
    input.themeLock.samplePaths[0],
  );
  await fs.appendFile(samplePath, Buffer.from("changed-after-approval", "utf8"));
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /visual sample.*hash|sampleHashes.*mismatch|sample.*stale/i,
  );
});

test("missing empty and directory visual sample paths fail closed", async () => {
  for (const mode of ["missing", "empty", "directory"]) {
    const input = await fixture(`visual-sample-${mode}`);
    await writeInputs(input);
    const samplePath = path.join(
      path.dirname(input.paths.themeLockPath),
      input.themeLock.samplePaths[0],
    );
    if (mode === "missing") await fs.rm(samplePath);
    if (mode === "empty") await fs.writeFile(samplePath, "");
    if (mode === "directory") {
      await fs.rm(samplePath);
      await fs.mkdir(samplePath);
    }
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /visual sample.*(?:missing|nonempty|ordinary file)|samplePaths/i,
      mode,
    );
  }
});

test("prebuild producer rejects malformed outline and scope approval hashes before writing PASS", async () => {
  const createInput = await fixture("invalid-outline-approval-hash");
  createInput.state.approvals.outline.approvedArtifactHash = "sha256:not-a-digest";
  await writeInputs(createInput);
  await assert.rejects(
    () => validateSlideSpecs(createInput.paths),
    /outline.*approvedArtifactHash|approval.*outline.*digest/i,
  );
  await assert.rejects(() => fs.stat(createInput.paths.outputPath), /ENOENT/);

  const editInput = await fixture("invalid-scope-approval-hash");
  editInput.slideSpecs.route = "edit";
  editInput.state.route = "edit";
  editInput.state.status = "CHANGE_PREVIEW";
  editInput.slideSpecs.slides[0].authorization = "authorized-modify";
  editInput.themeLock.fontResolutionMode = "source-edit";
  editInput.themeLock.resolvedFonts = {
    cjkTitle: "Source Edit CJK",
    cjkBody: "Source Edit CJK",
    latin: "Source Edit Latin",
    number: "Source Edit Number",
  };
  await bindSourceFile(editInput, { mode: "source-edit" });
  delete editInput.themeLock.approval;
  editInput.state.approvals = {
    scope: { approvedArtifactHash: `sha256:${"A".repeat(64)}` },
  };
  await writeInputs(editInput);
  await assert.rejects(
    () => validateSlideSpecs(editInput.paths),
    /scope.*approvedArtifactHash|approval.*scope.*digest/i,
  );
  await assert.rejects(() => fs.stat(editInput.paths.outputPath), /ENOENT/);
});

test("prebuild producer requires the route approvals implied by the state machine", async (t) => {
  for (const route of ["create", "template"]) {
    await t.test(`${route} VISUAL_LOCKED requires outline and visual`, async () => {
      const input = await fixture(`missing-${route}-outline`);
      input.slideSpecs.route = route;
      input.state.route = route;
      if (route === "template") input.slideSpecs.slides[0].authorization = "new-slide";
      delete input.state.approvals.outline;
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /outline.*approval.*required|requires.*outline/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }

  await t.test("edit CHANGE_PREVIEW requires scope and prospective diff-preview", async () => {
    const input = await fixture("missing-edit-approvals");
    input.slideSpecs.route = "edit";
    input.state.route = "edit";
    input.state.status = "CHANGE_PREVIEW";
    input.slideSpecs.slides[0].authorization = "authorized-modify";
    input.themeLock.fontResolutionMode = "source-edit";
    input.themeLock.resolvedFonts = {
      cjkTitle: "Source Edit CJK",
      cjkBody: "Source Edit CJK",
      latin: "Source Edit Latin",
      number: "Source Edit Number",
    };
    await bindSourceFile(input, { mode: "source-edit" });
    delete input.themeLock.approval;
    input.state.approvals = {};
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs({
        ...input.paths,
        prospectiveDiffPreview: { notApplicableReason: "只改文案，无视觉差异" },
      }),
      /scope.*approval.*required|requires.*scope/i,
    );
    input.state.approvals.scope = { approvedArtifactHash: `sha256:${"3".repeat(64)}` };
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /diff-preview.*(?:required|requires)/i,
    );
  });
});

test("prebuild producer rejects route/status pairs outside the legal build boundary", async (t) => {
  for (const [label, configure] of [
    ["create before VISUAL_LOCKED", (input) => {
      input.state.status = "OUTLINE_APPROVED";
    }],
    ["template before VISUAL_LOCKED", (input) => {
      input.slideSpecs.route = "template";
      input.state.route = "template";
      input.state.status = "VISUAL_REVIEW";
      input.slideSpecs.slides[0].authorization = "new-slide";
    }],
    ["edit at create-only VISUAL_LOCKED", (input) => {
      configureEditPrebuild(input, { status: "VISUAL_LOCKED" });
    }],
    ["edit before CHANGE_PREVIEW", (input) => {
      configureEditPrebuild(input, { status: "SCOPE_APPROVED" });
    }],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`illegal-prebuild-state-${label.replaceAll(" ", "-")}`);
      configure(input);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /prebuild.*(?:status|state)|status.*(?:route|prebuild)|build boundary/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }
});

test("blocked prebuild state requires a route-legal blocker and build-ready blockedFrom", async (t) => {
  for (const [label, configure] of [
    ["create cannot use compatibility blocker", (input) => {
      input.state.status = "BLOCKED_COMPATIBILITY";
      input.state.blockedFrom = "VISUAL_LOCKED";
      input.state.blockers = [{
        type: "BLOCKED_COMPATIBILITY",
        reason: "错误阻塞类型",
        createdAt: "2026-07-17T00:00:00.000Z",
      }];
    }],
    ["create blockedFrom cannot precede VISUAL_LOCKED", (input) => {
      input.state.status = "BLOCKED_SOURCE";
      input.state.blockedFrom = "OUTLINE_REVIEW";
      input.state.blockers = [{
        type: "BLOCKED_SOURCE",
        reason: "源资料缺失",
        createdAt: "2026-07-17T00:00:00.000Z",
      }];
    }],
    ["blockedFrom cannot itself be blocked", (input) => {
      input.state.status = "BLOCKED_SOURCE";
      input.state.blockedFrom = "BLOCKED_COMPATIBILITY";
      input.state.blockers = [{
        type: "BLOCKED_SOURCE",
        reason: "嵌套阻塞",
        createdAt: "2026-07-17T00:00:00.000Z",
      }];
    }],
    ["edit cannot use source blocker", (input) => {
      configureEditPrebuild(input, {
        status: "BLOCKED_SOURCE",
        blockedFrom: "CHANGE_PREVIEW",
        blockerType: "BLOCKED_SOURCE",
      });
    }],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`illegal-blocked-prebuild-${label.replaceAll(" ", "-")}`);
      configure(input);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /blocker|blockedFrom|blocked.*route|prebuild.*status/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }

  await t.test("edit compatibility blocker resolves through CHANGE_PREVIEW", async () => {
    const input = await fixture("legal-blocked-edit-prebuild");
    configureEditPrebuild(input, {
      status: "BLOCKED_COMPATIBILITY",
      blockedFrom: "CHANGE_PREVIEW",
      blockerType: "BLOCKED_COMPATIBILITY",
    });
    await writeInputs(input);
    assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
  });
});

test("non-blocked prebuild state rejects active blockers and stray blockedFrom", async (t) => {
  await t.test("active blocker cannot hide behind VISUAL_LOCKED", async () => {
    const input = await fixture("active-blocker-on-unblocked-create");
    input.state.blockers = [{
      type: "BLOCKED_SOURCE",
      reason: "仍有源资料阻塞",
      createdAt: "2026-07-17T00:00:00.000Z",
    }];
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /active.*blocker|blocker.*(?:VISUAL_LOCKED|non-blocked)|blocked.*status/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });

  await t.test("blockedFrom cannot exist on an ordinary build-ready state", async () => {
    const input = await fixture("stray-blocked-from-on-unblocked-create");
    input.state.blockers = [];
    input.state.blockedFrom = "OUTLINE_REVIEW";
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /blockedFrom.*(?:non-blocked|ordinary|status)|blocked.*status/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });
});

test("prebuild approvals reject unknown and route-incompatible keys", async (t) => {
  await t.test("unknown approval key", async () => {
    const input = await fixture("unknown-prebuild-approval-key");
    input.state.approvals.unknownGate = {
      approvedArtifactHash: `sha256:${"7".repeat(64)}`,
    };
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /unknownGate|unknown.*approval|approval.*allowed/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });

  await t.test("create cannot carry edit-only scope approval", async () => {
    const input = await fixture("route-incompatible-prebuild-approval");
    input.state.approvals.scope = { approvedArtifactHash: EDIT_SCOPE_HASH };
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /scope.*(?:create|route)|route.*approval/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });
});

test("diff-preview approvedArtifactHash rejects raw surrounding whitespace", async (t) => {
  const canonical = `sha256:${"4".repeat(64)}`;
  const variants = [
    ["leading space", ` ${canonical}`],
    ["trailing space", `${canonical} `],
    ["leading newline", `\n${canonical}`],
    ["trailing newline", `${canonical}\n`],
  ];
  for (const location of ["stored", "prospective"]) {
    for (const [label, approvedArtifactHash] of variants) {
      await t.test(`${location} ${label}`, async () => {
        const input = await fixture(`diff-preview-${location}-${label.replaceAll(" ", "-")}`);
        await configureValidEditSource(input);
        if (location === "stored") {
          input.state.approvals.diffPreview = { approvedArtifactHash };
        }
        await writeInputs(input);
        await assert.rejects(
          () => validateSlideSpecs({
            ...input.paths,
            ...(location === "prospective"
              ? { prospectiveDiffPreview: { approvedArtifactHash } }
              : {}),
          }),
          /diff-preview.*lowercase SHA-256|state.*schema.*diffPreview/i,
        );
        await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
      });
    }
  }

  await t.test("N/A reason remains normalized", async () => {
    const input = await fixture("diff-preview-normalized-na");
    await configureValidEditSource(input);
    await writeInputs(input);
    const evidence = await validateSlideSpecs({
      ...input.paths,
      prospectiveDiffPreview: { notApplicableReason: "  只改文案\n 无视觉差异  " },
    });
    const expected = `sha256:${crypto.createHash("sha256")
      .update("只改文案 无视觉差异", "utf8")
      .digest("hex")}`;
    assert.equal(evidence.approvalHashes.diffPreview, expected);
  });
});

test("standalone prebuild validates the complete public state schema", async (t) => {
  const schema = JSON.parse(await fs.readFile(PROJECT_ARTIFACTS_SCHEMA_PATH, "utf8"));
  for (const required of schema.$defs.state.required) {
    await t.test(`missing required ${required}`, async () => {
      const input = await fixture(`prebuild-state-missing-${required}`);
      delete input.state[required];
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        new RegExp(`state.*schema.*missing required property ${required}`, "i"),
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }

  await t.test("unknown state property", async () => {
    const input = await fixture("prebuild-state-unknown-property");
    input.state.unexpected = true;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /state.*schema.*additional property not allowed.*unexpected/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });

  await t.test("malformed final approval", async () => {
    const input = await fixture("prebuild-state-malformed-final-approval");
    input.state.approvals.final = {};
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /state.*schema.*final.*missing required property approvedArtifactHash/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });

  await t.test("incomplete blocker record", async () => {
    const input = await fixture("prebuild-state-incomplete-blocker");
    input.state.status = "BLOCKED_SOURCE";
    input.state.blockedFrom = "VISUAL_LOCKED";
    input.state.blockers = [{ type: "BLOCKED_SOURCE" }];
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /state.*schema.*blockers.*missing required property (?:reason|createdAt)/i,
    );
    await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
  });

  await t.test("complete state remains valid", async () => {
    const input = await fixture("prebuild-state-complete");
    await writeInputs(input);
    assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
  });
});

test("prebuild producer fails closed on every present malformed non-final approval", async (t) => {
  for (const [label, approval] of [
    ["missing hash", {}],
    ["empty hash", { approvedArtifactHash: "" }],
    ["non-string hash", { approvedArtifactHash: 42 }],
    ["null record", null],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`malformed-present-approval-${label.replaceAll(" ", "-")}`);
      input.state.approvals.outline = approval;
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /state.*schema.*approvals\.outline|outline.*approvedArtifactHash.*lowercase SHA-256|outline.*approval.*required/i,
      );
    });
  }

  await t.test("empty present diff-preview", async () => {
    const input = await fixture("malformed-present-diff-preview");
    configureEditPrebuild(input, { includeDiffPreview: false });
    input.state.approvals.diffPreview = {};
    input.themeLock.fontResolutionMode = "source-edit";
    input.themeLock.resolvedFonts = {
      cjkTitle: "Source Edit CJK",
      cjkBody: "Source Edit CJK",
      latin: "Source Edit Latin",
      number: "Source Edit Number",
    };
    await bindSourceFile(input, { mode: "source-edit" });
    delete input.themeLock.approval;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /state.*schema.*approvals\.diffPreview|diff-preview.*requires approvedArtifactHash or notApplicableReason/i,
    );
  });

  const withoutFinal = await fixture("final-not-required-before-building");
  delete withoutFinal.state.approvals.final;
  await writeInputs(withoutFinal);
  assert.equal((await validateSlideSpecs(withoutFinal.paths)).finalVerdict, "PASS");
});

test("rejects a theme lock whose font evidence is missing", async () => {
  const input = await fixture("missing-font-evidence");
  input.themeLock.fontEvidencePath = "missing-font-evidence.json";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /fontEvidencePath.*missing|font evidence.*missing/i);
});

test("rejects an empty font evidence file", async () => {
  const input = await fixture("empty-font-evidence");
  await writeInputs(input);
  const fontEvidencePath = path.join(path.dirname(input.paths.themeLockPath), input.themeLock.fontEvidencePath);
  await fs.writeFile(fontEvidencePath, "");
  await assert.rejects(() => validateSlideSpecs(input.paths), /fontEvidencePath.*nonempty|font evidence.*nonempty/i);
});

test("rejects a font evidence directory", async () => {
  const input = await fixture("directory-font-evidence");
  input.themeLock.fontEvidencePath = "font-evidence-directory";
  await writeInputs(input);
  await fs.mkdir(path.join(path.dirname(input.paths.themeLockPath), input.themeLock.fontEvidencePath));
  await assert.rejects(() => validateSlideSpecs(input.paths), /fontEvidencePath.*nonempty file|font evidence.*ordinary file/i);
});

test("accepts and binds an absolute ordinary font evidence path", async () => {
  const input = await fixture("absolute-font-evidence");
  const absoluteEvidencePath = path.join(path.dirname(input.paths.themeLockPath), "absolute-font-evidence.json");
  input.themeLock.fontEvidencePath = absoluteEvidencePath;
  const renewedHash = expectedVisualContractHash(input.themeLock);
  input.themeLock.approval.approvedArtifactHash = renewedHash;
  input.state.approvals.visual.approvedArtifactHash = renewedHash;
  await writeInputs(input);
  await fs.copyFile(
    path.join(path.dirname(input.paths.themeLockPath), "font-evidence.json"),
    absoluteEvidencePath,
  );
  const evidence = await validateSlideSpecs(input.paths);
  assert.match(evidence.inputHashes.fontEvidence, /^sha256:[0-9a-f]{64}$/);
});

test("font evidence must be structured and bind the resolved font contract", async () => {
  const input = await fixture("structured-font-evidence");
  await writeInputs(input);
  const evidencePath = path.join(path.dirname(input.paths.themeLockPath), input.themeLock.fontEvidencePath);

  await fs.writeFile(evidencePath, "plain text is not font evidence\n");
  await assert.rejects(() => validateSlideSpecs(input.paths), /font.*evidence.*JSON|structured/i);

  await writeInputs(input);
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  evidence.resolvedFonts.cjkBody = "Different Font";
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(() => validateSlideSpecs(input.paths), /font.*evidence.*resolvedFonts|cjkBody.*mismatch/i);
});

for (const { field, mutate } of [
  { field: "fontAvailability", mutate: (value) => { value.fontAvailability.status = "FAIL"; } },
  { field: "glyphCoverage", mutate: (value) => { value.glyphCoverage.status = "FAIL"; } },
  { field: "finalVerdict", mutate: (value) => { value.finalVerdict = "FAIL"; } },
]) {
  test(`font evidence rejects a non-PASS ${field}`, async () => {
    const input = await fixture(`font-evidence-${field}`);
    await writeInputs(input);
    const evidencePath = path.join(path.dirname(input.paths.themeLockPath), input.themeLock.fontEvidencePath);
    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    mutate(evidence);
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(() => validateSlideSpecs(input.paths), new RegExp(`${field}|font.*evidence`, "i"));
  });
}

for (const { field, value, label } of [
  { field: "embeddingStatus", value: undefined, label: "missing embeddingStatus" },
  { field: "embeddingStatus", value: "", label: "empty embeddingStatus" },
  { field: "embeddingStatus", value: "unknown", label: "unsupported embeddingStatus" },
  { field: "targetClient", value: undefined, label: "missing targetClient" },
  { field: "targetClient", value: "", label: "empty targetClient" },
]) {
  test(`rejects ${label} for a new quality build`, async () => {
    const input = await fixture(`theme-lock-${field}-${String(value)}`);
    if (value === undefined) delete input.themeLock[field];
    else input.themeLock[field] = value;
    await writeInputs(input);
    await assert.rejects(() => validateSlideSpecs(input.paths), new RegExp(field, "i"));
  });
}

for (const invalidTargetClient of ["Microsoft PowerPoint for Windows", "PowerPoint/WPS"]) {
  test(`new quality build rejects noncanonical targetClient: ${invalidTargetClient}`, async () => {
    const input = await fixture(`theme-lock-noncanonical-${invalidTargetClient.replaceAll(/[^a-z]/gi, "-")}`);
    input.themeLock.targetClient = invalidTargetClient;
    const targetHash = expectedVisualContractHash(input.themeLock);
    input.themeLock.approval.approvedArtifactHash = targetHash;
    input.state.approvals.visual.approvedArtifactHash = targetHash;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /targetClient|target client|schema.*enum/i,
    );
  });
}

test("theme-lock schema constrains resolved-font and client metadata without forcing legacy reads", async () => {
  const schema = JSON.parse(await fs.readFile(PROJECT_ARTIFACTS_SCHEMA_PATH, "utf8"));
  const themeLock = schema.$defs.themeLock;
  assert.deepEqual(themeLock.properties.embeddingStatus.enum, ["embedded", "not-embedded"]);
  assert.deepEqual(schema.$defs.targetClient?.enum, ["Microsoft PowerPoint", "WPS Presentation"]);
  assert.equal(themeLock.properties.targetClient.$ref, "#/$defs/targetClient");
  assert.deepEqual(
    [...themeLock.properties.resolvedFonts.required].sort(),
    ["cjkBody", "cjkTitle", "latin", "number"],
  );
  for (const role of ["cjkTitle", "cjkBody", "latin", "number"]) {
    assert.equal(themeLock.properties.resolvedFonts.properties[role].pattern, "\\S");
  }
  assert.deepEqual(themeLock.properties.fontResolutionMode.enum, [
    "theme-catalog",
    "source-template",
    "source-edit",
  ]);
  assert.equal(themeLock.properties.templatePath.pattern, "\\S");
  assert.equal(themeLock.properties.sourcePptPath.pattern, "\\S");
  for (const field of ["samplePaths", "sampleHashes"]) {
    assert.equal(themeLock.properties[field].minItems, 2);
    assert.equal(themeLock.properties[field].maxItems, 2);
  }
  const fontEvidence = schema.$defs.fontResolutionEvidence;
  assert.deepEqual(fontEvidence.required, [
    "artifactType",
    "schemaVersion",
    "resolvedFonts",
    "targetClient",
    "embeddingStatus",
    "fontAvailability",
    "glyphCoverage",
    "finalVerdict",
  ]);
  assert.equal(fontEvidence.properties.fontAvailability.properties.status.const, "PASS");
  assert.equal(fontEvidence.properties.targetClient.$ref, "#/$defs/targetClient");
  assert.equal(fontEvidence.properties.glyphCoverage.properties.status.const, "PASS");
  assert.equal(fontEvidence.properties.finalVerdict.const, "PASS");
  const legacyMinimum = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/themeLock" },
    { artifactType: "themeLock", schemaVersion: "1.0.0" },
  );
  assert.equal(legacyMinimum.valid, true, legacyMinimum.errors.join("\n"));

  const legacyRealThemeLock = {
    artifactType: "themeLock",
    schemaVersion: "1.0.0",
    projectId: "ppt-legacy-theme-lock",
    sourcePriority: ["user-template", "brand-guidelines"],
    themeId: "legacy-template",
    visualSamplePath: "visual-sample/approved.png",
    sampleHash: "sha256:legacy-sample-hash",
    approvalHash: "sha256:legacy-approval-hash",
    strictTemplate: true,
    templateHash: "sha256:legacy-template-hash",
    compatibilityStatus: "PASS",
  };
  const legacyRealResult = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/themeLock" },
    legacyRealThemeLock,
  );
  assert.equal(legacyRealResult.valid, true, legacyRealResult.errors.join("\n"));

  const currentInput = await fixture("schema-exact-visual-sample-count");
  for (const count of [1, 3]) {
    const currentThemeLock = JSON.parse(JSON.stringify(currentInput.themeLock));
    currentThemeLock.samplePaths = Array.from(
      { length: count },
      (_, index) => `visual-samples/${index + 1}.png`,
    );
    currentThemeLock.sampleHashes = Array.from(
      { length: count },
      (_, index) => `sha256:${String(index + 1).repeat(64)}`,
    );
    const result = validateSchema(
      { $defs: schema.$defs, $ref: "#/$defs/themeLock" },
      currentThemeLock,
    );
    assert.equal(result.valid, false, `schema accepted ${count} visual samples`);
  }
});

test("binds the font evidence SHA-256 into prebuild evidence", async () => {
  const input = await fixture("font-evidence-hash");
  await writeInputs(input);
  const first = await validateSlideSpecs(input.paths);
  const fontEvidencePath = path.join(path.dirname(input.paths.themeLockPath), input.themeLock.fontEvidencePath);
  const fontEvidence = JSON.parse(await fs.readFile(fontEvidencePath, "utf8"));
  await fs.writeFile(fontEvidencePath, JSON.stringify(fontEvidence));
  const second = await validateSlideSpecs(input.paths);
  assert.match(first.inputHashes.fontEvidence, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(second.inputHashes.fontEvidence, first.inputHashes.fontEvidence);
});

test("prebuild evidence schema requires a strict font-evidence SHA-256", async () => {
  const schema = JSON.parse(await fs.readFile(QUALITY_EVIDENCE_SCHEMA_PATH, "utf8"));
  const inputHashes = schema.$defs.prebuildEvidence.properties.inputHashes;
  const approvalHashes = schema.$defs.prebuildEvidence.properties.approvalHashes;

  assert.deepEqual(
    [...inputHashes.required].sort(),
    ["fontEvidence", "slideSpecs", "themeLock"],
  );
  assert.deepEqual(inputHashes.properties.fontEvidence, {
    type: "string",
    pattern: "^sha256:[0-9a-f]{64}$",
  });
  assert.equal(inputHashes.additionalProperties, false);
  assert.deepEqual(
    Object.keys(approvalHashes.properties).sort(),
    ["diffPreview", "final", "outline", "scope", "visual"],
  );
  assert.equal(approvalHashes.additionalProperties, false);
  for (const value of Object.values(approvalHashes.properties)) {
    assert.deepEqual(value, {
      type: "string",
      pattern: "^sha256:[0-9a-f]{64}$",
    });
  }
  for (const value of Object.values(schema.$defs.prebuildEvidence.properties.violationCounts.properties)) {
    assert.equal(value.const, 0);
  }
});

test("generation-contract slide-spec example is the current executable contract", async () => {
  const generation = await fs.readFile(
    "skills/visual-first-ppt/references/generation-contract.md",
    "utf8",
  );
  const section = generation.match(
    /## Per-slide mixed-editing contract[\s\S]*?```json\s*([\s\S]*?)```/,
  );
  assert.ok(section, "generation contract must contain a JSON slide-spec example");
  const documented = JSON.parse(section[1]);
  assert.equal(documented.artifactType, "slideSpecs");
  assert.equal(documented.schemaVersion, "1.0.0");
  assert.equal(documented.qualityContractVersion, "1.0.0");
  assert.ok(Array.isArray(documented.slides) && documented.slides.length > 0);
  assert.equal(documented.slides[0].slide, 1);
  assert.equal(documented.slides[0].safeZone.unit, "in");
  assert.ok(documented.slides[0].typographyBudget.body.minimumPt >= 18);
  assert.ok(!Object.hasOwn(documented.slides[0], "slideNumber"));
  assert.ok(!Object.hasOwn(documented.slides[0], "role"));

  const input = await fixture("documented-slide-spec-contract");
  documented.projectId = input.state.projectId;
  input.slideSpecs = documented;
  await writeInputs(input);
  assert.equal((await validateSlideSpecs(input.paths)).finalVerdict, "PASS");
});

test("prebuild executes slide-spec and theme-lock schemas before minting schema zero", async (t) => {
  await t.test("missing slideSpecs artifact identity", async () => {
    const input = await fixture("slide-specs-schema-missing-artifact-type");
    delete input.slideSpecs.artifactType;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /slideSpecs.*schema.*missing required property artifactType/i,
    );
  });

  await t.test("unknown per-slide property", async () => {
    const input = await fixture("slide-specs-schema-unknown-slide-property");
    input.slideSpecs.slides[0].legacyRole = "content";
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /slideSpecs.*schema.*additional property.*legacyRole/i,
    );
  });

  await t.test("unknown themeLock property", async () => {
    const input = await fixture("theme-lock-schema-unknown-property");
    input.themeLock.unboundDeclaration = true;
    await writeInputs(input);
    await assert.rejects(
      () => validateSlideSpecs(input.paths),
      /themeLock.*schema.*additional property.*unboundDeclaration/i,
    );
  });
});

test("rejects body text below the 18pt hard floor", async () => {
  const input = await fixture("body-floor");
  input.slideSpecs.slides[0].typographyBudget.body.minimumPt = 17;
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /body.*18pt/i);
});

test("rejects five primary blocks on an enforced create page", async () => {
  const input = await fixture("five-blocks");
  input.slideSpecs.slides[0].contentBlocks.push({
    contentId: "extra",
    text: "额外信息",
    estimatedLines: 1,
    maxLines: 2
  });
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /maximum.*4|content blocks/i);
});

test("rejects a forged critical-content hash", async () => {
  const input = await fixture("forged-content-hash");
  input.slideSpecs.slides[0].contentHash = "sha256:forged";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /content hash/i);
});

test("nativeCriticalContent structure fails closed before hashing", async (t) => {
  for (const [label, items] of [
    ["non-object item", [42]],
    ["empty contentId", [{ contentId: "  ", text: "正文" }]],
    ["non-string contentId", [{ contentId: 42, text: "正文" }]],
    ["numeric text", [{ contentId: "body", text: 42 }]],
    ["empty text", [{ contentId: "body", text: "  " }]],
    ["duplicate contentId", [
      { contentId: "body", text: "第一段" },
      { contentId: "body", text: "第二段" },
    ]],
  ]) {
    await t.test(label, async () => {
      const input = await fixture(`native-critical-${label.replaceAll(" ", "-")}`);
      input.slideSpecs.slides[0].nativeCriticalContent = items;
      input.slideSpecs.slides[0].contentHash = legacyCriticalContentHash(items);
      await writeInputs(input);
      await assert.rejects(
        () => validateSlideSpecs(input.paths),
        /nativeCriticalContent|critical content.*(?:object|contentId|text|unique|nonempty)/i,
      );
      await assert.rejects(() => fs.stat(input.paths.outputPath), /ENOENT/);
    });
  }
});

test("enforced nativeCriticalContent requires an OOXML object binding and typography role", async () => {
  const input = await fixture("critical-content-binding-required");
  delete input.slideSpecs.slides[0].nativeCriticalContent[0].objectId;
  delete input.slideSpecs.slides[0].nativeCriticalContent[0].typographyRole;
  input.slideSpecs.slides[0].contentHash = legacyCriticalContentHash(
    input.slideSpecs.slides[0].nativeCriticalContent,
  );
  await writeInputs(input);
  await assert.rejects(
    () => validateSlideSpecs(input.paths),
    /nativeCriticalContent.*(?:objectId|typographyRole|binding)/i,
  );
});

test("rejects an unknown or role-incompatible layout archetype", async () => {
  const input = await fixture("bad-layout");
  input.slideSpecs.slides[0].layoutArchetype = "unregistered-layout";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /layout archetype/i);
});

test("allows edit unauthorized pages only in compatibility-audit mode", async () => {
  const input = await fixture("edit-unauthorized");
  configureEditPrebuild(input);
  input.slideSpecs.slides[0].qualityMode = "compatibility-audit";
  input.slideSpecs.slides[0].authorization = "unauthorized-preserve";
  input.slideSpecs.slides[0].sourceObjectHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeInputs(input);
  const evidence = await validateSlideSpecs(input.paths);
  assert.equal(evidence.finalVerdict, "PASS");
});

test("rejects a slide-spec route that differs from the state route", async () => {
  const input = await fixture("route-mismatch");
  input.state.route = "edit";
  input.state.status = "CHANGE_PREVIEW";
  input.state.approvals = {
    scope: { approvedArtifactHash: EDIT_SCOPE_HASH },
    diffPreview: { ...EDIT_DIFF_PREVIEW },
  };
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /route mismatch/i);
});

test("rejects compatibility-audit pages on the create route", async () => {
  const input = await fixture("create-compatibility-bypass");
  input.slideSpecs.slides[0].qualityMode = "compatibility-audit";
  input.slideSpecs.slides[0].authorization = "unauthorized-preserve";
  input.slideSpecs.slides[0].sourceObjectHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /create.*enforced/i);
});

test("rejects a template source page that bypasses compatibility audit", async () => {
  const input = await fixture("template-source-enforced");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].authorization = "source-template";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /source-template.*compatibility-audit/i);
});

test("rejects a template new page that uses compatibility audit", async () => {
  const input = await fixture("template-new-compatibility");
  input.slideSpecs.route = "template";
  input.state.route = "template";
  input.slideSpecs.slides[0].qualityMode = "compatibility-audit";
  input.slideSpecs.slides[0].authorization = "new-slide";
  input.slideSpecs.slides[0].sourceObjectHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /template.*enforced/i);
});

test("rejects an edit unauthorized page that bypasses compatibility audit", async () => {
  const input = await fixture("edit-unauthorized-enforced");
  configureEditPrebuild(input);
  input.slideSpecs.slides[0].authorization = "unauthorized-preserve";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /unauthorized-preserve.*compatibility-audit/i);
});

test("rejects an authorized edit page that uses compatibility audit", async () => {
  const input = await fixture("edit-authorized-compatibility");
  configureEditPrebuild(input);
  input.slideSpecs.slides[0].qualityMode = "compatibility-audit";
  input.slideSpecs.slides[0].authorization = "authorized-modify";
  input.slideSpecs.slides[0].sourceObjectHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeInputs(input);
  await assert.rejects(() => validateSlideSpecs(input.paths), /edit.*enforced/i);
});

for (const authorization of [undefined, "", "unknown-authorization"]) {
  test(`rejects template pages with missing or unknown authorization: ${String(authorization)}`, async () => {
    const input = await fixture("template-invalid-authorization");
    input.slideSpecs.route = "template";
    input.state.route = "template";
    input.slideSpecs.slides[0].authorization = authorization;
    await writeInputs(input);
    await assert.rejects(() => validateSlideSpecs(input.paths), /template.*authorization/i);
  });

  test(`rejects edit pages with missing or unknown authorization: ${String(authorization)}`, async () => {
    const input = await fixture("edit-invalid-authorization");
    configureEditPrebuild(input);
    input.slideSpecs.slides[0].authorization = authorization;
    await writeInputs(input);
    await assert.rejects(() => validateSlideSpecs(input.paths), /edit.*authorization/i);
  });
}

for (const sourceObjectHash of [
  "sha256:short",
  "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
]) {
  test(`rejects an invalid compatibility source hash: ${sourceObjectHash}`, async () => {
    const input = await fixture("invalid-compatibility-hash");
    configureEditPrebuild(input);
    input.slideSpecs.slides[0].qualityMode = "compatibility-audit";
    input.slideSpecs.slides[0].authorization = "unauthorized-preserve";
    input.slideSpecs.slides[0].sourceObjectHash = sourceObjectHash;
    await writeInputs(input);
    await assert.rejects(() => validateSlideSpecs(input.paths), /sourceObjectHash/i);
  });
}

test("prebuild evidence declares and produces a canonical UTC ISO-8601 generatedAt timestamp", async () => {
  const schema = JSON.parse(await fs.readFile(QUALITY_EVIDENCE_SCHEMA_PATH, "utf8"));
  const generatedAt = schema.$defs.prebuildEvidence.properties.generatedAt;
  const pattern = generatedAt.pattern;
  const timestamp = new RegExp(pattern);

  assert.equal(generatedAt.format, "date-time");
  assert.match("2026-07-17T09:12:34.567Z", timestamp);
  assert.doesNotMatch("2026-07-17T09:12:34.567+08:00", timestamp);
  assert.doesNotMatch("2026-07-17T09:12:34Z", timestamp);
  assert.doesNotMatch("2026-07-17T", timestamp);

  const input = await fixture("canonical-generated-at");
  await writeInputs(input);
  await validateSlideSpecs(input.paths);
  const evidence = JSON.parse(await fs.readFile(input.paths.outputPath, "utf8"));
  assert.equal(new Date(evidence.generatedAt).toISOString(), evidence.generatedAt);
});
