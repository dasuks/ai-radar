# AI Radar Architecture

문서 버전: 1.0 (2026-09-12)
상태: 채택 (ADR-0001 ~ ADR-0008 참조)

이 문서는 AI Radar의 목표 아키텍처를 정의한다. 현재 구현과의 차이와 이행 계획은 `MIGRATION_AND_ACCEPTANCE.md`에 있다. 계약(데이터 모델)의 필드 수준 정의는 `CONTRACTS_AND_DATA.md`, 파이프라인 동작과 정책은 `PIPELINES_AND_POLICIES.md`, 외부 연동과 안전 규칙은 `INTEGRATIONS_AND_SAFETY.md`에 있다.

용어는 `README.md`의 Glossary를 따른다. 특히 **module / interface / seam / adapter / port** 를 구분해서 쓴다.

---

## 1. AI Radar가 무엇이고 무엇이 아닌가

### 1.1 정체성

AI Radar는 **개인용 AI Intelligence Platform** 이다.

- AI / LLM / AI Coding 생태계를 **지속적으로 관측**한다.
- 수집한 사실과 커뮤니티 반응을 **근거(Evidence)와 함께 저장**한다.
- 목적(교양·실무·트렌드)에 따라 **다르게 분석**한다.
- 결과를 **학습(Notion Daily), 지식 축적(Obsidian), 트렌드 관찰, 콘텐츠 제작**에 재사용한다.

핵심 가치는 "오늘 뭐가 있었나"가 아니라 **"무엇을, 어떤 근거로, 언제, 어느 정도 확신으로 알게 되었는가"** 를 6개월 뒤에도 추적할 수 있다는 점이다.

### 1.2 AI Radar가 아닌 것

| 아닌 것 | 이유 / 대신 무엇인가 |
| --- | --- |
| 뉴스 크롤러 | 수집은 입력 단계일 뿐. 핵심은 Entity·Metric·Claim·Evidence로 구조화된 Intelligence Store |
| Horizon 래퍼 | Horizon은 Source Adapter 후보 중 하나. 제거해도 Core와 Intelligence Layer는 유지된다 |
| Notion 앱 | Notion은 읽기·보관 채널. Canonical 저장소가 아니다 |
| Obsidian 동기화 도구 | Obsidian은 Living Knowledge Base. Daily Brief를 그대로 복사하지 않는다 |
| LLM 요약기 | LLM은 교체 가능한 외부 Provider. 근거 없는 수치·주장을 만들 권한이 없다 |
| 자동 SNS 게시기 | 공개 게시는 승인 경계(Approval Boundary) 뒤에만 존재한다 |
| Skill 생성기 | 지식 → Skill 승격은 인간 리뷰를 거치는 향후 flow. 자동 생성은 설계상 허용하지 않는다 |
| 마이크로서비스 | 단일 프로세스 TypeScript Modular Monolith |

---

## 2. 설계 철학

### 2.1 원칙

1. **Ports & Adapters.** 외부 세계(Source, LLM, Notion, Obsidian, 파일시스템, DB)는 모두 Port 뒤의 Adapter다.
2. **Stable Canonical Contracts.** Raw → Normalized → Entity/Metric/Claim → Artifact 계약은 `schemaVersion`을 가지며, Adapter는 계약을 향해 변환한다. Adapter 고유 타입은 Core로 새지 않는다.
3. **Explicit Application Use Cases.** 파이프라인의 각 단계는 이름 있는 Use Case다 (`CollectSources`, `NormalizeObservations`, `ResolveEntities`, `ComputeSignals`, `BuildDailyBrief`, `ProposeKnowledgeUpdates`, `PublishArtifact` …). 숨은 순서 의존을 두지 않는다.
4. **Replaceable Infrastructure.** Storage, LLM Provider, Source, Output Channel은 각각 최소 2개 Adapter(운영 + 테스트/in-memory)를 가진다. "One adapter means a hypothetical seam" 원칙에 따라, Adapter가 하나뿐인 곳에는 Port를 두지 않는다. 테스트용 in-memory/fake adapter는 실제 두 번째 adapter로 인정한다 (Use Case 테스트가 그 seam을 건너기 때문). 승인 같은 **내부 규칙**은 Port가 아니라 Application Use Case다.
5. **Deep modules.** Use Case는 작은 interface 뒤에 많은 동작(재시도, checkpoint, idempotency, 검증)을 숨긴다. Adapter는 얇게 유지한다: "fetch하고 계약으로 변환"만 한다.
6. **Evidence first.** 중요한 분석 결과는 Evidence 없이 존재할 수 없다. LLM 출력은 schema validation과 evidence-existence validation을 통과해야 저장된다.
7. **Failure semantics는 데이터다.** "정보 없음"과 "수집 실패"는 서로 다른 상태값이다. 실패는 Run 기록에 남고 Artifact에 반영된다.
8. **Idempotent by key.** 모든 persistent 객체에 idempotency key가 있다. 같은 window를 다시 실행해도 중복이 생기지 않는다.

