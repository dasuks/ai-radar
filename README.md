# AI Radar

AI/LLM/AI Coding 생태계를 지속적으로 관측하고, 수집된 사실과 커뮤니티 반응을 근거와 함께 저장하고, 목적에 따라 분석해 학습·지식 축적·트렌드 관찰·콘텐츠 제작에 재사용하는 개인용 AI Intelligence Platform입니다. 매일의 산출물은 **AI Intelligence Daily** 이며 Notion(읽기·보관)과 Obsidian(장기 지식)으로 전달됩니다.

목표 아키텍처와 이행 계획은 [`docs/architecture/`](docs/architecture/README.md) 에 있고, 주요 결정은 [`docs/adr/`](docs/adr/README.md) 에 기록되어 있습니다. 에이전트 작업 규칙은 [`AGENTS.md`](AGENTS.md) 를 따릅니다.

> 이 프로젝트의 이전 이름은 AI Coding Radar(`ai-coding-radar`)입니다. Obsidian 노트의 레거시 마커(`<!-- ai-coding-radar:… -->`)와 Notion Integration 표시명에는 이전 이름이 남아 있으며, 호환을 위해 의도적으로 유지합니다. 자세한 기준은 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §3 을 참고하세요.

## 현재 구현 범위

현재 코드는 목표 아키텍처의 **Phase 1(Artifact·Publish 경계와 사용자 데이터 안전)** 까지 구현되어 있습니다. 동작하는 경로는 다음과 같습니다.

1. 수동으로 작성한 Daily Brief JSON(`--input`)을 읽어 v1 이면 `DailyBriefBody` v2 로 upcast 하고, `Artifact<DailyBriefBody>` 로 저장합니다(revision, contentHash, visibility PRIVATE).
2. 같은 Artifact 를 Notion 과 Obsidian 두 채널로 발행합니다. 채널은 서로 격리되어 있어 한쪽이 실패해도 다른 쪽과 Librarian 은 계속 진행합니다. 발행 결과는 `PublicationRecord` 로 남고, 같은 revision 이 이미 성공했으면 다시 발행하지 않습니다.
3. Notion 은 `Date` 로 기존 페이지를 찾아 없으면 생성하고 있으면 갱신합니다. 갱신 요청에는 `Read` 와 `Applied` 를 넣지 않습니다. 본문 맨 앞에는 `ai-radar:revision:<n>` callout 을 넣어 부분 실패를 사람이 식별할 수 있게 합니다.
4. Obsidian Daily Note 는 날짜 접두로 찾고, `ai-radar:daily` 관리 영역만 교체합니다. 관리 영역 밖 사용자 텍스트는 건드리지 않습니다.
5. Deterministic Librarian 이 `knowledgeType` 이 있고 중요도 4 이상인 item 을 Knowledge Note 로 만들거나 갱신하고, 날짜별 Evidence 블록과 Daily Note 의 `Knowledge Updates` 양방향 링크를 관리합니다.
6. 실행 하나가 하나의 `Run` 이며 단계마다 `data/store/runs/` 에 기록됩니다. Run 상태는 `PIPELINES_AND_POLICIES.md` §4 의 판정식을 따릅니다.

소스 수집, LLM 호출, Entity/Metric/Trend, 승인·공개 게시는 아직 Daily 경로에 연결되어 있지 않습니다. 각 기능의 도입 Phase는 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §4 에 있습니다.

## 폴더 구조 (현재)

