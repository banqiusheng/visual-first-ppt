import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { validateSchema } from "../../skills/visual-first-ppt/scripts/lib/schema-validator.mjs";

const expectedThemes = new Map([
  ["minimal-business", "极简商务"],
  ["consulting-report", "咨询汇报"],
  ["future-tech", "科技未来"],
  ["product-launch", "产品发布"],
  ["editorial-story", "杂志叙事"],
  ["education-training", "教育培训"],
  ["academic-defense", "学术答辩"],
  ["government-formal", "政务正式"],
  ["neo-chinese", "新中式"],
  ["creative-energy", "创意活力"],
]);
const sansCandidates = [
  "Microsoft YaHei",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
];
const neoChineseBodyCandidates = [
  ...sansCandidates,
  "Arial Unicode MS",
];
const serifTitleCandidates = [
  "SimSun",
  "Songti SC",
  "Noto Serif CJK SC",
  "Source Han Serif SC",
];
const latinCandidates = ["Aptos", "Arial", "Calibri"];
const numberCandidates = ["Arial", "Aptos", "Calibri"];

function assertHex(value, message) {
  assert.match(value, /^#[0-9A-F]{6}$/i, message);
}

test("theme catalog contains ten complete and deterministic theme contracts", async () => {
  const catalogPath = path.resolve("skills/visual-first-ppt/assets/theme-catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const schemaResult = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/themeCatalog" },
    catalog,
  );
  assert.equal(schemaResult.valid, true, schemaResult.errors.join("\n"));
  assert.equal(catalog.themes.length, 10);
  assert.equal(new Set(catalog.themes.map((theme) => theme.id)).size, 10);

  for (const theme of catalog.themes) {
    assert.equal(expectedThemes.get(theme.id), theme.labelZh, `unexpected theme ${theme.id}`);
    assert.ok(theme.useWhen.length >= 2, `${theme.id} requires concrete useWhen rules`);
    assert.ok(theme.avoidWhen.length >= 2, `${theme.id} requires concrete avoidWhen rules`);
    for (const mode of ["light", "dark"]) {
      for (const token of ["background", "surface", "primary", "secondary", "accent", "text", "muted"]) {
        assertHex(theme.palettes[mode][token], `${theme.id}.${mode}.${token}`);
      }
    }
    for (const key of ["titleFont", "bodyFont", "numberFont", "titleSize", "bodySize", "captionSize"]) {
      assert.ok(theme.typography[key], `${theme.id} missing typography.${key}`);
    }
    assert.ok(theme.typography.titleSize >= 28, `${theme.id} titleSize must be at least 28pt`);
    assert.ok(theme.typography.bodySize >= 20, `${theme.id} bodySize must be at least 20pt`);
    assert.ok(theme.typography.captionSize >= 14, `${theme.id} captionSize must be at least 14pt`);
    assert.ok(theme.typography.sourceSize >= 10, `${theme.id} sourceSize must be at least 10pt`);
    assert.ok(theme.typography.pageNumberSize >= 10, `${theme.id} pageNumberSize must be at least 10pt`);
    assert.ok(theme.typography.cjkTitleCandidates.length >= 3, `${theme.id} needs title candidates`);
    assert.ok(theme.typography.cjkBodyCandidates.length >= 3, `${theme.id} needs body candidates`);
    const expectedTitleCandidates = ["editorial-story", "neo-chinese"].includes(theme.id)
      ? serifTitleCandidates
      : sansCandidates;
    assert.deepEqual(theme.typography.cjkTitleCandidates, expectedTitleCandidates, `${theme.id} title candidate order drifted`);
    const expectedBodyCandidates = theme.id === "neo-chinese"
      ? neoChineseBodyCandidates
      : sansCandidates;
    assert.deepEqual(theme.typography.cjkBodyCandidates, expectedBodyCandidates, `${theme.id} body candidate order drifted`);
    assert.deepEqual(theme.typography.latinCandidates, latinCandidates, `${theme.id} Latin candidate order drifted`);
    assert.deepEqual(theme.typography.numberCandidates, numberCandidates, `${theme.id} number candidate order drifted`);
    assert.equal(theme.typography.titleFont, theme.typography.cjkTitleCandidates[0], `${theme.id} titleFont conflicts with candidates`);
    assert.equal(theme.typography.bodyFont, theme.typography.cjkBodyCandidates[0], `${theme.id} bodyFont conflicts with candidates`);
    assert.equal(theme.typography.numberFont, theme.typography.numberCandidates[0], `${theme.id} numberFont conflicts with candidates`);
    assert.equal(theme.fontPolicy.requireBuildResolution, true, `${theme.id} must resolve fonts during build`);
    assert.equal(theme.fontPolicy.forbidSilentFallback, true, `${theme.id} must forbid silent fallback`);
    assert.equal(theme.fontPolicy.invalidateVisualLockOnChange, true, `${theme.id} font changes must invalidate visual lock`);
    assert.match(theme.imagePromptBase, /16:9/);
    assert.match(theme.negativePrompt, /no embedded critical text or precise data/i);
    assert.doesNotMatch(theme.imagePromptBase, /in the style of|模仿.*艺术家/i);
    for (const style of ["title", "body", "table", "chart"]) {
      assert.ok(theme.nativeTextStyles[style], `${theme.id} missing native ${style} style`);
    }
    for (const role of ["cover", "chapter", "content", "data", "ending"]) {
      assert.ok(theme.pageRoles[role], `${theme.id} missing page role ${role}`);
    }
    for (const safeKey of ["top", "right", "bottom", "left", "imageFocusRule", "cropRule"]) {
      assert.ok(theme.safeZone[safeKey], `${theme.id} missing safeZone.${safeKey}`);
    }
  }
  console.log("10 themes validated");
});

