# ADR-0002: Canonical Data Model (Raw → Normalized → Entity/Metric/Claim → Artifact)

- Status: Accepted (2026-09-12)

## Context

AI Radar의 핵심 가치는 "오늘 뭐가 있었나"가 아니라 **"무엇을, 어떤 근거로, 언제, 어느 정도 확신으로 알게 되었는가"를 6개월 뒤에도 추적할 수 있다**는 점이다 (`ARCHITECTURE.md` §1.1).

현재 구현은 `DailyBriefing` 하나만 가지고 있고 `schemaVersion` 이 없어, 계약이 바뀌면 과거 JSON을 해석할 수 없다 (R-P3, `INTEGRATIONS_AND_SAFETY.md` §4). 또 수집한 원본을 보존하지 않으므로 재분석 경로가 없다. 참고한 두 OSS도 같은 결손을 가진다. Horizon은 upstream 원본 JSON을 버리고, agents-radar는 구조적 저장 없이 메모리에서 LLM으로 넘긴다 (`INTEGRATIONS_AND_SAFETY.md` §8.3).

동시에 Source마다 payload 형태가 전혀 다르다. HN Firebase item, RSS entry, GitHub REST 응답, Horizon `ContentItem` 을 하나의 분석 파이프라인에 넣으려면 공통 모델이 필요하다.

## Options

1. **소스별 타입을 그대로 저장하고 렌더 시점에 맞춘다.** 변환 비용이 없고 원본 충실도가 최고다. 그러나 ranking, trend, evidence 검증 같은 공통 로직이 소스 개수만큼 분기하고, Source를 추가할 때마다 Core를 고쳐야 한다.
2. **단일 flat "item" 모델 하나(현재 `DailyBriefing` 확장).** 지금 코드에서 가장 작은 변화다. 그러나 관측값과 계산값, 사실과 주장, 원본과 산출물이 한 레코드에 섞여서 "이 문장의 근거가 무엇인가"를 되물을 수 없다. 재분석 시 무엇을 다시 계산해도 되는지 판단할 기준도 없다.
3. **4단계 canonical 계약 (Raw → Normalized → Entity/Metric/Claim+Evidence → Artifact) + `schemaVersion` + 공통 Provenance.** 단계마다 소유자와 불변 조건이 달라 책임이 분리되고, 원본 보존과 재계산 가능 영역이 구분된다. 초기 설계 비용이 가장 크다.

## Decision

옵션 3을 채택한다. 계약의 필드 수준 정의는 `CONTRACTS_AND_DATA.md` 이며 여기서 반복하지 않는다.

- **단계와 소유 데이터**는 `ARCHITECTURE.md` §4.1 표가 정의한다. `RawObservation`(§1.1)은 불변 snapshot이고 수정하지 않는다. 같은 `(sourceId, externalId)` 의 새로운 상태는 새 observation이다.
- **`schemaVersion` 정책** (`CONTRACTS_AND_DATA.md` §0.1): 모든 persistent 계약이 정수 버전을 가진다. 호환 추가는 minor, 비호환 변경은 major이며 `domain/<contract>/upcast.ts` 에 `vN → vN+1` 함수를 둔다. 저장된 데이터는 제자리에서 다시 쓰지 않고 **읽을 때 upcast**한다.
- **ID 규칙** (`CONTRACTS_AND_DATA.md` §0.2): 재수집 시 같은 결과가 나와야 하는 객체(RawObservation, NormalizedDocument, Evidence, Artifact)는 hash 기반 결정적 ID를 쓰고, 이름이 바뀌는 객체(Entity)와 실행 단위(Run, Claim)는 ULID를 쓴다. ULID 생성기는 `Clock` 과 random source를 인자로 받아 테스트 결정성을 유지한다.
- **Provenance 공통 블록** (`CONTRACTS_AND_DATA.md` §0.3): 분석 결과는 method(RULE/LLM/HUMAN/DERIVED), policy·prompt·model 버전, `runId` 를 함께 저장한다.
- **Evidence first**: `SYSTEM_INFERENCE` 를 제외한 모든 Claim은 최소 1개의 존재하는 Evidence를 가져야 하고, `SYSTEM_INFERENCE` 는 `COMPUTED` 상태의 signal을 참조해야 한다 (`CONTRACTS_AND_DATA.md` §4.2 불변 조건).
- **Failure semantics는 데이터다**: "정보 없음"과 "수집 실패"는 다른 상태값이다. `ContentCompleteness`, `CoverageNote`, `SignalStatus`, `RunStatus` 가 이를 계약에 담는다. 모르는 값은 추측으로 채우지 않고 `null` 로 둔다 (예: `publishedAt` 을 `fetchedAt` 으로 채우지 않는다).
- **Idempotent by key**: 모든 persistent 객체가 idempotency key를 가진다. 단계별 키와 재실행 동작은 `CONTRACTS_AND_DATA.md` §8 표에 있다.
- **Dedupe는 삭제가 아니라 link다** (`CONTRACTS_AND_DATA.md` §1.3). Ranking과 Trend는 link cluster 단위로 센다.
- 현재 `DailyBriefing`(암묵적 v1)은 `DailyBriefBody` v2로 확장하며 upcast 경로는 `MIGRATION_AND_ACCEPTANCE.md` §3.2에 있다.

