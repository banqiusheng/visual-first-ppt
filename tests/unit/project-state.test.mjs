import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  blockProject,
  initProject,
  invalidateApproval,
  isEphemeralOutputPath,
  resumeBlockedProject,
  transitionProject,
  validateProject,
} from "../../skills/visual-first-ppt/scripts/project-state.mjs";
import * as projectStateModule from "../../skills/visual-first-ppt/scripts/project-state.mjs";
import {
  readJson,
  writeJsonAtomic,
} from "../../skills/visual-first-ppt/scripts/lib/atomic-json.mjs";
import {
  validateSchema,
} from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";
import { validateSlideSpecs } from "../../skills/visual-first-ppt/scripts/validate-slide-specs.mjs";
import {
  buildQaReport,
  EDIT_REQUIRED_CHECKS,
  REQUIRED_AUTOMATED_CHECKS,
  REQUIRED_MANUAL_DIMENSIONS,
  REQUIRED_REVIEW_CHECKS,
} from "../../skills/visual-first-ppt/scripts/build-qa-report.mjs";

const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visual-first-ppt-state-"));
process.env.CODEX_HOME = path.join(sandboxRoot, "codex-home");
const STATE_DRIVER = path.resolve("tests/artifacts/support/state-driver.mjs");
const PROJECT_ARTIFACTS_SCHEMA_PATH = path.resolve(
  "skills/visual-first-ppt/schemas/project-artifacts.schema.json",
);
const DRIVER_OWNER_MARKER = ".synthetic-state-driver-owner.json";
const ADOPTION_JOURNAL = ".project-state-adopt-journal.json";
const APPROVAL_HASHES = Object.freeze({
  outline: `sha256:${"1".repeat(64)}`,
  visual: `sha256:${"2".repeat(64)}`,
  scope: `sha256:${"3".repeat(64)}`,
  diffPreview: `sha256:${"4".repeat(64)}`,
  changedDiffPreview: `sha256:${"5".repeat(64)}`,
});
const SYNTHETIC_VISUAL_SAMPLES = Object.freeze([
  ["visual-samples/cover.png", Buffer.from("synthetic approved cover sample\n", "utf8")],
  ["visual-samples/content.png", Buffer.from("synthetic approved content sample\n", "utf8")],
]);
let evidenceSequence = 0;

async function workspace(name) {
  return path.join(sandboxRoot, name);
}

async function loadState(projectWorkspace) {
  return readJson(path.join(projectWorkspace, "state.json"));
}

async function saveState(projectWorkspace, state) {
  return writeJsonAtomic(path.join(projectWorkspace, "state.json"), state);
}

async function loadManifest(projectWorkspace) {
  return readJson(path.join(projectWorkspace, "project-manifest.json"));
}

async function saveManifest(projectWorkspace, manifest) {
  return writeJsonAtomic(path.join(projectWorkspace, "project-manifest.json"), manifest);
}

async function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex")}`;
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

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, payload]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function pngBytes(width = 1600, height = 900) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xee)]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function nextGeneratedAt() {
  evidenceSequence += 1;
  return new Date(Date.UTC(2026, 6, 17, 0, 0, evidenceSequence)).toISOString();
}

function normalizedReason(reason) {
  return reason.trim().replace(/\s+/g, " ");
}

function diffPreviewBinding(approval) {
  if (typeof approval?.approvedArtifactHash === "string" && approval.approvedArtifactHash.trim()) {
    return approval.approvedArtifactHash.trim();
  }
  if (typeof approval?.notApplicableReason === "string" && approval.notApplicableReason.trim()) {
    return `sha256:${crypto.createHash("sha256")
      .update(normalizedReason(approval.notApplicableReason), "utf8")
      .digest("hex")}`;
  }
  return undefined;
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

async function workspaceSnapshot(projectWorkspace) {
  const snapshot = [];
  async function visit(directory) {
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(projectWorkspace, absolute);
      if (entry.isDirectory()) {
        snapshot.push({ relative, type: "directory" });
        await visit(absolute);
      } else if (entry.isFile()) {
        const metadata = await fs.stat(absolute);
        snapshot.push({
          relative,
          type: "file",
          mode: metadata.mode & 0o777,
          bytes: (await fs.readFile(absolute)).toString("base64"),
        });
      } else if (entry.isSymbolicLink()) {
        snapshot.push({ relative, type: "symlink", target: await fs.readlink(absolute) });
      }
    }
  }
  await visit(projectWorkspace);
  return snapshot;
}

async function assertRejectedTransitionPreservesWorkspace({
  projectWorkspace,
  to,
  approval,
}) {
  const before = await workspaceSnapshot(projectWorkspace);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to, approval }),
    /approval artifact hash|lowercase SHA-256/i,
  );
  assert.deepEqual(await workspaceSnapshot(projectWorkspace), before);
}

