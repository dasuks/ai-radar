# AI Coding Radar

해외의 최신 AI 코딩, 바이브코딩, agentic coding 정보를 실무 지식으로 정리하는 개인용 파이프라인입니다. 최종적으로 한국어 Daily Brief를 날짜별로 보관하고, 오래 쓸 수 있는 개념과 패턴을 Obsidian 지식과 연결하는 것을 목표로 합니다.

## 현재 범위 (Phase 1–3)

Phase 1은 수동으로 작성한 `data/daily-brief.json`을 표준 스키마로 검증하고, Obsidian용 Markdown으로 변환해 Vault의 `99 Daily` 폴더에 저장합니다. 같은 이름의 노트가 있으면 동일한 경로에서 내용을 갱신하며, 버전 이력과 복구는 Git이 담당합니다.

Phase 2는 같은 briefing을 Notion의 `AI Coding Daily` 데이터베이스에도 저장합니다. `Date`로 기존 페이지를 찾아 없으면 생성하고, 있으면 속성과 본문을 갱신합니다. 기존 페이지의 `Read`와 `Applied` 값은 유지합니다.

Phase 3는 deterministic rule 기반 Obsidian Librarian입니다. topic의 type에 따라 Knowledge Note를 만들거나 기존 노트를 갱신하고, 날짜별 Evidence와 Daily Note의 `Knowledge Updates` 양방향 링크를 관리합니다.

Reddit, Hacker News, GitHub 및 웹 수집, LLM 호출, semantic similarity, embedding, GitHub Actions는 아직 포함하지 않습니다.

## 폴더 구조

```text
src/
  config/paths.ts              입력 및 Obsidian 경로 설정
  schemas/briefing.ts          타입, 기본값, 런타임 검증
  loaders/briefing-loader.ts   JSON 파일 읽기
  formatters/daily-markdown.ts Markdown 생성
  librarian/topic-extractor.ts 추출기 인터페이스
  librarian/rule-based-extractor.ts 현재 rule 기반 추출기
  librarian/obsidian-librarian.ts Knowledge Note 검색 및 갱신
  writers/obsidian-writer.ts   Vault 경계 확인 및 저장
  writers/notion-writer.ts     Notion 날짜 기준 upsert 및 본문 생성
  run-daily.ts                 실행 진입점
data/
  daily-brief.json             수동 입력 예시
test/
  briefing.test.ts             Phase 1 핵심 동작 테스트
```

## 실행 방법

Node.js 18 이상이 필요합니다.

```powershell
npm install
npm run daily
```

입력 파일은 `data/daily-brief.json`입니다. 한 번 실행하면 Obsidian Daily Note, Notion, Obsidian Librarian 순서로 처리합니다. Obsidian의 기본 출력은 다음과 같습니다.

```text
C:\dev\knowledge\ai-knowledge\99 Daily\2026-09-12 AI Coding Daily Brief.md
```

검증과 테스트는 다음 명령으로 실행합니다.

```powershell
npm run typecheck
npm test
```

## Obsidian Vault 경로 설정

기본 Vault 경로는 `src/config/paths.ts`의 `DEFAULT_OBSIDIAN_VAULT`에서 한 번만 정의합니다. 다른 환경에서는 코드를 바꾸지 않고 `OBSIDIAN_VAULT_PATH` 환경 변수로 재정의할 수 있습니다.

```powershell
$env:OBSIDIAN_VAULT_PATH = "D:\Knowledge\ai-knowledge"
npm run daily
```

writer는 계산된 저장 경로가 설정한 Vault 안에 있는지 확인하며, Vault 밖으로 나가는 경로는 거부합니다.

## Notion 설정

프로젝트 루트의 `.env`에 다음 변수를 설정합니다. `.env`는 Git에서 제외됩니다.

```dotenv
NOTION_TOKEN=your_integration_token
NOTION_DATABASE_ID=your_database_id
OBSIDIAN_VAULT_PATH=C:\dev\knowledge\ai-knowledge
```

Integration에는 대상 데이터베이스의 읽기, 삽입, 수정 권한이 필요합니다. 데이터베이스 속성은 다음 이름과 타입을 사용합니다.

| 속성 | 타입 | 동작 |
| --- | --- | --- |
| Name | Title | briefing 제목 |
| Date | Date | briefing 날짜 및 upsert 기준 |
| Topics | Multi-select | topic 제목 목록 |
| Importance | Number | topic 중요도의 최댓값 |
| Read | Checkbox | 새 페이지에서만 `false`로 초기화 |
| Applied | Checkbox | 새 페이지에서만 `false`로 초기화 |

본문 텍스트는 Notion 제한에 맞춰 나누고, 블록은 요청당 최대 100개씩 순차적으로 저장합니다. 기존 페이지를 갱신할 때 본문은 현재 briefing 내용으로 교체됩니다.

## Obsidian Librarian

Librarian은 topic type을 다음 폴더에 매핑합니다.

| topic type | 폴더 |
| --- | --- |
| `concept` | `01 Concepts` |
| `pattern` | `02 Patterns` |
| `workflow` | `03 Workflows` |
| `tool` | `04 Tools` |
| `architecture` | `05 Architecture` |
| `research` | `06 Research` |
| 그 외 | `00 Inbox` |

기존 노트는 H1 제목과 파일명을 기준으로 검색합니다. 비교할 때 대소문자, 앞뒤 공백, 하이픈, underscore, 연속 공백을 정규화합니다. 동일한 날짜의 Evidence는 한 번만 유지하고, Daily Note에는 해당 topic과 related 항목을 `Knowledge Updates` 위키 링크로 기록합니다. 파일명 충돌이 있으면 기존 파일을 덮어쓰지 않고 숫자 suffix가 붙은 새 경로를 사용합니다. 별도 백업 Markdown은 생성하지 않으며 복구와 버전 이력은 Git이 담당합니다.

현재 `RuleBasedTopicExtractor`는 canonical briefing의 topic을 그대로 전달합니다. 이후 Phase에서 이 인터페이스 구현만 교체해 LLM 기반 선별을 추가할 수 있습니다.

## 다음 Phase 예정 범위

후속 단계에서는 해외 소스 수집, 실무 가치 선별, 한국어 요약, LLM 기반 지식 추출과 기존 개념의 의미 기반 연결을 순차적으로 추가할 예정입니다.
