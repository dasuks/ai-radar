# Integrations and Safety

문서 버전: 1.0 (2026-09-12)
관련 ADR: ADR-0007 (Notion / Obsidian 역할), ADR-0008 (Public Content Approval Boundary)

---

## 1. Notion — Daily Reader + Archive

### 1.1 역할

- 사용자가 매일 읽는 곳. 날짜별 `AI Intelligence Daily` 페이지.
- 과거 Daily의 아카이브.
- 사용자 피드백 입력 지점 (`Read`, `Applied` 체크박스).
- **Canonical Intelligence Store가 아니다.** Notion에서 데이터를 읽어 분석 입력으로 쓰지 않는다 (피드백 체크박스 제외).

### 1.2 현재 계약 (호환 유지)

| 항목 | 값 | 비고 |
| --- | --- | --- |
| 환경변수 | `NOTION_TOKEN`, `NOTION_DATABASE_ID` | 이름 유지. `NOTION_DATA_SOURCE_ID` 는 `.env` 에 존재하지만 코드가 읽지 않음 → 목표 구조에서 optional 설정으로 흡수 |
| DB 속성 | Name(title), Date(date), Topics(multi_select), Importance(number), Read(checkbox), Applied(checkbox) | 유지. 추가 속성은 optional |
| Upsert 키 | `Date` equals | 유지. 목표 구조에서는 `PublicationRecord.externalId` 를 1차 키, Date 조회를 reconciliation으로 사용 |
| 사용자 필드 | `Read`, `Applied` | 생성 시에만 false로 초기화, 갱신 시 요청에서 제외 (현재 구현·테스트 존재) |
| Integration 이름 | "AI Coding Radar Integration" (Notion 측 표시명) | **변경하지 않는다.** 표시명일 뿐이며 토큰과 무관 |
| DB 이름 | "AI Coding Daily" (사용자 workspace의 DB 제목) | 사용자가 원하면 Notion에서 직접 바꾼다. 코드는 ID로만 참조 |

### 1.3 목표 동작 (NotionPublisher)

1. `PublicationRecord(channel=notion)` 에 `externalId`(page id)가 있으면 그 page를 갱신한다. 없으면 Date로 조회하고, 발견하면 record에 backfill한다. 둘 다 없으면 생성.
2. 갱신 시 `properties` 는 Name/Date/Topics/Importance 만 보낸다. Read/Applied 및 **사용자가 추가한 다른 속성**은 건드리지 않는다 (현재는 required 6개만 검사하므로 추가 속성은 이미 안전).
3. 본문 교체는 `erase_content` + append 이므로 원자적이지 않다. 완화: (a) 렌더 결과를 먼저 완성하고 API 호출은 마지막에, (b) 실패 시 PublicationRecord FAILED로 남기고 다음 실행에서 같은 page를 다시 채움, (c) 본문 맨 앞에 `ai-radar:revision:<n>` 을 담은 callout 블록을 넣어 부분 실패 상태를 사람이 식별할 수 있게 한다.
4. Date로 페이지가 2개 이상이면 현재처럼 중단한다 (자동 삭제 금지).
5. **데이터 소스 자동 탐색 위험 완화** (§4 R-N1): 설정 ID와 일치하는 data source가 없을 때 "스키마가 유일하게 일치하는 다른 DB" 로 fallback하는 현재 동작은 목표 구조에서 **기본 비활성** 으로 바꾼다 (`NOTION_ALLOW_SCHEMA_FALLBACK=true` 일 때만 허용). 이유: 다른 workspace DB에 쓰는 사고 가능성.

### 1.4 NotionFeedbackReader (향후, Phase 4)

- 읽기 전용. Date 범위로 page를 조회해 `Read`/`Applied` 를 `FeedbackEvent(IMPLICIT_READ / EXPLICIT_APPLIED)` 로 기록한다. 체크 해제는 이벤트를 만들지 않는다 (Unread ≠ Disliked).
- Collector/Analyzer와 별도 Use Case (`SyncFeedback`), Publisher와 다른 adapter 클래스.

