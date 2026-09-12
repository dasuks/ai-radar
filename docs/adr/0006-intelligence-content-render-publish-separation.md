# ADR-0006: Intelligence / Content / Render / Publish 분리

- Status: Accepted (2026-09-12)

## Context

AI Radar의 산출물은 하나가 아니다. Notion Daily, Obsidian Knowledge Note, 향후 Weekly Report, Trend Report, Alert, Social Post Draft가 같은 하루의 관측에서 나온다 (`ARCHITECTURE.md` §4).

현재 구현은 수집 결과를 LLM에 넣어 브리핑을 만들고 곧바로 Notion과 Obsidian에 쓴다. 그래서 세 가지 문제가 있다.

- Notion 쓰기가 실패하면 Librarian이 실행되지 않는다 (R-P1, `INTEGRATIONS_AND_SAFETY.md` §4).
- 같은 내용을 다른 채널용으로 다시 만들려면 이미 발행된 결과를 읽어 재요약하는 유혹이 생긴다.
- "이 문장은 어느 근거에서 나왔는가"가 렌더 결과에만 남고 구조로 남지 않는다.

또 공개 채널이 생기면 "무엇을 승인했는가"를 고정해야 한다. 승인 이후 내용이 바뀌면 승인은 의미가 없다.

## Options

1. **한 단계에서 LLM이 채널 포맷을 직접 생성한다(현재 방식).** 단계가 적고 빠르다. 그러나 채널이 늘 때마다 프롬프트가 늘고, 내용과 표현이 한 덩어리라 렌더 변경이 내용 변경과 구분되지 않는다.
2. **Artifact를 하나만 만들고 채널마다 변형한다.** 저장 구조가 단순해진다. 그러나 Daily Brief와 Social Post는 목적과 공개 범위가 달라서(`Claim.visibility`) 하나의 body를 변형하는 방식으로는 public/private 경계를 표현할 수 없다.
3. **이미 발행된 결과(Notion page)를 읽어 다른 채널용으로 재요약한다.** 재사용처럼 보이지만 Notion이 입력이 되어 Canonical Store 자리를 빼앗고, 근거 연결이 한 번 더 끊어진다 (`ARCHITECTURE.md` §1.2).
4. **Intelligence → Content → Render → Approval → Publish 4+1 단계 분리.** 각 단계의 소유 데이터와 금지 사항이 명확해지고 실패 격리가 채널 단위로 가능해진다. 단계와 계약이 늘어난다.

## Decision

옵션 4를 채택한다. 경계는 `INTEGRATIONS_AND_SAFETY.md` §6.1, 단계별 책임은 `ARCHITECTURE.md` §4.1, Use Case 동작은 `PIPELINES_AND_POLICIES.md` §9에 있다.

- **모든 Artifact는 Intelligence Model에서 만든다.** 유일한 예외는 Phase 3까지의 수동 override(`data/daily-brief.json` → `rankingTrace.policyId = "manual"`)이며 Phase 4에서 제거된다 (`MIGRATION_AND_ACCEPTANCE.md` §3.2). Intelligence Model은 특정 window에 대해 검증된 Claim·Signal·Entity의 뷰이고 Artifact의 **유일한 입력**이다. Artifact가 이 뷰를 우회해 Raw나 다른 Artifact를 직접 재요약하는 경로는 없다. Notion은 Publisher의 출력이지 입력이 아니다.
- **같은 날의 `DAILY_BRIEF` 와 `SOCIAL_POST_DRAFT` 는 별개 Artifact다.** 같은 claim 집합을 입력으로 쓰되 각각 자기 body와 visibility를 가진다.
- **Artifact는 revision과 contentHash를 가진다.** `(type, targetKey, revision)` 이 unique이고 `artifacts_current` 가 현재 revision을 가리킨다. contentHash가 같으면 revision을 올리지 않는다 (`CONTRACTS_AND_DATA.md` §5.1, `PIPELINES_AND_POLICIES.md` §6.3 단계 10).
- **Artifact는 `inputs` 로 근거를 기록한다.** claimIds, documentIds, signalRefs, 사용한 rankingPolicies(id와 version), runId.
- **Renderer는 표현만 바꾼다.** 문장과 수치를 바꾸면 안 되며, 렌더 전후 claimIds 집합 동일성을 테스트로 확인한다 (`INTEGRATIONS_AND_SAFETY.md` §6.1).
- **본문 작성 LLM도 근거에 묶인다.** `oneMinuteSummary` 는 선택된 item의 `whatChanged` 만 입력으로 받고 새 사실 도입이 금지되며, 한국어 본문(`WRITE_BRIEF_KO`)의 각 필드는 `claimIds` 를 동반해야 한다 (`PIPELINES_AND_POLICIES.md` §6.3 단계 6~7).
- **섹션을 억지로 채우지 않는다.** 점수가 임계 미만이면 섹션을 생략하고, `coverage` 로 수집 실패 사실을 독자에게 알린다. `NO_NEW_INFORMATION` 과 수집 실패는 절대 같은 문구를 쓰지 않는다 (`PIPELINES_AND_POLICIES.md` §4, §6.3).
- **Approval은 별도 단계다.** PRIVATE 채널은 POLICY 자동 승인, PUBLIC 채널은 USER 승인이며, 승인 `contentHash` 가 현재 contentHash와 다르면 승인이 무효가 되고 발행이 중단된다. 세부는 ADR-0008.
- **PublishArtifact는 idempotent하다.** 같은 revision이 이미 `SUCCEEDED` 면 skip하고, 부분 실패는 `PublicationRecord` 에 `FAILED(attempt=n)` 로 남아 다음 실행에서 **기존 page를 찾아 교체**한다. 중복 page를 만들지 않는다 (`PIPELINES_AND_POLICIES.md` §9).
- **채널 실패는 격리된다.** 한 채널의 실패가 다른 채널이나 Librarian을 막지 않는다 (R-P1 대응, `PIPELINES_AND_POLICIES.md` §1).
- **Artifact Layer는 채널 API를 호출하지 않는다.** 채널 호출은 Publisher adapter의 일이다 (`ARCHITECTURE.md` §4.1).
- **이벤트는 알림이지 상태가 아니다.** `EventSink` 는 로그와 `run_events` append만 하고, durability가 필요한 것(재시도, 승인 대기)은 `publications.status`, `knowledge_proposals.decision` 같은 **테이블 상태**로 관리한다 (`PIPELINES_AND_POLICIES.md` §10).

