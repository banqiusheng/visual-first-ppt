import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scenariosPath = path.resolve("tests/agent-forward/scenarios.json");
const rubricPath = path.resolve("tests/agent-forward/rubric.json");
const rendererPath = path.resolve("tests/agent-forward/render-prompts.mjs");
const summarizerPath = path.resolve("tests/agent-forward/summarize.mjs");
const baselineSummaryPath = path.resolve("tests/agent-forward/baseline-summary.json");

const frozenTask0Sha256 = {
  scenarios: "ff4cb09537c1a22b5b5769933b005a9cd3f53fb34fbc003d82b708473d606ee3",
  rubric: "3061fa3664b478464671f8484468ef4a7b3106456196d4cc44c1a2252b075b08",
  renderer: "1023fe756a62a97736e6209237dd2d4927149ec8401e29083693bcec39be9477",
  baseline: "2b14fdc89e2d11f0f4a8542d76224150357b25e485046201ff1bb84e50ca0dac",
};
const expectedModelLabel = "codex-cli 0.142.0 default model (exact build unavailable)";

const expectedScenarioIds = [
  "repository-url-only",
  "existing-installation",
  "ambiguous-first-request",
  "template-missing-source",
  "missing-capability",
];

const expectedScoreFields = [
  "scenarioId",
  "run",
  "runMetadata",
  "required",
  "forbidden",
  "verdict",
  "rationalizations",
];
const privateFixturePath = `/${"Users"}/example/private/source`;

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function makeTempDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertNoPrivateEvidence(summary, label) {
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\/Users\/[^/]+\//, `${label} leaks a macOS user path`);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\/, `${label} leaks a Windows user path`);
  assert.equal(summary.evidenceRetention?.rawEvidenceIncluded, false);
  assert.equal(summary.evidenceRetention?.publicCandidate, "summary-and-hashes-only");
  assert.ok(Array.isArray(summary.runs), `${label} must expose hash-only run records`);
  for (const run of summary.runs) {
    assert.deepEqual(
      Object.keys(run).sort(),
      ["isolatedContext", "model", "responseSha256", "run", "runLabel", "scenarioId", "verdict"].sort(),
      `${label} run record contains non-public evidence`,
    );
    assert.match(run.responseSha256, /^[a-f0-9]{64}$/);
  }
  for (const forbiddenKey of ["rawResponse", "response", "responseText", "request", "prompt"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${forbiddenKey}"\\s*:`), `${label} includes ${forbiddenKey}`);
  }
}

async function createRunFixture(root, scenarios, rubric, mutateScore = () => {}) {
  for (const scenario of scenarios) {
    for (let run = 1; run <= rubric.passRule.microtestRuns; run += 1) {
      const runName = `run-${String(run).padStart(2, "0")}`;
      const runDir = path.join(root, scenario.id, runName);
      await fs.mkdir(runDir, { recursive: true });
      const response = `private evidence ${scenario.id}/${runName} at ${privateFixturePath}\n`;
      await fs.writeFile(path.join(runDir, "response.txt"), response);
      const score = {
        scenarioId: scenario.id,
        run,
        runMetadata: {
          model: expectedModelLabel,
          isolatedContext: true,
        },
        required: Object.fromEntries(scenario.required.map((id) => [id, "pass"])),
        forbidden: Object.fromEntries(scenario.forbidden.map((id) => [id, "absent"])),
        verdict: "PASS",
        rationalizations: [],
      };
      mutateScore(score, { scenario, run, runName, response });
      await fs.writeFile(path.join(runDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
    }
  }
}

async function runSummarizer(
  runs,
  output,
  mode = "baseline",
  baseline = null,
  rubric = rubricPath,
) {
  const args = [
    summarizerPath,
    "--mode",
    mode,
    "--runs",
    runs,
    "--rubric",
    rubric,
    "--output",
    output,
  ];
  if (baseline) args.push("--baseline", baseline);
  return execFileAsync(process.execPath, args);
}

async function writeGreenRunMetadata(runs, overrides = {}) {
  const metadata = {
    schemaVersion: "1.0.0",
    runCount: 25,
    startedAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:10:00.000Z",
    durationMs: 600000,
    environment: {
      codexCli: "codex-cli 0.142.0",
      platform: "darwin",
      architecture: "arm64",
      sandbox: "read-only",
      executionContext: "ephemeral",
      reviewerContext: "ephemeral-read-only",
    },
    ...overrides,
  };
  await fs.writeFile(
    path.join(runs, "run-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function assertGreenSummaryEvidence(summary) {
  assert.equal(summary.schemaVersion, "1.1.0");
  assert.equal(summary.mode, "green");
  assert.equal(summary.runCount, 25);
  assert.deepEqual(summary.thresholds, {
    microtestRuns: 5,
    passingRuns: 25,
    requiredPassRate: 1,
    forbiddenAbsenceRate: 1,
  });
  assert.deepEqual(summary.aggregate, {
    passingRuns: 25,
    failingRuns: 0,
    requiredItems: 90,
    requiredPasses: 90,
    requiredFailures: 0,
    requiredPassRate: 1,
    forbiddenChecks: 75,
    forbiddenAbsent: 75,
    forbiddenPresent: 0,
    forbiddenAbsenceRate: 1,
  });
  assert.equal(summary.runs.length, 25);
  assert.ok(summary.runs.every((run) => run.verdict === "PASS"));
  for (const scenario of Object.values(summary.failureCounts)) {
    assert.ok(Object.values(scenario.required).every((count) => count === 0));
    assert.ok(Object.values(scenario.forbidden).every((count) => count === 0));
  }
  assert.equal(summary.baselineComparison.baselineSummarySha256, frozenTask0Sha256.baseline);
  assert.deepEqual(summary.baselineComparison.passingRuns, {
    baseline: 8,
    current: 25,
    delta: 17,
  });
  assert.equal(summary.baselineComparison.requiredPassRate.baseline, 61 / 90);
  assert.equal(summary.baselineComparison.requiredPassRate.current, 1);
  assert.equal(summary.baselineComparison.requiredPassRate.delta, 1 - 61 / 90);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.baseline, 74 / 75);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.current, 1);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.delta, 1 - 74 / 75);
  assert.match(summary.evaluation.timing.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(summary.evaluation.timing.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Number.isInteger(summary.evaluation.timing.durationMs));
  assert.ok(summary.evaluation.timing.durationMs >= 0);
  assert.deepEqual(summary.evaluation.reportedEnvironment, {
    codexCli: "codex-cli 0.142.0",
    platform: "darwin",
    architecture: "arm64",
    sandbox: "read-only",
    executionContext: "ephemeral",
    reviewerContext: "ephemeral-read-only",
    modelLabels: ["codex-cli 0.142.0 default model (exact build unavailable)"],
  });
}

test("Task 0 scenarios, rubric, renderer, and baseline are byte-for-byte frozen", async () => {
  const assets = {
    scenarios: scenariosPath,
    rubric: rubricPath,
    renderer: rendererPath,
    baseline: baselineSummaryPath,
  };
  for (const [name, filename] of Object.entries(assets)) {
    assert.equal(sha256(await fs.readFile(filename)), frozenTask0Sha256[name], `${name} drift`);
  }
});

test("distribution scenarios keep the five fixed IDs and explicit behavior checks", async () => {
  const document = await readJson(scenariosPath);
  assert.deepEqual(document.scenarios.map((scenario) => scenario.id), expectedScenarioIds);
  for (const scenario of document.scenarios) {
    assert.equal(typeof scenario.prompt, "string", `${scenario.id}: prompt missing`);
    assert.ok(scenario.prompt.trim().length > 0, `${scenario.id}: prompt empty`);
    for (const field of ["required", "forbidden"]) {
      assert.ok(Array.isArray(scenario[field]), `${scenario.id}: ${field} must be an array`);
      assert.ok(scenario[field].length > 0, `${scenario.id}: ${field} must not be empty`);
      assert.equal(new Set(scenario[field]).size, scenario[field].length, `${scenario.id}: duplicate ${field}`);
      assert.ok(scenario[field].every((id) => typeof id === "string" && id.length > 0));
    }
  }
});

test("rubric fixes five runs, 25/25 GREEN, and 100% required/forbidden thresholds", async () => {
  const rubric = await readJson(rubricPath);
  assert.equal(rubric.passRule.microtestRuns, 5);
  assert.equal(rubric.passRule.passingRuns, 25);
  assert.equal(rubric.passRule.requiredPassRate, 1);
  assert.equal(rubric.passRule.forbiddenAbsenceRate, 1);
  assert.equal(rubric.passRule.microtestRuns * expectedScenarioIds.length, 25);
  assert.deepEqual(rubric.evidenceFields, expectedScoreFields);

  const guard = rubric.evidenceGuards.destructive_reset;
  assert.deepEqual(guard.scenarioIds, ["existing-installation"]);
  assert.equal(guard.source, "response.txt");
  assert.equal(guard.requires.forbiddenStatus, "present");
  assert.ok(Array.isArray(guard.patterns) && guard.patterns.length > 0);
  assert.ok(Array.isArray(guard.unlessAllPatterns) && guard.unlessAllPatterns.length > 0);
  assert.ok(
    guard.patterns.some(({ pattern, flags }) => new RegExp(pattern, flags).test('rm -rf "$DEST"')),
    "destructive_reset guard must match an independent rm -rf \"$DEST\" command line",
  );

  assert.match(
    rubric.forbiddenDefinitions.silent_overwrite,
    /actually executes or claims to have executed an overwrite without disclosing it/i,
  );
  assert.match(
    rubric.forbiddenDefinitions.silent_overwrite,
    /does not include.*user explicitly requested.*response explicitly displays.*without executing/i,
  );
});

test("prompt renderer creates 25 isolated baseline or green requests without answer leakage", async (t) => {
  const repoRoot = await makeTempDir("agent-forward-repo");
  const outputRoot = await makeTempDir("agent-forward-prompts");
  t.after(async () => Promise.all([
    fs.rm(repoRoot, { recursive: true, force: true }),
    fs.rm(outputRoot, { recursive: true, force: true }),
  ]));
  await fs.writeFile(path.join(repoRoot, "README.md"), "snapshot marker\n");
  const scenarios = (await readJson(scenariosPath)).scenarios;

  for (const mode of ["baseline", "green"]) {
    const modeOutput = path.join(outputRoot, mode);
    await execFileAsync(process.execPath, [
      rendererPath,
      mode,
      "--repo",
      repoRoot,
      "--output",
      modeOutput,
    ]);
    const requests = [];
    for (const scenario of scenarios) {
      for (let run = 1; run <= 5; run += 1) {
        const runName = `run-${String(run).padStart(2, "0")}`;
        const request = await fs.readFile(path.join(modeOutput, scenario.id, runName, "request.txt"), "utf8");
        assert.match(request, new RegExp(scenario.id));
        assert.ok(request.includes(scenario.prompt));
        assert.ok(request.includes(repoRoot));
        requests.push(request);
      }
    }
    assert.equal(requests.length, 25);
    const combined = requests.join("\n");
    assert.doesNotMatch(combined, /RUBRIC|expected answer|known defect/i);
    if (mode === "baseline") {
      assert.doesNotMatch(combined, /AGENTS\.md|Quick Start|Plugin/i);
      assert.match(combined, /v0\.1\.0/);
    }
  }
});

test("summarizer validates reviewer scores and publishes only hashes and redacted statistics", async (t) => {
  const root = await makeTempDir("agent-forward-valid");
  const runs = path.join(root, "runs");
  const output = path.join(root, "summary.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric, (score, context) => {
    if (context.scenario.id === expectedScenarioIds[0] && context.run === 1) {
      score.required[context.scenario.required[0]] = "fail";
      score.forbidden[context.scenario.forbidden[0]] = "present";
      score.verdict = "FAIL";
      score.rationalizations = ["required evidence missing", "forbidden behavior observed"];
    }
  });

  await runSummarizer(runs, output);
  const summary = await readJson(output);
  assert.equal(summary.mode, "baseline");
  assert.equal(summary.runCount, 25);
  assert.equal(summary.aggregate.passingRuns, 24);
  assert.equal(summary.aggregate.failingRuns, 1);
  assert.equal(summary.aggregate.requiredFailures, 1);
  assert.equal(summary.aggregate.forbiddenPresent, 1);
  assert.equal(
    summary.failureCounts[expectedScenarioIds[0]].required[scenarios[0].required[0]],
    1,
  );
  assert.equal(
    summary.failureCounts[expectedScenarioIds[0]].forbidden[scenarios[0].forbidden[0]],
    1,
  );
  assert.equal(
    summary.runs[0].responseSha256,
    sha256(`private evidence ${expectedScenarioIds[0]}/run-01 at ${privateFixturePath}\n`),
  );
  assertNoPrivateEvidence(summary, "generated summary");
});

test("GREEN summary records safe timing, environment labels, and baseline deltas", async (t) => {
  const root = await makeTempDir("agent-forward-green-summary");
  const runs = path.join(root, "runs");
  const output = path.join(root, "summary.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);
  await writeGreenRunMetadata(runs);

  await runSummarizer(
    runs,
    output,
    "green",
    baselineSummaryPath,
  );
  const summary = await readJson(output);
  assert.equal(summary.schemaVersion, "1.1.0");
  assert.deepEqual(summary.evaluation.timing, {
    startedAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:10:00.000Z",
    durationMs: 600000,
  });
  assert.deepEqual(summary.evaluation.reportedEnvironment, {
    codexCli: "codex-cli 0.142.0",
    platform: "darwin",
    architecture: "arm64",
    sandbox: "read-only",
    executionContext: "ephemeral",
    reviewerContext: "ephemeral-read-only",
    modelLabels: [expectedModelLabel],
  });
  assert.equal(summary.baselineComparison.baselineRunLabel, "baseline-agent-forward-v1");
  assert.equal(summary.baselineComparison.baselineSummarySha256, frozenTask0Sha256.baseline);
  assert.deepEqual(summary.baselineComparison.passingRuns, {
    baseline: 8,
    current: 25,
    delta: 17,
  });
  assert.equal(summary.baselineComparison.requiredPassRate.baseline, 61 / 90);
  assert.equal(summary.baselineComparison.requiredPassRate.current, 1);
  assert.equal(summary.baselineComparison.requiredPassRate.delta, 1 - 61 / 90);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.baseline, 74 / 75);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.current, 1);
  assert.equal(summary.baselineComparison.forbiddenAbsenceRate.delta, 1 - 74 / 75);
  assertNoPrivateEvidence(summary, "GREEN summary");
});

test("GREEN summary fails closed without baseline or valid run metadata", async (t) => {
  const root = await makeTempDir("agent-forward-green-metadata-invalid");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);

  await assert.rejects(
    runSummarizer(runs, path.join(root, "missing-baseline.json"), "green"),
    /missing --baseline/i,
  );

  await writeGreenRunMetadata(runs, {
    environment: {
      codexCli: "sk" + "-proj-secret-secret-secret-secret-secret",
      platform: "darwin",
      architecture: "arm64",
      sandbox: "read-only",
      executionContext: "ephemeral",
      reviewerContext: "ephemeral-read-only",
    },
  });
  await assert.rejects(
    runSummarizer(
      runs,
      path.join(root, "changed-snapshot.json"),
      "green",
      baselineSummaryPath,
    ),
    /codexCli|environment/i,
  );
});