### 1.5 Notion MCP (개발 도구)

Claude Code 세션에서 Notion을 조회하기 위한 MCP는 **AI Radar 런타임과 무관** 하다. 런타임은 `@notionhq/client` + `NOTION_TOKEN` 만 사용한다. MCP 토큰을 런타임 설정과 섞지 않는다.

---

## 2. Obsidian — Living Knowledge Base

### 2.1 역할

- 장기 지식: 개념·패턴·워크플로우·도구·아키텍처·연구.
- Daily Note(`99 Daily/`)는 읽기용 사본이자 Knowledge Note로 가는 허브.
- Daily Brief를 그대로 복사해 노트 수백 개를 만들지 않는다. Knowledge Note는 **entity 또는 concept 단위**로만 생성/갱신된다.

### 2.2 현재 계약 (호환 유지)

| 항목 | 값 |
| --- | --- |
| Vault 경로 | `OBSIDIAN_VAULT_PATH` (기본 `C:\dev\knowledge\ai-knowledge`) |
| 폴더 | `00 Inbox`, `01 Concepts`, `02 Patterns`, `03 Workflows`, `04 Tools`, `05 Architecture`, `06 Research`, `07 Projects`, `99 Daily` |
| Daily Note 파일명 | `<date> <title>.md` |
| 관리 마커 | `<!-- ai-coding-radar:content:start/end -->`, `<!-- ai-coding-radar:knowledge-updates:start/end -->`, `<!-- ai-coding-radar:evidence:<date>:start/end -->` |
| 매칭 | H1 제목 또는 파일명 정규화 |
| Vault 밖 쓰기 | 거부 (경로 검사 존재) |

### 2.3 사용자 데이터 보호 규칙

1. **관리 영역 밖은 절대 수정하지 않는다.** 마커 밖 텍스트는 사용자 소유다.
2. **Daily Note 전체 덮어쓰기 금지 (목표).** 현재 `writeObsidianDailyNote` 는 파일 전체를 다시 쓴다. 사용자가 Daily Note에 메모를 적었다면 재실행 시 사라진다 (§4 R-O1). 목표: Daily Note도 `ai-radar:daily:start/end` 관리 영역 + 사용자 영역 구조로 바꾸고, 기존 파일이 있으면 관리 영역만 교체한다.
3. 관리 영역 내부를 사용자가 고쳤으면(`managedHash` 불일치) 덮어쓰지 않고 NEEDS_REVIEW 로 보류한다.
4. 파일 이동/이름 변경 감지: frontmatter `ai-radar.entityId` 로 먼저 찾는다. 같은 entityId 노트가 2개면 AMBIGUOUS.
5. 삭제는 하지 않는다. "outdated" 는 status 영역에 표기만 한다.
6. 백업은 만들지 않는다 (Vault의 Git이 담당, 현재 방식 유지). 단, 한 Run이 수정할 수 있는 노트 수 상한(config, 기본 20)을 두어 대량 변경 사고를 막는다.
7. 레거시 마커 `ai-coding-radar:*` 는 읽기 호환. 갱신 시 새 마커 `ai-radar:*` 로 재기록한다 (관리 영역 전체를 교체하므로 안전).

### 2.4 Knowledge → Skill 승격 (향후, 구현 안 함)

```
Evidence 누적 → Knowledge Note (evidence history, best practice)
   → 반복 실무 검증 (EXPLICIT_APPLIED feedback ≥ N, 서로 다른 window ≥ M)
   → SkillCandidate Artifact (KNOWLEDGE_PROPOSAL 하위 타입)
   → 인간 리뷰 (ai-radar skills review)
   → C:\dev\ai\skills\<name>\SKILL.md 로 사람이 복사 (자동 쓰기 없음)
```

