# ADR-0001: Modular Monolith with Ports and Adapters

- Status: Accepted (2026-09-12)

## Context

AI Radar는 1인이 쓰는 AI Intelligence Platform이다 (`ARCHITECTURE.md` §1.1). 실행 주기는 하루 1회 수준이고, 데이터 규모는 개인 소비량이다. 그럼에도 교체 압력이 큰 부분이 명확히 있다.

- Source는 늘어난다 (`manual-json` → HackerNews, RSS, GitHub, Horizon: `PIPELINES_AND_POLICIES.md` §2.4).
- LLM Provider와 model은 수시로 바뀐다 (`PIPELINES_AND_POLICIES.md` §5.1).
- 출력 채널은 Notion, Obsidian에서 시작해 Discord, Email, Instagram, Web으로 늘어날 수 있다 (`INTEGRATIONS_AND_SAFETY.md` §6.2).
- 저장소는 SQLite로 시작하지만 driver 교체 가능성이 남아 있다 (`CONTRACTS_AND_DATA.md` §7.6).

현재 구현은 `src/run-daily.ts` 가 수집·분석·Notion 쓰기·Obsidian 쓰기를 순차 호출하는 직선 흐름이라, Notion 실패가 Librarian 실행을 막고(R-P1), 환경변수 접근이 여러 파일에 흩어져 있으며(R-S1), 계층 규칙을 강제하는 장치가 없다(R-A1). 위험 목록은 `INTEGRATIONS_AND_SAFETY.md` §4에 있다.

## Options

1. **현재의 단일 스크립트 유지.** 가장 싸고 빠르다. 소스가 1~2개이고 채널이 2개인 동안은 실제로 잘 동작한다. 그러나 교체 지점이 함수 호출 순서 안에 숨어 있어, Source나 채널을 하나 추가할 때마다 중앙 파일을 고쳐야 한다. R-P1, R-S1, R-A1이 구조적으로 반복된다.
2. **마이크로서비스 + 메시지 버스.** Collector / Analyzer / Publisher를 분리하면 실패 격리와 확장이 쉬워 보인다. 그러나 개인용 단일 사용자 워크로드에 운영 부담(프로세스, 배포, 버스, 관측)이 과하다. `ARCHITECTURE.md` §2.2는 Kafka, Kubernetes, service mesh를 초기 도입 금지 목록에 명시한다.
3. **플러그인 프레임워크 + DI 컨테이너.** runtime plugin marketplace와 DI framework로 확장성을 확보하는 방식. 설정이 코드가 되고 조립 경로가 암묵적이 되어, 1인 프로젝트에서 얻는 것보다 잃는 추적성이 크다. §2.2에서 역시 제외 대상이다.
4. **단일 프로세스 Modular Monolith + Ports & Adapters.** 확장성을 서비스 개수가 아니라 계약의 안정성과 seam 위치로 확보한다 (`ARCHITECTURE.md` §2.1). 배포 단위는 하나로 유지하면서 교체 지점만 interface로 노출한다.

## Decision

옵션 4를 채택한다.

