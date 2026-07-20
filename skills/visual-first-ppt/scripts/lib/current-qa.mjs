import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { readJson } from "./atomic-json.mjs";
import {
  evidenceSha256,
  loadQualityContract,
  loadStructuredEvidence,
} from "./quality-evidence.mjs";
import { validateSchema } from "./schema-validator.mjs";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_SCHEMA_PATH = path.resolve(LIB_DIR, "../../schemas/project-artifacts.schema.json");
const QUALITY_SCHEMA_PATH = path.resolve(LIB_DIR, "../../schemas/quality-evidence.schema.json");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const INPUT_ARTIFACT_IDS = Object.freeze(["deck", "slideSpecs", "themeLock"]);
let schemasPromise;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} requires a nonempty string`);
  }
  return value.trim();
}

function resolveDeclaredPath(value, baseDir, label) {
  const declared = requireString(value, label);
  return path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(baseDir, declared);
}

async function loadSchemas() {
  schemasPromise ??= Promise.all([
    readJson(PROJECT_SCHEMA_PATH),
    readJson(QUALITY_SCHEMA_PATH),
  ]).then(([projectSchema, qualitySchema]) => ({ projectSchema, qualitySchema }));
  return schemasPromise;
}

async function readNonemptyBytes(filePath, label) {
  let metadata;
  try {
    metadata = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist: ${filePath}`);
    throw error;
  }
  if (!metadata.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (metadata.size <= 0) throw new Error(`${label} must be nonempty: ${filePath}`);
  return fs.readFile(filePath);
}

