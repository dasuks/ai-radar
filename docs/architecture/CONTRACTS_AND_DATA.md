# Contracts and Data

문서 버전: 1.0 (2026-09-12)
관련 ADR: ADR-0002 (Canonical Data Model), ADR-0004 (Entity/Metric/Trend), ADR-0005 (Storage/Reprocessing)

이 문서는 AI Radar의 **persistent contract** 를 필드 수준으로 정의한다. 여기 정의된 계약은 `src/domain/` 에 TypeScript 타입과 validator로 구현되며, Adapter는 이 계약을 향해 변환한다.

표기: 타입은 TypeScript 유사 표기. `?`는 optional, `| null`은 "모르는 값은 null로 정직하게 기록"을 뜻한다. 모든 시각은 ISO 8601 UTC 문자열, timezone이 의미 있는 곳(target window)은 별도 필드로 둔다.

---

## 0. 공통 규칙

### 0.1 schemaVersion

모든 persistent 계약은 `schemaVersion: number` (정수, 1부터)를 가진다.

- 호환 추가(필드 추가, enum 값 추가)는 **minor**: 버전을 올리되 upcast는 기본값 채움만 한다.
- 비호환 변경(필드 의미 변경, 삭제, 키 변경)은 **major**: `domain/<contract>/upcast.ts` 에 `vN → vN+1` 함수를 추가하고, 읽기 경로는 항상 최신 버전으로 upcast한 뒤 사용한다.
- 저장된 데이터는 제자리에서 다시 쓰지 않는다. 읽을 때 upcast하고, 필요하면 migration 명령으로 일괄 재기록한다 (§6).

### 0.2 ID 규칙

| 객체 | ID 형식 | 생성 방식 | 이유 |
| --- | --- | --- | --- |
| RawObservation | `obs_<sha256[:24]>` | `hash(sourceId ┃ externalId ┃ payloadHash)` | 같은 payload 재수집 = 같은 ID (idempotent) |
| NormalizedDocument | `doc_<sha256[:24]>` | `hash(sourceId ┃ externalId)` | 같은 소스의 같은 항목은 여러 observation을 가져도 하나의 document |
| Entity | `ent_<ulid>` | 생성 시 ULID | 이름은 바뀌므로 이름 기반 ID 금지 |
| MetricObservation | 복합 unique (§3.1) | – | 자연키로 중복 방지 |
| DerivedSignal | 복합 unique (§3.2) | – | 재계산 가능 |
| Claim | `clm_<ulid>` | ULID | – |
| Evidence | `evd_<sha256[:24]>` | `hash(documentId ┃ locator)` | 같은 위치 인용 = 같은 evidence |
| Artifact | `art_<type>_<targetKey>` + `revision` | 결정적 | 같은 날짜 Daily는 하나의 Artifact, revision만 증가 |
| Run | `run_<ulid>` | ULID | – |

`┃`는 구분자 U+001F(unit separator)를 뜻한다. hash 입력은 정규화(trim, lower-case for sourceId)한다. ULID 생성은 `domain/shared/ids.ts` 가 `Clock`과 random source를 인자로 받아 만든다 (테스트 결정성).

### 0.3 Provenance 공통 블록

분석 결과(Claim, Classification, DerivedSignal, Artifact)는 다음을 공통으로 가진다.

```ts
interface Provenance {
  method: "RULE" | "LLM" | "HUMAN" | "DERIVED";
  policyId?: string;        // 예: "ranking.practical"
  policyVersion?: string;   // 예: "1.0.0"
  promptId?: string;        // 예: "extract-claims"
  promptVersion?: string;
  model?: string;           // 예: "claude-sonnet-5"
  provider?: string;        // 예: "anthropic"
  runId: string;
  createdAt: string;
}
```

---

## 1. Documents

### 1.1 RawObservation (schemaVersion 1)

Source에서 확보한 payload의 **불변 snapshot**. 재분석의 유일한 원천.

```ts
type ContentCompleteness = "FULL" | "EXCERPT" | "TITLE_ONLY" | "MISSING";
type SourceKind = "API" | "RSS" | "SCRAPE" | "EXTERNAL_TOOL" | "MANUAL";

interface RawObservation {
  schemaVersion: 1;
  id: string;                     // obs_…
  sourceId: string;               // "hackernews", "rss:simonwillison", "horizon:reddit", "manual-json"
  sourceKind: SourceKind;         // "API" | "RSS" | "SCRAPE" | "EXTERNAL_TOOL" | "MANUAL"
  externalId: string;             // 소스 안에서의 고유 ID (HN item id, GitHub node id, RSS guid, URL fallback)
  originalUrl: string | null;
  observedAt: string;             // 소스가 이 상태를 보고한 시각 (API의 timestamp). 모르면 fetchedAt과 동일하되 observedAtIsFetchedAt=true
  observedAtIsFetchedAt: boolean;
  fetchedAt: string;              // 우리가 받은 시각
  runId: string;
  payloadHash: string;            // sha256 of canonical JSON payload
  payloadRef: PayloadRef;         // 인라인 또는 파일 포인터
  completeness: ContentCompleteness;   // 이 payload 안에 본문이 어느 정도 있는가
  rawMetadata: Record<string, string | number | boolean | null>;  // 소스 고유 소형 메타 (subreddit, feed title …)
}

type PayloadRef =
  | { kind: "inline"; json: unknown }                      // 작은 payload (< 32KB)
  | { kind: "file"; path: string; bytes: number; encoding: "json" | "html" | "text" };  // data/store/raw/<sourceId>/<yyyy-mm>/<obsId>.<ext>
```

규칙:
- RawObservation은 **수정하지 않는다**. 같은 (sourceId, externalId)의 새로운 상태는 새 observation이다 (metric 변화 추적의 기반).
- 원문이 삭제·비공개된 것을 확인하면 `completeness: "MISSING"`, `rawMetadata.tombstone = true`, `payloadRef` 에 확인 응답(404 등)을 담은 **tombstone observation** 을 새로 기록한다. 이전 observation은 그대로 남는다. 원문이 수정된 경우는 새 hash의 일반 observation이다.
- `completeness`는 adapter가 payload를 보고 정직하게 판정한다. 본문이 없는데 title만 있으면 `TITLE_ONLY`.
- `rawMetadata` 값에 secret, 쿠키, 인증 헤더가 들어가면 안 된다 (adapter 테스트로 검증).

### 1.2 NormalizedDocument (schemaVersion 1)

