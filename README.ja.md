<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

<!-- BEGIN NEWBIE_QUICK_START -->
## クイックスタート

![4 段階の初心者向けフロー](docs/assets/newbie-quick-start.svg)

### 1. セットアップ対象を確認する

何かをインストールする前に `SETUP_TARGET` を確定します。`Plugin` または `Skill-only` を選び、現在の状態が新規インストール、既存インストール、不明のどれかを明示してください。「これを使えるようにしてから PPT を作って」のような曖昧な依頼では、Codex はセットアップと資料制作を別の工程として扱います。`SETUP_VERIFIED` に到達するまで、インストール範囲を推測したり、先に資料制作のルートを選んだりしてはいけません。

### 2. 固定バージョンをインストールする

デスクトップでは、Plugin ディレクトリから **Visual-First PPT** を選んでインストールするのが最も簡単です。コマンドラインは処理内容が明確な代替手段で、二つの独立した操作を行います。

この README の `codex` で始まるコマンドは、ユーザーが手動で実行する透明な代替手順です。実行中の Codex Agent は、ツール操作として直接、Shell、またはラッパー経由で `codex` 実行ファイル（`codex plugin ...` を含む）を起動してはいけません。現在のホストが直接提供する管理機能、または以下の `${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt` に限定した読み取り専用確認だけを使用します。

```bash
codex plugin marketplace add banqiusheng/visual-first-ppt --ref v0.3.0
codex plugin add visual-first-ppt@visual-first-ppt-marketplace
```

最初のコマンドは `v0.3.0` タグに固定された Marketplace を登録するだけで、Plugin のインストールは行いません。二つ目のコマンドで Plugin をインストールします。Plugin のインストール後は、新しい Codex タスクを開始してください。

Skill のみをインストールする場合は、次のプロンプトを Codex に貼り付けてください。

```text
$skill-installer を使って、次の固定バージョンから visual-first-ppt をインストールしてください：
https://github.com/banqiusheng/visual-first-ppt/tree/v0.3.0/skills/visual-first-ppt
インストール前に同名の Skill がないか確認し、存在する場合は EXISTING_INSTALLATION で停止して上書きしないでください。
インストール後、新しい Codex タスクが必要かどうかと、$visual-first-ppt で始める方法を説明してください。
インストール方法の説明だけの場合も、実際にインストールする場合も、インストール済みコピー用 doctor コマンド、期待結果と実結果、起動確認、setup 状態を含む完全な verification_plan ブロックで回答を終えてください。
```

### 3. 成功を宣言する前に検証する

インストールコマンドが終了しただけでは、利用可能になった証拠にはなりません。`node skills/visual-first-ppt/scripts/doctor.mjs --json` が確認するのはリポジトリのコピーであり、インストール済みコピーの検証にはなりません。標準の Skill-only インストールでは、次を実行します。

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json
```

Plugin をインストールした場合は、現在のホストが直接公開した Skill ルートと Plugin 情報だけを使用します。ホストがそのルートを公開していない場合は停止してブロッカーを説明し、Plugin 管理下のストレージを推測または走査してはいけません。公開されたルートに対して上記の doctor チェックを実行します。その後、新しい Codex タスクを開始して `$visual-first-ppt` を明示的に呼び出します。インストール済みのエントリーポイント、doctor の結果、起動確認の三つに証拠がある場合に限り、`SETUP_VERIFIED` を記録します。doctor の終了コード `2` は必須のローカルファイルが確認できたことを示しますが、任意の制作機能は未確認です。完全な PPT 制作準備が整ったとは表現しないでください。詳細な診断手順は `SUPPORT.md` にあります。

<!-- BEGIN INSTALL_VERIFICATION_RESPONSE -->
インストールを実行せず説明だけを行う場合も含め、インストールに関するすべての回答は次のフィールドをこの順序で末尾に記載します。「インストールして検証する」だけでは具体的な検証方法になりません。

- `verification_plan`：`REQUIRED`。
- `installed_target`：正確なインストール済み Skill ルート、またはホストが公開した Plugin Skill ルート。
- `doctor_command`：Skill-only では `SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"` を設定し、`node "$SKILL_ROOT/scripts/doctor.mjs" --skill-root "$SKILL_ROOT" --json` を実行します。Plugin ではホストが直接公開した正確な Skill ルートだけを代入します。
- `expected_doctor_result`：`exit 0` かつ JSON `PASS` は必須確認がすべて成功、`exit 2` かつ JSON `WARN` はローカル要件のみ成功して未公開の制作機能は未確認、`exit 1` かつ JSON `FAIL` は利用不可を示します。
- `doctor_result`：実際の終了コードと JSON ステータス。説明だけの場合は `NOT_RUN`、インストール先または確認が利用できない場合は `NOT_AVAILABLE`。
- `activation_check`：新しい Codex ターンまたはタスクで `$visual-first-ppt` を明示的に呼び出した結果。
- `setup_status`：インストール済みエントリーポイント、doctor 結果、起動確認の証拠がそろうまでは `SETUP_NOT_VERIFIED`、すべてそろった場合のみ `SETUP_VERIFIED`。
<!-- END INSTALL_VERIFICATION_RESPONSE -->

