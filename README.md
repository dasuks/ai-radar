# AI Radar

AI/LLM/AI Coding 생태계를 지속적으로 관측하고, 수집된 사실과 커뮤니티 반응을 근거와 함께 저장하고, 목적에 따라 분석해 학습·지식 축적·트렌드 관찰·콘텐츠 제작에 재사용하는 개인용 AI Intelligence Platform입니다. 매일의 산출물은 **AI Intelligence Daily** 이며 Notion(읽기·보관)과 Obsidian(장기 지식)으로 전달됩니다.

목표 아키텍처와 이행 계획은 [`docs/architecture/`](docs/architecture/README.md) 에 있고, 주요 결정은 [`docs/adr/`](docs/adr/README.md) 에 기록되어 있습니다. 에이전트 작업 규칙은 [`AGENTS.md`](AGENTS.md) 를 따릅니다.

> 이 프로젝트의 이전 이름은 AI Coding Radar(`ai-coding-radar`)입니다. Obsidian 노트의 레거시 마커(`<!-- ai-coding-radar:… -->`)와 Notion Integration 표시명에는 이전 이름이 남아 있으며, 호환을 위해 의도적으로 유지합니다. 자세한 기준은 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §3 을 참고하세요.

## 현재 구현 범위

현재 코드는 목표 아키텍처의 **Phase 0부터 Phase 3까지** 구현되어 있고, `npm run daily` 하나로 수집부터 발행까지 전체 파이프라인이 자동으로 동작합니다. 2026-09-12 야간에 첫 자동 실행이 성공했습니다. 세부 수치와 Phase별 현황표는 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §9 를 참고하세요. 파이프라인 순서는 다음과 같습니다.

1. **Collect**: Hacker News Firebase API 와 `config/sources.json` 에 등록된 RSS/Atom 피드를 수집해 `RawObservation` 으로 저장합니다. 소스별 checkpoint 를 남겨 idempotent 하게 재실행할 수 있습니다.
2. **Normalize / Link / Metrics**: 원문을 `NormalizedDocument` 로 정규화하고, 같은 문서를 가리키는 문서 간 링크를 만들고, 소스가 준 수치를 `MetricObservation` 으로 기록합니다.
3. **Analyze**: Codex CLI(`codex exec`)를 read-only sandbox, JSON schema 출력, `stdin` 을 닫은 상태로 호출해 classification 과 claim/evidence 를 뽑습니다. 사용자의 ChatGPT 구독으로 인증하며 별도 API 키가 필요 없습니다.
4. **BuildDailyBrief**: CULTURE·PRACTICAL ranking 정책 v1.0.1(threshold 0.3)로 item 을 뽑아 `DailyBriefBody` v2 `Artifact` 를 만듭니다(revision, contentHash, visibility PRIVATE).
5. **Publish**: 같은 Artifact 를 Notion(`Date` 기준 upsert, `Read`/`Applied` 보존, `ai-radar:revision:<n>` callout)과 Obsidian(날짜 접두로 Daily Note 를 찾고 `ai-radar:daily` 관리 영역만 교체)에 발행합니다. 두 채널은 서로 격리되어 있어 한쪽이 실패해도 다른 쪽과 Librarian 은 계속 진행합니다(Run 상태는 `PARTIAL_SUCCESS`).
6. **Librarian**: Deterministic Librarian 이 `knowledgeType` 이 있고 중요도 4 이상인 item 을 Knowledge Note 로 만들거나 갱신하고(한 Run 최대 20건), 날짜별 Evidence 블록과 Daily Note 의 `Knowledge Updates` 양방향 링크를 관리합니다.

실행 하나가 하나의 `Run` 이며 SQLite `runs` 테이블에 단계마다 기록됩니다. Run 상태는 `PIPELINES_AND_POLICIES.md` §4 의 판정식을 따릅니다. 수동으로 작성한 Daily Brief JSON을 `--input` 으로 지정하면 위 Collect/Analyze/BuildDailyBrief 자동 경로 대신 그 파일을 사용합니다(v1 이면 v2 로 upcast).

Entity 해석은 아직 GitHub repository URL 인식 정도의 최소 수준이고(그 외 surface form 은 UNRESOLVED mention 으로 저장), Trend 계산(DerivedSignal), Librarian v2(proposal/review), 승인 기반 공개 채널 발행은 아직 구현되어 있지 않습니다. 아래 "알려진 한계" 절과 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §9 를 참고하세요.

## 폴더 구조 (현재)