## Consequences

- 같은 window를 몇 번 다시 실행해도 중복이 생기지 않는다. 재실행은 안전한 기본 동작이 된다.
- 6개월 뒤 재분석이 가능하다. 원본이 `raw_observations` 와 `raw/` 에 남아 있고, 새 정책으로 돌린 결과는 새 `policyVersion` / `analysisId` 로 옛 결과와 공존한다 (ADR-0005, `CONTRACTS_AND_DATA.md` §7.5).
- Artifact의 모든 문장을 claim → evidence → observation → 원본 payload까지 되짚을 수 있다.
- Source를 추가해도 Core 계약은 바뀌지 않는다. 변환 책임은 adapter에 있다 (ADR-0003).
- 계약이 곧 검증 지점이 된다. LLM 출력은 schema validation과 evidence-existence validation을 통과해야만 저장된다 (`PIPELINES_AND_POLICIES.md` §5.2).

## Tradeoffs

- 문서 1건이 여러 테이블에 걸쳐 기록되므로 쓰기 경로와 저장 용량이 늘어난다. 원본 payload는 따로 파일로도 남는다.
- 계약이 많아 초기 구현량과 학습 비용이 크다. Phase별로 나눠 만들어야 한다 (`MIGRATION_AND_ACCEPTANCE.md` §5).
- `schemaVersion` major 변경마다 upcast 함수를 유지해야 하고, 읽기 경로가 upcast를 거치므로 약간의 비용이 상시 붙는다.
- 정직한 `null` 이 많아져서 렌더 단계에서 "모름"을 표현하는 부담이 생긴다.

## Revisit conditions

- 어느 계약이든 `schemaVersion` major가 6개월 안에 2회 이상 올라가거나 upcast 체인이 3단계를 넘을 때. 읽기 경로 비용이 커지므로 `ai-radar migrate --contract <name>` 로 일괄 재기록을 실행하고 옛 버전 지원을 끊는다 (`CONTRACTS_AND_DATA.md` §7.4).
- Evidence 없이 남기고 싶은 분석 결과가 반복적으로 생길 때. 현재 계약은 이를 허용하지 않으므로 새 ClaimType이 아니라 ADR로 다룬다.
- 하루 수집 문서가 1,000건을 넘어 Raw와 Normalized를 모두 보존하는 비용이 문제가 될 때. 보존 정책(오래된 payload 파일 외부 보관, row 유지)을 먼저 적용하고 그래도 부족하면 이 결정을 연다 (`CONTRACTS_AND_DATA.md` §7.2).
- Artifact 타입이 6개를 넘어 `Artifact<TBody>` envelope 하나로 담기 어려워질 때.
