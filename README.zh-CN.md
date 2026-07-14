<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

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
git clone --branch v0.1.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

`test ! -e` 用于避免意外覆盖已经安装的同名 Skill。复制完成后，请新建一个 Codex 任务，让 Skill 被干净识别。

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

- 59/59 项单元测试通过：Node 38 项、Python 21 项，覆盖多语言文档、持久目录和公开证据边界。
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

- 当前版本：[`v0.1.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.1.0)
- 更新记录：[`CHANGELOG.md`](CHANGELOG.md)
- 开源许可证：MIT，详见 [`LICENSE`](LICENSE)