```text
src/
  domain/        Canonical 계약과 순수 규칙
    artifacts/     Artifact, DailyBriefBody v1/v2 + upcast
    documents/      RawObservation, NormalizedDocument
    entities/        Entity (GitHub repository 최소 해석)
    evidence/        Claim, Evidence, Analysis, Provenance
    metrics/         MetricObservation, DerivedSignal (계약만, 계산은 Phase 4)
    runs/            Run
    shared/          ids, hash, markers, time, validation
  policies/      Ranking / Classification 정책 (순수 함수)
    culture/, practical/   CULTURE·PRACTICAL ranking 정책 v1.0.1
    classification/        visibility 정책
  application/   Use Case
    collect/       CollectSources (HN·RSS 수집, checkpoint, idempotency)
    normalize/      normalize / link-and-dedupe / record-metrics
    analyze/        classify-documents, extract-claims, evidence-builder, analyze-summary, prompts/
    briefing/       BuildDailyBrief
    publish/        PublishArtifact (idempotency·사용자 필드 보존)
    librarian/      RunLibrarian (Knowledge Note 생성·갱신, Evidence, 양방향 링크)
    runs/           RunDailyPipeline (단계 orchestration, 채널 실패 격리, Run 상태 판정)
  ports/         Application 이 요구하는 interface (storage, publishing, sources, llm, system)
  adapters/      Port 구현
    sources/       hackernews/, rss/
    llm/            codex-cli/ (Codex CLI provider, `child_process` 허용 예외), fake/ (테스트용)
    notion/         NotionPublisher (Date 기준 upsert, Read/Applied 보존)
    obsidian/       ObsidianVault(VaultPort), ObsidianDailyPublisher (관리 영역만 교체)
    rendering/      markdown/ (Daily Note 본문), notion-blocks/ (Notion 블록)
    storage/        sqlite/ (migrations, 기본 저장소), fs/ (raw·artifact 파일), json-files/, memory/ (테스트용)
    system/         SystemClock, ConsoleLogger, FetchHttpClient, LogEventSink, NodeRandom
  runtime/
    config/       env + config/sources.json -> AppConfig (유일한 process.env 접근 지점)
    composition/  buildDailyPipeline (조립)
    runs/         Run lifecycle 기록 (단계마다 flush)
    cli/daily.ts  `npm run daily` 진입점
config/
  sources.json   RSS/Atom 피드 목록 (id, name, url)
scripts/
  run-daily.cmd  Windows Task Scheduler 진입점 (로그를 data/store/logs/ 에 남김)
data/
  input/daily-brief.sample.json  수동 입력 예시 (--input 으로만 사용)
  store/         SQLite DB(ai-radar.sqlite), raw/artifact 파일, 로그 (gitignore)
test/            application/adapters 계약 테스트 26개 파일, architecture.test.ts 포함
docs/
  architecture/                목표 아키텍처, 계약, 파이프라인, 안전, 이행 계획
  adr/                         Architecture Decision Records
```

## 실행 방법

Node.js 24 이상이 필요합니다 (내장 `node:sqlite` 를 사용합니다).

```powershell
npm install
npm run daily
```

플래그 없이 실행하면 오늘 날짜(설정 timezone 기준)로 Collect → Normalize/Link/Metrics → Analyze(Codex) → BuildDailyBrief → Publish(Notion·Obsidian) → Librarian 전체가 자동으로 돌아갑니다. `npm run daily` 는 `src/runtime/cli/daily.ts` 를 실행합니다. 플래그는 다음과 같습니다.

| 플래그 | 뜻 |
| --- | --- |
| `--date YYYY-MM-DD` | 대상 날짜. 기본값은 설정 timezone(`AI_RADAR_TIMEZONE`, 기본 `Asia/Seoul`) 기준 오늘 |
| `--input <file>` | 수동 Daily Brief JSON 으로 자동 Collect/Analyze/BuildDailyBrief 경로를 대체. v1(`topics[]`) 과 v2(`bodySchemaVersion: 2`) 를 모두 받습니다 |
| `--dry-run` | Notion 쓰기는 건너뛰고 Obsidian 변경은 diff 로만 출력합니다. Codex 호출은 그대로 일어납니다 |
| `--skip-notion` | Notion 채널 건너뛰기 (이때는 `NOTION_TOKEN` 이 없어도 실행됩니다) |
| `--skip-obsidian` | Obsidian 채널 건너뛰기 (Librarian 도 함께 건너뜁니다) |
| `--skip-librarian` | Librarian 만 건너뛰기 |
| `--help` | 위 도움말 출력 |

한 채널이 실패해도 다른 채널과 Librarian 은 계속 진행합니다(Run 상태는 `PARTIAL_SUCCESS`). 실행이 끝나면 상태·발행 결과·Librarian 처리 건수·오류 요약이 출력되고, Run 은 SQLite `runs` 테이블에 단계마다 기록됩니다.

