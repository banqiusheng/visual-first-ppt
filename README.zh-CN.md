<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

<!-- BEGIN NEWBIE_QUICK_START -->
## 新手快速开始

![四阶段新手流程](docs/assets/newbie-quick-start.svg)

### 1. 先确认安装目标

安装任何内容之前，先确认 `SETUP_TARGET`：选择 `Plugin` 或 `Skill-only`，并说明当前属于全新安装、已有安装还是未知状态。如果用户只说“帮我把这个弄好，然后做个 PPT”，Codex 必须把环境配置和 PPT 制作拆成两个独立步骤；在达到 `SETUP_VERIFIED` 前，不能猜安装范围，也不能先替用户选择 PPT 路线。

### 2. 安装固定版本

桌面端最简单的方式是在 Plugin 目录中选择并安装 **Visual-First PPT**。命令行是过程透明的备用方式，并且会执行两个彼此独立的动作：

本 README 中以 `codex` 开头的命令，是供用户手动执行的透明备用方案。活跃的 Codex Agent 不得在工具动作中直接、通过 Shell 或包装器运行 `codex` 可执行文件，包括 `codex plugin ...`。Agent 只能使用当前宿主直接提供的管理控件，或执行下面针对 `${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt` 的限定只读检查。

```bash
codex plugin marketplace add banqiusheng/visual-first-ppt --ref v0.2.0
codex plugin add visual-first-ppt@visual-first-ppt-marketplace
```

第一条命令只登记固定在 `v0.2.0` 标签的 Marketplace，并不代表 Plugin 已经安装；第二条命令才会安装 Plugin。Plugin 安装完成后，请新建一个 Codex 任务。

如果只安装 Skill，请把下面的提示词发给 Codex：

```text
请使用 $skill-installer 从下面的固定版本安装 visual-first-ppt：
https://github.com/banqiusheng/visual-first-ppt/tree/v0.2.0/skills/visual-first-ppt
安装前检查是否已经存在同名 Skill；如果存在，请以 EXISTING_INSTALLATION 停止，不要覆盖。
安装完成后告诉我是否需要新建 Codex 任务，并说明如何使用 $visual-first-ppt 开始。
无论本轮只是说明安装方法，还是实际执行安装，都请用完整的 verification_plan 区块收尾，其中必须包含已安装副本的 doctor 命令、预期与实际结果、激活检查和 setup 状态。
```

### 3. 验证后才能声称成功

安装命令执行结束，不等于产品已经可用。`node skills/visual-first-ppt/scripts/doctor.mjs --json` 检查的是仓库副本，不能代替对已安装副本的验证。默认 Skill-only 安装请运行：

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

如果安装的是 Plugin，只能使用当前宿主直接暴露的 Skill 根目录和 Plugin 信息。如果宿主没有暴露该根目录，请停止并说明阻塞原因；不得猜测或扫描 Plugin 管理的存储。请对宿主暴露的根目录运行上述 doctor 检查，然后新建 Codex 任务，显式调用 `$visual-first-ppt`。只有安装入口、doctor 结果和激活检查都有证据时，才能记录 `SETUP_VERIFIED`。doctor 退出码 `2` 只说明本地必需文件通过、可选生产能力尚未确认，不能据此声称已经具备完整 PPT 生产能力。完整排障顺序见 `SUPPORT.md`。

<!-- BEGIN INSTALL_VERIFICATION_RESPONSE -->
凡是与安装有关的答复，包括仅提供说明、并未实际执行安装的答复，都必须按以下顺序收尾；只写“安装并验证”不算具体验证方法：

