import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  buildQaReport,
  EDIT_REQUIRED_CHECKS,
  HARD_ZERO,
  REQUIRED_AUTOMATED_CHECKS,
  REQUIRED_MANUAL_DIMENSIONS,
  REQUIRED_REVIEW_CHECKS,
} from "../../skills/visual-first-ppt/scripts/build-qa-report.mjs";
import { validateSchema } from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "visual-first-ppt-qa-"));
const CURRENT_QA_VALIDATOR = path.resolve(
  "skills/visual-first-ppt/scripts/validate-current-qa.mjs",
);
const OOXML_CHECK_IDS = new Set([
  "textFramePolicy",
  "safeMargin",
  "fontResolution",
  "contentPresence",
  "hiddenVisualResidue",
]);

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

async function loadProjectArtifactsSchema() {
  return JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
}

function validateProjectArtifactDefinition(schema, definition, value) {
  return validateSchema(
    { $defs: schema.$defs, $ref: `#/$defs/${definition}` },
    value,
  );
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const header = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function pngBytes(width = 1600, height = 900, shade = 255, {
  bitDepth = 8,
  colorType = 2,
  compressionMethod = 0,
  filterMethod = 0,
  interlaceMethod = 0,
  rawPayload,
  idatPayload,
} = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod], 8);
  const channels = colorType === 6 ? 4 : 3;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * channels, shade)]);
  const raw = rawPayload ?? Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatPayload ?? zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function corruptChunkCrc(payload, targetType) {
  const corrupted = Buffer.from(payload);
  let offset = 8;
  while (offset + 12 <= corrupted.length) {
    const length = corrupted.readUInt32BE(offset);
    const type = corrupted.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (type === targetType) {
      corrupted[end - 1] ^= 0xff;
      return corrupted;
    }
    offset = end;
  }
  throw new Error(`PNG chunk not found: ${targetType}`);
}

function replaceChunkType(payload, targetType, rawType) {
  const mutated = Buffer.from(payload);
  let offset = 8;
  while (offset + 12 <= mutated.length) {
    const length = mutated.readUInt32BE(offset);
    const type = mutated.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (type === targetType) {
      assert.equal(rawType.length, 4);
      rawType.copy(mutated, offset + 4);
      const body = mutated.subarray(offset + 4, offset + 8 + length);
      mutated.writeUInt32BE(crc32(body), offset + 8 + length);
      return mutated;
    }
    offset = end;
  }
  throw new Error(`PNG chunk not found: ${targetType}`);
}

function invalidPngCases() {
  return [
    ["wrong chunk CRC", corruptChunkCrc(pngBytes(2, 1), "IDAT")],
    ["non-decompressible IDAT", pngBytes(2, 1, 255, { idatPayload: Buffer.from("not-zlib") })],
    ["illegal IHDR", pngBytes(2, 1, 255, { colorType: 3 })],
    ["wrong scanline length", pngBytes(2, 1, 255, { rawPayload: Buffer.alloc(6) })],
    ["illegal scanline filter", pngBytes(2, 1, 255, { rawPayload: Buffer.from([5, 0, 0, 0, 0, 0, 0]) })],
  ];
}

function ambiguousPngCases() {
  const width = 2;
  const height = 1;
  const raw = Buffer.from([0, 0, 0, 0, 0, 0, 0]);
  const legalStream = zlib.deflateSync(raw);
  return [
    [
      "high-bit chunk type aliases to IDAT under permissive ASCII",
      replaceChunkType(pngBytes(width, height), "IDAT", Buffer.from([0xc9, 0x44, 0x41, 0x54])),
    ],
    [
      "garbage after legal zlib stream",
      pngBytes(width, height, 255, { idatPayload: Buffer.concat([legalStream, Buffer.from("junk")]) }),
    ],
    [
      "second zlib stream",
      pngBytes(width, height, 255, { idatPayload: Buffer.concat([legalStream, zlib.deflateSync(Buffer.from("extra"))]) }),
    ],
  ];
}

function automated(route = "create") {
  const ids = route === "edit"
    ? [...REQUIRED_AUTOMATED_CHECKS, ...EDIT_REQUIRED_CHECKS]
    : [...REQUIRED_AUTOMATED_CHECKS];
  return ids.map((id) => ({
    id,
    value: id === "pageCountAndCanvas" ? 1 : (HARD_ZERO.includes(id) ? 0 : null),
  }));
}

function manualSlides(slides, score = 5) {
  return slides.map((slide) => ({
    slide,
    reviewer: "local-review",
    scores: Object.fromEntries(REQUIRED_MANUAL_DIMENSIONS.map((dimension) => [dimension, score])),
    evidencePath: `previews/slide-${slide}.png`,
    ...(score === 4 ? { notes: "Observable issue reviewed and accepted" } : {}),
  }));
}