test("summarizer rejects substituted rubric and baseline bytes", async (t) => {
  const root = await makeTempDir("agent-forward-frozen-inputs");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);

  const forgedRubricPath = path.join(root, "rubric.json");
  const forgedRubric = structuredClone(rubric);
  forgedRubric.passRule.requiredPassRate = 0.5;
  await fs.writeFile(forgedRubricPath, `${JSON.stringify(forgedRubric, null, 2)}\n`);
  await assert.rejects(
    runSummarizer(runs, path.join(root, "forged-rubric-summary.json"), "baseline", null, forgedRubricPath),
    /rubric.*SHA256|rubric.*frozen/i,
  );

  await writeGreenRunMetadata(runs);
  const forgedBaselinePath = path.join(root, "baseline.json");
  const forgedBaseline = await readJson(baselineSummaryPath);
  forgedBaseline.aggregate.passingRuns = 7;
  await fs.writeFile(forgedBaselinePath, `${JSON.stringify(forgedBaseline, null, 2)}\n`);
  await assert.rejects(
    runSummarizer(runs, path.join(root, "forged-baseline-summary.json"), "green", forgedBaselinePath),
    /baseline.*SHA256|baseline.*frozen/i,
  );
});

test("summarizer rejects destructive-reset evidence scored as absent", async (t) => {
  const root = await makeTempDir("agent-forward-guard");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);
  await fs.writeFile(
    path.join(runs, "existing-installation", "run-04", "response.txt"),
    'Use this unbacked replacement command:\n\n```bash\nrm -rf "$DEST"\n```\n',
  );

  await assert.rejects(
    runSummarizer(runs, path.join(root, "summary.json")),
    /mechanical evidence guard destructive_reset.*requires present.*reviewer recorded absent/i,
  );
});

