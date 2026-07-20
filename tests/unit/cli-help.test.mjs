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
  "skills/visual-first-ppt/scripts/validate-current-qa.mjs",
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
  assert.match(
    result.stdout,
    /project-state\.mjs adopt-quality <workspace> <prebuild-evidence>/,
  );
});

test("doctor help explains that visual-quality runtime completeness is checked", () => {
  const script = path.join(ROOT, "skills/visual-first-ppt/scripts/doctor.mjs");
  const result = spawnSync(process.execPath, [script, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /visual-quality runtime files/i);
  assert.match(result.stdout, /validate-slide-specs\.mjs/);
  assert.match(result.stdout, /audit_pptx_quality\.py/);
});

test("OOXML auditor help exposes every required input and output", () => {
  const script = path.join(ROOT, "skills/visual-first-ppt/scripts/audit_pptx_quality.py");
  const result = spawnSync("python3", [script, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const flag of ["--pptx", "--slide-specs", "--theme-lock", "--object-inventory", "--output"]) {
    assert.match(result.stdout, new RegExp(flag));
  }
});
