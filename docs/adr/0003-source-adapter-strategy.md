# ADR-0003: Source Adapter Strategy (Horizon, agents-radar, 직접 구현)

- Status: Accepted (2026-09-12)

## Context

AI Radar는 여러 출처를 관측해야 하고, 출처는 계속 늘거나 죽는다. 이미 존재하는 두 OSS(Horizon, agents-radar)를 얼마나 재사용할지가 첫 갈림길이었다. 2026-09-12에 두 저장소의 소스를 직접 읽어 검증했고, 그 결과는 `INTEGRATIONS_AND_SAFETY.md` §8에 있다. 결정에 결정적으로 작용한 확인 사실은 다음과 같다.

**Horizon (`Thysrael/Horizon`)**, `INTEGRATIONS_AND_SAFETY.md` §8.1:
- **Python**이고 **MIT**다 (`LICENSE`, `pyproject.toml`). TypeScript가 아니다. 9.3k stars, 2026-09-12 push.
- **PyPI에 배포되어 있지 않다.** TypeScript에서는 MCP 또는 프로세스로만 쓸 수 있다.
- CLI 경로는 LLM 요약 Markdown만 저장한다. 반면 **MCP 도구 `hz_fetch_items` 는 LLM 없이 수집만 실행해 `raw_items.json`(ContentItem 전체)을 저장한다** (`src/mcp/service.py:304-350`, `src/orchestrator.py:173-218` 에 AI client 없음).
- 소스는 HN, RSS, Reddit, GitHub, Telegram, Twitter, OpenBB, OSS Insight, GDELT, Google News. **arXiv와 YouTube는 없다.**
- 본문 완전성은 RSS+extractor=FULL, RSS=EXCERPT, HN/GitHub=TITLE_ONLY+댓글. 댓글은 `--- Top Comments ---` 뒤 문자열로 평탄화되고 500자에서 잘린다.
- **checkpoint가 없다.** 시간 window만 있다. 재실행 시 같은 항목을 다시 가져온다.
- SSRF guard(`src/url_security.py`)는 우수하다. 다만 config의 `${VAR}` 확장으로 임의 env를 URL에 넣을 수 있고 `.cursor/mcp.secrets.json` 등에서 secret을 암묵 로딩한다.
- 계약 변환 난이도는 LOW에서 MEDIUM. `ContentItem` 과 `NormalizedDocument` 가 거의 1:1이다. 결손은 rawPayload 없음, `published_at` non-null(무날짜 항목 드롭), completeness 추론 필요, comments 문자열 파싱.

**agents-radar (`duanyytop/agents-radar`)**, `INTEGRATIONS_AND_SAFETY.md` §8.2:
- **TypeScript(ESM)**, **MIT**, 1.0k stars, 2026-09-11 push. 패키지가 아니라 GitHub Actions 워크플로 형태다.
- **구조적 저장이 없다.** 메모리 → LLM → Markdown이고 `highlights.json` 도 LLM 출력이다. 호스팅 MCP(Cloudflare Worker)는 Markdown만 제공하며 저자 계정이다.
- LLM provider를 모듈 top-level에서 생성하므로 파이프라인 실행에 LLM이 필수다. **다만 fetcher 모듈은 LLM 무관이고 의존성이 0이다.**
- `github.ts` 는 REST의 `since` pagination을 실제로 구현했고, `web.ts` 는 sitemap lastmod diff + `web-state.json` 이라는 진짜 checkpoint를 가진다. `arxiv.ts` 는 Atom을 regex로 파싱한다. `trending.ts` 는 HTML regex라 취약하다.

두 프로젝트 모두 upstream raw payload와 구조화된 `comments[]` 를 보존하지 않는다 (`INTEGRATIONS_AND_SAFETY.md` §8.3).

## Options

