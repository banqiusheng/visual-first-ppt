#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { readJson, writeJsonAtomic } from "./lib/atomic-json.mjs";
import { validateCurrentQaReport } from "./lib/current-qa.mjs";
import {
  evidenceSha256,
  loadQualityContract,
  loadStructuredEvidence,
  materializeInputArtifacts,
} from "./lib/quality-evidence.mjs";
import { validateSchema } from "./lib/schema-validator.mjs";

const QUALITY_CONTRACT = await loadQualityContract();
export const REQUIRED_AUTOMATED_CHECKS = Object.freeze([...QUALITY_CONTRACT.requiredAutomatedChecks]);
export const EDIT_REQUIRED_CHECKS = Object.freeze([...QUALITY_CONTRACT.editRequiredChecks]);
export const HARD_ZERO = Object.freeze([...QUALITY_CONTRACT.hardZeroChecks]);
export const MIN_MANUAL_SCORE = QUALITY_CONTRACT.minimumManualScore;
export const REQUIRED_MANUAL_DIMENSIONS = Object.freeze([...QUALITY_CONTRACT.requiredManualDimensions]);
export const REQUIRED_REVIEW_CHECKS = Object.freeze([...QUALITY_CONTRACT.requiredReviewChecks]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(SCRIPT_DIR, "../schemas/project-artifacts.schema.json");
const QUALITY_EVIDENCE_SCHEMA_PATH = path.resolve(SCRIPT_DIR, "../schemas/quality-evidence.schema.json");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} requires a nonempty string`);
  return value.trim();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

async function readStructuredJsonEvidence(evidencePath, label) {
  let rawBytes;
  try {
    rawBytes = await fs.readFile(evidencePath);
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8: ${error.message}`);
  }
  try {
    return {
      evidence: JSON.parse(raw),
      evidenceSha256: evidenceSha256(rawBytes),
    };
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function resolveDeclaredPath(value, sourcePath, label) {
  const declared = requireString(value, label);
  return path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(path.dirname(path.resolve(sourcePath)), declared);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} may contain only ${wanted.join(" and ")}`);
  }
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

function parsePng(payload, label) {
  if (payload.length < 45 || !payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
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
    const expectedCrc = payload.readUInt32BE(offset + 8 + length);
    if (crc32(chunkBody) !== expectedCrc) throw new Error(`${label} PNG ${type} CRC mismatch`);
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) throw new Error(`${label} must begin with one PNG IHDR chunk`);
      width = payload.readUInt32BE(offset + 8);
      height = payload.readUInt32BE(offset + 12);
      if (width < 1 || height < 1) throw new Error(`${label} PNG dimensions must be positive`);
      const bitDepth = payload[offset + 16];
      const colorType = payload[offset + 17];
      const compressionMethod = payload[offset + 18];
      const filterMethod = payload[offset + 19];
      const interlaceMethod = payload[offset + 20];
      if (
        bitDepth !== 8
        || ![2, 6].includes(colorType)
        || compressionMethod !== 0
        || filterMethod !== 0
        || interlaceMethod !== 0
      ) {
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
    if (type !== "IHDR" && type !== "PLTE" && type !== "IDAT" && type !== "IEND" && type[0] === type[0].toUpperCase()) {
      throw new Error(`${label} PNG contains unsupported critical chunk ${type}`);
    }
    if (type === "IEND") {
      if (idatChunks.length === 0) throw new Error(`${label} PNG must contain at least one IDAT chunk`);
      if (length !== 0 || end !== payload.length) throw new Error(`${label} has an invalid terminal PNG IEND chunk`);
      sawIend = true;
      break;
    }
    offset = end;
  }
  if (!sawIhdr || idatChunks.length === 0 || !sawIend) {
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
  const scanlines = inflation.buffer;
  if (inflation.engine.bytesWritten !== compressed.length) {
    throw new Error(`${label} PNG IDAT zlib stream has trailing compressed input`);
  }
  if (scanlines.length !== expectedLength) {
    throw new Error(`${label} PNG scanline length mismatch: expected ${expectedLength}, received ${scanlines.length}`);
  }
  for (let row = 0; row < height; row += 1) {
    const filter = scanlines[row * rowLength];
    if (filter > 4) throw new Error(`${label} PNG scanline filter byte is invalid: ${filter}`);
  }
  return { width, height };
}

async function fullSlideEvidence(entry, sourcePath, seenPaths, label) {
  const evidencePath = resolveDeclaredPath(entry.evidencePath, sourcePath, `${label} evidence path`);
  const expectedName = `slide-${entry.slide}.png`;
  if (path.basename(evidencePath) !== expectedName) {
    throw new Error(`${label} must map slide ${entry.slide} to ${expectedName}`);
  }
  if (seenPaths.has(evidencePath)) throw new Error(`${label} evidence paths must be unique; reused ${evidencePath}`);
  seenPaths.add(evidencePath);
  let payload;
  try {
    payload = await fs.readFile(evidencePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} evidence file does not exist: ${evidencePath}`);
    throw error;
  }
  const dimensions = parsePng(payload, `${label} evidence`);
  return {
    evidencePath,
    evidenceSha256: evidenceSha256(payload),
    ...dimensions,
  };
}

