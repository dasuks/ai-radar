# Migration and Acceptance

문서 버전: 1.0 (2026-09-12)

이 문서는 (1) 실제 repository에서 확인한 현재 구현 baseline, (2) 목표 아키텍처와의 gap, (3) 과거 이름 `ai-coding-radar` 이행, (4) Big Bang 없이 이행하는 Phase 계획, (5) 확장성 검증 시나리오, (6) 아키텍처 자동 검증 계획, (7) 설계 완료 조건을 담는다.

---

## 1. 현재 구현 Baseline (2026-09-12, repo 직접 검사)

검사 항목(Phase 0 착수 전 스냅샷): `git status`(clean, `main`, 커밋 1개 `9dd3486`), `package.json`, `tsconfig.json`(strict, nodenext, TS 7.0.2), `src/`(10 파일), `test/`(3 파일, 14 테스트 통과; Phase 0 후 `architecture.test.ts` 가 추가되어 4 파일 29건), `.gitignore`, `data/daily-brief.json`, 환경변수 사용처, Obsidian Vault 실제 파일, `npm run typecheck`/`npm test` 실행.

### 1.1 분류

| 기능 | 분류 | 근거 |
| --- | --- | --- |
| Daily Brief JSON 스키마 검증 | **1. 구현 + 테스트됨** | `src/schemas/briefing.ts` `parseBriefing`, `test/briefing.test.ts` 4건 |
| JSON → Obsidian Daily Note | **1. 구현 + 테스트됨** | `src/writers/obsidian-writer.ts`, Vault 경계 검사, 갱신 테스트 1건. 단 전체 덮어쓰기(R-O1) |
| Notion DB upsert (Date 기준, Read/Applied 보존) | **1. 구현 + 테스트됨** (fake client) | `src/writers/notion-writer.ts`, `test/notion-writer.test.ts` 5건 |
| Deterministic Obsidian Librarian | **1. 구현 + 테스트됨** | `src/librarian/obsidian-librarian.ts`, 4건. 실제 Vault에 결과 존재 (`02 Patterns/Verification Loop.md`) |
| `npm run daily` 진입점 | **2. 구현 + 검증 부족** | `src/run-daily.ts` 존재, typecheck 통과. end-to-end 자동 테스트 없음(실제 Notion 필요). 순차 throw로 Notion 실패 시 Librarian 미실행 |
| Notion data source 자동 탐색 | **2. 구현 + 검증 부족 / 6. 충돌** | 테스트는 있으나 설정 ID 불일치 시 다른 DB에 쓰는 동작이 위험(R-N1) |
| 로그 redaction | **2.** | `run-daily.ts` `errorMessage` 존재, 테스트 없음 |
| `TopicExtractor` seam | **3. 일부 구현** | interface + pass-through 구현 1개. Adapter가 하나뿐인 가설적 seam |
| 환경 설정 | **3. 일부 구현** | `config/paths.ts`(vault) + `run-daily.ts`(Notion) 두 곳에서 `process.env` |
| 소스 수집, LLM, semantic linking, GitHub Actions | **4. 문서에만 존재** | README "다음 Phase 예정 범위". 코드 없음 |
| Raw store, Entity, Metric, Signal, Trend, Claim/Evidence, Run 기록, schemaVersion, Event, Feedback, Approval/Publication, 아키텍처 테스트 | **5. 아직 없음** | – |
| Writers가 SDK를 직접 import하고 진입점이 직접 호출 | **6. 목표와 충돌** | Port 없음. 현재 규모에서는 정당하지만 Adapter로 이동 필요 |
| Librarian이 fs·매칭·콘텐츠 생성을 한 모듈에 결합 | **6.** | 순수 제안 계산과 VaultPort I/O 분리 필요 |
| `DailyBriefing` 에 schemaVersion/provenance 없음 | **6.** | R-P3 |
| `topic.type` 자유 문자열 | **6.** (경미) | `knowledgeType` enum + `00 Inbox` fallback 유지로 흡수 |

### 1.2 현재 실행 흐름 (사실)

```
run-daily.ts: dotenv → env 검사 → loadBriefing(data/daily-brief.json) → formatDailyMarkdown
  → writeObsidianDailyNote(전체 덮어쓰기) → writeNotionDailyBrief(Date upsert) → runObsidianLibrarian
  (어느 단계든 throw 시 종료, exitCode=1)
```

### 1.3 실제 사용자 데이터 (보호 대상)

- Vault `99 Daily/2026-09-12 AI Coding Daily Brief.md`, `02 Patterns/Verification Loop.md` 에 **레거시 마커 `ai-coding-radar:*` 가 이미 존재**한다. 마커 문자열 변경은 읽기 호환 없이는 데이터 손상이다.
- Notion DB에 기존 페이지와 사용자 체크박스가 존재한다고 가정한다.

---

## 2. Gap 요약 (현재 → 목표)

| 영역 | 현재 | 목표 | 이행 Phase |
| --- | --- | --- | --- |
| 진입/조립 | `run-daily.ts` 직접 호출 | `runtime/composition` + `RunDailyPipeline` | 1 |
| 계약 | `DailyBriefing`(암묵 v1) | `Artifact<DailyBriefBody v2>` + upcast | 1 |
| Run | 없음 | Run 기록(JSON → DB) + 상태 판정 | 1(JSON) / 2(DB) |
| 출력 | writers 직접 | Publisher Port + 채널 격리 + PublicationRecord | 1 |
| Obsidian 안전 | Daily 전체 덮어쓰기, 관리영역 무조건 교체 | 관리 영역 + managedHash + 레거시 마커 호환 | 1(daily) / 5(librarian v2) |
| Notion 안전 | schema fallback 기본 on | opt-in | 1 |
| Source | 없음 | SourceAdapter Port + manual-json adapter: 1 / CollectSources + checkpoint + HN·RSS: 2 |
| Storage | 파일 1개 | SQLite + raw 파일 + artifact 파일 | 2 |
| Entity/Metric | 없음 | 계약 + 결정적 해석 + scope validator | 3 |
| LLM | 없음 | Provider Port + Router + 검증 | 3 |
| Ranking/Brief 자동 생성 | 수동 JSON | 정책 v1 + BuildDailyBrief | 3 |
| Trend | 없음 | TrendEngine + TREND_WATCH | 4 |
| Feedback | 없음 | NotionFeedbackReader + Profile | 4 |
| Approval/공개 채널 | 없음 | RequestApproval + ApprovalRecord + 채널 정책 | 6 |
| 아키텍처 강제 | 없음 | `test/architecture.test.ts` | 0 |

---

## 3. 이름 이행 (`ai-coding-radar` → `ai-radar`)

### 3.1 발견 위치와 분류

| 위치 | 내용 | 분류 | 처리 |
| --- | --- | --- | --- |
| `package.json` `name`, `description` | `ai-coding-radar` | 1. 프로젝트 명칭 | **Phase 0에서 변경** (`ai-radar`) |
| `package-lock.json` `name` ×2 | 동일 | 1. | Phase 0에서 변경 (lockfile은 `npm install` 로 재생성해도 동일 결과) |
| `README.md` 제목·본문 | "AI Coding Radar" | 1. + 3. 역사 설명 | Phase 0에서 제목/소개 변경, 과거 Phase 1–3 설명은 "이전 이름" 주석과 함께 유지 |
| `src/librarian/obsidian-librarian.ts` 마커 상수 4종 + evidence 마커 | `<!-- ai-coding-radar:… -->` | **persisted format 식별자** (환경변수와 같은 취급) | Phase 0 변경 금지. Phase 1에서 `ai-radar:*` 쓰기 + 레거시 읽기 호환 (§3.3) |
| `src/schemas/briefing.ts`, `src/writers/obsidian-writer.ts`, 테스트, README, `data/daily-brief.json` | 기본 제목 "AI Coding Daily Brief" | 1. 산출물 명칭 | Phase 1에서 "AI Intelligence Daily" 로 변경. **Phase 0에서 바꾸지 않는 이유**: Daily Note 파일명이 제목을 포함하므로(R-O3) 지금 바꾸면 기존 `2026-09-12 AI Coding Daily Brief.md` 옆에 중복 노트가 생긴다. 날짜 기준 조회와 함께 바꾼다 |
| Notion Integration 표시명 "AI Coding Radar Integration" | 외부 | 2. 외부 Integration | 변경 안 함. 토큰·권한과 무관 |
| Notion DB 제목 "AI Coding Daily" | 외부 | 2. | 변경 안 함. 코드는 ID 참조. 사용자가 원하면 Notion에서 직접 변경 |
| `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `OBSIDIAN_VAULT_PATH` | 환경변수 | 4. | 유지 |
| `.test-dist/` | 빌드 산출물 | – | ignore됨, 재생성 |

### 3.2 DailyBriefing v1 → DailyBriefBody v2 upcast

```
v1 (bodySchemaVersion 없음): { date, title, summary[], topics[{id,title,type,importance,whatChanged,whyItMatters,howDevelopersUseIt,howToApply,related[],sources[]}] }
→ v2: oneMinuteSummary = summary
       sections = [{ kind: "AI_CODING", items: topics.map(t → BriefItem{ id: "item_"+sha256(artifactId ┃ t.id)[:16], title, importance, whatChanged, whyItMatters, howDevelopersUseIt, howToApply,
                     claimIds: [], entityIds: [], trend: null, sourceRefs: t.sources → { documentId: "doc_"+sha256("manual-json" ┃ canonicalUrl(url))[:24], title, url, sourceId: "manual-json", publishedAt: null }, rankingTrace: {policyId:"manual", policyVersion:"0", score:importance, reasons:["manual input"]},
                     knowledgeType: t.type ∈ enum ? t.type : null, related: t.related }) }]
       learnOneThing = 최고 importance item, applyCandidates = howToApply 있는 item, sources = 합집합, coverage = { sourcesAttempted:["manual-json"], sourcesFailed:[], partial:false, note:null }
