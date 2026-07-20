#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readJson,
  updateProjectIndex,
  writeJsonAtomic,
} from "./lib/atomic-json.mjs";
import { validateCurrentQaReport } from "./lib/current-qa.mjs";
import { validateSchema } from "./lib/schema-validator.mjs";
import { diffPreviewApprovalHash } from "./lib/prebuild-approval.mjs";
import { computePrebuildEvidence } from "./validate-slide-specs.mjs";

const SCHEMA_VERSION = "1.0.0";
const QUALITY_CONTRACT_VERSION = "1.0.0";
const STRICT_APPROVAL_HASH = /^sha256:[0-9a-f]{64}$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(SCRIPT_DIR, "../schemas/project-artifacts.schema.json");
const QUALITY_EVIDENCE_SCHEMA_PATH = path.resolve(
  SCRIPT_DIR,
  "../schemas/quality-evidence.schema.json",
);
const QUALITY_PATHS = Object.freeze({
  prebuildEvidence: "quality/prebuild-evidence.json",
  pptxAudit: "quality/pptx-audit.json",
  qaReport: "qa-report.json",
  slideSpecs: "slide-specs.json",
  themeLock: "theme-lock.json",
  objectInventory: "object-inventory.json",
});
const ADOPTION_JOURNAL_NAME = ".project-state-adopt-journal.json";
const USAGE = [
  "Usage: project-state.mjs <init|transition|block|resume|invalidate|adopt-quality|validate> ...",
  "  project-state.mjs transition <workspace> DELIVERED <approval-hash> <persistent-root> <persistent-final-output>",
  "  project-state.mjs adopt-quality <workspace> <prebuild-evidence>",
].join("\n");

const EPHEMERAL_COMPONENTS = new Set([
  ".cache",
  ".scratch",
  ".temp",
  ".tmp",
  "cache",
  "caches",
  "scratch",
  "temp",
  "temporaryitems",
  "tmp",
]);
const EPHEMERAL_PREFIXES = [
  ".cache-",
  ".scratch-",
  ".temp-",
  ".tmp-",
  "cache-",
  "scratch-",
  "temp-",
  "tmp-",
];

export const TRANSITIONS = Object.freeze({
  create: {
    INTAKE: ["SOURCE_READY"],
    SOURCE_READY: ["OUTLINE_REVIEW"],
    OUTLINE_REVIEW: ["OUTLINE_REVIEW", "OUTLINE_APPROVED"],
    OUTLINE_APPROVED: ["VISUAL_REVIEW"],
    VISUAL_REVIEW: ["VISUAL_REVIEW", "VISUAL_LOCKED"],
    VISUAL_LOCKED: ["BUILDING"],
    BUILDING: ["QA"],
    QA: ["BUILDING", "FINAL_REVIEW"],
    FINAL_REVIEW: ["BUILDING", "DELIVERED"],
  },
  template: {
    INTAKE: ["SOURCE_READY"],
    SOURCE_READY: ["OUTLINE_REVIEW"],
    OUTLINE_REVIEW: ["OUTLINE_REVIEW", "OUTLINE_APPROVED"],
    OUTLINE_APPROVED: ["VISUAL_REVIEW"],
    VISUAL_REVIEW: ["VISUAL_REVIEW", "VISUAL_LOCKED"],
    VISUAL_LOCKED: ["BUILDING"],
    BUILDING: ["QA"],
    QA: ["BUILDING", "FINAL_REVIEW"],
    FINAL_REVIEW: ["BUILDING", "DELIVERED"],
  },
  edit: {
    INTAKE: ["COMPATIBILITY_REVIEW"],
    COMPATIBILITY_REVIEW: ["SCOPE_REVIEW"],
    SCOPE_REVIEW: ["SCOPE_REVIEW", "SCOPE_APPROVED"],
    SCOPE_APPROVED: ["CHANGE_PREVIEW"],
    CHANGE_PREVIEW: ["CHANGE_PREVIEW", "BUILDING"],
    BUILDING: ["QA"],
    QA: ["BUILDING", "FINAL_REVIEW"],
    FINAL_REVIEW: ["BUILDING", "DELIVERED"],
  },
});

const APPROVAL_GATES = Object.freeze({
  OUTLINE_APPROVED: "outline",
  VISUAL_LOCKED: "visual",
  SCOPE_APPROVED: "scope",
  DELIVERED: "final",
});

const INVALIDATION_RULES = Object.freeze({
  create: {
    narrative: {
      eligible: ["OUTLINE_APPROVED", "VISUAL_REVIEW", "VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"],
      target: "OUTLINE_REVIEW",
      approvals: ["outline", "visual", "final"],
    },
    visual: {
      eligible: ["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"],
      target: "VISUAL_REVIEW",
      approvals: ["visual", "final"],
    },
  },
  template: {
    narrative: {
      eligible: ["OUTLINE_APPROVED", "VISUAL_REVIEW", "VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"],
      target: "OUTLINE_REVIEW",
      approvals: ["outline", "visual", "final"],
    },
    visual: {
      eligible: ["VISUAL_LOCKED", "BUILDING", "QA", "FINAL_REVIEW"],
      target: "VISUAL_REVIEW",
      approvals: ["visual", "final"],
    },
  },
  edit: {
    scope: {
      eligible: ["SCOPE_APPROVED", "CHANGE_PREVIEW", "BUILDING", "QA", "FINAL_REVIEW"],
      target: "SCOPE_REVIEW",
      approvals: ["scope", "diffPreview", "final"],
    },
  },
});