```text
src/
  domain/        Canonical 계약과 순수 규칙 (Artifact, DailyBriefBody v2, Run, 마커, ID/hash)
  policies/      Ranking / Classification 정책 (순수 함수)
  application/   Use Case
    publish/     PublishArtifact (승인·idempotency·사용자 필드 보존)
    librarian/   RunLibrarian (Knowledge Note 생성·갱신, Evidence, 양방향 링크)
    runs/        RunDailyPipeline (단계 orchestration, 채널 실패 격리, Run 상태 판정)
  ports/         Application 이 요구하는 interface (storage, publishing, sources, llm, system)
  adapters/      Port 구현
    notion/      NotionPublisher (Date 기준 upsert, Read/Applied 보존)
    obsidian/    ObsidianVault(VaultPort), ObsidianDailyPublisher (관리 영역만 교체)
    rendering/   markdown/ (Daily Note 본문), notion-blocks/ (Notion 블록)
    storage/     json-files/ (Artifact·Run 기록), fs/, memory/, sqlite/
    sources/     hackernews/, rss/
    system/      SystemClock, ConsoleLogger, FetchHttpClient, LogEventSink, NodeRandom
  runtime/
    config/      env + config/sources.json -> AppConfig (유일한 process.env 접근 지점)
    composition/ buildDailyPipeline (조립)
    runs/        Run lifecycle 기록 (단계마다 flush)
    cli/daily.ts `npm run daily` 진입점
config/
  sources.json   RSS/Atom 피드 목록
data/
  input/daily-brief.sample.json  수동 입력 예시 (--input 으로만 사용)
  store/         Run·Artifact·Publication 기록 (gitignore)
test/
  daily-brief-input.test.ts      v1 파싱 + v2 upcast
  markdown-renderer.test.ts      Daily Note Markdown 렌더
  notion-publisher.test.ts       Notion upsert (fake client)
  obsidian-daily-publisher.test.ts  Daily Note 관리 영역
  librarian.test.ts              Knowledge Note / Evidence / 레거시 마커
  publish-artifact.test.ts       발행 Use Case
  run-daily-pipeline.test.ts     채널 실패 격리와 Run 상태
  architecture.test.ts           계층 의존성 규칙
docs/
  architecture/                목표 아키텍처, 계약, 파이프라인, 안전, 이행 계획
  adr/                         Architecture Decision Records
```

## 실행 방법

Node.js 24 이상이 필요합니다 (Phase 2부터 내장 `node:sqlite` 를 사용합니다).

```powershell
npm install
npm run daily -- --input data/input/daily-brief.sample.json
```

`npm run daily` 는 `src/runtime/cli/daily.ts` 를 실행합니다. 플래그는 다음과 같습니다.

| 플래그 | 뜻 |
| --- | --- |
| `--date YYYY-MM-DD` | 대상 날짜. 기본값은 설정 timezone(`AI_RADAR_TIMEZONE`, 기본 `Asia/Seoul`) 기준 오늘 |
| `--input <file>` | 수동 Daily Brief JSON. v1(`topics[]`) 과 v2(`bodySchemaVersion: 2`) 를 모두 받습니다 |
| `--dry-run` | 아무것도 쓰지 않습니다. Notion 쓰기는 건너뛰고 Obsidian 변경은 diff 로만 출력합니다 |
| `--skip-notion` | Notion 채널 건너뛰기 (이때는 `NOTION_TOKEN` 이 없어도 실행됩니다) |
| `--skip-obsidian` | Obsidian 채널 건너뛰기 (Librarian 도 함께 건너뜁니다) |
| `--skip-librarian` | Librarian 만 건너뛰기 |

자동 수집·분석(Phase 2~3)이 붙기 전까지는 `--input` 없이 실행하면 입력이 없다는 오류로 끝납니다. 한 번 실행하면 입력 → Notion 발행 → Obsidian 발행 → Librarian 순서로 처리하고, 한 채널이 실패해도 다른 채널과 Librarian 은 계속 진행합니다(Run 상태는 `PARTIAL_SUCCESS`). 실행이 끝나면 상태·카운터·발행 결과·오류 요약이 출력되고, Run 기록은 `data/store/runs/<runId>.json` 에 남습니다.

종료 코드는 `SOURCE_FAILURE` / `ANALYSIS_FAILURE` / `OUTPUT_FAILURE` / `ABORTED` 일 때만 1 이고, `PARTIAL_SUCCESS` 는 경고만 출력하고 0 입니다.

Obsidian의 기본 출력은 다음과 같습니다.

```text
C:\dev\knowledge\ai-knowledge\99 Daily\2026-09-12 AI Intelligence Daily.md
```

같은 날짜의 노트는 `99 Daily/<date> *.md` 날짜 접두로 찾고, 없을 때만 만듭니다. 기존 노트는 `<!-- ai-radar:daily:start -->` ~ `<!-- ai-radar:daily:end -->` 관리 영역만 교체하므로 그 밖에 적어 둔 메모는 그대로 남습니다.

검증과 테스트:

```powershell
npm run typecheck
npm test
```

## Obsidian Vault 경로 설정

기본 Vault 경로는 `src/runtime/config/app-config.ts` 의 `DEFAULT_OBSIDIAN_VAULT` 에서 한 번만 정의합니다. 환경변수를 읽는 곳은 `src/runtime/config/` 하나뿐이며, 다른 환경에서는 `OBSIDIAN_VAULT_PATH` 로 재정의할 수 있습니다.

```powershell
$env:OBSIDIAN_VAULT_PATH = "D:\Knowledge\ai-knowledge"
npm run daily -- --input data/input/daily-brief.sample.json
```