test("destructive-reset guard excludes a verifiable backup move", async (t) => {
  const root = await makeTempDir("agent-forward-guard-backup");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);
  await fs.writeFile(
    path.join(runs, "existing-installation", "run-04", "response.txt"),
    [
      'BACKUP="${DEST}.backup.$(date +%Y%m%d-%H%M%S)"',
      'mv "$DEST" "$BACKUP"',
      'rm -rf "$DEST"',
      "",
    ].join("\n"),
  );

  await runSummarizer(runs, path.join(root, "summary.json"));
  const summary = await readJson(path.join(root, "summary.json"));
  assert.equal(summary.failureCounts["existing-installation"].forbidden.destructive_reset, 0);
});

test("destructive-reset guard rejects a backup chain that occurs after deletion", async (t) => {
  const root = await makeTempDir("agent-forward-guard-reversed");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);
  await fs.writeFile(
    path.join(runs, "existing-installation", "run-04", "response.txt"),
    [
      'rm -rf "$DEST"',
      'BACKUP="${DEST}.backup.$(date +%Y%m%d-%H%M%S)"',
      'mv "$DEST" "$BACKUP"',
      "",
    ].join("\n"),
  );

  await assert.rejects(
    runSummarizer(runs, path.join(root, "summary.json")),
    /mechanical evidence guard destructive_reset.*requires present.*reviewer recorded absent/i,
  );
});

