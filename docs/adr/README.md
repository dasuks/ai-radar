# Architecture Decision Records

AI Radar의 주요 결정을 기록한다. 여기 있는 ADR은 `docs/architecture/` 의 네 문서(ARCHITECTURE, CONTRACTS_AND_DATA, PIPELINES_AND_POLICIES, INTEGRATIONS_AND_SAFETY)가 서술한 결정의 **근거와 대안**을 남기는 곳이다. 계약 필드나 정책 수치 같은 상세는 원문 문서를 링크하고 여기서 중복하지 않는다.

규칙은 `docs/architecture/README.md` 의 "문서 유지 규칙"을 따른다. 결정을 뒤집을 때 기존 ADR을 삭제하지 않고 `Superseded by ADR-XXXX` 로 표시한 뒤 새 ADR을 추가한다.

## Index

| 번호 | 제목 | 상태 | 날짜 |
| --- | --- | --- | --- |
| [ADR-0001](./0001-modular-monolith-ports-and-adapters.md) | Modular Monolith with Ports and Adapters | Accepted | 2026-09-12 |
| [ADR-0002](./0002-canonical-data-model.md) | Canonical Data Model (Raw → Normalized → Entity/Metric/Claim → Artifact) | Accepted | 2026-09-12 |
| [ADR-0003](./0003-source-adapter-strategy.md) | Source Adapter Strategy (Horizon, agents-radar, 직접 구현) | Accepted | 2026-09-12 |
| [ADR-0004](./0004-entity-metric-trend-model.md) | Entity / Metric / Trend Model | Accepted | 2026-09-12 |
| [ADR-0005](./0005-storage-and-reprocessing.md) | Storage and Reprocessing (SQLite behind a Port) | Accepted | 2026-09-12 |
| [ADR-0006](./0006-intelligence-content-render-publish-separation.md) | Intelligence / Content / Render / Publish 분리 | Accepted | 2026-09-12 |
| [ADR-0007](./0007-notion-and-obsidian-roles.md) | Notion과 Obsidian의 역할 | Accepted | 2026-09-12 |
| [ADR-0008](./0008-public-content-approval-boundary.md) | Public Content Approval Boundary | Accepted | 2026-09-12 |
| [ADR-0009](./0009-reports-layer.md) | Reports Layer (섹션 상세 리포트 + 전체 목록) | Accepted | 2026-09-13 |

상태 값: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, `Deprecated`.

## Template

새 ADR은 아래 섹션을 **이 순서로, 빠짐없이** 가진다. 내용이 없으면 "해당 없음"이라고 쓰되 섹션을 지우지 않는다.

```markdown
# ADR-NNNN: Title

- Status: Accepted (YYYY-MM-DD)

## Context

무엇이 문제이고 어떤 제약이 있었는가. 관련 문서 절을 링크한다 (예: `CONTRACTS_AND_DATA.md` §7.3).

## Options

실제로 검토한 대안 2~3개 이상. 각각 왜 후보였는지 한 문장 이상 쓴다. 채택되지 않은 이유도 남긴다.

## Decision

무엇을 하기로 했는가. 문서에 없는 내용을 여기서 새로 정하지 않는다.

## Consequences

이 결정으로 확정되는 구조·작업·보장.

## Tradeoffs

이 결정이 포기한 것과 감수하는 비용.

## Revisit conditions

이 결정을 다시 열어야 하는 구체적 조건 (수치·시점·외부 사건).
```

## 파일 이름 규칙

`NNNN-kebab-case-title.md`. 번호는 재사용하지 않는다.