### 4. 既存インストールを復元可能な形で扱う

セットアップが `EXISTING_INSTALLATION` で停止した場合は、上書きしないでください。次のプロンプトを Codex に貼り付けます。

```text
既存の visual-first-ppt がある可能性があります。読み取り専用で確認し、正確な対象が Skill-only と Plugin のどちらかを特定してください。似た名前のプロジェクトデータ用ディレクトリと混同してはいけません。実際のインストールが見つからない場合は EXISTING_INSTALLATION_NOT_FOUND を報告し、確認した場所と候補バージョン v0.3.0 を示して、正確なパスの提示または新規インストールの選択を求めてください。この場合はアップグレード承認を求めないでください。
Skill-only リカバリー：これはセットアップまたはアップグレードの作業であり、PPT 制作ではありません。インストール済みの $visual-first-ppt ワークフローを呼び出してはいけません。${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt を最初に確認し、ユーザーが明示的に指定した場合にだけ別の絶対 Skill パスを確認してください。codex 実行ファイルを起動したり、ホームディレクトリを無制限に検索したりしてはいけません。認証ファイルを読み取ってはいけません。無関係な環境を列挙してはいけません。正確な Skill 対象と固定された v0.3.0 を読み取り専用でバージョンまたは内容比較し、差分と正確なパスを提示して、パスを特定した UPGRADE_APPROVED の判断まで停止してください。承認後のみ、既存 Skill をタイムスタンプ付き同階層バックアップへ移動し、新しい対象へインストールして doctor と明示的な $visual-first-ppt 起動確認を行います。インストールまたは検証に失敗した場合は ROLLBACK を実行してバックアップを復元してください。既存コピーをマージまたは再帰削除してはいけません。
Plugin リカバリー：現在のホストが直接提供する Plugin 管理機能だけを使用してください。実行中のタスク内から codex plugin コマンドを実行してはいけません。Codex がサポートする Plugin の管理、更新、ロールバック機能だけを使用してください。Plugin 管理下のストレージを推測、移動、名前変更、再帰削除してはいけません。サポート対象で復元可能な更新またはロールバック経路を特定できない場合は、停止してブロッカーを説明し、`UPGRADE_APPROVED` を要求または使用してはいけません。
```

### 5. 最初の資料制作を開始する

`Presentations` または `imagegen` が不足している、あるいは未検証の場合、利用可能であるかのように扱ったり最終ファイルを宣言したりせず、まず正確な再開地点を次の形式で示します。