```ts
interface NormalizedDocument {
  schemaVersion: 1;
  id: string;                    // doc_…
  sourceId: string;
  externalId: string;
  latestObservationId: string;   // 이 문서의 최신 snapshot
  firstObservationId: string;
  title: string;
  content: string | null;        // 본문 텍스트 (HTML 제거). null이면 completeness가 TITLE_ONLY/MISSING
  contentCompleteness: ContentCompleteness;
  author: { name: string | null; externalId: string | null; url: string | null };
  language: string | null;       // BCP-47, 감지 실패 시 null
  publishedAt: string | null;    // 모르면 null. fetchedAt으로 채우지 않는다
  updatedAt: string | null;
  fetchedAt: string;             // latest observation의 fetchedAt
  canonicalUrl: string | null;   // 정규화된 URL (tracking param 제거, 소문자 host)
  urls: string[];                // 본문 안 링크 (entity 해석·linking 입력)
  comments: NormalizedComment[]; // 비어 있을 수 있음. 최대 N개, 원본 순서
  metrics: MetricSnapshot[];     // 이 문서 자체에 대한 관측값 (score, comments …)  → MetricObservation으로도 기록됨
  tags: string[];                // 소스가 제공한 태그/서브레딧/카테고리 (분석 입력, 분류 결과 아님)
  status: "ACTIVE" | "CORRECTED" | "DELETED";   // CORRECTED: 이전 observation과 본문 hash가 다름. DELETED: tombstone observation 확인
  provenance: { normalizerVersion: string; runId: string; normalizedAt: string };
}

interface NormalizedComment {
  externalId: string;
  author: string | null;
  content: string;
  score: number | null;
  publishedAt: string | null;
  parentExternalId: string | null;
}

interface MetricSnapshot { key: MetricKey; value: number; observedAt: string; }
```

규칙:
- 하나의 (sourceId, externalId)에 대해 document는 하나. 새 observation이 오면 `latestObservationId`, `content`, `metrics`, `updatedAt` 을 갱신한다(upsert).
- Normalizer는 LLM을 호출하지 않는다. 언어 감지는 결정적 라이브러리 또는 null.

### 1.3 DocumentLink

```ts
type LinkType = "SAME_URL" | "SAME_STORY" | "CROSS_POST" | "REPLY_TO" | "MENTIONS_URL";

interface DocumentLink {
  fromDocumentId: string;
  toDocumentId: string;
  type: LinkType;
  confidence: number;      // 0..1. SAME_URL=1.0 (결정적). SAME_STORY는 title similarity 규칙 또는 LLM
  provenance: Provenance;
}
```

Dedupe는 **삭제가 아니라 link** 다. Ranking과 Trend는 link cluster 단위로 mention을 센다.

---

## 2. Entities

### 2.1 Entity (schemaVersion 1)

```ts
type EntityType =
  | "MODEL" | "TOOL" | "SKILL" | "MCP_SERVER" | "FRAMEWORK"
  | "REPOSITORY" | "COMPANY" | "PERSON" | "CONCEPT";

interface Entity {
  schemaVersion: 1;
  id: string;                    // ent_…
  type: EntityType;
  canonicalName: string;
  aliases: string[];             // 정규화된 별칭 (EntityAlias 테이블의 뷰)
  officialUrl: string | null;
  repositoryUrl: string | null;  // github.com/owner/repo 정규형
  ecosystem: string | null;      // "claude-code", "cursor", "openai", "mcp" … (Skill/MCP의 소속)
  parentEntityId: string | null; // Skill → Tool, MCP_SERVER → Company 등 (선택)
  versionLabel: string | null;   // 모델/도구의 버전 표기 (별도 Entity로 만들지 않음)
  identityConfidence: number;    // 0..1. 자동 생성 entity는 < 1.0
  status: "ACTIVE" | "MERGED" | "RETIRED";
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EntityAlias { entityId: string; alias: string; normalized: string; source: "OFFICIAL" | "OBSERVED" | "HUMAN"; }

interface EntityMerge { fromEntityId: string; intoEntityId: string; reason: string; provenance: Provenance; }
```

정체성 규칙 (`domain/entities/identity.ts`, 순수 함수):
1. `repositoryUrl` 정규형이 같으면 같은 REPOSITORY.
2. `officialUrl` host+path 가 같으면 같은 entity (type 동일 시).
3. 정규화 이름(`NFKC, lower, 공백/하이픈 통일`) + type + ecosystem 이 모두 같으면 **후보**. 후보는 자동 merge하지 않고 `EntityMention.resolution = "CANDIDATE"` 로 남긴다.
4. 이름만 같고 type이나 ecosystem이 다르면 다른 entity다 ("frontend-design" skill과 "Frontend Design" concept은 별개).
5. Merge/split은 `EntityMerge` 로 기록하고 원래 ID는 `MERGED` 상태로 보존한다 (과거 mention·metric의 참조 유지).
6. **버전은 기본적으로 별도 Entity가 아니다** (`versionLabel` 로 표기). 특정 버전이 독립적으로 논의되어 별도 시계열이 필요할 때만(예: "Claude Sonnet 5" 와 "Claude 5 family") 자식 MODEL entity를 만들고 `parentEntityId` 로 연결한다. 판단은 사람이 `ai-radar entities split` 으로 한다.
7. **Entity 간 metric 상속·집계는 없다.** MCP_SERVER의 mention은 그 REPOSITORY의 star를 물려받지 않고, 자식 entity의 metric은 부모에 합산되지 않는다. 집계가 필요하면 policy가 `DerivedSignal`(향후 `SignalKey` 에 `ecosystem_mentions` 를 추가하는 식)로 명시적으로 계산하고 inputs에 어느 entity를 합쳤는지 기록한다.

### 2.2 EntityMention

```ts
interface EntityMention {
  documentId: string;
  entityId: string | null;       // 해석 성공 시
  surfaceForm: string;           // 문서에 나타난 표기
  resolution: "RESOLVED" | "CANDIDATE" | "UNRESOLVED";
  candidateEntityIds: string[];
  confidence: number;
  locator: EvidenceLocator;      // 어디에 나왔는가
  provenance: Provenance;
}
```

Unique: (documentId, surfaceForm, locator). Trend의 mention 집계는 `RESOLVED` 만 센다.

---

## 3. Metrics and Signals

### 3.1 MetricObservation (schemaVersion 1)

실제로 관측한 수치. 계산하지 않는다.

