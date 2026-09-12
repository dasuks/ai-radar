# ADR-0004: Entity / Metric / Trend Model

- Status: Accepted (2026-09-12)

## Context

"무엇이 뜨고 있는가"를 말하려면 **무엇에 대한 이야기인지**(Entity)와 **어떤 수치가 실제로 관측되었는지**(Metric)를 분리해야 한다. 이 분리를 하지 않으면 두 가지 흔한 오류가 바로 들어온다.

- Skill이나 개념 같은 대상에 repository star를 붙여 "인기"라고 부르는 것. star는 repository의 수치이지 Skill의 수치가 아니다.
- 언급 수(mention)와 사용 수(usage/install)를 합쳐서 하나의 인기 지표로 쓰는 것.

또한 트렌드 계산은 데이터가 없을 때 거짓말하기 쉽다. 이전 window에 관측이 0건이면 증가율이 무한대가 되고, 소스를 하나 추가한 날에는 mention이 늘어난 것이 트렌드처럼 보인다. Horizon과 agents-radar 모두 이런 판정 상태를 표현하는 계약이 없다 (`INTEGRATIONS_AND_SAFETY.md` §8).

이름만으로 동일 대상을 판정하는 것도 위험하다. `frontend-design` skill과 `Frontend Design` concept은 다른 것이다.

## Options

1. **키워드/태그 카운트만 쓴다.** Entity 테이블 없이 문서의 tag와 제목 토큰을 세는 방식. 구현이 가장 싸고 초기 데이터가 적을 때 바로 쓸 수 있다. 그러나 별칭·표기 변형이 분산되고, "무엇에 대한 주장인가"를 Claim에 연결할 수 없으며, merge 이력이 없어 과거 집계가 계속 흔들린다.
2. **Entity 테이블 + 이름 기반 자동 merge.** 정규화 이름이 같으면 자동으로 합친다. 집계가 깔끔해 보이지만, 서로 다른 type의 동명이인을 합치는 사고가 조용히 일어나고 되돌릴 근거가 남지 않는다.
3. **Entity(별칭·merge 이력·identity confidence 포함) + MetricObservation(관측)과 DerivedSignal(계산)의 분리 + scope validator + 명시적 signal status.** 초기 비용이 크고 CANDIDATE 상태를 사람이 정리해야 하지만, 잘못된 자동 판단을 구조적으로 막는다.

## Decision

옵션 3을 채택한다. 필드 정의는 `CONTRACTS_AND_DATA.md` §2, §3이고 계산 규칙은 `PIPELINES_AND_POLICIES.md` §3.3, §3.4, §7이다.

- **EntityType은 9종**(MODEL, TOOL, SKILL, MCP_SERVER, FRAMEWORK, REPOSITORY, COMPANY, PERSON, CONCEPT)이다. 버전 표기는 별도 Entity가 아니라 `versionLabel` 필드다 (`CONTRACTS_AND_DATA.md` §2.1).
- **정체성 규칙은 순수 함수**(`domain/entities/identity.ts`)이고 7개 규칙(정규형 URL, 이름+type+ecosystem 후보, merge 이력, 버전 분리, 상속 없음)으로 `CONTRACTS_AND_DATA.md` §2.1에 있다. 핵심은 이름만 같고 type이나 ecosystem이 다르면 다른 entity이며, 이름 일치는 자동 merge가 아니라 `CANDIDATE` 로 남는다는 것이다.
- **신규 entity 자동 생성은 두 경우만**이다. URL로 결정되는 REPOSITORY, 그리고 서로 다른 source 2개 이상에서 같은 window에 등장한 UNRESOLVED surfaceForm. 나머지는 `ai-radar entities review` 로 사람이 확정한다 (`PIPELINES_AND_POLICIES.md` §3.3).
- **LLM은 새 canonical entity를 만들 권한이 없다.** `EXTRACT_ENTITIES` 는 surfaceForm과 type 후보만 내고, 출력은 alias 사전과 대조해 RESOLVED/CANDIDATE/UNRESOLVED로 분류된다.
- **Merge는 삭제가 아니다.** 원래 ID는 `MERGED` 상태로 남고 `EntityMerge` 에 이력이 기록되어 과거 mention과 metric의 참조가 유지된다.
- **관측과 계산을 다른 테이블로 분리한다.** `MetricObservation` 은 실제 관측값이고 계산하지 않는다. `DerivedSignal` 은 계산값이며 재계산 가능하다 (`CONTRACTS_AND_DATA.md` §3.1, §3.2).
- **scope validator가 저장 전에 위반을 거부한다.** `github.stars` 는 항상 `scope=REPOSITORY` 이며 Skill entity에 기록할 수 없다. mention과 usage/install은 다른 key이며 합치지 않는다. `radar.mentions` 는 `window` 와 `coverage` 가 필수다.
- **mention은 link cluster 단위로 센다.** 같은 story의 cross-post는 1로 집계되고, Trend Engine은 재집계하지 않는다 (`PIPELINES_AND_POLICIES.md` §3.4, §7.2).
- **signal status를 계약에 둔다.** `COMPUTED`, `INSUFFICIENT_DATA`, `COLD_START`, `COVERAGE_CHANGED`, `SOURCE_FAILURE`. 이전 window 관측이 0건이면 `COLD_START` 이고 증가율을 무한대나 100%로 만들지 않는다. 두 window의 `coverage.sourcesSucceeded` 집합이 다르면 `COVERAGE_CHANGED` 이며 소스가 늘어서 mention이 는 것을 트렌드로 보지 않는다 (`PIPELINES_AND_POLICIES.md` §7.2).
- **`trend_score` 는 primary signal이 모두 `COMPUTED` 일 때만 계산한다.** 하나라도 아니면 `trend_score` 도 `INSUFFICIENT_DATA` 이고, TREND ranking에서 0점 처리되어 표시되지 않는다 (`PIPELINES_AND_POLICIES.md` §6.2).
- **정책 버전이 바뀌면 새 row가 생기고 옛 row는 남는다.** `DerivedSignal` 의 unique key에 `provenance.policyVersion` 이 포함된다. Artifact는 어느 policyVersion을 썼는지 기록한다.
- **LLM은 Trend Artifact에서 설명문만 쓴다.** 수치는 `DerivedSignal` 에서 그대로 렌더한다 (`PIPELINES_AND_POLICIES.md` §7.3).
- Entity 종류별 metric profile 초기값은 `PIPELINES_AND_POLICIES.md` §7.2 마지막 문단에 있다.

