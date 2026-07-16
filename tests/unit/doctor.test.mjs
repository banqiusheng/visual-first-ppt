import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  candidateDiscoveryRoots,
  compareVersion,
  overallStatus,
  parseVersion,
  runChecks,
} from "../../skills/visual-first-ppt/scripts/doctor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DOCTOR = path.join(ROOT, "skills/visual-first-ppt/scripts/doctor.mjs");
const REAL_SKILL_ROOT = path.join(ROOT, "skills/visual-first-ppt");
const TEMP_ROOTS = [];

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/generation-contract.md",
  "references/intake-and-research.md",
  "references/qa-and-delivery.md",
  "references/themes.md",
  "references/workflow.md",
  "scripts/build-qa-report.mjs",
  "scripts/compare_untouched_slides.py",
  "scripts/package_delivery.py",
  "scripts/project-state.mjs",
  "scripts/verify_handoff_paths.py",
  "assets/theme-catalog.json",
];

after(() => {
  for (const tempRoot of TEMP_ROOTS) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-first-ppt-doctor-"));
  TEMP_ROOTS.push(tempRoot);
  return tempRoot;
}

function makeSkillRoot({ omit = [] } = {}) {
  const skillRoot = path.join(makeTempRoot(), "visual-first-ppt");
  for (const relativePath of REQUIRED_SKILL_FILES) {
    if (omit.includes(relativePath)) continue;
    const absolutePath = path.join(skillRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${relativePath}\n`, "utf8");
  }
  return skillRoot;
}

function exposeCapabilities(codexHome, names) {
  const skillsRoot = path.join(codexHome, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const name of names) {
    const relativePath = name === "imagegen"
      ? path.join(".system", "imagegen", "SKILL.md")
      : path.join(name.toLowerCase(), "SKILL.md");
    const skillFile = path.join(skillsRoot, relativePath);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `# ${name}\n`, "utf8");
  }
  return skillsRoot;
}

function doctorEnv({
  home = makeTempRoot(),
  codexHome,
  nodeVersion = "v22.14.0",
  pythonCommands = { python3: "Python 3.11.9" },
} = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PWD: ROOT,
    VISUAL_FIRST_PPT_TEST_HOME: home,
    VISUAL_FIRST_PPT_TEST_NODE_VERSION: nodeVersion,
    VISUAL_FIRST_PPT_TEST_PYTHON_COMMANDS: JSON.stringify(pythonCommands),
  };
  delete env.CODEX_HOME;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  return env;
}

function runDoctor({ skillRoot = REAL_SKILL_ROOT, env = doctorEnv(), args = [] } = {}) {
  return spawnSync(
    process.execPath,
    [DOCTOR, "--json", "--skill-root", skillRoot, ...args],
    { cwd: ROOT, encoding: "utf8", env },
  );
}

function parseDoctorJson(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function checkById(report, id) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

test("version helpers parse common runtime output and compare padded versions", () => {
  assert.deepEqual(parseVersion("v20.11.1"), [20, 11, 1]);
  assert.deepEqual(parseVersion("Python 3.10.14"), [3, 10, 14]);
  assert.equal(parseVersion("not a version"), null);
  assert.equal(compareVersion([20], [20, 0, 0]), 0);
  assert.equal(compareVersion([3, 9, 18], [3, 10]), -1);
  assert.equal(compareVersion([22, 1], [20]), 1);
});

test("candidate discovery roots are bounded to approved locations", () => {
  const tempRoot = makeTempRoot();
  const home = path.join(tempRoot, "home");
  const codexHome = path.join(tempRoot, "codex-home");
  const repoRoot = path.join(tempRoot, "repo");
  const nested = path.join(repoRoot, "packages", "example");
  const repoAgentsSkills = path.join(repoRoot, ".agents", "skills");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(repoAgentsSkills, { recursive: true });

  assert.deepEqual(
    candidateDiscoveryRoots({ CODEX_HOME: codexHome, PWD: nested }, home),
    [
      path.join(codexHome, "skills"),
      path.join(home, ".codex", "skills"),
      path.join(home, ".agents", "skills"),
      repoAgentsSkills,
    ],
  );
});

test("overall status gives FAIL precedence over WARN and PASS", () => {
  assert.equal(overallStatus([{ status: "PASS" }]), "PASS");
  assert.equal(overallStatus([{ status: "PASS" }, { status: "WARN" }]), "WARN");
  assert.equal(overallStatus([{ status: "WARN" }, { status: "FAIL" }]), "FAIL");
});

test("--help documents the read-only doctor interface", () => {
  const result = spawnSync(process.execPath, [DOCTOR, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /usage:/i);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--skill-root PATH/);
  assert.match(result.stdout, /read-only/i);
});

test("a copied doctor still executes when macOS resolves a temporary path alias", () => {
  const copiedRoot = path.join(makeTempRoot(), "visual-first-ppt", "scripts");
  const copiedDoctor = path.join(copiedRoot, "doctor.mjs");
  fs.mkdirSync(copiedRoot, { recursive: true });
  fs.copyFileSync(DOCTOR, copiedDoctor);

  const result = spawnSync(process.execPath, [copiedDoctor, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--skill-root PATH/);
});

test("a complete Skill and explicitly exposed capabilities return PASS and exit 0", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations", "imagegen"]);
  const result = runDoctor({ env: doctorEnv({ codexHome }) });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, "PASS");
  assert.equal(checkById(report, "skill-files").status, "PASS");
  assert.equal(checkById(report, "node").status, "PASS");
  assert.equal(checkById(report, "python").status, "PASS");
  assert.equal(checkById(report, "capability-presentations").status, "PASS");
  assert.equal(checkById(report, "capability-imagegen").status, "PASS");
});

test("a missing SKILL.md returns FAIL and exit 1", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations", "imagegen"]);
  const result = runDoctor({
    skillRoot: makeSkillRoot({ omit: ["SKILL.md"] }),
    env: doctorEnv({ codexHome }),
  });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.status, "FAIL");
  assert.equal(checkById(report, "skill-files").status, "FAIL");
  assert.match(checkById(report, "skill-files").detail, /SKILL\.md/);
});