async function normalizeAutomatedChecks(route, descriptors, sourcePath, expectedInputHashes) {
  if (!Array.isArray(descriptors)) throw new Error("automatedChecks must be a JSON array");
  const byId = new Map();
  for (const descriptor of descriptors) {
    requireObject(descriptor, "automated check descriptor");
    assertExactKeys(descriptor, ["id", "evidencePath"], "automated check descriptor");
    const id = requireString(descriptor.id, "automated check id");
    if (byId.has(id)) throw new Error(`Duplicate automated check: ${id}`);
    byId.set(id, descriptor);
  }
  const required = route === "edit"
    ? [...REQUIRED_AUTOMATED_CHECKS, ...EDIT_REQUIRED_CHECKS]
    : [...REQUIRED_AUTOMATED_CHECKS];
  const normalized = [];
  for (const id of required) {
    const descriptor = byId.get(id);
    if (!descriptor) throw new Error(`Missing required automated check: ${id}`);
    const evidencePath = resolveDeclaredPath(descriptor.evidencePath, sourcePath, `${id} evidence path`);
    const check = await loadStructuredEvidence({ checkId: id, evidencePath, expectedInputHashes });
    if (check.status !== "PASS") throw new Error(`Automated check did not pass: ${id}`);
    if (HARD_ZERO.includes(id) && check.value !== 0) {
      throw new Error(`${id} must be 0; received ${String(check.value)}`);
    }
    normalized.push(check);
  }
  return normalized;
}

async function normalizeManualScores(scores, sourcePath) {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error("manualScores must contain at least one reviewed slide");
  }
  const seenSlides = new Set();
  const normalizedScores = [];
  const seenPaths = new Set();
  for (const entry of scores) {
    requireObject(entry, "manual score");
    if (!Number.isInteger(entry.slide) || entry.slide < 1) {
      throw new Error("manual score slide must be a positive integer");
    }
    if (seenSlides.has(entry.slide)) throw new Error(`Duplicate manual score for slide ${entry.slide}`);
    seenSlides.add(entry.slide);
    requireObject(entry.scores, `slide ${entry.slide} scores`);
    for (const dimension of REQUIRED_MANUAL_DIMENSIONS) {
      const score = entry.scores[dimension];
      if (!Number.isInteger(score) || score < MIN_MANUAL_SCORE || score > 5) {
        throw new Error(`slide ${entry.slide} ${dimension} must be ${MIN_MANUAL_SCORE}–5; received ${String(score)}`);
      }
    }
    const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
    if (REQUIRED_MANUAL_DIMENSIONS.some((dimension) => entry.scores[dimension] === MIN_MANUAL_SCORE) && !notes) {
      throw new Error(`slide ${entry.slide} score 4 requires a nonempty page-level note`);
    }
    const evidence = await fullSlideEvidence(entry, sourcePath, seenPaths, `slide ${entry.slide} manual`);
    const normalized = {
      slide: entry.slide,
      score: Math.min(...REQUIRED_MANUAL_DIMENSIONS.map((dimension) => entry.scores[dimension])),
      dimensions: Object.fromEntries(REQUIRED_MANUAL_DIMENSIONS.map((dimension) => [dimension, entry.scores[dimension]])),
      reviewer: requireString(entry.reviewer, `slide ${entry.slide} reviewer`),
      ...evidence,
    };
    if (notes) normalized.notes = notes;
    normalizedScores.push(normalized);
  }
  return normalizedScores.sort((left, right) => left.slide - right.slide);
}

