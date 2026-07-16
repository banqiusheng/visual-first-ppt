import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const skillRoot = path.resolve("skills/visual-first-ppt");

async function readReference(name) {
  return fs.readFile(path.join(skillRoot, "references", name), "utf8");
}

test("workflow defines all route, approval, blocker, and recovery gates", async () => {
  const workflow = await readReference("workflow.md");
  for (const marker of [
    "[ROUTE_SELECTED]",
    "[OUTLINE_APPROVED]",
    "[VISUAL_LOCKED]",
    "[SCOPE_APPROVED]",
    "[FINAL_APPROVED]",
    "[BLOCKED_SOURCE]",
    "[BLOCKED_COMPATIBILITY]",
  ]) {
    assert.match(workflow, new RegExp(`\\${marker}`), `missing ${marker}`);
  }

  assert.match(workflow, /从 0 创建/);
  assert.match(workflow, /基于已有模板、主题或框架制作/);
  assert.match(workflow, /修改现有 PPT/);
  assert.match(workflow, /Create and template flow/);
  assert.match(workflow, /Edit flow/);
  assert.match(workflow, /16:9/);
  assert.match(workflow, /8[–-]12 页/);
  assert.match(workflow, /approvedArtifactHash/);
  assert.match(workflow, /approvedAt/);
  assert.match(workflow, /userMessage/);
  assert.match(workflow, /拒绝.*回到.*review/is);
  assert.match(workflow, /审批失效矩阵/);
  assert.match(workflow, /超过 20 页/);
  assert.match(workflow, /5[–-]8 页/);
  assert.match(workflow, /project ID/);
  assert.match(workflow, /manifest path/);
});

test("intake and research contract is public-web by default and fail-closed on evidence", async () => {
  const intake = await readReference("intake-and-research.md");
  for (const marker of [
    "[PUBLIC_WEB_DEFAULT]",
    "[PRIVATE_SOURCE_APPROVAL]",
    "[NO_FABRICATION]",
    "[SOURCE_LEDGER]",
  ]) {
    assert.match(intake, new RegExp(`\\${marker}`), `missing ${marker}`);
  }

  for (const extension of [".pptx", ".pdf", ".docx", ".xlsx", ".csv", ".md", ".txt", ".png", ".jpg", ".svg"]) {
    assert.match(intake, new RegExp(`\\${extension}`), `missing supported type ${extension}`);
  }
  assert.match(intake, /用户明确事实.*用户文件.*权威一手公开资料.*可靠二手资料.*模型推断/s);
  assert.match(intake, /登录.*付费.*私有.*单独批准/s);
  assert.match(intake, /数据冲突.*\[BLOCKED_SOURCE\]/s);
  assert.match(intake, /生产记录.*用户明确要求.*页内引用/s);
  assert.match(intake, /用户素材.*imagegen/s);
  assert.match(intake, /URL.*作者.*许可证/s);
  assert.match(intake, /许可证.*无法核验.*默认交付/s);
  assert.match(intake, /用户指定.*版权.*标记/s);
  assert.match(intake, /生成.*场景.*真实证据/s);
});

test("generation contract enforces one visual route and native critical content", async () => {
  const generation = await readReference("generation-contract.md");
  for (const marker of [
    "[ONE_VISUAL_ROUTE]",
    "[TEMPLATE_MAPPING_REQUIRED]",
    "[NATIVE_CRITICAL_CONTENT]",
    "[FLATTENED_PAGE_APPROVAL]",
    "[RENDER_EVERY_BUILD]",
  ]) {
    assert.match(generation, new RegExp(`\\${marker}`), `missing ${marker}`);
  }
  assert.match(generation, /@oai\/artifact-tool/);
  assert.match(generation, /不得使用 `python-pptx`/);
  assert.match(generation, /imagegen.*safeZone/is);
  assert.match(generation, /关键文字.*精确数据.*原生/s);
  assert.match(generation, /导入.*图表.*表格.*object inventory/is);
  assert.match(generation, /imagegen.*失败.*重试.*降级/s);
  assert.match(generation, /speaker notes.*明确要求/is);
  assert.match(generation, /不自动.*旁白.*嵌入音频.*动画.*转场/s);
});