<!-- BEGIN CAPABILITY_RECOVERY_RESPONSE -->
- `capability_status`：`BLOCKED_CAPABILITY`。
- `missing_capabilities`：`Presentations` と `imagegen` のうち不足または未検証の項目を正確に列挙します。
- `resume_after_capabilities_ready`：現在のホストで両方の機能が公開・検証された後、新しい Codex タスクを開始し `$visual-first-ppt` を明示的に呼び出します。
- `resume_without_manifest`：`ROUTE_SELECTION_OR_BRIEF`。`create`、`template`、`edit` から選択し、Brief から続行します。
- `resume_with_manifest`：`project-manifest.json` または提示された project ID を検証し、記録済みの `RECORDED_GATE` からのみ再開します。
<!-- END CAPABILITY_RECOVERY_RESPONSE -->

Skill のインストールと検証が完了した次のターンで、明示的に呼び出してください。検出されない場合は、新しい Codex タスクを開始します。その後、次のプロンプトで始めてください。

```text
$visual-first-ppt を使ってください。最初に create、template、edit の三つから一つのルートを選ばせ、完全な制作に入る前に必要な承認ゲートに従ってください。
```

最初の応答がルート選択と承認条件までで止まるのは正常な設計であり、タスクが停止したわけではありません。
<!-- END NEWBIE_QUICK_START -->

`visual-first-ppt` は、承認ゲートを備えたビジュアルファーストのワークフローでプレゼンテーション資料を制作するための Codex Skill です。資料をゼロから作成するほか、既存のテンプレートや構成案に沿った制作、既存の PPTX に対する範囲を限定した修正にも対応します。

生成画像は、雰囲気づくり、場面表現、視覚的な補助に使用します。一方、重要なテキスト、正確な数値、表、グラフ、出典、承認記録は、PowerPoint のネイティブ要素として編集可能な状態を保ちます。成果物は、見栄えのよいファイルだけではありません。明示的な承認、QA の証跡、永続的な引き渡し先を含む、レビュー可能な納品パッケージです。

> コミュニティプロジェクトです。このリポジトリは OpenAI の公式製品ではありません。

## この Skill を使う理由

プレゼンテーション制作では、編集はできても見た目が画一的になるか、洗練されていても画像化されているため検証や修正が難しくなるかの、どちらかに陥りがちです。この Skill は、次のように両方のレイヤーを組み合わせます。

- ビジュアルの方向性や説明用の場面には画像生成を使用する。
- 事実に関わる内容や変更の可能性が高い内容には、PowerPoint のネイティブ要素を使用する。
- コストの高い作業へ進む前に、明示的な承認ゲートを設ける。
- 修正、パッケージング、最終引き渡しに対して、再現性のあるチェックを行う。
- ユーザーが資料を持っていない場合は公開 Web 情報を調査し、出典と推論を分けて扱う。

ユーザーがテンプレートを用意していない場合は、対象者とテーマに合うデザインの方向性を提案し、スライド制作を始める前に一つに絞り込みます。

## 対応ルート

| ルート | 適したケース | 必須のユーザー承認ゲート |
| --- | --- | --- |
| `create` | 資料をゼロから作成する | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `template` | 既存の PPTX、テーマ、または構成案に沿って制作する | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `edit` | 許可された範囲内で既存の PPTX を修正する | `[SCOPE_APPROVED]` → 変更プレビュー → `[FINAL_APPROVED]` |

この Skill は、「そのまま進めて」という指示、ユーザーから返答がない状態、ファイルがアップロードされたという事実のいずれも、承認ゲートを省略する許可とはみなしません。

## ワークフロー

1. **ルートを選択する。** Codex は、内容の確認や制作に入る前に、`create`、`template`、`edit` のいずれかを確認します。
2. **入力を収集する。** `template` と `edit` では、ユーザーが元の PPTX と利用可能な資料を提供します。`create` では、対象者、目的、重点、分量、制約を Codex が確認します。
3. **責任を持って調査する。** ユーザー提供資料を優先します。情報が不足している場合、Codex は公開情報を調査し、出典を記録し、情報の不一致を明示し、根拠のない主張を避けます。
4. **構成とビジュアルの方向性を承認する。** ユーザーはアウトラインを確認し、該当する場合は本制作前にビジュアルシステムを確定します。`edit` プロジェクトでは、最初に修正を許可するスライドの範囲を確定します。
5. **制作して確認する。** すべてのスライドをレンダリングします。重要な内容はネイティブ要素のまま維持し、生成ビジュアルは定義済みのセーフゾーン内に配置します。`edit` プロジェクトで修正を許可されていないスライドには、PNG と XML の比較証跡を作成します。
6. **検証して納品する。** 自動 QA、フルサイズでのスライド確認、対象クライアントでのスモークテストまたはユーザーによる表示確認、最終承認、再現性のあるパッケージング、永続パスの検証を、それぞれ独立した工程として実施します。

