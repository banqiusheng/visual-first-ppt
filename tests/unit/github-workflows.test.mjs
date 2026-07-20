import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");
const workflowNames = ["ci.yml", "release-candidate.yml", "publish-release.yml"];

function read(name) {
  return fs.readFileSync(path.join(workflowDir, name), "utf8");
}

function pythonWithPinnedYaml() {
  const candidates = [
    process.env.PYTHON,
    path.join(repoRoot, ".venv/bin/python"),
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-c", "import yaml,sys; sys.exit(0 if yaml.__version__ == '6.0.2' else 1)"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return candidate;
  }
  throw new Error("PyYAML==6.0.2 is required; install requirements-dev.txt");
}

function loadWorkflows() {
  const validator = String.raw`
import json
import sys
from pathlib import Path
import yaml

result = {}
for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    with path.open(encoding="utf-8") as stream:
        value = yaml.safe_load(stream)
    assert isinstance(value, dict), path
    assert True not in value, f'{path}: YAML parsed a boolean true top-level key; quote "on"'
    assert "on" in value, f'{path}: missing string on key'
    result[path.name] = value
print(json.dumps(result))
`;
  const paths = workflowNames.map((name) => path.join(workflowDir, name));
  const result = spawnSync(pythonWithPinnedYaml(), ["-c", validator, ...paths], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function workflowRuns(workflow) {
  return Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => typeof step.run === "string").map((step) => step.run),
  );
}

function allSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

test("the three gated workflows exist", () => {
  for (const name of workflowNames) {
    const filename = path.join(workflowDir, name);
    assert.ok(fs.existsSync(filename), `missing .github/workflows/${name}`);
    assert.ok(fs.statSync(filename).isFile(), `${name} must be a regular file`);
  }
});

