import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { readJson } from "./atomic-json.mjs";
import { loadQualityContract as loadContract } from "./quality-contract.mjs";
import { validateSchema } from "./schema-validator.mjs";

const REQUIRED_INPUT_ARTIFACTS = Object.freeze(["deck", "slideSpecs", "themeLock"]);
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const QUALITY_EVIDENCE_SCHEMA_PATH = path.resolve(LIB_DIR, "../../schemas/quality-evidence.schema.json");
let qualityEvidenceSchemaPromise;

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

export async function loadQualityContract() {
  return loadContract();
}

async function loadQualityEvidenceSchema() {
  qualityEvidenceSchemaPromise ??= readJson(QUALITY_EVIDENCE_SCHEMA_PATH);
  return qualityEvidenceSchemaPromise;
}

export function evidenceSha256(value) {
  const payload = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

async function nonemptyFile(resolvedPath, label) {
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist: ${resolvedPath}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${resolvedPath}`);
  if (stat.size <= 0) throw new Error(`${label} must be nonempty: ${resolvedPath}`);
}

export async function materializeInputArtifacts(inputArtifactsPath) {
  const manifestPath = path.resolve(requireString(inputArtifactsPath, "inputArtifactsPath"));
  const input = requireObject(await readJson(manifestPath), "inputArtifacts");
  const baseDir = path.dirname(manifestPath);
  const materialized = {};
  for (const id of REQUIRED_INPUT_ARTIFACTS) {
    const descriptor = requireObject(input[id], `inputArtifacts.${id}`);
    const declaredPath = requireString(descriptor.path, `inputArtifacts.${id}.path`);
    const resolvedPath = path.isAbsolute(declaredPath)
      ? path.resolve(declaredPath)
      : path.resolve(baseDir, declaredPath);
    await nonemptyFile(resolvedPath, `input artifact ${id}`);
    const payload = await fs.readFile(resolvedPath);
    materialized[id] = { path: resolvedPath, sha256: evidenceSha256(payload) };
  }
  return materialized;
}

export async function loadStructuredEvidence({ checkId, evidencePath, expectedInputHashes }) {
  const normalizedCheckId = requireString(checkId, "checkId");
  const resolvedPath = path.resolve(requireString(evidencePath, `${normalizedCheckId} evidencePath`));
  await nonemptyFile(resolvedPath, `${normalizedCheckId} structured evidence`);
  const rawBytes = await fs.readFile(resolvedPath);
  const evidenceHash = evidenceSha256(rawBytes);
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch (error) {
    throw new Error(`${normalizedCheckId} structured evidence must be valid UTF-8: ${error.message}`);
  }
  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${normalizedCheckId} structured evidence must be valid JSON: ${error.message}`);
  }
  requireObject(evidence, `${normalizedCheckId} structured evidence`);
  const schema = await loadQualityEvidenceSchema();
  const ooxmlCheckIds = schema.$defs?.automatedEvidenceBundle?.properties?.checks?.required;
  if (!Array.isArray(ooxmlCheckIds)) throw new Error("quality evidence schema is missing OOXML check IDs");
  const definitionName = ooxmlCheckIds.includes(normalizedCheckId)
    ? "automatedEvidenceBundle"
    : "perCheckEvidence";
  const validation = validateSchema({ $defs: schema.$defs, $ref: `#/$defs/${definitionName}` }, evidence);
  if (!validation.valid) {
    throw new Error(
      `${normalizedCheckId} structured evidence schema validation failed; input/checker/check mismatch: `
      + validation.errors.join("; "),
    );
  }
  const contract = await loadQualityContract();
  if (evidence.qualityContractVersion !== contract.qualityContractVersion) {
    throw new Error(`${normalizedCheckId} structured evidence qualityContractVersion mismatch`);
  }
  if (evidence.finalVerdict !== "PASS") {
    throw new Error(`${normalizedCheckId} structured evidence finalVerdict must PASS`);
  }
  const evidenceHashes = requireObject(evidence.inputHashes, `${normalizedCheckId} inputHashes`);
  for (const [artifactId, expectedHash] of Object.entries(expectedInputHashes || {})) {
    if (evidenceHashes[artifactId] !== expectedHash) {
      throw new Error(`${normalizedCheckId} input mismatch for ${artifactId} hash`);
    }
  }
  let check;
  if (definitionName === "automatedEvidenceBundle") {
    check = evidence.checks[normalizedCheckId];
  } else {
    if (evidence.checkId !== normalizedCheckId) {
      throw new Error(`${normalizedCheckId} structured evidence checkId mismatch`);
    }
    if (evidence.checker.id !== normalizedCheckId) {
      throw new Error(`${normalizedCheckId} structured evidence checker.id mismatch`);
    }
    if (evidence.checker.version !== evidence.schemaVersion) {
      throw new Error(`${normalizedCheckId} structured evidence checker version must match schemaVersion`);
    }
    check = evidence.check;
  }
  requireObject(check, `${normalizedCheckId} structured check evidence`);
  const result = {
    id: normalizedCheckId,
    status: check.status,
    evidencePath: resolvedPath,
    evidenceSha256: evidenceHash,
  };
  if (Object.hasOwn(check, "value") && check.value !== null) result.value = check.value;
  return result;
}