- `verification_plan`：`REQUIRED`。
- `installed_target`：准确的已安装 Skill 根目录，或宿主直接暴露的 Plugin Skill 根目录。
- `doctor_command`：Skill-only 先设置 `SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"`，再运行 `node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json`；Plugin 只能代入宿主直接暴露的准确 Skill 根目录。
- `expected_doctor_result`：`exit 0` 且 JSON 为 `PASS` 表示全部必需检查通过；`exit 2` 且 JSON 为 `WARN` 只表示本地要求通过、未暴露的生产能力仍未确认；`exit 1` 且 JSON 为 `FAIL` 表示不可用。
- `doctor_result`：实际退出码和 JSON 状态；仅提供说明时填写 `NOT_RUN`，无法取得安装根目录或执行检查时填写 `NOT_AVAILABLE`。
- `activation_check`：在新的 Codex 轮次或任务中显式调用 `$visual-first-ppt` 后得到的结果。
- `setup_status`：在安装入口、doctor 结果和激活检查三项证据齐全前填写 `SETUP_NOT_VERIFIED`；全部齐全后才能填写 `SETUP_VERIFIED`。
<!-- END INSTALL_VERIFICATION_RESPONSE -->

### 4. 已有安装必须可回滚

如果安装以 `EXISTING_INSTALLATION` 停止，不要直接覆盖。把下面的提示词发给 Codex：

```text
电脑里可能已有 visual-first-ppt。请只读检查：先确认准确目标属于 Skill-only 还是 Plugin，不要把同名项目数据目录当成安装。如果没有找到真实安装，请报告 EXISTING_INSTALLATION_NOT_FOUND，列出检查过的位置和候选版本 v0.2.0，并让我提供准确路径或选择全新安装；此时不要申请升级授权。
Skill-only 恢复：请把这次任务视为安装或升级任务，不是 PPT 制作任务；不要调用已安装的 $visual-first-ppt 工作流。优先检查 ${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt；只有用户明确提供其他绝对 Skill 路径时，才检查该路径。不要运行 codex 可执行文件，也不要无边界搜索主目录。不要读取认证文件，也不要枚举无关环境。先把准确的 Skill 目标与固定的 v0.2.0 做只读版本或内容比较，展示差异和准确路径，然后停在针对该路径的 UPGRADE_APPROVED 授权。只有我批准后，才把旧 Skill 移到带时间戳的同级备份，在全新目标中安装，运行 doctor 并显式调用 $visual-first-ppt 验证；安装或验证失败时执行 ROLLBACK 并恢复备份。不要合并或递归删除旧副本。
Plugin 恢复：只使用当前宿主直接提供的 Plugin 控件。不要在当前活跃任务中运行 codex plugin 命令。仅使用 Codex 支持的 Plugin 管理、更新和回滚控制。不要猜测、移动、重命名或递归删除 Plugin 管理的存储。如果无法确认任何受支持且可恢复的更新或回滚路径，请停止并说明阻塞原因；不要申请或使用 `UPGRADE_APPROVED`。
```

### 5. 开始制作第一份 PPT

如果 `Presentations` 或 `imagegen` 缺失或尚未验证，不得假装能力可用，也不得声称已有最终文件；先按以下结构给出准确恢复点：

<!-- BEGIN CAPABILITY_RECOVERY_RESPONSE -->
- `capability_status`：`BLOCKED_CAPABILITY`。
- `missing_capabilities`：准确列出 `Presentations` 与 `imagegen` 中缺失或未验证的能力。
- `resume_after_capabilities_ready`：当前宿主暴露并验证两项能力后，新建 Codex 任务并显式调用 `$visual-first-ppt`。
- `resume_without_manifest`：`ROUTE_SELECTION_OR_BRIEF`；从 `create`、`template`、`edit` 中选择路线，再从 Brief 继续。
- `resume_with_manifest`：验证 `project-manifest.json` 或用户提供的 project ID，只从其中记录的 `RECORDED_GATE` 恢复。
<!-- END CAPABILITY_RECOVERY_RESPONSE -->

Skill 安装并验证后的下一轮请显式调用它；如果仍未被识别，请新建一个 Codex 任务。然后使用下面的提示词开始：

```text
请使用 $visual-first-ppt。先让我从 create、template、edit 三条路线中选择一条，并在完整制作前遵循对应的审批门禁。
```

第一次回复通常会停在路线选择和审批协议，这是正常设计，不代表任务卡住。
<!-- END NEWBIE_QUICK_START -->

`visual-first-ppt` 是一个面向 Codex 的 PPT 制作 Skill，通过带审批门禁的“视觉优先”流程，从 0 创建演示文稿、套用已有模板或框架，或者在授权范围内修改现有 PPTX。