아키텍처가 보장하는 것: 후보 생성에 필요한 데이터(evidence history, feedback events, entity)는 모두 Intelligence Store에 있고, `SkillCandidate` 는 Artifact 계약을 재사용한다. 인터넷에서 발견된 패턴이 곧바로 Skill이 되는 경로는 존재하지 않는다 (Artifact → Publisher 경로에 `skills` 채널을 정의하지 않는다).

---

## 3. LLM Provider 안전

- Provider adapter는 자격증명을 생성자로 받는다. 로그에는 provider id와 model만 남긴다.
- 모든 요청에 `outputSchema` 필수. 검증 전 출력은 어디에도 저장하지 않는다 (AnalysisRecord의 `outputHash` 는 검증 통과본).
- 분석 task는 tool calling 비활성. Provider가 tool calling을 지원해도 분석 Use Case는 요청하지 않는다.
- 비용: usage metadata를 Run에 누적. 상한 초과 시 SKIPPED.
- 외부 provider로 나가는 데이터: 수집된 공개 문서 텍스트와 우리 prompt. **사용자 Obsidian 노트 본문은 보내지 않는다** (Librarian은 노트의 제목·frontmatter·managed region hash만 사용). 예외를 도입하려면 ADR.

---

## 4. 기존 구현에서 발견한 위험

| ID | 위험 | 근거 | 목표 구조의 처리 |
| --- | --- | --- | --- |
| R-N1 | Notion 데이터 소스 fallback이 설정 ID와 무관한 DB에 쓸 수 있음 | `src/writers/notion-writer.ts:240-269` — 설정 ID 미일치 시 검색된 모든 data source 중 스키마 일치 1개면 채택. 테스트 "설정 ID가 일치하지 않아도 스키마가 유일하게 일치하면 저장한다" 가 이를 보장 | 기본 비활성, 명시 opt-in |
| R-N2 | 본문 교체가 비원자적 (erase 후 append 실패 시 빈 페이지) | `notion-writer.ts:353-360` | PublicationRecord 재시도 + revision callout |
| R-O1 | Daily Note 전체 덮어쓰기로 사용자 메모 유실 | `src/writers/obsidian-writer.ts:44` `writeFile` 전체 | 관리 영역 방식 |
| R-O2 | 관리 영역 내부 사용자 수정이 무조건 덮어써짐 | `obsidian-librarian.ts:241-255` | managedHash 비교 |
| R-O3 | Daily Note 파일명이 title에 의존 → title 변경 시 같은 날짜 노트 중복 | `obsidian-writer.ts:39` | date 접두 조회 + PublicationRecord externalId(경로) |
| R-P1 | Notion 실패 시 Librarian 미실행 (순차 throw) | `src/run-daily.ts:50-58` | 채널별 실패 격리 |
| R-P2 | Run 기록 없음. "무엇이 언제 실행됐는지" 추적 불가 | `run-daily.ts` 전체 | Run 계약 |
| R-P3 | schemaVersion 없음. `DailyBriefing` 변경 시 과거 JSON 해석 불가 | `src/schemas/briefing.ts` | v1 → v2 upcast |
| R-S1 | 환경변수 접근이 두 파일에 분산 (`config/paths.ts` 기본 인자, `run-daily.ts`) | grep 결과 | `runtime/config` 단일화 |
| R-S2 | `.brainpane/` 런타임 디렉터리에 `access.key` 파일 존재, 로컬 ignore에 의존 | `git status --ignored` 로 확인, 프로젝트 `.gitignore` 에 없음 | `.gitignore` 에 명시 추가 |
| R-D1 | `NOTION_DATA_SOURCE_ID` 가 `.env` 에 있으나 코드 미사용 → 설정 drift | grep | 설정 스키마에 optional로 등록하고 README 명시 |
| R-T1 | 테스트가 tsc 빌드 산출물(`.test-dist`)을 실행 → Windows 경로·ESM 확장자 문제에 취약하지만 현재 통과 | `package.json` scripts | 유지. 아키텍처 테스트도 같은 방식 |
| R-A1 | 계층 규칙을 강제하는 장치 없음 | 구조 | `test/architecture.test.ts` |

