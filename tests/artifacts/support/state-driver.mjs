#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  initProject,
  transitionProject,
  validateProject,
} from "../../../skills/visual-first-ppt/scripts/project-state.mjs";
import { writeJsonAtomic } from "../../../skills/visual-first-ppt/scripts/lib/atomic-json.mjs";
import { visualContractHash } from "../../../skills/visual-first-ppt/scripts/lib/visual-contract.mjs";
import { validateSlideSpecs } from "../../../skills/visual-first-ppt/scripts/validate-slide-specs.mjs";

const DRIVER_OWNER_MARKER = ".synthetic-state-driver-owner.json";
const QUALITY_CONTRACT_VERSION = "1.0.0";
const SYNTHETIC_VISUAL_SAMPLES = Object.freeze([
  ["visual-samples/cover.png", Buffer.from("synthetic approved cover sample\n", "utf8")],
  ["visual-samples/content.png", Buffer.from("synthetic approved content sample\n", "utf8")],
]);

function usage() {
  return [
    "Usage:",
    "  state-driver.mjs init WORKSPACE ROUTE TITLE [INPUT_HASHES_JSON]",
    "  state-driver.mjs transition WORKSPACE TARGET [APPROVAL_JSON]",
    "  state-driver.mjs validate WORKSPACE",
  ].join("\n");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex")}`;
}

