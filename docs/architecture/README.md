# AI Radar Architecture Documents

AI Radar는 AI/LLM/AI Coding 생태계를 지속적으로 관측하고, 근거와 함께 저장하고, 목적에 따라 분석해 학습·지식 축적·트렌드 관찰·콘텐츠 제작에 재사용하는 **개인용 AI Intelligence Platform** 이다. 이 디렉터리는 그 목표 아키텍처와 이행 계획의 단일 출처다.

## 문서 지도

| 문서 | 내용 | 먼저 읽을 사람 |
| --- | --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 정체성, 설계 철학, 계층과 의존성 규칙, 모듈 지도, 보안 경계, 확장 지점 | 모든 기여자 |
| [CONTRACTS_AND_DATA.md](./CONTRACTS_AND_DATA.md) | Canonical 계약(Raw/Document/Entity/Metric/Signal/Claim/Evidence/Artifact/Run), schemaVersion, Storage(SQLite DDL), idempotency key | 계약·저장소를 만지는 사람 |
| [PIPELINES_AND_POLICIES.md](./PIPELINES_AND_POLICIES.md) | 단계별 Use Case, Source Adapter 계약, Run 상태 판정, LLM 정책, Ranking/Trend 정책, Librarian, Publish | 파이프라인·정책 구현자 |
| [INTEGRATIONS_AND_SAFETY.md](./INTEGRATIONS_AND_SAFETY.md) | Notion/Obsidian 역할과 사용자 데이터 보호, 권한 분리, prompt injection, 공개 게시 승인 경계, OSS 검증 결과 | 외부 연동·안전 담당 |
| [MIGRATION_AND_ACCEPTANCE.md](./MIGRATION_AND_ACCEPTANCE.md) | 현재 구현 baseline, gap, 이름 이행, Phase 계획, 확장 시나리오 20개, 아키텍처 테스트 계획, 완료 조건 | 다음 Phase를 시작하는 사람 |
| [../adr/](../adr/) | 주요 결정의 Architecture Decision Records | 결정을 바꾸려는 사람 |

## 읽는 순서

1. 처음 합류: `ARCHITECTURE.md` §1–3 → `MIGRATION_AND_ACCEPTANCE.md` §1–2 (현재 상태) → 담당 영역 문서.
2. 새 Source/LLM/채널 추가: `ARCHITECTURE.md` §9 → `PIPELINES_AND_POLICIES.md` 해당 절 → `MIGRATION_AND_ACCEPTANCE.md` §6 의 유사 시나리오.
3. 아키텍처 변경: 관련 ADR의 "Revisit conditions" 확인 → 새 ADR 작성 → 문서 갱신.

## Glossary

용어는 문서 전체에서 아래 의미로만 쓴다.

| 용어 | 의미 |
| --- | --- |
| **Module** | interface와 implementation을 가진 모든 것 (함수, 클래스, 패키지). 크기 무관 |
| **Interface** | 호출자가 올바르게 쓰기 위해 알아야 하는 전부: 시그니처 + 불변 조건 + 실패 모드 + 필요한 설정 |
| **Seam** | 그 자리를 편집하지 않고 동작을 바꿀 수 있는 위치. Module의 interface가 놓이는 곳 |
| **Port** | Application이 외부에 요구하는 interface (`src/ports/`). Seam의 한 형태 |
| **Adapter** | Port를 만족하는 구체 구현 (`src/adapters/`). 역할을 말하는 이름이지 크기를 말하지 않는다 |
| **Deep module** | 작은 interface 뒤에 많은 동작. Use Case가 이래야 한다. Adapter는 얇게 |
| **Use Case** | `src/application/` 의 이름 있는 실행 단위. 입력 계약 → Port 호출 → 출력 계약 |
| **Canonical contract** | `schemaVersion` 을 가진 persistent 데이터 계약 (`src/domain/`) |
| **RawObservation** | Source에서 확보한 payload의 불변 snapshot |
| **NormalizedDocument** | Raw를 공통 모델로 변환한 문서. 소스당 externalId 하나에 하나 |
| **Entity** | 언급 대상(MODEL, TOOL, SKILL, MCP_SERVER, FRAMEWORK, REPOSITORY, COMPANY, PERSON, CONCEPT) |
| **MetricObservation** | 실제로 관측한 수치. 계산값이 아님 |
| **DerivedSignal** | 관측값에서 계산한 값. 재계산 가능. `INSUFFICIENT_DATA` 상태를 가질 수 있음 |
| **Claim** | 유형(FACT … SYSTEM_INFERENCE)이 붙은 한 문장 주장. Evidence 또는 Signal 참조 필수 |
| **Evidence** | 문서의 특정 위치 인용 |
| **Intelligence Model** | 특정 window에 대해 검증된 Claim·Signal·Entity의 뷰. Artifact의 유일한 입력 |
| **Artifact** | 목적·채널별 산출물 (DAILY_BRIEF 등). revision과 contentHash를 가짐 |
| **Publication** | Artifact revision을 채널로 내보낸 기록 |
| **Run** | 자동화 실행 1회. 상태(SUCCESS … NO_NEW_INFORMATION)를 가짐 |
| **Managed region** | Obsidian 노트에서 AI Radar가 소유하는 마커 사이 영역. 밖은 사용자 소유 |
| **UNVERIFIED EXTERNAL CONSTRAINT** | 구현 시점에 외부에서 확인해야 하는 제약. 확인 방법이 함께 적혀 있어야 한다 |

## 문서 유지 규칙

- 계약 필드를 바꾸면 `CONTRACTS_AND_DATA.md` 와 해당 domain validator를 같은 변경에서 고친다.
- 계층 규칙을 바꾸면 `ARCHITECTURE.md` §3.1 표와 `test/architecture.test.ts` 를 같은 변경에서 고친다.
- 결정을 뒤집으면 기존 ADR을 삭제하지 말고 "Superseded by ADR-XXXX" 로 표시한다.