---

## 5. 권한 분리와 외부 데이터 안전

### 5.1 신뢰 경계

| 데이터 | 신뢰 수준 | 취급 |
| --- | --- | --- |
| 환경변수, config 파일, prompt 템플릿, policy 상수 | 신뢰 | runtime/config 및 코드 |
| 수집된 문서·댓글·README·Issue 본문·Horizon 출력 | **비신뢰 데이터** | 항상 `untrusted` 블록. 명령·경로·URL로 해석 금지 |
| LLM 출력 | 비신뢰 (검증 전) | schema + evidence 검증 후에만 저장 |
| 사용자 Obsidian 노트 | 사용자 소유 | 관리 영역 밖 읽기만, 외부 전송 금지 |
| Notion 사용자 필드 | 사용자 소유 | 읽기(피드백)만 |

### 5.2 구조적 보장

- `application/analyze/*`, `application/trend/*`, `application/briefing/*` 는 생성자에 `LlmProvider` 와 `*Store` 만 받는다. `VaultPort`, `Publisher`, `HttpClient` 는 주입 목록에 없다. 아키텍처 테스트가 이 Use Case 파일의 import를 검사한다.
- 셸 실행(`child_process`)은 `adapters/sources/horizon/` 과 `adapters/llm/codex-cli/` 에서만 허용되며(`shell:false`), 명령과 인자는 코드 상수 + config 값 + 우리가 만든 임시 파일 경로만 사용한다. **외부 문서 텍스트가 인자(argv)에 들어가는 경로는 없다.** codex prompt 처럼 비신뢰 텍스트를 넘겨야 하는 경우는 자식 프로세스의 **stdin** 으로 써 넣고 곧바로 stdin 을 닫는다 — argv 에는 흔적이 남지 않으므로 프로세스 목록·셸 히스토리·명령줄 길이 제한에 노출되지 않는다 (테스트: `buildCodexArgs` 는 prompt 를 입력으로 받지 않고, spawn stub 이 stdin 기록을 검증한다).
- 파일 쓰기 경로는 `adapters/storage/fs` (data/store 하위만), `adapters/obsidian` (Vault 하위만). 두 곳 모두 경로 탈출 검사.
- 로그 redaction: config에서 secret으로 표시된 값은 Logger가 마스킹 (현재 `errorMessage(valuesToRedact)` 방식 유지·확장).

### 5.3 Prompt injection 대응 체크리스트 (테스트 항목)

- "ignore previous instructions" 를 포함한 문서를 CLASSIFY/EXTRACT_CLAIMS에 넣었을 때 출력 schema가 유지되고, 문서 내 지시가 claim statement로 번역되지 않는다 (fake provider로 구조 검증 + 실제 provider로 주기적 smoke).
- 문서에 `.env`, 파일 경로, 셸 명령이 있어도 어떤 Use Case도 그것을 열거나 실행하지 않는다 (fs/child_process 접근이 없는 계층이므로 구조적으로 불가; 테스트는 import 규칙으로 확인).
- LLM 출력에 존재하지 않는 evidenceId → 거부됨.
- LLM 출력에 URL → 자동 fetch 없음.

---

## 6. Content Creation → Publishing 경계

### 6.1 분리 원칙

```
INTELLIGENCE (claims, signals, entities)  ──▶  CONTENT CREATION (Artifact per purpose/channel)
     ──▶  RENDERING (Markdown / Notion blocks / card image)  ──▶  APPROVAL  ──▶  PUBLISHING  ──▶  PublicationRecord
```