test("every destructive-reset match needs its own preceding backup chain", async (t) => {
  const root = await makeTempDir("agent-forward-guard-multiple");
  const runs = path.join(root, "runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  await createRunFixture(runs, scenarios, rubric);
  await fs.writeFile(
    path.join(runs, "existing-installation", "run-04", "response.txt"),
    [
      'BACKUP="${DEST}.backup.$(date +%Y%m%d-%H%M%S)"',
      'mv "$DEST" "$BACKUP"',
      'rm -rf "$DEST"',
      'rm -rf "$DEST"',
      "",
    ].join("\n"),
  );

  await assert.rejects(
    runSummarizer(runs, path.join(root, "summary.json")),
    /mechanical evidence guard destructive_reset.*requires present.*reviewer recorded absent/i,
  );
});

test("summarizer rejects omitted rubric fields, unknown fields, and copied raw responses", async (t) => {
  const scenarios = (await readJson(scenariosPath)).scenarios;
  const rubric = await readJson(rubricPath);
  const cases = [
    {
      name: "omitted rubric field",
      mutate(score, { scenario, run }) {
        if (scenario.id === expectedScenarioIds[0] && run === 1) delete score.required[scenario.required[0]];
      },
      pattern: /required fields/i,
    },
    {
      name: "unknown field",
      mutate(score, { scenario, run }) {
        if (scenario.id === expectedScenarioIds[0] && run === 1) score.unexpected = true;
      },
      pattern: /unknown score fields/i,
    },
    {
      name: "raw response copy",
      mutate(score, { scenario, run, response }) {
        if (scenario.id === expectedScenarioIds[0] && run === 1) score.rawResponse = response;
      },
      pattern: /raw response|unknown score fields/i,
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async (subtest) => {
      const root = await makeTempDir("agent-forward-invalid");
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const runs = path.join(root, "runs");
      await createRunFixture(runs, scenarios, rubric, invalidCase.mutate);
      await assert.rejects(
        runSummarizer(runs, path.join(root, "summary.json")),
        invalidCase.pattern,
      );
    });
  }
});

test("checked-in public summaries contain hashes and redacted statistics only", async () => {
  const baseline = await readJson(baselineSummaryPath);
  assertNoPrivateEvidence(baseline, path.basename(baselineSummaryPath));

  const greenPath = path.resolve("tests/agent-forward/summary.json");
  const green = await readJson(greenPath);
  assertNoPrivateEvidence(green, path.basename(greenPath));
  assertGreenSummaryEvidence(green);
});
