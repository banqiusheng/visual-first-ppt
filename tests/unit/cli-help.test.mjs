import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

for (const relativePath of [
  "skills/visual-first-ppt/scripts/project-state.mjs",
  "skills/visual-first-ppt/scripts/build-qa-report.mjs",
  "skills/visual-first-ppt/scripts/doctor.mjs",
]) {
  test(`${path.basename(relativePath)} exposes a successful --help contract`, () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, relativePath), "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /usage:/i);
  });
}

test("project-state help exposes the persistent output required for DELIVERED", () => {
  const script = path.join(
    ROOT,
    "skills/visual-first-ppt/scripts/project-state.mjs",
  );
  const result = spawnSync(process.execPath, [script, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /transition <workspace> DELIVERED <approval-hash> <persistent-root> <persistent-final-output>/,
  );
});