## Consequences

- "Skill이 뜨고 있다"를 말할 때 근거가 `radar.mentions(scope=ENTITY)` 임이 계약으로 드러난다. star를 섞을 경로가 없다.
- 트렌드가 계산되지 않은 이유가 값 대신 status와 `statusReason` 으로 남는다. 빈 섹션이 "데이터 없음"인지 "수집 실패"인지 독자가 구분할 수 있다.
- 정책 가중치를 바꿔도 과거 결과가 사라지지 않는다. 두 policyVersion의 결과를 나란히 비교할 수 있다.
- 자동 merge 사고가 구조적으로 차단되고, 대신 `CANDIDATE` 대기열이 생긴다.
- Ranking은 점수와 함께 `reasons[]` 를 항상 채워 사람이 왜 올라왔는지 볼 수 있다 (`PIPELINES_AND_POLICIES.md` §6.1).

## Tradeoffs

- 사람이 해야 할 일이 생긴다. CANDIDATE 확정과 merge 판단은 `ai-radar entities review` 로 주기적으로 처리해야 한다.
- 초기에는 대부분의 signal이 `COLD_START` 나 `INSUFFICIENT_DATA` 다. 데이터가 쌓이기 전까지 TREND_WATCH 섹션은 거의 비어 있다.
- 테이블과 validator가 늘어 쓰기 경로가 복잡해진다. scope 규칙 위반은 런타임 거부이므로 adapter 개발 시 마찰이 있다.
- Ranking 가중치 초기값은 가설이며 검증되지 않았다 (`PIPELINES_AND_POLICIES.md` §6.2). 초기 정책 v1은 FeedbackProfile을 무시한다.

## Revisit conditions

- `CANDIDATE` 상태 mention 비율이 4주 이상 전체의 30%를 넘어 수동 리뷰가 밀릴 때. 자동 생성 조건(서로 다른 source 2개)을 완화할지 ADR로 다시 판단한다.
- `trend_score` 가 3주 연속 모든 entity에서 `INSUFFICIENT_DATA` 일 때. `minPointsPerWindow` 나 window 길이 같은 profile 초기값이 현실과 맞지 않는다는 신호다.
- Skill이나 MCP Server의 install/usage metric을 실제로 얻을 수 있는 공개 소스가 생길 때. `MetricKey` 추가는 `ARCHITECTURE.md` §9의 "새 Metric" 경로를 따르되, mention과 합치지 않는다는 규칙은 이 ADR을 열어야 바꿀 수 있다.
- Entity 수가 2,000을 넘어 `entities_lookup` 인덱스만으로 해석 성능이 부족해질 때.
- Ranking 또는 Trend 정책이 v2로 올라갈 때. 정책 버전 변경 자체는 ADR 없이 가능하지만, 가중치가 아니라 **입력 signal의 종류**가 바뀌면 이 ADR을 갱신한다.