生成式图片负责氛围、场景和视觉辅助；关键文字、精确数字、表格、图表、引用与审批证据则保留为原生可编辑对象。最终交付的不只是一个好看的文件，还包括明确的审批记录、质量检查证据和可持续访问的交付路径。

> 这是一个社区项目，并非 OpenAI 官方产品。

## 为什么做这个 Skill

PPT 制作常见两个极端：文件可编辑，但视觉效果普通；或者画面精致，却被整页压成图片，难以核验和修改。这个 Skill 将两层能力组合起来：

- 用图片生成能力建立视觉方向和解释性场景；
- 用 PowerPoint 原生对象承载事实性或经常需要修改的内容；
- 在高成本制作继续之前设置明确审批门禁；
- 对局部修改、打包和最终交付进行确定性校验；
- 当用户没有提供资料时检索公开网络，同时严格区分来源事实与模型推断。

如果用户没有预设模板，Skill 会根据受众和主题提出视觉主题方向，并在整套页面制作前完成视觉锁定。

## 支持的三条路线

| 路线 | 适用场景 | 必需的用户门禁 |
| --- | --- | --- |
| `create` | 从 0 创建一份 PPT | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `template` | 基于已有 PPTX、主题或内容框架制作 | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `edit` | 只在授权范围内修改现有 PPTX | `[SCOPE_APPROVED]` → 修改预览 → `[FINAL_APPROVED]` |

“直接做”、用户沉默或仅上传文件，都不会被解释为可以跳过门禁。

## 工作流程

1. **选择路线。** Codex 会先确认本次任务属于 `create`、`template` 还是 `edit`，再检查资料或开始制作。
2. **收集输入。** `template` 和 `edit` 需要用户提供源 PPTX 与现有资料；`create` 则先确认受众、目标、侧重点、页数和约束。
3. **负责任地补充资料。** 用户资料优先。资料不足时，Codex 可以检索公开来源、记录出处、暴露冲突，并避免编造事实。
4. **审批结构与视觉方向。** 用户先审阅大纲，并在适用时锁定视觉系统，再进入完整制作；`edit` 路线则先锁定允许修改的页面范围。
5. **制作并逐页检查。** 每一页都必须渲染检查。关键内容保持原生可编辑，生成式视觉只能进入声明过的安全区域；`edit` 路线中未授权页面要提供 PNG 与 XML 对比证据。
6. **验证并交付。** 自动 QA、全尺寸逐页审阅、目标客户端烟测或用户打开确认、最终审批、确定性打包和持久路径校验是彼此独立的步骤。

## 核心保护措施

- 使用当前 Codex 的 `Presentations` 工作流和 `@oai/artifact-tool`，不使用 `python-pptx`。
- `imagegen` 只负责视觉层，不作为事实文字和精确数据的最终载体。
- 局部修改时保留输入文件，并另存为新的输出文件。
- 对不兼容或高风险改动默认阻塞，除非用户明确批准有记录的降级方案。
- 拒绝交付位于声明目录之外，或位于操作系统、工具临时目录、缓存目录和 scratch 目录中的文件。
- 交付包固定包含一份可编辑 PPTX、一份 PDF、预览图、生产记录和一份确定性 ZIP。

## 环境要求

- 具备当前 `Presentations` 与 `imagegen` Skill 或能力的 Codex 环境。
- Node.js 20 或更高版本，用于项目状态和 QA 脚本。
- Python 3.10 或更高版本，用于差异比较、打包和交付路径校验。
- `PyYAML==6.0.2` 仅用于开发阶段的官方 Skill 校验。

本仓库不内置 Codex、PowerPoint、WPS、LibreOffice、`Presentations`、`imagegen` 或 `@oai/artifact-tool`。

## 安装

为了保证可复现，建议克隆已发布的版本标签，并且只复制可分发的 Skill 目录：

```bash
git clone --branch v0.2.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

`test ! -e` 用于避免意外覆盖已经安装的同名 Skill。复制完成后的下一轮，请先显式调用 `$visual-first-ppt`；如果仍未识别，再新建一个 Codex 任务并重新显式调用。

## 使用示例

```text
Codex，我要从 0 做一份面向职业院校校长的 AI 教学试点方案 PPT。