종료 코드는 `SOURCE_FAILURE` / `ANALYSIS_FAILURE` / `OUTPUT_FAILURE` / `ABORTED` 일 때만 1 이고, `PARTIAL_SUCCESS` 는 경고만 출력하고 0 입니다. Hacker News 수집은 200개 story 스캔 상한에 걸리면 정직하게 `PARTIAL` 을 보고하도록 되어 있어서, 매일 `PARTIAL_SUCCESS` 로 끝나는 것은 예상된 정상 동작입니다.

### Codex CLI 요구사항

Analyze 단계는 Codex CLI(`codex exec`)를 자식 프로세스로 호출합니다. API 키가 아니라 사용자의 ChatGPT 구독 로그인으로 인증하므로, 실행 전에 로그인 상태를 확인하세요.

```powershell
codex login status
```

로그인되어 있지 않으면 `codex login` 으로 다시 로그인합니다. Windows 에서 `codex` 커맨드는 `.cmd`/`.ps1` shim 이라 shell 없이 spawn 할 수 없어서, 코드는 `%APPDATA%\npm` 아래의 `codex.exe` 를 직접 찾아 실행합니다(경로는 `AI_RADAR_CODEX_BIN` 으로 재정의할 수 있습니다).

### 매일 자동 실행 (Windows Task Scheduler)

Windows Task Scheduler 에 "AI Radar Daily" 작업이 매일 07:00에 `scripts/run-daily.cmd` 를 실행하도록 등록되어 있습니다. 등록에 쓴 명령은 다음과 같습니다.

```powershell
schtasks /Create /TN "AI Radar Daily" /TR "C:\dev\projects\ai-radar\scripts\run-daily.cmd" /SC DAILY /ST 07:00
```

`scripts/run-daily.cmd` 는 `npm run daily` 를 호출하고 표준출력·표준에러를 `data/store/logs/<yyyy-mm-dd>.log` 에 남깁니다. 이 스케줄이 매일 동작하려면 PC 가 켜져 있어야 하고 Codex 로그인이 유지돼야 합니다(위 `codex login status` 로 주기적으로 확인하세요). 작업을 지우려면 다음을 실행합니다.

```powershell
schtasks /Delete /TN "AI Radar Daily" /F
```

### 오늘 수동으로 다시 실행하기

스케줄과 무관하게 지금 바로 실행하려면 `--date` 없이 그대로 실행합니다.

```powershell
npm run daily
```

같은 날짜를 다시 실행해도 Notion 은 같은 페이지를 갱신하고(Read/Applied 보존), Obsidian 은 관리 영역만 다시 교체하며, Artifact 의 `contentHash` 가 이전과 같으면 revision 은 올라가지 않습니다.

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