function runStateDriver(args) {
  return spawnSync(process.execPath, [STATE_DRIVER, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

async function ensureQualityInputs(projectWorkspace) {
  const state = await loadState(projectWorkspace);
  const slideSpecsPath = path.join(projectWorkspace, "slide-specs.json");
  const themeLockPath = path.join(projectWorkspace, "theme-lock.json");
  const fontEvidencePath = path.join(projectWorkspace, "font-evidence.json");
  const objectInventoryPath = path.join(projectWorkspace, "object-inventory.json");
  const deckPath = path.join(projectWorkspace, "deck.pptx");
  const slideSpecs = JSON.parse(await fs.readFile(
    path.resolve("tests/fixtures/visual-quality/valid-slide-specs.json"),
    "utf8",
  ));
  slideSpecs.projectId = state.projectId;
  slideSpecs.route = state.route;
  if (state.route === "template") slideSpecs.slides[0].authorization = "new-slide";
  if (state.route === "edit") slideSpecs.slides[0].authorization = "authorized-modify";
  await writeJsonAtomic(slideSpecsPath, slideSpecs);
  const sourcePptPath = path.join(projectWorkspace, "source-edit.pptx");
  if (state.route === "edit") {
    await fs.copyFile(path.resolve("tests/fixtures/baseline/edit-source.pptx"), sourcePptPath);
  }
  for (const [relativePath, bytes] of SYNTHETIC_VISUAL_SAMPLES) {
    const samplePath = path.join(projectWorkspace, relativePath);
    await fs.mkdir(path.dirname(samplePath), { recursive: true });
    await fs.writeFile(samplePath, bytes);
  }
  const themeLock = {
    artifactType: "themeLock",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    primary_visual_source: state.route === "edit"
      ? "source-ppt"
      : "builtin:education-training",
    themeId: "education-training",
    fontResolutionMode: state.route === "edit" ? "source-edit" : "theme-catalog",
    ...(state.route === "edit" ? {
      sourcePptPath: path.basename(sourcePptPath),
      sourcePptHash: await sha256File(sourcePptPath),
    } : {}),
    resolvedFonts: {
      cjkTitle: "Microsoft YaHei",
      cjkBody: "Microsoft YaHei",
      latin: "Aptos",
      number: "Arial",
    },
    fontEvidencePath: "font-evidence.json",
    embeddingStatus: "not-embedded",
    targetClient: "Microsoft PowerPoint",
    palette: { background: "#F4F9F7", primary: "#205B52" },
    composition: { grid: "12-column", rhythm: "explain-demonstrate-summarize" },
    samplePaths: SYNTHETIC_VISUAL_SAMPLES.map(([relativePath]) => relativePath),
    sampleHashes: SYNTHETIC_VISUAL_SAMPLES.map(([, bytes]) => (
      `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
    )),
  };
  const visualContractHash = expectedVisualContractHash(themeLock);
  if (state.route !== "edit") {
    themeLock.approval = {
      approvedArtifactHash: visualContractHash,
      approvedAt: "2026-07-17T00:00:00.000Z",
      userMessage: "批准合成视觉契约",
    };
  }
  await writeJsonAtomic(themeLockPath, themeLock);
  await writeJsonAtomic(fontEvidencePath, {
    artifactType: "fontResolutionEvidence",
    schemaVersion: "1.0.0",
    resolvedFonts: themeLock.resolvedFonts,
    targetClient: themeLock.targetClient,
    embeddingStatus: themeLock.embeddingStatus,
    fontAvailability: { status: "PASS", unavailableFonts: [] },
    glyphCoverage: { status: "PASS", missingGlyphs: [] },
    finalVerdict: "PASS",
  });
  await writeJsonAtomic(objectInventoryPath, {
    artifactType: "objectInventory",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    slides: [{ slide: 1, objects: [] }],
  });
  await fs.copyFile(path.resolve("tests/fixtures/baseline/edit-source.pptx"), deckPath);
  return {
    slideSpecsPath,
    themeLockPath,
    fontEvidencePath,
    objectInventoryPath,
    deckPath,
    visualContractHash,
  };
}

function currentApprovalHashes(state, prospectiveDiffPreview) {
  const hashes = Object.fromEntries(Object.entries(state.approvals)
    .filter(([key, value]) => key !== "final"
      && typeof value?.approvedArtifactHash === "string")
    .map(([key, value]) => [key, value.approvedArtifactHash]));
  const diffPreview = prospectiveDiffPreview || state.approvals.diffPreview;
  const binding = diffPreviewBinding(diffPreview);
  if (binding) hashes.diffPreview = binding;
  return hashes;
}

async function writePrebuildEvidence(projectWorkspace, outputPath = path.join(
  projectWorkspace,
  "quality/prebuild-evidence.json",
), { prospectiveDiffPreview } = {}) {
  let state = await loadState(projectWorkspace);
  const inputs = await ensureQualityInputs(projectWorkspace);
  if (state.qualityContractVersion === undefined
    && ["create", "template"].includes(state.route)
    && state.approvals?.visual?.approvedArtifactHash !== inputs.visualContractHash) {
    state.approvals.visual = {
      ...state.approvals.visual,
      approvedArtifactHash: inputs.visualContractHash,
      approvedAt: "2026-07-17T00:00:00.000Z",
    };
    await saveState(projectWorkspace, state);
    state = await loadState(projectWorkspace);
  }
  const evidence = await validateSlideSpecs({
    slideSpecsPath: inputs.slideSpecsPath,
    themeLockPath: inputs.themeLockPath,
    statePath: path.join(projectWorkspace, "state.json"),
    outputPath,
    prospectiveDiffPreview,
    generatedAt: nextGeneratedAt(),
  });
  return { evidence, outputPath, inputs };
}

async function writePptxAudit(projectWorkspace, { deckPath } = {}) {
  const inputs = await ensureQualityInputs(projectWorkspace);
  const auditedDeckPath = deckPath || inputs.deckPath;
  const outputPath = path.join(projectWorkspace, "quality/pptx-audit.json");
  const checks = Object.fromEntries([
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
  ].map((id) => [id, { status: "PASS", value: 0, violations: [] }]));
  const evidence = {
    artifactType: "automatedEvidenceBundle",
    schemaVersion: "1.0.0",
    qualityContractVersion: "1.0.0",
    checker: { id: "audit-pptx-quality", version: "1.0.0" },
    inputHashes: {
      deck: await sha256File(auditedDeckPath),
      slideSpecs: await sha256File(inputs.slideSpecsPath),
      themeLock: await sha256File(inputs.themeLockPath),
      objectInventory: await sha256File(inputs.objectInventoryPath),
    },
    checks,
    finalVerdict: "PASS",
    generatedAt: nextGeneratedAt(),
  };
  await writeJsonAtomic(outputPath, evidence);
  return { evidence, outputPath, inputs };
}

async function writeStrictQaPass(projectWorkspace) {
  const state = await loadState(projectWorkspace);
  const auditPath = path.join(projectWorkspace, "quality/pptx-audit.json");
  const inputs = await ensureQualityInputs(projectWorkspace);
  const qaInputDir = path.join(projectWorkspace, "qa-inputs");
  const previewDir = path.join(projectWorkspace, "previews");
  await fs.mkdir(qaInputDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  const inputArtifactsPath = path.join(qaInputDir, "input-artifacts.json");
  const toolVersionsPath = path.join(qaInputDir, "tool-versions.json");
  const automatedChecksPath = path.join(qaInputDir, "automated-checks.json");
  const reviewChecksPath = path.join(qaInputDir, "review-checks.json");
  const manualScoresPath = path.join(qaInputDir, "manual-scores.json");
  const clientSmokePath = path.join(qaInputDir, "client-smoke.json");
  const slidePngPath = path.join(previewDir, "slide-1.png");
  const clientEvidencePath = path.join(qaInputDir, "client-smoke-evidence.json");
  await fs.writeFile(slidePngPath, pngBytes());

  await writeJsonAtomic(inputArtifactsPath, {
    deck: { path: inputs.deckPath },
    slideSpecs: { path: inputs.slideSpecsPath },
    themeLock: { path: inputs.themeLockPath },
  });
  await writeJsonAtomic(toolVersionsPath, { node: process.version });
  const inputHashes = {
    deck: await sha256File(inputs.deckPath),
    slideSpecs: await sha256File(inputs.slideSpecsPath),
    themeLock: await sha256File(inputs.themeLockPath),
  };
  const ooxmlCheckIds = new Set([
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
  ]);
  const requiredChecks = state.route === "edit"
    ? [...REQUIRED_AUTOMATED_CHECKS, ...EDIT_REQUIRED_CHECKS]
    : [...REQUIRED_AUTOMATED_CHECKS];
  const automatedChecks = [];
  for (const id of requiredChecks) {
    let evidencePath = auditPath;
    if (!ooxmlCheckIds.has(id)) {
      evidencePath = path.join(qaInputDir, `${id}.json`);
      await writeJsonAtomic(evidencePath, {
        artifactType: "perCheckEvidence",
        schemaVersion: "1.0.0",
        qualityContractVersion: "1.0.0",
        checker: { id, version: "1.0.0" },
        checkId: id,
        inputHashes,
        check: {
          status: "PASS",
          value: id === "pageCountAndCanvas" ? 1 : 0,
          violations: [],
        },
        finalVerdict: "PASS",
        generatedAt: nextGeneratedAt(),
      });
    }
    automatedChecks.push({ id, evidencePath });
  }
  await writeJsonAtomic(automatedChecksPath, automatedChecks);
  await writeJsonAtomic(reviewChecksPath, [{
      slide: 1,
      reviewer: "synthetic state test",
      evidencePath: slidePngPath,
      checks: {
        ...Object.fromEntries(REQUIRED_REVIEW_CHECKS.map((id) => [
          id,
          { status: "PASS", notes: `${id} reviewed on the full slide` },
        ])),
      },
    }]);
  await writeJsonAtomic(manualScoresPath, [{
      slide: 1,
      scores: Object.fromEntries(REQUIRED_MANUAL_DIMENSIONS.map((id) => [id, 5])),
      reviewer: "synthetic state test",
      evidencePath: slidePngPath,
    }]);
  await writeJsonAtomic(clientEvidencePath, {
    artifactType: "clientSmokeEvidence",
    schemaVersion: "1.0.0",
    targetClient: "Microsoft PowerPoint",
    observationMode: "gui-open",
    openedArtifactHash: inputHashes.deck,
    observations: {
      applicationWindowVisible: true,
      deckOpened: true,
      slideCanvasVisible: true,
    },
    observedAt: nextGeneratedAt(),
  });
  await writeJsonAtomic(clientSmokePath, {
    status: "passed",
    targetClient: "Microsoft PowerPoint",
    evidencePath: clientEvidencePath,
  });
  const outputPath = path.join(projectWorkspace, "qa-report.json");
  const report = await buildQaReport({
    projectId: state.projectId,
    route: state.route,
    inputArtifactsPath,
    toolVersionsPath,
    automatedChecksPath,
    reviewChecksPath,
    manualScoresPath,
    clientSmokePath,
    outputPath,
  });
  return { report, outputPath, inputs };
}

async function createAtVisualLocked(name, impactRoute = "create") {
  const projectWorkspace = await workspace(name);
  await initProject({ title: name, route: impactRoute, workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
  await transitionProject({ workspace: projectWorkspace, to: "OUTLINE_REVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "OUTLINE_APPROVED",
    approval: { approvedArtifactHash: APPROVAL_HASHES.outline },
  });
  await transitionProject({ workspace: projectWorkspace, to: "VISUAL_REVIEW" });
  const inputs = await ensureQualityInputs(projectWorkspace);
  await transitionProject({
    workspace: projectWorkspace,
    to: "VISUAL_LOCKED",
    approval: { approvedArtifactHash: inputs.visualContractHash },
  });
  return projectWorkspace;
}

async function createAtBuildingWithEvidence(name, impactRoute = "create") {
  const projectWorkspace = await createAtVisualLocked(name, impactRoute);
  await writePrebuildEvidence(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  return projectWorkspace;
}

async function createAtBuilding(name, impactRoute = "create") {
  return createAtBuildingWithEvidence(name, impactRoute);
}

async function editAtBuilding(name) {
  const projectWorkspace = await createEditAtChangePreview(name);
  const approval = { approvedArtifactHash: APPROVAL_HASHES.diffPreview };
  await writePrebuildEvidence(projectWorkspace, undefined, { prospectiveDiffPreview: approval });
  await transitionProject({
    workspace: projectWorkspace,
    to: "BUILDING",
    approval,
  });
  return projectWorkspace;
}

async function createEditAtChangePreview(name) {
  const projectWorkspace = await workspace(name);
  await initProject({ title: name, route: "edit", workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "COMPATIBILITY_REVIEW" });
  await transitionProject({ workspace: projectWorkspace, to: "SCOPE_REVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "SCOPE_APPROVED",
    approval: { approvedArtifactHash: APPROVAL_HASHES.scope },
  });
  await transitionProject({ workspace: projectWorkspace, to: "CHANGE_PREVIEW" });
  return projectWorkspace;
}

async function createAtQa(name) {
  const projectWorkspace = await createAtBuildingWithEvidence(name);
  await writePptxAudit(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "QA" });
  return projectWorkspace;
}

async function createAtFinalReview(name) {
  const projectWorkspace = await createAtQa(name);
  await writeStrictQaPass(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" });
  return projectWorkspace;
}

async function mutatePptxAfterAudit(projectWorkspace) {
  await fs.appendFile(path.join(projectWorkspace, "deck.pptx"), "stale after audit");
}

async function copyLegacyFixture(name) {
  const target = await workspace(name);
  const source = path.resolve("tests/fixtures/project-legacy");
  await fs.mkdir(target, { recursive: true });
  for (const relativePath of [
    "project-manifest.json",
    "state.json",
    "qa-report.json",
  ]) {
    await fs.copyFile(path.join(source, relativePath), path.join(target, relativePath));
  }
  const projectId = `ppt-${crypto.randomUUID()}`;
  const manifest = await loadManifest(target);
  const state = await loadState(target);
  const qaReport = await readJson(path.join(target, "qa-report.json"));
  manifest.projectId = projectId;
  manifest.workspace = target;
  state.projectId = projectId;
  qaReport.projectId = projectId;
  state.status = "FINAL_REVIEW";
  delete state.approvals.final;
  await saveManifest(target, manifest);
  await saveState(target, state);
  await writeJsonAtomic(path.join(target, "qa-report.json"), qaReport);
  return target;
}

function serializedJsonHash(value) {
  return `sha256:${crypto.createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    .digest("hex")}`;
}

async function adoptionJournalFixture(projectWorkspace, evidence) {
  const oldManifest = await loadManifest(projectWorkspace);
  const oldState = await loadState(projectWorkspace);
  const qualityGates = { prebuildEvidenceHash: serializedJsonHash(evidence) };
  const newManifest = {
    ...oldManifest,
    qualityContractVersion: "1.0.0",
    qualityGates,
  };
  const newState = {
    ...oldState,
    qualityContractVersion: "1.0.0",
    qualityGates,
  };
  const journal = {
    artifactType: "qualityAdoptionJournal",
    schemaVersion: "1.0.0",
    workspace: path.resolve(projectWorkspace),
    projectId: oldState.projectId,
    old: {
      manifest: oldManifest,
      state: oldState,
      prebuildEvidence: null,
    },
    new: {
      manifest: newManifest,
      state: newState,
      prebuildEvidence: evidence,
    },
  };
  return { journal, oldManifest, oldState, newManifest, newState };
}

async function journalTestFixture(name) {
  const projectWorkspace = await copyLegacyFixture(name);
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  const { evidence } = await writePrebuildEvidence(projectWorkspace, evidencePath);
  const fixture = await adoptionJournalFixture(projectWorkspace, evidence);
  await writeJsonAtomic(path.join(projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  return { projectWorkspace, evidence, ...fixture };
}

async function assertJournalRejectedWithoutWrites(projectWorkspace, pattern) {
  const before = await workspaceSnapshot(projectWorkspace);
  await assert.rejects(validateProject(projectWorkspace), pattern);
  assert.deepEqual(await workspaceSnapshot(projectWorkspace), before);
}

test("initProject writes a valid manifest, state, and temporary CODEX_HOME index", async () => {
  const projectWorkspace = await workspace("init-create");
  const result = await initProject({
    title: "中性创建路线",
    route: "create",
    workspace: projectWorkspace,
  });

  const manifest = await readJson(path.join(projectWorkspace, "project-manifest.json"));
  const state = await loadState(projectWorkspace);
  assert.equal(manifest.projectId, result.projectId);
  assert.equal(state.projectId, result.projectId);
  assert.equal(state.status, "INTAKE");
  assert.equal(manifest.qualityContractVersion, "1.0.0");
  assert.deepEqual(manifest.qualityGates, {});
  assert.equal(state.qualityContractVersion, "1.0.0");
  assert.deepEqual(state.qualityGates, {});
  assert.equal((await validateProject(projectWorkspace)).valid, true);

  const index = await readJson(
    path.join(process.env.CODEX_HOME, "visual-first-ppt", "projects.json"),
  );
  assert.ok(index.projects.some((entry) => entry.projectId === result.projectId));
  assert.ok(index.projects.every((entry) => entry.workspace.startsWith(sandboxRoot)));
});

test("create route rejects skips and accepts INTAKE to SOURCE_READY", async () => {
  const projectWorkspace = await workspace("create-transitions");
  await initProject({ title: "创建路线", route: "create", workspace: projectWorkspace });

  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /Invalid transition/,
  );
  await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
  assert.equal((await loadState(projectWorkspace)).status, "SOURCE_READY");
});

test("outline and visual gates require approval artifact hashes", async () => {
  const projectWorkspace = await workspace("approval-gates-create");
  await initProject({ title: "审批门禁", route: "create", workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
  await transitionProject({ workspace: projectWorkspace, to: "OUTLINE_REVIEW" });

  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "OUTLINE_APPROVED" }),
    /approval artifact hash/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "OUTLINE_APPROVED",
    approval: { approvedArtifactHash: APPROVAL_HASHES.outline },
  });
  await transitionProject({ workspace: projectWorkspace, to: "VISUAL_REVIEW" });
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "VISUAL_LOCKED" }),
    /approval artifact hash/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "VISUAL_LOCKED",
    approval: { approvedArtifactHash: APPROVAL_HASHES.visual },
  });

  const state = await loadState(projectWorkspace);
  assert.equal(state.status, "VISUAL_LOCKED");
  assert.equal(state.approvals.outline.approvedArtifactHash, APPROVAL_HASHES.outline);
  assert.equal(state.approvals.visual.approvedArtifactHash, APPROVAL_HASHES.visual);
});

test("outline visual scope and final transitions reject non-canonical approval hashes without writes", async (t) => {
  const malformedHashes = [
    "sha256:short",
    `sha256:${"A".repeat(64)}`,
    ` ${APPROVAL_HASHES.outline} `,
    42,
  ];

  await t.test("outline", async () => {
    const projectWorkspace = await workspace("strict-approval-outline");
    await initProject({ title: "大纲审批哈希", route: "create", workspace: projectWorkspace });
    await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
    await transitionProject({ workspace: projectWorkspace, to: "OUTLINE_REVIEW" });
    for (const approvedArtifactHash of malformedHashes) {
      await assertRejectedTransitionPreservesWorkspace({
        projectWorkspace,
        to: "OUTLINE_APPROVED",
        approval: { approvedArtifactHash },
      });
    }
    await transitionProject({
      workspace: projectWorkspace,
      to: "OUTLINE_APPROVED",
      approval: { approvedArtifactHash: APPROVAL_HASHES.outline },
    });
  });

  await t.test("visual", async () => {
    const projectWorkspace = await workspace("strict-approval-visual");
    await initProject({ title: "视觉审批哈希", route: "create", workspace: projectWorkspace });
    await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
    await transitionProject({ workspace: projectWorkspace, to: "OUTLINE_REVIEW" });
    await transitionProject({
      workspace: projectWorkspace,
      to: "OUTLINE_APPROVED",
      approval: { approvedArtifactHash: APPROVAL_HASHES.outline },
    });
    await transitionProject({ workspace: projectWorkspace, to: "VISUAL_REVIEW" });
    for (const approvedArtifactHash of malformedHashes) {
      await assertRejectedTransitionPreservesWorkspace({
        projectWorkspace,
        to: "VISUAL_LOCKED",
        approval: { approvedArtifactHash },
      });
    }
    await transitionProject({
      workspace: projectWorkspace,
      to: "VISUAL_LOCKED",
      approval: { approvedArtifactHash: APPROVAL_HASHES.visual },
    });
  });

  await t.test("scope", async () => {
    const projectWorkspace = await workspace("strict-approval-scope");
    await initProject({ title: "范围审批哈希", route: "edit", workspace: projectWorkspace });
    await transitionProject({ workspace: projectWorkspace, to: "COMPATIBILITY_REVIEW" });
    await transitionProject({ workspace: projectWorkspace, to: "SCOPE_REVIEW" });
    for (const approvedArtifactHash of malformedHashes) {
      await assertRejectedTransitionPreservesWorkspace({
        projectWorkspace,
        to: "SCOPE_APPROVED",
        approval: { approvedArtifactHash },
      });
    }
    await transitionProject({
      workspace: projectWorkspace,
      to: "SCOPE_APPROVED",
      approval: { approvedArtifactHash: APPROVAL_HASHES.scope },
    });
  });

  await t.test("final", async () => {
    const projectWorkspace = await createAtFinalReview("strict-approval-final");
    for (const approvedArtifactHash of malformedHashes) {
      await assertRejectedTransitionPreservesWorkspace({
        projectWorkspace,
        to: "DELIVERED",
        approval: { approvedArtifactHash },
      });
    }
  });
});

test("edit scope and diff-preview gates require explicit evidence", async () => {
  const projectWorkspace = await workspace("approval-gates-edit");
  await initProject({ title: "编辑门禁", route: "edit", workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "COMPATIBILITY_REVIEW" });
  await transitionProject({ workspace: projectWorkspace, to: "SCOPE_REVIEW" });

  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "SCOPE_APPROVED" }),
    /approval artifact hash/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "SCOPE_APPROVED",
    approval: { approvedArtifactHash: APPROVAL_HASHES.scope },
  });
  await transitionProject({ workspace: projectWorkspace, to: "CHANGE_PREVIEW" });
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /diff-preview approval/i,
  );
  const notApplicableApproval = {
    notApplicableReason: "  纯文本错别字修正，  无视觉差异预览  ",
  };
  await writePrebuildEvidence(projectWorkspace, undefined, {
    prospectiveDiffPreview: notApplicableApproval,
  });
  await transitionProject({
    workspace: projectWorkspace,
    to: "BUILDING",
    approval: { notApplicableReason: "纯文本错别字修正， 无视觉差异预览" },
  });

  const state = await loadState(projectWorkspace);
  assert.equal(state.status, "BUILDING");
  assert.equal(state.approvals.diffPreview.notApplicableReason.length > 0, true);
});

test("delivery requires final approval, QA PASS, and a persistent final output", async () => {
  const projectWorkspace = await createAtFinalReview("delivery-gate");
  const deckHash = await sha256File(path.join(projectWorkspace, "deck.pptx"));

  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "DELIVERED" }),
    /approval artifact hash/i,
  );
  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: { approvedArtifactHash: deckHash },
    }),
    /finalOutputRoot/i,
  );

  const temporaryOutput = path.join(projectWorkspace, "final.pptx");
  await fs.writeFile(temporaryOutput, "temporary final output");
  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: {
        approvedArtifactHash: deckHash,
        finalOutputRoot: projectWorkspace,
        finalOutputPath: temporaryOutput,
      },
    }),
    /temporary/i,
  );

  const persistentOutput = path.resolve("tests/fixtures/baseline/edit-source.pptx");
  const persistentRoot = path.resolve("tests/fixtures/baseline");
  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: {
        approvedArtifactHash: deckHash,
        finalOutputRoot: path.resolve("tests/fixtures/project-valid"),
        finalOutputPath: persistentOutput,
      },
    }),
    /outside/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "DELIVERED",
    approval: {
      approvedArtifactHash: deckHash,
      finalOutputRoot: persistentRoot,
      finalOutputPath: persistentOutput,
    },
  });
  assert.equal((await loadState(projectWorkspace)).status, "DELIVERED");
  const manifest = await readJson(path.join(projectWorkspace, "project-manifest.json"));
  assert.equal(manifest.finalOutputRoot, persistentRoot);
  assert.equal(manifest.finalOutputPath, persistentOutput);
  assert.equal((await validateProject(projectWorkspace)).valid, true);
});

test("VISUAL_LOCKED cannot enter BUILDING without current prebuild evidence", async () => {
  const projectWorkspace = await createAtVisualLocked("missing-prebuild");
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /prebuild.*PASS/i,
  );
});

test("ordinary prebuild gate recomputes the deterministic producer output", async (t) => {
  await t.test("invalid slide specs cannot use a forged all-zero PASS", async () => {
    const projectWorkspace = await createAtVisualLocked("forged-pass-invalid-slide-specs");
    const { evidence, outputPath, inputs } = await writePrebuildEvidence(projectWorkspace);
    const slideSpecs = await readJson(inputs.slideSpecsPath);
    slideSpecs.slides[0].typographyBudget.body.minimumPt = 17;
    await writeJsonAtomic(inputs.slideSpecsPath, slideSpecs);
    evidence.inputHashes.slideSpecs = await sha256File(inputs.slideSpecsPath);
    await writeJsonAtomic(outputPath, evidence);
    await assert.rejects(
      transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
      /body.*18pt|TYPOGRAPHY_FLOOR|deterministic.*prebuild/i,
    );
  });

  await t.test("invalid font mode cannot use a forged all-zero PASS", async () => {
    const projectWorkspace = await createAtVisualLocked("forged-pass-invalid-font-mode");
    const { evidence, outputPath, inputs } = await writePrebuildEvidence(projectWorkspace);
    const themeLock = await readJson(inputs.themeLockPath);
    themeLock.fontResolutionMode = "source-template";
    themeLock.templatePath = "forged-template.pptx";
    themeLock.templateHash = `sha256:${"e".repeat(64)}`;
    const renewedVisualHash = expectedVisualContractHash(themeLock);
    themeLock.approval.approvedArtifactHash = renewedVisualHash;
    await writeJsonAtomic(inputs.themeLockPath, themeLock);
    const state = await loadState(projectWorkspace);
    state.approvals.visual.approvedArtifactHash = renewedVisualHash;
    await saveState(projectWorkspace, state);
    evidence.inputHashes.themeLock = await sha256File(inputs.themeLockPath);
    evidence.approvalHashes.visual = renewedVisualHash;
    await writeJsonAtomic(outputPath, evidence);
    await assert.rejects(
      transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
      /create.*theme-catalog|fontResolutionMode|deterministic.*prebuild/i,
    );
  });

  await t.test("PASS evidence cannot carry a nonzero violation count", async () => {
    const projectWorkspace = await createAtVisualLocked("forged-pass-nonzero-count");
    const { evidence, outputPath } = await writePrebuildEvidence(projectWorkspace);
    evidence.violationCounts.typography = 1;
    await writeJsonAtomic(outputPath, evidence);
    await assert.rejects(
      transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
      /violationCounts|typography|schema validation/i,
    );
  });

  await t.test("create cannot forge away the required outline approval", async () => {
    const projectWorkspace = await createAtVisualLocked("forged-pass-missing-outline");
    const { evidence, outputPath } = await writePrebuildEvidence(projectWorkspace);
    const state = await loadState(projectWorkspace);
    delete state.approvals.outline;
    await saveState(projectWorkspace, state);
    delete evidence.approvalHashes.outline;
    await writeJsonAtomic(outputPath, evidence);
    await assert.rejects(
      transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
      /outline.*approval.*required|requires.*outline|deterministic.*prebuild/i,
    );
  });

  await t.test("edit cannot forge away the required scope approval", async () => {
    const projectWorkspace = await createEditAtChangePreview("forged-pass-missing-scope");
    const approval = { approvedArtifactHash: APPROVAL_HASHES.diffPreview };
    const { evidence, outputPath } = await writePrebuildEvidence(
      projectWorkspace,
      undefined,
      { prospectiveDiffPreview: approval },
    );
    const state = await loadState(projectWorkspace);
    delete state.approvals.scope;
    await saveState(projectWorkspace, state);
    delete evidence.approvalHashes.scope;
    await writeJsonAtomic(outputPath, evidence);
    await assert.rejects(
      transitionProject({ workspace: projectWorkspace, to: "BUILDING", approval }),
      /scope.*approval.*required|requires.*scope|deterministic.*prebuild/i,
    );
  });
});

test("BUILDING cannot enter QA with a stale pptx audit hash", async () => {
  const projectWorkspace = await createAtBuildingWithEvidence("stale-audit");
  await writePptxAudit(projectWorkspace);
  await mutatePptxAfterAudit(projectWorkspace);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "QA" }),
    /pptx.*hash|stale.*audit/i,
  );
});

test("QA cannot enter FINAL_REVIEW before a current QA PASS", async () => {
  const projectWorkspace = await createAtQa("missing-qa-pass");
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /QA PASS/i,
  );
});

test("current QA rejects a legacy client descriptor without an evidence hash", async () => {
  const projectWorkspace = await createAtQa("legacy-client-descriptor-in-current-qa");
  const { report, outputPath } = await writeStrictQaPass(projectWorkspace);
  report.clientSmoke = {
    status: "passed",
    evidencePath: report.automatedChecks[0].evidencePath,
    userFinalOpenConfirmation: false,
  };
  await writeJsonAtomic(outputPath, report);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /qaReportCurrent.*clientSmoke|current.*client.*descriptor|evidenceSha256/i,
  );
});

test("current QA rejects passed client evidence without observationMode", async () => {
  const projectWorkspace = await createAtQa("missing-current-client-observation-mode");
  const { report, outputPath } = await writeStrictQaPass(projectWorkspace);
  delete report.clientSmoke.observationMode;
  await writeJsonAtomic(outputPath, report);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /qaReportCurrent.*clientSmoke|observationMode/i,
  );
});

test("current QA verifies every descriptor evidence path and hash before FINAL_REVIEW", async (t) => {
  const cases = ["automated", "review", "manual", "client"];
  for (const kind of cases) {
    await t.test(kind, async () => {
      const projectWorkspace = await createAtQa(`stale-current-${kind}-evidence-hash`);
      const { report, outputPath } = await writeStrictQaPass(projectWorkspace);
      const staleHash = `sha256:${"e".repeat(64)}`;
      if (kind === "automated") {
        report.automatedChecks[0].evidenceSha256 = staleHash;
      } else if (kind === "review") {
        report.reviewChecks[0].evidenceSha256 = staleHash;
      } else if (kind === "manual") {
        report.perSlideManualScores[0].evidenceSha256 = staleHash;
      } else {
        report.clientSmoke.evidenceSha256 = staleHash;
      }
      await writeJsonAtomic(outputPath, report);
      await assert.rejects(
        transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
        new RegExp(`${kind}.*evidence.*(?:hash|stale)|evidence.*${kind}.*(?:hash|stale)`, "i"),
      );
    });
  }
});

test("QA to FINAL_REVIEW reuses shared preflight and rejects an extra automated ID", async () => {
  const projectWorkspace = await createAtQa("qa-extra-automated-id");
  const { report, outputPath } = await writeStrictQaPass(projectWorkspace);
  report.automatedChecks.push({
    ...report.automatedChecks[0],
    id: "nonContractExtraCheck",
  });
  await writeJsonAtomic(outputPath, report);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /unexpected|exact.*automated|required automated/i,
  );
});

test("validateProject revalidates QA and its reviewed hash in FINAL_REVIEW", async () => {
  const projectWorkspace = await createAtFinalReview("validate-final-review-qa-hash");
  assert.equal((await validateProject(projectWorkspace)).valid, true);
  const qaPath = path.join(projectWorkspace, "qa-report.json");
  const report = await readJson(qaPath);
  report.generatedAt = "2026-07-20T00:00:00.000Z";
  await writeJsonAtomic(qaPath, report);
  await assert.rejects(
    validateProject(projectWorkspace),
    /FINAL_REVIEW.*QA report hash|QA report hash.*stale|not reviewed/i,
  );
});

test("project-state directly imports and invokes the shared current QA preflight", async () => {
  const source = await fs.readFile(
    path.resolve("skills/visual-first-ppt/scripts/project-state.mjs"),
    "utf8",
  );
  assert.match(source, /from\s+"\.\/lib\/current-qa\.mjs"/);
  assert.match(source, /validateCurrentQaReport\s*\(/);
});

test("current QA cannot enter FINAL_REVIEW without client evidence", async () => {
  const projectWorkspace = await createAtQa("missing-current-client-evidence");
  const { report, outputPath } = await writeStrictQaPass(projectWorkspace);
  delete report.clientSmoke;
  await writeJsonAtomic(outputPath, report);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /qaReportCurrent|current.*QA|clientSmoke|client evidence/i,
  );
});

test("an incomplete current QA report cannot authorize DELIVERED even with a forged review hash", async () => {
  const projectWorkspace = await createAtFinalReview("incomplete-current-delivery-gate");
  const reportPath = path.join(projectWorkspace, "qa-report.json");
  const report = await readJson(reportPath);
  delete report.clientSmoke;
  await writeJsonAtomic(reportPath, report);
  const forgedQaHash = await sha256File(reportPath);
  const state = await loadState(projectWorkspace);
  const manifest = await loadManifest(projectWorkspace);
  state.qualityGates.qaReportHash = forgedQaHash;
  manifest.qualityGates.qaReportHash = forgedQaHash;
  await saveState(projectWorkspace, state);
  await saveManifest(projectWorkspace, manifest);

  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: { approvedArtifactHash: report.inputHashes.deck },
    }),
    /qaReportCurrent|current.*QA|clientSmoke|client evidence/i,
  );
});

test("changing a reviewed client evidence hash descriptor invalidates the state QA hash", async () => {
  const projectWorkspace = await createAtFinalReview("stale-client-evidence-descriptor");
  const reportPath = path.join(projectWorkspace, "qa-report.json");
  const report = await readJson(reportPath);
  report.generatedAt = "2026-07-20T00:00:00.000Z";
  await writeJsonAtomic(reportPath, report);
  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: { approvedArtifactHash: report.inputHashes.deck },
    }),
    /QA report hash is stale|QA.*stale|reviewed/i,
  );
});

test("legacy project is readable but cannot rebuild until adopt-quality", async () => {
  const projectWorkspace = await copyLegacyFixture("legacy-rebuild");
  const state = await loadState(projectWorkspace);
  state.status = "QA";
  await saveState(projectWorkspace, state);
  assert.equal((await validateProject(projectWorkspace)).valid, true);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /adopt-quality|quality contract/i,
  );
});

test("quality gates advance only with current evidence and repaired builds clear downstream gates", async () => {
  const projectWorkspace = await createAtBuildingWithEvidence("quality-gates");
  let state = await loadState(projectWorkspace);
  assert.equal(state.qualityGates.prebuildEvidenceHash, await sha256File(
    path.join(projectWorkspace, "quality/prebuild-evidence.json"),
  ));

  await writePptxAudit(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "QA" });
  state = await loadState(projectWorkspace);
  assert.equal(state.qualityGates.pptxAuditHash, await sha256File(
    path.join(projectWorkspace, "quality/pptx-audit.json"),
  ));
  assert.equal(state.qualityGates.deckHash, await sha256File(path.join(projectWorkspace, "deck.pptx")));

  await writeStrictQaPass(projectWorkspace);
  const qaHash = await sha256File(path.join(projectWorkspace, "qa-report.json"));
  const manifest = await loadManifest(projectWorkspace);
  state.qualityGates.qaReportHash = qaHash;
  manifest.qualityGates.qaReportHash = qaHash;
  await saveState(projectWorkspace, state);
  await saveManifest(projectWorkspace, manifest);
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  state = await loadState(projectWorkspace);
  assert.deepEqual(state.qualityGates, {
    prebuildEvidenceHash: await sha256File(path.join(
      projectWorkspace,
      "quality/prebuild-evidence.json",
    )),
    invalidatedPptxAuditHashes: [await sha256File(path.join(
      projectWorkspace,
      "quality/pptx-audit.json",
    ))],
    invalidatedQaReportHashes: [qaHash],
  });
  assert.deepEqual((await loadManifest(projectWorkspace)).qualityGates, state.qualityGates);
});

test("repair cannot reuse the previous PPTX audit bytes", async () => {
  const projectWorkspace = await createAtQa("repair-reuses-audit");
  const oldAuditHash = await sha256File(path.join(projectWorkspace, "quality/pptx-audit.json"));
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  const gates = (await loadState(projectWorkspace)).qualityGates;
  assert.deepEqual(gates.invalidatedPptxAuditHashes, [oldAuditHash]);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "QA" }),
    /invalidated.*audit|regenerate.*audit|audit.*tombstone/i,
  );
});

test("repair cannot reuse old QA after regenerating only the PPTX audit", async () => {
  const projectWorkspace = await createAtFinalReview("repair-reuses-qa");
  const oldQaHash = await sha256File(path.join(projectWorkspace, "qa-report.json"));
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  await writePptxAudit(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "QA" });
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" }),
    /invalidated.*QA|regenerate.*QA|QA.*tombstone/i,
  );
  assert.ok((await loadState(projectWorkspace)).qualityGates.invalidatedQaReportHashes
    .includes(oldQaHash));
});

test("audit and QA tombstones persist across consecutive repair rounds", async () => {
  const projectWorkspace = await createAtFinalReview("consecutive-repairs");
  const firstAuditHash = await sha256File(path.join(projectWorkspace, "quality/pptx-audit.json"));
  const firstQaHash = await sha256File(path.join(projectWorkspace, "qa-report.json"));
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  await writePptxAudit(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "QA" });
  await writeStrictQaPass(projectWorkspace);
  await transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" });
  const secondAuditHash = await sha256File(path.join(projectWorkspace, "quality/pptx-audit.json"));
  const secondQaHash = await sha256File(path.join(projectWorkspace, "qa-report.json"));
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  const gates = (await loadState(projectWorkspace)).qualityGates;
  assert.deepEqual(gates.invalidatedPptxAuditHashes, [firstAuditHash, secondAuditHash]);
  assert.deepEqual(gates.invalidatedQaReportHashes, [firstQaHash, secondQaHash]);
  assert.equal(new Set(gates.invalidatedPptxAuditHashes).size, 2);
  assert.equal(new Set(gates.invalidatedQaReportHashes).size, 2);
});

test("prebuild evidence becomes stale after input or approval changes", async () => {
  const inputWorkspace = await createAtVisualLocked("stale-prebuild-input");
  await writePrebuildEvidence(inputWorkspace);
  await fs.appendFile(path.join(inputWorkspace, "slide-specs.json"), "\n");
  await assert.rejects(
    transitionProject({ workspace: inputWorkspace, to: "BUILDING" }),
    /prebuild.*hash|input.*hash/i,
  );

  const approvalWorkspace = await createAtVisualLocked("stale-prebuild-approval");
  await writePrebuildEvidence(approvalWorkspace);
  const state = await loadState(approvalWorkspace);
  state.approvals.visual.approvedArtifactHash = "sha256:changed-visual";
  await saveState(approvalWorkspace, state);
  await assert.rejects(
    transitionProject({ workspace: approvalWorkspace, to: "BUILDING" }),
    /prebuild.*approval|approval.*hash/i,
  );

  const fontWorkspace = await createAtVisualLocked("stale-prebuild-font-evidence");
  const { inputs } = await writePrebuildEvidence(fontWorkspace);
  const fontEvidence = await readJson(inputs.fontEvidencePath);
  await fs.writeFile(inputs.fontEvidencePath, JSON.stringify(fontEvidence));
  await assert.rejects(
    transitionProject({ workspace: fontWorkspace, to: "BUILDING" }),
    /prebuild font evidence input hash is stale/i,
  );
});

test("rewriting prebuild hashes cannot reuse a visual approval after a locked font changes", async () => {
  const projectWorkspace = await createAtVisualLocked("visual-contract-font-change");
  const { evidence, outputPath, inputs } = await writePrebuildEvidence(projectWorkspace);
  const themeLock = await readJson(inputs.themeLockPath);
  const originalVisualHash = themeLock.approval.approvedArtifactHash;
  themeLock.resolvedFonts.latin = "Arial";
  await writeJsonAtomic(inputs.themeLockPath, themeLock);
  const fontEvidence = await readJson(inputs.fontEvidencePath);
  fontEvidence.resolvedFonts.latin = "Arial";
  await writeJsonAtomic(inputs.fontEvidencePath, fontEvidence);

  evidence.inputHashes.themeLock = await sha256File(inputs.themeLockPath);
  evidence.inputHashes.fontEvidence = await sha256File(inputs.fontEvidencePath);
  evidence.approvalHashes.visual = originalVisualHash;
  await writeJsonAtomic(outputPath, evidence);
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /visual contract|visual approval|approvedArtifactHash/i,
  );

  const renewedVisualHash = expectedVisualContractHash(themeLock);
  themeLock.approval.approvedArtifactHash = renewedVisualHash;
  await writeJsonAtomic(inputs.themeLockPath, themeLock);
  const state = await loadState(projectWorkspace);
  state.approvals.visual.approvedArtifactHash = renewedVisualHash;
  await saveState(projectWorkspace, state);
  evidence.inputHashes.themeLock = await sha256File(inputs.themeLockPath);
  evidence.approvalHashes.visual = renewedVisualHash;
  await writeJsonAtomic(outputPath, evidence);

  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  assert.equal((await loadState(projectWorkspace)).status, "BUILDING");
});

test("ordinary prebuild gate rejects empty and directory font evidence", async () => {
  const emptyWorkspace = await createAtVisualLocked("prebuild-empty-font-evidence");
  const empty = await writePrebuildEvidence(emptyWorkspace);
  await fs.writeFile(empty.inputs.fontEvidencePath, "");
  await assert.rejects(
    transitionProject({ workspace: emptyWorkspace, to: "BUILDING" }),
    /prebuild.*font(?: evidence|EvidencePath).*nonempty.*ordinary file/i,
  );

  const directoryWorkspace = await createAtVisualLocked("prebuild-directory-font-evidence");
  const directory = await writePrebuildEvidence(directoryWorkspace);
  const directoryPath = path.join(directoryWorkspace, "font-evidence-directory");
  await fs.mkdir(directoryPath);
  const themeLock = await readJson(directory.inputs.themeLockPath);
  themeLock.fontEvidencePath = path.basename(directoryPath);
  await writeJsonAtomic(directory.inputs.themeLockPath, themeLock);
  directory.evidence.inputHashes.themeLock = await sha256File(directory.inputs.themeLockPath);
  directory.evidence.inputHashes.fontEvidence = `sha256:${"f".repeat(64)}`;
  await writeJsonAtomic(directory.outputPath, directory.evidence);
  await assert.rejects(
    transitionProject({ workspace: directoryWorkspace, to: "BUILDING" }),
    /prebuild.*font(?: evidence|EvidencePath).*nonempty.*ordinary file/i,
  );
});

test("edit prebuild evidence must bind the prospective diff-preview approval", async () => {
  const missingWorkspace = await createEditAtChangePreview("diff-preview-missing-binding");
  await assert.rejects(
    writePrebuildEvidence(missingWorkspace),
    /diff-preview.*(?:required|requires)|diffPreview.*prebuild/i,
  );

  const changedWorkspace = await createEditAtChangePreview("diff-preview-changed-binding");
  await writePrebuildEvidence(changedWorkspace, undefined, {
    prospectiveDiffPreview: { approvedArtifactHash: APPROVAL_HASHES.diffPreview },
  });
  await assert.rejects(
    transitionProject({
      workspace: changedWorkspace,
      to: "BUILDING",
      approval: { approvedArtifactHash: APPROVAL_HASHES.changedDiffPreview },
    }),
    /diffPreview.*prebuild|prebuild.*diff-preview|approval.*hash/i,
  );

  const wrongNWorkspace = await createEditAtChangePreview("diff-preview-na-wrong-binding");
  await writePrebuildEvidence(wrongNWorkspace, undefined, {
    prospectiveDiffPreview: { notApplicableReason: "只改文案" },
  });
  await assert.rejects(
    transitionProject({
      workspace: wrongNWorkspace,
      to: "BUILDING",
      approval: { notApplicableReason: "改动视觉布局" },
    }),
    /diffPreview.*prebuild|prebuild.*diff-preview|approval.*hash/i,
  );
});

test("public prebuild producer and state transition share prospective diff-preview semantics", async (t) => {
  for (const [label, approval] of [
    ["approved artifact hash", { approvedArtifactHash: APPROVAL_HASHES.diffPreview }],
    ["normalized not-applicable reason", { notApplicableReason: "  只改文案，   无视觉差异  " }],
  ]) {
    await t.test(label, async () => {
      const projectWorkspace = await createEditAtChangePreview(`producer-${label.replaceAll(" ", "-")}`);
      const inputs = await ensureQualityInputs(projectWorkspace);
      const outputPath = path.join(projectWorkspace, "quality/prebuild-evidence.json");
      const evidence = await validateSlideSpecs({
        slideSpecsPath: inputs.slideSpecsPath,
        themeLockPath: inputs.themeLockPath,
        statePath: path.join(projectWorkspace, "state.json"),
        outputPath,
        prospectiveDiffPreview: approval,
      });
      assert.equal(evidence.approvalHashes.diffPreview, diffPreviewBinding(approval));
      await transitionProject({
        workspace: projectWorkspace,
        to: "BUILDING",
        approval: label === "normalized not-applicable reason"
          ? { notApplicableReason: "只改文案， 无视觉差异" }
          : approval,
      });
      assert.equal((await loadState(projectWorkspace)).status, "BUILDING");
    });
  }

  const createWorkspace = await createAtVisualLocked("producer-rejects-prospective-on-create");
  const createInputs = await ensureQualityInputs(createWorkspace);
  await assert.rejects(
    validateSlideSpecs({
      slideSpecsPath: createInputs.slideSpecsPath,
      themeLockPath: createInputs.themeLockPath,
      statePath: path.join(createWorkspace, "state.json"),
      outputPath: path.join(createWorkspace, "quality/prebuild-evidence.json"),
      prospectiveDiffPreview: { approvedArtifactHash: APPROVAL_HASHES.diffPreview },
    }),
    /prospectiveDiffPreview.*edit.*CHANGE_PREVIEW/i,
  );
});

test("current deck identity is fixed to workspace deck.pptx", async () => {
  const standardWorkspace = await createAtBuildingWithEvidence("standard-deck-with-old-copy");
  await fs.copyFile(
    path.join(standardWorkspace, "deck.pptx"),
    path.join(standardWorkspace, "old-output.pptx"),
  );
  await writePptxAudit(standardWorkspace);
  await transitionProject({ workspace: standardWorkspace, to: "QA" });
  assert.equal((await loadState(standardWorkspace)).status, "QA");

  const nonstandardWorkspace = await createAtBuildingWithEvidence("nonstandard-current-deck");
  const nonstandardDeck = path.join(nonstandardWorkspace, "new-output.pptx");
  await fs.writeFile(nonstandardDeck, "new nonstandard deck bytes");
  await writePptxAudit(nonstandardWorkspace, { deckPath: nonstandardDeck });
  await assert.rejects(
    transitionProject({ workspace: nonstandardWorkspace, to: "QA" }),
    /deck\.pptx|current PPTX.*hash/i,
  );

  const missingWorkspace = await createAtBuildingWithEvidence("missing-standard-deck");
  const archivedDeck = path.join(missingWorkspace, "archive/old-deck.pptx");
  await fs.mkdir(path.dirname(archivedDeck), { recursive: true });
  await fs.rename(path.join(missingWorkspace, "deck.pptx"), archivedDeck);
  await writePptxAudit(missingWorkspace, { deckPath: archivedDeck });
  await fs.rename(
    path.join(missingWorkspace, "deck.pptx"),
    path.join(missingWorkspace, "archive/recreated-root-copy.pptx"),
  );
  await assert.rejects(
    transitionProject({ workspace: missingWorkspace, to: "QA" }),
    /deck\.pptx.*(missing|does not exist)|current PPTX/i,
  );
});

test("adopt-quality explicitly migrates current legacy evidence", async () => {
  const projectWorkspace = await copyLegacyFixture("legacy-adopt");
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  await writePrebuildEvidence(projectWorkspace, evidencePath);
  const script = path.resolve("skills/visual-first-ppt/scripts/project-state.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "adopt-quality",
    projectWorkspace,
    evidencePath,
  ], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const state = await loadState(projectWorkspace);
  const manifest = await loadManifest(projectWorkspace);
  assert.equal(state.qualityContractVersion, "1.0.0");
  assert.equal(manifest.qualityContractVersion, "1.0.0");
  assert.equal(state.qualityGates.prebuildEvidenceHash, await sha256File(
    path.join(projectWorkspace, "quality/prebuild-evidence.json"),
  ));
  assert.deepEqual(manifest.qualityGates, state.qualityGates);
});

test("adopt-quality rolls back manifest, state, and canonical evidence on second-write failure", async () => {
  const projectWorkspace = await copyLegacyFixture("legacy-adopt-second-write-failure");
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  await writePrebuildEvidence(projectWorkspace, evidencePath);
  const oldManifest = await loadManifest(projectWorkspace);
  const oldState = await loadState(projectWorkspace);
  assert.equal(typeof projectStateModule.adoptQualityContract, "function");
  await assert.rejects(
    projectStateModule.adoptQualityContract({
      workspace: projectWorkspace,
      prebuildEvidencePath: evidencePath,
      testHooks: {
        beforeStateWrite() {
          throw new Error("injected second write failure");
        },
      },
    }),
    /injected second write failure/,
  );
  assert.deepEqual(await loadManifest(projectWorkspace), oldManifest);
  assert.deepEqual(await loadState(projectWorkspace), oldState);
  await assert.rejects(
    fs.access(path.join(projectWorkspace, "quality/prebuild-evidence.json")),
    /ENOENT/,
  );
  await assert.rejects(fs.access(path.join(projectWorkspace, ADOPTION_JOURNAL)), /ENOENT/);
});

test("readProject rolls back an interrupted adoption journal before validating", async () => {
  const projectWorkspace = await copyLegacyFixture("legacy-adopt-interrupted");
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  const { evidence } = await writePrebuildEvidence(projectWorkspace, evidencePath);
  const fixture = await adoptionJournalFixture(projectWorkspace, evidence);
  await writeJsonAtomic(path.join(projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  await writeJsonAtomic(path.join(projectWorkspace, "quality/prebuild-evidence.json"), evidence);
  await saveManifest(projectWorkspace, fixture.newManifest);

  await assert.rejects(
    validateProject(projectWorkspace),
    /qaReportCurrent|legacy QA is read-only/i,
  );
  assert.deepEqual(await loadManifest(projectWorkspace), fixture.oldManifest);
  assert.deepEqual(await loadState(projectWorkspace), fixture.oldState);
  await assert.rejects(
    fs.access(path.join(projectWorkspace, "quality/prebuild-evidence.json")),
    /ENOENT/,
  );
  await assert.rejects(fs.access(path.join(projectWorkspace, ADOPTION_JOURNAL)), /ENOENT/);
});

test("readProject completes an adoption when both files already match the journal new state", async () => {
  const projectWorkspace = await copyLegacyFixture("legacy-adopt-complete-journal");
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  const { evidence } = await writePrebuildEvidence(projectWorkspace, evidencePath);
  const fixture = await adoptionJournalFixture(projectWorkspace, evidence);
  await writeJsonAtomic(path.join(projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  await writeJsonAtomic(path.join(projectWorkspace, "quality/prebuild-evidence.json"), evidence);
  await saveManifest(projectWorkspace, fixture.newManifest);
  await saveState(projectWorkspace, fixture.newState);

  await assert.rejects(
    validateProject(projectWorkspace),
    /qaReportCurrent|legacy QA is read-only/i,
  );
  assert.deepEqual(await loadManifest(projectWorkspace), fixture.newManifest);
  assert.deepEqual(await loadState(projectWorkspace), fixture.newState);
  await assert.rejects(fs.access(path.join(projectWorkspace, ADOPTION_JOURNAL)), /ENOENT/);
});

test("adoption recovery rejects malformed journal snapshots without writing", async (t) => {
  await t.test("malformed old snapshot", async () => {
    const fixture = await journalTestFixture("journal-rejects-malformed-old-snapshot");
    fixture.journal.old.state.status = "NOT_A_STATE";
    await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
    await assertJournalRejectedWithoutWrites(
      fixture.projectWorkspace,
      /journal.*old|invalid state|snapshot/i,
    );
  });

  await t.test("malformed new snapshot", async () => {
    const fixture = await journalTestFixture("journal-rejects-malformed-new-snapshot");
    delete fixture.journal.new.manifest.route;
    await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
    await assertJournalRejectedWithoutWrites(
      fixture.projectWorkspace,
      /journal.*new|invalid projectManifest|snapshot/i,
    );
  });
});

test("adoption recovery rejects a foreign workspace identity without writing", async () => {
  const fixture = await journalTestFixture("journal-rejects-workspace-mismatch");
  fixture.journal.workspace = path.join(sandboxRoot, "foreign-workspace");
  await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  await assertJournalRejectedWithoutWrites(fixture.projectWorkspace, /journal.*workspace|workspace.*mismatch/i);
});

test("adoption recovery rejects illegal old-to-new business changes without writing", async () => {
  const fixture = await journalTestFixture("journal-rejects-business-change");
  fixture.journal.new.manifest.title = "journal changed business title";
  await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  await assertJournalRejectedWithoutWrites(
    fixture.projectWorkspace,
    /journal.*(business|migration|old.*new)|old.*new.*differ/i,
  );
});

test("adoption recovery rejects a new prebuild gate hash mismatch without writing", async () => {
  const fixture = await journalTestFixture("journal-rejects-prebuild-hash");
  const wrongHash = `sha256:${"f".repeat(64)}`;
  fixture.journal.new.manifest.qualityGates.prebuildEvidenceHash = wrongHash;
  fixture.journal.new.state.qualityGates.prebuildEvidenceHash = wrongHash;
  await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  await assertJournalRejectedWithoutWrites(
    fixture.projectWorkspace,
    /journal.*prebuild.*hash|prebuild.*hash.*mismatch/i,
  );
});

test("adoption recovery rejects stale font evidence without writing", async () => {
  const projectWorkspace = await copyLegacyFixture("journal-rejects-stale-font-evidence");
  const evidencePath = path.join(projectWorkspace, "legacy-prebuild.json");
  const { evidence, inputs } = await writePrebuildEvidence(
    projectWorkspace,
    evidencePath,
  );
  const fixture = await adoptionJournalFixture(projectWorkspace, evidence);
  await writeJsonAtomic(path.join(projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
  const changedFontEvidence = await readJson(inputs.fontEvidencePath);
  await fs.writeFile(inputs.fontEvidencePath, JSON.stringify(changedFontEvidence));
  await assertJournalRejectedWithoutWrites(
    projectWorkspace,
    /journal prebuild font evidence input hash is stale/i,
  );

  const emptyWorkspace = await copyLegacyFixture("journal-rejects-empty-font-evidence");
  const emptyEvidencePath = path.join(emptyWorkspace, "legacy-prebuild.json");
  const { evidence: emptyEvidence, inputs: emptyInputs } = await writePrebuildEvidence(
    emptyWorkspace,
    emptyEvidencePath,
  );
  const emptyFixture = await adoptionJournalFixture(emptyWorkspace, emptyEvidence);
  await writeJsonAtomic(path.join(emptyWorkspace, ADOPTION_JOURNAL), emptyFixture.journal);
  await fs.writeFile(emptyInputs.fontEvidencePath, "");
  await assertJournalRejectedWithoutWrites(
    emptyWorkspace,
    /journal.*prebuild.*font(?: evidence|EvidencePath).*nonempty.*ordinary file/i,
  );
});

test("adoption recovery rejects a forged prebuild after visual-contract drift without writing", async () => {
  const fixture = await journalTestFixture("journal-rejects-visual-contract-drift");
  const themeLockPath = path.join(fixture.projectWorkspace, "theme-lock.json");
  const themeLock = await readJson(themeLockPath);
  themeLock.resolvedFonts.latin = "Arial";
  await writeJsonAtomic(themeLockPath, themeLock);
  const fontEvidencePath = path.join(fixture.projectWorkspace, themeLock.fontEvidencePath);
  const fontEvidence = await readJson(fontEvidencePath);
  fontEvidence.resolvedFonts.latin = "Arial";
  await writeJsonAtomic(fontEvidencePath, fontEvidence);

  fixture.journal.new.prebuildEvidence.inputHashes.themeLock = await sha256File(themeLockPath);
  fixture.journal.new.prebuildEvidence.inputHashes.fontEvidence = await sha256File(fontEvidencePath);
  const forgedGateHash = serializedJsonHash(fixture.journal.new.prebuildEvidence);
  fixture.journal.new.manifest.qualityGates.prebuildEvidenceHash = forgedGateHash;
  fixture.journal.new.state.qualityGates.prebuildEvidenceHash = forgedGateHash;
  await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);

  await assertJournalRejectedWithoutWrites(
    fixture.projectWorkspace,
    /journal.*visual contract|visual approval|approvedArtifactHash/i,
  );
});

test("adoption recovery recomputes prebuild semantics before any recovery write", async (t) => {
  await t.test("forged all-zero PASS over invalid slide specs", async () => {
    const fixture = await journalTestFixture("journal-rejects-forged-invalid-slide-specs");
    const slideSpecsPath = path.join(fixture.projectWorkspace, "slide-specs.json");
    const slideSpecs = await readJson(slideSpecsPath);
    slideSpecs.slides[0].typographyBudget.body.minimumPt = 17;
    await writeJsonAtomic(slideSpecsPath, slideSpecs);
    fixture.journal.new.prebuildEvidence.inputHashes.slideSpecs = await sha256File(slideSpecsPath);
    const forgedHash = serializedJsonHash(fixture.journal.new.prebuildEvidence);
    fixture.journal.new.manifest.qualityGates.prebuildEvidenceHash = forgedHash;
    fixture.journal.new.state.qualityGates.prebuildEvidenceHash = forgedHash;
    await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
    await assertJournalRejectedWithoutWrites(
      fixture.projectWorkspace,
      /body.*18pt|TYPOGRAPHY_FLOOR|journal.*prebuild/i,
    );
  });

  await t.test("forged all-zero PASS over invalid font mode", async () => {
    const fixture = await journalTestFixture("journal-rejects-forged-invalid-font-mode");
    const themeLockPath = path.join(fixture.projectWorkspace, "theme-lock.json");
    const themeLock = await readJson(themeLockPath);
    themeLock.fontResolutionMode = "source-template";
    themeLock.templatePath = "forged-template.pptx";
    themeLock.templateHash = `sha256:${"e".repeat(64)}`;
    const forgedVisualHash = expectedVisualContractHash(themeLock);
    themeLock.approval.approvedArtifactHash = forgedVisualHash;
    await writeJsonAtomic(themeLockPath, themeLock);
    const currentState = await loadState(fixture.projectWorkspace);
    currentState.approvals.visual.approvedArtifactHash = forgedVisualHash;
    await saveState(fixture.projectWorkspace, currentState);
    fixture.journal.old.state.approvals.visual.approvedArtifactHash = forgedVisualHash;
    fixture.journal.new.state.approvals.visual.approvedArtifactHash = forgedVisualHash;
    fixture.journal.new.prebuildEvidence.inputHashes.themeLock = await sha256File(themeLockPath);
    fixture.journal.new.prebuildEvidence.approvalHashes.visual = forgedVisualHash;
    const forgedHash = serializedJsonHash(fixture.journal.new.prebuildEvidence);
    fixture.journal.new.manifest.qualityGates.prebuildEvidenceHash = forgedHash;
    fixture.journal.new.state.qualityGates.prebuildEvidenceHash = forgedHash;
    await writeJsonAtomic(path.join(fixture.projectWorkspace, ADOPTION_JOURNAL), fixture.journal);
    await assertJournalRejectedWithoutWrites(
      fixture.projectWorkspace,
      /create.*theme-catalog|fontResolutionMode|journal.*prebuild/i,
    );
  });
});

test("adoption recovery rejects an impossible current transaction phase without writing", async () => {
  const fixture = await journalTestFixture("journal-rejects-impossible-phase");
  await writeJsonAtomic(
    path.join(fixture.projectWorkspace, "quality/prebuild-evidence.json"),
    fixture.evidence,
  );
  await saveState(fixture.projectWorkspace, fixture.newState);
  await assertJournalRejectedWithoutWrites(
    fixture.projectWorkspace,
    /journal.*phase|transaction.*phase|impossible.*phase/i,
  );
});

test("quality contract fields are paired within and across manifest and state", async (t) => {
  await t.test("gates-only in both files is not legacy", async () => {
    const projectWorkspace = await workspace("quality-pair-gates-only");
    await initProject({ title: "gates only", route: "create", workspace: projectWorkspace });
    const manifest = await loadManifest(projectWorkspace);
    const state = await loadState(projectWorkspace);
    delete manifest.qualityContractVersion;
    delete state.qualityContractVersion;
    await saveManifest(projectWorkspace, manifest);
    await saveState(projectWorkspace, state);
    await assert.rejects(validateProject(projectWorkspace), /quality.*paired|version.*qualityGates/i);
  });

  await t.test("one-sided quality fields are rejected", async () => {
    const projectWorkspace = await workspace("quality-pair-one-sided");
    await initProject({ title: "one sided", route: "create", workspace: projectWorkspace });
    const manifest = await loadManifest(projectWorkspace);
    delete manifest.qualityContractVersion;
    delete manifest.qualityGates;
    await saveManifest(projectWorkspace, manifest);
    await assert.rejects(validateProject(projectWorkspace), /both manifest and state|quality contract version/i);
  });

  await t.test("gates-only on one side is rejected", async () => {
    const projectWorkspace = await workspace("quality-pair-one-sided-gates");
    await initProject({ title: "one sided gates", route: "create", workspace: projectWorkspace });
    const manifest = await loadManifest(projectWorkspace);
    const state = await loadState(projectWorkspace);
    delete manifest.qualityContractVersion;
    delete state.qualityContractVersion;
    delete state.qualityGates;
    await saveManifest(projectWorkspace, manifest);
    await saveState(projectWorkspace, state);
    await assert.rejects(validateProject(projectWorkspace), /quality.*paired|version.*qualityGates/i);
  });

  await t.test("cross-file gate drift is rejected", async () => {
    const projectWorkspace = await workspace("quality-pair-drift");
    await initProject({ title: "gate drift", route: "create", workspace: projectWorkspace });
    const state = await loadState(projectWorkspace);
    state.qualityGates.deckHash = `sha256:${"9".repeat(64)}`;
    await saveState(projectWorkspace, state);
    await assert.rejects(validateProject(projectWorkspace), /qualityGates mismatch/i);
  });
});

test("state-driver init writes a fixed synthetic owner marker", async () => {
  const projectWorkspace = await workspace("driver-owner-init");
  const result = runStateDriver(["init", projectWorkspace, "create", "driver-owner"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const state = await loadState(projectWorkspace);
  assert.deepEqual(await readJson(path.join(projectWorkspace, DRIVER_OWNER_MARKER)), {
    artifactType: "syntheticStateDriverOwner",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    workspace: path.resolve(projectWorkspace),
  });
});

test("state-driver prebuild binds the prospective edit diff-preview approval", async () => {
  const projectWorkspace = await workspace("driver-edit-diff-preview");
  const scopeApprovalPath = path.join(sandboxRoot, "driver-scope-approval.json");
  const diffApprovalPath = path.join(sandboxRoot, "driver-diff-approval.json");
  await writeJsonAtomic(scopeApprovalPath, { approvedArtifactHash: APPROVAL_HASHES.scope });
  await writeJsonAtomic(diffApprovalPath, {
    approvedArtifactHash: APPROVAL_HASHES.diffPreview,
  });
  for (const args of [
    ["init", projectWorkspace, "edit", "driver-edit"],
    ["transition", projectWorkspace, "COMPATIBILITY_REVIEW"],
    ["transition", projectWorkspace, "SCOPE_REVIEW"],
    ["transition", projectWorkspace, "SCOPE_APPROVED", scopeApprovalPath],
    ["transition", projectWorkspace, "CHANGE_PREVIEW"],
    ["transition", projectWorkspace, "BUILDING", diffApprovalPath],
  ]) {
    const result = runStateDriver(args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const evidence = await readJson(path.join(
    projectWorkspace,
    "quality/prebuild-evidence.json",
  ));
  assert.equal(evidence.approvalHashes.diffPreview, APPROVAL_HASHES.diffPreview);
});

test("state-driver rejects legacy and non-driver workspaces without changing any byte", async () => {
  const legacyWorkspace = await copyLegacyFixture("driver-rejects-legacy");
  const legacyState = await loadState(legacyWorkspace);
  await writeJsonAtomic(path.join(legacyWorkspace, DRIVER_OWNER_MARKER), {
    artifactType: "syntheticStateDriverOwner",
    schemaVersion: "1.0.0",
    projectId: legacyState.projectId,
    workspace: path.resolve(legacyWorkspace),
  });
  const legacyBefore = await workspaceSnapshot(legacyWorkspace);
  const legacyResult = runStateDriver(["transition", legacyWorkspace, "BUILDING"]);
  assert.notEqual(legacyResult.status, 0);
  assert.match(`${legacyResult.stdout}\n${legacyResult.stderr}`, /legacy|quality contract|driver owner/i);
  assert.deepEqual(await workspaceSnapshot(legacyWorkspace), legacyBefore);

  const nonDriverWorkspace = await createAtVisualLocked("driver-rejects-non-driver");
  const nonDriverBefore = await workspaceSnapshot(nonDriverWorkspace);
  const nonDriverResult = runStateDriver(["transition", nonDriverWorkspace, "BUILDING"]);
  assert.notEqual(nonDriverResult.status, 0);
  assert.match(`${nonDriverResult.stdout}\n${nonDriverResult.stderr}`, /driver owner|synthetic owner/i);
  assert.deepEqual(await workspaceSnapshot(nonDriverWorkspace), nonDriverBefore);
});

test("state-driver rejects copied workspaces and marker drift without changing any byte", async () => {
  const sourceWorkspace = await workspace("driver-copy-source");
  const initResult = runStateDriver(["init", sourceWorkspace, "create", "driver-copy-source"]);
  assert.equal(initResult.status, 0, initResult.stderr || initResult.stdout);
  const copiedWorkspace = path.join(sandboxRoot, "driver-copy-target");
  await fs.cp(sourceWorkspace, copiedWorkspace, { recursive: true });
  const copiedBefore = await workspaceSnapshot(copiedWorkspace);
  const copiedResult = runStateDriver(["transition", copiedWorkspace, "SOURCE_READY"]);
  assert.notEqual(copiedResult.status, 0);
  assert.match(`${copiedResult.stdout}\n${copiedResult.stderr}`, /workspace|driver owner/i);
  assert.deepEqual(await workspaceSnapshot(copiedWorkspace), copiedBefore);

  const driftWorkspace = await workspace("driver-marker-drift");
  const driftInit = runStateDriver(["init", driftWorkspace, "create", "driver-marker-drift"]);
  assert.equal(driftInit.status, 0, driftInit.stderr || driftInit.stdout);
  const markerPath = path.join(driftWorkspace, DRIVER_OWNER_MARKER);
  const marker = await readJson(markerPath).catch(async () => ({
    artifactType: "syntheticStateDriverOwner",
    schemaVersion: "1.0.0",
    workspace: path.resolve(driftWorkspace),
  }));
  marker.projectId = "ppt-drifted-owner";
  await writeJsonAtomic(markerPath, marker);
  const driftBefore = await workspaceSnapshot(driftWorkspace);
  const driftResult = runStateDriver(["transition", driftWorkspace, "SOURCE_READY"]);
  assert.notEqual(driftResult.status, 0);
  assert.match(`${driftResult.stdout}\n${driftResult.stderr}`, /projectId|driver owner/i);
  assert.deepEqual(await workspaceSnapshot(driftWorkspace), driftBefore);
});

test("persistent output guard recognizes OS temp aliases and tool scratch roots", () => {
  assert.equal(isEphemeralOutputPath("/private/tmp/final.pptx"), true);
  assert.equal(isEphemeralOutputPath("/var/tmp/final.pptx"), true);
  assert.equal(isEphemeralOutputPath("/workspace/.cache/final.pptx"), true);
  assert.equal(isEphemeralOutputPath("/workspace/scratch/final.pptx"), true);
  assert.equal(
    isEphemeralOutputPath(path.resolve("tests/fixtures/baseline/edit-source.pptx")),
    false,
  );
});

test("blockProject enforces route-compatible blockers", async () => {
  const createWorkspace = await workspace("block-create");
  await initProject({ title: "资料阻塞", route: "create", workspace: createWorkspace });
  await blockProject({
    workspace: createWorkspace,
    blockerType: "BLOCKED_SOURCE",
    reason: "缺少可核验资料",
  });
  assert.equal((await loadState(createWorkspace)).status, "BLOCKED_SOURCE");

  const templateWorkspace = await workspace("block-template");
  await initProject({ title: "模板资料阻塞", route: "template", workspace: templateWorkspace });
  await blockProject({
    workspace: templateWorkspace,
    blockerType: "BLOCKED_SOURCE",
    reason: "模板文件损坏",
  });
  assert.equal((await loadState(templateWorkspace)).status, "BLOCKED_SOURCE");

  const editWorkspace = await workspace("block-edit");
  await initProject({ title: "兼容性阻塞", route: "edit", workspace: editWorkspace });
  await blockProject({
    workspace: editWorkspace,
    blockerType: "BLOCKED_COMPATIBILITY",
    reason: "源文件无法稳定解析",
  });
  assert.equal((await loadState(editWorkspace)).status, "BLOCKED_COMPATIBILITY");

  await assert.rejects(
    blockProject({
      workspace: editWorkspace,
      blockerType: "BLOCKED_SOURCE",
      reason: "错误的阻塞类型",
    }),
    /incompatible blocker/i,
  );
});

test("blocked projects resume only to blockedFrom after blockers clear and hashes match", async () => {
  const projectWorkspace = await workspace("resume-blocked");
  await initProject({ title: "恢复", route: "create", workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
  await blockProject({
    workspace: projectWorkspace,
    blockerType: "BLOCKED_SOURCE",
    reason: "等待资料",
  });

  await assert.rejects(resumeBlockedProject({ workspace: projectWorkspace }), /blockers must be cleared/i);
  const cleared = await loadState(projectWorkspace);
  cleared.blockers = [];
  await saveState(projectWorkspace, cleared);
  await resumeBlockedProject({ workspace: projectWorkspace });
  assert.equal((await loadState(projectWorkspace)).status, "SOURCE_READY");

  const hashWorkspace = await workspace("resume-hash-mismatch");
  await initProject({ title: "哈希变化", route: "create", workspace: hashWorkspace });
  await blockProject({
    workspace: hashWorkspace,
    blockerType: "BLOCKED_SOURCE",
    reason: "等待资料",
  });
  const changed = await loadState(hashWorkspace);
  changed.blockers = [];
  changed.inputHashes = { source: "sha256:changed" };
  await saveState(hashWorkspace, changed);
  await assert.rejects(resumeBlockedProject({ workspace: hashWorkspace }), /input hashes changed/i);
});

test("approval invalidation returns eligible routes to their review gates", async () => {
  const reviewedWorkspace = await createAtFinalReview("invalidate-reviewed-evidence");
  const reviewedAuditHash = await sha256File(path.join(
    reviewedWorkspace,
    "quality/pptx-audit.json",
  ));
  const reviewedQaHash = await sha256File(path.join(reviewedWorkspace, "qa-report.json"));
  await invalidateApproval({
    workspace: reviewedWorkspace,
    impact: "visual",
    changedArtifactHash: `sha256:${"8".repeat(64)}`,
    reason: "视觉审批后发生变化",
  });
  const reviewedState = await loadState(reviewedWorkspace);
  assert.deepEqual(reviewedState.qualityGates.invalidatedPptxAuditHashes, [reviewedAuditHash]);
  assert.deepEqual(reviewedState.qualityGates.invalidatedQaReportHashes, [reviewedQaHash]);

  const narrativeWorkspace = await createAtBuilding("invalidate-narrative");
  await invalidateApproval({
    workspace: narrativeWorkspace,
    impact: "narrative",
    changedArtifactHash: "sha256:outline-v2",
    reason: "核心结论发生变化",
    affectedPages: [3, 4],
  });
  const narrativeState = await loadState(narrativeWorkspace);
  assert.equal(narrativeState.status, "OUTLINE_REVIEW");
  assert.deepEqual(narrativeState.qualityGates, {});
  assert.deepEqual((await loadManifest(narrativeWorkspace)).qualityGates, {});
  assert.equal(narrativeState.invalidations.at(-1).changedArtifactHash, "sha256:outline-v2");
  assert.deepEqual(narrativeState.invalidations.at(-1).affectedPages, [3, 4]);

  const visualWorkspace = await createAtBuilding("invalidate-visual", "template");
  await invalidateApproval({
    workspace: visualWorkspace,
    impact: "visual",
    changedArtifactHash: "sha256:visual-v2",
    reason: "模板色彩体系改变",
  });
  const visualState = await loadState(visualWorkspace);
  assert.equal(visualState.status, "VISUAL_REVIEW");
  assert.deepEqual(visualState.qualityGates, {});

  const scopeWorkspace = await editAtBuilding("invalidate-scope");
  await invalidateApproval({
    workspace: scopeWorkspace,
    impact: "scope",
    changedArtifactHash: "sha256:scope-v2",
    reason: "授权页范围扩大",
    affectedPages: [4, 7, 8],
  });
  const scopeState = await loadState(scopeWorkspace);
  assert.equal(scopeState.status, "SCOPE_REVIEW");
  assert.deepEqual(scopeState.qualityGates, {});

  await assert.rejects(
    invalidateApproval({
      workspace: scopeWorkspace,
      impact: "scope",
      reason: "缺少变更哈希",
    }),
    /changed artifact hash/i,
  );
  await assert.rejects(
    invalidateApproval({
      workspace: scopeWorkspace,
      impact: "scope",
      changedArtifactHash: "sha256:scope-v3",
    }),
    /reason/i,
  );
});

test("validateProject accepts a readable fixture but rejects legacy QA as delivered authority", async () => {
  const validFixture = path.resolve("tests/fixtures/project-valid");
  const invalidFixture = path.resolve("tests/fixtures/project-invalid");
  const legacyDeliveredFixture = await copyLegacyFixture("validate-legacy-final-review");
  assert.equal((await validateProject(validFixture)).valid, true);
  await assert.rejects(
    validateProject(legacyDeliveredFixture),
    /qaReportCurrent|current.*QA|legacy.*read.?only|quality contract/i,
  );
  await assert.rejects(validateProject(invalidFixture), /projectId mismatch/i);
});

test("validateProject rejects a forged DELIVERED state without QA or final approval", async () => {
  const projectWorkspace = await workspace("validate-forged-delivered");
  await initProject({
    title: "伪造交付状态",
    route: "create",
    workspace: projectWorkspace,
  });
  const forged = await loadState(projectWorkspace);
  forged.status = "DELIVERED";
  forged.approvals = {};
  await saveState(projectWorkspace, forged);

  await assert.rejects(
    validateProject(projectWorkspace),
    /DELIVERED|QA|final approval/i,
  );
});

test("resume fails closed for a missing workspace", async () => {
  await assert.rejects(
    resumeBlockedProject({ workspace: path.join(sandboxRoot, "does-not-exist") }),
    /workspace|ENOENT/i,
  );
});

test("state approval schema mirrors strict runtime approval contracts", async () => {
  const schema = await readJson(PROJECT_ARTIFACTS_SCHEMA_PATH);
  const approvals = schema.$defs.state.properties.approvals;
  assert.equal(approvals.additionalProperties, false);
  assert.deepEqual(Object.keys(approvals.properties).sort(), [
    "diffPreview",
    "final",
    "outline",
    "scope",
    "visual",
  ]);
  for (const gate of ["outline", "visual", "scope"]) {
    assert.deepEqual(approvals.properties[gate], { $ref: "#/$defs/artifactApproval" });
  }
  assert.deepEqual(approvals.properties.final, { $ref: "#/$defs/finalApproval" });
  assert.deepEqual(approvals.properties.diffPreview, { $ref: "#/$defs/diffPreviewApproval" });
  assert.equal(
    schema.$defs.artifactApproval.properties.approvedArtifactHash.pattern,
    "^sha256:[0-9a-f]{64}$",
  );
  assert.equal(
    schema.$defs.finalApproval.properties.approvedArtifactHash.pattern,
    "^sha256:[0-9a-f]{64}$",
  );

  const artifactApprovalSchema = {
    $defs: schema.$defs,
    $ref: "#/$defs/artifactApproval",
  };
  assert.equal(validateSchema(artifactApprovalSchema, {
    approvedArtifactHash: APPROVAL_HASHES.outline,
  }).valid, true);
  for (const approvedArtifactHash of [
    "sha256:short",
    `sha256:${"A".repeat(64)}`,
    ` ${APPROVAL_HASHES.outline} `,
  ]) {
    assert.equal(validateSchema(artifactApprovalSchema, { approvedArtifactHash }).valid, false);
  }

  const diffPreviewSchema = {
    $defs: schema.$defs,
    $ref: "#/$defs/diffPreviewApproval",
  };
  assert.equal(validateSchema(diffPreviewSchema, {
    approvedArtifactHash: APPROVAL_HASHES.diffPreview,
  }).valid, true);
  assert.equal(validateSchema(diffPreviewSchema, {
    notApplicableReason: "仅修改文字，无可视差异",
  }).valid, true);
  assert.equal(validateSchema(diffPreviewSchema, {}).valid, false);
  assert.equal(validateSchema(diffPreviewSchema, {
    approvedArtifactHash: APPROVAL_HASHES.diffPreview,
    notApplicableReason: "不得同时存在",
  }).valid, false);
  assert.equal(validateSchema(diffPreviewSchema, {
    notApplicableReason: "   ",
  }).valid, false);
});

test("schema validator resolves local refs and rejects missing definitions", () => {
  const localRefSchema = {
    $defs: {
      item: {
        type: "object",
        required: ["kind"],
        properties: { kind: { const: "ok" } },
        additionalProperties: false,
      },
    },
    $ref: "#/$defs/item",
  };
  assert.deepEqual(validateSchema(localRefSchema, { kind: "ok" }), { valid: true, errors: [] });

  const missingRef = validateSchema({ $defs: {}, $ref: "#/$defs/missing" }, {});
  assert.equal(missingRef.valid, false);
  assert.match(missingRef.errors.join("\n"), /Missing schema definition/);

  const externalRef = validateSchema({ $ref: "https://example.com/schema.json" }, {});
  assert.equal(externalRef.valid, false);
  assert.match(externalRef.errors.join("\n"), /External or unsupported/);

  const recursiveRef = validateSchema(
    { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" },
    {},
  );
  assert.equal(recursiveRef.valid, false);
  assert.match(recursiveRef.errors.join("\n"), /Recursive schema reference/);
});

test("schema validator enforces finite JSON Schema number and integer parity", () => {
  const scoreSchema = { type: "integer", minimum: 4, maximum: 5 };
  assert.equal(validateSchema(scoreSchema, 4).valid, true);
  assert.equal(validateSchema(scoreSchema, 4.0).valid, true);
  assert.equal(validateSchema(scoreSchema, 4.5).valid, false);
  assert.equal(validateSchema(scoreSchema, 5).valid, true);
  const aboveMaximum = validateSchema(scoreSchema, 6);
  assert.equal(aboveMaximum.valid, false);
  assert.match(aboveMaximum.errors.join("\n"), /above maximum 5/i);
  for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(validateSchema({ type: "number" }, nonFinite).valid, false);
    assert.equal(validateSchema(scoreSchema, nonFinite).valid, false);
  }
});
