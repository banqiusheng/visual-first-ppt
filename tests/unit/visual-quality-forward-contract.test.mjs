import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  collectVisualQualityImplementationBinding,
  resolveImplementationRef,
} from "../quality-forward/summarize.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const HARNESS = path.join(ROOT, "tests/quality-forward");
const SCENARIOS = path.join(HARNESS, "scenarios.json");
const RUBRIC = path.join(HARNESS, "rubric.json");
const RENDERER = path.join(HARNESS, "render-prompts.mjs");
const SUMMARIZER = path.join(HARNESS, "summarize.mjs");
const EXPECTED_IDS = [
  "create-long-poem-quality",
  "edit-authorized-page-quality",
  "template-dense-data-quality",
];
const IMPLEMENTATION_INPUTS = [
  "skills/visual-first-ppt/SKILL.md",
  "skills/visual-first-ppt/references/generation-contract.md",
  "skills/visual-first-ppt/references/intake-and-research.md",
  "skills/visual-first-ppt/references/qa-and-delivery.md",
  "skills/visual-first-ppt/references/themes.md",
  "skills/visual-first-ppt/references/workflow.md",
  "skills/visual-first-ppt/assets/quality-contract.json",
  "skills/visual-first-ppt/schemas/project-artifacts.schema.json",
  "skills/visual-first-ppt/schemas/quality-evidence.schema.json",
  "skills/visual-first-ppt/scripts/audit_pptx_quality.py",
  "skills/visual-first-ppt/scripts/validate-slide-specs.mjs",
  "tests/quality-forward/rubric.json",
  "tests/quality-forward/scenarios.json",
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

async function trackedAgentForwardHash() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD:tests/agent-forward"], { cwd: ROOT });
  return `git-tree:${stdout.trim()}`;
}

