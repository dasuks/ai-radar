# ADR-0005: Storage and Reprocessing (SQLite behind a Port)

- Status: Accepted (2026-09-12)

## Context

AI Radar가 유지해야 하는 보장은 두 가지다. 하나는 **idempotency**(같은 window를 다시 실행해도 중복이 생기지 않는다), 다른 하나는 **reprocessing**(6개월 뒤 새 정책으로 과거를 다시 분석할 수 있다)이다. `ARCHITECTURE.md` §2.1 원칙 6~8이 이를 요구한다.

현재 구현은 JSON 파일만 쓴다. 그래서 unique constraint, index, window 쿼리를 직접 구현해야 하고 trend 계산과 idempotency 확인이 파일 스캔이 된다. 원본 payload를 보존하지 않아 재분석 경로도 없다.

동시에 개인용 단일 프로세스라는 제약이 있다. 운영해야 하는 서버가 늘어나는 선택지는 `ARCHITECTURE.md` §2.2에서 이미 배제되어 있다.

Node 24에는 `node:sqlite` 가 내장되어 있지만 아직 experimental 경고를 출력한다. 이것이 이 결정의 핵심 위험이다.

## Options

평가표 원문은 `CONTRACTS_AND_DATA.md` §7.1에 있다. 요약하면 다음과 같다.

1. **JSON 파일만 유지.** 현재와 동일하고 git diff가 가능하다. 그러나 unique constraint와 index를 손으로 만들어야 하고 window 쿼리가 전체 스캔이 된다. Raw payload와 Artifact 본문에는 여전히 적합하지만 인덱스 역할로는 부적합하다.
2. **`node:sqlite`.** Node 24 내장이라 의존성이 0이고, 단일 파일에 트랜잭션과 unique/index를 준다. Windows 네이티브 빌드 문제도 없다. 단점은 experimental 경고와 API 변경 가능성이다.
3. **`better-sqlite3`.** 성숙하고 동기 API가 깔끔하다. 다만 native build 의존성이 있어 Windows에서 빌드 이슈 가능성이 있다.
4. **Postgres 등 서버 DB.** 확장성은 가장 좋다. 개인용 단일 프로세스에 과하고 운영 부담이 크다.

## Decision

**옵션 2를 채택하되 Port와 driver 래퍼 뒤에 격리한다.** 옵션 3은 fallback으로 남기고, 옵션 4는 채택하지 않되 이행 가능성만 `MIGRATION_AND_ACCEPTANCE.md` §6 시나리오 17로 보장한다.

- **Store Port 뒤에 둔다.** `ports/storage/` 의 `RawStore`, `DocumentStore`, `EntityStore`, `MetricStore`, `ClaimStore`, `ArtifactStore`, `RunStore`, `CheckpointStore`, `FeedbackStore`, `KnowledgeProposalStore`, `UnitOfWork` 를 `adapters/storage/sqlite/` 가 구현한다 (테이블 대응은 `ARCHITECTURE.md` §5). 테스트용 `adapters/storage/memory/` 가 두 번째 구현이므로 seam이 가설이 아니다 (`ARCHITECTURE.md` §5).
- **driver 래퍼를 둔다.** `node:sqlite` 에 직접 닿는 코드는 `adapters/storage/sqlite/driver.ts` 한 파일이다. API가 바뀌거나 `better-sqlite3` 로 교체할 때 영향 범위를 한 파일로 제한한다.
- **3층 논리 저장소와 물리 배치**는 `CONTRACTS_AND_DATA.md` §7.2에 있다. Raw Store는 `CollectSources` 만 쓰고, Intelligence Store는 각 Use Case가 쓰며, Artifact Store는 `Build*` 와 `PublishArtifact` 가 쓴다.
- **DB에 담지 않는 것**: raw payload(`data/store/raw/<sourceId>/<yyyy-mm>/<obsId>.json|html`), Artifact body(`artifacts/<type>/<targetKey>/r<revision>.json`), 렌더 결과(`rendered/`, 재생성 가능), Run 스냅샷(`runs/<runId>.json`, 디버깅용 이중 기록). DB는 인덱스와 관계, 파일은 본문을 갖는다. 32KB 미만의 작은 payload는 `PayloadRef.kind="inline"` 로 둘 수 있다 (`CONTRACTS_AND_DATA.md` §1.1).
- **테이블 DDL v1**은 `CONTRACTS_AND_DATA.md` §7.3이다. `*_json` 컬럼이 계약 전체를 보관하고 쿼리에 필요한 컬럼만 승격했으므로, 계약의 minor 변경은 DDL 변경 없이 흡수된다. Foreign key는 `PRAGMA foreign_keys = ON` 으로 강제한다.
- **쓰기는 Use Case 단위 트랜잭션**(`UnitOfWork` port) 안에서 한다. Raw payload 파일은 트랜잭션 전에 쓰고, row 커밋이 실패하면 파일은 고아가 되어도 무해하다. 같은 hash로 다음 실행에서 재사용된다.
- **Migration**은 `adapters/storage/sqlite/migrations/NNNN_<name>.ts` 순번 모듈(SQL 문자열 export)이며 시작 시 `schema_migrations` 와 비교해 미적용분을 트랜잭션으로 적용한다. Downgrade는 지원하지 않고, 대신 migration 전 DB 파일 복사본을 `store/backups/<timestamp>/` 에 남긴다 (`CONTRACTS_AND_DATA.md` §7.4).
- **읽기 경로는 항상 `upcast()` 를 거친다.** 따라서 일괄 재기록(`ai-radar migrate --contract <name>`)을 미루어도 동작한다 (ADR-0002).
- **재분석 보장** (`CONTRACTS_AND_DATA.md` §7.5): (1) `raw_observations` 와 `raw/` 파일이 원본을 그대로 보존한다. (2) `ai-radar reanalyze --from … --to … --policy trend@2.0` 이 새 Run(kind=REANALYZE)을 만들어 Normalize 이후 단계를 다시 실행하고, 결과는 새 `policy_version` / `analysis_id` 로 옛 결과와 **공존**한다. (3) Artifact를 다시 만들면 revision이 올라가고 이미 발행된 revision은 그대로 남는다.
- **삭제 정책**: Derived 데이터(signals, classifications)는 재계산 가능하므로 policy 버전 단위 삭제를 허용한다. Raw와 Intelligence의 나머지, Artifact는 삭제하지 않고 상태로 표시한다 (`CONTRACTS_AND_DATA.md` §7.2).

