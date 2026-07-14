<!-- README_LANGUAGES: en | zh-CN | ja | ko -->

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Visual-First PPT

`visual-first-ppt`는 단계별 승인 절차와 비주얼 우선 워크플로를 통해 프레젠테이션 덱을 제작하는 Codex Skill입니다. 처음부터 덱을 만들거나, 기존 템플릿 또는 프레임워크를 따르거나, 기존 PPTX를 승인된 범위 안에서 수정할 수 있습니다.

생성 이미지는 분위기, 장면, 시각적 보조 요소를 담당합니다. 핵심 텍스트, 정확한 수치, 표, 차트, 인용, 승인 근거는 PowerPoint 네이티브 객체로 유지되어 편집할 수 있습니다. 결과물은 단순히 보기 좋은 파일에 그치지 않습니다. 명시적 승인, QA 근거, 영구 보관 가능한 인계 경로를 갖춘 검토 가능한 납품 패키지입니다.

> 커뮤니티 프로젝트입니다. 이 저장소는 OpenAI의 공식 제품이 아닙니다.

## 이 Skill을 사용하는 이유

프레젠테이션 작업은 대개 두 가지 문제 중 하나에 부딪힙니다. 편집은 가능하지만 시각적으로 평범하거나, 완성도는 높아 보여도 이미지로 평면화되어 검증과 수정이 어렵습니다. 이 Skill은 두 계층을 결합합니다.

- 시각적 방향과 설명용 장면을 위한 이미지 생성
- 사실 정보나 변경 가능성이 있는 콘텐츠를 위한 PowerPoint 네이티브 객체
- 비용이 큰 작업을 계속하기 전의 명시적 승인 단계
- 수정, 패키징, 최종 인계를 위한 결정론적 검사
- 사용자에게 원본 자료가 없을 때 수행하는 공개 웹 조사와 출처·추론의 명확한 구분

사용자에게 템플릿이 없으면, 이 Skill은 대상 청중과 주제에 맞는 테마 방향을 제안하고 슬라이드 제작 전에 하나를 확정합니다.

## 지원 경로

| 경로 | 사용 시점 | 필요한 사용자 승인 단계 |
| --- | --- | --- |
| `create` | 처음부터 덱을 제작할 때 | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `template` | 기존 PPTX, 테마 또는 콘텐츠 프레임워크를 따를 때 | `[OUTLINE_APPROVED]` → `[VISUAL_LOCKED]` → `[FINAL_APPROVED]` |
| `edit` | 승인된 범위 안에서 기존 PPTX를 변경할 때 | `[SCOPE_APPROVED]` → 변경 미리보기 → `[FINAL_APPROVED]` |

이 Skill은 “그냥 진행해 주세요”라는 말, 사용자의 침묵, 파일 업로드를 이러한 승인 단계를 건너뛰어도 된다는 허가로 해석하지 않습니다.

## 워크플로 진행 방식

1. **경로를 선택합니다.** Codex는 콘텐츠를 검토하거나 제작하기 전에 `create`, `template`, `edit` 중 하나를 확인합니다.
2. **입력 자료를 수집합니다.** `template`과 `edit`에서는 사용자가 원본 PPTX와 보유 자료를 제공합니다. `create`에서는 Codex가 대상 청중, 목표, 강조점, 분량, 제약 조건을 확인합니다.
3. **책임 있게 조사합니다.** 사용자 자료를 우선합니다. 자료가 충분하지 않으면 Codex가 공개 출처를 조사하고, 출처 이력을 기록하며, 상충되는 내용을 드러내고, 근거 없는 주장을 피할 수 있습니다.
4. **구조와 시각적 방향을 승인합니다.** 사용자는 전체 제작 전에 개요를 검토하고, 해당하는 경우 시각 시스템을 확정합니다. `edit` 프로젝트는 먼저 수정이 허용된 슬라이드 범위를 확정합니다.
5. **제작하고 검토합니다.** 모든 슬라이드를 렌더링합니다. 핵심 콘텐츠는 PowerPoint 네이티브 객체로 유지하고, 생성 이미지는 선언된 안전 영역 안에 배치합니다. `edit` 프로젝트에서 수정이 승인되지 않은 슬라이드에는 PNG 및 XML 비교 근거를 제공합니다.
6. **검증하고 납품합니다.** 자동 QA, 전체 크기 슬라이드 검토, 대상 클라이언트 스모크 테스트 또는 사용자의 파일 열기 확인, 최종 승인, 결정론적 패키징, 영구 보관 경로 검증은 각각 별도의 단계입니다.

