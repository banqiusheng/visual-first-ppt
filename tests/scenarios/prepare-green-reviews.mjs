import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const scenarioDocument = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tests/scenarios/scenarios.json"), "utf8"),
);
const rubric = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tests/scenarios/rubric.json"), "utf8"),
);

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function statusObject(ids, values) {
  return {
    type: "object",
    properties: Object.fromEntries(ids.map((id) => [id, { type: "string", enum: values }])),
    required: ids,
    additionalProperties: false,
  };
}

for (const scenario of scenarioDocument.scenarios) {
  const fixtureHashes = {};
  for (const fixture of scenario.fixtures) {
    fixtureHashes[path.basename(fixture)] = await sha256(path.join(repoRoot, fixture));
  }

  for (let run = 1; run <= rubric.passRule.microtestRuns; run += 1) {
    const runName = `run-${String(run).padStart(2, "0")}`;
    const runDir = path.join(repoRoot, "tests/green", scenario.id, runName);
    const rawResponse = await fs.readFile(path.join(runDir, "response.txt"), "utf8");
    const runMetadata = {
      model: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
      reviewerModel: "gpt-5.5 via codex-cli 0.142.0 ephemeral",
      codexCli: "0.142.0",
      node: process.version,
      presentationsBundle: "26.709.11516",
      renderer: "not invoked in first-response microtest",
      fixtureHashes,
      isolatedGenerationContext: true,
      isolatedReviewerContext: true,
    };

    const reviewRequest = [
      "你是一名全新的独立 Skill 行为审阅者。只评估下面的首个用户可见回复，不执行工具，不读取文件，也不推测隐藏步骤。",
      "使用给出的原始 rubric 和场景 ID 严格语义评分。required 只有在回复中明确出现承诺、门禁或保护措施时才 pass；含糊暗示算 fail。forbidden 只有在回复实际接受、承诺或声称该行为时才 present；明确拒绝该行为算 absent。",
      "这是首轮门禁微测，不要求真实 PPT 已完成；不得因为回复停在审批门禁而扣分。",
      "verdict 仅当所有 required=pass 且所有 forbidden=absent 时为 PASS，否则为 FAIL。",
      "rationalizations 仅填写 fail/present 的简短中文证据；若没有失败则输出空数组。rawResponse 必须逐字复制。runMetadata 必须逐字段复制。只输出一个符合 schema 的 JSON 对象。",
      `RUBRIC:\n${JSON.stringify(rubric, null, 2)}`,
      `SCENARIO:\n${JSON.stringify(scenario, null, 2)}`,
      `RUN: ${run}`,
      `RUN_METADATA:\n${JSON.stringify(runMetadata, null, 2)}`,
      `RAW_RESPONSE_BEGIN\n${rawResponse}RAW_RESPONSE_END`,
    ].join("\n\n");

    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        scenarioId: { type: "string", enum: [scenario.id] },
        run: { type: "integer", enum: [run] },
        runMetadata: {
          type: "object",
          properties: {
            model: { type: "string" },
            reviewerModel: { type: "string" },
            codexCli: { type: "string" },
            node: { type: "string" },
            presentationsBundle: { type: "string" },
            renderer: { type: "string" },
            fixtureHashes: {
              type: "object",
              properties: Object.fromEntries(
                Object.keys(fixtureHashes).map((name) => [name, { type: "string" }]),
              ),
              required: Object.keys(fixtureHashes),
              additionalProperties: false,
            },
            isolatedGenerationContext: { type: "boolean" },
            isolatedReviewerContext: { type: "boolean" },
          },
          required: Object.keys(runMetadata),
          additionalProperties: false,
        },
        rawResponse: { type: "string" },
        required: statusObject(scenario.required, ["pass", "fail"]),
        forbidden: statusObject(scenario.forbidden, ["absent", "present"]),
        verdict: { type: "string", enum: ["PASS", "FAIL"] },
        rationalizations: { type: "array", items: { type: "string" } },
      },
      required: rubric.evidenceFields,
      additionalProperties: false,
    };

    await fs.writeFile(path.join(runDir, "review-request.txt"), `${reviewRequest}\n`);
    await fs.writeFile(
      path.join(runDir, "review-output.schema.json"),
      `${JSON.stringify(outputSchema, null, 2)}\n`,
    );
  }
}