async function normalizeReviewChecks(reviews, sourcePath, qualityEvidenceSchema) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    throw new Error("reviewChecks must contain one entry per slide");
  }
  const seenSlides = new Set();
  const normalizedReviews = [];
  const seenPaths = new Set();
  for (const entry of reviews) {
    requireObject(entry, "review check entry");
    if (!Number.isInteger(entry.slide) || entry.slide < 1) throw new Error("review slide must be a positive integer");
    if (seenSlides.has(entry.slide)) throw new Error(`Duplicate review checks for slide ${entry.slide}`);
    seenSlides.add(entry.slide);
    const checks = requireObject(entry.checks, `slide ${entry.slide} review checks`);
    const normalizedChecks = {};
    for (const id of REQUIRED_REVIEW_CHECKS) {
      const check = requireObject(checks[id], `slide ${entry.slide} ${id}`);
      if (check.status !== "PASS") throw new Error(`slide ${entry.slide} ${id} must PASS`);
      normalizedChecks[id] = {
        status: "PASS",
        notes: requireString(check.notes, `slide ${entry.slide} ${id} notes`),
      };
    }
    const evidence = await fullSlideEvidence(entry, sourcePath, seenPaths, `slide ${entry.slide} review`);
    const normalized = {
      slide: entry.slide,
      reviewer: requireString(entry.reviewer, `slide ${entry.slide} review reviewer`),
      ...evidence,
      checks: normalizedChecks,
    };
    const validation = validateSchema(
      { $defs: qualityEvidenceSchema.$defs, $ref: "#/$defs/perSlideReview" },
      normalized,
    );
    if (!validation.valid) {
      throw new Error(`slide ${entry.slide} review schema validation failed: ${validation.errors.join("; ")}`);
    }
    normalizedReviews.push(normalized);
  }
  return normalizedReviews.sort((left, right) => left.slide - right.slide);
}