## 핵심 보호 장치

- 현재 Codex의 `Presentations` 워크플로와 `@oai/artifact-tool`을 사용하며, `python-pptx`는 사용하지 않습니다.
- 시각 계층에는 `imagegen`을 사용하지만, 사실 기반 텍스트나 정확한 데이터의 최종 원본으로는 사용하지 않습니다.
- 입력 덱을 보존하고, 범위가 제한된 수정 결과는 새 출력 파일로 작성합니다.
- 사용자가 문서화된 품질 저하를 명시적으로 승인하지 않는 한, 지원되지 않거나 위험한 호환성 변경을 차단합니다.
- 선언된 대상 루트 밖에 있거나 운영체제 및 도구가 관리하는 임시, 캐시, 스크래치 경로 안에 있는 최종 파일을 거부합니다.
- 편집 가능한 PPTX 1개, PDF 1개, 미리보기, 제작 기록, 결정론적 ZIP을 정확히 하나의 패키지로 구성합니다.

## 요구 사항

- 현재 `Presentations` 및 `imagegen` Skill 또는 기능을 사용할 수 있는 Codex 환경
- 프로젝트 상태 및 QA 스크립트 실행을 위한 Node.js 20 이상
- 비교, 패키징, 인계 검증을 위한 Python 3.10 이상
- 개발 시 공식 Skill 검증에만 필요한 `PyYAML==6.0.2`

이 저장소에는 Codex, PowerPoint, WPS, LibreOffice, `Presentations`, `imagegen`, `@oai/artifact-tool`이 포함되어 있지 않습니다.

## 설치

재현 가능한 설치를 위해 공개된 릴리스 태그를 클론한 뒤, 배포 가능한 Skill 디렉터리만 복사합니다.

```bash
git clone --branch v0.1.0 --depth 1 \
  https://github.com/banqiusheng/visual-first-ppt.git
cd visual-first-ppt

DEST="${CODEX_HOME:-$HOME/.codex}/skills/visual-first-ppt"
test ! -e "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R skills/visual-first-ppt "$DEST"
```

`test ! -e` 보호 절차는 기존 Skill을 실수로 덮어쓰는 일을 방지합니다. 설치 후 새 Codex 작업을 시작해야 Skill이 정상적으로 감지됩니다.

## 요청 예시

```text
Codex, 전문대학 총장을 대상으로 한 AI 교육 파일럿 제안서를 처음부터 만들어 주세요.

제가 업로드한 PPT 템플릿과 콘텐츠 프레임워크를 사용해 12장 분량의 솔루션 덱을 만들어 주세요.

기존 PPT에서 4번과 7번 슬라이드만 변경해 주세요. 다른 모든 슬라이드는 그대로 유지하고 비교 근거를 제공해 주세요.
```

첫 번째 응답은 의도적으로 경로 선택과 해당 승인 조건 안내까지만 진행한 뒤 멈춥니다.

## 최종 인계 계약

제작 및 렌더링 작업에는 스크래치 디렉터리를 사용할 수 있습니다. 최종 응답 전에 승인된 PPTX, PDF, ZIP을 현재 워크스페이스 아래의 영구 보관 디렉터리나 사용자가 선택한 대상 경로로 복사한 뒤 다음 명령을 실행합니다.

```bash
python3 skills/visual-first-ppt/scripts/verify_handoff_paths.py \
  --persistent-root /persistent/output \
  /persistent/output/deck.pptx \
  /persistent/output/deck.pdf \
  /persistent/output/deck-delivery.zip
```