- 모든 Artifact는 **Intelligence Model에서** 만든다. Notion Daily page를 읽어 Instagram용으로 재요약하는 경로는 없다 (Notion은 Publisher의 출력이지 입력이 아니다).
- 같은 날의 `DAILY_BRIEF` 와 `SOCIAL_POST_DRAFT` 는 같은 claim 집합을 입력으로 하되 별개의 Artifact다.
- Renderer는 표현만 바꾼다. 내용(문장·수치)을 바꾸면 안 된다 → 렌더 전후 claimIds 집합 동일성 테스트.

### 6.2 채널 정책

| 채널 | visibility 요구 | 승인 | 수정 가능 | 중복 방지 키 |
| --- | --- | --- | --- | --- |
| notion | PRIVATE 허용 | POLICY 자동 | in-place 갱신 | (artifactId, channel) + Date 조회 |
| obsidian | PRIVATE 허용 | POLICY 자동 | 관리 영역 교체 | 파일 경로 + 마커 |
| discord / email (향후) | PRIVATE 허용 (수신자가 본인뿐인 개인 채널일 때) | POLICY 자동, 단 revision당 1회 발송 | 불가 → 새 revision은 "수정본" 표시 후 재발송 | (artifactId, channel, revision) |
| discord (ADR-0010의 지정 멤버 서버) | 공개 출처 전용 DISCORD_EDITION, PRIVATE 배포 | 사용자 지정 범위 내 POLICY 자동 | 기존 메시지 수정, revision 표시 | 서버 + 날짜 + 항목 ID |
| discord / email (그 외 제3자 수신) | **PUBLIC_OK 필수** | **USER 승인 필수** (instagram과 동일 규칙) | 불가 | 동일 |
| instagram / web (향후) | **PUBLIC_OK 필수** | **USER 승인 필수**, contentHash + renderedAssetHash 잠금 | 불가 → 정정은 새 Artifact(RETRACTION) | (artifactId, channel) + externalId |

### 6.3 Instagram 미래 flow (설계만)

```
Public-safe selection: claims.visibility == PUBLIC_OK && sources license OK
  → SocialPostDraft Artifact (type=SOCIAL_POST_DRAFT, targetKey=<date>:<slot>)
  → InstagramCardRenderer → rendered assets (hash 기록)
  → Fact/source check (모든 카드 문장 → claimIds, 출처 카드 자동 생성)
  → ai-radar approve <artifactId> --channel instagram   (사용자, 터미널 또는 Notion 승인 DB)
  → ApprovalRecord(contentHash, renderedAssetHash, approvedBy=USER)
  → Scheduling (publications.status=PENDING, scheduledAt)
  → InstagramPublisher.publish (외부 API, UNVERIFIED)
  → PublicationRecord(externalId=media id)
  → 실패: attempt+1, 최대 N회, 애매한 결과(타임아웃 후 성공 여부 불명)는 externalId 조회로 검증 후에만 재시도
  → 정정: RETRACTION Artifact + 새 승인, 원본 record RETRACTED 표시
```

필수 보장 항목과 담당 계약:

| 요구 | 계약 |
| --- | --- |
| public/private 분류 | `Claim.visibility`, `Artifact.visibility` |
| private data 제외 | visibility AND + Obsidian 사용자 노트 미전송 |
| approval | `ApprovalRecord` |
| revision hash | `Artifact.contentHash`, `ApprovalRecord.contentHash` |
| rendered asset hash | `ApprovalRecord.renderedAssetHash` |
| duplicate posting 방지 | `publications` PK + externalId 조회 |
| publication ID | `PublicationRecord.externalId` |
| failure retry | `attempt`, `status` |
| ambiguous result 검증 | Publisher.verify(externalId) 후 재시도 |
| correction/retraction | `RETRACTED` status + RETRACTION Artifact |

Collector/Analyzer/Librarian 어느 것도 `Publisher` Port를 주입받지 않는다.