test("workflow YAML parses with a quoted on key and exact least-privilege triggers", () => {
  const workflows = loadWorkflows();
  const ci = workflows["ci.yml"];
  const candidate = workflows["release-candidate.yml"];
  const publish = workflows["publish-release.yml"];

  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(ci.on.pull_request.branches, ["main"]);
  assert.deepEqual(ci.on.push.branches, ["main", "codex/**"]);
  assert.deepEqual(ci.permissions, { contents: "read" });

  assert.deepEqual(Object.keys(candidate.on), ["push"]);
  assert.deepEqual(candidate.on.push.tags, ["v*.*.*"]);
  assert.deepEqual(candidate.permissions, { contents: "read" });

  assert.deepEqual(Object.keys(publish.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(publish.on.workflow_dispatch.inputs), ["tag"]);
  assert.equal(publish.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(publish.on.workflow_dispatch.inputs.tag.type, "string");
  assert.deepEqual(publish.permissions, { contents: "write" });

  for (const content of workflowNames.map(read)) {
    assert.doesNotMatch(content, /pull_request_target/);
  }
});

test("all actions are approved actions/* integrations pinned to exact 40-byte SHAs", () => {
  const approved = new Map([
    ["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
    ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
    ["actions/setup-python", "ece7cb06caefa5fff74198d8649806c4678c61a1"],
    ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ]);
  for (const name of workflowNames) {
    const content = read(name);
    const uses = [...content.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)].map(
      (match) => match[1],
    );
    assert.ok(uses.length >= 3, `${name} must use the pinned setup actions`);
    for (const value of uses) {
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(value);
      assert.ok(match, `${name}: unpinned action ${value}`);
      assert.match(match[1], /^actions\//, `${name}: only actions/* is approved`);
      assert.equal(match[2], approved.get(match[1]), `${name}: unexpected SHA for ${match[1]}`);
    }
  }
});

test("every checkout drops persisted credentials and every shell block is fail-fast", () => {
  const workflows = loadWorkflows();
  for (const [name, workflow] of Object.entries(workflows)) {
    const steps = allSteps(workflow);
    const checkouts = steps.filter((step) => String(step.uses || "").startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 1, `${name} must have exactly one checkout`);
    assert.equal(checkouts[0].with["persist-credentials"], false, name);
    for (const run of workflowRuns(workflow)) {
      assert.match(run, /^set -euo pipefail\n/, `${name}: shell block must start fail-fast`);
      assert.doesNotMatch(run, /\$\{\{/, `${name}: expressions must enter shells through env`);
    }
  }
});

test("ordinary CI uses the fixed runtime matrix and performs the full deterministic validation", () => {
  const workflows = loadWorkflows();
  const ci = workflows["ci.yml"];
  const steps = allSteps(ci);
  const node = steps.find((step) => String(step.uses || "").startsWith("actions/setup-node@"));
  const python = steps.find((step) => String(step.uses || "").startsWith("actions/setup-python@"));
  assert.equal(node.with["node-version"], "20");
  assert.equal(python.with["python-version"], "3.10");

  const shell = workflowRuns(ci).join("\n");
  for (const command of [
    "python -m pip install -r requirements-dev.txt",
    "node --test tests/unit/*.test.mjs",
    "PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/unit -p 'test_*.py' -v",
    "python scripts/audit_public_candidate.py --root . --candidate tracked",
    'python scripts/build_distribution.py --root . --output-dir "$RUNNER_TEMP/dist-a" --version 0.3.0',
    'python scripts/build_distribution.py --root . --output-dir "$RUNNER_TEMP/dist-b" --version 0.3.0',
    'diff -qr "$RUNNER_TEMP/dist-a" "$RUNNER_TEMP/dist-b"',
  ]) {
    assert.ok(shell.includes(command), `CI missing: ${command}`);
  }
  assert.doesNotMatch(read("ci.yml"), /actions\/upload-artifact|contents:\s*write|gh release/i);
});

test("candidate tags are annotated semver objects on origin/main and only become Actions artifacts", () => {
  const workflows = loadWorkflows();
  const candidate = workflows["release-candidate.yml"];
  const steps = allSteps(candidate);
  const checkout = steps.find((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.ref }}");
  const gate = steps.find((step) =>
    step.name === "Verify annotated tag, main ancestry, and version surfaces",
  );
  assert.equal(gate.id, "tag-gate");
  for (const output of ["tag_object", "tag_commit", "main_commit"]) {
    assert.ok(gate.run.includes(`${output}=`), `candidate gate must persist ${output}`);
  }
  const build = steps.find((step) => String(step.name || "").startsWith("Test, audit, and compare"));
  assert.equal(build.env.VERIFIED_TAG_OBJECT, "${{ steps.tag-gate.outputs.tag_object }}");
  assert.equal(build.env.VERIFIED_TAG_COMMIT, "${{ steps.tag-gate.outputs.tag_commit }}");
  assert.equal(build.env.VERIFIED_MAIN_COMMIT, "${{ steps.tag-gate.outputs.main_commit }}");
  for (const contract of [
    'test "$(git rev-parse "refs/tags/$TAG")" = "$VERIFIED_TAG_OBJECT"',
    'test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$VERIFIED_TAG_COMMIT"',
    'test "$(git rev-parse HEAD)" = "$VERIFIED_TAG_COMMIT"',
    'test "$(git rev-parse refs/remotes/origin/main)" = "$VERIFIED_MAIN_COMMIT"',
    "git diff --exit-code -- .",
    "git diff --cached --exit-code -- .",
    "git status --porcelain=v1 --untracked-files=all --ignored=matching",
  ]) {
    assert.ok(build.run.includes(contract), `candidate build must recheck: ${contract}`);
  }
  const shell = workflowRuns(candidate).join("\n");
  for (const contract of [
    "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
    'git cat-file -t "refs/tags/$TAG"',
    'git rev-parse "refs/tags/$TAG^{commit}"',
    'test "$(git rev-parse HEAD)" = "$TAG_COMMIT"',
    'refs/heads/main:refs/remotes/origin/main',
    'git merge-base --is-ancestor "$TAG_COMMIT" refs/remotes/origin/main',
    'VERSION="${TAG#v}"',
    ".codex-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    "README.zh-CN.md",
    "README.ja.md",
    "README.ko.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(shell.includes(contract), `candidate missing gate: ${contract}`);
  }
  const content = read("release-candidate.yml");
  assert.match(content, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.doesNotMatch(content, /gh release|contents:\s*write/i);
});

test("manual publish validates input before a full tag checkout and keeps GH_TOKEN in the final step", () => {
  const workflows = loadWorkflows();
  const publish = workflows["publish-release.yml"];
  const steps = allSteps(publish);
  const inputGate = steps.findIndex((step) => step.name === "Validate requested tag input");
  const checkout = steps.findIndex((step) => String(step.uses || "").startsWith("actions/checkout@"));
  assert.ok(inputGate >= 0 && inputGate < checkout, "tag input must be validated before checkout");
  assert.equal(steps[checkout].with.ref, "refs/tags/${{ inputs.tag }}");
  assert.equal(steps[checkout].with["fetch-depth"], 0);

  const gate = steps.find((step) =>
    step.name === "Verify annotated tag, main ancestry, and version surfaces",
  );
  assert.equal(gate.id, "tag-gate");
  for (const output of ["tag_object", "tag_commit", "main_commit"]) {
    assert.ok(gate.run.includes(`${output}=`), `publish gate must persist ${output}`);
  }

  const tokenSteps = steps.filter((step) => Object.hasOwn(step.env || {}, "GH_TOKEN"));
  assert.equal(tokenSteps.length, 1);
  assert.equal(tokenSteps[0].name, "Publish or reconcile GitHub Release");
  assert.equal(steps.at(-1).name, "Publish or reconcile GitHub Release");

  const shell = workflowRuns(publish).join("\n");
  assert.ok(shell.includes("^v[0-9]+\\.[0-9]+\\.[0-9]+$"));
  assert.ok(shell.includes('git cat-file -t "refs/tags/$TAG"'));
  assert.ok(shell.includes('git merge-base --is-ancestor "$TAG_COMMIT" refs/remotes/origin/main'));
  assert.ok(shell.includes(".agents/plugins/marketplace.json"));
  assert.ok(shell.includes("CHANGELOG.md"));
});

test("publish is fail-closed for existing releases and never replaces remote assets", () => {
  const content = read("publish-release.yml");
  const workflows = loadWorkflows();
  const publishStep = allSteps(workflows["publish-release.yml"]).at(-1);
  const shell = publishStep.run;

  assert.equal(
    publishStep.env.VERIFIED_TAG_OBJECT,
    "${{ steps.tag-gate.outputs.tag_object }}",
  );
  assert.equal(
    publishStep.env.VERIFIED_TAG_COMMIT,
    "${{ steps.tag-gate.outputs.tag_commit }}",
  );
  assert.equal(
    publishStep.env.VERIFIED_MAIN_COMMIT,
    "${{ steps.tag-gate.outputs.main_commit }}",
  );

  for (const contract of [
    'test "$(git rev-parse "refs/tags/$TAG")" = "$VERIFIED_TAG_OBJECT"',
    'test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$VERIFIED_TAG_COMMIT"',
    'test "$(git rev-parse HEAD)" = "$VERIFIED_TAG_COMMIT"',
    'test "$(git rev-parse refs/remotes/origin/main)" = "$VERIFIED_MAIN_COMMIT"',
    'TAG_COMMIT="$VERIFIED_TAG_COMMIT"',
    "git diff --exit-code -- .",
    "git diff --cached --exit-code -- .",
    "git status --porcelain=v1 --untracked-files=all --ignored=matching",
  ]) {
    assert.ok(shell.includes(contract), `publish final step must recheck: ${contract}`);
  }

  for (const contract of [
    "HTTP_STATUS",
    '"200"',
    '"404"',
    "gh release view",
    "tagName,targetCommitish,assets",
    "duplicate",
    "unknown",
    "existing-assets.txt",
    "missing-assets.txt",
    "gh release download",
    "cmp -s",
    "gh release upload",
    "gh release create",
    '--target "$TAG_COMMIT"',
    "--verify-tag",
    "--generate-notes",
    "hashlib.sha256",
  ]) {
    assert.ok(shell.includes(contract), `publish missing fail-closed contract: ${contract}`);
  }
  assert.ok(
    shell.indexOf("existing-assets.txt") < shell.indexOf("gh release upload"),
    "all existing assets must be planned before any upload",
  );
  assert.ok(
    shell.indexOf("cmp -s") < shell.indexOf("gh release upload"),
    "all byte comparisons must occur before missing uploads",
  );
  assert.ok(
    shell.indexOf("hashlib.sha256") < shell.indexOf("gh api --include --silent"),
    "local assets and SHA256SUMS must be verified before querying the release",
  );
  assert.doesNotMatch(content, /--clobber|gh release (?:delete|delete-asset|edit)/i);
  assert.doesNotMatch(content, /actions\/upload-artifact/);

  const releaseCommands = shell
    .split("\n")
    .filter((line) => /\bgh release (?:view|download|upload|create)\b/.test(line));
  assert.ok(releaseCommands.length >= 5, "expected all release command paths to be covered");
  for (const line of releaseCommands) {
    assert.match(
      line,
      /--repo "\$GITHUB_REPOSITORY"/,
      `release command must bind the current GitHub repository: ${line.trim()}`,
    );
  }
});

test("existing Release target validation ignores forged unrelated local refs", () => {
  const workflows = loadWorkflows();
  const shell = allSteps(workflows["publish-release.yml"]).at(-1).run;
  const anchor = shell.indexOf("export EXISTING_LIST MISSING_LIST RELEASE_JSON");
  assert.ok(anchor >= 0, "missing existing Release validation anchor");
  const marker = "python - <<'PY'\n";
  const start = shell.indexOf(marker, anchor);
  const end = shell.indexOf("\nPY\n", start + marker.length);
  assert.ok(start >= 0 && end > start, "cannot extract existing Release validator");
  const validator = shell.slice(start + marker.length, end);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "visual-first-ppt-release-target-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: scratch }).status, 0);
    fs.writeFileSync(path.join(scratch, "fixture.txt"), "fixture\n");
    assert.equal(spawnSync("git", ["add", "fixture.txt"], { cwd: scratch }).status, 0);
    const commit = spawnSync(
      "git",
      ["-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", "commit", "-qm", "fixture"],
      { cwd: scratch, encoding: "utf8" },
    );
    assert.equal(commit.status, 0, commit.stderr);
    const tagCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: scratch,
      encoding: "utf8",
    }).stdout.trim();
    assert.match(tagCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      spawnSync("git", ["update-ref", "refs/remotes/origin/evil", tagCommit], {
        cwd: scratch,
      }).status,
      0,
    );

    const releaseJson = path.join(scratch, "release.json");
    const existingList = path.join(scratch, "existing.txt");
    const missingList = path.join(scratch, "missing.txt");
    const validateTarget = (targetCommitish, verifiedMainCommit = tagCommit) => {
      fs.writeFileSync(
        releaseJson,
        JSON.stringify({ tagName: "v0.2.0", targetCommitish, assets: [] }),
      );
      return spawnSync(pythonWithPinnedYaml(), ["-c", validator], {
        cwd: scratch,
        encoding: "utf8",
        env: {
          ...process.env,
          EXISTING_LIST: existingList,
          MISSING_LIST: missingList,
          RELEASE_JSON: releaseJson,
          TAG: "v0.2.0",
          TAG_COMMIT: tagCommit,
          VERIFIED_MAIN_COMMIT: verifiedMainCommit,
        },
      });
    };

    const forged = validateTarget("evil");
    assert.notEqual(
      forged.status,
      0,
      "an unrelated forged local ref must never authenticate targetCommitish",
    );
    assert.match(`${forged.stdout}\n${forged.stderr}`, /targetCommitish/);

    for (const allowed of [
      tagCommit,
      "v0.2.0",
      "refs/tags/v0.2.0",
      "main",
      "refs/heads/main",
    ]) {
      const result = validateTarget(allowed);
      assert.equal(result.status, 0, `verified target identity must pass: ${allowed}`);
    }
    const advancedMain = validateTarget("main", "0".repeat(40));
    assert.notEqual(advancedMain.status, 0, "main must equal the verified tag commit");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
