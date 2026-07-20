#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_TREE = /^git-tree:[0-9a-f]{40}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const EXPECTED_IDS = Object.freeze([
  "create-long-poem-quality",
  "template-dense-data-quality",
  "edit-authorized-page-quality",
]);
const IMPLEMENTATION_INPUTS = Object.freeze([
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
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported fields; expected ${wanted.join(", ")}`);
  }
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing ${name}`);
  return argv[index + 1];
}

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

async function readJsonBytes(filePath, label) {
  const bytes = await fs.readFile(filePath);
  if (bytes.length === 0) throw new Error(`${label} must be nonempty`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  return { bytes, value };
}

function portableRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error(`${label} escapes its scenario directory`);
  }
  return value;
}

async function containedFile(root, declaredPath, label) {
  const relative = portableRelativePath(declaredPath, label);
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(root, relative);
  const candidateReal = await fs.realpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`${label} escapes its scenario directory`);
  }
  const stat = await fs.stat(candidateReal);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a nonempty file`);
  return candidateReal;
}

async function canonicalRunRoot(repoRoot, runRoot) {
  const repo = await fs.realpath(path.resolve(repoRoot));
  const rawBase = path.join(repo, ".superpowers/quality-forward/runs");
  const rawBaseReal = await fs.realpath(rawBase);
  const resolved = path.resolve(runRoot);
  if (
    path.dirname(resolved) !== rawBaseReal
    || !/^\d{8}T\d{6}(?:\d{3})?Z$/.test(path.basename(resolved))
  ) {
    throw new Error("run root must be inside repository .superpowers/quality-forward/runs/<timestamp>");
  }
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error("run root must not be a symbolic link");
  if (!stat.isDirectory()) throw new Error("run root must be a directory");
  if (await fs.realpath(resolved) !== resolved) {
    throw new Error("run root must resolve to its canonical repository path");
  }
  return { repo, runs: resolved };
}

async function containsPptxArtifact(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`scenario evidence must not contain symbolic links: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      if (await containsPptxArtifact(entryPath)) return true;
    } else if (entry.isFile() && /\.pptx$/i.test(entry.name)) {
      return true;
    }
  }
  return false;
}

function assertFacts(facts, rule, label) {
  requireObject(facts, `${label} facts`);
  for (const [key, expected] of Object.entries(rule.equals ?? {})) {
    if (JSON.stringify(facts[key]) !== JSON.stringify(expected)) {
      throw new Error(`${label} file evidence does not support ${key}`);
    }
  }
  for (const [key, expectedItems] of Object.entries(rule.includes ?? {})) {
    if (!Array.isArray(facts[key])) throw new Error(`${label} ${key} must be an array`);
    for (const expected of expectedItems) {
      if (!facts[key].includes(expected)) throw new Error(`${label} file evidence is missing ${key}=${expected}`);
    }
  }
}

async function currentAgentForwardTree(repoRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD:tests/agent-forward"],
    { cwd: repoRoot },
  );
  const value = `git-tree:${stdout.trim()}`;
  if (!GIT_TREE.test(value)) throw new Error("git rev-parse HEAD:tests/agent-forward returned an invalid tree hash");
  return value;
}