**UNVERIFIED EXTERNAL CONSTRAINT**: Instagram Graph API의 게시 절차(컨테이너 생성 → 게시), 캐러셀 제한, 비즈니스 계정 요구, rate limit. 확인 방법: 구현 착수 시 Meta 공식 문서와 샌드박스 계정으로 검증 후 `adapters/instagram/README.md` 에 기록.

---

## 7. 사용자 피드백 설계

| 신호 | 종류 | 해석 |
| --- | --- | --- |
| Notion `Applied` 체크 | EXPLICIT_APPLIED | 강한 긍정. 해당 item의 entity/category 가중 |
| Notion `Read` 체크 | IMPLICIT_READ | 약한 긍정 (소비함) |
| 체크 없음 | (이벤트 없음) | 해석 안 함 |
| CLI `ai-radar feedback <itemId> --up/--down` (향후) | EXPLICIT_POSITIVE/NEGATIVE | 직접 신호 |
| Obsidian Knowledge Note frontmatter `ai-radar.feedback: applied \| useful \| wrong` (Phase 5) | EXPLICIT_APPLIED / EXPLICIT_POSITIVE / EXPLICIT_NEGATIVE | Librarian 읽기 단계가 수집. 사용자 영역(frontmatter)을 읽기만 한다 |

`FeedbackProfile` 은 FeedbackEvent 집계 뷰이며 RankingInput의 optional 필드다. 정책 버전이 profile 사용 여부를 결정한다. 초기 정책 v1은 profile을 무시한다 (데이터가 없으므로).

---

## 8. 외부 OSS 검증 결과 (2026-09-12, 실제 소스 확인)

상세 보고서는 이 설계 세션에서 raw.githubusercontent.com / GitHub API로 직접 읽어 작성했다. 요약:

### 8.1 Horizon (`Thysrael/Horizon`)

| 항목 | 확인 결과 |
| --- | --- |
| 언어 / 라이선스 | **Python** (TypeScript 아님) / MIT (`LICENSE`, `pyproject.toml`) |
| 활동 | 9.3k stars, 2026-09-12 push |
| 소스 | HN(Firebase API), RSS(feedparser), Reddit(비인증 .json → RSS → old.reddit HTML fallback), GitHub(events/releases), Telegram(HTML scrape), Twitter(Apify 유료 또는 Playwright 쿠키), OpenBB, OSS Insight, GDELT, Google News. **arXiv·YouTube 없음** |
| Raw 접근 | CLI 경로는 LLM Markdown만 저장. **MCP 경로(`horizon-mcp`)의 `hz_fetch_items` 는 LLM 없이 수집만 실행해 `raw_items.json`(ContentItem 전체) 저장** (`src/mcp/service.py:304-350`, `src/orchestrator.py:173-218` 에 AI client 없음) |
| 본문 완전성 | RSS+extractor=FULL, RSS=EXCERPT, HN/GitHub=TITLE_ONLY+댓글. 댓글은 `--- Top Comments ---` 뒤 문자열로 평탄화(500자 절단) |
| Metric | HN score/descendants, Reddit score/upvote_ratio/num_comments. GitHub star 없음 |
| Pagination/checkpoint | 시간 window만. **checkpoint 없음** (재실행 시 같은 항목 재수집 → 우리 hash dedupe가 흡수) |
| 실패 처리 | 소스별 try/except, `success/empty/failure` 구분, 전부 실패 시에만 중단. 좋은 모델 |
| LLM | 9개 provider. **수집에는 불필요** |
| MCP | 서버 제공(13 tools, 7 resources). 소비 안 함 |
| 보안 | SSRF guard(`src/url_security.py`) 우수. 단 config `${VAR}` 확장으로 임의 env를 URL에 넣을 수 있고, `.cursor/mcp.secrets.json` 등에서 secret 암묵 로딩 → **우리가 config와 env를 통제해서 실행** |
| 계약 변환 난이도 | LOW–MEDIUM. `ContentItem` ↔ `NormalizedDocument` 거의 1:1. 결손: rawPayload 없음, published_at non-null(무날짜 항목 드롭), completeness 추론 필요, comments 문자열 파싱 |
| 라이브러리/프로세스 | PyPI 미배포. TS에서는 **MCP 또는 프로세스**로만 사용 |