test("generation routing and slide-spec fields are explicit", async () => {
  const generation = await readReference("generation-contract.md");
  for (const route of [
    "Existing native Google Slides -> Google Drive Slides workflow",
    "Net-new Google Slides -> verified local PPTX, then native import",
    "PowerPoint/local deck -> Presentations",
    "User template/source deck -> template-following only",
    "Approved custom theme -> explicit custom formatting",
    "Custom theme declined -> Presentations default layout system",
  ]) {
    assert.ok(generation.includes(route), `missing route: ${route}`);
  }
  assert.match(generation, /read.*installed `Presentations` skill completely/is);
  assert.match(generation, /current `imagegen` skill/is);
  for (const field of [
    "visualLayerSource",
    "nativeObjects",
    "safeZone",
    "flattened",
    "flattenedApprovalHash",
    "dataBindings",
    "renderEvidence",
  ]) {
    assert.match(generation, new RegExp(`\\b${field}\\b`), `missing slide-spec field ${field}`);
  }
  assert.match(generation, /新建.*表格.*图表.*原生/s);
  assert.match(generation, /rebuild.*approved_flatten.*blocked/s);
  assert.match(generation, /不得.*可编辑/s);
});

test("QA and delivery reference defines compatibility, hard thresholds, and packaging", async () => {
  const qa = await readReference("qa-and-delivery.md");
  assert.match(qa, /自动检查.*全尺寸人工复核.*目标客户端烟测/s);
  assert.match(qa, /raster PDF.*vector PDF/is);
  assert.match(qa, /overflow.*unexpectedOverlap.*unresolvedPlaceholder.*brokenRelationship.*dataMismatch.*必须为 0/s);
  assert.match(qa, /4\/5/);
  assert.match(qa, /package_delivery\.py.*--workspace.*--delivery-dir.*--output/s);
  assert.match(qa, /Presentations.*最终回复.*文件链接/s);
  assert.match(qa, /verify_handoff_paths\.py.*PPTX.*PDF.*ZIP/is);
  assert.match(qa, /--persistent-root/);
  assert.match(qa, /out-of-root/i);
  assert.match(qa, /persistent.*current workspace.*user-selected/is);
  assert.match(qa, /temporary.*build-only.*never.*final.*link/is);
  for (const risk of ["动画", "转场", "SmartArt", "嵌入对象", "媒体", "链接图表", "复杂母版", "speaker notes", "全局字体", "全局配色", "页面比例"]) {
    assert.match(qa, new RegExp(risk, "i"), `missing compatibility risk ${risk}`);
  }
  assert.match(qa, /默认阻塞.*明确批准.*降级/s);
});

test("SKILL entrypoint is concise, valid, and directly routes every reference", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatterMatch, "missing YAML frontmatter");
  const keys = frontmatterMatch[1]
    .split("\n")
    .filter((line) => /^[A-Za-z][A-Za-z0-9_-]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")))
    .sort();
  assert.deepEqual(keys, ["description", "name"]);
  assert.match(frontmatterMatch[1], /^description: Use when/m);

  for (const reference of [
    "workflow.md",
    "intake-and-research.md",
    "themes.md",
    "generation-contract.md",
    "qa-and-delivery.md",
  ]) {
    assert.match(skill, new RegExp(`\\(references/${reference.replace(".", "\\.")}\\)`));
  }
  for (const heading of [
    "Overview",
    "Required sub-skills",
    "Start or resume a project",
    "Choose the route",
    "Run the current state only",
    "Approval gates",
    "Validate and deliver",
    "Failure handling",
    "Reference routing",
  ]) {
    assert.match(skill, new RegExp(`^## ${heading}$`, "m"), `missing heading ${heading}`);
  }
  assert.match(skill, /initProject|project-state\.mjs init/);
  assert.match(skill, /create.*template.*edit/s);
  assert.match(skill, /OUTLINE_APPROVED.*VISUAL_LOCKED.*FINAL_APPROVED/s);
  assert.match(skill, /SCOPE_APPROVED.*CHANGE_PREVIEW.*FINAL_APPROVED/s);
  assert.match(skill, /Presentations/);
  assert.match(skill, /imagegen/);
  assert.match(skill, /validate.*DELIVERED/is);
  assert.match(skill, /production-record/);
  assert.match(skill, /verify_handoff_paths\.py/);
  assert.match(skill, /finalOutputRoot/);
  assert.match(skill, /--persistent-root/);
  assert.match(skill, /persistent.*current workspace.*user-selected/is);
  assert.match(skill, /temporary.*never.*DELIVERED/is);
  assert.match(skill, /\[BASELINE_COUNTER: act-before-gates\]/);
  assert.match(skill, /\[BASELINE_COUNTER: unchanged-without-diff\]/);

  const body = skill.slice(frontmatterMatch[0].length);
  const wordCount = body.trim().split(/\s+/).length;
  const lineCount = skill.split("\n").length;
  assert.ok(wordCount < 2500, `SKILL body is ${wordCount} words`);
  assert.ok(lineCount < 500, `SKILL has ${lineCount} lines`);
});