async function currentDiffSha256(repoRoot) {
  const [{ stdout: diffBytes }, { stdout: untrackedBytes }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const hash = crypto.createHash("sha256");
  hash.update("tracked-diff\0");
  hash.update(diffBytes);
  const untracked = untrackedBytes.toString("utf8").split("\0").filter(Boolean).sort();
  for (const relativePath of untracked) {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(absolutePath);
    hash.update("\0untracked\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(stat.isSymbolicLink() ? await fs.readlink(absolutePath) : await fs.readFile(absolutePath));
  }
  return `sha256:${hash.digest("hex")}`;
}

function plausibleShortRefName(value) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && value.length <= 255
    && value !== "HEAD"
    && !value.startsWith("-")
    && !value.startsWith("refs/")
    && !value.startsWith("@{")
    && !/[\u0000-\u0020\u007f]/.test(value);
}

export function resolveGithubActionsRef(environment, headSha) {
  if (environment?.GITHUB_ACTIONS !== "true"
    || typeof environment.GITHUB_WORKSPACE !== "string"
    || !environment.GITHUB_WORKSPACE.trim()
    || !GIT_COMMIT.test(headSha)) {
    return null;
  }
  if (environment.GITHUB_EVENT_NAME === "workflow_dispatch"
    && typeof environment.INPUT_TAG === "string") {
    const tag = environment.INPUT_TAG;
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)
      || environment.VERIFIED_TAG_COMMIT !== headSha
      || !GIT_COMMIT.test(environment.VERIFIED_TAG_OBJECT || "")) {
      return null;
    }
    return { name: tag, fullRef: `refs/tags/${tag}` };
  }
  if (environment.GITHUB_SHA !== headSha) return null;
  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(environment.GITHUB_REF || "");
    const headRef = environment.GITHUB_HEAD_REF;
    if (!match
      || environment.GITHUB_REF_TYPE !== "branch"
      || environment.GITHUB_REF_NAME !== `${match[1]}/merge`
      || !plausibleShortRefName(headRef)) {
      return null;
    }
    return { name: headRef, fullRef: `refs/heads/${headRef}` };
  }
  if (!["push", "workflow_dispatch"].includes(environment.GITHUB_EVENT_NAME)) return null;
  const refType = environment.GITHUB_REF_TYPE;
  const name = environment.GITHUB_REF_NAME;
  if (!plausibleShortRefName(name) || !["branch", "tag"].includes(refType)) return null;
  const fullRef = `refs/${refType === "branch" ? "heads" : "tags"}/${name}`;
  if (environment.GITHUB_REF !== fullRef) return null;
  return { name, fullRef };
}

export async function resolveImplementationRef(repoRoot, environment = process.env) {
  const repo = await fs.realpath(path.resolve(repoRoot));
  const [{ stdout: branch }, { stdout: head }] = await Promise.all([
    execFileAsync("git", ["branch", "--show-current"], { cwd: repo }),
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }),
  ]);
  const branchName = branch.trim();
  const headSha = head.trim();
  if (branchName) return branchName;

  const githubRef = resolveGithubActionsRef(environment, headSha);
  if (!githubRef) {
    throw new Error("quality-forward verification requires a named Git branch or verified GitHub ref");
  }
  let githubWorkspace;
  try {
    githubWorkspace = await fs.realpath(environment.GITHUB_WORKSPACE);
  } catch {
    throw new Error("quality-forward GitHub workspace is unavailable");
  }
  if (githubWorkspace !== repo) {
    throw new Error("quality-forward GitHub workspace does not match the repository");
  }
  try {
    await execFileAsync("git", ["check-ref-format", githubRef.fullRef], { cwd: repo });
  } catch {
    throw new Error("quality-forward GitHub ref name is invalid");
  }

  let checkoutRef;
  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    checkoutRef = `refs/remotes/pull/${environment.GITHUB_REF_NAME}^{commit}`;
  } else if (githubRef.fullRef.startsWith("refs/heads/")) {
    checkoutRef = `refs/remotes/origin/${githubRef.name}^{commit}`;
  } else {
    checkoutRef = `${githubRef.fullRef}^{commit}`;
  }
  let checkoutSha;
  try {
    ({ stdout: checkoutSha } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", checkoutRef],
      { cwd: repo },
    ));
  } catch {
    throw new Error("quality-forward GitHub ref is not present in the checkout");
  }
  if (checkoutSha.trim() !== headSha) {
    throw new Error("quality-forward GitHub ref does not match HEAD");
  }
  if (githubRef.fullRef.startsWith("refs/tags/")) {
    const [{ stdout: objectType }, { stdout: objectSha }] = await Promise.all([
      execFileAsync("git", ["cat-file", "-t", githubRef.fullRef], { cwd: repo }),
      execFileAsync("git", ["rev-parse", githubRef.fullRef], { cwd: repo }),
    ]);
    if (objectType.trim() !== "tag") {
      throw new Error("quality-forward GitHub tag must be annotated");
    }
    if (environment.VERIFIED_TAG_OBJECT
      && objectSha.trim() !== environment.VERIFIED_TAG_OBJECT) {
      throw new Error("quality-forward GitHub tag object does not match the verified tag");
    }
  }
  return githubRef.name;
}