async function readStructuredJson(filePath, label) {
  const bytes = await readNonemptyBytes(filePath, label);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  return { value: requireObject(value, label), bytes };
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseFullSlidePng(payload, label = "full-slide evidence") {
  if (!Buffer.isBuffer(payload)
    || payload.length < 45
    || !payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} must have a valid PNG signature`);
  }
  let offset = PNG_SIGNATURE.length;
  let width;
  let height;
  let channels;
  let sawIhdr = false;
  let sawIend = false;
  let sawPlte = false;
  let idatEnded = false;
  const idatChunks = [];
  while (offset + 12 <= payload.length) {
    const length = payload.readUInt32BE(offset);
    const typeBytes = payload.subarray(offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > payload.length) throw new Error(`${label} has a truncated PNG chunk`);
    if (![...typeBytes].every((byte) => (
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
    ))) {
      throw new Error(`${label} has an invalid PNG chunk type`);
    }
    const type = typeBytes.toString("ascii");
    const chunkBody = payload.subarray(offset + 4, offset + 8 + length);
    if (crc32(chunkBody) !== payload.readUInt32BE(offset + 8 + length)) {
      throw new Error(`${label} PNG ${type} CRC mismatch`);
    }
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error(`${label} must begin with one PNG IHDR chunk`);
      }
      width = payload.readUInt32BE(offset + 8);
      height = payload.readUInt32BE(offset + 12);
      if (width < 1 || height < 1) throw new Error(`${label} PNG dimensions must be positive`);
      const bitDepth = payload[offset + 16];
      const colorType = payload[offset + 17];
      if (bitDepth !== 8
        || ![2, 6].includes(colorType)
        || payload[offset + 18] !== 0
        || payload[offset + 19] !== 0
        || payload[offset + 20] !== 0) {
        throw new Error(`${label} PNG IHDR must be non-interlaced 8-bit RGB or RGBA`);
      }
      channels = colorType === 2 ? 3 : 4;
      sawIhdr = true;
    } else if (type === "IHDR") {
      throw new Error(`${label} PNG must contain exactly one IHDR chunk`);
    }
    if (type === "PLTE") {
      if (sawPlte || idatChunks.length > 0) throw new Error(`${label} PNG PLTE chunk order is invalid`);
      sawPlte = true;
    }
    if (type === "IDAT") {
      if (idatEnded) throw new Error(`${label} PNG IDAT chunks must be consecutive`);
      idatChunks.push(payload.subarray(offset + 8, offset + 8 + length));
    } else if (idatChunks.length > 0 && type !== "IEND") {
      idatEnded = true;
    }
    if (!["IHDR", "PLTE", "IDAT", "IEND"].includes(type)
      && type[0] === type[0].toUpperCase()) {
      throw new Error(`${label} PNG contains unsupported critical chunk ${type}`);
    }
    if (type === "IEND") {
      if (idatChunks.length === 0) throw new Error(`${label} PNG must contain at least one IDAT chunk`);
      if (length !== 0 || end !== payload.length) {
        throw new Error(`${label} has an invalid terminal PNG IEND chunk`);
      }
      sawIend = true;
      break;
    }
    offset = end;
  }
  if (!sawIhdr || !sawIend || idatChunks.length === 0) {
    throw new Error(`${label} must contain PNG IHDR, IDAT, and terminal IEND chunks`);
  }
  const rowLength = 1 + (width * channels);
  const expectedLength = height * rowLength;
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1) {
    throw new Error(`${label} PNG scanline size cannot be safely validated`);
  }
  const compressed = Buffer.concat(idatChunks);
  let inflation;
  try {
    inflation = zlib.inflateSync(compressed, {
      maxOutputLength: expectedLength + 1,
      info: true,
    });
  } catch (error) {
    throw new Error(`${label} PNG IDAT zlib decompression failed: ${error.message}`);
  }
  if (inflation.engine.bytesWritten !== compressed.length) {
    throw new Error(`${label} PNG IDAT zlib stream has trailing compressed input`);
  }
  if (inflation.buffer.length !== expectedLength) {
    throw new Error(
      `${label} PNG scanline length mismatch: expected ${expectedLength}, received ${inflation.buffer.length}`,
    );
  }
  for (let row = 0; row < height; row += 1) {
    if (inflation.buffer[row * rowLength] > 4) {
      throw new Error(`${label} PNG scanline filter byte is invalid`);
    }
  }
  return { width, height };
}

function assertExactSet(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  if (actual.size !== actualValues.length) {
    const duplicate = actualValues.find((value, index) => actualValues.indexOf(value) !== index);
    throw new Error(`Duplicate ${label}: ${duplicate}`);
  }
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${label} must be the exact required set; missing: ${missing.join(", ") || "none"}; `
      + `unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

function assertContinuousCoverage(entries, pageCount, label) {
  const slides = entries.map((entry) => entry.slide).sort((left, right) => left - right);
  const expected = Array.from({ length: pageCount }, (_, index) => index + 1);
  if (slides.length !== expected.length
    || slides.some((slide, index) => slide !== expected[index])) {
    throw new Error(`${label} must cover every consecutive slide 1-${pageCount}`);
  }
}

async function validateSlideEvidence(records, baseDir, pageCount, label) {
  assertContinuousCoverage(records, pageCount, label);
  const seenPaths = new Set();
  const paths = [];
  for (const record of records) {
    const evidencePath = resolveDeclaredPath(
      record.evidencePath,
      baseDir,
      `${label} slide ${record.slide} evidence path`,
    );
    if (path.basename(evidencePath) !== `slide-${record.slide}.png`) {
      throw new Error(`${label} slide ${record.slide} must map to slide-${record.slide}.png`);
    }
    if (seenPaths.has(evidencePath)) {
      throw new Error(`${label} evidence paths must be unique; reused ${evidencePath}`);
    }
    seenPaths.add(evidencePath);
    const bytes = await readNonemptyBytes(evidencePath, `${label} slide ${record.slide} evidence`);
    const dimensions = parseFullSlidePng(bytes, `${label} slide ${record.slide} evidence`);
    if (record.evidenceSha256 !== evidenceSha256(bytes)) {
      throw new Error(`${label} slide ${record.slide} evidence hash is stale`);
    }
    if (record.width !== dimensions.width || record.height !== dimensions.height) {
      throw new Error(`${label} slide ${record.slide} PNG dimensions are stale`);
    }
    paths.push(evidencePath);
  }
  return paths;
}

function assertSchema(schema, definition, value, label) {
  const result = validateSchema(
    { $defs: schema.$defs, $ref: `#/$defs/${definition}` },
    value,
  );
  if (!result.valid) throw new Error(`${label} schema validation failed: ${result.errors.join("; ")}`);
}