### 2.2 초기부터 도입하지 않는 것

Microservices, Kafka, Kubernetes, service mesh, DI framework, runtime plugin marketplace, 사용하지 않는 추상화, 빈 디렉터리 수십 개.

확장성은 서비스 개수가 아니라 **계약의 안정성과 seam의 위치**로 확보한다.

### 2.3 런타임 의존성 정책

- `domain`, `policies`, `application`, `ports` 는 **외부 패키지를 import하지 않는다** (Node 내장 모듈 중 순수 계산용만 허용). 아키텍처 테스트가 강제한다.
- 외부 패키지는 `adapters/` 와 `runtime/` 에서만 허용된다. 추가 조건: (1) Node 내장으로 합리적으로 대체할 수 없을 것, (2) 라이선스가 MIT/Apache-2.0/BSD/ISC 계열일 것, (3) `package.json` 변경 PR 본문에 대체안과 선택 이유를 한 줄 적을 것. 예: arXiv Atom 파싱에 정규식 대신 XML 파서를 쓰는 것은 정당하다.
- 네이티브 빌드가 필요한 패키지(`better-sqlite3` 등)는 마지막 수단이며 ADR로 기록한다.
- 새 의존성이 Port 시그니처에 타입을 노출하면 위반이다 (`ports/` 는 외부 패키지 import 금지).

---

## 3. 계층 구조와 의존성 규칙

```
        ┌───────────────────────────────────────────────┐
        │ runtime/  (Composition Root, CLI, Run 관리)     │  ← 유일하게 모든 것을 알 수 있음
        └───────────────────────────────────────────────┘
                   │ 조립                       │ 조립
                   ▼                            ▼
        ┌────────────────────┐        ┌────────────────────┐
        │ adapters/          │  구현→ │ ports/             │
        │ (horizon, github,  │        │ (SourceAdapter,    │
        │  rss, notion,      │        │  Storage, Llm,     │
        │  obsidian, llm,    │        │  Renderer,         │
        │  sqlite, fs)       │        │  Publisher, Clock) │
        └────────────────────┘        └────────────────────┘
                                                ▲ 사용
                                      ┌────────────────────┐
                                      │ application/       │  Use Cases
                                      │ policies/          │  Ranking / Trend 정책 (pure)
                                      └────────────────────┘
                                                ▲ 사용
                                      ┌────────────────────┐
                                      │ domain/            │  Canonical 계약 + 순수 규칙
                                      └────────────────────┘
```

의존성 방향: **Domain ← Policies ← Application → Ports ← Adapters ← Composition Root**. Application은 Ports를 **사용**하고 Adapters는 Ports를 **구현**한다. Ports는 Domain만 안다. 표 §3.1 의 "허용 import" 열이 정확한 규칙이며, 그 반대 방향 import는 금지다.

### 3.1 계층별 책임과 금지 사항