function now() {
  return new Date().toISOString();
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function isWithinPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function tempRootCandidates() {
  return [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    "/tmp",
    "/var/tmp",
    "/private/tmp",
    "/private/var/tmp",
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
}

async function resolvedTempRoots() {
  const roots = [];
  for (const candidate of tempRootCandidates()) {
    let resolved;
    try {
      resolved = await fs.realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      resolved = path.resolve(candidate);
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

export function isEphemeralOutputPath(value, tempRoots = tempRootCandidates()) {
  const candidate = path.resolve(requireNonEmpty(value, "output path"));
  const parts = candidate.split(path.sep).filter(Boolean);
  const hasScratchComponent = parts.some((part) => {
    const normalized = part.toLocaleLowerCase("en-US");
    return EPHEMERAL_COMPONENTS.has(normalized)
      || EPHEMERAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
  return hasScratchComponent
    || tempRoots.some((root) => isWithinPath(candidate, path.resolve(root)));
}

async function assertPersistentFinalOutputPath(value, persistentRootValue, projectWorkspace) {
  const requestedRoot = path.resolve(
    projectWorkspace,
    requireNonEmpty(persistentRootValue, "finalOutputRoot"),
  );
  let resolvedRoot;
  try {
    resolvedRoot = await fs.realpath(requestedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`finalOutputRoot does not exist: ${requestedRoot}`);
    }
    throw error;
  }
  const rootMetadata = await fs.stat(resolvedRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`finalOutputRoot is not a directory: ${resolvedRoot}`);
  }
  const tempRoots = await resolvedTempRoots();
  if (isEphemeralOutputPath(resolvedRoot, tempRoots)) {
    throw new Error(
      `finalOutputRoot is an operating-system temporary or tool scratch directory: ${resolvedRoot}`,
    );
  }

  const requested = path.resolve(
    projectWorkspace,
    requireNonEmpty(value, "finalOutputPath"),
  );
  let resolved;
  try {
    resolved = await fs.realpath(requested);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`finalOutputPath does not exist: ${requested}`);
    }
    throw error;
  }
  const metadata = await fs.stat(resolved);
  if (!metadata.isFile()) {
    throw new Error(`finalOutputPath is not a regular file: ${resolved}`);
  }
  if (metadata.size <= 0) {
    throw new Error(`finalOutputPath is empty: ${resolved}`);
  }
  if (isEphemeralOutputPath(resolved, tempRoots)) {
    throw new Error(
      `finalOutputPath is inside an operating-system temporary or tool scratch directory: ${resolved}`,
    );
  }
  if (!isWithinPath(resolved, resolvedRoot)) {
    throw new Error(
      `finalOutputPath is outside finalOutputRoot ${resolvedRoot}: ${resolved}`,
    );
  }
  return { finalOutputRoot: resolvedRoot, finalOutputPath: resolved };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertDeterministicPrebuildMatch(actual, expected, label) {
  for (const [key, display] of Object.entries({
    slideSpecs: "slide-specs",
    themeLock: "theme-lock",
    fontEvidence: "font evidence",
  })) {
    if (actual.inputHashes?.[key] !== expected.inputHashes?.[key]) {
      throw new Error(`${label} ${display} input hash is stale or forged`);
    }
  }
  if (stableJson(actual.approvalHashes) !== stableJson(expected.approvalHashes)) {
    throw new Error(`${label} approval hashes are stale or do not match deterministic recomputation`);
  }
  if (stableJson(actual.violationCounts) !== stableJson(expected.violationCounts)) {
    throw new Error(`${label} violationCounts do not match deterministic recomputation`);
  }
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} PASS evidence differs from deterministic recomputation`);
  }
}

function projectIndexPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "visual-first-ppt", "projects.json");
}

async function workspaceExists(projectWorkspace) {
  try {
    return (await fs.stat(projectWorkspace)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureWorkspace(projectWorkspace) {
  const absolute = path.resolve(requireNonEmpty(projectWorkspace, "workspace"));
  if (!(await workspaceExists(absolute))) {
    throw new Error(`Workspace not found: ${absolute}`);
  }
  return absolute;
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validateAdoptionJournal(journal) {
  if (!journal || journal.artifactType !== "qualityAdoptionJournal"
    || journal.schemaVersion !== SCHEMA_VERSION
    || typeof journal.workspace !== "string"
    || typeof journal.projectId !== "string") {
    throw new Error("Invalid quality adoption transaction journal");
  }
  for (const side of ["old", "new"]) {
    if (!journal[side]?.manifest || !journal[side]?.state
      || journal[side].manifest.projectId !== journal.projectId
      || journal[side].state.projectId !== journal.projectId) {
      throw new Error(`Invalid quality adoption transaction journal ${side} snapshot`);
    }
    if (!Object.hasOwn(journal[side], "prebuildEvidence")) {
      throw new Error(`Invalid quality adoption transaction journal ${side} prebuild snapshot`);
    }
  }
}

function migrationProjection(value) {
  const projected = clone(value);
  delete projected.qualityContractVersion;
  delete projected.qualityGates;
  delete projected.updatedAt;
  return projected;
}

function assertJournalSnapshotValid(schema, journal, side) {
  try {
    validateDefinition(schema, "projectManifest", journal[side].manifest);
    validateDefinition(schema, "state", journal[side].state);
    validateCrossFileInvariants(journal[side].manifest, journal[side].state);
  } catch (error) {
    throw new Error(`Invalid quality adoption journal ${side} snapshot: ${error.message}`);
  }
}

function assertJournalMigrationShape(journal) {
  const oldHasQualityFields = [
    Object.hasOwn(journal.old.manifest, "qualityContractVersion"),
    Object.hasOwn(journal.old.manifest, "qualityGates"),
    Object.hasOwn(journal.old.state, "qualityContractVersion"),
    Object.hasOwn(journal.old.state, "qualityGates"),
  ].some(Boolean);
  if (oldHasQualityFields) {
    throw new Error("Invalid quality adoption journal old snapshot: expected a true legacy project");
  }
  if (journal.new.manifest.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || journal.new.state.qualityContractVersion !== QUALITY_CONTRACT_VERSION) {
    throw new Error("Invalid quality adoption journal new snapshot: expected current quality contract");
  }
  for (const artifact of ["manifest", "state"]) {
    if (stableJson(migrationProjection(journal.old[artifact]))
      !== stableJson(migrationProjection(journal.new[artifact]))) {
      throw new Error(`Invalid quality adoption journal old/new ${artifact} business fields differ`);
    }
  }

  const gates = journal.new.state.qualityGates;
  const allowedGateKeys = new Set([
    "prebuildEvidenceHash",
    "invalidatedPptxAuditHashes",
    "invalidatedQaReportHashes",
  ]);
  if (!gates || typeof gates.prebuildEvidenceHash !== "string") {
    throw new Error("Invalid quality adoption journal new prebuild gate");
  }
  for (const key of Object.keys(gates)) {
    if (!allowedGateKeys.has(key)) {
      throw new Error(`Invalid quality adoption journal new gate ${key}`);
    }
  }
  for (const key of ["invalidatedPptxAuditHashes", "invalidatedQaReportHashes"]) {
    if (Object.hasOwn(gates, key) && (!Array.isArray(gates[key]) || gates[key].length !== 0)) {
      throw new Error(`Invalid quality adoption journal new gate ${key} must be empty`);
    }
  }
}

async function validateJournalPrebuildEvidence(projectWorkspace, journal) {
  const evidence = journal.new.prebuildEvidence;
  try {
    await validateQualityEvidence("prebuildEvidence", evidence, "journal prebuild");
  } catch (error) {
    throw new Error(`Invalid quality adoption journal new prebuild evidence: ${error.message}`);
  }
  if (evidence.projectId !== journal.projectId
    || evidence.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || evidence.finalVerdict !== "PASS") {
    throw new Error("Invalid quality adoption journal new prebuild identity or verdict");
  }
  let expected;
  try {
    expected = await computePrebuildEvidence({
      slideSpecsPath: path.join(projectWorkspace, QUALITY_PATHS.slideSpecs),
      themeLockPath: path.join(projectWorkspace, QUALITY_PATHS.themeLock),
      state: journal.old.state,
      generatedAt: evidence.generatedAt,
    });
  } catch (error) {
    throw new Error(`Invalid quality adoption journal deterministic prebuild: ${error.message}`);
  }
  assertDeterministicPrebuildMatch(evidence, expected, "journal prebuild");
  const evidenceHash = serializedJsonHash(evidence);
  if (journal.new.manifest.qualityGates.prebuildEvidenceHash !== evidenceHash
    || journal.new.state.qualityGates.prebuildEvidenceHash !== evidenceHash) {
    throw new Error("Invalid quality adoption journal prebuild hash mismatch");
  }
}

function currentAdoptionPhase(journal, currentManifest, currentState, currentPrebuildEvidence) {
  const same = (left, right) => stableJson(left) === stableJson(right);
  const oldManifest = same(currentManifest, journal.old.manifest);
  const newManifest = same(currentManifest, journal.new.manifest);
  const oldState = same(currentState, journal.old.state);
  const newState = same(currentState, journal.new.state);
  const oldPrebuild = same(currentPrebuildEvidence, journal.old.prebuildEvidence);
  const newPrebuild = same(currentPrebuildEvidence, journal.new.prebuildEvidence);

  if (newManifest && newState && newPrebuild) return "complete";
  if ((oldManifest && oldState && oldPrebuild)
    || (oldManifest && oldState && newPrebuild)
    || (newManifest && oldState && newPrebuild)) {
    return "rollback";
  }
  throw new Error("Invalid quality adoption journal transaction phase");
}

async function restorePrebuildSnapshot(projectWorkspace, snapshot) {
  const standardPath = path.join(projectWorkspace, QUALITY_PATHS.prebuildEvidence);
  if (snapshot === null) await removeIfExists(standardPath);
  else await writeJsonAtomic(standardPath, snapshot);
}

async function recoverAdoptionTransaction(projectWorkspace, schema) {
  const journalPath = path.join(projectWorkspace, ADOPTION_JOURNAL_NAME);
  const journal = await readOptionalJson(journalPath);
  if (journal === undefined) return;
  validateAdoptionJournal(journal);
  const manifestPath = path.join(projectWorkspace, "project-manifest.json");
  const statePath = path.join(projectWorkspace, "state.json");
  const standardPrebuildPath = path.join(projectWorkspace, QUALITY_PATHS.prebuildEvidence);
  const [manifest, state, currentPrebuildValue] = await Promise.all([
    readOptionalJson(manifestPath),
    readOptionalJson(statePath),
    readOptionalJson(standardPrebuildPath),
  ]);
  const currentPrebuildEvidence = currentPrebuildValue === undefined ? null : currentPrebuildValue;

  if (journal.workspace !== projectWorkspace) {
    throw new Error("Invalid quality adoption journal workspace mismatch");
  }
  if (!manifest || !state
    || journal.projectId !== manifest.projectId
    || journal.projectId !== state.projectId) {
    throw new Error("Invalid quality adoption journal projectId mismatch with current project");
  }
  assertJournalSnapshotValid(schema, journal, "old");
  assertJournalSnapshotValid(schema, journal, "new");
  assertJournalMigrationShape(journal);
  await validateJournalPrebuildEvidence(projectWorkspace, journal);
  const phase = currentAdoptionPhase(journal, manifest, state, currentPrebuildEvidence);

  if (phase === "complete") {
    await restorePrebuildSnapshot(projectWorkspace, journal.new.prebuildEvidence);
  } else {
    await writeJsonAtomic(manifestPath, journal.old.manifest);
    await writeJsonAtomic(statePath, journal.old.state);
    await restorePrebuildSnapshot(projectWorkspace, journal.old.prebuildEvidence);
  }
  await removeIfExists(journalPath);
}

async function loadSchema() {
  return readJson(SCHEMA_PATH);
}

function validateDefinition(schema, definition, value) {
  const result = validateSchema(
    { $defs: schema.$defs, $ref: `#/$defs/${definition}` },
    value,
  );
  if (!result.valid) {
    throw new Error(`Invalid ${definition}: ${result.errors.join("; ")}`);
  }
}

async function readProject(projectWorkspace) {
  const absolute = await ensureWorkspace(projectWorkspace);
  const schema = await loadSchema();
  await recoverAdoptionTransaction(absolute, schema);
  const manifestPath = path.join(absolute, "project-manifest.json");
  const statePath = path.join(absolute, "state.json");
  const [manifest, state] = await Promise.all([
    readJson(manifestPath),
    readJson(statePath),
  ]);
  validateDefinition(schema, "projectManifest", manifest);
  validateDefinition(schema, "state", state);
  validateCrossFileInvariants(manifest, state);
  return { workspace: absolute, manifestPath, statePath, schema, manifest, state };
}

function validateCrossFileInvariants(manifest, state) {
  if (manifest.projectId !== state.projectId) {
    throw new Error(`projectId mismatch: manifest=${manifest.projectId}, state=${state.projectId}`);
  }
  if (manifest.route !== state.route) {
    throw new Error(`route mismatch: manifest=${manifest.route}, state=${state.route}`);
  }
  if (manifest.schemaVersion !== state.schemaVersion) {
    throw new Error("schemaVersion mismatch between manifest and state");
  }
  const manifestHasVersion = Object.hasOwn(manifest, "qualityContractVersion");
  const manifestHasGates = Object.hasOwn(manifest, "qualityGates");
  const stateHasVersion = Object.hasOwn(state, "qualityContractVersion");
  const stateHasGates = Object.hasOwn(state, "qualityGates");
  if (manifestHasVersion !== manifestHasGates) {
    throw new Error("manifest qualityContractVersion and qualityGates must be paired");
  }
  if (stateHasVersion !== stateHasGates) {
    throw new Error("state qualityContractVersion and qualityGates must be paired");
  }
  if (manifestHasVersion !== stateHasVersion) {
    throw new Error("quality contract fields must be present in both manifest and state");
  }
  if (manifestHasVersion) {
    if (manifest.qualityContractVersion !== state.qualityContractVersion) {
      throw new Error("qualityContractVersion mismatch between manifest and state");
    }
    if (stableJson(manifest.qualityGates) !== stableJson(state.qualityGates)) {
      throw new Error("qualityGates mismatch between manifest and state");
    }
  }
  if (["BLOCKED_SOURCE", "BLOCKED_COMPATIBILITY"].includes(state.status) && !state.blockedFrom) {
    throw new Error("blockedFrom is required while a project is blocked");
  }
}

async function assertWorkspaceIsEmpty(projectWorkspace) {
  for (const filename of ["project-manifest.json", "state.json"]) {
    try {
      await fs.access(path.join(projectWorkspace, filename));
      throw new Error(`Refusing to overwrite existing ${filename}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function persistProject(project, nextState, nextManifest = project.manifest) {
  const timestamp = now();
  const state = { ...nextState, updatedAt: timestamp };
  const manifest = { ...nextManifest, updatedAt: timestamp };
  validateDefinition(project.schema, "projectManifest", manifest);
  validateDefinition(project.schema, "state", state);
  validateCrossFileInvariants(manifest, state);
  await writeJsonAtomic(project.manifestPath, manifest);
  await writeJsonAtomic(project.statePath, state);
  await updateProjectIndex(projectIndexPath(), {
    projectId: manifest.projectId,
    workspace: project.workspace,
    finalOutputRoot: manifest.finalOutputRoot || null,
    finalOutputPath: manifest.finalOutputPath || null,
    currentState: state.status,
    updatedAt: timestamp,
  });
  return { manifest, state };
}

function approvalRecord(approval = {}) {
  return { ...clone(approval), approvedAt: now() };
}

function requireApprovalHash(approval, label = "approval") {
  if (typeof approval?.approvedArtifactHash !== "string"
    || !STRICT_APPROVAL_HASH.test(approval.approvedArtifactHash)) {
    throw new Error(`${label} requires an approval artifact hash as a lowercase SHA-256 digest`);
  }
}

function isQualityContractProject(project) {
  return project.manifest.qualityContractVersion === QUALITY_CONTRACT_VERSION
    && project.state.qualityContractVersion === QUALITY_CONTRACT_VERSION;
}

function assertQualityContractAdopted(project) {
  if (!isQualityContractProject(project)) {
    throw new Error(
      "Legacy project is read-only for rebuild, QA, and delivery; run adopt-quality with current prebuild evidence",
    );
  }
  if (!project.manifest.qualityGates || !project.state.qualityGates) {
    throw new Error("quality contract project is missing qualityGates");
  }
}

function appendUnique(values = [], value) {
  return value && !values.includes(value) ? [...values, value] : [...values];
}

function invalidateActiveQualityEvidence(gates) {
  const next = clone(gates || {});
  if (next.pptxAuditHash) {
    next.invalidatedPptxAuditHashes = appendUnique(
      next.invalidatedPptxAuditHashes,
      next.pptxAuditHash,
    );
  }
  if (next.qaReportHash) {
    next.invalidatedQaReportHashes = appendUnique(
      next.invalidatedQaReportHashes,
      next.qaReportHash,
    );
  }
  delete next.prebuildEvidenceHash;
  delete next.pptxAuditHash;
  delete next.qaReportHash;
  delete next.deckHash;
  return next;
}

async function sha256File(filePath, label = "file") {
  let payload;
  try {
    payload = await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist: ${filePath}`);
    throw error;
  }
  if (payload.length === 0) throw new Error(`${label} must be nonempty: ${filePath}`);
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

async function loadQualityEvidenceSchema() {
  return readJson(QUALITY_EVIDENCE_SCHEMA_PATH);
}

async function readEvidence(filePath, label) {
  let evidence;
  try {
    evidence = await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} PASS evidence is missing: ${filePath}`);
    throw new Error(`${label} PASS evidence is not valid JSON: ${error.message}`);
  }
  return evidence;
}

async function validateQualityEvidence(definition, evidence, label) {
  const schema = await loadQualityEvidenceSchema();
  try {
    validateDefinition(schema, definition, evidence);
  } catch (error) {
    throw new Error(`${label} PASS evidence failed schema validation: ${error.message}`);
  }
}

async function assertInputHash(filePath, expectedHash, label) {
  const actualHash = await sha256File(filePath, label);
  if (actualHash !== expectedHash) {
    throw new Error(`${label} input hash is stale: expected ${expectedHash}, received ${actualHash}`);
  }
  return actualHash;
}

async function validatePrebuildPassAt(project, evidencePath, { checkGate = true } = {}) {
  const evidence = await readEvidence(evidencePath, "prebuild");
  await validateQualityEvidence("prebuildEvidence", evidence, "prebuild");
  let expected;
  try {
    expected = await computePrebuildEvidence({
      slideSpecsPath: path.join(project.workspace, QUALITY_PATHS.slideSpecs),
      themeLockPath: path.join(project.workspace, QUALITY_PATHS.themeLock),
      state: project.state,
      generatedAt: evidence.generatedAt,
    });
  } catch (error) {
    throw new Error(`prebuild deterministic recomputation failed: ${error.message}`);
  }
  assertDeterministicPrebuildMatch(evidence, expected, "prebuild");
  const evidenceHash = await sha256File(evidencePath, "prebuild PASS evidence");
  const recordedHash = project.state.qualityGates?.prebuildEvidenceHash;
  if (checkGate && recordedHash && recordedHash !== evidenceHash) {
    throw new Error("prebuild evidence hash is stale relative to the recorded quality gate");
  }
  return { evidence, evidenceHash, evidencePath };
}

async function assertPrebuildPass(project) {
  return validatePrebuildPassAt(
    project,
    path.join(project.workspace, QUALITY_PATHS.prebuildEvidence),
  );
}

async function findCurrentDeck(project, expectedHash) {
  const deckPath = path.join(project.workspace, "deck.pptx");
  await assertInputHash(deckPath, expectedHash, "current deck.pptx");
  return deckPath;
}

async function assertPptxAuditPass(project) {
  assertQualityContractAdopted(project);
  const prebuild = await assertPrebuildPass(project);
  if (project.state.qualityGates.prebuildEvidenceHash !== prebuild.evidenceHash) {
    throw new Error("PPTX audit requires a recorded current prebuild PASS gate");
  }
  const evidencePath = path.join(project.workspace, QUALITY_PATHS.pptxAudit);
  const evidence = await readEvidence(evidencePath, "PPTX audit");
  await validateQualityEvidence("automatedEvidenceBundle", evidence, "PPTX audit");
  if (evidence.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || evidence.finalVerdict !== "PASS") {
    throw new Error("PPTX audit finalVerdict must PASS under the current quality contract");
  }
  await assertInputHash(
    path.join(project.workspace, QUALITY_PATHS.slideSpecs),
    evidence.inputHashes.slideSpecs,
    "PPTX audit slide-specs",
  );
  await assertInputHash(
    path.join(project.workspace, QUALITY_PATHS.themeLock),
    evidence.inputHashes.themeLock,
    "PPTX audit theme-lock",
  );
  await assertInputHash(
    path.join(project.workspace, QUALITY_PATHS.objectInventory),
    evidence.inputHashes.objectInventory,
    "PPTX audit object-inventory",
  );
  const deckPath = await findCurrentDeck(project, evidence.inputHashes.deck);
  const evidenceHash = await sha256File(evidencePath, "PPTX audit PASS evidence");
  const gates = project.state.qualityGates;
  if ((gates.invalidatedPptxAuditHashes || []).includes(evidenceHash)) {
    throw new Error("PPTX audit evidence hash was invalidated; regenerate audit evidence bytes");
  }
  if (gates.pptxAuditHash && gates.pptxAuditHash !== evidenceHash) {
    throw new Error("PPTX audit hash is stale relative to the recorded quality gate");
  }
  if (gates.deckHash && gates.deckHash !== evidence.inputHashes.deck) {
    throw new Error("PPTX deck hash is stale relative to the recorded quality gate");
  }
  return { evidence, evidenceHash, evidencePath, deckPath, deckHash: evidence.inputHashes.deck };
}

function resolveQaArtifactPath(project, declaredPath) {
  const normalized = requireNonEmpty(declaredPath, "QA input artifact path");
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(project.workspace, normalized);
}

async function assertQaPass(project, { transitionLabel = "DELIVERED" } = {}) {
  let qaReport;
  try {
    qaReport = await readJson(path.join(project.workspace, QUALITY_PATHS.qaReport));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${transitionLabel} requires a QA PASS artifact`);
    }
    throw error;
  }
  try {
    validateDefinition(project.schema, "qaReportCurrent", qaReport);
  } catch (error) {
    throw new Error(
      `${transitionLabel} requires qaReportCurrent; legacy QA is read-only: ${error.message}`,
    );
  }
  if (qaReport.projectId !== project.state.projectId || qaReport.finalVerdict !== "PASS") {
    throw new Error(`${transitionLabel} requires a QA PASS artifact for this project`);
  }
  if (!isQualityContractProject(project)) {
    throw new Error(`${transitionLabel} requires the current quality contract; legacy QA is read-only`);
  }
  assertQualityContractAdopted(project);
  const qaReportHash = await sha256File(
    path.join(project.workspace, QUALITY_PATHS.qaReport),
    "QA PASS artifact",
  );
  if ((project.state.qualityGates.invalidatedQaReportHashes || []).includes(qaReportHash)) {
    throw new Error(`${transitionLabel} QA evidence hash was invalidated; regenerate QA evidence bytes`);
  }
  if (transitionLabel !== "QA -> FINAL_REVIEW"
    && project.state.qualityGates.qaReportHash !== qaReportHash) {
    throw new Error(`${transitionLabel} QA report hash is stale or was not reviewed`);
  }

  try {
    await validateCurrentQaReport({
      report: qaReport,
      reportPath: path.join(project.workspace, QUALITY_PATHS.qaReport),
      workspace: project.workspace,
      expectedProjectId: project.state.projectId,
      expectedRoute: project.state.route,
    });
  } catch (error) {
    throw new Error(`${transitionLabel} current QA preflight failed: ${error.message}`);
  }

  const audit = await assertPptxAuditPass(project);
  if (project.state.qualityGates.pptxAuditHash !== audit.evidenceHash
    || project.state.qualityGates.deckHash !== audit.deckHash) {
    throw new Error(`${transitionLabel} requires a recorded current PPTX audit and deck hash`);
  }
  if (qaReport.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || qaReport.route !== project.state.route
    || !qaReport.inputArtifacts
    || !Array.isArray(qaReport.reviewChecks)) {
    throw new Error(`${transitionLabel} requires a current structured QA PASS artifact`);
  }
  for (const artifactId of ["deck", "slideSpecs", "themeLock"]) {
    const descriptor = qaReport.inputArtifacts[artifactId];
    if (!descriptor || typeof descriptor.sha256 !== "string") {
      throw new Error(`${transitionLabel} QA PASS is missing input artifact ${artifactId}`);
    }
    const artifactPath = resolveQaArtifactPath(project, descriptor.path);
    await assertInputHash(artifactPath, descriptor.sha256, `QA ${artifactId}`);
    if (qaReport.inputHashes?.[artifactId] !== descriptor.sha256) {
      throw new Error(`${transitionLabel} QA ${artifactId} input hash projection is stale`);
    }
  }
  if (qaReport.inputArtifacts.deck.sha256 !== audit.deckHash
    || qaReport.inputArtifacts.slideSpecs.sha256 !== audit.evidence.inputHashes.slideSpecs
    || qaReport.inputArtifacts.themeLock.sha256 !== audit.evidence.inputHashes.themeLock) {
    throw new Error(`${transitionLabel} QA PASS input hashes do not match the current PPTX audit`);
  }
  const bindsCurrentAudit = qaReport.automatedChecks.some((check) => {
    if (typeof check?.evidencePath !== "string") return false;
    const resolved = path.isAbsolute(check.evidencePath)
      ? path.resolve(check.evidencePath)
      : path.resolve(project.workspace, check.evidencePath);
    return resolved === audit.evidencePath && check.evidenceSha256 === audit.evidenceHash;
  });
  if (!bindsCurrentAudit) {
    throw new Error(`${transitionLabel} QA PASS is not bound to the current PPTX audit hash`);
  }
  return { qaReport, qaReportHash, deckHash: audit.deckHash };
}

export async function initProject({ title, route, workspace, inputHashes = {} }) {
  const normalizedTitle = requireNonEmpty(title, "title");
  if (!Object.hasOwn(TRANSITIONS, route)) {
    throw new Error(`route must be one of: ${Object.keys(TRANSITIONS).join(", ")}`);
  }
  const absolute = path.resolve(requireNonEmpty(workspace, "workspace"));
  await fs.mkdir(absolute, { recursive: true });
  await assertWorkspaceIsEmpty(absolute);

  const timestamp = now();
  const projectId = `ppt-${crypto.randomUUID()}`;
  const manifest = {
    artifactType: "projectManifest",
    schemaVersion: SCHEMA_VERSION,
    qualityContractVersion: QUALITY_CONTRACT_VERSION,
    qualityGates: {},
    projectId,
    title: normalizedTitle,
    route,
    workspace: absolute,
    inputHashes: clone(inputHashes),
    toolVersions: { node: process.version },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const state = {
    artifactType: "state",
    schemaVersion: SCHEMA_VERSION,
    qualityContractVersion: QUALITY_CONTRACT_VERSION,
    qualityGates: {},
    projectId,
    route,
    status: "INTAKE",
    approvals: {},
    blockers: [],
    completedBatches: [],
    inputHashes: clone(inputHashes),
    invalidations: [],
    updatedAt: timestamp,
  };
  const schema = await loadSchema();
  validateDefinition(schema, "projectManifest", manifest);
  validateDefinition(schema, "state", state);
  await writeJsonAtomic(path.join(absolute, "project-manifest.json"), manifest);
  await writeJsonAtomic(path.join(absolute, "state.json"), state);
  await updateProjectIndex(projectIndexPath(), {
    projectId,
    workspace: absolute,
    finalOutputPath: null,
    currentState: state.status,
    updatedAt: timestamp,
  });
  return { projectId, workspace: absolute, manifest, state };
}

export async function validateProject(workspace) {
  const project = await readProject(workspace);
  if (project.state.status === "FINAL_REVIEW") {
    await assertQaPass(project, { transitionLabel: "FINAL_REVIEW validation" });
  }
  if (project.state.status === "DELIVERED") {
    requireApprovalHash(project.state.approvals?.final, "final approval");
    if (typeof project.manifest.finalOutputRoot !== "string" || project.manifest.finalOutputRoot.trim() === "") {
      throw new Error("DELIVERED project requires manifest.finalOutputRoot");
    }
    if (typeof project.manifest.finalOutputPath !== "string" || project.manifest.finalOutputPath.trim() === "") {
      throw new Error("DELIVERED project requires manifest.finalOutputPath");
    }
    const persistentFinalOutput = await assertPersistentFinalOutputPath(
      project.manifest.finalOutputPath,
      project.manifest.finalOutputRoot,
      project.workspace,
    );
    const qa = await assertQaPass(project);
    if (isQualityContractProject(project)) {
      const finalOutputHash = await sha256File(
        persistentFinalOutput.finalOutputPath,
        "DELIVERED final output",
      );
      if (finalOutputHash !== qa.deckHash
        || project.state.approvals.final.approvedArtifactHash !== qa.deckHash) {
        throw new Error("DELIVERED final approval and final output must match the current QA deck hash");
      }
    }
  }
  return {
    valid: true,
    projectId: project.manifest.projectId,
    route: project.state.route,
    status: project.state.status,
  };
}

export async function transitionProject({ workspace, to, approval }) {
  const target = requireNonEmpty(to, "to");
  const project = await readProject(workspace);
  const allowed = TRANSITIONS[project.state.route]?.[project.state.status] || [];
  if (!allowed.includes(target)) {
    throw new Error(
      `Invalid transition for ${project.state.route}: ${project.state.status} -> ${target}`,
    );
  }

  if (["BUILDING", "QA", "FINAL_REVIEW", "DELIVERED"].includes(target)) {
    assertQualityContractAdopted(project);
  }

  const gate = APPROVAL_GATES[target];
  if (gate) requireApprovalHash(approval, gate);
  if (
    project.state.route === "edit"
    && project.state.status === "CHANGE_PREVIEW"
    && target === "BUILDING"
  ) {
    diffPreviewApprovalHash(approval, { required: true });
  }
  const approvals = clone(project.state.approvals);
  if (gate) approvals[gate] = approvalRecord(approval);
  if (
    project.state.route === "edit"
    && project.state.status === "CHANGE_PREVIEW"
    && target === "BUILDING"
  ) {
    approvals.diffPreview = approvalRecord(approval);
  }
  const prospectiveProject = {
    ...project,
    state: { ...project.state, approvals },
  };
  let qualityGates = clone(project.state.qualityGates);
  if (target === "BUILDING") {
    if (["QA", "FINAL_REVIEW"].includes(project.state.status)) {
      qualityGates = invalidateActiveQualityEvidence(qualityGates);
    }
    const prebuild = await assertPrebuildPass(prospectiveProject);
    qualityGates = { ...qualityGates, prebuildEvidenceHash: prebuild.evidenceHash };
  }
  if (target === "QA") {
    const audit = await assertPptxAuditPass(prospectiveProject);
    qualityGates = {
      ...qualityGates,
      pptxAuditHash: audit.evidenceHash,
      deckHash: audit.deckHash,
    };
    delete qualityGates.qaReportHash;
  }
  if (target === "FINAL_REVIEW") {
    const qa = await assertQaPass(prospectiveProject, { transitionLabel: "QA -> FINAL_REVIEW" });
    qualityGates = {
      ...qualityGates,
      qaReportHash: qa.qaReportHash,
      deckHash: qa.deckHash,
    };
  }
  let persistentFinalOutput;
  if (target === "DELIVERED") {
    const qa = await assertQaPass(prospectiveProject);
    if (approval.approvedArtifactHash !== qa.deckHash) {
      throw new Error("DELIVERED final approval hash must match the current QA deck hash");
    }
    persistentFinalOutput = await assertPersistentFinalOutputPath(
      approval?.finalOutputPath,
      approval?.finalOutputRoot,
      project.workspace,
    );
    if (await sha256File(persistentFinalOutput.finalOutputPath, "DELIVERED final output") !== qa.deckHash) {
      throw new Error("DELIVERED final output does not match the current QA deck hash");
    }
  }

  const manifest = clone(project.manifest);
  manifest.qualityGates = clone(qualityGates);
  if (target === "DELIVERED") {
    manifest.finalOutputRoot = persistentFinalOutput.finalOutputRoot;
    manifest.finalOutputPath = persistentFinalOutput.finalOutputPath;
  }
  const result = await persistProject(
    project,
    { ...project.state, status: target, approvals, qualityGates },
    manifest,
  );
  return result.state;
}

export async function blockProject({ workspace, blockerType, reason }) {
  const type = requireNonEmpty(blockerType, "blockerType");
  const blockerReason = requireNonEmpty(reason, "reason");
  const project = await readProject(workspace);
  const expected = project.state.route === "edit" ? "BLOCKED_COMPATIBILITY" : "BLOCKED_SOURCE";
  if (type !== expected) {
    throw new Error(`Incompatible blocker ${type} for route ${project.state.route}; expected ${expected}`);
  }
  if (project.state.status === "DELIVERED") {
    throw new Error("DELIVERED projects cannot be blocked");
  }
  if (["BLOCKED_SOURCE", "BLOCKED_COMPATIBILITY"].includes(project.state.status)) {
    throw new Error("Project is already blocked");
  }

  const state = {
    ...project.state,
    status: type,
    blockedFrom: project.state.status,
    blockedInputHashes: clone(project.state.inputHashes || {}),
    blockers: [
      ...project.state.blockers,
      { type, reason: blockerReason, createdAt: now() },
    ],
  };
  return (await persistProject(project, state)).state;
}

export async function resumeBlockedProject({ workspace }) {
  const project = await readProject(workspace);
  if (!["BLOCKED_SOURCE", "BLOCKED_COMPATIBILITY"].includes(project.state.status)) {
    throw new Error(`Project is not blocked: ${project.state.status}`);
  }
  if (project.state.blockers.length !== 0) {
    throw new Error("All blockers must be cleared before resume");
  }
  if (!project.state.blockedFrom) {
    throw new Error("blockedFrom is missing; refusing to guess a resume state");
  }
  if (stableJson(project.state.blockedInputHashes || {}) !== stableJson(project.state.inputHashes || {})) {
    throw new Error("Project input hashes changed while blocked; a new review is required");
  }
  if (!Object.hasOwn(TRANSITIONS[project.state.route], project.state.blockedFrom)) {
    throw new Error(`Invalid blockedFrom state: ${project.state.blockedFrom}`);
  }

  const state = { ...project.state, status: project.state.blockedFrom };
  delete state.blockedFrom;
  delete state.blockedInputHashes;
  return (await persistProject(project, state)).state;
}

export async function invalidateApproval({
  workspace,
  impact,
  changedArtifactHash,
  reason,
  affectedPages = [],
}) {
  const normalizedImpact = requireNonEmpty(impact, "impact");
  const changedHash = requireNonEmpty(changedArtifactHash, "changed artifact hash");
  const invalidationReason = requireNonEmpty(reason, "reason");
  if (!Array.isArray(affectedPages)) {
    throw new Error("affectedPages must be an array");
  }

  const project = await readProject(workspace);
  const rule = INVALIDATION_RULES[project.state.route]?.[normalizedImpact];
  if (!rule) {
    throw new Error(`Invalid impact ${normalizedImpact} for route ${project.state.route}`);
  }
  if (!rule.eligible.includes(project.state.status)) {
    throw new Error(
      `Cannot invalidate ${normalizedImpact} approval from state ${project.state.status}`,
    );
  }

  const approvals = clone(project.state.approvals);
  const invalidatedApprovals = rule.approvals.filter((key) => Object.hasOwn(approvals, key));
  for (const key of rule.approvals) delete approvals[key];
  const invalidation = {
    impact: normalizedImpact,
    changedArtifactHash: changedHash,
    reason: invalidationReason,
    invalidatedApprovals,
    affectedPages: clone(affectedPages),
    invalidatedAt: now(),
    previousState: project.state.status,
  };
  const state = {
    ...project.state,
    status: rule.target,
    approvals,
    ...(isQualityContractProject(project)
      ? { qualityGates: invalidateActiveQualityEvidence(project.state.qualityGates) }
      : {}),
    invalidations: [...project.state.invalidations, invalidation],
  };
  const manifest = clone(project.manifest);
  if (isQualityContractProject(project)) manifest.qualityGates = clone(state.qualityGates);
  return (await persistProject(project, state, manifest)).state;
}

function serializedJsonHash(value) {
  return `sha256:${crypto.createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    .digest("hex")}`;
}

export async function adoptQualityContract({
  workspace,
  prebuildEvidencePath,
  testHooks = {},
}) {
  const project = await readProject(workspace);
  if (project.manifest.qualityContractVersion !== undefined
    || project.state.qualityContractVersion !== undefined) {
    throw new Error("Project already uses the current quality contract; adopt-quality is legacy-only");
  }
  const providedPath = path.resolve(requireNonEmpty(prebuildEvidencePath, "prebuild evidence"));
  const validated = await validatePrebuildPassAt(project, providedPath, { checkGate: false });
  const standardPath = path.join(project.workspace, QUALITY_PATHS.prebuildEvidence);
  const oldPrebuildEvidence = await readOptionalJson(standardPath) ?? null;
  const prebuildEvidenceHash = serializedJsonHash(validated.evidence);
  const qualityGates = { prebuildEvidenceHash };
  const timestamp = now();
  const state = {
    ...project.state,
    qualityContractVersion: QUALITY_CONTRACT_VERSION,
    qualityGates,
    updatedAt: timestamp,
  };
  const manifest = {
    ...project.manifest,
    qualityContractVersion: QUALITY_CONTRACT_VERSION,
    qualityGates: clone(qualityGates),
    updatedAt: timestamp,
  };
  validateDefinition(project.schema, "projectManifest", manifest);
  validateDefinition(project.schema, "state", state);
  validateCrossFileInvariants(manifest, state);

  const journalPath = path.join(project.workspace, ADOPTION_JOURNAL_NAME);
  const journal = {
    artifactType: "qualityAdoptionJournal",
    schemaVersion: SCHEMA_VERSION,
    workspace: project.workspace,
    projectId: project.state.projectId,
    old: {
      manifest: project.manifest,
      state: project.state,
      prebuildEvidence: oldPrebuildEvidence,
    },
    new: {
      manifest,
      state,
      prebuildEvidence: validated.evidence,
    },
  };
  await writeJsonAtomic(journalPath, journal);
  try {
    await writeJsonAtomic(standardPath, validated.evidence);
    await writeJsonAtomic(project.manifestPath, manifest);
    if (typeof testHooks.beforeStateWrite === "function") {
      await testHooks.beforeStateWrite();
    }
    await writeJsonAtomic(project.statePath, state);
  } catch (error) {
    try {
      await writeJsonAtomic(project.manifestPath, project.manifest);
      await writeJsonAtomic(project.statePath, project.state);
      await restorePrebuildSnapshot(project.workspace, oldPrebuildEvidence);
      await removeIfExists(journalPath);
    } catch (rollbackError) {
      error.cause = rollbackError;
    }
    throw error;
  }
  await removeIfExists(journalPath);
  await updateProjectIndex(projectIndexPath(), {
    projectId: manifest.projectId,
    workspace: project.workspace,
    finalOutputRoot: manifest.finalOutputRoot || null,
    finalOutputPath: manifest.finalOutputPath || null,
    currentState: state.status,
    updatedAt: timestamp,
  });
  return state;
}

async function runCli(argv) {
  const [command, ...args] = argv;
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return { help: true };
  }
  if (command === "validate") {
    const result = await validateProject(args[0]);
    console.log(`VALID ${path.basename(path.resolve(args[0]))}`);
    return result;
  }
  if (command === "init") {
    const [workspace, route, ...titleParts] = args;
    const result = await initProject({ workspace, route, title: titleParts.join(" ") });
    console.log(`INITIALIZED ${result.projectId}`);
    return result;
  }
  if (command === "transition") {
    const [workspace, to, approvedArtifactHash, finalOutputRoot, finalOutputPath] = args;
    const approval = approvedArtifactHash
      ? {
        approvedArtifactHash,
        ...(finalOutputRoot ? { finalOutputRoot } : {}),
        ...(finalOutputPath ? { finalOutputPath } : {}),
      }
      : undefined;
    const result = await transitionProject({ workspace, to, approval });
    console.log(`STATE ${result.status}`);
    return result;
  }
  if (command === "block") {
    const [workspace, blockerType, ...reasonParts] = args;
    const result = await blockProject({ workspace, blockerType, reason: reasonParts.join(" ") });
    console.log(`STATE ${result.status}`);
    return result;
  }
  if (command === "resume") {
    const result = await resumeBlockedProject({ workspace: args[0] });
    console.log(`STATE ${result.status}`);
    return result;
  }
  if (command === "invalidate") {
    const [workspace, impact, changedArtifactHash, ...reasonParts] = args;
    const result = await invalidateApproval({
      workspace,
      impact,
      changedArtifactHash,
      reason: reasonParts.join(" "),
    });
    console.log(`STATE ${result.status}`);
    return result;
  }
  if (command === "adopt-quality") {
    const [workspace, prebuildEvidencePath] = args;
    const result = await adoptQualityContract({ workspace, prebuildEvidencePath });
    console.log(`QUALITY ${result.qualityContractVersion}`);
    return result;
  }
  throw new Error(
    USAGE,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