export async function collectVisualQualityImplementationBinding(repoRoot) {
  const repo = await fs.realpath(path.resolve(repoRoot));
  const implementationInputHashes = {};
  for (const relativePath of IMPLEMENTATION_INPUTS) {
    const filePath = path.join(repo, relativePath);
    const fileReal = await fs.realpath(filePath);
    if (!fileReal.startsWith(`${repo}${path.sep}`)) {
      throw new Error(`implementation input escapes repository: ${relativePath}`);
    }
    implementationInputHashes[relativePath] = digest(await fs.readFile(fileReal));
  }
  const [branchName, diffSha256] = await Promise.all([
    resolveImplementationRef(repo),
    currentDiffSha256(repo),
  ]);
  return { branch: branchName, diffSha256, implementationInputHashes };
}

function assertImplementationBinding(recorded, current) {
  if (recorded.branch !== current.branch) throw new Error("implementation branch drift");
  if (!SHA256.test(recorded.diffSha256) || recorded.diffSha256 !== current.diffSha256) {
    throw new Error("implementation diff hash drift");
  }
  assertExactKeys(recorded.implementationInputHashes, IMPLEMENTATION_INPUTS, "implementation input hashes");
  for (const relativePath of IMPLEMENTATION_INPUTS) {
    const value = recorded.implementationInputHashes[relativePath];
    if (!SHA256.test(value) || value !== current.implementationInputHashes[relativePath]) {
      throw new Error(`implementation input hash drift: ${relativePath}`);
    }
  }
}