| 계층 | 책임 | 허용 import | 금지 |
| --- | --- | --- | --- |
| `domain/` | Canonical 계약 타입, 값 검증(parse/validate), 순수 규칙(ID 생성, hash, 상태 전이, 계약 upcast). 입출력 없음 | `node:crypto` 등 순수 표준 모듈, `domain/` 내부 | `node:fs`, `node:http`, `fetch`, `process.env`, `@notionhq/*`, `@anthropic-ai/*`, `openai`, `node:sqlite`, `application/`, `ports/`, `adapters/`, `runtime/` |
| `policies/` | Ranking / Trend / Classification 가중치와 계산. 순수 함수. 버전 상수 포함 | `domain/` | domain 금지 목록 전부 + `application/` |
| `application/` | Use Case 구현. 입력 계약을 받아 Port를 호출하고 결과 계약을 반환. 재시도·checkpoint·idempotency·검증 로직의 **깊이**가 여기에 있다 | `domain/`, `policies/`, `ports/` | `adapters/`, `runtime/`, 외부 SDK, `process.env`, `node:fs` |
| `ports/` | Application이 외부에 요구하는 interface. 타입만 존재. 계약은 domain 타입으로 표현 | `domain/` | 외부 SDK 타입, `adapters/`, `application/` |
| `adapters/` | Port 구현. 외부 SDK·HTTP·파일시스템·DB 사용. 외부 payload를 domain 계약으로 변환 | `domain/`, `ports/`, 자기 자신의 SDK | **다른 adapter 디렉터리**, `application/`, `runtime/`, `process.env` (자격증명은 생성자 인자로 받는다) |
| `runtime/` | Composition Root, 환경변수·설정 로딩, CLI 진입점, Run lifecycle 조립 | 전부 | 비즈니스 규칙 구현 (계산은 application/policies에 둔다) |

추가 규칙:

- **Adapter 간 호출 금지.** `adapters/notion`이 `adapters/obsidian`을 import하면 위반이다. 공통이 필요하면 `domain/` 또는 `adapters/shared/`(외부 SDK 미포함 유틸)로 올린다.
- **Provider 고유 타입 누출 금지.** `ports/` 시그니처에 `@notionhq/client`의 `BlockObjectRequest`, Anthropic의 `Message` 같은 타입이 나타나면 위반이다.
- **Horizon 타입 누출 금지.** Horizon의 출력 JSON 형태는 `adapters/horizon/` 안에서만 존재한다. Core는 `RawObservation`만 안다.
- **`process.env` 접근 지점은 `runtime/config`** 하나다. 다른 모든 모듈은 값을 인자로 받는다.
- **프로세스 실행(`node:child_process`)은 `adapters/sources/horizon/` 과 `adapters/llm/codex-cli/` 두 곳에서만** 허용한다. 두 adapter 모두 고정 명령과 코드 상수 인자만 쓰고, 외부 데이터는 stdin 을 닫은 채 파일·인자 텍스트(셸 해석 없음, `shell:false`)로만 전달한다.

이 규칙은 `test/architecture.test.ts` 가 import 스캔으로 강제한다 (`MIGRATION_AND_ACCEPTANCE.md` §7).

### 3.2 Composition Root

`src/runtime/composition/` 는 다음만 한다.

1. `runtime/config`로 환경변수와 설정 파일을 읽어 typed `AppConfig`를 만든다 (secret 값은 이후 로그 redaction 목록에 등록).
2. Adapter를 생성한다 (`new NotionPublisher(client)`, `new SqliteStore(db)`, `new HackerNewsSource(http)` …).
3. Use Case에 Port 구현을 주입한다.
4. `RunDailyPipeline` 같은 최상위 Use Case를 CLI 명령에 연결한다.

DI framework는 쓰지 않는다. 생성자 주입 + 명시적 조립 함수(`buildDailyPipeline(config)`) 로 충분하다.

---

## 4. 전체 데이터 흐름 (개념 계층)

```
 SOURCES ──▶ Source Ports ──▶ RAW OBSERVATIONS ──▶ NORMALIZE ──▶ CANONICAL DOCUMENTS
                                                                      │
                                                          DEDUPE / LINKING
                                                                      │
                                                     ┌────────────────┴───────────────┐
                                                     ▼                                ▼
                                               ENTITY LAYER                     SIGNAL LAYER
                                    (Model, Tool, Skill, MCP Server,     (MetricObservation →
                                     Framework, Repository, Company,      DerivedSignal)
                                     Person, Concept)                          │
                                                     └────────────────┬───────────────┘
                                                                      ▼
                                                          INTELLIGENCE LAYER
                                          (Classification, Claims+Evidence, Ranking Policies,
                                           Trend Engine, LLM Analysis)
                                                                      │
                                                                      ▼
                                                          INTELLIGENCE MODEL
                                       (하루/한 주에 대한 검증된 Claim·Signal·Trend 집합 + 선택 근거)
                                                                      │
                                                                      ▼
                                                             ARTIFACT LAYER
                            (Daily Brief, Weekly Report, Trend Report, Alert, Knowledge Proposal, Social Post Draft)
                                                                      │
                                                                      ▼
                                              CONTENT ──▶ RENDER ──▶ (APPROVAL) ──▶ PUBLISH
                                                                      │
                                       Notion · Obsidian · (Discord · Email · Instagram · Web)
```

