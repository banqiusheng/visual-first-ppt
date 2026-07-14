import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  blockProject,
  initProject,
  invalidateApproval,
  isEphemeralOutputPath,
  resumeBlockedProject,
  transitionProject,
  validateProject,
} from "../../skills/visual-first-ppt/scripts/project-state.mjs";
import {
  readJson,
  writeJsonAtomic,
} from "../../skills/visual-first-ppt/scripts/lib/atomic-json.mjs";
import {
  validateSchema,
} from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visual-first-ppt-state-"));
process.env.CODEX_HOME = path.join(sandboxRoot, "codex-home");

async function workspace(name) {
  return path.join(sandboxRoot, name);
}

async function loadState(projectWorkspace) {
  return readJson(path.join(projectWorkspace, "state.json"));
}

async function saveState(projectWorkspace, state) {
  return writeJsonAtomic(path.join(projectWorkspace, "state.json"), state);
}

async function createAtBuilding(name, impactRoute = "create") {
  const projectWorkspace = await workspace(name);
  await initProject({ title: name, route: impactRoute, workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "SOURCE_READY" });
  await transitionProject({ workspace: projectWorkspace, to: "OUTLINE_REVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "OUTLINE_APPROVED",
    approval: { approvedArtifactHash: "sha256:outline-v1" },
  });
  await transitionProject({ workspace: projectWorkspace, to: "VISUAL_REVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "VISUAL_LOCKED",
    approval: { approvedArtifactHash: "sha256:visual-v1" },
  });
  await transitionProject({ workspace: projectWorkspace, to: "BUILDING" });
  return projectWorkspace;
}

async function editAtBuilding(name) {
  const projectWorkspace = await workspace(name);
  await initProject({ title: name, route: "edit", workspace: projectWorkspace });
  await transitionProject({ workspace: projectWorkspace, to: "COMPATIBILITY_REVIEW" });
  await transitionProject({ workspace: projectWorkspace, to: "SCOPE_REVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "SCOPE_APPROVED",
    approval: { approvedArtifactHash: "sha256:scope-v1" },
  });
  await transitionProject({ workspace: projectWorkspace, to: "CHANGE_PREVIEW" });
  await transitionProject({
    workspace: projectWorkspace,
    to: "BUILDING",
    approval: { approvedArtifactHash: "sha256:diff-v1" },
  });
  return projectWorkspace;
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
    approval: { approvedArtifactHash: "sha256:outline" },
  });
  await transitionProject({ workspace: projectWorkspace, to: "VISUAL_REVIEW" });
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "VISUAL_LOCKED" }),
    /approval artifact hash/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "VISUAL_LOCKED",
    approval: { approvedArtifactHash: "sha256:visual" },
  });

  const state = await loadState(projectWorkspace);
  assert.equal(state.status, "VISUAL_LOCKED");
  assert.equal(state.approvals.outline.approvedArtifactHash, "sha256:outline");
  assert.equal(state.approvals.visual.approvedArtifactHash, "sha256:visual");
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
    approval: { approvedArtifactHash: "sha256:scope" },
  });
  await transitionProject({ workspace: projectWorkspace, to: "CHANGE_PREVIEW" });
  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "BUILDING" }),
    /diff-preview approval/i,
  );
  await transitionProject({
    workspace: projectWorkspace,
    to: "BUILDING",
    approval: { notApplicableReason: "纯文本错别字修正，无视觉差异预览" },
  });

  const state = await loadState(projectWorkspace);
  assert.equal(state.status, "BUILDING");
  assert.equal(state.approvals.diffPreview.notApplicableReason.length > 0, true);
});

test("delivery requires final approval, QA PASS, and a persistent final output", async () => {
  const projectWorkspace = await createAtBuilding("delivery-gate");
  await transitionProject({ workspace: projectWorkspace, to: "QA" });
  await transitionProject({ workspace: projectWorkspace, to: "FINAL_REVIEW" });

  await assert.rejects(
    transitionProject({ workspace: projectWorkspace, to: "DELIVERED" }),
    /approval artifact hash/i,
  );
  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: { approvedArtifactHash: "sha256:final" },
    }),
    /QA PASS/i,
  );

  const state = await loadState(projectWorkspace);
  const qaReport = {
    artifactType: "qaReport",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    inputHashes: { deck: "sha256:deck" },
    toolVersions: { node: process.version },
    automatedChecks: [{ id: "slides-test", status: "PASS", evidencePath: "qa/slides-test.txt" }],
    perSlideManualScores: [{ slide: 1, score: 5, evidencePath: "qa/slide-1.png" }],
    clientSmokeStatus: "PASS",
    evidencePaths: ["qa/slides-test.txt", "qa/slide-1.png"],
    finalVerdict: "PASS",
  };
  await writeJsonAtomic(path.join(projectWorkspace, "qa-report.json"), qaReport);

  await assert.rejects(
    transitionProject({
      workspace: projectWorkspace,
      to: "DELIVERED",
      approval: { approvedArtifactHash: "sha256:final" },
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
        approvedArtifactHash: "sha256:final",
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
        approvedArtifactHash: "sha256:final",
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
      approvedArtifactHash: "sha256:final",
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
  assert.equal(narrativeState.invalidations.at(-1).changedArtifactHash, "sha256:outline-v2");
  assert.deepEqual(narrativeState.invalidations.at(-1).affectedPages, [3, 4]);

  const visualWorkspace = await createAtBuilding("invalidate-visual", "template");
  await invalidateApproval({
    workspace: visualWorkspace,
    impact: "visual",
    changedArtifactHash: "sha256:visual-v2",
    reason: "模板色彩体系改变",
  });
  assert.equal((await loadState(visualWorkspace)).status, "VISUAL_REVIEW");

  const scopeWorkspace = await editAtBuilding("invalidate-scope");
  await invalidateApproval({
    workspace: scopeWorkspace,
    impact: "scope",
    changedArtifactHash: "sha256:scope-v2",
    reason: "授权页范围扩大",
    affectedPages: [4, 7, 8],
  });
  assert.equal((await loadState(scopeWorkspace)).status, "SCOPE_REVIEW");

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

test("validateProject accepts the valid fixture and rejects cross-file identity mismatch", async () => {
  const validFixture = path.resolve("tests/fixtures/project-valid");
  const invalidFixture = path.resolve("tests/fixtures/project-invalid");
  assert.equal((await validateProject(validFixture)).valid, true);
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
