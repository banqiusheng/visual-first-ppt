import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const README_FILES = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
];
const LANGUAGE_MARKER = "<!-- README_LANGUAGES: en | zh-CN | ja | ko -->";
const QUICK_START_BEGIN = "<!-- BEGIN NEWBIE_QUICK_START -->";
const QUICK_START_END = "<!-- END NEWBIE_QUICK_START -->";
const INSTALL_VERIFICATION_BEGIN = "<!-- BEGIN INSTALL_VERIFICATION_RESPONSE -->";
const INSTALL_VERIFICATION_END = "<!-- END INSTALL_VERIFICATION_RESPONSE -->";
const CAPABILITY_RECOVERY_BEGIN = "<!-- BEGIN CAPABILITY_RECOVERY_RESPONSE -->";
const CAPABILITY_RECOVERY_END = "<!-- END CAPABILITY_RECOVERY_RESPONSE -->";
const QUICK_START_TOKENS = [
  QUICK_START_BEGIN,
  QUICK_START_END,
  "codex plugin marketplace add banqiusheng/visual-first-ppt --ref v0.2.0",
  "codex plugin add visual-first-ppt@visual-first-ppt-marketplace",
  "$skill-installer",
  "$visual-first-ppt",
  "skills/visual-first-ppt/scripts/doctor.mjs",
  "docs/assets/newbie-quick-start.svg",
  "SUPPORT.md",
  "EXISTING_INSTALLATION",
  "EXISTING_INSTALLATION_NOT_FOUND",
  "SETUP_TARGET",
  "SETUP_VERIFIED",
  "UPGRADE_APPROVED",
  "ROLLBACK",
  "--skill-root",
  "--json",
  "verification_plan",
  "expected_doctor_result",
  "resume_after_capabilities_ready",
];
const QUICK_START_PROMPT_TOKENS = [
  "$skill-installer",
  "https://github.com/banqiusheng/visual-first-ppt/tree/v0.2.0/skills/visual-first-ppt",
  "EXISTING_INSTALLATION",
  "$visual-first-ppt",
  "create",
  "template",
  "edit",
];
const INSTALLED_DOCTOR_COMMAND =
  'node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json';
const INSTALLED_DEST_DOCTOR_COMMAND =
  'node "$DEST/scripts/doctor.mjs" --skill-root "$DEST" --json';