- 계층은 `domain/`, `policies/`, `application/`, `ports/`, `adapters/`, `runtime/` 여섯 개이고, 의존 방향은 **Domain ← Application ← Ports ← Adapters ← Composition Root** 로 고정한다. 계층별 허용·금지 import는 `ARCHITECTURE.md` §3.1 표가 정의한다.
- Adapter 간 직접 호출을 금지하고, Provider 고유 타입(Notion `BlockObjectRequest`, Anthropic `Message`, Horizon 출력 JSON)이 `ports/` 시그니처에 나타나지 않게 한다 (`ARCHITECTURE.md` §3.1).
- `process.env` 접근 지점은 `runtime/config` 하나다. 다른 모듈은 값을 인자로 받는다 (R-S1 대응).
- DI framework를 쓰지 않는다. `src/runtime/composition/` 의 명시적 조립 함수(`buildDailyPipeline(config)`)와 생성자 주입으로 조립한다 (`ARCHITECTURE.md` §3.2).
- 깊이는 Use Case에 둔다. 재시도, checkpoint, idempotency, 검증은 `CollectSources`, `ExtractClaims`, `PublishArtifact` 안에 있고 Adapter는 "fetch하고 계약으로 변환"만 한다 (`ARCHITECTURE.md` §5.1).
- "One adapter means a hypothetical seam" 원칙에 따라, Adapter가 하나뿐인 곳에는 Port를 만들지 않는다 (`ARCHITECTURE.md` §2.1 원칙 4).
- 실행 모델은 단일 Node 프로세스 + CLI다. 스케줄링은 OS나 CI가 맡고 프로세스 내부 스케줄러를 두지 않는다 (`ARCHITECTURE.md` §7).
- 규칙은 문서가 아니라 `test/architecture.test.ts` 의 import 스캔이 강제한다 (`MIGRATION_AND_ACCEPTANCE.md` §7).

## Consequences

- 새 Source, LLM Provider, 채널, 저장소 추가는 `adapters/<name>/` 디렉터리와 composition root 한 줄로 끝난다 (`ARCHITECTURE.md` §9).
- Horizon 제거 같은 되돌리기가 디렉터리 삭제 + 조립 한 줄 삭제로 끝난다 (`ARCHITECTURE.md` §6).
- 보안 경계가 계층으로 표현된다. 분석 Use Case에는 `VaultPort`, `Publisher`, `HttpClient` 가 주입되지 않으므로 LLM 관련 코드가 파일을 쓰거나 발행할 경로 자체가 없다 (`INTEGRATIONS_AND_SAFETY.md` §5.2).
- 재시도·checkpoint 로직이 Use Case 한 곳에 모이므로 Source가 10개가 되어도 중복되지 않는다 (locality).
- 디렉터리는 필요한 Phase에 만든다. 빈 디렉터리를 미리 만들지 않는다 (`ARCHITECTURE.md` §5).

## Tradeoffs

- 파일 수와 간접 호출이 늘어난다. 오늘의 기능 하나를 만드는 데 필요한 타이핑은 단일 스크립트보다 많다.
- Port를 언제 만들지 판단해야 한다. 원칙 4가 이를 제약하지만, Adapter가 하나뿐인 시점에는 판단이 남는다 (예: `VaultPort` 는 운영 adapter와 in-memory 테스트 adapter 두 개를 처음부터 함께 만든다. 승인 같은 내부 규칙은 Port가 아니라 Use Case로 둔다).
- 단일 프로세스이므로 한 Run의 총 시간과 메모리가 곧 상한이다. 병렬화는 프로세스 내부 `Promise.allSettled` 수준으로 제한된다 (`PIPELINES_AND_POLICIES.md` §2.2).
- 아키텍처 테스트를 유지해야 한다. 규칙이 바뀌면 표와 테스트를 같은 변경에서 고쳐야 한다.

## Revisit conditions

- 한 번의 daily Run이 단일 프로세스에서 30분을 넘거나, 등록 Source가 20개를 넘어 수집 단계가 전체 시간의 절반 이상을 차지할 때.
- AI Radar를 여러 사용자가 쓰거나, CLI가 아니라 상시 실행 서비스(웹 UI, 실시간 alert)가 필요해질 때. 그 경우에도 첫 분리 후보는 수집 프로세스 하나이며 `MIGRATION_AND_ACCEPTANCE.md` §6의 시나리오로 검증한다.
- `test/architecture.test.ts` 의 예외 허용 목록이 3건 이상 쌓일 때. 규칙이 현실과 어긋났다는 신호이므로 계층 표를 다시 연다.
- Adapter가 하나뿐인 Port가 두 개 이상 6개월간 그대로 유지될 때. 원칙 4에 따라 해당 Port 제거를 검토한다.
