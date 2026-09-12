# ADR-0007: Notion과 Obsidian의 역할

- Status: Accepted (2026-09-12)

## Context

사용자는 이미 Notion DB("AI Coding Daily")와 Obsidian Vault(`C:\dev\knowledge\ai-knowledge`)를 쓰고 있고, 현재 구현이 둘 다에 쓴다. 두 도구는 성격이 다르다. Notion은 매일 읽고 체크하는 곳이고, Obsidian은 오래 쌓아 두는 개인 지식 저장소다.

두 곳 모두 **사용자 소유 데이터가 섞여 있다**는 점이 핵심 제약이다. 현재 구현에는 실제 사고 경로가 있다.

- Notion 데이터 소스 fallback이 설정 ID와 무관한 다른 workspace DB에 쓸 수 있다 (R-N1).
- Obsidian Daily Note를 파일 전체로 덮어써서 사용자 메모가 사라진다 (R-O1).
- 관리 영역 안의 사용자 수정이 무조건 덮어써진다 (R-O2).
- Daily Note 파일명이 title에 의존해 같은 날짜 노트가 중복된다 (R-O3).

근거는 `INTEGRATIONS_AND_SAFETY.md` §4 위험표다.

## Options

1. **Notion을 Canonical Store로 삼는다.** 이미 데이터가 거기 있고 UI가 무료다. 그러나 window 쿼리·unique constraint·트랜잭션이 없고, API 호출이 분석 경로의 일부가 되며, 사용자가 UI에서 고친 값과 시스템 값을 구분할 수 없다. `ARCHITECTURE.md` §1.2가 "Notion 앱이 아니다"를 명시한다.
2. **Obsidian Vault(Markdown 파일)를 진실의 원천으로 삼는다.** git 이력이 붙고 사람이 직접 편집할 수 있다. 그러나 파일이 사용자 소유이므로 시스템이 자유롭게 쓸 수 없고, 구조화된 metric·signal·evidence를 Markdown으로 표현하면 재계산이 불가능하다.
3. **두 도구를 모두 출력 채널로 두고 Canonical Store는 별도로 둔다(ADR-0005).** Notion과 Obsidian은 Publisher의 목적지이며 각각 다른 역할을 맡는다. 통합 비용은 유지되지만 사용자 데이터와 시스템 데이터가 섞이지 않는다.

## Decision

옵션 3을 채택한다. 역할과 보호 규칙은 `INTEGRATIONS_AND_SAFETY.md` §1, §2에 있다.

**Notion: Daily Reader + Archive + 피드백 입력 지점**
- 사용자가 매일 읽는 날짜별 페이지이자 과거 Daily의 아카이브이며, `Read` / `Applied` 체크박스가 피드백 입력 지점이다.
- **Canonical Intelligence Store가 아니다.** 피드백 체크박스를 제외하면 Notion에서 데이터를 읽어 분석 입력으로 쓰지 않는다.
- 현재 계약을 유지한다. 환경변수 이름(`NOTION_TOKEN`, `NOTION_DATABASE_ID`), DB 속성 6개, Date upsert, Integration 표시명, DB 이름은 그대로다. 표는 `INTEGRATIONS_AND_SAFETY.md` §1.2에 있다. `NOTION_DATA_SOURCE_ID` 는 설정 스키마에 optional로 등록한다 (R-D1).
- `PublicationRecord.externalId`(page id)를 1차 키로 쓰고 Date 조회는 reconciliation으로 쓴다. Date로 페이지가 2개 이상이면 **중단한다**. 자동 삭제는 하지 않는다.
- 갱신 시 `properties` 는 Name/Date/Topics/Importance만 보낸다. `Read` / `Applied` 와 사용자가 추가한 다른 속성은 건드리지 않는다.
- **스키마 fallback을 기본 비활성으로 바꾼다.** `NOTION_ALLOW_SCHEMA_FALLBACK=true` 일 때만 허용한다 (R-N1 대응, `INTEGRATIONS_AND_SAFETY.md` §1.3 항목 5).
- 피드백 읽기는 Publisher와 **다른 adapter 클래스**이고 다른 Use Case(`SyncFeedback`)다. 체크 해제는 이벤트를 만들지 않는다. Unread는 Disliked가 아니다 (`INTEGRATIONS_AND_SAFETY.md` §1.4, `CONTRACTS_AND_DATA.md` §6.3).
- 개발 세션용 Notion MCP는 **AI Radar 런타임과 무관**하다. 런타임은 `@notionhq/client` 와 `NOTION_TOKEN` 만 쓰고 MCP 토큰을 섞지 않는다.

