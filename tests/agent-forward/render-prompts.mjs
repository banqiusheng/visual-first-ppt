import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

if (!['baseline', 'green'].includes(mode)) {
  throw new Error("mode must be baseline or green");
}

const repoRoot = path.resolve(readFlag("--repo"));
const outputRoot = path.resolve(readFlag("--output"));
const repoStat = await fs.stat(repoRoot);
if (!repoStat.isDirectory()) {
  throw new Error("--repo must point to a directory");
}

const scenarios = JSON.parse(
  await fs.readFile(path.join(scriptDir, "scenarios.json"), "utf8"),
).scenarios;

for (const scenario of scenarios) {
  for (let run = 1; run <= 5; run += 1) {
    const runLabel = `run-${String(run).padStart(2, "0")}`;
    const runDir = path.join(outputRoot, scenario.id, runLabel);
    await fs.mkdir(runDir, { recursive: true });
    const context = mode === "baseline"
      ? [
          "你是一个全新、无历史上下文的 Codex 执行 Agent。",
          `唯一可见的产品仓库是只读 v0.1.0 快照：${repoRoot}`,
          "只能依据该快照中已经发布的事实处理请求；不要读取其他工作区、测试脚手架或未来实现。",
        ]
      : [
          "你是一个全新、无历史上下文的 Codex 执行 Agent。",
          `唯一可见的候选产品仓库是：${repoRoot}`,
          "请从仓库公开入口开始，按当前仓库实际提供的分发与使用说明帮助第一次接触它的用户。",
        ];
    const request = [
      ...context,
      "保留首个用户可见回复，并只执行处理该请求确有必要的工具动作。不要虚构已完成的动作。",
      `SCENARIO ID: ${scenario.id}`,
      `USER REQUEST:\n${scenario.prompt}`,
    ].join("\n\n");
    await fs.writeFile(path.join(runDir, "request.txt"), `${request}\n`);
  }
}