请基于我上传的 PPT 模板和内容框架，制作一份 12 页解决方案。

只修改现有 PPT 的第 4 页和第 7 页，其余页面必须保持不变，并提供差异证据。
```

第一次回复会有意停在路线选择与对应的审批协议，不会直接越过门禁开始制作。

## 最终交付协议

制作和渲染阶段可以使用 scratch 目录。最终回复之前，必须把获批的 PPTX、PDF 和 ZIP 复制到当前工作区内的持久目录，或用户指定的持久位置，然后运行：

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root /persistent/output \
  /persistent/output/deck.pptx \
  /persistent/output/deck.pdf \
  /persistent/output/deck-delivery.zip
```

只有通过校验的持久副本才可以提供给用户。进入 `DELIVERED` 状态时，还必须绑定获批的 PPTX 和目标目录：

```bash
node skills/visual-first-ppt/scripts/project-state.mjs transition \
  WORKSPACE DELIVERED APPROVED_PPTX_HASH \
  /persistent/output /persistent/output/deck.pptx
```

## 本地校验

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

node --test tests/unit/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python \
  -m unittest discover -s tests/unit -p 'test_*.py' -v

SKILL_CREATOR="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator"
.venv/bin/python "$SKILL_CREATOR/scripts/quick_validate.py" \
  skills/visual-first-ppt
```

## 验证证据

- 仓库内的 Node 与 Python 测试套件是可执行的发布证据。发布校验要求全部测试通过；每次运行都会报告当次准确数量，不在 README 中保留容易过期的固定总数。
- 未加载 Skill 的 15/15 个 RED 压力样本都至少漏掉一项必要协议。
- 加载 Skill 后的 15/15 个 GREEN 行为样本全部通过：75/75 项必需行为通过，30/30 项禁止行为均未出现。
- 合成的 `create`、严格 `template` 和局部 `edit` 三条路线均达到 `DELIVERED`，且 QA 为 PASS；精简结果和哈希见 [`tests/artifacts/artifact-summary.json`](tests/artifacts/artifact-summary.json)。
- 三份合成测试文件均通过 LibreOffice Impress 无界面导入/导出烟测；这不等同于已完成 Microsoft PowerPoint GUI 验证。
- 另有一份使用本流程制作的 10 页教育行业试点方案，于 2026-07-14 由用户在 PowerPoint/WPS 中打开检查，未报告异常。该客户文件不包含在本仓库中。

精简行为记录保存在 [`tests/baseline/summary.json`](tests/baseline/summary.json) 和 [`tests/green/summary.json`](tests/green/summary.json)。原始运行日志、客户资料和生成的 PPT 文件不进入公开仓库；可复用的正向测试支撑脚本保留在 `tests/artifacts/support/`。

## 已知限制

- 模板还原度取决于源文件兼容性，必须用证据确认，不能默认假设。
- 动画、SmartArt、OLE 对象、链接媒体、复杂母版、缺失字体和全局主题修改，可能阻塞编辑或需要用户明确批准降级。
- 位图型 PDF 可以保留外观，但文字不可搜索、不可编辑；生产记录必须说明 PDF 类型。
- 最终兼容性仍取决于真实目标客户端、字体可用性与运行环境。
- 生成场景只用于解释和视觉表达，不能作为真实学校、客户或已完成项目的证据。

## 仓库结构

- `skills/visual-first-ppt/` — 可分发的 Skill。
- `tests/unit/` — 可确定复现的 Node 与 Python 测试。
- `tests/fixtures/` — 小型、中性的 PPTX 与文本夹具。
- `tests/scenarios/` — RED/GREEN 场景定义和提示词工具。
- `tests/artifacts/support/` — 可复用的三路线正向测试支撑脚本；生成结果仅保留在本地。
- `tests/*/summary.json` — 精简验证证据；大型生成产物仅保留在本地。

## 版本与许可证

- 当前版本：[`v0.2.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.2.0)
- 更新记录：[`CHANGELOG.md`](CHANGELOG.md)
- 开源许可证：MIT，详见 [`LICENSE`](LICENSE)
