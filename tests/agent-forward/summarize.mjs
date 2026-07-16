import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const FROZEN_SCENARIOS_SHA256 = "ff4cb09537c1a22b5b5769933b005a9cd3f53fb34fbc003d82b708473d606ee3";
const FROZEN_RUBRIC_SHA256 = "3061fa3664b478464671f8484468ef4a7b3106456196d4cc44c1a2252b075b08";
const FROZEN_BASELINE_SHA256 = "2b14fdc89e2d11f0f4a8542d76224150357b25e485046201ff1bb84e50ca0dac";
const EXPECTED_MODEL_LABEL = "codex-cli 0.142.0 default model (exact build unavailable)";

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function readOptionalFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, label) {
  const actual = sortedKeys(value);
  const wanted = [...expected].sort();
  const unknown = actual.filter((key) => !wanted.includes(key));
  if (unknown.length) throw new Error(`${label}: unknown score fields: ${unknown.join(", ")}`);
  const missing = wanted.filter((key) => !actual.includes(key));
  if (missing.length) throw new Error(`${label}: missing required fields: ${missing.join(", ")}`);
}

function rate(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireRate(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite rate from 0 to 1`);
  }
  return value;
}

function requireCanonicalIsoTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

function findMatches(text, { pattern, flags = "" }) {
  const globalFlags = flags.includes("g") ? flags : `${flags}g`;
  return [...text.matchAll(new RegExp(pattern, globalFlags))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function findOrderedChainBefore(text, patterns, after, before) {
  if (patterns.length === 0) return null;
  let cursor = after;
  for (const pattern of patterns) {
    const match = findMatches(text, pattern).find(({ start, end }) => start >= cursor && end <= before);
    if (!match) return null;
    cursor = match.end;
  }
  return cursor;
}

const mode = readFlag("--mode");
if (!["baseline", "green"].includes(mode)) throw new Error("--mode must be baseline or green");
const runsRoot = path.resolve(readFlag("--runs"));
const rubricPath = path.resolve(readFlag("--rubric"));
const outputPath = path.resolve(readFlag("--output"));
const baselineFlag = readOptionalFlag("--baseline");
if (mode === "green" && baselineFlag === null) throw new Error("missing --baseline");
const scenariosBytes = await fs.readFile(path.join(scriptDir, "scenarios.json"));
assert.equal(sha256(scenariosBytes), FROZEN_SCENARIOS_SHA256, "scenarios frozen SHA256 mismatch");
const rubricBytes = await fs.readFile(rubricPath);
assert.equal(sha256(rubricBytes), FROZEN_RUBRIC_SHA256, "rubric frozen SHA256 mismatch");
const scenarios = JSON.parse(scenariosBytes.toString("utf8")).scenarios;
const rubric = JSON.parse(rubricBytes.toString("utf8"));

const aggregate = {
  passingRuns: 0,
  failingRuns: 0,
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
const failureCounts = {};
const publicRuns = [];

for (const scenario of scenarios) {
  failureCounts[scenario.id] = {
    required: Object.fromEntries(scenario.required.map((id) => [id, 0])),
    forbidden: Object.fromEntries(scenario.forbidden.map((id) => [id, 0])),
  };
  const scenarioSummary = {
    runs: rubric.passRule.microtestRuns,
    passingRuns: 0,
    failingRuns: 0,
    requiredItems: 0,
    requiredPasses: 0,
    requiredFailures: 0,
    requiredPassRate: 0,
    forbiddenChecks: 0,
    forbiddenAbsent: 0,
    forbiddenPresent: 0,
    forbiddenAbsenceRate: 0,
  };

  for (let run = 1; run <= rubric.passRule.microtestRuns; run += 1) {
    const runLabel = `run-${String(run).padStart(2, "0")}`;
    const label = `${scenario.id}/${runLabel}`;
    const runDir = path.join(runsRoot, scenario.id, runLabel);
    const response = await fs.readFile(path.join(runDir, "response.txt"));
    const score = JSON.parse(await fs.readFile(path.join(runDir, "score.json"), "utf8"));

    if (Object.hasOwn(score, "rawResponse")) {
      throw new Error(`${label}: raw response must not be copied into reviewer score`);
    }
    assertExactKeys(score, rubric.evidenceFields, label);
    assert.equal(score.scenarioId, scenario.id, `${label}: scenarioId drift`);
    assert.equal(score.run, run, `${label}: run drift`);
    assertExactKeys(score.runMetadata, ["model", "isolatedContext"], `${label}/runMetadata`);
    assert.equal(score.runMetadata.model, EXPECTED_MODEL_LABEL, `${label}: model label drift`);
    assert.equal(score.runMetadata.isolatedContext, true, `${label}: reviewer context is not isolated`);
    assertExactKeys(score.required, scenario.required, `${label}/required`);
    assertExactKeys(score.forbidden, scenario.forbidden, `${label}/forbidden`);
    assert.ok(Object.values(score.required).every((value) => ["pass", "fail"].includes(value)), `${label}: invalid required status`);
    assert.ok(Object.values(score.forbidden).every((value) => ["absent", "present"].includes(value)), `${label}: invalid forbidden status`);
    assert.ok(Array.isArray(score.rationalizations) && score.rationalizations.every((item) => typeof item === "string"), `${label}: invalid rationalizations`);

    for (const [forbiddenId, guard] of Object.entries(rubric.evidenceGuards ?? {})) {
      if (!guard.scenarioIds.includes(scenario.id)) continue;
      assert.equal(guard.source, "response.txt", `${label}: unsupported evidence guard source`);
      assert.ok(scenario.forbidden.includes(forbiddenId), `${label}: guard field is not in scenario forbidden rubric`);
      const responseText = response.toString("utf8");
      const destructiveMatches = [
        ...new Map(
          guard.patterns
            .flatMap((pattern) => findMatches(responseText, pattern))
            .map((match) => [`${match.start}:${match.end}`, match]),
        ).values(),
      ].sort((left, right) => left.start - right.start);
      let chainCursor = 0;
      const matched = destructiveMatches.some(({ start, end }) => {
        const chainEnd = findOrderedChainBefore(
          responseText,
          guard.unlessAllPatterns ?? [],
          chainCursor,
          start,
        );
        if (chainEnd === null) return true;
        chainCursor = end;
        return false;
      });
      const requiredStatus = guard.requires.forbiddenStatus;
      if (matched && score.forbidden[forbiddenId] !== requiredStatus) {
        throw new Error(
          `${label}: mechanical evidence guard ${forbiddenId} requires ${requiredStatus}; reviewer recorded ${score.forbidden[forbiddenId]}`,
        );
      }
    }

    const requiredPasses = Object.values(score.required).filter((value) => value === "pass").length;
    const forbiddenAbsent = Object.values(score.forbidden).filter((value) => value === "absent").length;
    for (const [id, value] of Object.entries(score.required)) {
      if (value === "fail") failureCounts[scenario.id].required[id] += 1;
    }
    for (const [id, value] of Object.entries(score.forbidden)) {
      if (value === "present") failureCounts[scenario.id].forbidden[id] += 1;
    }
    const expectedVerdict = requiredPasses === scenario.required.length && forbiddenAbsent === scenario.forbidden.length
      ? "PASS"
      : "FAIL";
    assert.equal(score.verdict, expectedVerdict, `${label}: verdict drift`);

    scenarioSummary[expectedVerdict === "PASS" ? "passingRuns" : "failingRuns"] += 1;
    scenarioSummary.requiredItems += scenario.required.length;
    scenarioSummary.requiredPasses += requiredPasses;
    scenarioSummary.forbiddenChecks += scenario.forbidden.length;
    scenarioSummary.forbiddenAbsent += forbiddenAbsent;
    publicRuns.push({
      scenarioId: scenario.id,
      run,
      runLabel: label,
      model: score.runMetadata.model,
      isolatedContext: true,
      verdict: expectedVerdict,
      responseSha256: crypto.createHash("sha256").update(response).digest("hex"),
    });
  }

  scenarioSummary.requiredFailures = scenarioSummary.requiredItems - scenarioSummary.requiredPasses;
  scenarioSummary.requiredPassRate = rate(scenarioSummary.requiredPasses, scenarioSummary.requiredItems);
  scenarioSummary.forbiddenPresent = scenarioSummary.forbiddenChecks - scenarioSummary.forbiddenAbsent;
  scenarioSummary.forbiddenAbsenceRate = rate(scenarioSummary.forbiddenAbsent, scenarioSummary.forbiddenChecks);
  scenarioSummaries[scenario.id] = scenarioSummary;
  for (const key of ["passingRuns", "failingRuns", "requiredItems", "requiredPasses", "requiredFailures", "forbiddenChecks", "forbiddenAbsent", "forbiddenPresent"]) {
    aggregate[key] += scenarioSummary[key];
  }
}

aggregate.requiredPassRate = rate(aggregate.requiredPasses, aggregate.requiredItems);
aggregate.forbiddenAbsenceRate = rate(aggregate.forbiddenAbsent, aggregate.forbiddenChecks);

if (mode === "green") {
  assert.equal(aggregate.passingRuns, rubric.passRule.passingRuns, "GREEN requires 25/25 PASS");
  assert.equal(aggregate.requiredPassRate, rubric.passRule.requiredPassRate, "GREEN required threshold failed");
  assert.equal(aggregate.forbiddenAbsenceRate, rubric.passRule.forbiddenAbsenceRate, "GREEN forbidden threshold failed");
}

let evaluation;
let baselineComparison;
if (mode === "green") {
  const metadataPath = path.join(runsRoot, "run-metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assertExactKeys(
    metadata,
    [
      "schemaVersion",
      "runCount",
      "startedAt",
      "completedAt",
      "durationMs",
      "environment",
    ],
    "run metadata",
  );
  assert.equal(metadata.schemaVersion, "1.0.0", "run metadata schemaVersion drift");
  assert.equal(metadata.runCount, publicRuns.length, "run metadata count drift");
  const startedAtMs = requireCanonicalIsoTimestamp(metadata.startedAt, "run metadata startedAt");
  const completedAtMs = requireCanonicalIsoTimestamp(metadata.completedAt, "run metadata completedAt");
  if (completedAtMs < startedAtMs) throw new Error("run metadata completion precedes start");
  assert.equal(
    metadata.durationMs,
    completedAtMs - startedAtMs,
    "run metadata duration does not match the evaluation window",
  );
  assertExactKeys(
    metadata.environment,
    [
      "codexCli",
      "platform",
      "architecture",
      "sandbox",
      "executionContext",
      "reviewerContext",
    ],
    "run metadata environment",
  );
  const environment = metadata.environment;
  if (!/^codex-cli (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(environment.codexCli)) {
    throw new Error("run metadata environment codexCli is not an allowed label");
  }
  if (!["darwin", "linux", "win32"].includes(environment.platform)) {
    throw new Error("run metadata environment platform is not allowed");
  }
  if (!["arm64", "x64"].includes(environment.architecture)) {
    throw new Error("run metadata environment architecture is not allowed");
  }
  assert.equal(environment.sandbox, "read-only", "Agent sandbox must be read-only");
  assert.equal(environment.executionContext, "ephemeral", "Agent context must be ephemeral");
  assert.equal(
    environment.reviewerContext,
    "ephemeral-read-only",
    "reviewer context must be ephemeral and read-only",
  );
  const modelLabels = [...new Set(publicRuns.map((run) => run.model))].sort();
  assert.deepEqual(modelLabels, [EXPECTED_MODEL_LABEL], "public model labels drift");
  evaluation = {
    timing: {
      startedAt: metadata.startedAt,
      completedAt: metadata.completedAt,
      durationMs: metadata.durationMs,
    },
    reportedEnvironment: {
      ...environment,
      modelLabels,
    },
  };

  const baselineBytes = await fs.readFile(path.resolve(baselineFlag));
  const baselineSha256 = sha256(baselineBytes);
  assert.equal(baselineSha256, FROZEN_BASELINE_SHA256, "baseline frozen SHA256 mismatch");
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  assert.equal(baseline.schemaVersion, "1.0.0", "baseline schemaVersion drift");
  assert.equal(baseline.mode, "baseline", "comparison input must be a baseline summary");
  assert.equal(baseline.runCount, publicRuns.length, "baseline run count drift");
  assert.deepEqual(baseline.thresholds, {
    microtestRuns: rubric.passRule.microtestRuns,
    passingRuns: rubric.passRule.passingRuns,
    requiredPassRate: rubric.passRule.requiredPassRate,
    forbiddenAbsenceRate: rubric.passRule.forbiddenAbsenceRate,
  }, "baseline thresholds drift");
  if (typeof baseline.runLabel !== "string" || !/^[a-z0-9-]+$/.test(baseline.runLabel)) {
    throw new Error("baseline runLabel is invalid");
  }
  const baselinePassingRuns = baseline.aggregate?.passingRuns;
  if (!Number.isInteger(baselinePassingRuns) || baselinePassingRuns < 0 || baselinePassingRuns > publicRuns.length) {
    throw new Error("baseline passingRuns is invalid");
  }
  const baselineRequiredPassRate = requireRate(
    baseline.aggregate?.requiredPassRate,
    "baseline requiredPassRate",
  );
  const baselineForbiddenAbsenceRate = requireRate(
    baseline.aggregate?.forbiddenAbsenceRate,
    "baseline forbiddenAbsenceRate",
  );
  assert.equal(
    baseline.aggregate.passingRuns + baseline.aggregate.failingRuns,
    baseline.runCount,
    "baseline run totals are inconsistent",
  );
  assert.equal(
    baseline.aggregate.requiredPasses + baseline.aggregate.requiredFailures,
    baseline.aggregate.requiredItems,
    "baseline required totals are inconsistent",
  );
  assert.equal(
    baseline.aggregate.requiredPassRate,
    rate(baseline.aggregate.requiredPasses, baseline.aggregate.requiredItems),
    "baseline required rate is inconsistent",
  );
  assert.equal(
    baseline.aggregate.forbiddenAbsent + baseline.aggregate.forbiddenPresent,
    baseline.aggregate.forbiddenChecks,
    "baseline forbidden totals are inconsistent",
  );
  assert.equal(
    baseline.aggregate.forbiddenAbsenceRate,
    rate(baseline.aggregate.forbiddenAbsent, baseline.aggregate.forbiddenChecks),
    "baseline forbidden rate is inconsistent",
  );
  baselineComparison = {
    baselineRunLabel: baseline.runLabel,
    baselineSummarySha256: baselineSha256,
    passingRuns: {
      baseline: baselinePassingRuns,
      current: aggregate.passingRuns,
      delta: aggregate.passingRuns - baselinePassingRuns,
    },
    requiredPassRate: {
      baseline: baselineRequiredPassRate,
      current: aggregate.requiredPassRate,
      delta: aggregate.requiredPassRate - baselineRequiredPassRate,
    },
    forbiddenAbsenceRate: {
      baseline: baselineForbiddenAbsenceRate,
      current: aggregate.forbiddenAbsenceRate,
      delta: aggregate.forbiddenAbsenceRate - baselineForbiddenAbsenceRate,
    },
  };
}

const summary = {
  schemaVersion: mode === "green" ? "1.1.0" : "1.0.0",
  mode,
  runLabel: `${mode}-agent-forward-v1`,
  evidenceRetention: {
    publicCandidate: "summary-and-hashes-only",
    rawEvidenceIncluded: false,
    rawEvidenceLocation: "ignored-local-runs",
  },
  runCount: publicRuns.length,
  thresholds: {
    microtestRuns: rubric.passRule.microtestRuns,
    passingRuns: rubric.passRule.passingRuns,
    requiredPassRate: rubric.passRule.requiredPassRate,
    forbiddenAbsenceRate: rubric.passRule.forbiddenAbsenceRate,
  },
  aggregate,
  scenarios: scenarioSummaries,
  failureCounts,
  runs: publicRuns,
  ...(evaluation ? { evaluation, baselineComparison } : {}),
};

const serialized = JSON.stringify(summary, null, 2);
assert.doesNotMatch(serialized, /\/Users\/[^/]+\//, "public summary leaks a macOS user path");
assert.doesNotMatch(serialized, /[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\/, "public summary leaks a Windows user path");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${serialized}\n`);
