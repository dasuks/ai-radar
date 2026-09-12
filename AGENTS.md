# AI Radar — Agent 작업 규칙

이 저장소에서 작업하는 모든 코딩 에이전트(Claude Code, Codex, 기타)는 이 파일을 먼저 읽는다. 전역 규칙(`~/.agents/AGENTS.md`)을 보완하며, 충돌하면 이 파일과 사용자 지시가 우선한다.

## 1. 프로젝트 정체성

- 표기명 **AI Radar**, repository `ai-radar`, Daily 산출물 이름 **AI Intelligence Daily**.
- 개인용 AI Intelligence Platform이다. 뉴스 크롤러도, Horizon 래퍼도, 자동 SNS 게시기도 아니다.
- 과거 이름 `ai-coding-radar` / "AI Coding Radar" 는 Obsidian 노트의 레거시 마커와 외부 Notion Integration 표시명에 남아 있다. **런타임 호환을 위해 남긴 것이므로 이름 통일 목적으로 지우지 않는다.** 처리 기준은 `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` §3.

## 2. 아키텍처 문서 (단일 출처)

| 문서 | 내용 |
| --- | --- |
| `docs/architecture/README.md` | 문서 지도, 용어집 |
| `docs/architecture/ARCHITECTURE.md` | 계층, 의존성 규칙, 모듈 지도, 확장 지점 |
| `docs/architecture/CONTRACTS_AND_DATA.md` | Canonical 계약, schemaVersion, 저장소 DDL, idempotency key |
| `docs/architecture/PIPELINES_AND_POLICIES.md` | Use Case, Source Adapter 계약, Run 상태, LLM/Ranking/Trend 정책 |
| `docs/architecture/INTEGRATIONS_AND_SAFETY.md` | Notion/Obsidian 역할, 사용자 데이터 보호, 보안, 공개 게시 승인 |
| `docs/architecture/MIGRATION_AND_ACCEPTANCE.md` | 현재 baseline, Phase 계획, 시나리오, 아키텍처 테스트 |
| `docs/adr/` | 결정 기록 (ADR-0001 ~ 0008) |

기능을 추가하기 전에 해당 Phase와 시나리오를 확인한다. 설계에 없는 구조를 도입하려면 먼저 ADR을 쓴다.

## 3. 절대 위반하면 안 되는 의존성 규칙

의존성 방향: `domain ← policies ← application → ports ← adapters ← runtime` (application은 ports를 사용하고, adapters가 ports를 구현한다. ports는 domain만 안다).

- `src/domain`, `src/policies`, `src/application`, `src/ports` 는 외부 SDK(`@notionhq/*`, `@anthropic-ai/*`, `openai`, `dotenv`), `node:fs`, `node:http`, `node:child_process`, `node:sqlite`, `process.env` 를 import/참조하지 않는다.
- `src/application` 은 `src/adapters`, `src/runtime` 을 import하지 않는다.
- `src/adapters/<a>` 는 `src/adapters/<b>` 를 import하지 않는다.
- `process.env` 는 `src/runtime/config` 에서만 읽는다. 자격증명은 생성자 인자로 전달한다.
- Horizon·Notion·Provider 고유 타입은 각 adapter 디렉터리 밖으로 나가지 않는다.
- 분석 Use Case(`application/analyze`, `trend`, `briefing`)는 Publisher·Vault·Http Port를 주입받지 않는다.
- `test/architecture.test.ts` 가 이 규칙을 검사한다. 규칙을 바꾸면 `ARCHITECTURE.md` §3.1 과 테스트를 같은 변경에서 고친다.

## 4. 새 Source / LLM / Output 추가 방식

- **Source**: `src/adapters/sources/<name>/` 에 `SourceAdapter` 구현 + `normalize.ts` + fixture 테스트. `descriptor.capabilities` 와 `license` 를 정직하게 채운다. checkpoint는 인자로 받고 반환한다(상태 저장 금지). `publishedAt` 을 모르면 null. Core 변경 없이 composition root에 등록만 한다.
- **LLM Provider**: `src/adapters/llm/<name>/` 에 `LlmProvider` 구현 + `capabilities()`. 라우팅은 설정 파일. 모든 출력은 schema + evidence 검증을 거친다.
- **Output 채널**: `src/adapters/<channel>/` 에 `Publisher` + Renderer. 채널 visibility 정책(`INTEGRATIONS_AND_SAFETY.md` §6.2)에 등록. PUBLIC 채널은 `ApprovalRecord` 없이 발행할 수 없다.
- 새 Entity type, Metric key, Artifact type은 domain enum 추가 + 해당 정책 profile 추가. 별도 Trend Engine을 만들지 않는다.

## 5. 기존 사용자 데이터 보호

- Notion: `Read`, `Applied` 및 코드가 관리하지 않는 속성은 갱신 요청에 넣지 않는다. Date 기준 페이지가 2개 이상이면 중단한다. 설정 ID와 다른 DB에 쓰지 않는다.
- Obsidian: 마커 밖 텍스트는 사용자 소유이며 수정하지 않는다. 관리 영역 내부를 사용자가 고쳤으면 덮어쓰지 않고 보류한다. 레거시 마커 `ai-coding-radar:*` 는 읽기 호환한다. 삭제·대량 변경·백업 파일 생성을 하지 않는다. 한 Run의 노트 변경 수 상한을 지킨다.
- `.env` 값을 출력·로그·커밋하지 않는다. `data/store/` 는 커밋하지 않는다.
- 실제 Vault나 Notion에 대한 변경은 `--dry-run` 으로 먼저 확인한다.

## 6. 작업 규칙

- Big Bang rewrite 금지. Phase 순서(`MIGRATION_AND_ACCEPTANCE.md` §4)를 따르고 각 Phase의 Done 조건과 rollback을 지킨다.
- 빈 디렉터리를 미리 만들지 않는다. 필요한 모듈만 만든다.
- 테스트는 새 seam의 interface에서 작성한다(replace, don't layer). `npm run typecheck` 와 `npm test` 가 통과해야 완료다.
- 구현 시점에만 알 수 있는 외부 제약은 `UNVERIFIED EXTERNAL CONSTRAINT` 로 표시하고 확인 방법을 적는다.
- git commit/push는 사용자가 지시할 때만 한다.