async function ensureJson(filePath, value) {
  if (!(await exists(filePath))) await writeJsonAtomic(filePath, value);
  return filePath;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertSyntheticOwner(workspace) {
  const absolute = path.resolve(workspace);
  let marker;
  try {
    marker = await readJson(path.join(absolute, DRIVER_OWNER_MARKER));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("state-driver owner marker is missing");
    throw error;
  }
  const [manifest, state] = await Promise.all([
    readJson(path.join(absolute, "project-manifest.json")),
    readJson(path.join(absolute, "state.json")),
  ]);
  if (marker.artifactType !== "syntheticStateDriverOwner"
    || marker.schemaVersion !== "1.0.0"
    || marker.projectId !== manifest.projectId
    || marker.projectId !== state.projectId
    || marker.workspace !== absolute) {
    throw new Error("state-driver owner marker does not match this workspace");
  }
  if (manifest.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || state.qualityContractVersion !== QUALITY_CONTRACT_VERSION
    || !manifest.qualityGates
    || !state.qualityGates
    || stableJson(manifest.qualityGates) !== stableJson(state.qualityGates)) {
    throw new Error("state-driver requires a synchronized current quality contract");
  }
  return { absolute, marker, manifest, state };
}

async function qualityInputs(workspace, state) {
  const slideSpecsValue = JSON.parse(await fs.readFile(
    path.resolve("tests/fixtures/visual-quality/valid-slide-specs.json"),
    "utf8",
  ));
  slideSpecsValue.projectId = state.projectId;
  slideSpecsValue.route = state.route;
  if (state.route === "template") slideSpecsValue.slides[0].authorization = "new-slide";
  if (state.route === "edit") slideSpecsValue.slides[0].authorization = "authorized-modify";
  const slideSpecs = await ensureJson(path.join(workspace, "slide-specs.json"), slideSpecsValue);
  const sourcePpt = path.join(workspace, "source-edit.pptx");
  if (state.route === "edit" && !(await exists(sourcePpt))) {
    await fs.copyFile(path.resolve("tests/fixtures/baseline/edit-source.pptx"), sourcePpt);
  }
  for (const [relativePath, bytes] of SYNTHETIC_VISUAL_SAMPLES) {
    const samplePath = path.join(workspace, relativePath);
    if (!(await exists(samplePath))) {
      await fs.mkdir(path.dirname(samplePath), { recursive: true });
      await fs.writeFile(samplePath, bytes);
    }
  }
  const themeLockPath = path.join(workspace, "theme-lock.json");
  const themeLockValue = {
    artifactType: "themeLock",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    primary_visual_source: state.route === "edit"
      ? "source-ppt"
      : "builtin:education-training",
    themeId: "education-training",
    fontResolutionMode: state.route === "edit" ? "source-edit" : "theme-catalog",
    ...(state.route === "edit" ? {
      sourcePptPath: path.basename(sourcePpt),
      sourcePptHash: await sha256File(sourcePpt),
    } : {}),
    resolvedFonts: {
      cjkTitle: "Microsoft YaHei",
      cjkBody: "Microsoft YaHei",
      latin: "Aptos",
      number: "Arial",
    },
    fontEvidencePath: "font-evidence.json",
    embeddingStatus: "not-embedded",
    targetClient: "Microsoft PowerPoint",
    palette: { background: "#F4F9F7", primary: "#205B52" },
    composition: { grid: "12-column", rhythm: "explain-demonstrate-summarize" },
    samplePaths: SYNTHETIC_VISUAL_SAMPLES.map(([relativePath]) => relativePath),
    sampleHashes: SYNTHETIC_VISUAL_SAMPLES.map(([, bytes]) => (
      `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
    )),
  };
  const visualHash = visualContractHash(themeLockValue);
  if (state.route !== "edit") {
    themeLockValue.approval = {
      approvedArtifactHash: visualHash,
      approvedAt: "2026-07-17T00:00:00.000Z",
      userMessage: "synthetic visual approval",
    };
  }
  const themeLock = await ensureJson(themeLockPath, themeLockValue);
  const fontEvidence = path.join(workspace, "font-evidence.json");
  await ensureJson(fontEvidence, {
    artifactType: "fontResolutionEvidence",
    schemaVersion: "1.0.0",
    resolvedFonts: themeLockValue.resolvedFonts,
    targetClient: themeLockValue.targetClient,
    embeddingStatus: themeLockValue.embeddingStatus,
    fontAvailability: { status: "PASS", unavailableFonts: [] },
    glyphCoverage: { status: "PASS", missingGlyphs: [] },
    finalVerdict: "PASS",
  });
  const objectInventory = await ensureJson(path.join(workspace, "object-inventory.json"), {
    artifactType: "objectInventory",
    schemaVersion: "1.0.0",
    projectId: state.projectId,
    slides: [{ slide: 1, objects: [] }],
  });
  return { slideSpecs, themeLock, fontEvidence, objectInventory, visualHash };
}

async function ensureSyntheticDeck(workspace) {
  const synthetic = path.join(workspace, "deck.pptx");
  if (!(await exists(synthetic))) {
    await fs.writeFile(synthetic, "synthetic PPTX bytes for state-driver quality gates\n");
  }
  return synthetic;
}

async function preparePrebuild(workspace, prospectiveDiffPreview) {
  const { state } = await assertSyntheticOwner(workspace);
  const outputPath = path.join(workspace, "quality/prebuild-evidence.json");
  if (state.qualityGates?.prebuildEvidenceHash && await exists(outputPath)) return;
  const inputs = await qualityInputs(workspace, state);
  await validateSlideSpecs({
    slideSpecsPath: inputs.slideSpecs,
    themeLockPath: inputs.themeLock,
    statePath: path.join(workspace, "state.json"),
    outputPath,
    prospectiveDiffPreview,
  });
}

async function preparePptxAudit(workspace) {
  const { state } = await assertSyntheticOwner(workspace);
  const inputs = await qualityInputs(workspace, state);
  const deck = await ensureSyntheticDeck(workspace);
  const checks = Object.fromEntries([
    "textFramePolicy",
    "safeMargin",
    "fontResolution",
    "contentPresence",
    "hiddenVisualResidue",
  ].map((id) => [id, { status: "PASS", value: 0, violations: [] }]));
  await writeJsonAtomic(path.join(workspace, "quality/pptx-audit.json"), {
    artifactType: "automatedEvidenceBundle",
    schemaVersion: "1.0.0",
    qualityContractVersion: "1.0.0",
    checker: { id: "audit-pptx-quality", version: "1.0.0" },
    inputHashes: {
      deck: await sha256File(deck),
      slideSpecs: await sha256File(inputs.slideSpecs),
      themeLock: await sha256File(inputs.themeLock),
      objectInventory: await sha256File(inputs.objectInventory),
    },
    checks,
    finalVerdict: "PASS",
    generatedAt: new Date().toISOString(),
  });
}

async function prepareQaPass(workspace) {
  const { state } = await assertSyntheticOwner(workspace);
  const inputs = await qualityInputs(workspace, state);
  const auditPath = path.join(workspace, "quality/pptx-audit.json");
  const audit = await readJson(auditPath);
  const deck = await ensureSyntheticDeck(workspace);
  const inputArtifacts = {
    deck: { path: deck, sha256: await sha256File(deck) },
    slideSpecs: { path: inputs.slideSpecs, sha256: await sha256File(inputs.slideSpecs) },
    themeLock: { path: inputs.themeLock, sha256: await sha256File(inputs.themeLock) },
  };
  if (inputArtifacts.deck.sha256 !== audit.inputHashes.deck) {
    throw new Error("synthetic deck changed after PPTX audit");
  }
  await writeJsonAtomic(path.join(workspace, "qa-report.json"), {
    artifactType: "qaReport",
    schemaVersion: "1.0.0",
    qualityContractVersion: "1.0.0",
    projectId: state.projectId,
    route: state.route,
    inputArtifacts,
    inputHashes: Object.fromEntries(Object.entries(inputArtifacts)
      .map(([key, value]) => [key, value.sha256])),
    toolVersions: { node: process.version, driver: "state-driver" },
    automatedChecks: [{
      id: "pptx-audit",
      status: "PASS",
      evidencePath: auditPath,
      evidenceSha256: await sha256File(auditPath),
      value: 0,
    }],
    reviewChecks: [{
      slide: 1,
      reviewer: "synthetic state driver",
      evidencePath: auditPath,
      checks: {
        contentVisibility: { status: "PASS", notes: "synthetic PASS" },
        generatedImageTextReview: { status: "PASS", notes: "synthetic PASS" },
        visualSemanticMatch: { status: "PASS", notes: "synthetic PASS" },
      },
    }],
    perSlideManualScores: [{ slide: 1, score: 5, evidencePath: auditPath }],
    clientSmokeStatus: "PASS",
    evidencePaths: [auditPath],
    finalVerdict: "PASS",
    generatedAt: new Date().toISOString(),
  });
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const [workspace, route, title, inputHashesPath] = args;
    if (!workspace || !route || !title) throw new Error(usage());
    const inputHashes = inputHashesPath ? await readJson(inputHashesPath) : {};
    const result = await initProject({ workspace, route, title, inputHashes });
    await writeJsonAtomic(path.join(result.workspace, DRIVER_OWNER_MARKER), {
      artifactType: "syntheticStateDriverOwner",
      schemaVersion: "1.0.0",
      projectId: result.projectId,
      workspace: result.workspace,
    });
    console.log(JSON.stringify({ projectId: result.projectId, status: result.state.status }));
    return;
  }

  if (command === "transition") {
    const [workspace, to, approvalPath] = args;
    if (!workspace || !to) throw new Error(usage());
    const absolute = path.resolve(workspace);
    await assertSyntheticOwner(absolute);
    const approval = approvalPath ? await readJson(approvalPath) : undefined;
    if (to === "VISUAL_LOCKED") {
      const state = await readJson(path.join(absolute, "state.json"));
      const inputs = await qualityInputs(absolute, state);
      if (approval?.approvedArtifactHash !== inputs.visualHash) {
        throw new Error(`VISUAL_LOCKED approval must equal ${inputs.visualHash}`);
      }
    }
    if (to === "BUILDING") await preparePrebuild(absolute, approval);
    if (to === "QA") await preparePptxAudit(absolute);
    if (to === "FINAL_REVIEW") await prepareQaPass(absolute);
    const state = await transitionProject({ workspace: absolute, to, approval });
    console.log(JSON.stringify({ projectId: state.projectId, status: state.status }));
    return;
  }

  if (command === "validate") {
    const [workspace] = args;
    if (!workspace) throw new Error(usage());
    console.log(JSON.stringify(await validateProject(workspace)));
    return;
  }

  throw new Error(usage());
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