## Consequences

- 새 채널 추가가 Publisher + Renderer + 채널 visibility 정책으로 끝나고 Core는 바뀌지 않는다 (`ARCHITECTURE.md` §9).
- 같은 Artifact를 여러 번 발행해도 중복이 생기지 않고, 실패한 채널만 다시 시도된다.
- Artifact 본문과 렌더 결과가 분리되어, 렌더 버그를 고친 뒤 재렌더해도 내용 revision은 그대로다.
- 발행된 문장에서 claim, evidence, 원본 문서까지 되짚을 수 있다.
- Notion을 읽어 무언가를 만드는 코드는 존재하지 않는다. 유일한 Notion 읽기는 피드백 동기화다 (ADR-0007).
- 단계가 늘어난 만큼 Run 상태 판정이 세분화된다. Librarian 실패는 `OUTPUT_FAILURE` 가 아니라 `PARTIAL_SUCCESS` 다 (`PIPELINES_AND_POLICIES.md` §1, §4).

## Tradeoffs

- 계약과 테이블이 늘어난다. Artifact(revision 단위 row), ApprovalRecord, PublicationRecord를 모두 유지해야 한다.
- 단계 사이를 **저장된 결과**로 넘기므로(메모리 전달이 아님) 쓰기가 늘고 한 Run이 느려진다. 대신 어느 단계에서든 재개할 수 있다.
- 렌더 결과가 재생성 가능하다는 전제 때문에, 렌더러 변경이 과거 발행물과 다른 결과를 낼 수 있다. 승인된 채널은 `renderedAssetHash` 로 이를 잠근다.
- Notion 본문 교체가 원자적이지 않다는 외부 제약은 남는다. 완화책은 revision callout과 재시도다 (R-N2, `INTEGRATIONS_AND_SAFETY.md` §1.3).

## Revisit conditions

- 출력 채널이 4개를 넘어 Renderer 사이 중복이 눈에 띌 때. 공통 렌더 중간 표현을 둘지 판단한다.
- `ArtifactType` 이 6개를 넘거나, 한 Artifact body가 `Artifact<TBody>` envelope로 다루기 어려울 만큼 커질 때 (ADR-0002와 함께 연다).
- 한 Run의 발행 단계가 전체 시간의 절반을 넘거나, 단계 간 저장 왕복이 병목으로 측정될 때.
- 이벤트 소비자가 실제로 생길 때(예: Discord 실시간 alert). 그 시점에 `run_events` polling과 in-process subscriber 중 무엇을 쓸지 결정한다 (`PIPELINES_AND_POLICIES.md` §10).
- Artifact를 다른 Artifact의 입력으로 쓰고 싶은 요구가 생길 때. 현재 설계는 이를 금지하므로 ADR로만 바꿀 수 있다.
