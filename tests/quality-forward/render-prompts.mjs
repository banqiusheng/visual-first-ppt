#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_LABEL = /^\d{8}T\d{6}(?:\d{3})?Z$/;

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing ${name}`);
  return argv[index + 1];
}

async function assertRawRunsRoot(value, repoRoot) {
  const repository = await fs.realpath(path.resolve(repoRoot));
  const rawBase = path.join(repository, ".superpowers/quality-forward/runs");
  await fs.mkdir(rawBase, { recursive: true });
  const rawBaseReal = await fs.realpath(rawBase);
  const resolved = path.resolve(value);
  const parts = resolved.split(path.sep);
  const suffix = parts.slice(-4);
  if (
    suffix[0] !== ".superpowers"
    || suffix[1] !== "quality-forward"
    || suffix[2] !== "runs"
    || suffix.length !== 4
  ) {
    throw new Error("raw evidence root must be .superpowers/quality-forward/runs/<timestamp>");
  }
  const runLabel = suffix[3];
  if (!RUN_LABEL.test(runLabel)) {
    throw new Error("raw evidence root must end in a canonical timestamp");
  }
  if (path.dirname(resolved) !== rawBaseReal) {
    throw new Error("repository raw evidence root must stay inside the selected repository");
  }
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(resolved);
    stat = await fs.lstat(resolved);
  }
  if (stat.isSymbolicLink()) throw new Error("raw evidence root must not be a symbolic link");
  if (!stat.isDirectory()) throw new Error("raw evidence root must be a directory");
  if (await fs.realpath(resolved) !== resolved) {
    throw new Error("raw evidence root must resolve to its canonical repository path");
  }
  return resolved;
}

async function ensureScenarioDirectory(outputRoot, scenarioId) {
  const scenarioRoot = path.join(outputRoot, scenarioId);
  let stat;
  try {
    stat = await fs.lstat(scenarioRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(scenarioRoot);
    stat = await fs.lstat(scenarioRoot);
  }
  if (stat.isSymbolicLink()) throw new Error(`${scenarioId}: scenario directory must not be a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`${scenarioId}: scenario output must be a directory`);
  const rootReal = await fs.realpath(outputRoot);
  const scenarioReal = await fs.realpath(scenarioRoot);
  if (!scenarioReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`${scenarioId}: scenario directory escapes the raw evidence root`);
  }
  return scenarioReal;
}

function portablePrompt(scenario) {
  return [
    "VISUAL QUALITY FORWARD SCENARIO",
    `SCENARIO_ID: ${scenario.id}`,
    `ROUTE: ${scenario.route}`,
    "REPOSITORY_ROOT: {{REPOSITORY_ROOT}}",
    "SCENARIO_OUTPUT_DIRECTORY: {{SCENARIO_OUTPUT_DIRECTORY}}",
    "",
    "任务：",
    scenario.prompt,
    "",
    "边界：",
    "- 只处理当前场景；不得安装、提交、推送、创建 PR、发布或改写冻结输入。",
    "- 所有结论必须写成场景目录中的 JSON 文件证据；聊天陈述不能替代文件证据。",
    "- 不得在请求文件中写入本机绝对路径；调度器会独立提供仓库和输出目录。",
    "- 结束时保留 manifest.json；不要创建公开 summary。",
    "",
    `允许结果：${scenario.acceptableOutcomes.join(" | ")}`,
  ].join("\n");
}

export async function renderPrompts({ repoRoot, runsRoot }) {
  const outputRoot = await assertRawRunsRoot(runsRoot, repoRoot);
  const document = JSON.parse(await fs.readFile(path.join(SCRIPT_DIR, "scenarios.json"), "utf8"));
  for (const scenario of document.scenarios) {
    const scenarioRoot = await ensureScenarioDirectory(outputRoot, scenario.id);
    await fs.writeFile(
      path.join(scenarioRoot, "request.md"),
      `${portablePrompt(scenario)}\n`,
      { flag: "wx" },
    );
  }
  return { runsRoot: outputRoot, promptCount: document.scenarios.length };
}

async function runCli(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log("Usage: render-prompts.mjs --repo ROOT --runs-root ROOT/.superpowers/quality-forward/runs/<timestamp>");
    return;
  }
  await renderPrompts({
    repoRoot: readFlag(argv, "--repo"),
    runsRoot: readFlag(argv, "--runs-root"),
  });
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