test("theme catalog schema requires deterministic candidates for all four resolved-font roles", async () => {
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const typography = schema.$defs.themeCatalog.properties.themes.items.properties.typography;
  assert.ok(typography.required.includes("cjkTitleCandidates"));
  assert.ok(typography.required.includes("cjkBodyCandidates"));
  assert.ok(typography.required.includes("latinCandidates"));
  assert.ok(typography.required.includes("numberCandidates"));
  for (const role of ["cjkTitleCandidates", "cjkBodyCandidates", "latinCandidates", "numberCandidates"]) {
    assert.equal(typography.properties[role].type, "array");
    assert.ok(typography.properties[role].minItems >= 3);
  }
});

test("theme selection reference locks one visual source behind a two-slide sample gate", async () => {
  const themes = await fs.readFile(
    path.resolve("skills/visual-first-ppt/references/themes.md"),
    "utf8",
  );
  assert.match(themes, /visual-source priority/i);
  assert.match(themes, /primary_visual_source/);
  assert.match(themes, /观众.*场景.*密度.*基调/s);
  assert.match(themes, /三个.*推荐/);
  assert.match(themes, /用户选择.*授权 Codex 代选/s);
  assert.match(themes, /封面.*典型内容页/s);
  assert.match(themes, /theme-lock\.json/);
  assert.match(themes, /Presentations.*默认布局体系/s);
  assert.match(themes, /strict template.*whole-deck route switch/is);
});

test("the documented theme-lock JSON example validates against the public schema", async () => {
  const themes = await fs.readFile(
    path.resolve("skills/visual-first-ppt/references/themes.md"),
    "utf8",
  );
  const match = themes.match(/## `theme-lock\.json`[\s\S]*?```json\s*\n([\s\S]*?)\n```/);
  assert.ok(match, "themes.md must expose one marked theme-lock JSON example");
  const example = JSON.parse(match[1]);
  assert.equal(example.targetClient, "Microsoft PowerPoint");
  const schema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/project-artifacts.schema.json"),
    "utf8",
  ));
  const result = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/themeLock" },
    example,
  );
  assert.equal(result.valid, true, result.errors.join("\n"));

  const { visualContractHash } = await import(
    "../../skills/visual-first-ppt/scripts/lib/visual-contract.mjs"
  );
  assert.equal(
    example.approval.approvedArtifactHash,
    visualContractHash(example),
    "the public example must contain its real visual contract hash",
  );

  const fontMatch = themes.match(/During each build[\s\S]*?```json\s*\n([\s\S]*?)\n```/);
  assert.ok(fontMatch, "themes.md must expose one fontResolutionEvidence JSON example");
  const fontEvidence = JSON.parse(fontMatch[1]);
  assert.equal(fontEvidence.targetClient, "Microsoft PowerPoint");
  const fontResult = validateSchema(
    { $defs: schema.$defs, $ref: "#/$defs/fontResolutionEvidence" },
    fontEvidence,
  );
  assert.equal(fontResult.valid, true, fontResult.errors.join("\n"));

  const qualitySchema = JSON.parse(await fs.readFile(
    path.resolve("skills/visual-first-ppt/schemas/quality-evidence.schema.json"),
    "utf8",
  ));
  assert.deepEqual(schema.$defs.targetClient?.enum, ["Microsoft PowerPoint", "WPS Presentation"]);
  assert.deepEqual(qualitySchema.$defs.targetClient?.enum, ["Microsoft PowerPoint", "WPS Presentation"]);
  assert.deepEqual(schema.$defs.targetClient?.enum, qualitySchema.$defs.targetClient?.enum);
  for (const definition of ["clientSmokeEvidence", "userOpenConfirmationEvidence"]) {
    assert.equal(
      qualitySchema.$defs[definition].properties.targetClient.$ref,
      "#/$defs/targetClient",
    );
  }
});