**UNVERIFIED EXTERNAL CONSTRAINT** (`CONTRACTS_AND_DATA.md` §7.6): `node:sqlite` 의 안정성. Node 24.14에서 import는 성공하지만 ExperimentalWarning을 출력한다. 확인 방법은 Phase 2 착수 시 `node --no-warnings -e "require('node:sqlite')"` 실행과 공식 Node 문서의 stability index 확인이며, Stable이 아니면 `driver.ts` 를 `better-sqlite3` 로 교체한다.

## Consequences

- unique constraint와 index가 DB에서 강제되므로 idempotency key 표(`CONTRACTS_AND_DATA.md` §8)가 코드가 아니라 스키마로 보장된다.
- 단일 파일이므로 백업이 파일 복사다. 설치와 배포에 추가 서비스가 없다.
- 원본 payload가 불변 파일로 남아 재분석과 감사가 가능하다. 파일 경로가 `(sourceId, yyyy-mm, obsId)` 로 정해져 사람이 직접 찾아볼 수 있다.
- 큰 본문이 DB 밖에 있으므로 DB 파일 크기가 천천히 는다.
- `node:sqlite` 위험은 한 파일(`driver.ts`)로 국한되고, 교체 경로가 미리 정해져 있다.
- 파일과 DB의 이중 기록 때문에 고아 파일이 생길 수 있다. 이는 의도된 트레이드오프이며 해로운 상태가 아니다.

## Tradeoffs

- experimental API에 의존한다. Node minor 업그레이드가 런타임을 깨뜨릴 수 있다.
- SQLite는 단일 writer다. 여러 프로세스가 동시에 쓰는 구조로 갈 수 없다.
- 데이터가 DB와 파일 두 곳에 나뉘어 있어 "전부 복사"가 두 단계다. 백업 절차가 단순 파일 하나가 아니다.
- `*_json` 컬럼 방식은 유연하지만, 승격되지 않은 필드로 쿼리하려면 migration이 필요하다.
- 파일은 git으로 추적하지 않는다(`data/store/` 는 gitignore). 소실 시 복구는 백업에 의존한다.

## Revisit conditions

- **Phase 2 착수 시점에 `node:sqlite` 가 여전히 experimental이면** 이 ADR의 driver 선택을 `better-sqlite3` 로 바꾼다. Store Port와 DDL은 그대로 유지한다.
- `node:sqlite` 의 API가 breaking 변경을 내거나 `driver.ts` 가 두 버전을 동시에 지원해야 할 때.
- DB 파일이 2GB를 넘거나, 한 달 window의 trend 쿼리가 5초를 넘을 때. 먼저 인덱스와 승격 컬럼을 조정하고, 그래도 부족하면 옵션 4(Postgres, 시나리오 17)를 연다.
- 여러 프로세스나 여러 기기에서 동시에 쓰는 요구가 생길 때. SQLite 단일 writer 가정이 깨지므로 이 결정 전체를 다시 연다.
- `raw/` 디렉터리가 디스크 용량을 위협할 때. 먼저 오래된 payload 파일만 외부 보관으로 옮기고 row는 유지한다 (`CONTRACTS_AND_DATA.md` §7.2). 그래도 부족하면 보존 정책을 ADR로 다시 정한다.