```ts
type MetricKey =
  | "github.stars" | "github.forks" | "github.open_issues" | "github.release_count"
  | "reddit.score" | "reddit.comments" | "hn.points" | "hn.comments"
  | "youtube.views" | "arxiv.citations"   // 향후 source용 예약. 현재 계획된 source 중 공급자 없음 (YouTube/Arxiv adapter 도입 시 활성)
  | "radar.mentions";            // AI Radar가 document 집계로 "관측"한 mention 수 (scope=ENTITY, window 필수)

type MetricSubjectType = "DOCUMENT" | "ENTITY";
type MetricScope = "ITEM" | "REPOSITORY" | "CHANNEL" | "ENTITY";

interface MetricObservation {
  schemaVersion: 1;
  subjectType: MetricSubjectType;
  subjectId: string;             // doc_… 또는 ent_…
  key: MetricKey;
  value: number;
  unit: "count" | "score" | "ratio";
  scope: MetricScope;            // 이 수치가 무엇의 범위인가
  observedAt: string;
  window: { start: string; end: string } | null;   // 누적값이면 null, 기간값이면 필수
  sourceId: string;
  observationId: string | null;  // 어느 RawObservation에서 왔는가 (radar.mentions는 null)
  coverage: CoverageNote;        // 관측 당시 수집 범위
}

interface CoverageNote { sourcesAttempted: number; sourcesSucceeded: number; truncated: boolean; note: string | null; }
```

Unique: `(subjectType, subjectId, key, sourceId, observedAt)`.

Scope 규칙 (위반은 저장 전 validator가 거부):
- `github.stars` 는 항상 `scope=REPOSITORY`, `subjectType=ENTITY(REPOSITORY)`. **Skill entity에 repository star를 기록할 수 없다.** Skill의 인기는 `radar.mentions(scope=ENTITY)` 또는 향후 install metric으로만 표현한다.
- `radar.mentions` 는 `window` 필수, `coverage` 필수.
- mention과 usage/install은 다른 key다. 합치지 않는다.
- `scope=CHANNEL` 은 채널(YouTube 채널, 뉴스레터, 서브레딧) 단위 수치(구독자 수 등)에 쓰며, subject는 그 채널을 소유한 `PERSON` 또는 `COMPANY` entity다. 채널 전용 EntityType은 두지 않는다. 채널 수치를 그 채널이 다룬 TOOL/MODEL의 인기로 기록할 수 없다.
- 생태계·부모 단위 집계는 MetricObservation이 아니라 DerivedSignal이다 (§2.1 규칙 7). MetricScope에 집계용 값은 없다.

### 3.2 DerivedSignal (schemaVersion 1)

```ts
type SignalKey =
  | "mention_velocity" | "mention_acceleration" | "source_diversity"
  | "star_delta_7d" | "engagement_delta" | "trend_score";

type SignalStatus = "COMPUTED" | "INSUFFICIENT_DATA" | "COLD_START" | "COVERAGE_CHANGED" | "SOURCE_FAILURE";

interface DerivedSignal {
  schemaVersion: 1;
  subjectType: MetricSubjectType;
  subjectId: string;
  key: SignalKey;
  window: { start: string; end: string };
  previousWindow: { start: string; end: string } | null;
  value: number | null;          // status가 COMPUTED일 때만 non-null
  status: SignalStatus;
  statusReason: string | null;   // "previous window has 0 observations" 등
  inputs: { metricKey: MetricKey; observationCount: number; sourceIds: string[] }[];
  provenance: Provenance;        // policyId="trend.engine", policyVersion 필수
}
```

```ts
interface DerivedSignalRef { subjectType: MetricSubjectType; subjectId: string; key: SignalKey; window: { start: string; end: string }; policyVersion: string; }
```

`DerivedSignalRef` 는 위 unique 키를 그대로 담은 참조 타입이며 Claim·Artifact·BriefItem이 signal을 가리킬 때 쓴다.

Unique: `(subjectType, subjectId, key, window.start, window.end, provenance.policyVersion)`.

DerivedSignal은 **재계산 가능**하다. policy 버전이 바뀌면 새 row가 생기고 옛 row는 남는다. Artifact는 어느 policyVersion을 썼는지 기록한다.

---

## 4. Evidence, Claims, Analysis

### 4.1 Evidence

```ts
type EvidenceLocator =
  | { kind: "document"; }                                  // 문서 전체
  | { kind: "excerpt"; start: number; end: number; text: string }   // content 오프셋 + 인용 텍스트
  | { kind: "comment"; commentExternalId: string; text: string }
  | { kind: "metric"; metricKey: MetricKey; observedAt: string };

interface Evidence {
  schemaVersion: 1;
  id: string;                    // evd_…
  documentId: string;
  observationId: string;         // 인용 당시 snapshot
  locator: EvidenceLocator;
  capturedAt: string;
  publishedAt: string | null;    // 문서의 publishedAt 복사 (정렬·시효 판단용)
}
```

### 4.2 Claim

```ts
type ClaimType =
  | "FACT"            // 검증 가능한 사실 (릴리스됨, 가격, 수치)
  | "OFFICIAL_CLAIM"  // 회사/저자의 공식 주장 (아직 검증 안 됨)
  | "USER_EXPERIENCE" // 특정 사용자의 경험 보고 (일반화 금지)
  | "OPINION"
  | "FORECAST"
  | "RUMOR"
  | "SYSTEM_INFERENCE"; // AI Radar가 signal로부터 추론 (evidence 대신 signal 참조 필수)

interface Claim {
  schemaVersion: 1;
  id: string;
  type: ClaimType;
  statement: string;                 // 한 문장, 한국어 또는 원문 언어
  statementLanguage: string;
  subjectEntityIds: string[];        // 무엇에 대한 주장인가
  evidenceIds: string[];             // SYSTEM_INFERENCE 외에는 최소 1개
  signalRefs: DerivedSignalRef[];    // SYSTEM_INFERENCE용 (§3.2)
  confidence: number;                // 0..1 (분석기의 확신, 사실성 아님)
  sentiment: "POSITIVE" | "NEGATIVE" | "MIXED" | "NEUTRAL" | "UNKNOWN";  // 근거 텍스트의 논조. 댓글 수로 추정 금지
  visibility: "PRIVATE" | "PUBLIC_OK";  // 공개 콘텐츠 사용 가능 여부 (§5.4)
  status: "ACTIVE" | "SUPERSEDED" | "RETRACTED";   // SUPERSEDED: 같은 subject에 대한 더 새로운 claim이 대체. RETRACTED: 근거 문서가 DELETED/CORRECTED 되어 더 이상 지지되지 않음
  supersededById: string | null;
  analysisId: string;
  provenance: Provenance;
}
```