async function normalizeClientSmoke(
  smoke,
  sourcePath,
  expectedDeckHash,
  expectedTargetClient,
  qualityEvidenceSchema,
) {
  requireObject(smoke, "clientSmoke");
  const canonicalTargetClients = qualityEvidenceSchema.$defs?.targetClient?.enum;
  if (!Array.isArray(canonicalTargetClients)
    || !canonicalTargetClients.includes(expectedTargetClient)) {
    throw new Error("themeLock targetClient must be a canonical target client");
  }
  const status = requireString(smoke.status, "clientSmoke status");
  const evidencePath = resolveDeclaredPath(smoke.evidencePath, sourcePath, "clientSmoke evidence path");
  if (status === "failed") throw new Error("Target-client smoke failed");
  if (status === "not_available") {
    const { evidence, evidenceSha256: confirmationEvidenceSha256 } = (
      await readStructuredJsonEvidence(evidencePath, "user-open confirmation structured evidence")
    );
    const validation = validateSchema(
      { $defs: qualityEvidenceSchema.$defs, $ref: "#/$defs/userOpenConfirmationEvidence" },
      evidence,
    );
    if (!validation.valid) {
      throw new Error(
        `user-open confirmation evidence validation failed: ${validation.errors.join("; ")}`,
      );
    }
    if (evidence.targetClient !== expectedTargetClient
      || (smoke.targetClient !== undefined && smoke.targetClient !== expectedTargetClient)) {
      throw new Error("client smoke target client does not match theme-lock targetClient");
    }
    if (evidence.openedArtifactHash !== expectedDeckHash) {
      throw new Error("user-open confirmation opened artifact hash does not match the delivered deck");
    }
    return {
      clientSmokeStatus: "NOT_RUN",
      clientSmoke: {
        status,
        evidencePath,
        evidenceSha256: confirmationEvidenceSha256,
        userFinalOpenConfirmation: true,
        targetClient: evidence.targetClient,
        openedArtifactHash: evidence.openedArtifactHash,
      },
    };
  }
  if (status !== "passed") throw new Error("clientSmoke status must be passed, failed, or not_available");
  const targetClient = requireString(smoke.targetClient, "clientSmoke targetClient");
  if (targetClient !== expectedTargetClient) {
    throw new Error("client smoke target client does not match theme-lock targetClient");
  }
  const { evidence, evidenceSha256: clientEvidenceSha256 } = (
    await readStructuredJsonEvidence(evidencePath, "client smoke structured evidence")
  );
  const validation = validateSchema(
    { $defs: qualityEvidenceSchema.$defs, $ref: "#/$defs/clientSmokeEvidence" },
    evidence,
  );
  if (!validation.valid) {
    throw new Error(
      `client smoke structured GUI evidence validation failed: ${validation.errors.join("; ")}`,
    );
  }
  if (evidence.targetClient !== targetClient) {
    throw new Error("client smoke target client does not match its structured evidence");
  }
  if (evidence.openedArtifactHash !== expectedDeckHash) {
    throw new Error("client smoke opened artifact hash does not match the delivered deck");
  }
  return {
    clientSmokeStatus: "PASS",
    clientSmoke: {
      status,
      evidencePath,
      evidenceSha256: clientEvidenceSha256,
      userFinalOpenConfirmation: false,
      targetClient,
      observationMode: evidence.observationMode,
      openedArtifactHash: evidence.openedArtifactHash,
    },
  };
}

function expectedSlideCount(automatedChecks) {
  const check = automatedChecks.find((entry) => entry.id === "pageCountAndCanvas");
  if (!Number.isInteger(check?.value) || check.value < 1) {
    throw new Error("pageCountAndCanvas must report a positive integer slide count in structured evidence");
  }
  return check.value;
}

function assertContinuousCoverage(entries, slideCount, label) {
  const actual = entries.map((entry) => entry.slide);
  const expected = Array.from({ length: slideCount }, (_, index) => index + 1);
  if (actual.length !== expected.length || actual.some((slide, index) => slide !== expected[index])) {
    const missing = expected.filter((slide) => !actual.includes(slide));
    throw new Error(`${label} must cover every consecutive slide 1-${slideCount}; missing: ${missing.join(", ") || "none"}`);
  }
}

async function assertEvidenceFiles(evidencePaths) {
  for (const evidencePath of evidencePaths) {
    let stat;
    try {
      stat = await fs.stat(evidencePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`evidence file does not exist: ${evidencePath}`);
      throw error;
    }
    if (!stat.isFile()) throw new Error(`evidence path is not a file: ${evidencePath}`);
    if (stat.size <= 0) throw new Error(`evidence file must be nonempty: ${evidencePath}`);
  }
}