function manual(score = 5) {
  return manualSlides([1], score);
}

function reviewSlides(slides) {
  return slides.map((slide) => ({
    slide,
    reviewer: "local-review",
    evidencePath: `previews/slide-${slide}.png`,
    checks: Object.fromEntries(REQUIRED_REVIEW_CHECKS.map((id) => [id, {
      status: "PASS",
      notes: `${id} reviewed on the full slide`,
    }])),
  }));
}

async function writeInputs(name, {
  route = "create",
  checks = automated(route),
  scores = manual(),
  smoke,
  themeTargetClient = "Microsoft PowerPoint",
  materializeEvidence = true,
} = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const deckPath = path.join(dir, "deck.pptx");
  const slideSpecsPath = path.join(dir, "slide-specs.json");
  const themeLockPath = path.join(dir, "theme-lock.json");
  const artifactPayloads = {
    deck: Buffer.from(`deck-${name}`),
    slideSpecs: Buffer.from(`${JSON.stringify({ slides: scores.map((entry) => ({ slide: entry.slide })) })}\n`),
    themeLock: Buffer.from(`${JSON.stringify({
      themeId: "neutral",
      targetClient: themeTargetClient,
    })}\n`),
  };
  await fs.writeFile(deckPath, artifactPayloads.deck);
  await fs.writeFile(slideSpecsPath, artifactPayloads.slideSpecs);
  await fs.writeFile(themeLockPath, artifactPayloads.themeLock);
  const inputHashes = Object.fromEntries(Object.entries(artifactPayloads).map(([id, value]) => [id, sha256(value)]));
  const automatedChecks = [];
  const evidenceById = new Map();
  const ooxmlEvidencePath = path.join(dir, "qa", "ooxml-quality-bundle.json");
  for (const check of checks) {
    const evidencePath = OOXML_CHECK_IDS.has(check.id)
      ? ooxmlEvidencePath
      : path.join(dir, "qa", `${check.id}.json`);
    automatedChecks.push({ id: check.id, evidencePath });
    evidenceById.set(check.id, evidencePath);
    if (materializeEvidence && !OOXML_CHECK_IDS.has(check.id)) {
      await fs.mkdir(path.dirname(evidencePath), { recursive: true });
      await fs.writeFile(evidencePath, `${JSON.stringify({
        artifactType: "perCheckEvidence",
        schemaVersion: "1.0.0",
        qualityContractVersion: "1.0.0",
        checker: { id: check.id, version: "1.0.0" },
        checkId: check.id,
        inputHashes,
        check: {
          status: "PASS",
          value: check.value ?? 0,
          violations: [],
        },
        finalVerdict: "PASS",
        generatedAt: "2026-07-17T00:00:00.000Z",
      }, null, 2)}\n`);
    }
  }
  if (materializeEvidence) {
    const ooxmlChecks = Object.fromEntries([...OOXML_CHECK_IDS].map((id) => {
      const source = checks.find((entry) => entry.id === id);
      return [id, { status: "PASS", value: source?.value ?? 0, violations: [] }];
    }));
    await fs.mkdir(path.dirname(ooxmlEvidencePath), { recursive: true });
    await fs.writeFile(ooxmlEvidencePath, `${JSON.stringify({
      artifactType: "automatedEvidenceBundle",
      schemaVersion: "1.0.0",
      qualityContractVersion: "1.0.0",
      checker: { id: "audit-pptx-quality", version: "1.0.0" },
      inputHashes: { ...inputHashes, objectInventory: sha256("inventory") },
      checks: ooxmlChecks,
      finalVerdict: "PASS",
      generatedAt: "2026-07-17T00:00:00.000Z",
    }, null, 2)}\n`);
  }
  const manualScores = scores.map((entry) => ({ ...entry, scores: { ...entry.scores } }));
  const reviewChecks = reviewSlides(scores.map((entry) => entry.slide));
  const clientSmoke = { ...(smoke || {
    status: "passed",
    evidencePath: "qa/client-smoke.json",
    targetClient: "Microsoft PowerPoint",
  }) };
  const clientSmokeEvidence = clientSmoke.evidencePayload || {
    artifactType: "clientSmokeEvidence",
    schemaVersion: "1.0.0",
    targetClient: clientSmoke.targetClient,
    observationMode: "gui-open",
    openedArtifactHash: inputHashes.deck,
    observations: {
      applicationWindowVisible: true,
      deckOpened: true,
      slideCanvasVisible: true,
    },
    observedAt: "2026-07-17T00:00:00.000Z",
  };
  if (clientSmokeEvidence.openedArtifactHash === "AUTO_DECK_HASH") {
    clientSmokeEvidence.openedArtifactHash = inputHashes.deck;
  }
  delete clientSmoke.evidencePayload;
  for (const record of [...reviewChecks, ...manualScores, clientSmoke]) {
    const absolute = path.isAbsolute(record.evidencePath) ? record.evidencePath : path.join(dir, record.evidencePath);
    record.evidencePath = absolute;
    if (materializeEvidence) {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (absolute.endsWith(".png")) {
        const match = path.basename(absolute).match(/^slide-(\d+)\.png$/);
        await fs.writeFile(absolute, pngBytes(1600, 900, match ? Number(match[1]) : 255));
      } else if (record === clientSmoke && clientSmoke.evidencePath) {
        await fs.writeFile(absolute, `${JSON.stringify(clientSmokeEvidence, null, 2)}\n`);
      } else {
        await fs.writeFile(absolute, "verified evidence\n");
      }
    }
  }
  const values = {
    inputArtifacts: {
      deck: { path: deckPath, sha256: "sha256:caller-supplied-hash-is-ignored" },
      slideSpecs: { path: slideSpecsPath },
      themeLock: { path: themeLockPath },
    },
    toolVersions: { node: process.version },
    automatedChecks,
    reviewChecks,
    manualScores,
    clientSmoke,
  };
  const paths = {};
  for (const [key, value] of Object.entries(values)) {
    paths[key] = path.join(dir, `${key}.json`);
    await fs.writeFile(paths[key], `${JSON.stringify(value, null, 2)}\n`);
  }
  const legacyInputHashesPath = path.join(dir, "inputHashes.json");
  await fs.writeFile(legacyInputHashesPath, `${JSON.stringify(inputHashes)}\n`);
  return {
    name,
    dir,
    route,
    paths,
    values,
    inputHashes,
    evidenceById,
    legacyInputHashesPath,
    output: path.join(dir, "qa-report.json"),
  };
}