상태 전이 규칙: Claim은 수정하지 않는다. 새 사실은 새 Claim이며, 이전 Claim을 `SUPERSEDED` 로 표시하고 `supersededById` 를 채운다. 근거 문서가 `CORRECTED` 되면 해당 Claim은 재분석 대상이 되고, 재분석 결과가 같은 statement를 재확인하지 못하면 `RETRACTED` 로 표시한다. Artifact가 RETRACTED claim을 포함하고 있으면 다음 Run에서 새 revision(또는 공개 채널은 RETRACTION Artifact)을 만든다 (`INTEGRATIONS_AND_SAFETY.md` §6.2).

불변 조건 (validator):
- `type !== "SYSTEM_INFERENCE"` → `evidenceIds.length >= 1`, 모든 ID가 존재하는 Evidence.
- `type === "SYSTEM_INFERENCE"` → `signalRefs.length >= 1`, 모든 signal이 `COMPUTED`.
- `OFFICIAL_CLAIM` 은 출처 문서의 author가 해당 entity의 official 채널일 때만 허용. 그렇지 않으면 `OPINION` 또는 `RUMOR`.
- `USER_EXPERIENCE` 의 statement에 "모든/대부분의 사용자" 같은 일반화 표현이 있으면 거부 (규칙 기반 lint, 완전하지는 않으므로 리뷰 대상 플래그).

### 4.3 AnalysisRecord

LLM 또는 규칙 실행 한 건의 기록. 비용·재현성·감사 용도.

```ts
interface AnalysisRecord {
  schemaVersion: 1;
  id: string;
  task: "CLASSIFY" | "EXTRACT_ENTITIES" | "EXTRACT_CLAIMS" | "LINK_STORIES" | "SYNTHESIZE" | "WRITE_BRIEF_KO" | "PROPOSE_KNOWLEDGE";
  inputDocumentIds: string[];
  inputEvidenceIds: string[];       // LLM에 보여준 evidence 집합 = 출력 evidenceIds의 허용 집합
  provenance: Provenance;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number } | null;
  outputHash: string;               // 검증 통과한 출력의 hash
  validation: { schemaOk: boolean; evidenceOk: boolean; rejectedItems: number; notes: string[] };
  status: "SUCCEEDED" | "FAILED" | "PARTIAL";
}
```

### 4.4 Classification

```ts
type EditorialCategory =
  | "CULTURE" | "AI_CODING" | "LLM" | "AGENT_ENGINEERING" | "EVALS_RELIABILITY" | "AI_ECONOMICS" | "OTHER";

interface Classification {
  documentId: string;
  categories: { category: EditorialCategory; confidence: number }[];   // 다중 허용
  audience: "PRACTITIONER" | "GENERAL" | "RESEARCH";
  provenance: Provenance;
}
```

Category는 **편집 분류**다. 서비스 경계도, Store 분할 기준도 아니다.

---

## 5. Artifacts, Approval, Publication

### 5.1 Artifact envelope (schemaVersion 1)

```ts
type ArtifactType = "DAILY_BRIEF" | "WEEKLY_REPORT" | "TREND_REPORT" | "ALERT" | "KNOWLEDGE_PROPOSAL" | "SOCIAL_POST_DRAFT";
type ArtifactStatus = "DRAFT" | "FINAL" | "APPROVED" | "PUBLISHED" | "RETRACTED";

interface Artifact<TBody> {
  schemaVersion: 1;
  id: string;                  // art_<type>_<targetKey>
  type: ArtifactType;
  targetKey: string;           // DAILY_BRIEF: "2026-09-12", WEEKLY: "2026-W37", ALERT: "<entityId>:<signalKey>:<window>"
  revision: number;            // 1부터. 내용이 바뀌면 +1
  contentHash: string;         // body의 canonical JSON hash
  status: ArtifactStatus;
  timezone: string;            // "Asia/Seoul"
  window: { start: string; end: string };
  body: TBody;                 // 타입별 계약 (§5.2)
  inputs: {                    // 근거 추적
    claimIds: string[];
    documentIds: string[];
    signalRefs: DerivedSignalRef[];
    rankingPolicies: { id: string; version: string }[];
    runId: string;
  };
  visibility: "PRIVATE" | "PUBLIC_OK";   // 모든 포함 claim이 PUBLIC_OK일 때만 PUBLIC_OK
  createdAt: string;
}
```

Unique: `(type, targetKey, revision)`. "현재 revision"은 `artifacts_current(type, targetKey) → revision` 포인터.

용어: **ArtifactRevision** 은 별도 계약이 아니라 위 envelope의 row 하나(특정 revision)를 가리키는 말이다. **ArtifactHead** 는 `artifacts_current` 의 포인터 `{ type, targetKey, revision }` 다. 코드에서는 `type ArtifactRevision<T> = Artifact<T>`, `interface ArtifactHead { type: ArtifactType; targetKey: string; revision: number }` 로 둔다.

### 5.2 DailyBrief body (bodySchemaVersion 2; envelope `Artifact.schemaVersion` 은 1)

현재 구현의 `DailyBriefing`(암묵적 v1)을 확장한다. v1 → v2 upcast는 `MIGRATION_AND_ACCEPTANCE.md` §3.2.

```ts
interface DailyBriefBody {
  bodySchemaVersion: 2;
  date: string;                       // YYYY-MM-DD (target timezone 기준)
  title: string;                      // 기본 "AI Intelligence Daily"
  oneMinuteSummary: string[];         // 1. 오늘 1분 요약
  sections: BriefSection[];           // 2~8. 비어 있는 섹션은 포함하지 않는다
  learnOneThing: BriefItem | null;    // 9. 오늘 하나만 배운다면
  applyCandidates: ApplyCandidate[];  // 10. 내 환경에 적용할 후보
  sources: SourceRef[];               // 11. Sources (전체 근거의 유일 목록)
  coverage: RunCoverageSummary;       // 수집 실패·부분 수집 사실을 독자에게 알림
}

type BriefSectionKind = "CULTURE" | "AI_CODING" | "LLM" | "AGENT_ENGINEERING" | "EVALS_RELIABILITY" | "AI_ECONOMICS" | "TREND_WATCH";

interface BriefSection { kind: BriefSectionKind; items: BriefItem[]; }

interface BriefItem {
  id: string;                         // `item_<sha256[:16]>`. 자동 생성: hash(artifactId ┃ 정렬된 claimIds). manual override: hash(artifactId ┃ v1 topic.id)
  title: string;
  importance: 1 | 2 | 3 | 4 | 5;
  whatChanged: string;
  whyItMatters: string;
  howDevelopersUseIt: string | null;  // PRACTICAL 항목에서 주로 채움
  howToApply: string | null;
  claimIds: string[];                 // 본문의 각 문장은 이 claim들에서만 나와야 한다
  entityIds: string[];
  trend: { signalRef: DerivedSignalRef; label: string } | null;   // TREND_WATCH 항목
  sourceRefs: SourceRef[];            // 이 item의 근거 (sources의 부분집합)
  rankingTrace: { policyId: string; policyVersion: string; score: number; reasons: string[] };
  knowledgeType: "concept" | "pattern" | "workflow" | "tool" | "architecture" | "research" | null;   // Librarian 힌트 (현재 topic.type 호환)
  related: string[];                  // 관련 개념 표시명 (Obsidian 링크 후보)
}

interface SourceRef { documentId: string; title: string; url: string; sourceId: string; publishedAt: string | null; }
interface ApplyCandidate { itemId: string; action: string; effort: "S" | "M" | "L"; prerequisites: string[]; }
interface RunCoverageSummary { sourcesAttempted: string[]; sourcesFailed: string[]; partial: boolean; note: string | null; }
```