const RECOVERY_ROUTE_LABELS = {
  "README.md": ["Skill-only recovery:", "Plugin recovery:"],
  "README.zh-CN.md": ["Skill-only 恢复：", "Plugin 恢复："],
  "README.ja.md": ["Skill-only リカバリー：", "Plugin リカバリー："],
  "README.ko.md": ["Skill-only 복구:", "Plugin 복구:"],
};
const PLUGIN_RECOVERY_PATTERNS = {
  "README.md": [
    /Codex-supported Plugin management, update, and rollback controls/i,
    /Never guess, move, rename, or recursively delete Plugin-managed storage/i,
    /no supported recoverable update or rollback path.*stop.*blocker/is,
    /do not ask for or consume `?UPGRADE_APPROVED`?/i,
  ],
  "README.zh-CN.md": [
    /仅使用 Codex 支持的 Plugin 管理、更新和回滚控制/,
    /不要猜测、移动、重命名或递归删除 Plugin 管理的存储/,
    /无法确认.*受支持.*可恢复.*更新或回滚路径.*停止.*阻塞原因/s,
    /不要申请或使用 `UPGRADE_APPROVED`/,
  ],
  "README.ja.md": [
    /Codex がサポートする Plugin の管理、更新、ロールバック機能だけ/,
    /Plugin 管理下のストレージを推測、移動、名前変更、再帰削除してはいけません/,
    /サポート対象.*復元可能な更新またはロールバック経路.*特定できない.*停止.*ブロッカー/s,
    /`UPGRADE_APPROVED` を要求または使用してはいけません/,
  ],
  "README.ko.md": [
    /Codex가 지원하는 Plugin 관리, 업데이트, 롤백 제어만/,
    /Plugin 관리 저장소를 추측하거나 이동, 이름 변경, 재귀 삭제하지 마세요/,
    /지원되는.*복구 가능한 업데이트 또는 롤백 경로.*확인할 수 없으면.*중단.*차단 사유/s,
    /`UPGRADE_APPROVED`를 요청하거나 사용하지 마세요/,
  ],
};
const NO_NESTED_CODEX_PATTERNS = {
  "README.md": /manual fallback.*active Codex Agent.*must not execute the `codex` executable/is,
  "README.zh-CN.md": /供用户手动执行.*活跃的 Codex Agent.*不得.*运行 `codex` 可执行文件/s,
  "README.ja.md": /ユーザーが手動で実行.*実行中の Codex Agent.*`codex` 実行ファイル.*起動してはいけません/s,
  "README.ko.md": /사용자가 직접 실행.*실행 중인 Codex Agent.*`codex` 실행 파일.*실행해서는 안 됩니다/s,
};
const SKILL_ONLY_BOUNDED_RECOVERY_PATTERNS = {
  "README.md": [
    /setup or upgrade, not PPT production/i,
    /do not invoke the installed \$visual-first-ppt workflow/i,
    /Check \$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt first/i,
    /different absolute Skill path only when the user supplied it explicitly/i,
    /do not read authentication files/i,
    /do not enumerate unrelated environment/i,
  ],
  "README.zh-CN.md": [
    /安装或升级任务，不是 PPT 制作任务/,
    /不要调用已安装的 \$visual-first-ppt 工作流/,
    /优先检查 \$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt/,
    /只有用户明确提供.*其他绝对 Skill 路径/s,
    /不要读取认证文件/,
    /不要枚举无关环境/,
  ],
  "README.ja.md": [
    /セットアップまたはアップグレード.*PPT 制作ではありません/s,
    /インストール済みの \$visual-first-ppt ワークフローを呼び出してはいけません/,
    /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt を最初に確認/,
    /ユーザーが明示的に指定.*別の絶対 Skill パス/s,
    /認証ファイルを読み取ってはいけません/,
    /無関係な環境を列挙してはいけません/,
  ],
  "README.ko.md": [
    /설정 또는 업그레이드 작업이며 PPT 제작 작업이 아닙니다/,
    /설치된 \$visual-first-ppt 워크플로를 호출하지 마세요/,
    /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/visual-first-ppt를 먼저 확인/,
    /사용자가 명시적으로 제공.*다른 절대 Skill 경로/s,
    /인증 파일을 읽지 마세요/,
    /관련 없는 환경을 열거하지 마세요/,
  ],
};
const HOST_NATIVE_PLUGIN_PATTERNS = {
  "README.md": [
    /controls exposed directly by the current host/i,
    /Do not run codex plugin commands from inside the active task/i,
  ],
  "README.zh-CN.md": [
    /当前宿主直接提供的 Plugin 控件/,
    /不要在当前活跃任务中运行 codex plugin 命令/,
  ],
  "README.ja.md": [
    /現在のホストが直接提供する Plugin 管理機能/,
    /実行中のタスク内から codex plugin コマンドを実行してはいけません/,
  ],
  "README.ko.md": [
    /현재 호스트가 직접 제공하는 Plugin 제어/,
    /실행 중인 작업 안에서 codex plugin 명령을 실행하지 마세요/,
  ],
};
const INSTALL_SECTION_HEADINGS = {
  "README.md": "## Install",
  "README.zh-CN.md": "## 安装",
  "README.ja.md": "## インストール",
  "README.ko.md": "## 설치",
};
const QUICK_VERIFY_HEADINGS = {
  "README.md": "### 3. Verify before claiming success",
  "README.zh-CN.md": "### 3. 验证后才能声称成功",
  "README.ja.md": "### 3. 成功を宣言する前に検証する",
  "README.ko.md": "### 3. 성공이라고 말하기 전에 검증합니다",
};
const INSTALL_ACTIVATION_PATTERNS = {
  "README.md": /next Codex turn.*explicitly invoke.*\$visual-first-ppt.*not discovered.*start a new Codex task/is,
  "README.zh-CN.md": /下一轮.*显式调用.*\$visual-first-ppt.*仍未识别.*新建.*Codex 任务/s,
  "README.ja.md": /次の Codex ターン.*\$visual-first-ppt.*明示的に呼び出.*検出されない場合.*新しい Codex タスク/s,
  "README.ko.md": /다음 Codex 턴.*\$visual-first-ppt.*명시적으로 호출.*감지되지.*새 Codex 작업/s,
};
const INSTALL_DOCTOR_REFERENCE_PATTERNS = {
  "README.md": /Quick Start step 3[\s\S]*SETUP_VERIFIED/i,
  "README.zh-CN.md": /快速开始第 3 步[\s\S]*SETUP_VERIFIED/s,
  "README.ja.md": /クイックスタートの手順 3[\s\S]*SETUP_VERIFIED/s,
  "README.ko.md": /빠른 시작 3단계[\s\S]*SETUP_VERIFIED/s,
};
const PLUGIN_DOCTOR_BOUNDARY_PATTERNS = {
  "README.md": [
    /Plugin information exposed directly by the current host/i,
    /host does not expose that root.*stop.*blocker/is,
    /never guess or scan Plugin-managed storage/i,
  ],
  "README.zh-CN.md": [
    /当前宿主直接暴露的.*Plugin 信息/s,
    /宿主没有暴露该根目录.*停止.*阻塞/s,
    /不得猜测或扫描 Plugin 管理的存储/,
  ],
  "README.ja.md": [
    /現在のホストが直接公開した.*Plugin 情報/s,
    /ホストがそのルートを公開していない場合.*停止.*ブロッカー/s,
    /Plugin 管理下のストレージを推測または走査してはいけません/,
  ],
  "README.ko.md": [
    /현재 호스트가 직접 노출한.*Plugin 정보/s,
    /호스트가 해당 루트를 노출하지 않으면.*중단.*차단 사유/s,
    /Plugin 관리 저장소를 추측하거나 스캔하지 마세요/,
  ],
};
const CURRENT_VALIDATION_EVIDENCE_PATTERNS = {
  "README.md": /every test to pass.*each run reports its exact current count.*stale hard-coded totals/is,
  "README.zh-CN.md": /全部测试通过.*每次运行.*当次准确数量.*容易过期的固定总数/s,
  "README.ja.md": /すべてのテスト.*合格.*各実行.*正確な現在数.*固定総数/s,
  "README.ko.md": /모든 테스트.*통과.*각 실행.*정확한 현재 개수.*고정 총계/s,
};

function extractBashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function extractTextBlocks(markdown) {
  return [...markdown.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function extractQuickStart(markdown, readmeFile) {
  assert.equal(
    markdown.split(QUICK_START_BEGIN).length - 1,
    1,
    `${readmeFile} must contain exactly one Quick Start begin marker`,
  );
  assert.equal(
    markdown.split(QUICK_START_END).length - 1,
    1,
    `${readmeFile} must contain exactly one Quick Start end marker`,
  );

  const start = markdown.indexOf(QUICK_START_BEGIN);
  const end = markdown.indexOf(QUICK_START_END, start + QUICK_START_BEGIN.length);
  assert.ok(start >= 0 && end > start, `${readmeFile} has invalid Quick Start marker order`);
  return markdown.slice(start, end + QUICK_START_END.length);
}

function extractInstallVerification(markdown, readmeFile) {
  assert.equal(
    markdown.split(INSTALL_VERIFICATION_BEGIN).length - 1,
    1,
    `${readmeFile} must contain exactly one installation-verification begin marker`,
  );
  assert.equal(
    markdown.split(INSTALL_VERIFICATION_END).length - 1,
    1,
    `${readmeFile} must contain exactly one installation-verification end marker`,
  );
  const start = markdown.indexOf(INSTALL_VERIFICATION_BEGIN);
  const end = markdown.indexOf(INSTALL_VERIFICATION_END, start + INSTALL_VERIFICATION_BEGIN.length);
  assert.ok(start >= 0 && end > start, `${readmeFile} has invalid installation-verification marker order`);
  return markdown.slice(start, end + INSTALL_VERIFICATION_END.length);
}

function extractCapabilityRecovery(markdown, readmeFile) {
  assert.equal(
    markdown.split(CAPABILITY_RECOVERY_BEGIN).length - 1,
    1,
    `${readmeFile} must contain exactly one capability-recovery begin marker`,
  );
  assert.equal(
    markdown.split(CAPABILITY_RECOVERY_END).length - 1,
    1,
    `${readmeFile} must contain exactly one capability-recovery end marker`,
  );
  const start = markdown.indexOf(CAPABILITY_RECOVERY_BEGIN);
  const end = markdown.indexOf(CAPABILITY_RECOVERY_END, start + CAPABILITY_RECOVERY_BEGIN.length);
  assert.ok(start >= 0 && end > start, `${readmeFile} has invalid capability-recovery marker order`);
  return markdown.slice(start, end + CAPABILITY_RECOVERY_END.length);
}

function extractHeadingSection(markdown, heading, nextHeadingPrefix, readmeFile) {
  const start = markdown.indexOf(heading);
  assert.ok(start >= 0, `${readmeFile} is missing ${heading}`);
  const end = markdown.indexOf(nextHeadingPrefix, start + heading.length);
  assert.ok(end > start, `${readmeFile} has no section after ${heading}`);
  return markdown.slice(start, end);
}

test("all localized READMEs expose the same release and workflow contract", async () => {
  const canonicalReadme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const canonicalBashBlocks = extractBashBlocks(canonicalReadme);
  const canonicalQuickStart = extractQuickStart(canonicalReadme, "README.md");
  const canonicalQuickStartBashBlocks = extractBashBlocks(canonicalQuickStart);
  const localizedQuickStartPrompts = [];

  for (const readmeFile of README_FILES) {
    const readme = await fs.readFile(path.join(ROOT, readmeFile), "utf8");
    assert.doesNotMatch(
      readme,
      /\b(?:installation_verification|resume_point_after_verification)\b/,
      `${readmeFile} must not expose frozen evaluation field names`,
    );
    const quickStart = extractQuickStart(readme, readmeFile);
    const installVerification = extractInstallVerification(quickStart, readmeFile);
    const capabilityRecovery = extractCapabilityRecovery(quickStart, readmeFile);
    const quickStartPrompts = extractTextBlocks(quickStart).join("\n");
    const installSection = extractHeadingSection(
      readme,
      INSTALL_SECTION_HEADINGS[readmeFile],
      "\n## ",
      readmeFile,
    );
    const verifyStep = extractHeadingSection(
      quickStart,
      QUICK_VERIFY_HEADINGS[readmeFile],
      "\n### ",
      readmeFile,
    );

    assert.ok(readme.includes(LANGUAGE_MARKER), `${readmeFile} is missing the language marker`);
    assert.equal((readme.match(/^## /gm) ?? []).length, 14, `${readmeFile} has a section mismatch`);
    assert.deepEqual(
      extractBashBlocks(readme),
      canonicalBashBlocks,
      `${readmeFile} has commands that differ from README.md`,
    );
    assert.deepEqual(
      extractBashBlocks(quickStart),
      canonicalQuickStartBashBlocks,
      `${readmeFile} has Quick Start commands that differ from README.md`,
    );
    assert.ok(
      canonicalQuickStartBashBlocks.length > 0,
      "README.md Quick Start must contain at least one bash block",
    );
    for (const token of QUICK_START_TOKENS) {
      assert.ok(quickStart.includes(token), `${readmeFile} Quick Start is missing ${token}`);
    }
    assert.match(
      quickStart,
      /SETUP_TARGET[\s\S]*Plugin[\s\S]*Skill-only[\s\S]*SETUP_VERIFIED/,
      `${readmeFile} must clarify setup before use`,
    );
    assert.match(
      quickStart,
      new RegExp(
        `${INSTALLED_DOCTOR_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*SETUP_VERIFIED`,
      ),
      `${readmeFile} must verify the installed root before SETUP_VERIFIED`,
    );
    const verificationFields = [
      "verification_plan",
      "installed_target",
      "doctor_command",
      "expected_doctor_result",
      "doctor_result",
      "activation_check",
      "setup_status",
    ];
    let previousVerificationField = -1;
    for (const field of verificationFields) {
      const currentIndex = installVerification.indexOf(field);
      assert.ok(
        currentIndex > previousVerificationField,
        `${readmeFile} installation-verification field ${field} is missing or out of order`,
      );
      previousVerificationField = currentIndex;
    }
    assert.ok(
      installVerification.includes(INSTALLED_DOCTOR_COMMAND),
      `${readmeFile} verification response must include the installed-copy doctor command`,
    );
    assert.match(installVerification, /expected_doctor_result[\s\S]*exit 0[\s\S]*PASS/);
    assert.match(installVerification, /expected_doctor_result[\s\S]*exit 2[\s\S]*WARN/);
    assert.match(installVerification, /doctor_result[\s\S]*NOT_RUN[\s\S]*NOT_AVAILABLE/);
    assert.match(installVerification, /activation_check[\s\S]*\$visual-first-ppt/);
    assert.match(
      installVerification,
      /setup_status[\s\S]*SETUP_NOT_VERIFIED[\s\S]*SETUP_VERIFIED/,
      `${readmeFile} verification response must fail closed before SETUP_VERIFIED`,
    );
    const capabilityFields = [
      "capability_status",
      "missing_capabilities",
      "resume_after_capabilities_ready",
      "resume_without_manifest",
      "resume_with_manifest",
    ];
    let previousCapabilityField = -1;
    for (const field of capabilityFields) {
      const currentIndex = capabilityRecovery.indexOf(field);
      assert.ok(
        currentIndex > previousCapabilityField,
        `${readmeFile} capability-recovery field ${field} is missing or out of order`,
      );
      previousCapabilityField = currentIndex;
    }
    for (const token of [
      "BLOCKED_CAPABILITY",
      "Presentations",
      "imagegen",
      "$visual-first-ppt",
      "ROUTE_SELECTION_OR_BRIEF",
      "create",
      "template",
      "edit",
      "project-manifest.json",
      "project ID",
      "RECORDED_GATE",
    ]) {
      assert.ok(capabilityRecovery.includes(token), `${readmeFile} capability recovery is missing ${token}`);
    }
    assert.ok(
      quickStart.indexOf("SETUP_VERIFIED") < quickStart.indexOf("create"),
      `${readmeFile} must verify setup before choosing a PPT route`,
    );
    assert.match(
      quickStart,
      /EXISTING_INSTALLATION[\s\S]*UPGRADE_APPROVED[\s\S]*ROLLBACK/,
      `${readmeFile} must expose a recoverable existing-installation path`,
    );
    assert.match(
      quickStart,
      NO_NESTED_CODEX_PATTERNS[readmeFile],
      `${readmeFile} must distinguish manual commands from nested Codex execution`,
    );
    assert.match(
      quickStart,
      /CODEX_HOME:-\$HOME\/\.codex[\s\S]*skills\/visual-first-ppt/,
      `${readmeFile} must name the bounded default Skill target`,
    );
    const [skillOnlyLabel, pluginLabel] = RECOVERY_ROUTE_LABELS[readmeFile];
    const skillOnlyStart = quickStart.indexOf(skillOnlyLabel);
    const pluginStart = quickStart.indexOf(pluginLabel);
    assert.ok(skillOnlyStart >= 0, `${readmeFile} must label the Skill-only recovery route`);
    assert.ok(pluginStart > skillOnlyStart, `${readmeFile} must separate Plugin recovery`);
    const skillOnlyRecovery = quickStart.slice(skillOnlyStart, pluginStart);
    const pluginRecovery = quickStart.slice(pluginStart);
    assert.match(skillOnlyRecovery, /UPGRADE_APPROVED[\s\S]*ROLLBACK/);
    for (const pattern of SKILL_ONLY_BOUNDED_RECOVERY_PATTERNS[readmeFile]) {
      assert.match(skillOnlyRecovery, pattern, `${readmeFile} Skill-only recovery is unbounded`);
    }
    for (const pattern of PLUGIN_RECOVERY_PATTERNS[readmeFile]) {
      assert.match(pluginRecovery, pattern, `${readmeFile} Plugin recovery is incomplete`);
    }
    for (const pattern of HOST_NATIVE_PLUGIN_PATTERNS[readmeFile]) {
      assert.match(pluginRecovery, pattern, `${readmeFile} Plugin recovery must stay host-native`);
    }
    assert.match(
      installSection,
      INSTALL_ACTIVATION_PATTERNS[readmeFile],
      `${readmeFile} Install section must use the next-turn-then-new-task Skill activation path`,
    );
    const copyIndex = installSection.indexOf('cp -R skills/visual-first-ppt "$DEST"');
    const installedDoctorIndex = installSection.indexOf(INSTALLED_DEST_DOCTOR_COMMAND);
    assert.ok(
      copyIndex >= 0 && installedDoctorIndex > copyIndex,
      `${readmeFile} Install section must run doctor against the installed copy after copying it`,
    );
    assert.match(
      installSection,
      INSTALL_DOCTOR_REFERENCE_PATTERNS[readmeFile],
      `${readmeFile} Install section must point beginners back to Quick Start step 3`,
    );
    for (const pattern of PLUGIN_DOCTOR_BOUNDARY_PATTERNS[readmeFile]) {
      assert.match(verifyStep, pattern, `${readmeFile} Plugin doctor guidance must fail closed`);
    }
    assert.doesNotMatch(
      readme,
      /59\/59|38 Node|Node 38|Python 21|21 Python/,
      `${readmeFile} contains stale validation totals`,
    );
    assert.match(
      readme,
      CURRENT_VALIDATION_EVIDENCE_PATTERNS[readmeFile],
      `${readmeFile} must explain count-independent release evidence`,
    );
    assert.doesNotMatch(
      pluginRecovery,
      /timestamped sibling backup|带时间戳的同级备份|タイムスタンプ付き同階層バックアップ|타임스탬프가 있는 동일 계층 백업/i,
      `${readmeFile} must not apply Skill-only storage moves to Plugin recovery`,
    );
    assert.doesNotMatch(quickStart, /rm\s+-rf/i, `${readmeFile} must not recommend destructive reset`);
    for (const token of QUICK_START_PROMPT_TOKENS) {
      assert.ok(quickStartPrompts.includes(token), `${readmeFile} prompts are missing ${token}`);
    }
    localizedQuickStartPrompts.push(quickStartPrompts);
    for (const linkedReadme of README_FILES) {
      assert.ok(readme.includes(`](${linkedReadme})`), `${readmeFile} does not link to ${linkedReadme}`);
    }

    for (const route of ["create", "template", "edit"]) {
      assert.match(readme, new RegExp(`\\b${route}\\b`), `${readmeFile} is missing route ${route}`);
    }
    for (const gate of [
      "[OUTLINE_APPROVED]",
      "[VISUAL_LOCKED]",
      "[SCOPE_APPROVED]",
      "[FINAL_APPROVED]",
    ]) {
      assert.ok(readme.includes(gate), `${readmeFile} is missing gate ${gate}`);
    }

    for (const requiredText of [
      "visual-first-ppt",
      "verify_handoff_paths.py",
      "project-state.mjs",
      "https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.2.0",
      "CHANGELOG.md",
      "LICENSE",
    ]) {
      assert.ok(readme.includes(requiredText), `${readmeFile} is missing ${requiredText}`);
    }

    assert.doesNotMatch(readme, /After this repository is published/i);

    for (const link of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = link[1].split("#", 1)[0];
      if (!target || /^https?:\/\//.test(target)) continue;
      await assert.doesNotReject(
        fs.access(path.join(ROOT, target)),
        `${readmeFile} links to missing path ${target}`,
      );
    }
  }

  assert.equal(
    new Set(localizedQuickStartPrompts).size,
    README_FILES.length,
    "Quick Start text prompts must be localized in every README",
  );
});