```

수동 입력 brief는 `claimIds` 가 비어 있으므로 "claim 없는 item 금지" 규칙의 예외다. 예외는 `rankingTrace.policyId === "manual"` 로만 허용하고, Phase 3 이후 자동 생성 brief에는 적용하지 않는다. `documentId` 는 CONTRACTS §0.2 규칙과 같은 방식(`doc_` + hash(sourceId ┃ externalId), externalId = canonical URL)으로 만들어, Phase 2에서 manual-json Source adapter가 같은 문서를 `documents` 에 기록할 때 ID가 일치한다. 이 override 경로는 Phase 4에서 제거된다.

### 3.3 마커 호환 규칙

- 읽기: `ai-radar:<region>` 을 먼저 찾고, 없으면 `ai-coding-radar:<region>` 을 찾는다.
- 쓰기: 항상 `ai-radar:<region>`. 관리 영역 교체 시 레거시 마커까지 포함해 교체하므로 파일은 자연스럽게 새 마커로 이행한다.
- 테스트: 레거시 마커가 있는 fixture 노트를 갱신하면 (a) 사용자 영역 보존, (b) 관리 영역 1개만 존재, (c) 새 마커 사용.

---

## 4. Migration Phases

원칙: Big Bang 금지. 각 Phase 종료 시 `npm run daily` 가 기존 입력으로 동작하고 기존 테스트(또는 같은 seam의 대체 테스트)가 통과한다. Phase 안에서도 작은 PR 단위로 나눈다.

### Phase 0 — 설계 패키지 (이 세션)

| 항목 | 내용 |
| --- | --- |
| 목표 | 아키텍처·계약·정책·이행 계획 문서화, ADR, AGENTS.md, 이름 이행 1차, 아키텍처 테스트 골격 |
| 변경 파일 | `docs/architecture/*.md`, `docs/adr/*.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`(name/description/test script), `package-lock.json`(name), `README.md`(제목/소개/문서 링크), `.gitignore`(`.brainpane/`, `data/store/`), `test/architecture.test.ts` |
| 신규 contract | 없음 (문서만) |
| Backward compatibility | 런타임 동작 변화 없음 |
| Test | `npm run typecheck`, `npm test` (기존 14 + 아키텍처 테스트) 통과 |
| Done | §8 완료 조건 전부 문서에 존재. 문서 간 용어·참조 모순 없음. 커밋은 사용자가 수행 |
| Rollback | 파일 삭제/`git checkout` (런타임 영향 없음) |

### Phase 1 — Artifact·Publish 경계와 사용자 데이터 안전

| 항목 | 내용 |
| --- | --- |
| 목표 | 현재 기능을 유지한 채 Domain/Application/Ports/Adapters/Runtime 골격을 세우고, R-N1·R-O1·R-O3·R-P1·R-P2·R-P3·R-S1 을 해소 |
| 변경 파일 | 신규: `src/domain/artifacts/daily-brief.ts`(v2 + upcast), `src/domain/runs/run.ts`, `src/domain/shared/{ids,hash,markers}.ts`, `src/ports/publishing/{publisher,vault}.ts`, `src/ports/sources/source-adapter.ts`(manual-json만 구현), `src/application/publish/publish-artifact.ts`, `src/application/runs/run-daily-pipeline.ts`, `src/runtime/{config,composition,cli}/`. 이동: `writers/notion-writer.ts` → `adapters/notion/notion-publisher.ts`, `writers/obsidian-writer.ts` + `formatters/daily-markdown.ts` → `adapters/obsidian/` + `adapters/rendering/markdown/`, `librarian/*` → `application/librarian/`(순수 부분) + `adapters/obsidian/vault.ts`(I/O), `loaders/briefing-loader.ts` → `adapters/sources/manual-json/`. `src/run-daily.ts` 는 **삭제**하고 `package.json` 의 `daily` 스크립트를 `tsx src/runtime/cli/daily.ts` 로 바꾼다 (`npm run daily` 명령은 그대로). shim을 남기면 LEGACY allowlist가 비워지지 않으므로 남기지 않는다. 권장 PR 분할: (1) `runtime/config` + composition root + CLI 이동, (2) Artifact v2 + upcast, (3) Notion/Obsidian adapter 이동 + Publisher Port + 채널 격리 + Run 기록, (4) Daily Note 관리 영역 + 날짜 조회 + 제목 변경, (5) Librarian 분리 + 마커 v2. 각 PR에서 이동한 파일만 allowlist에서 제거한다 |
| 신규 contract | `Artifact<DailyBriefBody v2>`, `Run`(JSON 파일 `data/store/runs/<runId>.json`), `PublicationRecord`(JSON, Phase 2에서 DB로), 마커 v2 |
| 동작 변경 | (a) 채널 실패 격리: Notion 실패해도 Obsidian·Librarian 진행, Run status PARTIAL_SUCCESS. (b) Daily Note는 `<!-- ai-radar:daily:start/end -->` 관리 영역만 교체, 기존 파일의 사용자 텍스트 보존. (c) Daily Note 조회는 `99 Daily/<date> *.md` 날짜 접두로 하고 없을 때만 생성. 기본 제목 "AI Intelligence Daily". (d) Notion schema fallback 기본 off. (e) `process.env` 는 `runtime/config` 만 |
| Backward compatibility | `data/daily-brief.json` v1 형식 그대로 입력 가능(upcast). 환경변수 동일. 기존 Vault 파일·마커 읽기 호환. Notion 속성 동일 |
| Test | 기존 테스트를 새 seam으로 이동(replace, don't layer): Notion publisher(fake client) 5건 중 4건 유지, "설정 ID가 일치하지 않아도 스키마가 유일하게 일치하면 저장한다" 1건은 "기본값에서는 거부한다" 로 재작성하고 opt-in 플래그 시 허용 1건 추가, Librarian 4건 유지 + 레거시 마커 fixture 1건, Daily Note 관리영역 보존 1건, upcast 1건, Run status 판정(채널 실패 조합) 3건, config 단일화 1건, 아키텍처 테스트 legacy allowlist 축소 |
| Done | 위 테스트 통과. 실제 Vault의 `2026-09-12` 노트로 dry-run(`--dry-run` 플래그: 파일 대신 diff 출력) 결과에 사용자 텍스트 손실 없음. `npm run daily` 실제 실행 1회 성공 및 Notion 페이지 Read/Applied 유지 확인 |
| Rollback | `git revert`. 데이터 형식 변경 없음(마커는 읽기 호환이므로 옛 코드로 돌아가도 새 마커 노트는 "관리 영역 없음"으로 취급되어 새 관리 영역이 추가될 수 있음 → rollback 시 Vault Git으로 복구) |

### Phase 2 — Raw Store, Storage, 첫 Source

| 항목 | 내용 |
| --- | --- |
| 목표 | 수집 → Raw → Normalized → Link 경로와 SQLite 저장소, Run DB 기록, 상태 판정 완성. Daily 생성은 아직 수동 JSON |
| 변경 파일 | `src/domain/documents/*`, `src/ports/storage/*`, `src/adapters/storage/{sqlite,fs,memory}/`, `src/adapters/storage/sqlite/migrations/0001_init.ts`(SQL 문자열 모듈), `src/application/collect/*`, `src/application/normalize/*`, `src/adapters/sources/{hackernews,rss}/`, 선택 `adapters/sources/horizon/`, `runtime/cli/collect.ts` |
| 신규 contract | RawObservation, NormalizedDocument, DocumentLink, SourceAdapter, CollectResult, source_checkpoints |
| Backward compatibility | Daily 경로 변화 없음. `data/store/` 신설(gitignore) |
| Test | in-memory Store로 CollectSources 상태 판정(NO_NEW/PARTIAL/FAILED) 5건, idempotent 재실행(같은 window 2회 → raw 건수 불변) 1건, HN/RSS fixture normalize 각 2건, SQLite migration 적용/재적용 1건, canonical URL 정규화 1건, Horizon `raw_items.json` fixture 변환 1건(채택 시) |
| Done | `ai-radar collect --window 24h` 두 번 실행 시 두 번째 Run이 NO_NEW_INFORMATION 또는 신규분만 기록. 소스 하나를 강제 실패시켰을 때 Run이 PARTIAL_SUCCESS 이고 coverage에 기록됨 |
| Rollback | `data/store/` 삭제 + revert. Daily 경로 무영향 |
| 위험 | `node:sqlite` experimental(§7.6 CONTRACTS). Horizon 실행 방식 UNVERIFIED |

### Phase 3 — Entity·Metric·LLM·자동 Daily

| 항목 | 내용 |
| --- | --- |
| 목표 | 자동 Daily Brief 생성(CULTURE·PRACTICAL 정책, TREND_WATCH 없음). 근거 없는 문장 없음 |
| 변경 파일 | `domain/{entities,metrics,evidence}`, `ports/llm`, `adapters/llm/{anthropic,openai,fake}`, `application/analyze/*`, `application/briefing/build-daily-brief.ts`, `policies/{culture,practical,classification}`, `adapters/sources/github/`(agents-radar 포팅, `THIRD_PARTY_NOTICES.md` 에 MIT attribution), `runtime/cli/daily.ts` 확장 |
| 신규 contract | Entity*, MetricObservation, Evidence, Claim, AnalysisRecord, Classification, LlmRequest/Response, RankingPolicy |
| Backward compatibility | `data/daily-brief.json` 이 존재하면 우선(수동 override), 없으면 자동 생성. 환경변수 추가(`ANTHROPIC_API_KEY` 등)는 optional |
| Test | evidence 미존재 ID 거부, claim type 불변 조건, scope validator 거부, injection fixture(지시문 포함 문서 → schema 유지), LLM 캐시 재사용, ranking reasons 비어있지 않음, 빈 섹션 생략, contentHash 동일 시 revision 불변, fake provider로 end-to-end |
| Done | 실제 provider로 1회 생성한 Daily의 모든 item이 `claimIds ≥ 1`, 모든 claim이 evidence 존재. Notion/Obsidian 발행 성공. LLM 비용이 Run에 기록 |
| Rollback | 자동 생성 비활성 플래그(`AI_RADAR_AUTO_BRIEF=false`)로 수동 경로 복귀 |

### Phase 4 — Trend·Feedback

| 항목 | 내용 |
| --- | --- |
| 목표 | DerivedSignal, TREND_WATCH 섹션, Notion 피드백 동기화 |
| 변경 파일 | `domain/metrics/derived-signal.ts`, `policies/trend/*`, `application/trend/*`, `adapters/notion/feedback-reader.ts`, `application/feedback/sync-feedback.ts`, `domain/feedback`, `application/briefing/build-daily-brief.ts`(ranking.trend 등록·TREND_WATCH), `adapters/sources/manual-json`(override 경로 제거, 입력을 `data/input/` 로 이동) |
| 신규 contract | DerivedSignal, DerivedSignalRef, FeedbackEvent, FeedbackProfile, MetricProfile |
| Backward compatibility | 수동 override(`data/daily-brief.json` 우선) 제거. 수동 brief는 이후 manual-json Source의 문서로만 취급된다. 환경변수 변화 없음 |
| Test | cold start → COLD_START, coverage 변화 → COVERAGE_CHANGED, 소스 실패 → SOURCE_FAILURE, 정상 velocity 계산, cross-post 중복이 mention 1로 집계, TREND_WATCH 생략 조건, Read 해제가 이벤트를 만들지 않음 |
| Done | 최소 14일 관측 후 TREND_WATCH 가 근거 metric과 함께 표시되거나 INSUFFICIENT_DATA 로 생략됨 |
| Rollback | policy 버전 삭제(derived_signals는 재계산 가능) |

### Phase 5 — Librarian v2

| 항목 | 내용 |
| --- | --- |
| 목표 | Proposal → Safety → Apply 흐름, frontmatter entityId, NEEDS_REVIEW CLI |
| 변경 파일 | `application/librarian/{propose,check-safety,apply}.ts`, `adapters/obsidian/vault.ts`(frontmatter 읽기·managedHash), `runtime/cli/librarian.ts`(review), `adapters/obsidian/feedback-reader.ts`(frontmatter feedback) |
| 신규 contract | KnowledgeUpdateProposal, 노트 frontmatter `ai-radar` 블록(entityId, type, schemaVersion, managedHash, feedback) |
| Backward compatibility | frontmatter 없는 기존 노트는 제목 매칭으로 계속 동작하고, 첫 갱신 때 frontmatter가 추가된다. 사용자 영역 무변경 |
| Test | AMBIGUOUS_MATCH 보류, USER_EDITED_MANAGED_REGION 보류, CONTRADICTS_EXISTING 제안만, 노트 수 상한, 레거시 노트 이행 |
| Done | 실제 Vault dry-run에서 제안 목록이 사람 검토 가능한 형태로 출력되고 AUTO_APPLY 만 적용됨 |
| Rollback | Vault Git |

### Phase 6 — 채널 확장·공개 게시

| 항목 | 내용 |
| --- | --- |
| 목표 | RequestApproval/ApprovalRecord, Weekly Report, Discord/Email, Instagram(UNVERIFIED 해소 후) |
| 변경 파일 | `application/publish/request-approval.ts`, `application/briefing/build-weekly-report.ts`, `adapters/{discord,email,instagram}/`, `adapters/rendering/{html,instagram-card}/`, `runtime/cli/{approve,publish}.ts` |
| 신규 contract | ApprovalRecord(실사용), WeeklyReportBody, SocialPostDraftBody, 채널 visibility 정책 표 |
| Backward compatibility | notion/obsidian 채널은 POLICY 자동 승인이므로 동작 변화 없음. 새 채널은 config에 등록해야만 활성 |
| Rollback | 새 채널 adapter를 composition root에서 제거. `publications` 의 해당 채널 row는 남긴다(이력) |
| Test | PRIVATE artifact → public 채널 거부, 승인 후 hash 변경 → 발행 거부, 부분 실패 재시도 중복 없음, RETRACTION 흐름 |
| Done | 승인 없이 공개 채널로 나가는 코드 경로가 존재하지 않음(아키텍처 테스트) |

---

## 5. 디렉터리 생성 시점

| 디렉터리 | Phase |
| --- | --- |
| `docs/architecture`, `docs/adr`, `test/architecture.test.ts` | 0 |
| `src/domain/{artifacts,runs,shared}`, `src/application/{publish,runs,librarian}`, `src/ports/{publishing,sources}`, `src/adapters/{notion,obsidian,rendering,sources/manual-json}`, `src/runtime/{config,composition,cli}` | 1 |
| `src/domain/documents`, `src/ports/storage`, `src/adapters/storage/*`, `src/application/{collect,normalize}`, `src/adapters/sources/{hackernews,rss,horizon}`, `src/adapters/storage/sqlite/migrations/` | 2 |
| `src/domain/{entities,metrics,evidence}`, `src/ports/llm`, `src/adapters/llm/*`, `src/application/{analyze,briefing}`, `src/policies/{culture,practical,classification}`, `src/adapters/sources/github` | 3 |
| `src/policies/trend`, `src/application/{trend,feedback}`, `src/domain/feedback` | 4 |
| 나머지 채널 adapter | 6 |

빈 디렉터리를 미리 만들지 않는다.

---

## 6. 확장성 검증 시나리오

<!-- extension-scenarios:start -->

이 절은 목표 아키텍처가 실제로 확장 가능한지를 20개의 구체 시나리오로 검증한다. 각 시나리오는 "어디를 만지는가 / Core 계약이 바뀌는가 / migration이 필요한가" 를 같은 7개 항목으로 답한다. 판정 기준은 `ARCHITECTURE.md` §3.1(계층 규칙)·§9(확장 지점), `CONTRACTS_AND_DATA.md` §0.1(schemaVersion)·§7(Storage), `PIPELINES_AND_POLICIES.md` §2·§6·§7, `INTEGRATIONS_AND_SAFETY.md` §6(발행 경계)이다. 검증 중 문서가 답하지 못한 지점은 발명하지 않고 기록했으며, 모두 이 설계 패키지 안에서 해소했다. 목록과 해소 위치는 §6.22 에 있다.

### 6.1 Horizon 제거

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/adapters/sources/horizon/` 디렉터리 삭제, `src/runtime/composition/` 의 adapter 등록 1줄 삭제 |
| 새 adapter | 없음 |
| Core 변경 여부 | 없음. Core는 `RawObservation` 만 알고(ARCHITECTURE §6), ARCH-10이 `horizon`·`ContentItem` 식별자가 domain/application/ports에 없음을 이미 강제한다 |
| migration 여부 | 없음. `raw_observations` 의 `source_id LIKE 'horizon:%'` row와 `raw/horizon:*/` payload 파일은 삭제하지 않는다(CONTRACTS §7.2: Raw Store는 삭제 안 함). `source_checkpoints` 의 horizon row는 남아도 무해 |
| config | AppConfig의 horizon 실행 항목(고정 명령, runs root, 전용 `data/config.json` 경로) 제거 |
| 테스트 | `raw_items.json` fixture 변환 테스트 1건 삭제. ARCH-08을 "`child_process` import 0건" 으로 강화. CollectSources 상태 판정 테스트는 무영향 |
| 예상 위험 | `horizon:<source_type>` 로만 들어오던 소스의 커버리지 공백. 직접 수집 adapter가 없으면 해당 entity의 window별 `coverage.sourcesSucceeded` 집합이 바뀌어 TrendEngine이 `COVERAGE_CHANGED` 를 낸다(PIPELINES §7.2). 이는 거짓 하락을 trend로 보지 않게 하는 의도된 동작이다 |

### 6.2 Reddit 직접 수집 추가

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/sources/reddit/`(`index.ts`, `normalize.ts`, `fixtures/`) + composition root 등록 |
| 새 adapter | `RedditSource`(SourceAdapter, `kind: "API"`, `sourceId = "reddit:<subreddit>"`). Horizon(MIT)의 JSON → RSS → old.reddit HTML fallback 체인을 TS로 포팅하고 `THIRD_PARTY_NOTICES.md` 에 attribution (INTEGRATIONS §8.1 결정) |
| Core 변경 여부 | 없음. `RawObservation` 불변, MetricKey `reddit.score`·`reddit.comments` 이미 등록됨(CONTRACTS §3.1) |
| migration 여부 | 없음 |
| config | AppConfig `sources.reddit.subreddits[]`, `limits.requestsPerMinute`, `userAgent`. 비인증 경로이므로 자격증명 없음 |
| 테스트 | fallback 단계별 fixture 3건(JSON 200 / JSON 403 후 RSS 성공 / 둘 다 실패 후 old.reddit), completeness 판정(TITLE_ONLY + comments) 1건, `horizon:reddit` 문서와 `SAME_URL` link 생성 1건, 같은 window 2회 실행 시 raw 건수 불변 1건 |
| 예상 위험 | fallback 경로마다 다른 식별자를 뽑으면 같은 글이 2개 document가 된다. `externalId` 를 항상 Reddit fullname(`t3_…`)으로 고정해 `(sourceId, externalId)` 를 일치시킨다. 차단 시 `errors.kind = "ACCESS"` 와 `status: "FAILED"` 로 보고하고 checkpoint는 유지한다(PIPELINES §2.1) |