### 5.3 ApprovalRecord / PublicationRecord

```ts
interface ApprovalRecord {
  artifactId: string;
  revision: number;
  contentHash: string;         // 승인 시점 hash. publish 시 재검증
  renderedAssetHash: string | null;   // 카드 이미지 등 렌더 결과 hash (있을 때)
  channel: ChannelId;
  approvedBy: "USER" | "POLICY";      // PRIVATE 채널은 POLICY 자동 승인
  approvedAt: string;
  note: string | null;
}

type ChannelId = "notion" | "obsidian" | "discord" | "email" | "instagram" | "web";

interface PublicationRecord {
  artifactId: string;
  revision: number;
  channel: ChannelId;
  externalId: string | null;   // Notion page id, Instagram media id …
  externalUrl: string | null;
  status: "PENDING_APPROVAL" | "PENDING" | "SUCCEEDED" | "FAILED" | "RETRACTED";   // PENDING_APPROVAL: 공개 채널 승인 대기. PENDING: 승인됨, 발행 대기(스케줄)
  attempt: number;
  renderedHash: string;
  scheduledAt: string | null;  // PENDING 상태에서 발행 예정 시각 (스케줄 채널). null이면 즉시
  publishedAt: string | null;
  error: string | null;
  runId: string;
}
```

Primary key: `(artifactId, channel, revision)`. revision마다 row가 하나 생겨 발행 이력이 남는다. 채널 안의 **외부 객체**(Notion page 등)의 정체성은 `externalId` 가 나타내며, in-place 갱신 채널(notion, obsidian)은 새 revision row가 이전 row의 `externalId` 를 이어받는다(같은 page를 갱신). 수정 불가 채널(instagram)은 새 revision을 발행하지 않고 이전 row를 `RETRACTED` 로 표시한 뒤 RETRACTION Artifact를 따로 발행한다. "이 artifact가 이 채널에 이미 나갔는가" 는 `(artifactId, channel)` 로 조회하고 최신 revision row의 status로 판단한다. 채널별 정책은 `INTEGRATIONS_AND_SAFETY.md` §6.2.

### 5.4 Visibility

- `PRIVATE`: 기본값. 개인 메모, 유료/제한 소스, 라이선스 불명 인용, 개인 식별 정보 포함 문서에서 나온 claim.
- `PUBLIC_OK`: 공개 소스(공식 블로그, 공개 repo, 공개 게시글)의 짧은 인용 + 우리 문장으로 재서술 가능한 claim.
- 결정은 규칙(`policies/classification/visibility.ts`)이 하고, 기본은 PRIVATE. Artifact의 visibility는 포함된 claim의 AND.

---

## 6. Run, Events, Feedback

### 6.1 Run

```ts
type RunStatus = "RUNNING" | "SUCCESS" | "PARTIAL_SUCCESS" | "NO_NEW_INFORMATION" | "SOURCE_FAILURE" | "ANALYSIS_FAILURE" | "OUTPUT_FAILURE" | "ABORTED";

interface Run {
  schemaVersion: 1;
  id: string;
  kind: "DAILY" | "WEEKLY" | "REANALYZE" | "PUBLISH_ONLY" | "LIBRARIAN_ONLY";
  startedAt: string;
  finishedAt: string | null;
  targetWindow: { start: string; end: string };
  timezone: string;
  status: RunStatus;
  counters: {
    sourcesAttempted: string[]; sourcesSucceeded: string[]; sourcesFailed: string[];
    observationsCollected: number; observationsNew: number; documentsUpserted: number;
    linksCreated: number; entitiesResolved: number; metricsRecorded: number; signalsComputed: number;
    claimsCreated: number; claimsRejected: number; artifactsCreated: string[]; publications: string[];
  };
  llmUsage: { provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null }[];
  errors: { stage: string; sourceId?: string; message: string; retryable: boolean }[];
  stages: RunStage[];
}

interface RunStage { name: string; status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED"; startedAt: string | null; finishedAt: string | null; checkpoint: unknown | null; }
```

상태 판정 규칙은 `PIPELINES_AND_POLICIES.md` §4.

### 6.2 DomainEvent

```ts
type DomainEvent =
  | { type: "ITEM_COLLECTED"; observationId: string; sourceId: string }
  | { type: "ITEM_NORMALIZED"; documentId: string }
  | { type: "ENTITY_RESOLVED"; entityId: string; documentId: string }
  | { type: "METRIC_RECORDED"; subjectId: string; key: MetricKey }
  | { type: "ANALYSIS_CREATED"; analysisId: string }
  | { type: "ARTIFACT_CREATED"; artifactId: string; revision: number }
  | { type: "KNOWLEDGE_PROPOSED"; proposalId: string }
  | { type: "PUBLICATION_REQUESTED"; artifactId: string; channel: ChannelId }
  | { type: "PUBLICATION_COMPLETED"; artifactId: string; channel: ChannelId; externalId: string | null };
```

모든 이벤트는 `{ runId, at }` envelope에 담겨 `run_events` 에 append된다. 소비자는 현재 로그뿐이다.

### 6.3 FeedbackEvent

