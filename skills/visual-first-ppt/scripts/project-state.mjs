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
import { validateSchema } from "./lib/schema-validator.mjs";

const SCHEMA_VERSION = "1.0.0";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(SCRIPT_DIR, "../schemas/project-artifacts.schema.json");
const USAGE = [
  "Usage: project-state.mjs <init|transition|block|resume|invalidate|validate> ...",
  "  project-state.mjs transition <workspace> DELIVERED <approval-hash> <persistent-root> <persistent-final-output>",
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
  const manifestPath = path.join(absolute, "project-manifest.json");
  const statePath = path.join(absolute, "state.json");
  const [schema, manifest, state] = await Promise.all([
    loadSchema(),
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
  if (typeof approval?.approvedArtifactHash !== "string" || approval.approvedArtifactHash.trim() === "") {
    throw new Error(`${label} requires an approval artifact hash`);
  }
}

async function assertQaPass(project) {
  let qaReport;
  try {
    qaReport = await readJson(path.join(project.workspace, "qa-report.json"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("DELIVERED requires a QA PASS artifact");
    }
    throw error;
  }
  try {
    validateDefinition(project.schema, "qaReport", qaReport);
  } catch (error) {
    throw new Error(`DELIVERED requires a schema-valid QA PASS artifact: ${error.message}`);
  }
  if (qaReport.projectId !== project.state.projectId || qaReport.finalVerdict !== "PASS") {
    throw new Error("DELIVERED requires a QA PASS artifact for this project");
  }
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
  if (project.state.status === "DELIVERED") {
    requireApprovalHash(project.state.approvals?.final, "final approval");
    if (typeof project.manifest.finalOutputRoot !== "string" || project.manifest.finalOutputRoot.trim() === "") {
      throw new Error("DELIVERED project requires manifest.finalOutputRoot");
    }
    if (typeof project.manifest.finalOutputPath !== "string" || project.manifest.finalOutputPath.trim() === "") {
      throw new Error("DELIVERED project requires manifest.finalOutputPath");
    }
    await assertPersistentFinalOutputPath(
      project.manifest.finalOutputPath,
      project.manifest.finalOutputRoot,
      project.workspace,
    );
    await assertQaPass(project);
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

  const gate = APPROVAL_GATES[target];
  if (gate) requireApprovalHash(approval, gate);
  if (
    project.state.route === "edit"
    && project.state.status === "CHANGE_PREVIEW"
    && target === "BUILDING"
  ) {
    const hasHash = typeof approval?.approvedArtifactHash === "string"
      && approval.approvedArtifactHash.trim() !== "";
    const hasReason = typeof approval?.notApplicableReason === "string"
      && approval.notApplicableReason.trim() !== "";
    if (!hasHash && !hasReason) {
      throw new Error("CHANGE_PREVIEW -> BUILDING requires diff-preview approval or a not-applicable reason");
    }
  }
  let persistentFinalOutput;
  if (target === "DELIVERED") {
    await assertQaPass(project);
    persistentFinalOutput = await assertPersistentFinalOutputPath(
      approval?.finalOutputPath,
      approval?.finalOutputRoot,
      project.workspace,
    );
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

  const manifest = clone(project.manifest);
  if (target === "DELIVERED") {
    manifest.finalOutputRoot = persistentFinalOutput.finalOutputRoot;
    manifest.finalOutputPath = persistentFinalOutput.finalOutputPath;
  }
  const result = await persistProject(
    project,
    { ...project.state, status: target, approvals },
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
    invalidations: [...project.state.invalidations, invalidation],
  };
  return (await persistProject(project, state)).state;
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