export async function validateCurrentQaReport({
  report,
  reportPath,
  workspace,
  expectedProjectId,
  expectedRoute,
} = {}) {
  const current = requireObject(report, "current QA report");
  const baseDir = workspace
    ? path.resolve(workspace)
    : path.dirname(path.resolve(requireString(reportPath, "reportPath")));
  const [{ projectSchema, qualitySchema }, contract] = await Promise.all([
    loadSchemas(),
    loadQualityContract(),
  ]);
  assertSchema(projectSchema, "qaReportCurrent", current, "qaReportCurrent");
  if (current.qualityContractVersion !== contract.qualityContractVersion) {
    throw new Error("current QA qualityContractVersion is stale");
  }
  if (expectedProjectId !== undefined && current.projectId !== expectedProjectId) {
    throw new Error("current QA projectId does not match the project");
  }
  if (expectedRoute !== undefined && current.route !== expectedRoute) {
    throw new Error("current QA route does not match the project");
  }

  const actualInputHashes = {};
  const inputPaths = {};
  for (const artifactId of INPUT_ARTIFACT_IDS) {
    const descriptor = requireObject(current.inputArtifacts[artifactId], `inputArtifacts.${artifactId}`);
    const artifactPath = resolveDeclaredPath(
      descriptor.path,
      baseDir,
      `inputArtifacts.${artifactId}.path`,
    );
    const bytes = await readNonemptyBytes(artifactPath, `QA input artifact ${artifactId}`);
    const actualHash = evidenceSha256(bytes);
    if (descriptor.sha256 !== actualHash) {
      const fileKind = artifactId === "deck" ? " PPTX" : "";
      throw new Error(`QA input artifact ${artifactId}${fileKind} hash is stale`);
    }
    if (current.inputHashes[artifactId] !== actualHash) {
      throw new Error(`QA inputHashes ${artifactId} hash projection is stale`);
    }
    actualInputHashes[artifactId] = actualHash;
    inputPaths[artifactId] = artifactPath;
  }

  const themeLock = requireObject(await readJson(inputPaths.themeLock), "QA theme-lock input");
  const expectedTargetClient = requireString(themeLock.targetClient, "QA theme-lock targetClient");
  const canonicalTargetClients = qualitySchema.$defs?.targetClient?.enum;
  if (!Array.isArray(canonicalTargetClients)
    || !canonicalTargetClients.includes(expectedTargetClient)) {
    throw new Error("QA theme-lock targetClient must be canonical");
  }

  const automated = current.automatedChecks;
  const automatedIds = automated.map((entry) => entry.id);
  const requiredAutomated = current.route === "edit"
    ? [...contract.requiredAutomatedChecks, ...contract.editRequiredChecks]
    : [...contract.requiredAutomatedChecks];
  assertExactSet(automatedIds, requiredAutomated, "automated check IDs");
  const evidencePaths = [];
  const normalizedChecks = new Map();
  for (const descriptor of automated) {
    const evidencePath = resolveDeclaredPath(
      descriptor.evidencePath,
      baseDir,
      `automated ${descriptor.id} evidence path`,
    );
    const normalized = await loadStructuredEvidence({
      checkId: descriptor.id,
      evidencePath,
      expectedInputHashes: actualInputHashes,
    });
    if (normalized.status !== "PASS" || descriptor.status !== normalized.status) {
      throw new Error(`automated ${descriptor.id} must PASS in descriptor and evidence`);
    }
    if (descriptor.evidenceSha256 !== normalized.evidenceSha256) {
      throw new Error(`automated ${descriptor.id} evidence hash is stale`);
    }
    if (Object.hasOwn(normalized, "value") && descriptor.value !== normalized.value) {
      throw new Error(`automated ${descriptor.id} descriptor value does not match evidence`);
    }
    if (contract.hardZeroChecks.includes(descriptor.id)
      && (descriptor.value !== 0 || normalized.value !== 0)) {
      throw new Error(`automated hard-zero ${descriptor.id} must be 0`);
    }
    normalizedChecks.set(descriptor.id, normalized);
    evidencePaths.push(evidencePath);
  }
  const pageCount = normalizedChecks.get("pageCountAndCanvas")?.value;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("pageCountAndCanvas must report a positive integer pageCount");
  }

  for (const review of current.reviewChecks) {
    assertExactSet(
      Object.keys(requireObject(review.checks, `review slide ${review.slide} checks`)),
      contract.requiredReviewChecks,
      `review slide ${review.slide} check IDs`,
    );
    for (const checkId of contract.requiredReviewChecks) {
      const check = requireObject(review.checks[checkId], `review slide ${review.slide} ${checkId}`);
      if (check.status !== "PASS") throw new Error(`review slide ${review.slide} ${checkId} must PASS`);
      requireString(check.notes, `review slide ${review.slide} ${checkId} notes`);
    }
  }
  evidencePaths.push(...await validateSlideEvidence(
    current.reviewChecks,
    baseDir,
    pageCount,
    "review checks",
  ));

  for (const manual of current.perSlideManualScores) {
    const dimensions = requireObject(manual.dimensions, `manual slide ${manual.slide} dimensions`);
    assertExactSet(
      Object.keys(dimensions),
      contract.requiredManualDimensions,
      `manual slide ${manual.slide} dimension IDs`,
    );
    for (const dimension of contract.requiredManualDimensions) {
      const score = dimensions[dimension];
      if (!Number.isInteger(score)
        || score < contract.minimumManualScore
        || score > 5) {
        throw new Error(`manual slide ${manual.slide} ${dimension} score is outside the contract`);
      }
    }
    const minimum = Math.min(...contract.requiredManualDimensions.map((id) => dimensions[id]));
    if (manual.score !== minimum) {
      throw new Error(`manual slide ${manual.slide} score must equal its minimum dimension score`);
    }
    if (minimum === contract.minimumManualScore) {
      requireString(manual.notes, `manual slide ${manual.slide} score 4 notes`);
    }
    requireString(manual.reviewer, `manual slide ${manual.slide} reviewer`);
  }
  evidencePaths.push(...await validateSlideEvidence(
    current.perSlideManualScores,
    baseDir,
    pageCount,
    "manual review",
  ));

  const client = requireObject(current.clientSmoke, "current QA clientSmoke");
  const clientEvidencePath = resolveDeclaredPath(
    client.evidencePath,
    baseDir,
    "current QA clientSmoke evidence path",
  );
  const { value: clientEvidence, bytes: clientEvidenceBytes } = await readStructuredJson(
    clientEvidencePath,
    "current QA clientSmoke evidence",
  );
  if (client.evidenceSha256 !== evidenceSha256(clientEvidenceBytes)) {
    throw new Error("current QA clientSmoke evidence hash is stale");
  }
  if (client.targetClient !== expectedTargetClient
    || client.openedArtifactHash !== actualInputHashes.deck) {
    throw new Error("current QA client target client or deck binding does not match theme-lock/deck");
  }
  if (client.status === "passed") {
    assertSchema(qualitySchema, "clientSmokeEvidence", clientEvidence, "client smoke evidence");
    if (current.clientSmokeStatus !== "PASS"
      || client.userFinalOpenConfirmation !== false
      || client.observationMode !== "gui-open"
      || clientEvidence.targetClient !== expectedTargetClient
      || clientEvidence.observationMode !== "gui-open"
      || clientEvidence.openedArtifactHash !== actualInputHashes.deck) {
      throw new Error("current QA passed client descriptor does not match structured GUI evidence");
    }
  } else if (client.status === "not_available") {
    assertSchema(
      qualitySchema,
      "userOpenConfirmationEvidence",
      clientEvidence,
      "user-open confirmation evidence",
    );
    if (current.clientSmokeStatus !== "NOT_RUN"
      || client.userFinalOpenConfirmation !== true
      || clientEvidence.targetClient !== expectedTargetClient
      || clientEvidence.openedArtifactHash !== actualInputHashes.deck) {
      throw new Error("current QA not_available client descriptor does not match user-open confirmation");
    }
  } else {
    throw new Error("current QA clientSmoke must be passed or not_available");
  }
  evidencePaths.push(clientEvidencePath);

  const expectedProjection = [...new Set(evidencePaths.map((item) => path.resolve(item)))].sort();
  const actualProjection = current.evidencePaths
    .map((item) => resolveDeclaredPath(item, baseDir, "current QA evidencePaths entry"));
  if (new Set(actualProjection).size !== actualProjection.length) {
    throw new Error("current QA evidencePaths exact projection may not contain duplicates");
  }
  const normalizedProjection = [...actualProjection].sort();
  if (normalizedProjection.length !== expectedProjection.length
    || normalizedProjection.some((item, index) => item !== expectedProjection[index])) {
    throw new Error("current QA evidencePaths must be the exact descriptor projection");
  }

  return {
    report: current,
    pageCount,
    targetClient: expectedTargetClient,
    inputHashes: actualInputHashes,
    inputPaths,
    evidencePaths: expectedProjection,
  };
}
