import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildQaReport,
  EDIT_REQUIRED_CHECKS,
  HARD_ZERO,
  REQUIRED_AUTOMATED_CHECKS,
  REQUIRED_MANUAL_DIMENSIONS,
} from "../../skills/visual-first-ppt/scripts/build-qa-report.mjs";
import { validateSchema } from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "visual-first-ppt-qa-"));

function automated(route = "create") {
  const ids = route === "edit"
    ? [...REQUIRED_AUTOMATED_CHECKS, ...EDIT_REQUIRED_CHECKS]
    : [...REQUIRED_AUTOMATED_CHECKS];
  return ids.map((id) => ({
    id,
    result: "passed",
    value: id === "pageCountAndCanvas" ? 1 : (HARD_ZERO.includes(id) ? 0 : null),
    evidencePath: `qa/${id}.json`,
  }));
}

function manualSlides(slides, score = 4) {
  return slides.map((slide) => ({
    slide,
    reviewer: "local-review",
    scores: Object.fromEntries(REQUIRED_MANUAL_DIMENSIONS.map((dimension) => [dimension, score])),
    evidencePath: `previews/slide-${slide}.png`,
  }));
}

function manual(score = 4) {
  return manualSlides([1], score);
}

async function materializeEvidencePaths(dir, values) {
  const records = [
    ...values.automatedChecks,
    ...values.manualScores,
    values.clientSmoke,
  ];
  for (const record of records) {
    if (typeof record.evidencePath !== "string" || record.evidencePath.trim() === "") continue;
    const absolute = path.isAbsolute(record.evidencePath)
      ? record.evidencePath
      : path.join(dir, record.evidencePath);
    record.evidencePath = absolute;
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "verified evidence\n");
  }
}

async function writeInputs(name, {
  route = "create",
  checks = automated(route),
  scores = manual(),
  smoke,
  materializeEvidence = true,
} = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const values = {
    inputHashes: { deck: "sha256:deck" },
    toolVersions: { node: process.version },
    automatedChecks: checks.map((check) => ({ ...check })),
    manualScores: scores.map((entry) => ({ ...entry, scores: { ...entry.scores } })),
    clientSmoke: { ...(smoke || { status: "passed", evidencePath: "qa/client-smoke.txt" }) },
  };
  if (materializeEvidence) await materializeEvidencePaths(dir, values);
  const paths = {};
  for (const [key, value] of Object.entries(values)) {
    paths[key] = path.join(dir, `${key}.json`);
    await fs.writeFile(paths[key], `${JSON.stringify(value, null, 2)}\n`);
  }
  return { name, dir, route, paths, values, output: path.join(dir, "qa-report.json") };
}

async function buildInput(input) {
  return buildQaReport({
    projectId: `ppt-${input.name}`,
    route: input.route,
    inputHashesPath: input.paths.inputHashes,
    toolVersionsPath: input.paths.toolVersions,
    automatedChecksPath: input.paths.automatedChecks,
    manualScoresPath: input.paths.manualScores,
    clientSmokePath: input.paths.clientSmoke,
    outputPath: input.output,
  });
}

async function build(name, options = {}) {
  const input = await writeInputs(name, options);
  return buildInput(input);
}

test("valid evidence builds a schema-valid PASS report", async () => {
  const report = await build("valid");
  assert.equal(report.finalVerdict, "PASS");
  assert.equal(report.clientSmokeStatus, "PASS");
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const result = validateSchema({ $defs: schema.$defs, $ref: "#/$defs/qaReport" }, report);
  assert.equal(result.valid, true, result.errors.join("\n"));
});

test("every hard-zero check rejects a nonzero value", async () => {
  for (const id of HARD_ZERO) {
    const checks = automated();
    checks.find((check) => check.id === id).value = 1;
    await assert.rejects(build(`hard-zero-${id}`, { checks }), new RegExp(id));
  }
});

test("missing checks and evidence paths fail closed", async () => {
  const missing = automated().filter((check) => check.id !== "fontAvailability");
  await assert.rejects(build("missing-check", { checks: missing }), /fontAvailability/);

  const blankEvidence = automated();
  blankEvidence[0].evidencePath = "";
  await assert.rejects(build("missing-evidence", { checks: blankEvidence }), /evidence path/i);
});

test("evidence paths must reference existing files", async () => {
  const input = await writeInputs("missing-evidence-file");
  await fs.rm(input.values.automatedChecks[0].evidencePath);
  await assert.rejects(
    buildInput(input),
    /evidence.*(?:exist|missing|file)|ENOENT/i,
  );
});

test("evidence files must be nonempty", async () => {
  const input = await writeInputs("empty-evidence-file");
  await fs.writeFile(input.values.automatedChecks[0].evidencePath, "");
  await assert.rejects(
    buildInput(input),
    /evidence.*(?:empty|nonempty|zero)/i,
  );
});

test("manual review covers every consecutive slide declared by pageCountAndCanvas", async () => {
  const checks = automated();
  checks.find((check) => check.id === "pageCountAndCanvas").value = 3;
  await assert.rejects(
    build("manual-page-coverage", {
      checks,
      scores: manualSlides([1, 3]),
    }),
    /manual|slide 2|page.*count|consecutive|continuous/i,
  );
});

test("edit route requires source, scope, and unauthorized-slide comparison evidence", async () => {
  for (const missingId of EDIT_REQUIRED_CHECKS) {
    const checks = automated("edit").filter((check) => check.id !== missingId);
    await assert.rejects(
      build(`edit-missing-${missingId}`, { route: "edit", checks }),
      new RegExp(missingId),
    );
  }
});

test("manual dimensions below 4 fail", async () => {
  for (const dimension of REQUIRED_MANUAL_DIMENSIONS) {
    const scores = manual();
    scores[0].scores[dimension] = 3;
    await assert.rejects(build(`manual-${dimension}`, { scores }), new RegExp(dimension));
  }
});

test("client smoke not_available needs user final-open confirmation", async () => {
  await assert.rejects(
    build("smoke-missing-confirmation", {
      smoke: { status: "not_available", evidencePath: "qa/smoke-unavailable.txt" },
    }),
    /final-open confirmation/i,
  );
  const report = await build("smoke-confirmed", {
    smoke: {
      status: "not_available",
      evidencePath: "qa/smoke-unavailable.txt",
      userFinalOpenConfirmation: true,
    },
  });
  assert.equal(report.finalVerdict, "PASS");
  assert.equal(report.clientSmokeStatus, "NOT_RUN");
});