결정: **외부 프로세스 + `hz_fetch_items` 출력 ingest** (ADR-0003). Reddit fallback 체인과 SSRF guard는 향후 TS 포팅 후보.

### 8.2 agents-radar (`duanyytop/agents-radar`)

| 항목 | 확인 결과 |
| --- | --- |
| 언어 / 라이선스 | TypeScript (ESM) / MIT |
| 활동 | 1.0k stars, 2026-09-11 push. GitHub Actions 워크플로 형태, 패키지 아님 |
| 소스 | GitHub issues/PRs/releases(REST, `since` pagination 실구현, `/pulls` 는 client-side filter), Discussions(GraphQL), Trending(HTML regex, 취약), arXiv(Atom, regex 파싱), HF, Product Hunt(token), Dev.to, Lobste.rs, Anthropic/OpenAI 블로그(sitemap lastmod diff + `web-state.json` **진짜 checkpoint**) |
| Raw 접근 | **구조적 저장 없음.** 메모리 → LLM → Markdown. `highlights.json` 도 LLM 출력. MCP 서버(Cloudflare Worker)는 Markdown만 제공 |
| 본문 | arXiv 초록 FULL, GitHub body FULL, HN TITLE_ONLY, 댓글 본문 미수집(개수만) |
| LLM | 모듈 top-level에서 provider 생성 → 파이프라인 실행에 필수. 단 fetcher 모듈은 LLM 무관·의존성 0 |
| 보안 | 셸 실행 없음, env 접근 좁음, SSRF guard 없음, 호스팅 MCP는 저자 계정 |
| 계약 변환 난이도 | fetcher 포팅 MEDIUM, 전체 채택 HIGH |

결정: **파이프라인 채택 안 함. `github.ts`, `web.ts`, `arxiv.ts` 와 `config.yml` repo 목록을 MIT attribution 하에 포팅** (Phase 3). `trending.ts`, prompt 계층은 제외.

### 8.3 공통 결손과 우리 대응

두 프로젝트 모두 upstream raw payload와 구조화된 `comments[]` 를 보존하지 않는다. AI Radar의 `RawObservation.payloadRef` 와 `NormalizedComment[]` 는 이 결손을 우리 adapter 경계에서 메우기 위한 것이다.

### 1.6 Notion 리포트 DB (2026-09-13 추가)

| 항목 | 값 |
| --- | --- |
| DB | `AI Radar Reports` (Daily DB 와 별개, 같은 workspace 최상위) |
| 환경변수 | `NOTION_REPORTS_DATABASE_ID`, optional `NOTION_REPORTS_DATA_SOURCE_ID`. 없으면 reports 단계는 SKIPPED (Daily 는 링크 없이 발행) |
| 속성 | Name(title), Date(date), Section(select: AI 교양 / AI Coding / LLM / Agent Engineering / Evals & Reliability / AI Economics / Trend Watch / 전체 목록), Items(number), Importance(number), Read, Applied |
| upsert 키 | Date + Section. 2개 이상이면 중단 |
| 사용자 필드 | Read, Applied 는 생성 시에만 false, 갱신 시 제외 (Daily DB 와 동일 규칙) |
| 본문 | 첫 블록 `ai-radar:revision:<n>` callout. 전체 목록 페이지는 이야기마다 Notion bookmark 블록(썸네일 카드)을 넣는다. 이미지는 Notion 이 미리보기를 가져오며 우리는 수집하지 않는다 |
| 링크 방향 | Daily 페이지 → 섹션 리포트 / 전체 목록 (URL). Relation 속성은 두지 않는다 (Daily 페이지가 나중에 만들어지므로) |

Obsidian 에는 리포트를 복제하지 않는다 (지식 노트 역할 유지).