```ts
interface FeedbackEvent {
  schemaVersion: 1;
  id: string;
  subject: { artifactId: string; itemId: string | null } | { entityId: string };
  kind: "EXPLICIT_POSITIVE" | "EXPLICIT_NEGATIVE" | "EXPLICIT_APPLIED" | "IMPLICIT_READ";
  channel: ChannelId | "cli";
  observedAt: string;
  source: "NOTION_READ_CHECKBOX" | "NOTION_APPLIED_CHECKBOX" | "CLI" | "OBSIDIAN_FRONTMATTER";   // OBSIDIAN_FRONTMATTER: Knowledge Note frontmatter `ai-radar.feedback: applied | useful | wrong` 을 Librarian 읽기 단계가 수집 (Phase 5, INTEGRATIONS §7)
}
```

`IMPLICIT_IGNORED` 같은 부정 추론 이벤트는 **존재하지 않는다**. Unread는 신호가 아니다.

### 6.3.1 FeedbackProfile (집계 뷰, 저장하지 않음)

`RankingInput.feedbackProfile` 에 들어가는 값. FeedbackEvent를 window로 집계해 매 Run 계산한다.

```ts
interface FeedbackProfile {
  computedAt: string;
  window: { start: string; end: string };        // 기본 90일
  entityAffinity: { entityId: string; applied: number; read: number; positive: number; negative: number }[];
  categoryAffinity: { category: EditorialCategory; applied: number; read: number }[];
  knowledgeTypeAffinity: { knowledgeType: string; applied: number }[];
  eventCount: number;                            // 0이면 정책은 profile을 무시한다
}
```

정책이 profile을 쓰는 방식은 정책 버전에 속한다. 부정 신호는 `negative` (EXPLICIT_NEGATIVE)만이며, `read=0` 은 어떤 항에도 기여하지 않는다.

### 6.4 KnowledgeUpdateProposal

```ts
interface KnowledgeUpdateProposal {
  schemaVersion: 1;
  id: string;
  targetNote: { path: string | null; title: string; entityId: string | null; folder: string };   // path null = 신규
  operation: "CREATE" | "UPDATE_MANAGED_REGION" | "APPEND_EVIDENCE" | "MARK_OUTDATED";
  managedRegions: { region: "daily" | "content" | "evidence" | "status" | "knowledge-updates"; markdown: string }[];   // 마커 이름 = `ai-radar:<region>`; evidence는 `ai-radar:evidence:<date>`
  claimIds: string[];
  conflicts: { kind: "AMBIGUOUS_MATCH" | "USER_EDITED_MANAGED_REGION" | "NOTE_MOVED" | "CONTRADICTS_EXISTING"; detail: string }[];
  decision: "AUTO_APPLY" | "NEEDS_REVIEW" | "REJECTED";
  provenance: Provenance;
}
```

---

## 7. Storage 결정

### 7.1 평가

| 후보 | 장점 | 단점 | 결론 |
| --- | --- | --- | --- |
| JSON 파일만 | 현재와 동일, git diff 가능 | unique constraint·index·window 쿼리를 직접 구현해야 함. Trend·idempotency가 파일 스캔이 됨 | Raw payload·Artifact 본문에는 적합, 인덱스 역할로는 부적합 |
| SQLite (`node:sqlite`) | Node 24 내장, 의존성 0, 단일 파일, 트랜잭션, unique/index | Node에서 아직 experimental 경고 출력. API 변경 가능성 | **채택** (Port 뒤에 격리, 위험은 §7.6) |
| SQLite (`better-sqlite3`) | 성숙, 동기 API | native build 의존성 (Windows 빌드 이슈 가능) | fallback |
| Postgres 등 | 확장성 | 개인용 단일 프로세스에 과함, 운영 부담 | 채택 안 함. 시나리오 17로 이행 가능성만 보장 |

### 7.2 3층 논리 저장소와 물리 배치

```
data/
  input/                 (git 추적) 수동 입력 brief 등. 현재 data/daily-brief.json 은 Phase 3까지 수동 override 입력으로 이 위치에서 읽히고, Phase 4에서 override 제거와 함께 data/input/ 으로 이동
  store/                 (gitignore)
    ai-radar.sqlite      Intelligence Store + 인덱스(Raw·Artifact 메타 포함)
    raw/<sourceId>/<yyyy-mm>/<obsId>.json|html     Raw payload 파일 (불변)
    artifacts/<type>/<targetKey>/r<revision>.json  Artifact body (불변)
    rendered/<channel>/<artifactId>/r<revision>.*  렌더 결과 (재생성 가능)
    runs/<runId>.json                              Run 기록 스냅샷 (DB와 이중 기록, 디버깅용)
```

| 논리 층 | 소유 테이블/파일 | 쓰기 주체 | 삭제 정책 |
| --- | --- | --- | --- |
| Raw Store | `raw_observations`, `raw/` | `CollectSources` 만 | 삭제 안 함 (용량 정책 시 오래된 payload 파일만 외부 보관으로 이동, row 유지) |
| Intelligence Store | documents, links, entities, mentions, metrics, signals, evidence, claims, analyses, classifications, feedback | 각 Use Case | Derived(signals, classifications)는 재계산 가능하므로 policy 버전 단위 삭제 허용. 나머지는 삭제 안 함 |
| Artifact Store | `artifacts`, `artifacts_current`, `approvals`, `publications`, `artifacts/` | `Build*`, `PublishArtifact` | 삭제 안 함. RETRACTED 상태로 표시 |
| Rendered cache | `rendered/` | `RenderArtifact` | 재생성 가능. 언제든 삭제 허용. 승인된 revision의 렌더 결과는 `renderedAssetHash` 로 검증되므로 삭제 후 재렌더 시 hash가 다르면 재승인 필요 |
| Run snapshots | `runs/<runId>.json` | `runtime/runs` | DB `runs` 와 이중 기록. 디버깅용. 90일 후 삭제 허용 (DB row는 유지) |

### 7.3 테이블 정의 (SQLite DDL v1)