### 4.1 계층별 책임과 금지 의존성

| 계층 | 책임 | 소유 데이터 | 금지 |
| --- | --- | --- | --- |
| Sources / Source Ports | 외부에서 payload 확보. TimeWindow·checkpoint·rate limit·timeout·부분 실패를 계약으로 보고 | 없음 (stateless). checkpoint는 Application이 저장 | 정규화·분석·저장 |
| Raw Observations | 확보한 payload의 불변 snapshot. 원본 재분석의 유일한 출처 | `RawObservation` + raw payload 파일 | 수정. 삭제는 보존 정책으로만 |
| Normalize | Source별 payload → `NormalizedDocument`. 시간·본문 완전성·metric을 정직하게 표기 | `NormalizedDocument` | LLM 호출, 추측으로 필드 채우기 (예: fetchedAt을 publishedAt으로) |
| Dedupe / Linking | 동일 URL·동일 story·cross-post 연결. 삭제하지 않고 link한다 | `DocumentLink` | 원본 삭제 |
| Entity Layer | 언급 대상의 정체성 관리. alias, merge/split 이력, identity confidence | `Entity`, `EntityAlias`, `EntityMention`, `EntityMerge` | 이름만 같다고 자동 merge |
| Signal Layer | 실제 관측값(`MetricObservation`)과 계산값(`DerivedSignal`) 분리 | 두 테이블 | 범위(scope)가 다른 metric 혼합, LLM이 수치 생성 |
| Intelligence Layer | Classification, Claim 추출, Evidence 연결, Ranking, Trend | `Claim`, `Evidence`, `AnalysisRecord`, `DerivedSignal` | 근거 없는 Claim 저장, 외부 텍스트를 명령으로 해석, 파일/셸/발행 권한 |
| Intelligence Model | 특정 window에 대해 "검증된 것"의 뷰. Artifact의 유일한 입력 | 뷰 (Query 결과) | Artifact가 이 뷰를 우회해 Raw나 다른 Artifact를 직접 재요약 |
| Artifact Layer | 목적·채널별 산출물 생성. revision·contentHash·status 관리 | `Artifact`(revision 단위 row), `ArtifactHead` | 채널 API 호출 |
| Content / Render | Artifact → 채널 포맷(Markdown, Notion blocks, 카드 이미지) | 렌더 결과 (파일 또는 메모리) | 내용 변경 (렌더는 표현만 바꾼다) |
| Approval | 공개 채널 대상 revision lock | `ApprovalRecord` | 승인 후 내용 변경 |
| Publish | 채널로 전송. idempotent. 사용자 수정 필드 보존 | `PublicationRecord` | Artifact 재생성, 사용자 필드 덮어쓰기 |

---

## 5. 모듈 지도 (논리 구조)

아래는 목표 논리 구조다. **실제 디렉터리는 필요한 시점에만 만든다.** Phase별 생성 시점은 `MIGRATION_AND_ACCEPTANCE.md` §5에 있다.