async function makeRunRoot(t) {
  const runsBase = path.join(ROOT, ".superpowers/quality-forward/runs");
  await fs.mkdir(runsBase, { recursive: true });
  for (let offset = 0; offset < 1000; offset += 1) {
    const compact = new Date(Date.now() + offset).toISOString().replace(/[-:.]/g, "");
    const runRoot = path.join(runsBase, compact);
    try {
      await fs.mkdir(runRoot);
      t.after(() => fs.rm(runRoot, { recursive: true, force: true }));
      return runRoot;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate an ignored quality-forward timestamp directory");
}

async function writeScenarioEvidence(runRoot, scenario, outcome, facts) {
  const scenarioRoot = path.join(runRoot, scenario.id);
  const evidenceRoot = path.join(scenarioRoot, "evidence");
  await fs.mkdir(evidenceRoot, { recursive: true });
  const evidenceId = Object.keys(facts)[0];
  const evidence = {
    artifactType: "visualQualityForwardEvidence",
    schemaVersion: "1.0.0",
    scenarioId: scenario.id,
    evidenceId,
    status: "PASS",
    facts: facts[evidenceId],
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  const evidencePath = path.join(evidenceRoot, `${evidenceId}.json`);
  await fs.writeFile(evidencePath, evidenceBytes);
  const manifest = {
    artifactType: "visualQualityForwardScenarioManifest",
    schemaVersion: "1.0.0",
    scenarioId: scenario.id,
    route: scenario.route,
    verdict: "PASS",
    outcome,
    deckProduced: false,
    evidence: [{
      id: evidenceId,
      path: `evidence/${evidenceId}.json`,
      sha256: sha256(evidenceBytes),
    }],
  };
  const manifestPath = path.join(scenarioRoot, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { id: scenario.id, manifestPath: `${scenario.id}/manifest.json` };
}

async function makeCompleteRun(t) {
  const runRoot = await makeRunRoot(t);
  const scenarios = (await readJson(SCENARIOS)).scenarios;
  const descriptors = [];
  descriptors.push(await writeScenarioEvidence(
    runRoot,
    scenarios.find(({ id }) => id === "create-long-poem-quality"),
    "BLOCKED_PREBUILD",
    {
      "prebuild-decision": {
        requestedState: "BUILDING",
        blockedBeforeBuilding: true,
        violationCodes: ["TYPOGRAPHY_FLOOR", "CONTENT_BLOCK_LIMIT", "CONTENT_HASH"],
      },
    },
  ));
  descriptors.push(await writeScenarioEvidence(
    runRoot,
    scenarios.find(({ id }) => id === "template-dense-data-quality"),
    "COMPATIBILITY_BLOCKED",
    {
      "compatibility-decision": {
        compatibilityBlocked: true,
        originalTemplatePagesUnchanged: true,
      },
    },
  ));
  descriptors.push(await writeScenarioEvidence(
    runRoot,
    scenarios.find(({ id }) => id === "edit-authorized-page-quality"),
    "BLOCKED_FINAL_REVIEW",
    {
      "authorization-decision": {
        finalReviewBlocked: true,
        unauthorizedHashMismatch: true,
        unchangedEvidenceRequired: "compare_untouched_slides.py",
        qaPassClaimed: false,
      },
    },
  ));
  const treeHash = await trackedAgentForwardHash();
  const implementationBinding = await collectVisualQualityImplementationBinding(ROOT);
  await fs.writeFile(path.join(runRoot, "run-manifest.json"), `${JSON.stringify({
    artifactType: "visualQualityForwardRunManifest",
    schemaVersion: "1.0.0",
    frozenAgentForwardTreeHashBefore: treeHash,
    frozenAgentForwardTreeHashAfter: treeHash,
    ...implementationBinding,
    scenarios: descriptors,
  }, null, 2)}\n`);
  return { runRoot, treeHash };
}

test("quality-forward contract fixes exactly three route-specific scenarios", async () => {
  const scenariosDocument = await readJson(SCENARIOS);
  assert.deepEqual(
    scenariosDocument.scenarios.map(({ id }) => id).sort(),
    EXPECTED_IDS,
  );
  assert.equal(scenariosDocument.scenarios.length, 3);
  assert.equal(scenariosDocument.rawEvidenceRoot, ".superpowers/quality-forward/runs/<timestamp>/");
  for (const scenario of scenariosDocument.scenarios) {
    assert.ok(["create", "template", "edit"].includes(scenario.route));
    assert.equal(typeof scenario.prompt, "string");
    assert.ok(scenario.prompt.trim());
  }

  const rubricText = await fs.readFile(RUBRIC, "utf8");
  assert.match(rubricText, /contentVisibility/);
  assert.match(rubricText, /generatedImageTextReview/);
  assert.match(rubricText, /unauthorized.*unchanged/is);
});

test("implementation ref resolver verifies detached PR and tag checkouts", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forward-detached-ref-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileAsync("git", args, { cwd: repo });
  await git("init");
  await git("config", "user.name", "Visual Quality Test");
  await git("config", "user.email", "visual-quality@example.invalid");
  await fs.writeFile(path.join(repo, "marker.txt"), "detached ref fixture\n");
  await git("add", "marker.txt");
  await git("commit", "-m", "fixture");
  await git("branch", "-M", "codex/detached-fixture");
  const { stdout: headOutput } = await git("rev-parse", "HEAD");
  const headSha = headOutput.trim();

  assert.equal(await resolveImplementationRef(repo, {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA: "f".repeat(40),
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_REF_NAME: "7/merge",
    GITHUB_REF_TYPE: "branch",
    GITHUB_HEAD_REF: "forged/ignored-on-named-branch",
  }), "codex/detached-fixture");

  await git("tag", "-a", "v0.3.0", "-m", "fixture tag");
  const { stdout: tagObjectOutput } = await git("rev-parse", "refs/tags/v0.3.0");
  const tagObject = tagObjectOutput.trim();
  await git("update-ref", "refs/remotes/pull/7/merge", headSha);
  await git("checkout", "--detach", headSha);
  const prEnvironment = {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA: headSha,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_REF_NAME: "7/merge",
    GITHUB_REF_TYPE: "branch",
    GITHUB_HEAD_REF: "codex/detached-fixture",
  };
  assert.equal(await resolveImplementationRef(repo, prEnvironment), "codex/detached-fixture");
  await assert.rejects(
    resolveImplementationRef(repo, { ...prEnvironment, GITHUB_SHA: "e".repeat(40) }),
    /named Git branch|verified GitHub ref/i,
  );

  assert.equal(await resolveImplementationRef(repo, {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: headSha,
    GITHUB_REF: "refs/tags/v0.3.0",
    GITHUB_REF_NAME: "v0.3.0",
    GITHUB_REF_TYPE: "tag",
  }), "v0.3.0");

  assert.equal(await resolveImplementationRef(repo, {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: "d".repeat(40),
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_REF_TYPE: "branch",
    INPUT_TAG: "v0.3.0",
    VERIFIED_TAG_OBJECT: tagObject,
    VERIFIED_TAG_COMMIT: headSha,
  }), "v0.3.0");
});

test("renderer writes portable prompts only inside the ignored raw-evidence shape", async (t) => {
  const runRoot = await makeRunRoot(t);
  await execFileAsync(process.execPath, [RENDERER, "--repo", ROOT, "--runs-root", runRoot]);
  const scenarios = (await readJson(SCENARIOS)).scenarios;
  for (const scenario of scenarios) {
    const prompt = await fs.readFile(path.join(runRoot, scenario.id, "request.md"), "utf8");
    assert.match(prompt, new RegExp(scenario.id));
    assert.match(prompt, /\{\{REPOSITORY_ROOT\}\}/);
    assert.match(prompt, /\{\{SCENARIO_OUTPUT_DIRECTORY\}\}/);
    assert.doesNotMatch(prompt, /\/Users\/[^/]+\//);
    assert.ok(!prompt.includes(runRoot), "prompt must not capture its local output path");
  }

  const rendererSource = await fs.readFile(RENDERER, "utf8");
  assert.doesNotMatch(rendererSource, /node:child_process|\b(?:spawn|execFile|exec|codex|claude)\b/i);
  const outside = path.join(path.dirname(runRoot), "not-a-timestamp");
  await assert.rejects(
    execFileAsync(process.execPath, [RENDERER, "--repo", ROOT, "--runs-root", outside]),
    /\.superpowers.*quality-forward.*runs.*timestamp|raw evidence root/i,
  );

  const otherRepo = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forward-other-repo-"));
  t.after(() => fs.rm(otherRepo, { recursive: true, force: true }));
  const foreignRunRoot = path.join(
    otherRepo,
    ".superpowers/quality-forward/runs/20260717T000000000Z",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [RENDERER, "--repo", ROOT, "--runs-root", foreignRunRoot]),
    /repository.*raw evidence root|inside.*repository/i,
  );

  const escapedTarget = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forward-render-escape-"));
  t.after(() => fs.rm(escapedTarget, { recursive: true, force: true }));
  const symlinkRunRoot = path.join(
    ROOT,
    ".superpowers/quality-forward/runs/20260717T235959999Z",
  );
  await fs.rm(symlinkRunRoot, { recursive: true, force: true });
  await fs.symlink(escapedTarget, symlinkRunRoot, "dir");
  t.after(() => fs.rm(symlinkRunRoot, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [RENDERER, "--repo", ROOT, "--runs-root", symlinkRunRoot]),
    /symbolic link|symlink|raw evidence root/i,
  );
  await assert.rejects(fs.access(path.join(escapedTarget, EXPECTED_IDS[0], "request.md")));
});

test("summarizer accepts only hash-bound file evidence and emits the compact public shape", async (t) => {
  const { runRoot, treeHash } = await makeCompleteRun(t);
  const output = path.join(runRoot, "compact-summary.json");
  await execFileAsync(process.execPath, [
    SUMMARIZER,
    "--repo",
    ROOT,
    "--run-root",
    runRoot,
    "--output",
    output,
  ]);
  const summary = await readJson(output);
  assert.deepEqual(Object.keys(summary).sort(), [
    "artifactType",
    "evidenceRetention",
    "frozenAgentForwardTreeHash",
    "scenarios",
    "schemaVersion",
  ].sort());
  assert.equal(summary.evidenceRetention, "summary-and-hashes-only");
  assert.equal(summary.frozenAgentForwardTreeHash, treeHash);
  assert.deepEqual(summary.scenarios.map(({ id }) => id).sort(), EXPECTED_IDS);
  for (const scenario of summary.scenarios) {
    assert.deepEqual(Object.keys(scenario).sort(), ["id", "manifestSha256", "verdict"].sort());
    assert.equal(scenario.verdict, "PASS");
    assert.match(scenario.manifestSha256, /^sha256:[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\.superpowers\/quality-forward\/runs|\.pptx|\.png/i);
});

test("summarizer fails closed on frozen-tree drift and unsupported or forged evidence", async (t) => {
  const { runRoot } = await makeCompleteRun(t);
  const output = path.join(runRoot, "compact-summary.json");
  const runManifestPath = path.join(runRoot, "run-manifest.json");
  const runManifest = await readJson(runManifestPath);
  runManifest.frozenAgentForwardTreeHashAfter = `git-tree:${"0".repeat(40)}`;
  await fs.writeFile(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [SUMMARIZER, "--repo", ROOT, "--run-root", runRoot, "--output", output]),
    /before.*after|frozen.*tree.*mismatch/i,
  );

  runManifest.frozenAgentForwardTreeHashAfter = runManifest.frozenAgentForwardTreeHashBefore;
  await fs.writeFile(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
  const evidencePath = path.join(runRoot, "create-long-poem-quality/evidence/prebuild-decision.json");
  const evidence = await readJson(evidencePath);
  evidence.facts.blockedBeforeBuilding = false;
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [SUMMARIZER, "--repo", ROOT, "--run-root", runRoot, "--output", output]),
    /hash mismatch|evidence.*hash/i,
  );
  await assert.rejects(fs.access(output));
});

test("summarizer rejects symlinked run roots and deckProduced lies", async (t) => {
  const { runRoot } = await makeCompleteRun(t);
  const deckLieOutput = path.join(runRoot, "deck-lie-summary.json");
  await fs.writeFile(
    path.join(runRoot, "template-dense-data-quality", "undeclared-output.PPTX"),
    "not a real deck, but still a produced PPTX artifact\n",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      SUMMARIZER,
      "--repo",
      ROOT,
      "--run-root",
      runRoot,
      "--output",
      deckLieOutput,
    ]),
    /deckProduced|PPTX/i,
  );
  await assert.rejects(fs.access(deckLieOutput));

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forward-summary-escape-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.cp(runRoot, outside, { recursive: true });
  await fs.rm(path.join(outside, "template-dense-data-quality", "undeclared-output.PPTX"));
  const symlinkRunRoot = path.join(
    ROOT,
    ".superpowers/quality-forward/runs/20260717T235958999Z",
  );
  await fs.rm(symlinkRunRoot, { recursive: true, force: true });
  await fs.symlink(outside, symlinkRunRoot, "dir");
  t.after(() => fs.rm(symlinkRunRoot, { recursive: true, force: true }));
  const symlinkOutput = path.join(outside, "symlink-summary.json");
  await assert.rejects(
    execFileAsync(process.execPath, [
      SUMMARIZER,
      "--repo",
      ROOT,
      "--run-root",
      symlinkRunRoot,
      "--output",
      symlinkOutput,
    ]),
    /symbolic link|symlink|run root/i,
  );
  await assert.rejects(fs.access(symlinkOutput));
});

test("summarizer binds Task 9 implementation state and refuses linked manifest or output files", async (t) => {
  const implementationRun = await makeCompleteRun(t);
  const manifestPath = path.join(implementationRun.runRoot, "run-manifest.json");
  const manifest = await readJson(manifestPath);
  assert.deepEqual(Object.keys(manifest.implementationInputHashes).sort(), IMPLEMENTATION_INPUTS.toSorted());
  assert.equal(manifest.branch, (await collectVisualQualityImplementationBinding(ROOT)).branch);
  assert.match(manifest.diffSha256, /^sha256:[0-9a-f]{64}$/);

  manifest.diffSha256 = `sha256:${"0".repeat(64)}`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const driftOutput = path.join(implementationRun.runRoot, "diff-drift-summary.json");
  await assert.rejects(
    execFileAsync(process.execPath, [SUMMARIZER, "--repo", ROOT, "--run-root", implementationRun.runRoot, "--output", driftOutput]),
    /diff.*hash|implementation.*drift/i,
  );
  await assert.rejects(fs.access(driftOutput));

  const manifestLinkRun = await makeCompleteRun(t);
  const externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forward-file-links-"));
  t.after(() => fs.rm(externalDirectory, { recursive: true, force: true }));
  const externalManifest = path.join(externalDirectory, "run-manifest.json");
  const linkedManifestPath = path.join(manifestLinkRun.runRoot, "run-manifest.json");
  await fs.copyFile(linkedManifestPath, externalManifest);
  await fs.rm(linkedManifestPath);
  await fs.symlink(externalManifest, linkedManifestPath);
  const linkedManifestOutput = path.join(manifestLinkRun.runRoot, "linked-manifest-summary.json");
  await assert.rejects(
    execFileAsync(process.execPath, [SUMMARIZER, "--repo", ROOT, "--run-root", manifestLinkRun.runRoot, "--output", linkedManifestOutput]),
    /run manifest.*escapes|symbolic link|symlink/i,
  );
  await assert.rejects(fs.access(linkedManifestOutput));

  const outputLinkRun = await makeCompleteRun(t);
  const victim = path.join(externalDirectory, "victim.json");
  await fs.writeFile(victim, "do not overwrite\n");
  const linkedOutput = path.join(outputLinkRun.runRoot, "compact-summary.json");
  await fs.symlink(victim, linkedOutput);
  await assert.rejects(
    execFileAsync(process.execPath, [SUMMARIZER, "--repo", ROOT, "--run-root", outputLinkRun.runRoot, "--output", linkedOutput]),
    /output.*symbolic link|symlink/i,
  );
  assert.equal(await fs.readFile(victim, "utf8"), "do not overwrite\n");
});

test("route evidence producer exposes current quality inputs without replacing legacy route flags", async () => {
  const source = await fs.readFile(
    path.join(ROOT, "tests/artifacts/support/build-route-evidence.py"),
    "utf8",
  );
  for (const flag of [
    "--slide-specs", "--theme-lock", "--object-inventory", "--quality-audit",
    "--review-checks", "--user-open-confirmation-evidence",
  ]) {
    assert.match(source, new RegExp(flag));
  }
  for (const legacyFlag of ["--workspace", "--route", "--pptx", "--pdf", "--data-contract"]) {
    assert.match(source, new RegExp(legacyFlag));
  }
  assert.match(
    source,
    /if check_id == "pageCountAndCanvas":\s+structured_check\["value"\] = slide_count/,
    "current structured evidence must retain the positive slide count required by build-qa-report",
  );
  assert.doesNotMatch(
    source,
    /"status":\s*"passed"[\s\S]{0,500}LibreOffice Impress headless/,
    "headless LibreOffice diagnostics cannot claim target-client GUI PASS",
  );
  assert.match(source, /"status":\s*"not_available"/);
  assert.doesNotMatch(
    source,
    /"userFinalOpenConfirmation":\s*True/,
    "the helper cannot mint user confirmation",
  );
  assert.match(source, /args\.user_open_confirmation_evidence\.resolve\(\)/);
});