1. **Horizon 파이프라인을 그대로 채택하고 AI Radar를 그 래퍼로 만든다.** 소스 10종을 즉시 얻는다. 그러나 CLI 경로는 LLM Markdown만 남기므로 Evidence·Metric·재분석이 불가능하고, AI Radar가 "Horizon 래퍼"가 되어 정체성 부정 목록(`ARCHITECTURE.md` §1.2)에 정면으로 어긋난다.
2. **Horizon의 per-source 로직을 TypeScript로 포팅한다.** Python 의존과 프로세스 실행이 사라지고 checkpoint를 우리가 붙일 수 있다. 그러나 소스 10종 + Reddit fallback 체인 + SSRF guard를 옮기는 비용이 크고, upstream 개선을 따라가지 못한다.
3. **Horizon을 외부 프로세스로 실행하고 `hz_fetch_items` 의 `raw_items.json` 출력을 ingest한다.** LLM 없이 수집만 돌릴 수 있다는 확인 사실이 이 옵션을 가능하게 했다. Python 의존과 프로세스 경계가 남지만, 소스 10종을 그대로 얻으면서 Core는 `RawObservation` 만 본다.
4. **agents-radar 파이프라인을 채택한다.** 언어가 TypeScript라 통합이 쉬워 보인다. 그러나 구조적 저장이 없고 LLM이 모듈 top-level에 묶여 있어 "수집만" 떼어내려면 결국 fetcher만 쓰게 된다.
5. **전부 직접 구현한다.** 계약 충실도가 최고다. 그러나 Phase 1에 소스가 0이 되고, 이미 검증된 로직(HN Firebase, GitHub `since` pagination, sitemap diff)을 다시 만드는 비용이 든다.

## Decision

- **Source Port 계약을 먼저 고정한다.** `SourceDescriptor` / `CollectRequest` / `CollectResult` / `SourceAdapter` 는 `PIPELINES_AND_POLICIES.md` §2.1에 있다. Adapter는 **stateless**이며 checkpoint를 인자로 받고 결과로 돌려준다. 네트워크는 `ctx.http` 로만 접근하고 `fetch` 를 직접 호출하지 않는다. 자격증명은 생성자 인자로 받는다.
- **깊이는 `CollectSources` 에 둔다** (`PIPELINES_AND_POLICIES.md` §2.2). 재시도(지수 백오프 최대 2회), source별 `AbortController` 와 deadline, hash dedupe, checkpoint 저장, 부분 실패 집계가 여기 한 곳에 있다. `NO_NEW_ITEMS` 와 `FAILED` 를 구분하는 판정표도 §2.2에 있다.
- **Horizon: 옵션 3을 채택한다.** `adapters/sources/horizon/` 은 `kind: "EXTERNAL_TOOL"` 로, 고정 명령으로 Horizon 프로세스를 실행해 `hz_fetch_items(hours, sources)` 를 호출하고 run 디렉터리의 `raw_items.json` 을 읽어 `RawObservation` 으로 변환한다. Horizon `ContentItem` 하나가 `payloadRef`(inline JSON)가 되며, upstream 원본이 없다는 사실을 `rawMetadata.rawIsHorizonContentItem=true` 로 정직하게 기록한다. completeness 추론 규칙, `--- Top Comments ---` 파싱, `externalId`/`sourceId` 규칙, 실행 환경 격리(전용 `data/config.json`, 필요한 env만 전달)는 `PIPELINES_AND_POLICIES.md` §2.3에 있다.
- **agents-radar: 파이프라인은 채택하지 않는다.** `github.ts`, `web.ts`, `arxiv.ts` 와 `config.yml` 의 repo 목록만 **MIT attribution 하에 포팅**한다 (Phase 3). `trending.ts` 와 prompt 계층은 제외한다 (`INTEGRATIONS_AND_SAFETY.md` §8.2).
- **직접 구현 순서**는 `manual-json` → `hackernews` → `rss` → `github` 이다. 각 소스의 이유는 `PIPELINES_AND_POLICIES.md` §2.4 표에 있다.
- Horizon 출력은 **비신뢰 데이터**다. 명령 인자나 경로로 해석하지 않는다. 셸 실행은 `adapters/sources/horizon/` 에서만 허용되고 인자 조립 함수는 `RawObservation` 을 입력받지 않는다 (`INTEGRATIONS_AND_SAFETY.md` §5.2).
- Horizon의 Reddit fallback 체인과 SSRF guard는 향후 TypeScript 포팅 후보로 남긴다 (`INTEGRATIONS_AND_SAFETY.md` §8.1).

