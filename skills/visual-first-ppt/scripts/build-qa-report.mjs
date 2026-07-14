#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJson, writeJsonAtomic } from "./lib/atomic-json.mjs";
import { validateSchema } from "./lib/schema-validator.mjs";

export const REQUIRED_AUTOMATED_CHECKS = Object.freeze([
  "pptxParse",
  "pdfParse",
  "pageCountAndCanvas",
  "overflow",
  "unexpectedOverlap",
  "unresolvedPlaceholder",
  "brokenRelationship",
  "fontAvailability",
  "nativeObjectTypes",
  "dataMismatch",
  "pptxPdfPreviewParity",
]);

export const EDIT_REQUIRED_CHECKS = Object.freeze([
  "sourceHashPreserved",
  "authorizedScope",
  "unauthorizedSlideComparison",
]);

export const HARD_ZERO = Object.freeze([
  "overflow",
  "unexpectedOverlap",
  "unresolvedPlaceholder",
  "brokenRelationship",
  "dataMismatch",
]);

export const MIN_MANUAL_SCORE = 4;
export const REQUIRED_MANUAL_DIMENSIONS = Object.freeze([
  "readability",
  "visualConsistency",
  "imageIntegrity",
  "visualContractFidelity",
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(SCRIPT_DIR, "../schemas/project-artifacts.schema.json");

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} requires a nonempty string`);
  }
  return value.trim();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function normalizePassed(result) {
  return result === true || result === "passed" || result === "PASS";
}

function normalizeAutomatedChecks(route, checks) {
  if (!Array.isArray(checks)) throw new Error("automatedChecks must be a JSON array");
  const byId = new Map();
  for (const check of checks) {
    requireObject(check, "automated check");
    const id = requireString(check.id, "automated check id");
    if (byId.has(id)) throw new Error(`Duplicate automated check: ${id}`);
    byId.set(id, check);
  }
  const required = route === "edit"
    ? [...REQUIRED_AUTOMATED_CHECKS, ...EDIT_REQUIRED_CHECKS]
    : [...REQUIRED_AUTOMATED_CHECKS];
  for (const id of required) {
    const check = byId.get(id);
    if (!check) throw new Error(`Missing required automated check: ${id}`);
    if (!normalizePassed(check.result ?? check.status)) {
      throw new Error(`Automated check did not pass: ${id}`);
    }
    requireString(check.evidencePath, `${id} evidence path`);
    if (HARD_ZERO.includes(id) && check.value !== 0) {
      throw new Error(`${id} must be 0; received ${String(check.value)}`);
    }
  }
  return required.map((id) => {
    const check = byId.get(id);
    const normalized = {
      id,
      status: "PASS",
      evidencePath: check.evidencePath.trim(),
    };
    if (Object.hasOwn(check, "value") && check.value !== null) normalized.value = check.value;
    if (typeof check.command === "string" && check.command.trim()) normalized.command = check.command.trim();
    return normalized;
  });
}

function normalizeManualScores(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error("manualScores must contain at least one reviewed slide");
  }
  const seenSlides = new Set();
  return scores.map((entry) => {
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
        throw new Error(
          `slide ${entry.slide} ${dimension} must be ${MIN_MANUAL_SCORE}–5; received ${String(score)}`,
        );
      }
    }
    const evidencePath = requireString(entry.evidencePath, `slide ${entry.slide} evidence path`);
    return {
      slide: entry.slide,
      score: Math.min(...REQUIRED_MANUAL_DIMENSIONS.map((dimension) => entry.scores[dimension])),
      dimensions: Object.fromEntries(
        REQUIRED_MANUAL_DIMENSIONS.map((dimension) => [dimension, entry.scores[dimension]]),
      ),
      reviewer: requireString(entry.reviewer, `slide ${entry.slide} reviewer`),
      evidencePath,
    };
  }).sort((left, right) => left.slide - right.slide);
}

function normalizeClientSmoke(smoke) {
  requireObject(smoke, "clientSmoke");
  const status = requireString(smoke.status, "clientSmoke status");
  const evidencePath = requireString(smoke.evidencePath, "clientSmoke evidence path");
  if (status === "failed") throw new Error("Target-client smoke failed");
  if (status === "not_available") {
    if (smoke.userFinalOpenConfirmation !== true) {
      throw new Error("Client smoke not_available requires user final-open confirmation");
    }
    return {
      clientSmokeStatus: "NOT_RUN",
      clientSmoke: {
        status,
        evidencePath,
        userFinalOpenConfirmation: true,
      },
    };
  }
  if (status !== "passed") {
    throw new Error("clientSmoke status must be passed, failed, or not_available");
  }
  return {
    clientSmokeStatus: "PASS",
    clientSmoke: { status, evidencePath, userFinalOpenConfirmation: false },
  };
}

function expectedSlideCount(automatedChecks) {
  const check = automatedChecks.find((entry) => entry.id === "pageCountAndCanvas");
  if (!Number.isInteger(check?.value) || check.value < 1) {
    throw new Error("pageCountAndCanvas must report a positive integer slide count in value");
  }
  return check.value;
}

function assertContinuousManualCoverage(perSlideManualScores, slideCount) {
  const actual = perSlideManualScores.map((entry) => entry.slide);
  const expected = Array.from({ length: slideCount }, (_, index) => index + 1);
  if (actual.length !== expected.length || actual.some((slide, index) => slide !== expected[index])) {
    const missing = expected.filter((slide) => !actual.includes(slide));
    throw new Error(
      `manual review must cover every consecutive slide 1-${slideCount}; missing: ${missing.join(", ") || "none"}`,
    );
  }
}

async function assertEvidenceFiles(evidencePaths, outputPath) {
  const baseDir = path.dirname(path.resolve(outputPath));
  for (const evidencePath of evidencePaths) {
    const resolved = path.isAbsolute(evidencePath)
      ? evidencePath
      : path.resolve(baseDir, evidencePath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`evidence file does not exist: ${resolved}`);
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error(`evidence path is not a file: ${resolved}`);
    if (stat.size <= 0) throw new Error(`evidence file must be nonempty: ${resolved}`);
  }
}

export async function buildQaReport({
  projectId,
  route,
  inputHashesPath,
  toolVersionsPath,
  automatedChecksPath,
  manualScoresPath,
  clientSmokePath,
  outputPath,
}) {
  const normalizedProjectId = requireString(projectId, "projectId");
  if (!["create", "template", "edit"].includes(route)) {
    throw new Error("route must be create, template, or edit");
  }
  const [inputHashes, toolVersions, checksInput, manualInput, smokeInput, schema] = await Promise.all([
    readJson(inputHashesPath),
    readJson(toolVersionsPath),
    readJson(automatedChecksPath),
    readJson(manualScoresPath),
    readJson(clientSmokePath),
    readJson(SCHEMA_PATH),
  ]);
  requireObject(inputHashes, "inputHashes");
  requireObject(toolVersions, "toolVersions");
  const automatedChecks = normalizeAutomatedChecks(route, checksInput);
  const perSlideManualScores = normalizeManualScores(manualInput);
  assertContinuousManualCoverage(perSlideManualScores, expectedSlideCount(automatedChecks));
  const smoke = normalizeClientSmoke(smokeInput);
  const evidencePaths = [...new Set([
    ...automatedChecks.map((check) => check.evidencePath),
    ...perSlideManualScores.map((entry) => entry.evidencePath),
    smoke.clientSmoke.evidencePath,
  ])].sort();
  await assertEvidenceFiles(evidencePaths, outputPath);
  const report = {
    artifactType: "qaReport",
    schemaVersion: "1.0.0",
    projectId: normalizedProjectId,
    route,
    inputHashes,
    toolVersions,
    automatedChecks,
    perSlideManualScores,
    clientSmokeStatus: smoke.clientSmokeStatus,
    clientSmoke: smoke.clientSmoke,
    evidencePaths,
    finalVerdict: "PASS",
    generatedAt: new Date().toISOString(),
  };
  const validation = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/qaReport" },
    report,
  );
  if (!validation.valid) throw new Error(`qaReport schema validation failed: ${validation.errors.join("; ")}`);
  await writeJsonAtomic(outputPath, report);
  return report;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("All CLI arguments must use --name value pairs");
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

async function runCli(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log(
      "Usage: build-qa-report.mjs --project-id ID --route create|template|edit "
      + "--input-hashes FILE --tool-versions FILE --automated-checks FILE "
      + "--manual-scores FILE --client-smoke FILE --output FILE",
    );
    return { help: true };
  }
  const args = parseArgs(argv);
  const report = await buildQaReport({
    projectId: args["project-id"],
    route: args.route,
    inputHashesPath: args["input-hashes"],
    toolVersionsPath: args["tool-versions"],
    automatedChecksPath: args["automated-checks"],
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