`npm test` 는 먼저 `.test-dist/` 로 clean build 한 뒤 `.test-dist/test/**/*.test.js` 를 실행합니다. 현재 165개 테스트가 통과하며 `test/architecture.test.ts` 의 LEGACY allowlist 는 비어 있습니다.

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
```

`src/runtime/config` 는 이 값들 외에도 아래 환경변수를 읽습니다. 모두 선택값이며, 지정하지 않으면 기본값을 씁니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `NOTION_TOKEN` | 없음 (필수, `--skip-notion` 이면 생략 가능) | Notion Integration 토큰 |
| `NOTION_DATABASE_ID` | 없음 (필수, `--skip-notion` 이면 생략 가능) | 대상 데이터베이스 ID |
| `NOTION_DATA_SOURCE_ID` | 자동 탐색 | 지정하면 data source 자동 탐색을 건너뜁니다 |
| `NOTION_ALLOW_SCHEMA_FALLBACK` | `false` | 설정 ID 와 무관한 DB 로의 스키마 fallback 을 허용하려면 `true` |
| `OBSIDIAN_VAULT_PATH` | `C:\dev\knowledge\ai-knowledge` | Obsidian Vault 경로 |
| `AI_RADAR_STORE_DIR` | `<projectRoot>/data/store` | SQLite DB, raw 파일, artifact 파일, 로그가 저장되는 위치 |
| `AI_RADAR_TIMEZONE` | `Asia/Seoul` | 날짜 계산 기준 timezone |
| `AI_RADAR_LLM_PROVIDER` | `codex-cli` | Analyze 단계에서 쓸 LLM Provider |
| `AI_RADAR_LLM_MODEL` | Codex 기본 모델 | Codex CLI 에 넘길 모델 이름 |
| `AI_RADAR_LLM_MAX_CALLS` | `12` | 한 Run 에서 허용하는 Codex 호출 수 상한 |
| `AI_RADAR_MAX_DOCS` | `32` | 한 Run 에서 분석할 문서 수 상한 |
| `AI_RADAR_LLM_TIMEOUT_MS` | `240000` | Codex 호출 1건당 타임아웃(ms) |
| `AI_RADAR_CODEX_BIN` | `%APPDATA%\npm` 아래 `codex.exe` 자동 탐색 | Codex 실행 파일 경로. Windows 에서 `codex` shim 은 shell 없이 spawn 할 수 없어 필요합니다 |

RSS 피드 목록은 환경변수가 아니라 `config/sources.json`(id, name, url)에 있습니다.

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

## 상세 리포트와 전체 목록 (Notion `AI Radar Reports`)

Daily 페이지는 짧은 요약이고, 자세한 내용은 별도 DB `AI Radar Reports` 에 매일 다음 페이지가 생깁니다.

- `<날짜> · <섹션> 상세`: 섹션(AI 교양, AI Coding, LLM, Agent Engineering, Evals & Reliability, AI Economics)마다 1개. 항목별로 무슨 일이 있었나(긴 서술), 근거 인용(원문·댓글 링크), 주장 구분표, 커뮤니티 반응, 왜 중요한가, 적용 방법, 반론과 불확실한 점, 출처. 근거가 충분한 항목(본문이 있거나 claim 3개 이상)만 실리고, 중요하면 여러 섹션에 중복 등장합니다.
- `<날짜> · 전체 목록`: 그날 들어온 이야기 전부. 한국어 제목 + 1~3줄 요약 + 근거 수준 태그 + 원문 미리보기 카드(bookmark) + HN 토론 링크 + (있으면) 상세 리포트 링크.
- Daily 페이지의 각 섹션 제목 아래 "상세 리포트 →", 맨 아래 "오늘 들어온 이야기 전체 목록 →" 링크가 붙습니다.

설정: `.env` 에 `NOTION_REPORTS_DATABASE_ID` (선택: `NOTION_REPORTS_DATA_SOURCE_ID`). 없으면 리포트 단계는 건너뛰고 Daily 만 발행합니다. 리포트 DB 는 런타임 통합(Integration)에 공유돼 있어야 합니다. 하루 Codex 호출은 약 15회, 실행 25~35분입니다.

## Obsidian Librarian

Librarian 은 `npm run daily` 파이프라인의 마지막 단계로 자동 실행됩니다. Daily Brief 의 item 중 `knowledgeType` 이 있고 중요도가 4 이상인 것만 Knowledge Note 로 승격하고, 한 Run 에서 만들거나 고치는 노트 수는 `AI_RADAR_MAX_NOTES_PER_RUN`(기본 20)으로 제한합니다. `knowledgeType` 이 없거나 중요도가 4 미만인 item 은 승격되지 않습니다.

item 의 `knowledgeType` 은 다음 폴더에 매핑합니다.

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

## 알려진 한계

- **Trend 미계산**: DerivedSignal·TrendEngine 은 아직 구현되어 있지 않습니다(Phase 4). Daily Brief 에는 TREND_WATCH 섹션이 없습니다.
- **Entity 해석 최소**: GitHub repository URL 인식 정도만 결정적으로 해석하고, 그 외 이름·서비스는 entity 로 연결되지 않은 UNRESOLVED mention 으로만 저장됩니다.
- **Librarian 은 아직 v1**: 규칙(knowledgeType + 중요도 4 이상)을 그대로 적용하는 deterministic 버전이라, 뉴스성 item 도 조건만 맞으면 Knowledge Note 로 승격될 수 있습니다. Proposal/사람 검토 흐름은 Phase 5에서 추가됩니다.
- **수치 문장 거부**: 퍼센트나 증가율이 들어간 문장은 대응하는 metric evidence 가 없으면 claim 으로 승격되지 않고 거부됩니다.
- **Codex 지연시간 변동**: 호출 1건에 25초에서 2분 이상까지 걸릴 수 있고, 한 Run 전체는 대략 8분에서 15분이 걸립니다.
- **Notion schema fallback 기본 off**: 설정한 data source ID 가 없을 때 다른 DB 로 자동 대체하는 동작은 기본적으로 꺼져 있습니다(`NOTION_ALLOW_SCHEMA_FALLBACK=true` 로 켜야 합니다).

## 다음 단계

Phase 0~3 은 구현되어 매일 자동으로 돕니다 (`docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §9). 다음은 Phase 4(Trend Engine, DerivedSignal, Trend Watch)와 Phase 5(Librarian v2 제안·검토 흐름), 그리고 Horizon/GitHub Source 추가입니다. 수동 입력 예시는 `data/input/daily-brief.sample.json` 에 있으며 `--input` 으로 지정할 때만 사용됩니다.