**Obsidian: Living Knowledge Base**
- 장기 지식(개념·패턴·워크플로우·도구·아키텍처·연구)을 담는다. Daily Note(`99 Daily/`)는 읽기용 사본이자 허브다.
- **Daily Brief를 그대로 복사해 노트 수백 개를 만들지 않는다.** Knowledge Note는 entity 또는 concept 단위로만 생성·갱신된다.
- 사용자 데이터 보호 규칙 7개는 `INTEGRATIONS_AND_SAFETY.md` §2.3이다. 핵심은 관리 영역 밖 무수정, Daily Note 전체 덮어쓰기 금지(관리 영역 방식으로 전환), `managedHash` 불일치 시 NEEDS_REVIEW 보류, `ai-radar.entityId` 기반 매칭, 삭제 없음(outdated 표기만), 한 Run의 노트 수정 상한 기본 20개다.
- 레거시 마커 `ai-coding-radar:*` 는 읽기 호환하고 갱신 시 `ai-radar:*` 로 재기록한다.
- Librarian 제안은 순수 함수로 계산하고(`ProposeKnowledgeUpdates`, `CheckKnowledgeSafety`) I/O는 `ApplyKnowledgeUpdates` 만 한다. `AUTO_APPLY` 가 아닌 제안은 `knowledge_proposals` 에 남아 `ai-radar librarian review` 로 사람이 처리한다 (`PIPELINES_AND_POLICIES.md` §8).
- **사용자 Obsidian 노트 본문은 외부 LLM provider로 보내지 않는다.** Librarian은 제목·frontmatter·managed region hash만 쓴다. 예외를 두려면 ADR이 필요하다 (`INTEGRATIONS_AND_SAFETY.md` §3).
- **Knowledge에서 Skill로의 자동 승격 경로는 없다.** Artifact → Publisher 경로에 `skills` 채널을 정의하지 않으며, 최종 복사는 사람이 한다 (`INTEGRATIONS_AND_SAFETY.md` §2.4).

## Consequences

- 두 채널 모두 PRIVATE artifact를 허용하고 POLICY 자동 승인이다 (`INTEGRATIONS_AND_SAFETY.md` §6.2). 사용자 승인 부담이 늘지 않는다.
- Notion이나 Obsidian을 꺼도 Intelligence Store는 그대로 남는다. 채널 하나를 잃어도 데이터는 잃지 않는다.
- 사용자가 Notion 속성을 추가하거나 Obsidian 노트에 메모를 적어도 다음 Run이 지우지 않는다.
- R-N1, R-O1, R-O2, R-O3에 각각 대응되는 구조가 생긴다. 노트 수 상한 20개가 대량 변경 사고를 막는다.
- Notion 피드백이 `FeedbackEvent` 로 들어와 향후 ranking의 `FeedbackProfile` 입력이 된다. 초기 정책 v1은 이를 무시한다 (`INTEGRATIONS_AND_SAFETY.md` §7).

## Tradeoffs

- 같은 내용이 SQLite, Notion, Obsidian 세 곳에 존재한다. 의도된 중복이지만 동기화 상태를 사람이 오해할 수 있다.
- 관리 영역 방식은 마커 파싱과 hash 비교가 필요해, 전체 덮어쓰기보다 구현이 복잡하고 깨질 여지가 있다.
- `NEEDS_REVIEW` 제안이 쌓이면 사람이 처리해야 한다. 처리하지 않으면 지식이 갱신되지 않는다.
- 노트 수정 상한 20개 때문에 대량 갱신이 여러 Run에 걸쳐 나뉜다.
- Notion API의 비원자적 본문 교체(R-N2)는 우리가 없앨 수 없다. revision callout으로 사람이 식별하게 할 뿐이다.
- Obsidian 노트 본문을 LLM에 보내지 않으므로, 기존 노트 내용을 반영한 정교한 제안은 만들 수 없다.

## Revisit conditions

- Notion API 변경으로 Date upsert나 `erase_content` + append 경로가 깨질 때.
- 한 Run이 노트 수정 상한 20개에 4주 연속 도달할 때. 상한값이 현실과 맞지 않거나 Librarian이 너무 넓게 제안한다는 신호다.
- `knowledge_proposals` 의 `NEEDS_REVIEW` 가 50건을 넘을 때. 매칭 규칙이나 `CheckKnowledgeSafety` 기준을 다시 본다.
- Obsidian 노트 본문을 분석에 쓰고 싶은 요구가 생길 때. 현재는 금지이므로 별도 ADR이 필요하다.
- 사용자가 Notion을 더 이상 쓰지 않거나 다른 읽기 채널(Discord, Email, Web)이 주 채널이 될 때. 채널 역할표(`INTEGRATIONS_AND_SAFETY.md` §6.2)를 다시 연다.
- Knowledge에서 Skill로의 승격을 실제로 구현하기로 할 때. 자동 쓰기 금지 원칙을 유지하는지 이 ADR에서 확인한다.
