<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

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

## 必要条件

- 現行の `Presentations` と `imagegen` の Skill または機能を利用できる Codex 環境。
- プロジェクト状態管理と QA スクリプトのための Node.js 20 以降。
- 比較、パッケージング、引き渡し検証のための Python 3.10 以降。
- 開発時の公式 Skill 検証に限り `PyYAML==6.0.2`。

このリポジトリには、Codex、PowerPoint、WPS、LibreOffice、`Presentations`、`imagegen`、`@oai/artifact-tool` は含まれていません。

## インストール

再現可能な方法でインストールするには、公開済みのリリースタグをクローンし、配布対象の Skill ディレクトリだけをコピーします。

```bash
git clone --branch v0.1.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

`test ! -e` のガードにより、既存の Skill を誤って置き換えることを防ぎます。インストール後は、新しい Codex タスクを開始して Skill が正しく検出されるようにしてください。

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

- 59/59 のユニットテストに合格：38 Node、21 Python。ローカライズ、永続ルート、公開証跡の境界に関するテストを含みます。
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

- 現在のリリース：[`v0.1.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.1.0)
- リリース履歴：[`CHANGELOG.md`](CHANGELOG.md)
- ライセンス：MIT — [`LICENSE`](LICENSE) を参照してください