```
src/
  domain/
    documents/     RawObservation, NormalizedDocument, DocumentLink, ContentCompleteness
    entities/      Entity, EntityType, EntityAlias, EntityMention, EntityMerge, identity rules
    metrics/       MetricObservation, DerivedSignal, MetricScope, SignalStatus
    evidence/      Evidence, Claim, ClaimType, AnalysisRecord, evidence validation
    artifacts/     Artifact(revision 단위), ArtifactHead, ArtifactType, DailyBrief 계약, ApprovalRecord, PublicationRecord
    runs/          Run, RunStage, RunStatus, DomainEvent
    feedback/      FeedbackEvent
    shared/        ids(ULID/hash), time(TimeWindow), schemaVersion, Result 타입
  application/
    collect/       CollectSources (checkpoint, timeout, partial failure, raw store 기록)
    normalize/     NormalizeObservations, LinkAndDedupe
    analyze/       ResolveEntities, RecordMetrics, ClassifyDocuments, ExtractClaims (LLM, 검증 포함)
    trend/         ComputeSignals, TrendEngine 호출, TrendWatch 선택
    briefing/      BuildDailyBrief (ranking policy 적용, 섹션 구성), BuildWeeklyReport(향후)
    librarian/     ProposeKnowledgeUpdates, CheckKnowledgeSafety, ApplyKnowledgeUpdates
    publish/       RenderArtifact, RequestApproval(승인 규칙: PRIVATE 채널 POLICY 자동, PUBLIC 채널 USER 필수), PublishArtifact (idempotency, 사용자 필드 보존)
    runs/          RunDailyPipeline (단계 orchestration, Run 기록, 상태 판정)
  ports/
    sources/       SourceAdapter, SourceDescriptor, CollectRequest/Result
    storage/       RawStore, DocumentStore(documents, links), EntityStore(entities, aliases, merges, mentions), MetricStore(metrics, signals), ClaimStore(claims, evidence, analyses, classifications), ArtifactStore(artifacts, approvals, publications), RunStore(runs, run_events), CheckpointStore, FeedbackStore, KnowledgeProposalStore, UnitOfWork
    llm/           LlmProvider, LlmCapabilities, LlmTaskRouter
    rendering/     Renderer<TArtifact, TRendered>
    publishing/    Publisher, VaultPort(Obsidian 읽기/쓰기; 운영 adapter + in-memory 테스트 adapter)
    system/        Clock, Logger, HttpClient, EventSink
  adapters/
    sources/manual-json/   현재 data/daily-brief.json 경로를 Source로 흡수 (Phase 1)
    sources/hackernews/    (Phase 2)
    sources/rss/           (Phase 2)
    sources/github/        (Phase 3)
    sources/horizon/       (선택, 외부 프로세스 출력 ingest)
    storage/sqlite/        node:sqlite 기반 Store 구현 + migrations
    storage/fs/            raw payload / artifact 파일 저장
    storage/memory/        테스트용 in-memory Store
    llm/anthropic/, llm/openai/, llm/fake/
    notion/                NotionPublisher, NotionFeedbackReader
    obsidian/              ObsidianVault(VaultPort), Markdown 렌더 결과 쓰기
    rendering/markdown/, rendering/notion-blocks/
  policies/
    culture/       CULTURE ranking v1
    practical/     PRACTICAL ranking v1
    trend/         TREND ranking v1 + TrendEngine 계산 규칙 + metric profile
    classification/ editorial category 규칙, visibility.ts (PRIVATE/PUBLIC_OK 판정)
  runtime/
    config/        env → AppConfig (유일한 process.env 접근 지점)
    composition/   buildDailyPipeline 등 조립 함수
    cli/           `ai-radar daily --date`, `ai-radar publish`, `ai-radar reanalyze` (Phase별 추가)
    runs/          Run 시작/종료 기록, 로그 redaction
```

### 5.1 Deep module 관점의 핵심 seam

| Module | Interface (작게) | Implementation (깊게) |
| --- | --- | --- |
| `CollectSources` | `collect(window, sourceIds) → CollectSummary` | 소스별 timeout·abort, checkpoint 로드/저장, RawObservation dedupe(hash), partial failure 집계, 상태 판정(NO_NEW vs FAILED) |
| `ExtractClaims` | `extract(docIds, policy) → ClaimBatch` | prompt 조립(신뢰 경계 표시), provider 라우팅, schema validation, evidence ID 존재 검증, 재시도, AnalysisRecord 기록 |
| `TrendEngine` (policy) | `compute(series, profile) → TrendResult` | window 정렬, cold start, coverage 변화, 결측, INSUFFICIENT_DATA 판정 |
| `BuildDailyBrief` | `build(window, policies) → DailyBriefArtifact` | Intelligence 조회, 정책별 ranking, 섹션 채움/비움 규칙, 근거 링크 첨부, revision·hash |
| `PublishArtifact` | `publish(artifactId, channel) → PublicationRecord` | 승인 확인, 기존 publication 조회, 렌더, 채널별 사용자 필드 보존, 부분 실패 재시도, 기록 |
| `ProposeKnowledgeUpdates` | `propose(intelligence, vaultIndex) → Proposal[]` | entity ↔ note 매칭, 충돌 판정, managed region diff 계산 (순수) |

Adapter는 이 깊이를 갖지 않는다. 예를 들어 `HackerNewsSource`는 "API 호출 → RawObservation 배열 + coverage 보고"만 한다. 재시도와 checkpoint는 `CollectSources`의 책임이다. 이렇게 해야 Source가 10개가 되어도 재시도 로직이 한 곳에만 있다 (locality).

