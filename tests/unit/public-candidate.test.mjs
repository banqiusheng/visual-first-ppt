import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), "utf8"));
}

function collectRepositoryPaths(value, paths = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRepositoryPaths(item, paths);
    return paths;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectRepositoryPaths(item, paths);
    return paths;
  }
  if (typeof value === "string" && value.startsWith("tests/")) paths.push(value);
  return paths;
}

test("public summaries declare compact-only retention and contain no dangling paths", async () => {
  const artifactSummary = await readJson("tests/artifacts/artifact-summary.json");
  const baselineSummary = await readJson("tests/baseline/summary.json");
  const greenSummary = await readJson("tests/green/summary.json");

  for (const summary of [artifactSummary, baselineSummary, greenSummary]) {
    assert.equal(summary.evidenceRetention.publicCandidate, "summary-and-hashes-only");
  }

  const referencedPaths = [artifactSummary, baselineSummary, greenSummary]
    .flatMap((summary) => collectRepositoryPaths(summary));
  const missing = [];
  for (const relativePath of referencedPaths) {
    try {
      await fs.access(path.join(ROOT, relativePath));
    } catch {
      missing.push(relativePath);
    }
  }
  assert.deepEqual(missing, []);
});

test("public candidate keeps reusable artifact support scripts without claiming raw evidence", async () => {
  const gitignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, /!tests\/artifacts\/support\//);
  assert.doesNotMatch(gitignore, /summaries remain publishable and reproducible/i);
});

test("public candidate ignores local planning and raw agent-forward evidence", async () => {
  const gitignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");
  const lines = new Set(gitignore.split(/\r?\n/));

  assert.ok(lines.has(".superpowers/"));
  assert.ok(lines.has("tests/agent-forward/runs/"));
});