export async function buildQaReport({
  projectId,
  route,
  inputArtifactsPath,
  inputHashesPath,
  toolVersionsPath,
  automatedChecksPath,
  reviewChecksPath,
  manualScoresPath,
  clientSmokePath,
  outputPath,
}) {
  const normalizedProjectId = requireString(projectId, "projectId");
  if (!["create", "template", "edit"].includes(route)) throw new Error("route must be create, template, or edit");
  if (inputHashesPath) {
    requireObject(await readJson(inputHashesPath), "legacy inputHashes");
    throw new Error("legacy --input-hashes is read-only validation and cannot create a new PASS report");
  }
  if (!inputArtifactsPath) throw new Error("inputArtifactsPath is required for a new PASS report");
  if (!reviewChecksPath) throw new Error("reviewChecksPath is required for a new PASS report");
  const [inputArtifacts, toolVersions, checksInput, reviewInput, manualInput, smokeInput, schema, qualityEvidenceSchema] = await Promise.all([
    materializeInputArtifacts(inputArtifactsPath),
    readJson(toolVersionsPath),
    readJson(automatedChecksPath),
    readJson(reviewChecksPath),
    readJson(manualScoresPath),
    readJson(clientSmokePath),
    readJson(SCHEMA_PATH),
    readJson(QUALITY_EVIDENCE_SCHEMA_PATH),
  ]);
  requireObject(toolVersions, "toolVersions");
  const inputHashes = Object.fromEntries(Object.entries(inputArtifacts).map(([id, value]) => [id, value.sha256]));
  const themeLock = requireObject(await readJson(inputArtifacts.themeLock.path), "themeLock");
  const expectedTargetClient = requireString(themeLock.targetClient, "themeLock targetClient");
  const automatedChecks = await normalizeAutomatedChecks(route, checksInput, automatedChecksPath, inputHashes);
  const perSlideManualScores = await normalizeManualScores(manualInput, manualScoresPath);
  const reviewChecks = await normalizeReviewChecks(reviewInput, reviewChecksPath, qualityEvidenceSchema);
  const slideCount = expectedSlideCount(automatedChecks);
  assertContinuousCoverage(perSlideManualScores, slideCount, "manual review");
  assertContinuousCoverage(reviewChecks, slideCount, "review checks");
  const smoke = await normalizeClientSmoke(
    smokeInput,
    clientSmokePath,
    inputHashes.deck,
    expectedTargetClient,
    qualityEvidenceSchema,
  );
  const evidencePaths = [...new Set([
    ...automatedChecks.map((check) => check.evidencePath),
    ...reviewChecks.map((entry) => entry.evidencePath),
    ...perSlideManualScores.map((entry) => entry.evidencePath),
    smoke.clientSmoke.evidencePath,
  ])].sort();
  await assertEvidenceFiles(evidencePaths);
  const report = {
    artifactType: "qaReport",
    schemaVersion: "1.0.0",
    qualityContractVersion: QUALITY_CONTRACT.qualityContractVersion,
    projectId: normalizedProjectId,
    route,
    inputArtifacts,
    inputHashes,
    toolVersions,
    automatedChecks,
    reviewChecks,
    perSlideManualScores,
    clientSmokeStatus: smoke.clientSmokeStatus,
    clientSmoke: smoke.clientSmoke,
    evidencePaths,
    finalVerdict: "PASS",
    generatedAt: new Date().toISOString(),
  };
  const validation = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/qaReportCurrent" },
    report,
  );
  if (!validation.valid) {
    throw new Error(`qaReportCurrent schema validation failed: ${validation.errors.join("; ")}`);
  }
  await validateCurrentQaReport({
    report,
    reportPath: outputPath,
    workspace: path.dirname(path.resolve(outputPath)),
    expectedProjectId: normalizedProjectId,
    expectedRoute: route,
  });
  await writeJsonAtomic(outputPath, report);
  return report;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("All CLI arguments must use --name value pairs");
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

async function runCli(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log(
      "Usage: build-qa-report.mjs --project-id ID --route create|template|edit "
      + "--input-artifacts FILE --tool-versions FILE --automated-checks FILE --review-checks FILE "
      + "--manual-scores FILE --client-smoke FILE --output FILE "
      + "[--input-hashes LEGACY_READ_ONLY_FILE]",
    );
    return { help: true };
  }
  const args = parseArgs(argv);
  const report = await buildQaReport({
    projectId: args["project-id"],
    route: args.route,
    inputArtifactsPath: args["input-artifacts"],
    inputHashesPath: args["input-hashes"],
    toolVersionsPath: args["tool-versions"],
    automatedChecksPath: args["automated-checks"],
    reviewChecksPath: args["review-checks"],
    manualScoresPath: args["manual-scores"],
    clientSmokePath: args["client-smoke"],
    outputPath: args.output,
  });
  console.log(`QA ${report.finalVerdict} ${path.resolve(args.output)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
