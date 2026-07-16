import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const INSTALLER = process.env.VISUAL_FIRST_PPT_INSTALLER_UNDER_TEST
  ?? path.join(ROOT, "scripts/install-skill.sh");
const SOURCE_SKILL = path.join(ROOT, "skills/visual-first-ppt");
const TEMP_ROOTS = [];

after(() => {
  for (const tempRoot of TEMP_ROOTS) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-first-ppt-install-"));
  TEMP_ROOTS.push(tempRoot);
  return tempRoot;
}

function isolatedEnv({ home = makeTempRoot(), codexHome, explicitRoot } = {}) {
  const env = { ...process.env, HOME: home };
  delete env.CODEX_HOME;
  delete env.VISUAL_FIRST_PPT_SKILLS_DIR;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  if (explicitRoot !== undefined) env.VISUAL_FIRST_PPT_SKILLS_DIR = explicitRoot;
  return env;
}

function runInstaller({ installer = INSTALLER, args = [], env = isolatedEnv() } = {}) {
  return spawnSync(installer, args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

function makeNodeShim({
  exitStatus,
  doctorOutput = '{"status":"FAIL","checks":[]}\n',
  delegate = false,
} = {}) {
  const shimRoot = makeTempRoot();
  const shim = path.join(shimRoot, "node");
  const callLog = path.join(makeTempRoot(), "node-args.log");
  const callCount = path.join(makeTempRoot(), "node-call-count.txt");
  const doctorOutputFile = path.join(makeTempRoot(), "doctor-output.txt");
  fs.writeFileSync(doctorOutputFile, doctorOutput, "utf8");
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(callLog)}`,
    `call_count_file=${JSON.stringify(callCount)}`,
    `doctor_output_file=${JSON.stringify(doctorOutputFile)}`,
    `real_node=${JSON.stringify(process.execPath)}`,
    "call_number=1",
    "if [[ -f \"$call_count_file\" ]]; then",
    "  read -r previous_call_number < \"$call_count_file\"",
    "  call_number=$((previous_call_number + 1))",
    "fi",
    "printf '%s\\n' \"$call_number\" > \"$call_count_file\"",
    "if (( call_number == 1 )); then",
    "  printf '%s\\n' \"$@\" > \"$call_log\"",
  ];
  if (delegate) {
    lines.push('  exec "$real_node" "$@"');
  } else {
    lines.push('  cat "$doctor_output_file"', `  exit ${exitStatus ?? 1}`);
  }
  lines.push("fi", 'exec "$real_node" "$@"', "");
  fs.writeFileSync(shim, lines.join("\n"), "utf8");
  fs.chmodSync(shim, 0o755);
  return { shimRoot, callLog };
}

function doctorEvidence({ status = "PASS", checks } = {}) {
  return `${JSON.stringify({
    status,
    checks: checks ?? ["skill-files", "node", "python"].map((id) => ({
      id,
      status: "PASS",
    })),
  }, null, 2)}\n`;
}

function assertDoctorEvidenceRejected(result, destination) {
  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /INSTALLATION_VERIFICATION_FAILED/);
  assert.doesNotMatch(result.stdout, /INSTALLED_FILES_VERIFIED/);
  assert.equal(fs.existsSync(destination), false);
}

function snapshotTree(root) {
  const snapshot = [];

  function visit(current, relative = "") {
    for (const name of fs.readdirSync(current).sort()) {
      const absolutePath = path.join(current, name);
      const relativePath = relative ? path.join(relative, name) : name;
      const stat = fs.lstatSync(absolutePath);

      if (stat.isDirectory()) {
        snapshot.push({ path: relativePath, type: "directory" });
        visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        snapshot.push({
          path: relativePath,
          type: "symlink",
          target: fs.readlinkSync(absolutePath),
        });
      } else {
        snapshot.push({
          path: relativePath,
          type: "file",
          content: fs.readFileSync(absolutePath).toString("base64"),
        });
      }
    }
  }

  visit(root);
  return snapshot;
}

function snapshotPath(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return { type: "missing" };
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return { type: "symlink", target: fs.readlinkSync(target) };
  }
  if (stat.isDirectory()) {
    return { type: "directory", entries: snapshotTree(target) };
  }
  return {
    type: "file",
    content: fs.readFileSync(target).toString("base64"),
  };
}

function makeFakeRepo({ skillEntry = "missing" } = {}) {
  const fakeRoot = makeTempRoot();
  const fakeInstaller = path.join(fakeRoot, "scripts/install-skill.sh");
  const fakeSkill = path.join(fakeRoot, "skills/visual-first-ppt");
  fs.mkdirSync(path.dirname(fakeInstaller), { recursive: true });
  fs.mkdirSync(fakeSkill, { recursive: true });
  fs.copyFileSync(INSTALLER, fakeInstaller);
  fs.chmodSync(fakeInstaller, 0o755);

  if (skillEntry === "regular") {
    fs.writeFileSync(path.join(fakeSkill, "SKILL.md"), "# fixture\n", "utf8");
  } else if (skillEntry === "escaping-symlink") {
    const externalEntry = path.join(fakeRoot, "skills/external-skill.md");
    fs.writeFileSync(externalEntry, "# external fixture\n", "utf8");
    fs.symlinkSync("../external-skill.md", path.join(fakeSkill, "SKILL.md"));
  }

  return { fakeInstaller, fakeRoot };
}

test("installer is executable and copies only the Skill to an explicit target root", () => {
  const explicitRoot = path.join(makeTempRoot(), "explicit-skills");
  const codexHome = path.join(makeTempRoot(), "codex-home");
  const home = makeTempRoot();
  const result = runInstaller({
    env: isolatedEnv({ home, codexHome, explicitRoot }),
  });
  const destination = path.join(explicitRoot, "visual-first-ppt");

  assert.notEqual(fs.statSync(INSTALLER).mode & 0o111, 0, "installer must be executable");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readdirSync(explicitRoot), ["visual-first-ppt"]);
  assert.deepEqual(snapshotTree(destination), snapshotTree(SOURCE_SKILL));
  assert.equal(fs.existsSync(path.join(codexHome, "skills/visual-first-ppt")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex/skills/visual-first-ppt")), false);
  assert.match(result.stdout, /INSTALLED_FILES_VERIFIED/);
  assert.match(result.stdout, /"status": "(?:PASS|WARN)"/);
  assert.match(result.stdout, /SETUP_VERIFICATION_REQUIRED/);
  assert.doesNotMatch(result.stdout, /^INSTALLED:/m);
  assert.doesNotMatch(result.stdout, /^SETUP_VERIFIED:/m);
  assert.match(result.stdout, /next Codex turn[\s\S]*\$visual-first-ppt/i);
  assert.match(result.stdout, /not discovered[\s\S]*new Codex task/i);
});

test("installer runs doctor against the copied destination before reporting file verification", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot, callLog } = makeNodeShim({ delegate: true });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;
  env.VISUAL_FIRST_PPT_NODE_LOG = callLog;
  env.VISUAL_FIRST_PPT_REAL_NODE = process.execPath;

  const result = runInstaller({ env });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(callLog, "utf8").trim().split("\n"), [
    path.join(destination, "scripts/doctor.mjs"),
    "--skill-root",
    destination,
    "--json",
  ]);
  assert.match(result.stdout, /INSTALLED_FILES_VERIFIED/);
  assert.match(result.stdout, /DOCTOR_EXIT_CODE: [02]/);
});

test("doctor failure removes only the destination created by this installer run", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot, callLog } = makeNodeShim({ exitStatus: 1 });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;
  env.VISUAL_FIRST_PPT_NODE_LOG = callLog;

  const result = runInstaller({ env });

  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /INSTALLATION_VERIFICATION_FAILED/);
  assert.doesNotMatch(result.stdout, /INSTALLED_FILES_VERIFIED/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readFileSync(callLog, "utf8").trim().split("\n"), [
    path.join(destination, "scripts/doctor.mjs"),
    "--skill-root",
    destination,
    "--json",
  ]);
});

test("installer rejects a zero exit when doctor output does not prove PASS or WARN", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot } = makeNodeShim({ exitStatus: 0 });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;
  env.VISUAL_FIRST_PPT_NODE_LOG = path.join(makeTempRoot(), "node-args.log");

  const result = runInstaller({ env });

  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /INSTALLATION_VERIFICATION_FAILED/);
  assert.equal(fs.existsSync(destination), false);
});

test("installer rejects invalid JSON even when it contains a PASS substring", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot } = makeNodeShim({
    exitStatus: 0,
    doctorOutput: 'not-json {"status": "PASS"}\n',
  });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;

  const result = runInstaller({ env });

  assertDoctorEvidenceRejected(result, destination);
});

test("installer rejects PASS evidence that omits required checks", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot } = makeNodeShim({
    exitStatus: 0,
    doctorOutput: doctorEvidence({
      checks: [{ id: "skill-files", status: "PASS" }],
    }),
  });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;

  const result = runInstaller({ env });

  assertDoctorEvidenceRejected(result, destination);
});

test("installer rejects doctor exit and top-level status mismatches", async (t) => {
  const cases = [
    {
      name: "exit 0 with WARN",
      exitStatus: 0,
      doctorOutput: doctorEvidence({ status: "WARN" }),
    },
    {
      name: "exit 2 with PASS",
      exitStatus: 2,
      doctorOutput: doctorEvidence({
        checks: [
          ...["skill-files", "node", "python"].map((id) => ({ id, status: "PASS" })),
          { id: "capability-presentations", status: "WARN" },
        ],
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const explicitRoot = path.join(makeTempRoot(), "skills");
      const destination = path.join(explicitRoot, "visual-first-ppt");
      const { shimRoot } = makeNodeShim(scenario);
      const env = isolatedEnv({ explicitRoot });
      env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;

      const result = runInstaller({ env });

      assertDoctorEvidenceRejected(result, destination);
    });
  }
});

test("installer rejects evidence containing any FAIL check", () => {
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const { shimRoot } = makeNodeShim({
    exitStatus: 0,
    doctorOutput: doctorEvidence({
      checks: [
        ...["skill-files", "node", "python"].map((id) => ({ id, status: "PASS" })),
        { id: "capability-presentations", status: "FAIL" },
      ],
    }),
  });
  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;

  const result = runInstaller({ env });

  assertDoctorEvidenceRejected(result, destination);
});

test("CODEX_HOME/skills is used when no explicit target root is set", () => {
  const home = makeTempRoot();
  const codexHome = path.join(makeTempRoot(), "codex-home");
  const result = runInstaller({ env: isolatedEnv({ home, codexHome }) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.statSync(path.join(codexHome, "skills/visual-first-ppt/SKILL.md")).isFile(),
    true,
  );
  assert.equal(fs.existsSync(path.join(home, ".codex/skills/visual-first-ppt")), false);
});

test("HOME/.codex/skills is the final default and remains isolated in tests", () => {
  const home = makeTempRoot();
  const result = runInstaller({ env: isolatedEnv({ home }) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.statSync(path.join(home, ".codex/skills/visual-first-ppt/SKILL.md")).isFile(),
    true,
  );
});

test("every existing destination type returns exit 3 and remains unchanged", async (t) => {
  const cases = [
    {
      name: "ordinary directory with sentinel",
      setup(destination) {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, "keep-me.txt"), "directory sentinel\n", "utf8");
        return [];
      },
    },
    {
      name: "ordinary file",
      setup(destination) {
        fs.writeFileSync(destination, "existing file destination\n", "utf8");
        return [];
      },
    },
    {
      name: "valid symlink",
      setup(destination) {
        const externalTarget = path.join(makeTempRoot(), "valid-external-target");
        fs.mkdirSync(externalTarget, { recursive: true });
        fs.writeFileSync(path.join(externalTarget, "outside.txt"), "external sentinel\n", "utf8");
        fs.symlinkSync(externalTarget, destination);
        return [externalTarget];
      },
    },
    {
      name: "broken symlink",
      setup(destination) {
        const externalTarget = path.join(makeTempRoot(), "missing-external-target");
        fs.symlinkSync(externalTarget, destination);
        return [externalTarget];
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const explicitRoot = path.join(makeTempRoot(), "skills");
      const destination = path.join(explicitRoot, "visual-first-ppt");
      fs.mkdirSync(explicitRoot, { recursive: true });
      const externalTargets = scenario.setup(destination);
      const beforeDestination = snapshotPath(destination);
      const beforeExternalTargets = externalTargets.map(snapshotPath);

      const result = runInstaller({ env: isolatedEnv({ explicitRoot }) });

      assert.equal(result.status, 3, result.stderr || result.stdout);
      assert.match(`${result.stdout}\n${result.stderr}`, /EXISTING_INSTALLATION/);
      assert.deepEqual(snapshotPath(destination), beforeDestination);
      assert.deepEqual(externalTargets.map(snapshotPath), beforeExternalTargets);
    });
  }
});

test("a destination created during the atomic mkdir race is preserved and returns exit 3", () => {
  const realMkdir = ["/bin/mkdir", "/usr/bin/mkdir"].find((candidate) => fs.existsSync(candidate));
  assert.ok(realMkdir, "a system mkdir binary is required for the race shim");

  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  const shimRoot = makeTempRoot();
  const shim = path.join(shimRoot, "mkdir");
  const callLog = path.join(makeTempRoot(), "mkdir-calls.log");
  fs.writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$VISUAL_FIRST_PPT_RACE_LOG\"",
      "if [[ \"${1:-}\" == \"-p\" ]]; then",
      "  exec \"$VISUAL_FIRST_PPT_REAL_MKDIR\" \"$@\"",
      "fi",
      "if [[ \"$#\" -eq 1 && \"$1\" == \"$VISUAL_FIRST_PPT_RACE_DESTINATION\" ]]; then",
      "  \"$VISUAL_FIRST_PPT_REAL_MKDIR\" \"$1\"",
      "  printf '%s\\n' 'race sentinel' > \"$1/race-sentinel.txt\"",
      "  exit 73",
      "fi",
      "exec \"$VISUAL_FIRST_PPT_REAL_MKDIR\" \"$@\"",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(shim, 0o755);

  const env = isolatedEnv({ explicitRoot });
  env.PATH = `${shimRoot}${path.delimiter}${env.PATH ?? ""}`;
  env.VISUAL_FIRST_PPT_REAL_MKDIR = realMkdir;
  env.VISUAL_FIRST_PPT_RACE_DESTINATION = destination;
  env.VISUAL_FIRST_PPT_RACE_LOG = callLog;

  const result = runInstaller({ env });

  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /EXISTING_INSTALLATION/);
  assert.deepEqual(snapshotPath(destination), {
    type: "directory",
    entries: [{
      path: "race-sentinel.txt",
      type: "file",
      content: Buffer.from("race sentinel\n").toString("base64"),
    }],
  });
  assert.equal(fs.existsSync(path.join(destination, "SKILL.md")), false);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CLEANUP_FAILED/);
  assert.deepEqual(
    fs.readFileSync(callLog, "utf8").trim().split("\n"),
    [`-p ${explicitRoot}`, destination],
  );
});

test("a missing source SKILL.md returns exit 4 without deleting a pre-existing target", () => {
  const { fakeInstaller } = makeFakeRepo({ skillEntry: "missing" });
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "keep-me.txt"), "preserve\n", "utf8");
  const before = snapshotTree(destination);

  const result = runInstaller({
    installer: fakeInstaller,
    env: isolatedEnv({ explicitRoot }),
  });

  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /INVALID_SOURCE/);
  assert.deepEqual(snapshotTree(destination), before);
});

test("a failed post-copy SKILL.md check removes only the destination acquired by this run", () => {
  const { fakeInstaller } = makeFakeRepo({ skillEntry: "escaping-symlink" });
  const explicitRoot = path.join(makeTempRoot(), "skills");
  const destination = path.join(explicitRoot, "visual-first-ppt");

  const result = runInstaller({
    installer: fakeInstaller,
    env: isolatedEnv({ explicitRoot }),
  });

  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /INVALID_INSTALLATION/);
  assert.equal(fs.existsSync(destination), false);
});

test("every argument is rejected before installation, including force and upgrade flags", () => {
  for (const argument of ["--force", "--upgrade", "unexpected"]) {
    const explicitRoot = path.join(makeTempRoot(), "skills");
    const result = runInstaller({
      args: [argument],
      env: isolatedEnv({ explicitRoot }),
    });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /UNSUPPORTED_ARGUMENTS/);
    assert.equal(fs.existsSync(path.join(explicitRoot, "visual-first-ppt")), false);
  }
});
