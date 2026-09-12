# ADR-0009: Reports Layer (섹션 상세 리포트 + 전체 목록)

- Status: Accepted (2026-09-13)

## Context

첫 실운영(2026-09-12)에서 window 안의 이야기 40개 중 Daily 에 6개만 실렸다. 원인은 항목당 섹션 1개 배정, 섹션당 5개 상한, 임계값이었다. 사용자는 "중요하면 섹션이 중복되더라도 다 들어가야 하고, 각 주제를 훨씬 자세히 읽고 싶고, 나머지도 목록으로 훑다가 흥미로우면 원문으로 가고 싶다"고 요구했다 (`CONTRACTS_AND_DATA.md` §9).

## Options

1. **Daily 항목을 길게 쓴다.** 페이지 하나가 수십 화면이 되어 1분 요약이라는 역할이 사라진다.
2. **항목마다 페이지 1개.** 필터·검색은 좋지만 하루 20~40페이지가 생겨 DB 가 빠르게 지저분해지고, "오늘 AI Coding 흐름"을 한 번에 읽을 수 없다.
3. **섹션(주제)당 상세 리포트 1개 + 전체 목록 1개 + 짧은 Daily.** 페이지 수는 하루 5~8개로 제한되고, 각 페이지가 한 주제를 통째로 다룬다. 전체 목록이 "버려진 이야기 0개"를 보장한다.
4. **주제(entity)별 dossier 누적.** 트렌드에 강하지만 entity 해석과 Phase 4 signal 이 먼저 필요하다. 나중 확장으로 남긴다.

## Decision

옵션 3. `SECTION_REPORT`, `DAILY_DIGEST` Artifact 타입을 추가하고 Notion 에 `AI Radar Reports` DB 를 둔다. Daily 는 리포트 발행 이후에 리포트 항목에서 만들어지며 각 섹션·목록으로 링크한다. 상세 리포트 자격은 근거 충분성(본문 존재 또는 claim ≥ 3)으로 정하고 중요도로 자르지 않는다. 항목은 임계값을 넘는 모든 섹션에 중복 등장할 수 있다. 근거가 없는 이야기에 긴 글을 강요하지 않는다 (LLM 이 채워 넣는 것을 막기 위해). 상세는 `PIPELINES_AND_POLICIES.md` §11, `INTEGRATIONS_AND_SAFETY.md` §1.6.

## Consequences

- Codex 호출이 하루 7회에서 약 14~16회로, 실행 시간이 10분에서 25~30분으로 늘어난다.
- Intelligence → Content → Render → Publish 분리(ADR-0006)는 유지된다. 리포트도 Artifact 이고 Notion 은 여전히 출력 채널이다.
- Daily 의 문장이 리포트에서 파생되므로 두 산출물이 서로 모순되지 않는다.

## Tradeoffs

- 페이지가 늘어 Notion 에서 "오늘 것"을 찾는 데 Date 필터가 필요하다.
- 전체 목록의 bookmark 미리보기는 Notion 이 가져오므로 사이트에 따라 썸네일이 없을 수 있다.

## Revisit conditions

- 하루 Codex 호출이 구독 한도에 걸리거나 실행이 45분을 넘을 때 (배치 크기·모델 tier 조정).
- 사용자가 주제별 누적(dossier)을 원할 때 → 옵션 4를 Phase 4 이후 ADR 로 다룬다.
- 섹션 리포트의 항목이 하루 15개를 넘어 한 페이지가 너무 길어질 때 → 항목별 하위 페이지로 분할 검토.