### 6.3 GitHub Issues/PR collector

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/sources/github/`(Phase 3, §5 디렉터리 표) + composition root 등록 |
| 새 adapter | `GithubSource`(`kind: "API"`, `sourceId = "github:issues"` / `"github:pulls"` / `"github:releases"`). agents-radar `github.ts` 의 `since` pagination과 `/pulls` client-side filter를 포팅, MIT attribution을 `THIRD_PARTY_NOTICES.md` 에 기록(INTEGRATIONS §8.2) |
| Core 변경 여부 | 없음. MetricKey `github.stars`·`github.forks`·`github.open_issues`·`github.release_count` 이미 등록됨 |
| migration 여부 | 없음 |
| config | AppConfig `sources.github.repos[]`(agents-radar `config.yml` 목록 포팅), `GITHUB_TOKEN` optional. 토큰은 `runtime/config` 만 읽고 `new GithubSource({ token })` 로 주입(PIPELINES §2.1) |
| 테스트 | `since` pagination fixture 2건, REPOSITORY entity에 `github.stars(scope=REPOSITORY)` 기록 1건, SKILL entity에 `github.stars` 기록 시 scope validator 거부 1건, rate limit 시 `PARTIAL` + `truncationReason: "RATE_LIMIT"` 1건, Issue 본문이 untrusted 블록으로만 LLM에 전달됨 1건 |
| 예상 위험 | GitHub REST `since` 동작과 토큰 유무별 rate limit은 UNVERIFIED EXTERNAL CONSTRAINT(§8.1). Issue/PR 본문은 비신뢰 데이터이므로 명령·경로로 해석 금지(INTEGRATIONS §5.1) |

### 6.4 YouTube transcript source

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/sources/youtube/` + composition root 등록 |
| 새 adapter | `YoutubeSource`(`kind: "API"`, `sourceId = "youtube:<channelId>"`). transcript 유무에 따라 `completeness` 를 FULL / EXCERPT(설명만) / TITLE_ONLY 로 정직하게 판정 |
| Core 변경 여부 | 없음. MetricKey `youtube.views` 이미 등록, `MetricScope` 에 `CHANNEL` 이미 존재 |
| migration 여부 | 없음 |
| config | AppConfig `sources.youtube.channels[]`, `YOUTUBE_API_KEY`, `maxItemsPerRun` |
| 테스트 | transcript 있는/없는 fixture 각 1건, `youtube.views` 를 `scope=ITEM`(영상)과 `scope=CHANNEL`(채널 구독자 등)으로 섞지 않는 validator 1건, transcript 오프셋이 `EvidenceLocator.excerpt` 의 start/end와 일치 1건 |
| 예상 위험 | 자막 이용 조건이 소스마다 다르다. `SourceDescriptor.license.attributionRequired` 에 기록하고 파생 Claim의 기본 visibility는 PRIVATE(CONTRACTS §5.4). transcript 확보 수단(공식 Captions API는 OAuth 필요)은 UNVERIFIED EXTERNAL CONSTRAINT로 §8.1 표에 추가한다 |