## 主な安全策

- 現行の Codex `Presentations` ワークフローと `@oai/artifact-tool` を使用し、`python-pptx` は使用しません。
- ビジュアルレイヤーには `imagegen` を使用しますが、事実に関わるテキストや正確なデータの最終的な情報源にはしません。
- 元の資料を保持し、範囲を限定した修正では新しい出力ファイルを作成します。
- ユーザーが、文書化された機能低下を伴う代替対応を明示的に承認しない限り、未対応またはリスクの高い互換性変更を停止します。
- 最終ファイルが指定された出力先ルートの外部、または OS やツールが管理する一時、キャッシュ、スクラッチのパスにある場合は受け付けません。
- 編集可能な PPTX 1 ファイル、PDF 1 ファイル、プレビュー、制作記録、再現性のある ZIP のみをパッケージ化します。

### ビジュアル品質ゲート

- ネイティブテキストは編集可能なまま維持し、生成画像は雰囲気や場面表現に使い、事実テキストや正確なデータを埋め込みません。
- 情報量の多いページは分割される場合があり、承認済み内容を小さくしたり切り落としたりせず、意味のまとまりごとに分けます。
- フォントフォールバックは納品をブロックします。検証済みの代替フォントを選び、ビジュアルサンプルを再承認する必要があります。
- `template` と `edit` の保持対象ページは、新規ページの規則に合わせて再整形せず、互換性と未変更の証跡で確認します。
- legacy プロジェクトは読み取り可能ですが、移行が完了するまで再ビルド、新しい QA 証跡の生成、再パッケージ化、再納品はできません。

## 必要条件

- 現行の `Presentations` と `imagegen` の Skill または機能を利用できる Codex 環境。
- プロジェクト状態管理と QA スクリプトのための Node.js 20 以降。
- 比較、パッケージング、引き渡し検証のための Python 3.10 以降。
- 開発時の公式 Skill 検証に限り `PyYAML==6.0.2`。

このリポジトリには、Codex、PowerPoint、WPS、LibreOffice、`Presentations`、`imagegen`、`@oai/artifact-tool` は含まれていません。

## インストール

再現可能な方法でインストールするには、公開済みのリリースタグをクローンし、配布対象の Skill ディレクトリだけをコピーします。

```bash
git clone --branch v0.3.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
node "$DEST/scripts/doctor.mjs" --skill-root "$DEST" --json
```

`test ! -e` のガードにより、既存の Skill を誤って置き換えることを防ぎます。上記の最後のコマンドは、リポジトリのコピーではなく `$DEST` のインストール済みコピーに対して doctor を実行します。クイックスタートの手順 3 に従って `PASS`、`WARN`、`FAIL` を解釈し、起動確認を完了してください。両方の証拠がそろうまで `SETUP_VERIFIED` と記録してはいけません。コピー後の次の Codex ターンで、まず `$visual-first-ppt` を明示的に呼び出してください。検出されない場合にだけ新しい Codex タスクを開始し、もう一度明示的に呼び出します。

## リクエスト例

```text
Codex、職業教育機関の校長向けに、AI 教育パイロットの提案資料をゼロから作成してください。

アップロードした PPT テンプレートとコンテンツ構成案を使って、12 枚のソリューション資料を作成してください。

既存の PPT は 4 枚目と 7 枚目だけを変更してください。それ以外のスライドは変更せず、比較証跡も提示してください。
```

最初の応答は、意図的にルート選択と該当する承認条件の提示までで停止します。

## 最終引き渡し条件