`ObsidianVault` 는 계산된 경로가 설정한 Vault 안에 있는지 확인하며, Vault 밖으로 나가는 경로는 거부합니다. 한 Run 이 만들거나 고치는 Knowledge Note 수는 `AI_RADAR_MAX_NOTES_PER_RUN`(기본 20)으로 제한합니다.

## Notion 설정

프로젝트 루트의 `.env` 에 다음 변수를 설정합니다. `.env` 는 Git에서 제외됩니다.

```dotenv
NOTION_TOKEN=your_integration_token
NOTION_DATABASE_ID=your_database_id
OBSIDIAN_VAULT_PATH=C:\dev\knowledge\ai-knowledge
# NOTION_DATA_SOURCE_ID=optional (지정하면 data source 자동 탐색을 건너뜁니다)
# NOTION_ALLOW_SCHEMA_FALLBACK=false (기본값. 설정 ID 와 무관한 DB 로의 fallback 을 허용하려면 true)
# AI_RADAR_TIMEZONE=Asia/Seoul
# AI_RADAR_STORE_DIR=<projectRoot>/data/store
# AI_RADAR_MAX_NOTES_PER_RUN=20
```

Integration에는 대상 데이터베이스의 읽기, 삽입, 수정 권한이 필요합니다. 데이터베이스 속성은 다음 이름과 타입을 사용합니다.

| 속성 | 타입 | 동작 |
| --- | --- | --- |
| Name | Title | briefing 제목 |
| Date | Date | briefing 날짜 및 upsert 기준 |
| Topics | Multi-select | topic 제목 목록 |
| Importance | Number | topic 중요도의 최댓값 |
| Read | Checkbox | 새 페이지에서만 `false` 로 초기화, 이후 사용자 값 유지 |
| Applied | Checkbox | 새 페이지에서만 `false` 로 초기화, 이후 사용자 값 유지 |

본문 텍스트는 Notion 제한에 맞춰 나누고, 블록은 요청당 최대 100개씩 순차적으로 저장합니다. 기존 페이지를 갱신할 때 본문은 현재 briefing 내용으로 교체됩니다.

설정한 ID와 일치하는 data source가 없을 때 스키마가 유일하게 일치하는 다른 data source로 fallback 하는 동작은 **기본 비활성** 입니다 (`docs/architecture/INTEGRATIONS_AND_SAFETY.md` §4 R-N1). 다른 workspace DB 에 쓰는 사고를 막기 위해서이며, 필요하면 `NOTION_DATA_SOURCE_ID` 를 지정하거나 `NOTION_ALLOW_SCHEMA_FALLBACK=true` 로 명시적으로 켭니다.

## Obsidian Librarian

Librarian은 item 의 `knowledgeType` 을 다음 폴더에 매핑합니다. `knowledgeType` 이 없거나 중요도가 4 미만인 item 은 Knowledge Note 로 승격되지 않습니다.

| item knowledgeType | 폴더 |
| --- | --- |
| `concept` | `01 Concepts` |
| `pattern` | `02 Patterns` |
| `workflow` | `03 Workflows` |
| `tool` | `04 Tools` |
| `architecture` | `05 Architecture` |
| `research` | `06 Research` |
| 그 외 | `00 Inbox` |

기존 노트는 H1 제목과 파일명을 기준으로 검색합니다. 비교할 때 대소문자, 앞뒤 공백, 하이픈, underscore, 연속 공백을 정규화합니다. 정규화 제목이 2개 이상 일치하면 아무것도 쓰지 않고 실패로 보고합니다. 동일한 날짜의 Evidence는 한 번만 유지하고, Daily Note에는 해당 item과 related 항목을 `Knowledge Updates` 위키 링크로 기록합니다. 파일명 충돌이 있으면 기존 파일을 덮어쓰지 않고 숫자 suffix가 붙은 새 경로를 사용합니다. 별도 백업 Markdown은 생성하지 않으며 복구와 버전 이력은 Git이 담당합니다.

관리 영역은 `daily`, `content`, `evidence:<date>`, `status`, `knowledge-updates` 다섯 가지입니다. 쓸 때는 항상 새 마커 `<!-- ai-radar:… -->` 를 쓰고, 레거시 마커 `<!-- ai-coding-radar:… -->` 는 읽기 호환합니다(갱신하면 자연스럽게 새 마커로 이행합니다).

## 다음 단계

`docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §4 의 Phase 2(Raw Store, Storage, 첫 Source)와 Phase 3(자동 Daily Brief 생성)으로 이어집니다. 수동 입력 예시는 `data/input/daily-brief.sample.json` 에 있으며 `--input` 으로 지정할 때만 사용됩니다.