해소: YouTube 채널은 그 채널을 소유한 PERSON/COMPANY entity로 두고, 구독자 수 등은 `scope=CHANNEL` metric으로 그 entity에 기록한다. 채널 전용 EntityType은 두지 않는다 (CONTRACTS §3.1).

### 6.5 Arxiv source

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/sources/arxiv/` + composition root 등록 |
| 새 adapter | `ArxivSource`(`kind: "API"`, `sourceId = "arxiv:<category>"`). agents-radar `arxiv.ts` 를 포팅하되 regex Atom 파싱을 결정적 XML 파서로 교체(INTEGRATIONS §8.2: regex 파싱은 취약으로 기록됨). MIT attribution 기록 |
| Core 변경 여부 | 없음. 초록은 `completeness: "FULL"`. MetricKey `arxiv.citations` 는 이미 등록되어 있으나 Atom feed가 인용 수를 주지 않으므로 초기에는 관측 기록 없음(추정으로 채우지 않는다) |
| migration 여부 | 없음 |
| config | AppConfig `sources.arxiv.categories[]`(예: `cs.AI`, `cs.CL`), `maxItemsPerRun`, `defaultTimeoutMs` |
| 테스트 | Atom fixture 파싱 2건(정상 / 엔티티 이스케이프·CDATA), `externalId` 를 버전 접미사 제거한 arXiv id로 정규화 1건, 같은 논문의 v1/v2 재수집이 document 1건 + observation 2건이 되는지 1건 |
| 예상 위험 | XML 파서를 쓰려면 런타임 의존성이 늘어난다. 파서 없이 regex로 남기면 포팅한 취약점을 그대로 들여온다 |

해소: ARCHITECTURE §2.3 의존성 정책. XML 파서는 adapters 계층에서 내장 대체가 없고 허용 라이선스이면 도입 가능하다.

### 6.6 새로운 Entity type 추가 (예: DATASET)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/domain/entities/` 의 `EntityType` 에 `"DATASET"` 추가, `src/policies/trend/` 의 metric profile 표에 DATASET 항목 추가. `domain/entities/identity.ts` 는 type을 비교만 하므로 변경 없음 |
| 새 adapter | 없음. HF dataset URL(`huggingface.co/datasets/<org>/<name>`)을 결정적으로 인식하려면 `ResolveEntities` 의 URL 패턴 규칙 1줄 추가(PIPELINES §3.3) |
| Core 변경 여부 | **enum 추가(계약 minor)**. CONTRACTS §0.1에 따라 `Entity.schemaVersion` 은 1을 유지하고 upcast는 불필요하다(기존 row에 DATASET 값이 없다) |
| migration 여부 | 없음. `entities.type` 은 TEXT 컬럼이라 DDL 변경이 없다 |
| config | 없음 |
| 테스트 | metric profile을 `Record<EntityType, MetricProfile>` 로 두어 신규 enum 누락 시 typecheck 실패 1건, scope validator가 DATASET + `github.stars` 를 거부 1건, DATASET entity의 TrendEngine 결과가 관측 부족 시 `INSUFFICIENT_DATA` 1건 |
| 예상 위험 | enum만 늘고 metric profile이 빠지면 `trend_score` 를 계산할 수 없다. profile 매핑을 전수 Record로 강제해 컴파일 단계에서 막는다. ARCHITECTURE §9의 "새 EntityType = enum 추가" 판정과 일치 |