test("scenario prompt renderer is portable and has no personal repository path", async () => {
  const renderer = await fs.readFile("tests/scenarios/render-prompts.mjs", "utf8");
  assert.doesNotMatch(renderer, /\/Users\/[^/]+\//);
  assert.match(renderer, /VISUAL_FIRST_PPT_SKILL_PATH/);
  assert.match(renderer, /import\.meta\.url/);
});

test("SKILL first response exposes the complete route contract before tools", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^## Mandatory new-project first-turn stop$/m);
  assert.ok(
    skill.indexOf("## Mandatory new-project first-turn stop") < skill.indexOf("## Overview"),
    "new-project stop must be the first body section",
  );
  assert.match(skill, /Do not execute any other tool after reading this file.*Ignore every later section on this turn/s);
  assert.match(skill, /^### First user-visible response contract$/m);
  assert.ok(
    skill.indexOf("### First user-visible response contract") < skill.indexOf("## Required sub-skills"),
    "first-response hard stop must appear before sub-skill/tool instructions",
  );
  assert.match(skill, /明确描述.*直接记录.*\[ROUTE_SELECTED\]/s);
  assert.match(skill, /不得把用户要求的捷径复述为已接受规则/);
  assert.match(skill, /Never begin.*“直接完成”.*“我不会中途提问”/s);
  assert.match(skill, /\[NEW_PROJECT_FIRST_TURN\].*After reading this `SKILL\.md`.*route contract.*END TURN.*only allowed first-turn tool action/s);
  assert.match(skill, /Do not read references, inspect attachments, browse, initialize, or research/s);

  assert.match(skill, /`create` first response.*\[PUBLIC_WEB_DEFAULT\].*source-ledger\.json.*\[OUTLINE_APPROVED\].*\[VISUAL_LOCKED\].*\[FINAL_APPROVED\]/s);
  assert.match(skill, /`template` first response.*source PPT.*primary visual source.*\[OUTLINE_APPROVED\].*\[VISUAL_LOCKED\].*strict layout.*whole-deck.*\[FINAL_APPROVED\]/is);
  assert.match(skill, /`edit` first response.*COMPATIBILITY_REVIEW.*\[SCOPE_APPROVED\].*CHANGE_PREVIEW.*compare_untouched_slides\.py.*新输出文件.*\[FINAL_APPROVED\]/s);
  assert.match(skill, /\[EDIT_FIRST_TURN_CHECKLIST\].*Every edit first response MUST show.*authorized pages `CHANGE_PREVIEW`.*do not shorten at the current gate/s);
  assert.match(skill, /first response.*stop before research, inspection, or editing/is);
});

test("SKILL separates current setup requests without depending on repository state at runtime", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");

  assert.match(
    skill,
    /Mandatory new-project first-turn stop[\s\S]*current request[\s\S]*presentation project/,
  );
  assert.match(
    skill,
    /installation.*upgrade.*set this up.*make a PPT.*not.*new presentation project/is,
  );
  assert.match(skill, /resolve SETUP_TARGET.*before invoking this Skill/is);
  assert.match(
    skill,
    /already installed.*self-contained.*does not require.*historical SETUP_VERIFIED.*root AGENTS\.md.*README/is,
  );
});

test("SKILL blocks missing capabilities and names the exact verified resume point", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.doesNotMatch(
    skill,
    /\b(?:installation_verification|resume_point_after_verification)\b/,
    "SKILL.md must not expose frozen evaluation field names",
  );
  const responseStart = skill.indexOf("### First user-visible response contract");
  const requiredSkillsStart = skill.indexOf("## Required sub-skills", responseStart);

  assert.ok(responseStart >= 0, "SKILL must define the first-response contract");
  assert.ok(requiredSkillsStart > responseStart, "capability recovery must be visible before sub-skill execution");
  const responseContract = skill.slice(responseStart, requiredSkillsStart);

  for (const field of [
    "capability_status",
    "missing_capabilities",
    "resume_after_capabilities_ready",
    "resume_without_manifest",
    "resume_with_manifest",
  ]) {
    assert.ok(responseContract.includes(field), `missing capability field ${field}`);
  }
  assert.match(responseContract, /capability_status[\s\S]*BLOCKED_CAPABILITY/);
  assert.match(responseContract, /missing_capabilities[\s\S]*Presentations[\s\S]*imagegen/);
  assert.match(
    responseContract,
    /resume_after_capabilities_ready[\s\S]*both capabilities[\s\S]*new Codex task[\s\S]*\$visual-first-ppt/is,
  );
  assert.match(responseContract, /resume_without_manifest[\s\S]*ROUTE_SELECTION_OR_BRIEF[\s\S]*create[\s\S]*template[\s\S]*edit/is);
  assert.match(responseContract, /resume_with_manifest[\s\S]*project-manifest\.json[\s\S]*project ID[\s\S]*RECORDED_GATE/is);
  assert.match(responseContract, /do not claim.*final.*file/is);
});