async function writeInputsToDisk(input) {
  for (const [key, value] of Object.entries(input.values)) {
    await fs.writeFile(input.paths[key], `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function mutateEvidence(input, checkId, patch) {
  const evidencePath = input.evidenceById.get(checkId);
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  Object.assign(evidence, patch);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function buildInput(input) {
  return buildQaReport({
    projectId: `ppt-${input.name}`,
    route: input.route,
    inputArtifactsPath: input.paths.inputArtifacts,
    toolVersionsPath: input.paths.toolVersions,
    automatedChecksPath: input.paths.automatedChecks,
    reviewChecksPath: input.paths.reviewChecks,
    manualScoresPath: input.paths.manualScores,
    clientSmokePath: input.paths.clientSmoke,
    outputPath: input.output,
  });
}

async function build(name, options = {}) {
  const input = await writeInputs(name, options);
  return buildInput(input);
}

function runCurrentQaValidator(reportPath) {
  return spawnSync(process.execPath, [
    CURRENT_QA_VALIDATOR,
    "--qa-report",
    reportPath,
    "--workspace",
    path.dirname(reportPath),
  ], {
    encoding: "utf8",
    env: process.env,
  });
}

async function rewriteReport(reportPath, mutate) {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  await mutate(report);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

test("valid evidence builds a schema-valid PASS report from recomputed inputs", async () => {
  const input = await writeInputs("valid");
  const report = await buildInput(input);
  assert.equal(report.finalVerdict, "PASS");
  assert.equal(report.clientSmokeStatus, "PASS");
  assert.equal(
    report.clientSmoke.evidenceSha256,
    sha256(await fs.readFile(report.clientSmoke.evidencePath)),
  );
  assert.equal(report.inputArtifacts.deck.sha256, input.inputHashes.deck);
  assert.notEqual(report.inputArtifacts.deck.sha256, input.values.inputArtifacts.deck.sha256);
  assert.deepEqual(Object.keys(input.values.automatedChecks[0]).sort(), ["evidencePath", "id"]);
  assert.match(report.reviewChecks[0].evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.reviewChecks[0].width, 1600);
  assert.equal(report.reviewChecks[0].height, 900);
  assert.match(report.perSlideManualScores[0].evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(new Set(
    [...OOXML_CHECK_IDS].map((id) => input.evidenceById.get(id)),
  ).size, 1);
  const pptxParseEvidence = await fs.readFile(input.evidenceById.get("pptxParse"));
  assert.equal(
    report.automatedChecks.find((entry) => entry.id === "pptxParse").evidenceSha256,
    sha256(pptxParseEvidence),
  );
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const result = validateSchema({ $defs: schema.$defs, $ref: "#/$defs/qaReport" }, report);
  assert.equal(result.valid, true, result.errors.join("\n"));
});

test("shared current QA preflight accepts the builder's canonical report", async () => {
  const input = await writeInputs("shared-preflight-valid");
  await buildInput(input);
  const result = runCurrentQaValidator(input.output);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CURRENT_QA_VALID/i);
});

test("builder directly invokes the shared current QA preflight before writing PASS", async () => {
  const source = await fs.readFile(
    path.resolve("skills/visual-first-ppt/scripts/build-qa-report.mjs"),
    "utf8",
  );
  assert.match(source, /from\s+"\.\/lib\/current-qa\.mjs"/);
  assert.match(source, /validateCurrentQaReport\s*\(/);
});

test("shared current QA preflight rejects semantic mutations that still satisfy the schema", async (t) => {
  const cases = [
    {
      name: "unexpected-automated-id",
      expected: /unexpected|exact.*automated|required automated/i,
      mutate: async (report) => {
        report.automatedChecks.push({
          ...report.automatedChecks[0],
          id: "nonContractExtraCheck",
        });
      },
    },
    {
      name: "duplicate-automated-id",
      expected: /duplicate.*automated/i,
      mutate: async (report) => {
        report.automatedChecks.push({ ...report.automatedChecks[0] });
      },
    },
    {
      name: "descriptor-evidence-value-mismatch",
      expected: /value.*mismatch|descriptor.*evidence/i,
      mutate: async (report) => {
        const check = report.automatedChecks.find((entry) => entry.id === "pageCountAndCanvas");
        check.value += 1;
      },
    },
    {
      name: "noncontinuous-page-coverage",
      expected: /cover every consecutive slide|continuous.*1-2|review.*coverage/i,
      mutate: async (report) => {
        const check = report.automatedChecks.find((entry) => entry.id === "pageCountAndCanvas");
        const evidence = JSON.parse(await fs.readFile(check.evidencePath, "utf8"));
        evidence.check.value = 2;
        await fs.writeFile(check.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
        check.value = 2;
        check.evidenceSha256 = sha256(await fs.readFile(check.evidencePath));
      },
    },
    {
      name: "stale-declared-png-dimensions",
      expected: /PNG.*dimensions|dimensions.*stale|declared.*width/i,
      mutate: async (report) => {
        report.reviewChecks[0].width += 1;
      },
    },
    {
      name: "client-theme-target-mismatch",
      expected: /target client.*theme|theme.?lock.*target/i,
      mutate: async (report) => {
        report.clientSmoke.targetClient = "WPS Presentation";
      },
    },
    {
      name: "extra-evidence-path-projection",
      expected: /evidencePaths.*projection|exact.*evidence/i,
      mutate: async (report) => {
        report.evidencePaths.push(report.inputArtifacts.deck.path);
      },
    },
    {
      name: "stale-input-artifact-bytes",
      expected: /themeLock.*hash|input artifact.*stale/i,
      mutate: async (report) => {
        await fs.appendFile(report.inputArtifacts.themeLock.path, "\n");
      },
    },
    {
      name: "structured-checker-mismatch",
      expected: /checker.*mismatch|checker.*invalid|schema validation/i,
      mutate: async (report) => {
        const check = report.automatedChecks.find((entry) => entry.id === "pptxParse");
        const evidence = JSON.parse(await fs.readFile(check.evidencePath, "utf8"));
        evidence.checker.id = "different-checker";
        await fs.writeFile(check.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
        check.evidenceSha256 = sha256(await fs.readFile(check.evidencePath));
      },
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const input = await writeInputs(`shared-preflight-${candidate.name}`);
      await buildInput(input);
      await rewriteReport(input.output, candidate.mutate);
      const result = runCurrentQaValidator(input.output);
      assert.notEqual(result.status, 0, `${candidate.name} unexpectedly passed`);
      assert.match(`${result.stdout}\n${result.stderr}`, candidate.expected);
    });
  }
});

test("project schema separates strict current QA from legacy read-only QA", async () => {
  const schema = await loadProjectArtifactsSchema();
  const currentReport = await build("schema-current-baseline");
  const current = validateProjectArtifactDefinition(schema, "qaReportCurrent", currentReport);
  assert.equal(current.valid, true, current.errors.join("\n"));

  const legacyReport = JSON.parse(await fs.readFile(
    path.resolve("tests/fixtures/project-legacy/qa-report.json"),
    "utf8",
  ));
  const legacy = validateProjectArtifactDefinition(schema, "qaReportLegacy", legacyReport);
  assert.equal(legacy.valid, true, legacy.errors.join("\n"));

  const compatibilityCurrent = validateProjectArtifactDefinition(schema, "qaReport", currentReport);
  const compatibilityLegacy = validateProjectArtifactDefinition(schema, "qaReport", legacyReport);
  assert.equal(compatibilityCurrent.valid, true, compatibilityCurrent.errors.join("\n"));
  assert.equal(compatibilityLegacy.valid, true, compatibilityLegacy.errors.join("\n"));
});

test("qaReportCurrent requires complete evidence descriptors and all seven dimensions", async () => {
  const schema = await loadProjectArtifactsSchema();
  const report = await build("schema-current-required-fields");
  const baseline = validateProjectArtifactDefinition(schema, "qaReportCurrent", report);
  assert.equal(baseline.valid, true, baseline.errors.join("\n"));

  const cases = [
    ["clientSmoke", (candidate) => delete candidate.clientSmoke],
    ["legacy clientSmoke descriptor", (candidate) => {
      candidate.clientSmoke = {
        status: "passed",
        evidencePath: candidate.clientSmoke.evidencePath,
        userFinalOpenConfirmation: false,
      };
    }],
    ["passed client observationMode", (candidate) => {
      delete candidate.clientSmoke.observationMode;
    }],
    ["review evidenceSha256", (candidate) => delete candidate.reviewChecks[0].evidenceSha256],
    ["review width", (candidate) => delete candidate.reviewChecks[0].width],
    ["review height", (candidate) => delete candidate.reviewChecks[0].height],
    ["manual evidenceSha256", (candidate) => delete candidate.perSlideManualScores[0].evidenceSha256],
    ["manual width", (candidate) => delete candidate.perSlideManualScores[0].width],
    ["manual height", (candidate) => delete candidate.perSlideManualScores[0].height],
    ...REQUIRED_MANUAL_DIMENSIONS.map((dimension) => [
      `manual dimension ${dimension}`,
      (candidate) => delete candidate.perSlideManualScores[0].dimensions[dimension],
    ]),
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(report);
    mutate(candidate);
    const result = validateProjectArtifactDefinition(schema, "qaReportCurrent", candidate);
    assert.equal(result.valid, false, `${label} unexpectedly satisfied qaReportCurrent`);
  }
});

test("qaReportCurrent keeps verdict and client/check statuses internally consistent", async () => {
  const schema = await loadProjectArtifactsSchema();
  const report = await build("schema-current-consistency");
  const baseline = validateProjectArtifactDefinition(schema, "qaReportCurrent", report);
  assert.equal(baseline.valid, true, baseline.errors.join("\n"));

  const cases = [
    ["top-level client status", (candidate) => { candidate.clientSmokeStatus = "NOT_RUN"; }],
    ["descriptor client status", (candidate) => { candidate.clientSmoke.status = "not_available"; }],
    ["user confirmation", (candidate) => { candidate.clientSmoke.userFinalOpenConfirmation = true; }],
    ["automated check", (candidate) => { candidate.automatedChecks[0].status = "FAIL"; }],
    ["review check", (candidate) => {
      candidate.reviewChecks[0].checks.contentVisibility.status = "FAIL";
    }],
    ["manual score", (candidate) => {
      candidate.perSlideManualScores[0].dimensions.readability = 3;
    }],
    ["manual score above the scale", (candidate) => {
      candidate.perSlideManualScores[0].dimensions.readability = 6;
    }],
    ["final verdict", (candidate) => { candidate.finalVerdict = "FAIL"; }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(report);
    mutate(candidate);
    const result = validateProjectArtifactDefinition(schema, "qaReportCurrent", candidate);
    assert.equal(result.valid, false, `${label} contradiction satisfied qaReportCurrent`);
  }
});

test("every hard-zero check rejects a nonzero structured value", async () => {
  for (const id of HARD_ZERO) {
    const checks = automated();
    checks.find((check) => check.id === id).value = 1;
    await assert.rejects(build(`hard-zero-${id}`, { checks }), new RegExp(id));
  }
});

test("missing checks and evidence paths fail closed", async () => {
  const missing = automated().filter((check) => check.id !== "fontAvailability");
  await assert.rejects(build("missing-check", { checks: missing }), /fontAvailability/);

  const input = await writeInputs("missing-evidence");
  input.values.automatedChecks[0].evidencePath = "";
  await writeInputsToDisk(input);
  await assert.rejects(buildInput(input), /evidence path/i);
});

test("evidence paths must reference existing nonempty files", async () => {
  const missing = await writeInputs("missing-evidence-file");
  await fs.rm(missing.values.automatedChecks[0].evidencePath);
  await assert.rejects(buildInput(missing), /evidence.*(?:exist|missing|file)|ENOENT/i);

  const empty = await writeInputs("empty-evidence-file");
  await fs.writeFile(empty.values.automatedChecks[0].evidencePath, "");
  await assert.rejects(buildInput(empty), /evidence.*(?:empty|nonempty|zero)/i);
});

test("manual and review coverage includes every slide declared by pageCountAndCanvas", async () => {
  const checks = automated();
  checks.find((check) => check.id === "pageCountAndCanvas").value = 3;
  await assert.rejects(
    build("manual-page-coverage", { checks, scores: manualSlides([1, 3]) }),
    /manual|slide 2|page.*count|consecutive|continuous/i,
  );
});

test("edit route requires source scope and unauthorized-slide evidence", async () => {
  for (const missingId of EDIT_REQUIRED_CHECKS) {
    const checks = automated("edit").filter((check) => check.id !== missingId);
    await assert.rejects(build(`edit-missing-${missingId}`, { route: "edit", checks }), new RegExp(missingId));
  }
});

test("every contract manual dimension below 4 fails", async () => {
  for (const dimension of REQUIRED_MANUAL_DIMENSIONS) {
    const scores = manual();
    scores[0].scores[dimension] = 3;
    await assert.rejects(build(`manual-${dimension}`, { scores }), new RegExp(dimension));
  }
});

test("client smoke not_available needs external deck-bound user-open evidence", async () => {
  await assert.rejects(
    build("smoke-missing-confirmation", {
      smoke: {
        status: "not_available",
        evidencePath: "qa/smoke-unavailable.json",
        userFinalOpenConfirmation: true,
        targetClient: "Microsoft PowerPoint",
        evidencePayload: {
          artifactType: "clientSmokeUnavailableEvidence",
          schemaVersion: "1.0.0",
          targetClient: "Microsoft PowerPoint",
          reason: "Only headless diagnostics were available",
        },
      },
    }),
    /user.*open|confirmation.*evidence|structured.*confirmation/i,
  );
  const report = await build("smoke-confirmed", {
    smoke: {
      status: "not_available",
      evidencePath: "qa/user-open-confirmation.json",
      userFinalOpenConfirmation: true,
      targetClient: "Microsoft PowerPoint",
      evidencePayload: {
        artifactType: "userOpenConfirmationEvidence",
        schemaVersion: "1.0.0",
        targetClient: "Microsoft PowerPoint",
        openedArtifactHash: "AUTO_DECK_HASH",
        userMessage: "I opened the final deck in Microsoft PowerPoint and confirmed it displays correctly.",
        confirmedAt: "2026-07-17T00:00:00.000Z",
      },
    },
  });
  assert.equal(report.clientSmokeStatus, "NOT_RUN");
  assert.equal(report.clientSmoke.targetClient, "Microsoft PowerPoint");
  assert.equal(report.clientSmoke.openedArtifactHash, report.inputHashes.deck);
  assert.equal(
    report.clientSmoke.evidenceSha256,
    sha256(await fs.readFile(report.clientSmoke.evidencePath)),
  );
});

test("client smoke passed requires deck-bound structured GUI evidence", async () => {
  const plain = await writeInputs("client-smoke-plain-forgery");
  await fs.writeFile(plain.values.clientSmoke.evidencePath, "PASS\n");
  await assert.rejects(buildInput(plain), /client.*smoke.*(?:structured|JSON|evidence)/i);

  await assert.rejects(
    build("client-smoke-headless-forgery", {
      smoke: {
        status: "passed",
        evidencePath: "qa/client-smoke.json",
        targetClient: "Microsoft PowerPoint",
        evidencePayload: {
          artifactType: "clientSmokeEvidence",
          schemaVersion: "1.0.0",
          targetClient: "Microsoft PowerPoint",
          observationMode: "headless-import-export",
          openedArtifactHash: "sha256:" + "0".repeat(64),
          observations: {
            applicationWindowVisible: false,
            deckOpened: true,
            slideCanvasVisible: false,
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      },
    }),
    /headless|GUI|target.*client|opened.*artifact.*hash/i,
  );

  const report = await build("client-smoke-structured-gui");
  assert.equal(report.clientSmokeStatus, "PASS");
  assert.equal(report.clientSmoke.targetClient, "Microsoft PowerPoint");
  assert.equal(report.clientSmoke.observationMode, "gui-open");
  assert.equal(
    report.clientSmoke.evidenceSha256,
    sha256(await fs.readFile(report.clientSmoke.evidencePath)),
  );

  await assert.rejects(
    build("client-smoke-theme-target-mismatch", {
      themeTargetClient: "Microsoft PowerPoint",
      smoke: {
        status: "passed",
        evidencePath: "qa/client-smoke.json",
        targetClient: "WPS Presentation",
      },
    }),
    /theme.?lock.*targetClient|target.*client.*theme/i,
  );
});

for (const invalidTargetClient of ["Microsoft PowerPoint for Windows", "PowerPoint/WPS"]) {
  test(`QA rejects noncanonical targetClient: ${invalidTargetClient}`, async () => {
    await assert.rejects(
      build(`client-smoke-noncanonical-${invalidTargetClient.replaceAll(/[^a-z]/gi, "-")}`, {
        themeTargetClient: invalidTargetClient,
        smoke: {
          status: "passed",
          evidencePath: "qa/client-smoke.json",
          targetClient: invalidTargetClient,
        },
      }),
      /targetClient|target client|schema.*enum/i,
    );
  });
}

test("plain nonempty evidence can no longer forge PASS", async () => {
  const input = await writeInputs("plain-evidence");
  await fs.writeFile(input.values.automatedChecks[0].evidencePath, "PASS\n");
  await assert.rejects(buildInput(input), /structured.*evidence|JSON/i);
});

test("missing and wrong OOXML checker identities cannot mint PASS", async () => {
  for (const [label, checker] of [
    ["missing", undefined],
    ["wrong-id", { id: "unit-test", version: "1.0.0" }],
    ["wrong-version", { id: "audit-pptx-quality", version: "9.9.9" }],
  ]) {
    const input = await writeInputs(`ooxml-checker-${label}`);
    const evidencePath = input.evidenceById.get("textFramePolicy");
    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    if (checker === undefined) delete evidence.checker;
    else evidence.checker = checker;
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(buildInput(input), /checker|schema/i);
  }
});

test("generic per-check evidence requires a matching checker identity and version", async () => {
  for (const [label, checker] of [
    ["missing", undefined],
    ["wrong-id", { id: "different-check", version: "1.0.0" }],
    ["wrong-version", { id: "pptxParse", version: "9.9.9" }],
  ]) {
    const input = await writeInputs(`generic-checker-${label}`);
    const evidencePath = input.evidenceById.get("pptxParse");
    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    if (checker === undefined) delete evidence.checker;
    else evidence.checker = checker;
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(buildInput(input), /checker|schema|version/i);
  }
});

test("generic per-check and shared OOXML evidence require complete strict check payloads", async () => {
  const genericCases = [
    ["missing-check", (evidence) => { delete evidence.check; }],
    ["wrong-check-id", (evidence) => { evidence.checkId = "different-check"; }],
    ["invalid-violations", (evidence) => { evidence.check.violations = "none"; }],
    ["additional-field", (evidence) => { evidence.status = "PASS"; }],
  ];
  for (const [label, mutate] of genericCases) {
    const input = await writeInputs(`generic-schema-${label}`);
    const evidencePath = input.evidenceById.get("pptxParse");
    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    mutate(evidence);
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(buildInput(input), /schema|checkId|check|violations|additional/i);
  }

  const bundle = await writeInputs("incomplete-ooxml-bundle");
  const bundlePath = bundle.evidenceById.get("textFramePolicy");
  const evidence = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  delete evidence.checks.safeMargin;
  await fs.writeFile(bundlePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(buildInput(bundle), /schema|safeMargin|check/i);
});

test("legacy top-level id or checkId fallback cannot mint PASS", async () => {
  const input = await writeInputs("legacy-top-level-check-fallback");
  const evidencePath = input.evidenceById.get("pptxParse");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  delete evidence.check;
  Object.assign(evidence, {
    id: "pptxParse",
    checkId: "pptxParse",
    status: "PASS",
    value: 0,
    violations: [],
  });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(buildInput(input), /schema|check|additional/i);
});

test("automated descriptors reject every key beyond id and evidencePath", async () => {
  for (const key of ["status", "value", "command"]) {
    const input = await writeInputs(`descriptor-extra-${key}`);
    input.values.automatedChecks[0][key] = key === "value" ? 0 : "PASS";
    await writeInputsToDisk(input);
    await assert.rejects(buildInput(input), /descriptor|additional|only.*id.*evidencePath/i);
  }
});

test("review and manual evidence must be real PNG files", async () => {
  for (const collection of ["reviewChecks", "manualScores"]) {
    const input = await writeInputs(`text-${collection}`);
    await fs.writeFile(input.values[collection][0].evidencePath, "not a PNG\n");
    await assert.rejects(buildInput(input), /PNG|signature|IHDR|IEND/i);
  }
});

test("full-slide PNG validation rejects corrupt chunks and malformed scanlines", async (t) => {
  for (const [label, payload] of invalidPngCases()) {
    await t.test(label, async () => {
      const input = await writeInputs(`invalid-png-${label.replaceAll(" ", "-")}`);
      await fs.writeFile(input.values.reviewChecks[0].evidencePath, payload);
      await assert.rejects(
        buildInput(input),
        /PNG|CRC|IHDR|IDAT|zlib|decompress|scanline|filter/i,
      );
    });
  }
});

test("full-slide PNG validation rejects non-ASCII chunk aliases and extra zlib input", async (t) => {
  for (const [label, payload] of ambiguousPngCases()) {
    await t.test(label, async () => {
      const input = await writeInputs(`ambiguous-png-${label.replaceAll(" ", "-")}`);
      await fs.writeFile(input.values.reviewChecks[0].evidencePath, payload);
      await assert.rejects(
        buildInput(input),
        /PNG|chunk type|ASCII|IDAT|zlib|trailing|stream|compressed input/i,
      );
    });
  }
});

test("structured evidence rejects malformed UTF-8 before JSON parsing", async () => {
  const input = await writeInputs("malformed-utf8-evidence");
  const evidencePath = input.evidenceById.get("pptxParse");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  evidence.check.violations = [{ note: "MALFORMED" }];
  const encoded = Buffer.from(JSON.stringify(evidence));
  const marker = Buffer.from("MALFORMED");
  const markerOffset = encoded.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  const malformed = Buffer.concat([
    encoded.subarray(0, markerOffset),
    Buffer.from([0x80]),
    encoded.subarray(markerOffset + marker.length),
  ]);
  await fs.writeFile(evidencePath, malformed);
  await assert.rejects(buildInput(input), /UTF-?8|encoding|decode/i);
});

test("full-slide evidence filename must explicitly match its slide", async () => {
  const input = await writeInputs("wrong-slide-filename");
  const wrong = path.join(input.dir, "previews", "evidence.png");
  await fs.writeFile(wrong, pngBytes());
  input.values.reviewChecks[0].evidencePath = wrong;
  await writeInputsToDisk(input);
  await assert.rejects(buildInput(input), /slide-1\.png|slide.*filename|mapping/i);
});

test("different slides cannot reuse one full-slide evidence path", async () => {
  const checks = automated();
  checks.find((entry) => entry.id === "pageCountAndCanvas").value = 2;
  const input = await writeInputs("reused-slide-evidence", { checks, scores: manualSlides([1, 2]) });
  input.values.reviewChecks[1].evidencePath = input.values.reviewChecks[0].evidencePath;
  await writeInputsToDisk(input);
  await assert.rejects(buildInput(input), /unique|reuse|slide-2\.png|mapping/i);
});

test("evidence bound to a different deck hash fails", async () => {
  const input = await writeInputs("stale-deck-hash");
  await mutateEvidence(input, "pptxParse", { inputHashes: { deck: "sha256:old" } });
  await assert.rejects(buildInput(input), /deck.*hash|input.*mismatch/i);
});

test("every slide requires content visibility image text and semantic review", async () => {
  const input = await writeInputs("missing-review-check");
  delete input.values.reviewChecks[0].checks.generatedImageTextReview;
  await writeInputsToDisk(input);
  await assert.rejects(buildInput(input), /generatedImageTextReview/);
});

test("score four requires an observable issue note", async () => {
  const input = await writeInputs("score-four-note");
  input.values.manualScores[0].scores.readability = 4;
  input.values.manualScores[0].notes = "";
  await writeInputsToDisk(input);
  await assert.rejects(buildInput(input), /score.*4.*note/i);
});

test("legacy input hashes cannot create a new PASS report", async () => {
  const input = await writeInputs("legacy-read-only");
  await assert.rejects(
    buildQaReport({
      projectId: "ppt-legacy-read-only",
      route: "create",
      inputHashesPath: input.legacyInputHashesPath,
      toolVersionsPath: input.paths.toolVersions,
      automatedChecksPath: input.paths.automatedChecks,
      manualScoresPath: input.paths.manualScores,
      clientSmokePath: input.paths.clientSmoke,
      outputPath: input.output,
    }),
    /legacy.*read-only.*cannot create.*PASS/i,
  );
});