制作とレンダリングではスクラッチディレクトリを使用できます。最終応答の前に、承認済みの PPTX、PDF、ZIP を現在のワークスペース配下の永続ディレクトリ、またはユーザーが指定した出力先へコピーし、次を実行します。

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root /persistent/output \
  /persistent/output/deck.pptx \
  /persistent/output/deck.pdf \
  /persistent/output/deck-delivery.zip
```

検証済みの永続コピーだけをユーザーへリンクします。`DELIVERED` への遷移では、承認済み PPTX と出力先ルートも関連付ける必要があります。

```bash
node skills/visual-first-ppt/scripts/project-state.mjs transition \
  WORKSPACE DELIVERED APPROVED_PPTX_HASH \
  /persistent/output /persistent/output/deck.pptx
```

## ローカル検証

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

## 検証結果

- リポジトリに含まれる Node と Python のテストスイートは、実行可能なリリース証拠です。リリース検証ではすべてのテストが合格する必要があり、各実行が正確な現在数を報告するため、README に古くなる固定総数を残しません。
- 15/15 の RED プレッシャーサンプルでは、この Skill を使用しない場合、各サンプルで少なくとも 1 つの必須条件が欠落しました。
- 15/15 の GREEN 動作テストに合格し、75/75 の必須項目を満たし、30/30 の禁止動作が発生しないことを確認しました。
- 合成データによる `create`、厳格な `template`、範囲を限定した `edit` の各ルートは、QA PASS で `DELIVERED` に到達しました。要約結果とハッシュは [`tests/artifacts/artifact-summary.json`](tests/artifacts/artifact-summary.json) にあります。
- 3 つの合成フィクスチャはすべて、LibreOffice Impress のヘッドレスインポート／エクスポートのスモークテストに合格しました。これは、Microsoft PowerPoint の GUI 検証を主張するものではありません。
- このワークフローで作成した別の教育向け 10 スライドのパイロット資料は、2026-07-14 にユーザーが PowerPoint/WPS で開き、異常は報告されませんでした。この顧客向け資料は本リポジトリには含まれていません。

動作検証の要約記録は [`tests/baseline/summary.json`](tests/baseline/summary.json) と [`tests/green/summary.json`](tests/green/summary.json) に保持されています。実行ログの原本、顧客資料、生成された資料ファイルは公開リポジトリの外部に保持し、今後のテストで再利用できる補助スクリプトは `tests/artifacts/support/` 配下に残しています。

## 制限事項

- テンプレートの再現度は元資料の互換性に左右されるため、想定ではなく証跡によって確認する必要があります。
- アニメーション、SmartArt、OLE オブジェクト、リンクメディア、複雑なマスター、未インストールのフォント、全体的なテーマ変更は、編集を停止させる場合や、明示的な劣化承認を必要とする場合があります。
- ラスター PDF は見た目を維持できますが、テキストの検索や編集はできません。制作記録には PDF の種類を明記する必要があります。
- 最終的な互換性は、実際の利用先クライアント、利用可能なフォント、環境にも依存します。
- 生成された場面は説明用のビジュアルであり、実在する学校、顧客、完了済みプロジェクトの証拠として提示してはなりません。

## リポジトリ構成

- `skills/visual-first-ppt/` — 配布対象の Skill。
- `tests/unit/` — 再現性のある Node および Python テスト。
- `tests/fixtures/` — 小規模で中立的な PPTX とテキストのフィクスチャ。
- `tests/scenarios/` — RED/GREEN シナリオの定義とプロンプト用ツール。
- `tests/artifacts/support/` — 3 ルートの今後のテストで再利用できる補助スクリプト。生成物はローカルに保持します。
- `tests/*/summary.json` — 保持対象の要約証跡。容量の大きい生成物はローカルに保持します。

## リリースとライセンス

- 現在のリリース：[`v0.3.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.3.0)
- リリース履歴：[`CHANGELOG.md`](CHANGELOG.md)
- ライセンス：MIT — [`LICENSE`](LICENSE) を参照してください