async function atomicWriteSummary(repoRoot, outputPath, summary) {
  const output = path.resolve(outputPath);
  const parent = path.dirname(output);
  const parentReal = await fs.realpath(parent);
  if (parentReal !== parent || (parentReal !== repoRoot && !parentReal.startsWith(`${repoRoot}${path.sep}`))) {
    throw new Error("summary output parent must be a canonical directory inside the repository");
  }
  try {
    const stat = await fs.lstat(output);
    if (stat.isSymbolicLink()) throw new Error("summary output must not be a symbolic link");
    if (!stat.isFile()) throw new Error("summary output must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    parentReal,
    `.${path.basename(output)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, output);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

export function validateVisualQualityPublicSummary(summary) {
  assertExactKeys(
    summary,
    ["artifactType", "schemaVersion", "evidenceRetention", "frozenAgentForwardTreeHash", "scenarios"],
    "public summary",
  );
  if (summary.artifactType !== "visualQualityHardeningSummary") throw new Error("public summary artifactType mismatch");
  if (summary.schemaVersion !== "1.0.0") throw new Error("public summary schemaVersion mismatch");
  if (summary.evidenceRetention !== "summary-and-hashes-only") throw new Error("public summary retention mismatch");
  if (!GIT_TREE.test(summary.frozenAgentForwardTreeHash)) throw new Error("public summary frozen tree hash is invalid");
  if (!Array.isArray(summary.scenarios) || summary.scenarios.length !== EXPECTED_IDS.length) {
    throw new Error("public summary must contain exactly three scenarios");
  }
  const ids = [];
  for (const scenario of summary.scenarios) {
    assertExactKeys(scenario, ["id", "verdict", "manifestSha256"], "public summary scenario");
    if (!EXPECTED_IDS.includes(scenario.id) || ids.includes(scenario.id)) throw new Error("public summary scenario ID mismatch");
    if (scenario.verdict !== "PASS") throw new Error("public summary may contain only PASS results");
    if (!SHA256.test(scenario.manifestSha256)) throw new Error("public summary manifest hash is invalid");
    ids.push(scenario.id);
  }
  if (EXPECTED_IDS.some((id) => !ids.includes(id))) throw new Error("public summary scenario coverage mismatch");
  const serialized = JSON.stringify(summary);
  if (/\.superpowers\/quality-forward\/runs|\.pptx|\.png|\/Users\/[^/]+\/|[A-Za-z]:\\\\Users\\\\/i.test(serialized)) {
    throw new Error("public summary contains a raw or private path");
  }
  return summary;
}

async function validateScenario({ runRoot, descriptor, scenario, rule, conditionalBuildEvidence }) {
  assertExactKeys(descriptor, ["id", "manifestPath"], "run manifest scenario descriptor");
  if (descriptor.id !== scenario.id) throw new Error("run manifest scenario ID drift");
  if (descriptor.manifestPath !== `${scenario.id}/manifest.json`) {
    throw new Error(`${scenario.id}: manifestPath must be ${scenario.id}/manifest.json`);
  }
  const manifestPath = await containedFile(runRoot, descriptor.manifestPath, `${scenario.id} manifest`);
  const manifestRecord = await readJsonBytes(manifestPath, `${scenario.id} manifest`);
  const manifest = manifestRecord.value;
  assertExactKeys(
    manifest,
    ["artifactType", "schemaVersion", "scenarioId", "route", "verdict", "outcome", "deckProduced", "evidence"],
    `${scenario.id} manifest`,
  );
  if (manifest.artifactType !== "visualQualityForwardScenarioManifest" || manifest.schemaVersion !== "1.0.0") {
    throw new Error(`${scenario.id}: scenario manifest type/version mismatch`);
  }
  if (manifest.scenarioId !== scenario.id || manifest.route !== scenario.route || manifest.route !== rule.route) {
    throw new Error(`${scenario.id}: scenario manifest identity mismatch`);
  }
  if (manifest.verdict !== "PASS") throw new Error(`${scenario.id}: only PASS scenario manifests can be summarized`);
  if (typeof manifest.deckProduced !== "boolean") throw new Error(`${scenario.id}: deckProduced must be boolean`);
  const scenarioRoot = path.dirname(manifestPath);
  const pptxPresent = await containsPptxArtifact(scenarioRoot);
  if (manifest.deckProduced !== pptxPresent) {
    throw new Error(`${scenario.id}: deckProduced does not match PPTX artifacts in the scenario directory`);
  }
  const outcomeRule = rule.outcomes?.[manifest.outcome];
  if (!outcomeRule || !scenario.acceptableOutcomes.includes(manifest.outcome)) {
    throw new Error(`${scenario.id}: unsupported outcome ${manifest.outcome}`);
  }
  if (!Array.isArray(manifest.evidence)) throw new Error(`${scenario.id}: evidence must be an array`);
  const evidenceById = new Map();
  for (const descriptorEntry of manifest.evidence) {
    assertExactKeys(descriptorEntry, ["id", "path", "sha256"], `${scenario.id} evidence descriptor`);
    if (evidenceById.has(descriptorEntry.id)) throw new Error(`${scenario.id}: duplicate evidence ${descriptorEntry.id}`);
    if (!SHA256.test(descriptorEntry.sha256)) throw new Error(`${scenario.id}: invalid evidence hash`);
    evidenceById.set(descriptorEntry.id, descriptorEntry);
  }
  const expectedRules = {
    ...outcomeRule.requiredEvidence,
    ...(manifest.deckProduced ? conditionalBuildEvidence : {}),
  };
  if (evidenceById.size !== Object.keys(expectedRules).length) {
    throw new Error(`${scenario.id}: evidence set does not match the selected outcome`);
  }
  for (const [evidenceId, evidenceRule] of Object.entries(expectedRules)) {
    const evidenceDescriptor = evidenceById.get(evidenceId);
    if (!evidenceDescriptor) throw new Error(`${scenario.id}: missing file evidence ${evidenceId}`);
    const evidencePath = await containedFile(scenarioRoot, evidenceDescriptor.path, `${scenario.id}/${evidenceId}`);
    const evidenceRecord = await readJsonBytes(evidencePath, `${scenario.id}/${evidenceId}`);
    if (digest(evidenceRecord.bytes) !== evidenceDescriptor.sha256) {
      throw new Error(`${scenario.id}/${evidenceId}: evidence hash mismatch`);
    }
    const evidence = evidenceRecord.value;
    assertExactKeys(
      evidence,
      ["artifactType", "schemaVersion", "scenarioId", "evidenceId", "status", "facts"],
      `${scenario.id}/${evidenceId}`,
    );
    if (
      evidence.artifactType !== "visualQualityForwardEvidence"
      || evidence.schemaVersion !== "1.0.0"
      || evidence.scenarioId !== scenario.id
      || evidence.evidenceId !== evidenceId
      || evidence.status !== "PASS"
    ) {
      throw new Error(`${scenario.id}/${evidenceId}: evidence identity or status mismatch`);
    }
    assertFacts(evidence.facts, evidenceRule, `${scenario.id}/${evidenceId}`);
  }
  return {
    id: scenario.id,
    verdict: "PASS",
    manifestSha256: digest(manifestRecord.bytes),
  };
}

export async function summarizeVisualQualityRun({ repoRoot, runRoot, outputPath }) {
  const { repo, runs } = await canonicalRunRoot(repoRoot, runRoot);
  const runManifestLexicalPath = path.join(runs, "run-manifest.json");
  const runManifestStat = await fs.lstat(runManifestLexicalPath);
  if (runManifestStat.isSymbolicLink()) throw new Error("run manifest must not be a symbolic link");
  const runManifestPath = await containedFile(runs, "run-manifest.json", "run manifest");
  const [{ value: scenarioDocument }, { value: rubric }, { value: runManifest }, currentImplementation] = await Promise.all([
    readJsonBytes(path.join(SCRIPT_DIR, "scenarios.json"), "scenarios"),
    readJsonBytes(path.join(SCRIPT_DIR, "rubric.json"), "rubric"),
    readJsonBytes(runManifestPath, "run manifest"),
    collectVisualQualityImplementationBinding(repo),
  ]);
  assertExactKeys(
    runManifest,
    [
      "artifactType",
      "schemaVersion",
      "frozenAgentForwardTreeHashBefore",
      "frozenAgentForwardTreeHashAfter",
      "branch",
      "diffSha256",
      "implementationInputHashes",
      "scenarios",
    ],
    "run manifest",
  );
  if (runManifest.artifactType !== "visualQualityForwardRunManifest" || runManifest.schemaVersion !== "1.0.0") {
    throw new Error("run manifest type/version mismatch");
  }
  const before = runManifest.frozenAgentForwardTreeHashBefore;
  const after = runManifest.frozenAgentForwardTreeHashAfter;
  if (!GIT_TREE.test(before) || !GIT_TREE.test(after) || before !== after) {
    throw new Error("frozen agent-forward tree before/after mismatch");
  }
  assertImplementationBinding(runManifest, currentImplementation);
  const current = await currentAgentForwardTree(repo);
  if (current !== before) throw new Error("frozen agent-forward tree does not match current HEAD tree");
  if (!Array.isArray(runManifest.scenarios) || runManifest.scenarios.length !== EXPECTED_IDS.length) {
    throw new Error("run manifest must contain exactly three scenarios");
  }
  const descriptorById = new Map(runManifest.scenarios.map((entry) => [entry.id, entry]));
  if (descriptorById.size !== EXPECTED_IDS.length) throw new Error("run manifest contains duplicate scenarios");
  const scenarioById = new Map(scenarioDocument.scenarios.map((entry) => [entry.id, entry]));
  const publicScenarios = [];
  for (const id of EXPECTED_IDS) {
    const descriptor = descriptorById.get(id);
    const scenario = scenarioById.get(id);
    const rule = rubric.scenarios?.[id];
    if (!descriptor || !scenario || !rule) throw new Error(`missing contract for scenario ${id}`);
    publicScenarios.push(await validateScenario({
      runRoot: runs,
      descriptor,
      scenario,
      rule,
      conditionalBuildEvidence: rubric.conditionalBuildEvidence,
    }));
  }
  const summary = validateVisualQualityPublicSummary({
    artifactType: "visualQualityHardeningSummary",
    schemaVersion: "1.0.0",
    evidenceRetention: "summary-and-hashes-only",
    frozenAgentForwardTreeHash: current,
    scenarios: publicScenarios,
  });
  await atomicWriteSummary(repo, outputPath, summary);
  return summary;
}

async function runCli(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log("Usage: summarize.mjs --repo ROOT --run-root DIR --output FILE");
    return;
  }
  await summarizeVisualQualityRun({
    repoRoot: readFlag(argv, "--repo"),
    runRoot: readFlag(argv, "--run-root"),
    outputPath: readFlag(argv, "--output"),
  });
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