### 6.7 Skill Trend

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/policies/trend/` 의 SKILL metric profile만. **TrendEngine과 `application/trend/ComputeSignals` 는 변경 없음**. 같은 엔진에 다른 `MetricProfile` 을 넣는 것이 전부다(PIPELINES §7.1) |
| 새 adapter | 없음 |
| Core 변경 여부 | 없음. `EntityType "SKILL"` 과 `radar.mentions` 모두 이미 존재 |
| migration 여부 | 없음. `derived_signals` PK에 `policy_version` 이 포함되어 profile 조정은 새 row로 공존한다 |
| config | TREND ranking 임계값과 `policies/trend` 버전 선택 |
| 테스트 | SKILL entity에 `github.stars` 를 기록하려 하면 scope validator가 거부 1건(CONTRACTS §3.1), cross-post가 link cluster 단위로 mention 1로 집계 1건, `source_diversity < 2` 인 단일 소스 spike가 TREND 점수 0 1건 |
| 예상 위험 | Skill이 어떤 repository에서 배포된다는 이유로 그 repo의 star를 인기로 쓰는 실수 |

다른 점: SKILL profile의 primary는 `radar.mentions`, secondary는 `source_diversity` 뿐이다(PIPELINES §7.2). REPOSITORY profile과 달리 `github.stars` 와 `star_delta_7d` 가 없다. `Entity.parentEntityId` 로 repository와 연결되어 있어도 metric은 상속되지 않는다. star는 `scope=REPOSITORY` + `subjectType=ENTITY(REPOSITORY)` 로만 저장 가능하므로 저장 단계에서 이미 막힌다.

### 6.8 MCP Trend

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/policies/trend/` 의 MCP_SERVER metric profile만. TrendEngine·ComputeSignals 무변경(§6.7과 동일 메커니즘) |
| 새 adapter | 없음. MCP 서버 목록을 직접 수집하려면 별도 Source 시나리오가 되며 이 시나리오 범위 밖이다 |
| Core 변경 여부 | 없음. `EntityType "MCP_SERVER"`, `Entity.ecosystem = "mcp"` 이미 존재 |
| migration 여부 | 없음 |
| config | TREND 임계값, `policies/trend` 버전 |
| 테스트 | MCP_SERVER + `github.stars` 거부 1건, parent REPOSITORY의 `star_delta_7d` 가 MCP_SERVER의 `trend_score` 입력에 섞이지 않음 1건, `radar.mentions` 만으로 `trend_score` 가 계산되거나 `INSUFFICIENT_DATA` 1건 |
| 예상 위험 | MCP 서버는 거의 항상 repository를 동반하므로 두 entity의 신호를 무심코 합치기 쉽다 |

다른 점: MCP_SERVER profile의 primary도 `radar.mentions` 다(PIPELINES §7.2). 서버와 그 repository는 서로 다른 Entity이고, star는 REPOSITORY entity에만 기록된다. 두 entity의 신호를 함께 보려면 정책이 명시적으로 두 subject를 조회해야 하며 자동 상속 경로는 없다.

해소: 상속·자동 집계는 없다 (CONTRACTS §2.1 규칙 7). MCP_SERVER의 trend는 `radar.mentions` 로만 계산하고, REPOSITORY star는 그 REPOSITORY entity의 별도 trend로 함께 표시한다.

### 6.9 Model Trend

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/policies/trend/` 의 MODEL metric profile만. TrendEngine·ComputeSignals 무변경(§6.7과 동일 메커니즘) |
| 새 adapter | 없음 |
| Core 변경 여부 | 없음. `EntityType "MODEL"` 과 `Entity.versionLabel` 이미 존재 |
| migration 여부 | 없음 |
| config | TREND 임계값, `policies/trend` 버전 |
| 테스트 | `huggingface.co/<org>/<model>` URL의 결정적 MODEL 후보 추출 1건(PIPELINES §3.3), 이전 window 관측 0건 → `COLD_START`(증가율을 무한대로 만들지 않음) 1건, MODEL + `github.stars` 거부 1건 |
| 예상 위험 | 모델 버전이 빠르게 갈리는 도메인이라 mention이 어느 단위로 모이는지가 결과를 지배한다 |

다른 점: MODEL profile의 primary도 `radar.mentions`, secondary는 `source_diversity` 다. REPOSITORY만 `github.stars` 를 primary로 갖는다. 모델 버전은 별도 Entity가 아니라 `Entity.versionLabel` 필드이므로(CONTRACTS §2.1) 같은 모델 계열의 mention은 하나의 시계열로 합쳐진다.

해소: 버전 단위 시계열이 필요하면 사람이 `ai-radar entities split` 으로 자식 MODEL entity(parentEntityId 연결)를 만든다. 그 전까지는 family entity 하나의 시계열이다 (CONTRACTS §2.1 규칙 6).

### 6.10 LLM Provider 교체 (Anthropic → Gemini, 또는 Local model 추가)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/llm/gemini/`(또는 `src/adapters/llm/local/`) + composition root 등록. `application/analyze/*` 는 변경 없음 |
| 새 adapter | `LlmProvider` 구현 1개 + `capabilities(model)` 선언(`structuredOutput`, `toolCalling`, `maxContextTokens`, `usageMetadata`) |
| Core 변경 여부 | 없음. `LlmRequest`/`LlmResponse` 는 provider 중립이고, provider SDK 타입이 `ports/llm` 에 나타나면 ARCH-05 위반이다 |
| migration 여부 | 없음. 기존 `analyses` row의 `provider`·`model` 컬럼과 Provenance는 그대로 남아 과거 결과가 어느 provider 산출인지 계속 추적된다 |
| config | `llm-routing.json` 의 task → (provider, model, fallback) 항목 교체, `GEMINI_API_KEY` 등은 `runtime/config` 에서만 읽어 생성자로 주입. Local model은 base URL만 받고 자격증명 없음 |
| 테스트 | fake provider용 계약 테스트 스위트를 신규 provider에 재사용 1건, `structuredOutput: false` 인 provider가 EXTRACT_CLAIMS 라우팅에서 배제됨 1건, schema 검증 실패 → 1회 재요청 후 task FAILED 1건, `usageMetadata: false` provider에서 `usage = null` 이 Run 비용 상한 계산을 깨지 않음 1건 |
| 예상 위험 | LLM 캐시 키가 `(task, promptVersion, model, hash(input))` 이라 provider·model 교체 시 캐시가 전량 miss되어 재실행 비용이 발생한다(PIPELINES §5.4). provider별 structured output 지원 범위와 usage 필드는 UNVERIFIED EXTERNAL CONSTRAINT(§8.1) |

### 6.11 사용자 관심 profile 추가 (FeedbackProfile → RankingInput)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/domain/feedback/` 에 `FeedbackProfile` 계약 추가, `src/application/feedback/` 에 집계 뷰 Use Case 추가, `src/policies/{culture,practical,trend}/` 에 profile을 읽는 새 버전 파일 추가 |
| 새 adapter | 없음. `src/adapters/notion/feedback-reader.ts` 는 Phase 4에 이미 존재한다 |
| Core 변경 여부 | **계약 minor**. `RankingInput.feedbackProfile` 은 이미 optional 필드로 선언되어 있으므로(PIPELINES §6.1) Ranking Port 시그니처는 바뀌지 않고, 새로 정의되는 것은 `FeedbackProfile` 타입 자체다 |
| migration 여부 | 없음. `feedback_events` 테이블이 이미 있고 profile은 집계 뷰라 저장하지 않는다 |
| config | 사용할 정책 버전 목록(예: `ranking.practical@1.1.0`), profile 집계 window 길이 |
| 테스트 | profile이 null일 때 v1.0.0과 점수가 동일한 회귀 1건, `EXPLICIT_APPLIED` 가중이 `RankingOutput.reasons[]` 에 드러남 1건, 체크 해제·미열람이 음수 가중을 만들지 않음 1건(INTEGRATIONS §7), Artifact가 사용한 `rankingPolicies[{id, version}]` 기록 1건 |
| 예상 위험 | 피드백 과적합으로 새 주제 노출이 줄어든다. `reasons[]` 를 항상 채우고 정책을 버전으로 롤백 가능하게 두는 것이 유일한 방어다(PIPELINES §6.1) |

해소: `FeedbackProfile` 계약은 CONTRACTS §6.3.1 에 정의되어 있다 (집계 뷰, 저장하지 않음).