---

## 6. Horizon의 위치

Horizon은 `adapters/sources/horizon/` 에만 존재한다.

- 통합 방식은 OSS 검증 결과(`INTEGRATIONS_AND_SAFETY.md` §8)에 따라 **외부 프로세스로 `hz_fetch_items` 를 실행하고 `raw_items.json` 을 ingest** 하는 것으로 결정했다 (ADR-0003, `PIPELINES_AND_POLICIES.md` §2.3). Reddit fallback 체인과 SSRF guard의 TS 포팅은 별도 adapter(`sources/reddit`)의 향후 선택지다. 어느 쪽이든 Core가 보는 것은 `RawObservation` 뿐이다.
- Horizon이 사라져도 삭제되는 것은 그 디렉터리와 composition root의 한 줄뿐이다 (`MIGRATION_AND_ACCEPTANCE.md` 시나리오 1).
- Horizon 출력의 필드명·형식 변경은 그 adapter 안의 변환 함수와 fixture 테스트에만 영향을 준다.

---

## 7. 실행 모델

- 단일 Node 프로세스, CLI 진입. 스케줄링은 OS(Task Scheduler / cron) 또는 향후 GitHub Actions가 담당한다. 프로세스 내부에 스케줄러를 두지 않는다.
- 하나의 실행 = 하나의 `Run`. Run은 단계(`RunStage`) 단위로 checkpoint를 저장하고, 실패 시 같은 `runId`로 재개하거나 새 Run으로 재실행할 수 있다. 어느 쪽이든 idempotency key 덕분에 중복이 생기지 않는다.
- 이벤트(`ITEM_COLLECTED` … `PUBLICATION_COMPLETED`)는 Use Case가 `EventSink` Port로 발행한다. 초기 구현은 in-process 로그 + `run_events` 테이블 기록이다. 외부 bus는 두지 않는다.

---

## 8. 보안 경계 요약

| 권한 | 가진 모듈 | 갖지 않는 모듈 |
| --- | --- | --- |
| Secret 읽기 | `runtime/config` | 그 외 전부 (값을 인자로 받음) |
| 네트워크(수집) | `adapters/sources/*` | domain, application, policies |
| 네트워크(LLM) | `adapters/llm/*` | 그 외 |
| 파일시스템 쓰기 | `adapters/storage/fs`, `adapters/obsidian` | domain, application(포트 통해서만), LLM 관련 어떤 모듈도 직접 쓰기 불가 |
| Notion 쓰기 | `adapters/notion` (Publisher) | Collector, Analyzer |
| 공개 채널 게시 | `adapters/<channel>` Publisher + `RequestApproval`(ApprovalRecord) 통과 시에만 | Collector, Analyzer, Librarian |
| 셸 실행 | 없음. 프로세스 실행은 `adapters/sources/horizon`(Horizon 수집)과 `adapters/llm/codex-cli`(`codex exec`, read-only sandbox, `shell:false`)만 허용하며 셸 해석은 없다 | 그 외 전부 |

상세는 `INTEGRATIONS_AND_SAFETY.md` §5.

---

## 9. 확장 지점 요약

| 추가하려는 것 | 만드는 곳 | Core 변경 |
| --- | --- | --- |
| 새 Source | `adapters/sources/<name>/` + composition root 등록 + fixture 테스트 | 없음 |
| 새 EntityType | `domain/entities/EntityType` enum 값 + `policies/trend` metric profile | enum 추가 (계약 minor 버전) |
| 새 Metric | `domain/metrics/MetricKey` 등록 + Source adapter가 관측 기록 | key 등록만 |
| 새 Ranking Policy | `policies/<name>/` 새 버전 파일 | 없음 (BuildDailyBrief가 policy 목록을 인자로 받음) |
| 새 LLM Provider | `adapters/llm/<name>/` + capabilities 선언 + router 설정 | 없음 |
| 새 Artifact 타입 | `domain/artifacts/<Type>` 계약 + `application/<builder>` + Renderer | 없음 (ArtifactType enum 추가) |
| 새 출력 채널 | `adapters/<channel>/` Publisher + Renderer + 채널 visibility 정책 | 없음 |
| 새 저장소 | `adapters/storage/<db>/` 가 Store Port 구현 + migration | 없음 |

각 시나리오의 상세 검증은 `MIGRATION_AND_ACCEPTANCE.md` §6.