```sql
-- src/adapters/storage/sqlite/migrations/0001_init.ts 의 sql 상수 (표기는 SQL)
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, timezone TEXT NOT NULL,
  status TEXT NOT NULL, record_json TEXT NOT NULL, schema_version INTEGER NOT NULL
);
CREATE INDEX runs_window ON runs(window_start, window_end);

CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL
);

CREATE TABLE source_checkpoints (
  source_id TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL, updated_at TEXT NOT NULL, run_id TEXT NOT NULL
);

CREATE TABLE raw_observations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, original_url TEXT, observed_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id), completeness TEXT NOT NULL,
  payload_ref_json TEXT NOT NULL, raw_metadata_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(source_id, external_id, payload_hash)
);
CREATE INDEX raw_obs_source_time ON raw_observations(source_id, observed_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
  latest_observation_id TEXT NOT NULL REFERENCES raw_observations(id),
  first_observation_id TEXT NOT NULL REFERENCES raw_observations(id),
  title TEXT NOT NULL, canonical_url TEXT, published_at TEXT, updated_at TEXT, fetched_at TEXT NOT NULL,
  content_completeness TEXT NOT NULL, language TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
  document_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX documents_published ON documents(published_at);
CREATE INDEX documents_canonical_url ON documents(canonical_url);

CREATE TABLE document_links (
  from_document_id TEXT NOT NULL REFERENCES documents(id), to_document_id TEXT NOT NULL REFERENCES documents(id),
  type TEXT NOT NULL, confidence REAL NOT NULL, provenance_json TEXT NOT NULL,
  PRIMARY KEY(from_document_id, to_document_id, type)
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, canonical_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  official_url TEXT, repository_url TEXT, ecosystem TEXT, parent_entity_id TEXT REFERENCES entities(id),
  identity_confidence REAL NOT NULL, status TEXT NOT NULL, merged_into_id TEXT REFERENCES entities(id),
  entity_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX entities_repo ON entities(repository_url) WHERE repository_url IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX entities_lookup ON entities(type, normalized_name, ecosystem);

CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id), alias TEXT NOT NULL, normalized TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized)
);
CREATE INDEX entity_aliases_normalized ON entity_aliases(normalized);

CREATE TABLE entity_merges (
  from_entity_id TEXT NOT NULL REFERENCES entities(id), into_entity_id TEXT NOT NULL REFERENCES entities(id),
  reason TEXT NOT NULL, provenance_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(from_entity_id, into_entity_id)
);

CREATE TABLE entity_mentions (
  document_id TEXT NOT NULL REFERENCES documents(id), surface_form TEXT NOT NULL, locator_hash TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id), resolution TEXT NOT NULL, candidate_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL, locator_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
  PRIMARY KEY(document_id, surface_form, locator_hash)
);
CREATE INDEX entity_mentions_entity ON entity_mentions(entity_id, resolution);

CREATE TABLE metric_observations (
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, key TEXT NOT NULL, source_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, scope TEXT NOT NULL,
  window_start TEXT, window_end TEXT, observation_id TEXT REFERENCES raw_observations(id),
  coverage_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  PRIMARY KEY(subject_type, subject_id, key, source_id, observed_at)
);
CREATE INDEX metric_obs_series ON metric_observations(subject_id, key, observed_at);

CREATE TABLE derived_signals (
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, key TEXT NOT NULL,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, policy_version TEXT NOT NULL,
  value REAL, status TEXT NOT NULL, status_reason TEXT, signal_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  PRIMARY KEY(subject_type, subject_id, key, window_start, window_end, policy_version)
);
CREATE INDEX derived_signals_window ON derived_signals(window_end, key, status);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
  observation_id TEXT NOT NULL REFERENCES raw_observations(id), locator_json TEXT NOT NULL,
  captured_at TEXT NOT NULL, published_at TEXT, schema_version INTEGER NOT NULL
);
CREATE INDEX evidence_document ON evidence(document_id);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), status TEXT NOT NULL,
  provider TEXT, model TEXT, prompt_id TEXT, prompt_version TEXT, output_hash TEXT NOT NULL,
  record_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, statement TEXT NOT NULL, analysis_id TEXT NOT NULL REFERENCES analyses(id),
  confidence REAL NOT NULL, sentiment TEXT NOT NULL, visibility TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', superseded_by_id TEXT REFERENCES claims(id),
  claim_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE claim_evidence (claim_id TEXT NOT NULL REFERENCES claims(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), PRIMARY KEY(claim_id, evidence_id));
CREATE TABLE claim_entities (claim_id TEXT NOT NULL REFERENCES claims(id), entity_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(claim_id, entity_id));
CREATE INDEX claim_entities_entity ON claim_entities(entity_id);

CREATE TABLE classifications (
  document_id TEXT NOT NULL REFERENCES documents(id), policy_version TEXT NOT NULL,
  classification_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(document_id, policy_version)
);

CREATE TABLE artifacts (
  id TEXT NOT NULL, type TEXT NOT NULL, target_key TEXT NOT NULL, revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
  body_ref TEXT NOT NULL, inputs_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(type, target_key, revision)
);
CREATE TABLE artifacts_current (type TEXT NOT NULL, target_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(type, target_key));

CREATE TABLE approvals (
  artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, channel TEXT NOT NULL, content_hash TEXT NOT NULL,
  rendered_asset_hash TEXT, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, note TEXT,
  PRIMARY KEY(artifact_id, revision, channel)
);

CREATE TABLE publications (
  artifact_id TEXT NOT NULL, channel TEXT NOT NULL, revision INTEGER NOT NULL, external_id TEXT, external_url TEXT,
  status TEXT NOT NULL, attempt INTEGER NOT NULL, rendered_hash TEXT NOT NULL, scheduled_at TEXT, published_at TEXT, error TEXT,
  run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(artifact_id, channel, revision)
);
CREATE INDEX publications_scheduled ON publications(status, scheduled_at);
CREATE INDEX publications_external ON publications(channel, external_id);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL,
  observed_at TEXT NOT NULL, source TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(subject_json, kind, source, observed_at)
);

CREATE TABLE knowledge_proposals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), target_path TEXT, target_title TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id), operation TEXT NOT NULL, decision TEXT NOT NULL,
  proposal_json TEXT NOT NULL, applied_at TEXT, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
```

설계 노트:
- `*_json` 컬럼은 계약 전체를 보관하고, 쿼리에 필요한 컬럼만 승격했다. 계약이 minor 변경될 때 DDL 변경 없이 흡수한다.
- Foreign key는 `PRAGMA foreign_keys = ON` 으로 강제한다.
- 모든 쓰기는 Use Case 단위 트랜잭션(`UnitOfWork` port) 안에서 수행한다. Raw payload 파일은 트랜잭션 전에 쓰고, row 커밋 실패 시 파일은 고아가 되어도 무해하다(같은 hash로 다음 실행에서 재사용).

### 7.4 Migration 전략

- `adapters/storage/sqlite/migrations/NNNN_<name>.ts` 순번 모듈이 SQL 문자열을 `export const sql` 로 내보내고 `index.ts` 가 순서대로 배열한다 (`.sql` 파일은 `tsc --outDir .test-dist` 로 복사되지 않으므로 TS 모듈로 둔다). 시작 시 `schema_migrations` 와 비교해 미적용분을 트랜잭션으로 적용한다.
- 계약 major 변경 시: (1) 새 컬럼/테이블 추가 migration, (2) `ai-radar migrate --contract <name>` 명령이 `*_json` 을 읽어 upcast 후 재기록, (3) 완료 후 옛 컬럼 제거는 다음 릴리스.
- 읽기 경로는 항상 `upcast()` 를 거치므로 (2)를 미루어도 동작한다.
- Downgrade는 지원하지 않는다. 대신 migration 전 `ai-radar.sqlite` 파일 복사본을 `store/backups/<timestamp>/` 에 남긴다.

