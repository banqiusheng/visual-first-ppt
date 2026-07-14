# Intake, research, and source contract

Build the narrative from traceable evidence. User urgency may reduce low-value questions, but it never permits invented facts, hidden private-source access, or unlicensed default assets.

## Supported inputs

Accept and inventory `.pptx`, `.pdf`, `.docx`, `.xlsx`, `.csv`, `.md`, `.txt`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, screenshots, web URLs, and pasted text. Preserve every original file and hash it before interpretation. Record parser/tool limitations instead of treating extraction as lossless.

## Source precedence and permissions

Resolve claims in this order: 用户明确事实 → 用户文件 → 权威一手公开资料 → 可靠二手资料 → 模型推断. A lower-priority source never silently overrides a higher-priority source; log conflicts and ask for a decision when they affect conclusions.

- `[PUBLIC_WEB_DEFAULT]`: when supplied materials are absent or incomplete, automatically research the public web without asking again for ordinary browsing permission. Prefer primary and authoritative sources, preserve the access URL and date, and distinguish source fact from Codex inference. If the user forbids browsing, stay within the supplied evidence.
- `[PRIVATE_SOURCE_APPROVAL]`: 登录、付费、内部系统或私有资料必须获得单独批准 before access. Approval to make a PPT is not approval to use credentials, subscriptions, private drives, or internal databases.
- `[NO_FABRICATION]`: if no reliable support exists, record the gap and narrow or remove the claim. Never invent citations, numbers, customer cases, quotations, product capabilities, or research findings.
- 数据冲突、统计口径不明或关键事实无法核验时，进入 `[BLOCKED_SOURCE]`；列出冲突值、来源、口径、受影响页面和需要用户决定的事项。

## Source ledger

`[SOURCE_LEDGER]` is the canonical inventory. Each record includes `sourceId`, type, title, local path or URL, provenance, author/publisher when known, access date, content hash, license or usage boundary, verification status, supported claims, and affected pages. Keep user facts, source facts, and model inferences distinguishable.

Critical numbers and quotations must point to a ledger record. 公开来源默认只写入生产记录；用户明确要求页内引用、脚注或参考文献页时，才把来源放到 PPT 页面。This default does not remove traceability from the working files.

## Research completion and outline

Research is ready only when the Brief’s decision, audience, core claims, and critical data are supported or explicitly labeled as assumptions. Then create an outline containing:

- the overall narrative and chapter structure;
- each slide’s role, purpose, and core conclusion;
- main content and the evidence/source IDs supporting it;
- needed data, unresolved assumptions, and conflicts;
- recommended visual form and which elements must remain native/editable.

Do not generate the full deck before the outline hash is approved for `create` or `template`.

## Image evidence and copyright policy

Use visual assets in this order: 用户素材 → `imagegen` for non-evidentiary backgrounds, scenes, people, illustrations, and decoration → verified-license public images when factual appearance is necessary. Do not use a web image merely because it is visually convenient.

- For every public image, record its original URL、作者/发布者、许可证或使用条款、access date, and local hash in the source ledger.
- 许可证无法核验的图片不得进入默认交付; propose a licensed substitute, an `imagegen` illustration, or a user decision instead.
- 用户指定的受版权保护素材必须在制作记录中标记为 `用户指定素材`; do not misstate it as licensed by the Skill.
- 生成的人物、地点、产品或事件场景不得描述为真实证据、真实现场或纪实照片. Label synthetic explanatory visuals whenever a reasonable viewer could mistake them for evidence.
- Generated images must not contain critical text, exact numbers, tables, axes, citations, or other content that must be checked or edited natively.