**UNVERIFIED EXTERNAL CONSTRAINT** (`PIPELINES_AND_POLICIES.md` §2.3): TypeScript에서 `hz_fetch_items` 를 호출하는 가장 단순한 방법(MCP stdio client 대 Python 한 줄 래퍼)과 runs root 경로 규칙이 아직 확인되지 않았다. 확인 방법은 Phase 2에서 Horizon을 로컬 설치하고 두 방식을 fixture로 실행해 `raw_items.json` 위치와 `ContentItem` 스키마(`extra="forbid"`)를 고정 테스트로 캡처하는 것이다.

## Consequences

- Horizon이 사라져도 삭제되는 것은 `adapters/sources/horizon/` 과 composition root 한 줄이다 (`ARCHITECTURE.md` §6).
- Horizon에 checkpoint가 없다는 결손은 우리 `payloadHash` dedupe가 흡수한다. 재수집이 중복을 만들지 않는다 (`CONTRACTS_AND_DATA.md` §8).
- 같은 항목을 Horizon과 직접 수집으로 둘 다 받으면 `sourceId` 가 다르고(`horizon:hackernews` 대 `hackernews`) `SAME_URL` link로 연결된다. 삭제하지 않는다.
- 댓글 500자 절단과 무날짜 항목 드롭은 Horizon 경로에서 복구되지 않는다. 같은 소스를 직접 구현하면 그때 손실이 사라진다.
- Python 런타임이 Horizon 경로의 전제 조건이 된다. Horizon을 등록하지 않으면 AI Radar는 Node만으로 동작한다.
- agents-radar 포팅분은 MIT attribution을 코드와 문서에 남겨야 한다.

## Tradeoffs

- 프로세스 경계와 파일 ingest는 in-process 호출보다 느리고 디버깅이 번거롭다. 실행 실패 유형(설치 없음, Python 버전, 경로)이 새로 생긴다.
- Horizon의 config와 env를 우리가 통제해야 한다. `${VAR}` 확장과 암묵 secret 로딩을 차단하는 책임이 adapter에 있다.
- Horizon 출력 스키마 변경은 우리 fixture 테스트를 깨뜨린다. 이는 의도된 조기 경보이지만 유지 비용이다.
- agents-radar에서 파일 3개만 가져오므로 upstream 수정이 자동으로 따라오지 않는다.
- 직접 구현 소스가 늘수록 Horizon의 가치는 줄어든다. 한동안 두 경로가 공존하는 중복을 감수한다.

## Revisit conditions

- Phase 2에서 위 UNVERIFIED 항목을 검증했을 때 `raw_items.json` 위치나 스키마가 문서와 다르면, 이 ADR의 Horizon 결정을 다시 연다.
- Horizon이 `hz_fetch_items` 를 MCP에서 제거하거나 출력에서 `ContentItem` 전체 저장을 그만두면 옵션 2(per-source 포팅)로 전환한다. 그 경우 Reddit fallback 체인이 첫 포팅 대상이다.
- Horizon이 PyPI에 배포되거나 upstream raw payload를 보존하기 시작하면 통합 방식을 다시 평가한다.
- Horizon 프로세스 실행이 한 Run의 수집 deadline의 50%를 넘거나, Horizon 경로의 `FAILED` 비율이 2주 연속 30%를 넘을 때.
- 직접 구현 소스가 Horizon이 제공하는 소스의 대부분을 대체해, Horizon 고유 소스(Telegram, GDELT, OpenBB 등)만 남을 때. 그 시점에 Horizon 등록 유지 여부를 판단한다.
- agents-radar 포팅분(`github.ts`, `web.ts`, `arxiv.ts`)이 upstream과 크게 벌어져 재포팅이 필요해질 때.