### 7.5 재분석(Reprocessing) 보장

6개월 뒤 과거 데이터를 다시 분석하려면:
1. `raw_observations` + `raw/` 파일이 원본을 그대로 보존한다 (§1.1).
2. `ai-radar reanalyze --from 2026-03-01 --to 2026-03-31 --policy trend@2.0` 은 새 Run(kind=REANALYZE)을 만들고, Normalize 이후 단계를 다시 실행한다. 결과는 새 `policy_version` / `analysis_id` 로 저장되어 옛 결과와 공존한다.
3. Artifact를 다시 만들면 revision이 올라간다. 이미 발행된 revision은 그대로 남는다.
4. **REANALYZE Run은 기본적으로 발행하지 않는다.** 새 revision은 DRAFT/FINAL 상태로 Artifact Store에만 남고, 발행은 `ai-radar publish <artifactId> --channel <ch>` 로 명시적으로 한다. 공개 채널은 이때도 승인 절차를 거친다.

### 7.6 UNVERIFIED EXTERNAL CONSTRAINT

- **`node:sqlite` 안정성.** Node 24.14에서 import는 성공하나 ExperimentalWarning을 출력한다. API가 바뀌면 `adapters/storage/sqlite/driver.ts` 한 파일만 영향을 받도록 driver 래퍼를 둔다. 확인 방법: Phase 2 착수 시 `node --no-warnings -e "require('node:sqlite')"` 와 공식 Node 문서의 stability index를 확인하고, Stable이 아니면 `better-sqlite3` 로 driver를 교체한다.

---

## 8. Idempotency Key 표

| 단계 | 객체 | Key | 재실행 시 동작 |
| --- | --- | --- | --- |
| Collect | RawObservation | (sourceId, externalId, payloadHash) | 동일 payload는 skip. 변경된 payload는 새 observation |
| Normalize | NormalizedDocument | (sourceId, externalId) | upsert |
| Link | DocumentLink | (from, to, type) | upsert (confidence 갱신) |
| Entity | Entity | repositoryUrl 또는 (type, normalizedName, ecosystem)+수동확정 | 기존 재사용. 후보는 CANDIDATE로 보류 |
| Mention | EntityMention | (documentId, surfaceForm, locatorHash) | upsert |
| Metric | MetricObservation | (subjectType, subjectId, key, sourceId, observedAt) | 동일 키 skip |
| Signal | DerivedSignal | (subject, key, window, policyVersion) | 동일 키 덮어쓰기 (결정적 계산) |
| Evidence | Evidence | hash(documentId, locator) | 재사용 |
| Claim | Claim | analysis 단위. 같은 (task, inputEvidenceIds, promptVersion, model) → 기존 AnalysisRecord 재사용 (캐시) | LLM 재호출 없음 |
| Artifact | Artifact | (type, targetKey) + contentHash | contentHash 동일 → revision 증가 없음 |
| Approval | ApprovalRecord | (artifactId, revision, channel) | 재승인 불필요 |
| Publication | PublicationRecord | PK (artifactId, channel, revision); 채널 객체 정체성은 externalId | 같은 revision이 SUCCEEDED → skip. 새 revision은 이전 row의 externalId를 이어받아 같은 외부 객체를 갱신. Notion은 Date 조회로 externalId 재확인 |
| Obsidian Evidence | managed region marker `ai-radar:evidence:<date>` (노트당 날짜별 1개) | 같은 marker 교체 |
| Knowledge Proposal | (targetTitle, operation, claimIds hash) | 중복 제안 생성 안 함 |
| SNS Post | (artifactId, channel) + approval contentHash | 동일 hash 발행 완료면 skip. 다른 hash면 재승인 필요 |

## 9. 리포트 계층 계약 (2026-09-13 추가)

사용자 요구: Daily 는 너무 요약돼 있으니 (1) 오늘 들어온 이야기 **전부**를 담는 목록과 (2) 섹션(주제)마다 **긴 상세 리포트**를 두고, Daily 는 그 위의 짧은 요약으로 바꾼다. 구현은 `src/domain/artifacts/section-report.ts`.

| Artifact type | targetKey | body | 발행 채널 |
| --- | --- | --- | --- |
| `SECTION_REPORT` | `<date>:<BriefSectionKind>` | `SectionReportBody { overview[], entries: ReportEntry[], sources, excluded, coverage }` | Notion `AI Radar Reports` DB (Date + Section 으로 upsert) |
| `DAILY_DIGEST` | `<date>` | `DailyDigestBody { stories: DigestStory[] (window 의 클러스터 대표 전부), coverage }` | 같은 DB, Section = "전체 목록" |
| `DAILY_BRIEF` (v2 확장) | `<date>` | `sections[].report: ArtifactLink`, `digest: ArtifactLink` 추가. item 은 ReportEntry 와 같은 id | 기존 Daily DB |

규칙:
- `ReportEntry` 자격은 `qualifiesForDetailedReport`: 본문(FULL/EXCERPT)이 있거나 검증된 claim 3개 이상. 자격이 없는 이야기는 `excluded[]` 에 사유와 함께 남고, 전체 목록에는 항상 실린다 (버려지는 이야기 0개).
- 한 항목은 임계값을 넘는 **모든** 섹션에 실릴 수 있다 (편집 분류는 경계가 아니다). 섹션당 항목 상한은 없다.
- `ReportEntry.narrative` 는 제공된 claim·evidence 에서만 쓴다. `sectionReportViolations` 가 evidenceId/claimId 존재를 검증한다.
- `DigestStory` 는 LLM 이 빠뜨려도 결정적 fallback(원문 제목 + 첫 claim 또는 "제목만 수집됨")으로 채운다.
- `ArtifactLink.externalUrl` 은 발행 후 채워지므로 Daily 는 리포트·목록 발행 **이후**에 만든다 (PIPELINES §1 단계 순서: analyze → reports → input(daily)). dry-run 에서는 null.
- idempotency: SECTION_REPORT 는 (type, `<date>:<section>`), DAILY_DIGEST 는 (type, date). Notion 은 (Date, Section) 조회로 같은 page 를 갱신하고 Read/Applied 는 보존한다.