test("a substituted Node.js version below 20 returns FAIL", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations", "imagegen"]);
  const result = runDoctor({ env: doctorEnv({ codexHome, nodeVersion: "v18.20.8" }) });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(checkById(report, "node").status, "FAIL");
});

test("no substituted Python command returns FAIL", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations", "imagegen"]);
  const result = runDoctor({ env: doctorEnv({ codexHome, pythonCommands: {} }) });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(checkById(report, "python").status, "FAIL");
  assert.match(checkById(report, "python").nextAction, /Python 3\.10/);
});

test("Python 3.9 is present but incompatible and returns FAIL", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations", "imagegen"]);
  const result = runDoctor({
    env: doctorEnv({ codexHome, pythonCommands: { python3: "Python 3.9.19" } }),
  });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(checkById(report, "python").status, "FAIL");
  assert.match(checkById(report, "python").detail, /3\.9\.19/);
});

test("capabilities not exposed by the runtime return WARN and exit 2", () => {
  const result = runDoctor({ env: doctorEnv() });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(report.status, "WARN");
  assert.equal(checkById(report, "capability-presentations").status, "WARN");
  assert.equal(checkById(report, "capability-imagegen").status, "WARN");
  assert.match(checkById(report, "capability-imagegen").detail, /not expose/i);
});

test("the explicit Skill root is an approved capability discovery root", () => {
  const skillRoot = makeSkillRoot();
  for (const relativePath of [
    path.join("presentations", "SKILL.md"),
    path.join(".system", "imagegen", "SKILL.md"),
  ]) {
    const capabilityFile = path.join(skillRoot, relativePath);
    fs.mkdirSync(path.dirname(capabilityFile), { recursive: true });
    fs.writeFileSync(capabilityFile, "# test capability\n", "utf8");
  }

  const result = runDoctor({ skillRoot, env: doctorEnv() });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, "PASS");
  assert.equal(checkById(report, "capability-presentations").status, "PASS");
  assert.equal(checkById(report, "capability-imagegen").status, "PASS");
  assert.equal(new Set(report.discoveryRoots).size, report.discoveryRoots.length);
});

test("an explicitly exposed capability root with a missing capability returns FAIL", () => {
  const codexHome = path.join(makeTempRoot(), "codex-home");
  exposeCapabilities(codexHome, ["presentations"]);
  const result = runDoctor({ env: doctorEnv({ codexHome }) });
  const report = parseDoctorJson(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.status, "FAIL");
  assert.equal(checkById(report, "capability-presentations").status, "PASS");
  assert.equal(checkById(report, "capability-imagegen").status, "FAIL");
  assert.match(checkById(report, "capability-imagegen").detail, /CODEX_HOME/);
});

test("runChecks honors an injected spawn implementation without writing state", () => {
  const skillRoot = makeSkillRoot();
  const home = makeTempRoot();
  const spawnCalls = [];
  const checks = runChecks({
    skillRoot,
    home,
    env: { PWD: ROOT, VISUAL_FIRST_PPT_TEST_NODE_VERSION: "v20.0.0" },
    spawnSyncImpl(command, args) {
      spawnCalls.push([command, args]);
      if (command === "python3") {
        return { status: 0, stdout: "Python 3.10.0\n", stderr: "" };
      }
      return { status: 127, stdout: "", stderr: "not found" };
    },
  });

  assert.deepEqual(spawnCalls, [["python3", ["--version"]]]);
  assert.equal(checks.find((check) => check.id === "python").status, "PASS");
});

test("JSON normalizes HOME to ~ and redacts other personal absolute paths", () => {
  const usersRoot = path.join(path.parse(ROOT).root, "Users");
  const fakeHome = path.join(usersRoot, "doctor-home-person");
  const otherPersonCodexHome = path.join(usersRoot, "other-person", ".codex");
  const env = doctorEnv({ home: fakeHome, codexHome: otherPersonCodexHome });
  const result = runDoctor({
    skillRoot: path.join(fakeHome, "skills", "visual-first-ppt"),
    env,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /doctor-home-person/);
  assert.doesNotMatch(result.stdout, /other-person/);
  assert.match(result.stdout, /~\/skills\/visual-first-ppt/);
  const report = parseDoctorJson(result);
  assert.ok(report.discoveryRoots.every((root) => typeof root === "string"));
});
