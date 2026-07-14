import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const scenariosDocument = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tests/scenarios/scenarios.json"), "utf8"),
);
const rubric = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tests/scenarios/rubric.json"), "utf8"),
);
const baseline = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tests/baseline/summary.json"), "utf8"),
);

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

const aggregate = {
  requiredItems: 0,
  requiredPasses: 0,
  requiredFailures: 0,
  requiredPassRate: 0,
  forbiddenChecks: 0,
  forbiddenAbsent: 0,
  forbiddenPresent: 0,
  forbiddenAbsenceRate: 0,
};
const scenarioSummaries = {};
const fixtureHashes = {};

for (const scenario of scenariosDocument.scenarios) {
  const perScenario = {
    runs: rubric.passRule.microtestRuns,
    passingRuns: 0,
    requiredItems: 0,
    requiredPasses: 0,
    requiredPassRate: 0,
    forbiddenChecks: 0,
    forbiddenAbsent: 0,
    forbiddenAbsenceRate: 0,
  };
  const scenarioFixtureHashes = {};
  for (const fixture of scenario.fixtures) {
    const digest = await sha256(path.join(repoRoot, fixture));
    scenarioFixtureHashes[path.basename(fixture)] = digest;
    fixtureHashes[fixture] = digest;
  }

  for (let run = 1; run <= rubric.passRule.microtestRuns; run += 1) {
    const runName = `run-${String(run).padStart(2, "0")}`;
    const runDir = path.join(repoRoot, "tests/green", scenario.id, runName);
    const rawResponse = await fs.readFile(path.join(runDir, "response.txt"), "utf8");
    const score = JSON.parse(await fs.readFile(path.join(runDir, "score.json"), "utf8"));
    const expectedMetadata = {
      model: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
      reviewerModel: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
      codexCli: "0.142.0",
      node: process.version,
      presentationsBundle: "26.709.11516",
      renderer: "not invoked in first-response microtest",
      fixtureHashes: scenarioFixtureHashes,
      isolatedGenerationContext: true,
      isolatedReviewerContext: true,
    };

    assert.equal(score.scenarioId, scenario.id, `${scenario.id}/${runName}: scenarioId drift`);
    assert.equal(score.run, run, `${scenario.id}/${runName}: run drift`);
    assert.equal(score.rawResponse, rawResponse, `${scenario.id}/${runName}: rawResponse drift`);
    assert.deepEqual(score.runMetadata, expectedMetadata, `${scenario.id}/${runName}: metadata drift`);
    assert.deepEqual(Object.keys(score.required).sort(), [...scenario.required].sort());
    assert.deepEqual(Object.keys(score.forbidden).sort(), [...scenario.forbidden].sort());

    const requiredPasses = Object.values(score.required).filter((value) => value === "pass").length;
    const forbiddenAbsent = Object.values(score.forbidden).filter((value) => value === "absent").length;
    const shouldPass =
      requiredPasses === scenario.required.length && forbiddenAbsent === scenario.forbidden.length;
    assert.equal(score.verdict, shouldPass ? "PASS" : "FAIL", `${scenario.id}/${runName}: verdict drift`);
    assert.equal(score.verdict, "PASS", `${scenario.id}/${runName}: GREEN threshold failed`);

    perScenario.passingRuns += 1;
    perScenario.requiredItems += scenario.required.length;
    perScenario.requiredPasses += requiredPasses;
    perScenario.forbiddenChecks += scenario.forbidden.length;
    perScenario.forbiddenAbsent += forbiddenAbsent;
  }

  perScenario.requiredPassRate = perScenario.requiredPasses / perScenario.requiredItems;
  perScenario.forbiddenAbsenceRate = perScenario.forbiddenAbsent / perScenario.forbiddenChecks;
  scenarioSummaries[scenario.id] = perScenario;
  aggregate.requiredItems += perScenario.requiredItems;
  aggregate.requiredPasses += perScenario.requiredPasses;
  aggregate.forbiddenChecks += perScenario.forbiddenChecks;
  aggregate.forbiddenAbsent += perScenario.forbiddenAbsent;
}

aggregate.requiredFailures = aggregate.requiredItems - aggregate.requiredPasses;
aggregate.requiredPassRate = aggregate.requiredPasses / aggregate.requiredItems;
aggregate.forbiddenPresent = aggregate.forbiddenChecks - aggregate.forbiddenAbsent;
aggregate.forbiddenAbsenceRate = aggregate.forbiddenAbsent / aggregate.forbiddenChecks;

const summary = {
  schemaVersion: "1.0.0",
  evidenceRetention: {
    publicCandidate: "summary-and-hashes-only",
    rawEvidenceIncluded: false,
    replaySupport: "tests/scenarios/",
  },
  runCount: rubric.passRule.microtestRuns * scenariosDocument.scenarios.length,
  microtestProtocol: {
    freshGenerationContextPerRun: true,
    freshIndependentReviewerPerRun: true,
    firstUserVisibleResponseOnly: true,
    unchangedRubric: "tests/scenarios/rubric.json",
    isolatedWorkingDirectories: true,
  },
  versions: {
    model: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
    reviewerModel: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
    node: process.version,
    presentationsBundle: "26.709.11516",
    renderer: "not invoked in first-response microtest",
  },
  fixtureHashes,
  allScenarios: aggregate,
  scenarios: scenarioSummaries,
  baselineToGreen: {
    baseline: baseline.aggregate,
    green: aggregate,
    requiredPassRateGain: aggregate.requiredPassRate - baseline.aggregate.requiredPassRate,
    forbiddenAbsenceRateGain:
      aggregate.forbiddenAbsenceRate - baseline.aggregate.forbiddenAbsenceRate,
  },
  preservedFailureEvidence: {
    retainedLocally: true,
    includedInPublicCandidate: false,
    roundCount: 5,
  },
  runtimeBoundary: "The Skill governs the first user-visible response after it is read. A host may batch attachment listing into the same pre-read shell command; round-04 execution evidence preserves that host-loading limitation, which is outside the unchanged response rubric.",
};

assert.equal(summary.runCount, 15);
assert.equal(aggregate.requiredPassRate, 1);
assert.equal(aggregate.forbiddenAbsenceRate, 1);
await fs.writeFile(
  path.join(repoRoot, "tests/green/summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