### 6.12 Weekly Report artifact

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/domain/artifacts/` 에 Weekly body 계약, `src/application/briefing/` 에 `BuildWeeklyReport`(ARCHITECTURE §5에 이미 예고됨), `src/adapters/rendering/markdown/` 에 weekly 렌더러, `src/runtime/cli/` 에 weekly 명령 |
| 새 adapter | 없음. notion·obsidian Publisher를 그대로 재사용한다 |
| Core 변경 여부 | 없음. `ArtifactType` 에 `"WEEKLY_REPORT"`, `Run.kind` 에 `"WEEKLY"`, targetKey 형식 `"2026-W37"` 이 모두 이미 정의되어 있다(CONTRACTS §5.1, §6.1) |
| migration 여부 | 없음. `artifacts`/`artifacts_current` 는 `(type, target_key, revision)` 로만 구분한다 |
| config | 실행 요일과 timezone(`Asia/Seoul`), 섹션 상한 |
| 테스트 | ISO week targetKey 계산 1건, 같은 주 2회 실행 시 contentHash 동일 → revision 불변 1건, Weekly의 입력이 Daily Artifact body가 아니라 Intelligence Model(claims·signals)임을 확인하는 1건 |
| 예상 위험 | Daily 7개를 재요약하는 지름길은 INTEGRATIONS §6.1 위반이다. `application/briefing/**` 이 `ArtifactStore` 의 DAILY_BRIEF body를 입력으로 읽지 않는지 아키텍처 테스트로 고정한다 |

### 6.13 Discord 채널

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/discord/`(Publisher) + `src/adapters/rendering/discord/`(메시지·임베드 렌더러) + composition root 등록. Phase 6 |
| 새 adapter | `DiscordPublisher`(Publisher Port) 1개, Renderer 1개 |
| Core 변경 여부 | 없음. `ChannelId` 에 `"discord"` 가 이미 있고 `Artifact`·`ApprovalRecord`·`PublicationRecord` 는 그대로다 |
| migration 여부 | 없음. `publications.channel` 은 TEXT다 |
| config | `DISCORD_WEBHOOK_URL` 또는 bot token(`runtime/config` 에서만 읽고 생성자 주입), 대상 채널 ID |
| 테스트 | 같은 `(artifactId, channel, revision)` 재실행 시 skip 1건, 새 revision은 "수정본" 표시 후 재발송 1건(INTEGRATIONS §6.2), 길이 제한 분할 렌더가 claimIds 집합을 바꾸지 않음 1건, PRIVATE artifact 허용 1건 |
| 예상 위험 | 발송 후 수정이 불가하므로 부분 실패가 중복 메시지가 된다. 전송 전에 `publications` 를 `PENDING` 으로 먼저 기록하고 PK `(artifactId, channel, revision)` 로 재시도를 흡수한다 |

### 6.14 Email 채널

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/email/`(Publisher) + `src/adapters/rendering/html/`(메일 본문 렌더러) + composition root 등록. Phase 6 |
| 새 adapter | `EmailPublisher` 1개, HTML Renderer 1개 |
| Core 변경 여부 | 없음. `ChannelId` 에 `"email"` 이 이미 있다 |
| migration 여부 | 없음 |
| config | SMTP host/port/user/password 또는 발송 API key, 수신자 목록. secret은 `runtime/config` 의 redaction 목록에 등록 |
| 테스트 | 동일 revision 재발송 skip 1건, 렌더 전후 claimIds 동일 1건, 자격증명이 로그에 남지 않음 1건(INTEGRATIONS §5.2), 이미지·첨부 없이 본문만으로 완결 1건 |
| 예상 위험 | 메일은 회수 불가라 discord와 같은 "revision당 1회 발송" 규칙이 필수다. 정정은 새 revision을 "수정본"으로 재발송한다 |

해소: INTEGRATIONS §6.2 표에 따라 수신자에 제3자가 포함되면 PUBLIC_OK + USER 승인이 필요하다. 개인 수신일 때만 PRIVATE 허용·POLICY 자동 승인이다.

### 6.15 Instagram content generation (SOCIAL_POST_DRAFT + card renderer, 게시 제외)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/domain/artifacts/` 에 SocialPostDraft body 계약, `src/application/briefing/` 에 draft builder, 신규 `src/adapters/rendering/instagram-card/`(카드 이미지 Renderer). Publisher는 만들지 않는다 |
| 새 adapter | Renderer 1개만. `Renderer<SocialPostDraft, RenderedAssets>` |
| Core 변경 여부 | **계약 minor**(body 계약 신설). `ArtifactType "SOCIAL_POST_DRAFT"` 와 targetKey `<date>:<slot>` 은 이미 정의되어 있어 enum 추가는 없다(CONTRACTS §5.1, INTEGRATIONS §6.3) |
| migration 여부 | 없음. 렌더 결과는 `data/store/rendered/instagram/<artifactId>/r<revision>.*` 로 나가고 재생성 가능하다(CONTRACTS §7.2) |
| config | 슬롯 수, 카드 템플릿·폰트 경로, public-safe 선택 필터(PUBLIC_OK + 소스 license OK) |
| 테스트 | PRIVATE claim이 하나라도 포함되면 `Artifact.visibility = PRIVATE` 1건, 모든 카드 문장이 `claimIds ≥ 1` 1건, 출처 카드 자동 생성 1건, 렌더 전후 claim 집합 동일 1건, 같은 입력에서 `renderedAssetHash` 가 결정적으로 재현됨 1건 |
| 예상 위험 | 카드 길이에 맞추려고 문장을 줄이면 Renderer가 내용을 바꾸는 것이 되어 INTEGRATIONS §6.1 위반이다. 초과분은 자르지 말고 item을 통째로 제외한다. 폰트 버전 차이로 asset hash가 흔들리면 승인 잠금이 깨지므로 렌더 입력에 폰트 식별자를 포함한다 |

### 6.16 Instagram approval/publishing

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/application/publish/` 에 `RequestApproval`(승인 규칙, `ApprovalRecord` 저장), 신규 `src/adapters/instagram/`(Publisher + `verify(externalId)`), `src/runtime/cli/` 에 `ai-radar approve <artifactId> --channel instagram` |
| 새 adapter | `InstagramPublisher` 1개 |
| Core 변경 여부 | 없음. `ApprovalRecord`, `PublicationRecord`, `ChannelId "instagram"`, `ArtifactStatus` 의 `APPROVED`/`PUBLISHED`/`RETRACTED` 가 모두 이미 정의되어 있다 |
| migration 여부 | 없음. `publications.scheduled_at` 과 `publications_scheduled` 인덱스는 CONTRACTS §7.3 의 `0001_init.sql` 에 이미 포함된다 (0001 적용 이전 DB가 존재하면 `0002_publications_scheduled_at.sql` 로 ALTER). 데이터 재기록은 없다 |
| config | Instagram 자격증명과 비즈니스 계정 ID(`runtime/config` 에서만), 재시도 상한 N, 슬롯별 발행 시각 |
| 테스트 | PRIVATE artifact를 public 채널로 보내면 거부 1건, 승인 후 contentHash 변경 시 발행 거부 1건, `renderedAssetHash` 불일치 시 거부 1건, 타임아웃 결과가 애매할 때 `verify(externalId)` 없이는 재시도하지 않음 1건, 승인을 우회하는 코드 경로가 존재하지 않음(아키텍처 테스트, Phase 6 Done 조건) |
| 예상 위험 | 중복 게시는 되돌릴 수 없다. Instagram Graph API의 컨테이너 생성·게시 절차, 캐러셀 제한, rate limit은 UNVERIFIED EXTERNAL CONSTRAINT(§8.1)이며 확인 결과를 `adapters/instagram/README.md` 에 기록한다 |

### 6.17 SQLite → 다른 DB (예: Postgres)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 신규 `src/adapters/storage/postgres/` 가 `src/ports/storage/` 전체(RawStore, DocumentStore, EntityStore, MetricStore, ClaimStore, ArtifactStore, RunStore, CheckpointStore, UnitOfWork)를 구현. `src/adapters/storage/fs`(raw payload·artifact body)와 application 계층은 무변경 |
| 새 adapter | Store 구현 1세트 + 자체 migration 디렉터리 |
| Core 변경 여부 | 없음. Port 시그니처는 domain 타입만 쓰므로(ARCH-05) 드라이버 타입이 위로 새지 않는다 |
| migration 여부 | **DDL 추가 + 데이터 재기록**. CONTRACTS §7.3의 SQLite DDL을 Postgres용으로 다시 쓴다(복합 PK는 동일, `entities_repo` 의 부분 unique index는 partial index로 1:1 대응, `REAL` → `double precision`). 이전은 `*_json` 컬럼을 그대로 옮기는 1회 export/import이며 계약 upcast는 필요 없다 |
| config | `DATABASE_URL`, `storage.driver = "sqlite" \| "postgres"` 로 composition root가 분기 |
| 테스트 | 하나의 Store 계약 테스트 스위트를 memory/sqlite/postgres 세 adapter에 모두 실행 1세트, idempotency 재실행 건수 불변 1건, UnitOfWork 롤백 1건, partial unique index 동작 1건 |
| 예상 위험 | CONTRACTS §7.1은 Postgres를 "개인용 단일 프로세스에 과함, 채택 안 함" 으로 판정하고 이 시나리오로 이행 가능성만 보장한다. 실제 이행은 운영 부담 증가를 감수하는 결정이므로 새 ADR이 선행되어야 한다 |

### 6.18 과거 Raw 데이터 재분석 (새 policy/prompt 버전으로 REANALYZE run)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 없음. `src/runtime/cli/` 의 `ai-radar reanalyze --from … --to … --policy trend@2.0` 은 CONTRACTS §7.5에 이미 정의된 경로다 |
| 새 adapter | 없음 |
| Core 변경 여부 | 없음. `Run.kind "REANALYZE"` 가 이미 있고, 파이프라인은 Normalize(2단계)부터 재실행한다(PIPELINES §1) |
| migration 여부 | 없음. 새 결과는 새 `policy_version`·`analysis_id` 로 저장되어 옛 row와 공존한다. `derived_signals` PK와 `classifications` PK에 `policy_version` 이 포함되어 충돌하지 않는다 |
| config | `--policy <id>@<version>`, `--prompt <id>@v<N>`, Run당 LLM 비용 상한 |
| 테스트 | 같은 범위·같은 policyVersion으로 2회 실행 시 건수 불변 1건, 다른 policyVersion이면 새 row만 추가되고 옛 row 유지 1건, prompt가 그대로면 LLM 캐시 재사용으로 비용 0 1건, Artifact revision은 올라가되 이미 발행된 revision의 PublicationRecord는 불변 1건 |
| 예상 위험 | 재분석 결과를 자동 발행하면 독자가 이미 읽은 Daily가 조용히 바뀐다. REANALYZE는 발행하지 않고 발행은 `Run.kind = "PUBLISH_ONLY"` 로 분리해야 한다 |

해소: REANALYZE Run은 발행하지 않는다. 발행은 `ai-radar publish` 로 명시한다 (CONTRACTS §7.5 항목 4).

### 6.19 Source article 정정 (원문 수정 또는 삭제)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | 없음(정상 경로). 수정된 원문은 재수집 시 payloadHash가 달라 새 `RawObservation` 이 되고, `documents` 는 `(sourceId, externalId)` 로 upsert되어 `latestObservationId` 만 갱신된다 |
| 새 adapter | 없음 |
| Core 변경 여부 | 수정 케이스는 없음. 삭제 케이스와 claim supersede는 아래 "요구" 참조 |
| migration 여부 | 없음 |
| config | 없음 |
| 테스트 | 같은 externalId + 다른 payloadHash → raw 2건·document 1건 1건, 옛 Evidence의 `observationId` 와 인용 텍스트가 변하지 않음 1건, 발행된 artifact의 RETRACTION 흐름 1건(Phase 6 테스트 목록) |
| 예상 위험 | `documents.title`·`content` 가 갱신되어 과거 Artifact의 `SourceRef.title` 과 달라진다. Artifact body는 불변 파일이므로 당시 문구가 유지되며, 이는 손상이 아니라 의도된 snapshot 보존이다 |

불변성: `RawObservation` 은 수정하지 않는다(CONTRACTS §1.1). 정정은 언제나 **새 observation** 이고, 과거 Claim의 근거는 `Evidence.observationId` 가 가리키는 인용 당시 snapshot으로 남는다.

발행물: 이미 발행된 artifact를 소리 없이 다시 쓰지 않는다(INTEGRATIONS §6.2). notion·obsidian은 in-place 갱신 가능 채널이므로 새 revision으로 교체하되 revision callout과 관리 영역 교체로 변경을 드러낸다. instagram·web은 수정 불가이므로 RETRACTION Artifact + 새 USER 승인을 거치고 원본은 `PublicationRecord.status = "RETRACTED"`, `Artifact.status = "RETRACTED"` 로 표시한다.

해소: (1) 삭제 확인 시 `completeness: "MISSING"` + `rawMetadata.tombstone=true` 인 tombstone observation을 기록하고 NormalizedDocument.status 를 DELETED 로 둔다 (CONTRACTS §1.1, §1.2). (2) Claim 에 `status`(ACTIVE/SUPERSEDED/RETRACTED)와 `supersededById` 를 두고 전이 규칙을 정의했다 (CONTRACTS §4.2).

### 6.20 User feedback 기반 ranking 개선 (policy 버전 업)

| 항목 | 내용 |
| --- | --- |
| 변경 모듈 | `src/policies/practical/` 등에 새 버전 파일 추가(예: v1.1.0). 기존 버전 파일은 삭제하지 않고 남긴다. changelog 주석과 `RankingPolicy.version` 갱신 |
| 새 adapter | 없음 |
| Core 변경 여부 | 없음. `RankingInput`/`RankingOutput` 은 그대로이고 `BuildDailyBrief` 가 policy 목록을 인자로 받으므로(ARCHITECTURE §9) application 코드도 바뀌지 않는다 |
| migration 여부 | 없음. `classifications`·`derived_signals` 는 PK에 `policy_version` 이 있어 옛 결과와 공존하고, Artifact 재생성 시 contentHash가 바뀌면 revision이 +1 된다 |
| config | 사용할 정책 목록(예: `ranking.practical@1.1.0`)만 교체하면 전환과 롤백이 코드 변경 없이 가능하다 |
| 테스트 | 고정 fixture window에 대해 v1.0.0과 v1.1.0의 순위 diff를 스냅샷으로 고정 1건, 같은 입력·같은 버전이 항상 같은 점수를 내는 결정성 1건, `reasons[]` 가 비어 있지 않음 1건, 이전 버전으로 롤백 시 옛 점수가 재현됨 1건 |
| 예상 위험 | 정책을 올린 뒤 과거 Artifact를 재생성하면 "그때 왜 이 항목이 올라왔는가" 의 재현이 어려워진다. 옛 revision과 `inputs.rankingPolicies[{id, version}]` 기록이 이를 막으므로 옛 revision을 덮어쓰지 않는다 |

### 6.21 시나리오 결과 요약

| # | 시나리오 | Core 변경 | Migration |
| --- | --- | --- | --- |
| 1 | Horizon 제거 | 없음 | 없음 |
| 2 | Reddit 직접 수집 | 없음 | 없음 |
| 3 | GitHub Issues/PR collector | 없음 | 없음 |
| 4 | YouTube transcript source | 없음 (채널은 PERSON/COMPANY entity, CONTRACTS §3.1) | 없음 |
| 5 | Arxiv source | 없음 | 없음 |
| 6 | 새 EntityType (DATASET) | enum 추가 | 없음 |
| 7 | Skill Trend | 없음 | 없음 |
| 8 | MCP Trend | 없음 | 없음 |
| 9 | Model Trend | 없음 | 없음 |
| 10 | LLM Provider 교체 | 없음 | 없음 |
| 11 | FeedbackProfile → RankingInput | 계약 minor | 없음 |
| 12 | Weekly Report artifact | 없음 | 없음 |
| 13 | Discord 채널 | 없음 | 없음 |
| 14 | Email 채널 | 없음 | 없음 |
| 15 | Instagram content generation | 계약 minor (body 계약 신설) | 없음 |
| 16 | Instagram approval/publishing | 없음 | 없음 (`scheduled_at` 은 0001_init 포함) |
| 17 | SQLite → Postgres | 없음 | DDL 추가 + 데이터 재기록 |
| 18 | 과거 Raw 재분석 (REANALYZE) | 없음 | 없음 |
| 19 | Source article 정정 | 없음 (tombstone·status·supersededById 는 v1 계약에 포함, CONTRACTS §1.1·§1.2·§4.2) | 없음 |
| 20 | Feedback 기반 ranking 버전 업 | 없음 | 없음 |

### 6.22 시나리오 검증에서 드러난 결손과 해소

시나리오 20개를 문서와 대조하며 아래 결손이 발견되었고, 모두 이 설계 패키지 안에서 해소했다 (ADR로 미루지 않음).

| 시나리오 | 발견된 결손 | 해소 (문서 위치) |
| --- | --- | --- |
| 6.4 | `MetricScope="CHANNEL"` 에 대응하는 EntityType이 없었다 | 채널 수치의 subject는 채널을 소유한 PERSON/COMPANY entity. 채널 전용 EntityType은 두지 않는다 (CONTRACTS §3.1 scope 규칙) |
| 6.5 | 런타임 외부 의존성 추가 기준이 없었다 | 의존성 정책 신설: adapters/runtime에서만, 내장 대체 불가·허용 라이선스·PR 근거 (ARCHITECTURE §2.3) |
| 6.8 | entity 간 metric 상속·집계 규칙이 없었다 | 상속 없음. 집계는 policy가 DerivedSignal로 명시 계산 (CONTRACTS §2.1 규칙 7) |
| 6.9 | MODEL 버전 단위 시계열 축이 없었다 | 버전은 기본 versionLabel. 독립 논의될 때만 자식 MODEL entity + parentEntityId, 사람이 split (CONTRACTS §2.1 규칙 6) |
| 6.11 | FeedbackProfile 필드 정의가 없었다 | CONTRACTS §6.3.1 FeedbackProfile 계약 추가 |
| 6.14 | 제3자 수신 email/discord의 visibility·승인 요구가 없었다 | 수신자에 제3자 포함 시 PUBLIC_OK + USER 승인 (INTEGRATIONS §6.2 표 행 추가) |
| 6.16 | publications DDL에 scheduled_at이 없었다 | PublicationRecord.scheduledAt + DDL 컬럼·인덱스 추가. 0001_init에 포함되므로 별도 migration 불필요 (CONTRACTS §5.3, §7.3) |
| 6.18 | REANALYZE Run의 기본 발행 여부가 없었다 | 발행하지 않음. `ai-radar publish` 로 명시 (CONTRACTS §7.5 항목 4) |
| 6.19 | 원문 삭제 tombstone, Claim supersede/retract 관계가 없었다 | tombstone observation 규칙(CONTRACTS §1.1), NormalizedDocument.status, Claim.status + supersededById와 전이 규칙 (CONTRACTS §1.2, §4.2) |
| 전반 | migration 파일 경로가 문서마다 달랐다 | `src/adapters/storage/sqlite/migrations/` 로 통일 (다른 DB adapter는 자기 migrations를 가진다) |

<!-- extension-scenarios:end -->

---

## 7. 아키텍처 자동 검증 계획

기존 도구(`tsc`, `node --test`)만 사용한다. 새 lint 도구를 추가하지 않는다.

### 7.1 Import 규칙 테스트 (`test/architecture.test.ts`, Phase 0)

`src/**/*.ts` 를 읽어 `import` 구문을 정규식으로 추출하고 규칙을 검사한다. 규칙은 `ARCHITECTURE.md` §3.1 표와 동일해야 하며, 테스트 파일이 그 표의 단일 진실이 되지 않도록 표를 인용하는 주석을 둔다.

| 규칙 ID | 검사 | 위반 예 |
| --- | --- | --- |
| ARCH-01 | `src/domain/**` 는 `node:fs`, `node:http(s)`, `node:child_process`, `node:sqlite`, 외부 패키지(`@notionhq/*`, `@anthropic-ai/*`, `openai`, `dotenv`) import 금지, `process.env` 참조 금지 | domain이 Notion SDK import |
| ARCH-02 | `src/domain/**` 는 `application/ ports/ adapters/ runtime/ policies/` import 금지 | – |
| ARCH-03 | `src/policies/**` 는 `domain/` 외 import 금지 | – |
| ARCH-04 | `src/application/**` 는 `adapters/`, `runtime/` import 금지, 외부 SDK·`node:fs`·`process.env` 금지 | application이 concrete adapter import |
| ARCH-05 | `src/ports/**` 는 `domain/` 외 import 금지 (외부 SDK 타입 누출 방지) | port 시그니처에 Notion 타입 |
| ARCH-06 | `src/adapters/<a>/**` 는 `src/adapters/<b>/**` (a≠b) import 금지, `application/`·`runtime/` 금지, `process.env` 금지 | adapter 간 호출 |
| ARCH-07 | `process.env` 문자열은 `src/runtime/config/**` 에서만 | – |
| ARCH-08 | `child_process` import는 `src/adapters/sources/horizon/**` 과 `src/adapters/llm/codex-cli/**` 에서만 (둘 다 `shell:false`, 고정 인자) | 외부 데이터 명령 실행 경로 차단 |
| ARCH-09 | `src/application/{analyze,trend,briefing}/**` 는 `ports/publishing`, `ports/system/http` import 금지 | Analyzer가 발행 권한 획득 |
| ARCH-10 | Horizon 관련 식별자(`horizon`, `ContentItem`)가 `src/domain`, `src/application`, `src/ports` 에 등장 금지 | Horizon 타입 노출 |
| LEGACY | Phase 1 완료 전 `src/{config,formatters,librarian,loaders,schemas,writers}/**`, `src/run-daily.ts` 는 allowlist. allowlist 항목은 Phase 1에서 제거되어야 하며 테스트가 "allowlist에 있으나 존재하지 않는 파일"을 실패로 보고해 정리를 강제 | – |

구현 시 확정한 해석 (`test/architecture.test.ts`, Phase 0에서 구현 완료, 셀프테스트 15건 포함):

- 같은 계층 내부 import(`policies → policies`, `ports → ports`)는 허용한다. ARCHITECTURE §3.1 의 "domain/ 내부" 허용과 같은 취지다.
- `adapters/shared/**` 는 ARCH-06 의 예외 대상(다른 adapter가 import 가능)이다. 단 `adapters/shared` 자체는 외부 SDK를 import하지 않는다.
- ARCH-06 의 adapter 그룹 `<a>` 는 `adapters/` 바로 아래 첫 세그먼트다 (`adapters/sources/hackernews` 와 `adapters/sources/rss` 는 같은 그룹).
- domain/policies/application/ports 에서는 **모든** 비-`node:` bare specifier를 위반으로 본다 (§3.1 이 예시로 든 SDK 목록은 메시지 근거로만 쓴다). ARCHITECTURE §2.3 의존성 정책과 일치.
- `fetch` 전역 호출은 import 스캔으로 잡히지 않는다. 이 항목은 §7.2 의 구조 테스트(분석 Use Case 생성자 주입 목록)와 코드 리뷰로 보완한다. Phase 2에서 `ports/system/http` 도입 시 `\bfetch\(` 텍스트 검사를 ARCH-11 로 추가한다.

### 7.2 동작 규칙 테스트 (해당 Phase에서 추가)

| 검사 | 방법 | Phase |
| --- | --- | --- |
| Idempotency: 같은 window 2회 → raw/document/metric/artifact/publication 건수 불변 | in-memory store end-to-end | 2, 3 |
| Metric scope 오류 거부 (SKILL + github.stars) | domain validator 단위 | 3 |
| 지원되지 않는 trend 계산 → INSUFFICIENT_DATA/COLD_START, 절대 숫자 생성 안 함 | TrendEngine 단위 | 4 |
| Evidence 없는 claim 거부, 존재하지 않는 evidenceId 거부 | ExtractClaims + fake provider | 3 |
| LLM 출력 수치가 metric evidence 없이 등장 → 거부 | 동일 | 3 |
| Notion 사용자 필드(Read/Applied 및 미관리 속성) 미전송 | fake client 호출 검사 (현재 테스트 유지) | 1 |
| Obsidian 사용자 영역 보존, 관리 영역 사용자 수정 시 보류 | fixture 노트 | 1, 5 |
| Private claim이 PUBLIC 채널 artifact에 포함 → 거부 | PublishArtifact 단위 | 6 |
| 승인 후 내용 변경 → 발행 거부 | ApprovalRecord hash 불일치 | 6 |
| 부분 발행 재시도 중 중복 post 없음 | Publisher fake로 1회 실패 후 재시도 | 1(Notion), 6 |
| 외부 문서의 지시문이 claim으로 승격되지 않음 | injection fixture + schema | 3 |
| 채널 실패 격리 (Notion 실패 → Obsidian·Librarian 진행) | RunDailyPipeline + fake publishers | 1 |

---

## 8. 설계 완료 조건 (Acceptance)

| 조건 | 위치 |
| --- | --- |
| AI Radar가 무엇이고 무엇이 아닌가 | ARCHITECTURE §1 |
| Source 추가 방식 | PIPELINES §2, ARCHITECTURE §9, ADR-0003 |
| Canonical data | CONTRACTS §1–6, ADR-0002 |
| Raw와 Intelligence 분리 | CONTRACTS §7.2, ADR-0005 |
| Entity identity | CONTRACTS §2, PIPELINES §3.3, ADR-0004 |
| Metric / Signal 의미 | CONTRACTS §3, PIPELINES §3.4 |
| Trend 계산 조건 | PIPELINES §7 |
| Evidence / Claim 관계 | CONTRACTS §4, PIPELINES §5.2 |
| LLM 역할 | PIPELINES §5, INTEGRATIONS §3 |
| Storage ownership | CONTRACTS §7.2 |
| Run / Failure semantics | CONTRACTS §6.1, PIPELINES §2.2, §4 |
| Idempotency | CONTRACTS §8 |
| Notion 역할 | INTEGRATIONS §1, ADR-0007 |
| Obsidian 역할 | INTEGRATIONS §2, ADR-0007 |
| Knowledge update safety | PIPELINES §8, INTEGRATIONS §2.3 |
| Content creation 경계 | INTEGRATIONS §6, ADR-0006 |
| Public publishing approval | INTEGRATIONS §6.2–6.3, ADR-0008 |
| Schema migration | CONTRACTS §0.1, §7.4 |
| Existing implementation migration | 이 문서 §3–5 |
| Architecture validation | 이 문서 §7 |
| Future extension points | ARCHITECTURE §9, 이 문서 §6 |

### 8.1 UNVERIFIED EXTERNAL CONSTRAINT 목록

| 항목 | 확인 방법 | 시점 |
| --- | --- | --- |
| `node:sqlite` 안정성 | Node 문서 stability index + 실행 확인, 불안정 시 `better-sqlite3` driver | Phase 2 착수 |
| Horizon `hz_fetch_items` 호출 방식과 runs 경로 | 로컬 설치 후 fixture 실행, `raw_items.json` 스키마 캡처 | Phase 2 |
| Hacker News Firebase API rate limit 정책 | 공식 문서 + 실측 | Phase 2 |
| GitHub REST `since` 동작과 rate limit(토큰 유무) | agents-radar 코드 + 공식 문서 | Phase 3 |
| Anthropic/OpenAI structured output 지원 범위·usage 필드 | provider 문서, capabilities() 구현 시 실측 | Phase 3 |
| Notion API 블록 append 원자성 대안(없음으로 가정) | 공식 문서 | Phase 1 |
| Instagram Graph API 게시 절차·제한 | Meta 문서 + 샌드박스 | Phase 6 |
| YouTube transcript 확보 수단(공식 Captions API는 OAuth 필요, 비공식 경로는 이용 조건 불명) | YouTube Data API 문서 + 테스트 채널로 실측, 결과를 `adapters/sources/youtube/README.md` 에 기록 | YouTube source 착수 시 |