검증된 영구 보관 위치의 복사본만 사용자에게 링크해야 합니다. `DELIVERED` 전환에는 승인된 PPTX와 대상 루트도 연결해야 합니다.

```bash
node skills/visual-first-ppt/scripts/project-state.mjs transition \
  WORKSPACE DELIVERED APPROVED_PPTX_HASH \
  /persistent/output /persistent/output/deck.pptx
```

## 로컬 검증

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

## 검증 근거

- 59/59 단위 테스트 통과: Node 38개, Python 21개. 현지화, 영구 보관 루트, 공개 근거 경계 검사를 포함합니다.
- 15/15 RED 압박 샘플에서 Skill 없이 실행했을 때 각각 하나 이상의 필수 계약 항목이 누락되었습니다.
- 15/15 GREEN 동작 실행이 통과했으며, 필수 항목 75/75가 통과하고 금지 동작 30/30이 발생하지 않았습니다.
- 합성 `create`, 엄격한 `template`, 범위가 제한된 `edit` 경로가 QA PASS 상태로 `DELIVERED`에 도달했습니다. 요약 결과와 해시는 [`tests/artifacts/artifact-summary.json`](tests/artifacts/artifact-summary.json)에 있습니다.
- 세 합성 픽스처 모두 LibreOffice Impress 헤드리스 가져오기/내보내기 스모크 테스트를 통과했습니다. 이는 Microsoft PowerPoint GUI 검증을 주장하는 것이 아닙니다.
- 이 워크플로로 별도 제작한 교육 고객 대상 10장 분량의 파일럿은 사용자가 2026-07-14에 PowerPoint/WPS에서 열었으며, 보고된 이상은 없었습니다. 해당 고객용 덱은 이 저장소에 포함되어 있지 않습니다.

간결한 동작 기록은 [`tests/baseline/summary.json`](tests/baseline/summary.json)과 [`tests/green/summary.json`](tests/green/summary.json)에 보관됩니다. 원시 실행 로그, 고객 자료, 생성된 덱 산출물은 공개 저장소 외부에 유지되며, 재사용 가능한 향후 테스트 지원 스크립트는 `tests/artifacts/support/` 아래에 유지됩니다.

## 제한 사항

- 템플릿 충실도는 원본 덱의 호환성에 따라 달라지며, 추정하지 않고 근거로 입증해야 합니다.
- 애니메이션, SmartArt, OLE 객체, 연결된 미디어, 복잡한 마스터, 누락된 글꼴, 전역 테마 변경으로 인해 편집이 차단되거나 명시적인 품질 저하 승인이 필요할 수 있습니다.
- 래스터 PDF는 외형은 보존하지만 텍스트 검색이나 편집은 지원하지 않습니다. 제작 기록에 PDF 유형을 공개해야 합니다.
- 최종 호환성은 실제 대상 클라이언트, 글꼴 가용성, 환경에 따라 달라집니다.
- 생성된 장면은 설명용 시각 자료이며, 실제 학교, 고객 또는 완료된 프로젝트의 증거로 제시해서는 안 됩니다.

## 저장소 구조

- `skills/visual-first-ppt/` — 배포 가능한 Skill
- `tests/unit/` — 결정론적 Node 및 Python 테스트
- `tests/fixtures/` — 소규모 중립 PPTX 및 텍스트 픽스처
- `tests/scenarios/` — RED/GREEN 시나리오 정의 및 프롬프트 도구
- `tests/artifacts/support/` — 세 가지 경로의 향후 테스트에 재사용할 수 있는 지원 스크립트. 생성된 출력은 로컬에 유지됩니다.
- `tests/*/summary.json` — 보관되는 간결한 근거. 대용량 생성 산출물은 로컬에 유지됩니다.

## 릴리스 및 라이선스

- 현재 릴리스: [`v0.1.0`](https://github.com/banqiusheng/visual-first-ppt/releases/tag/v0.1.0)
- 릴리스 기록: [`CHANGELOG.md`](CHANGELOG.md)
- 라이선스: MIT — [`LICENSE`](LICENSE) 참조
