# ADR-0008: Public Content Approval Boundary

- Status: Accepted (2026-09-12)

## Context

AI Radar의 산출물 일부는 언젠가 공개 채널(Instagram, Web)로 나갈 수 있다. 그러나 저장소 안에는 공개하면 안 되는 것이 섞여 있다.

- 개인 메모, 유료/제한 소스에서 온 내용, 라이선스가 불명한 인용, 개인 식별 정보가 포함된 문서에서 나온 claim.
- 사용자의 Obsidian 노트 내용.
- 아직 검증되지 않은 `RUMOR`, `FORECAST`, 일반화된 `USER_EXPERIENCE`.

`ARCHITECTURE.md` §1.2는 "자동 SNS 게시기"를 정체성 부정 목록에 넣고, 공개 게시는 승인 경계 뒤에만 존재한다고 못 박는다.

공개 게시에는 되돌릴 수 없는 실패 모드가 있다. 잘못 게시한 내용은 삭제해도 이미 퍼진다. 수정 불가 채널에서는 in-place 수정도 불가능하다. 게다가 타임아웃 후 성공 여부를 알 수 없는 애매한 결과가 존재한다.

## Options

1. **공개 게시를 아예 하지 않는다.** 가장 안전하고 구현이 0이다. 그러나 `ARCHITECTURE.md` §1.1이 명시한 재사용 목적 중 하나인 "콘텐츠 제작"을 포기하게 되고, 나중에 붙일 때 계약을 전부 다시 설계해야 한다.
2. **자동 게시 후 사후 검토.** 운영이 가장 편하고 매일 콘텐츠가 나온다. 그러나 잘못된 게시가 되돌려지지 않으며, 사후 검토는 실제로는 수행되지 않는 경우가 많다. 개인 계정의 평판이 걸린 실패 모드에 맞지 않는다.
3. **분류(visibility) + 사람 승인 + hash 잠금.** 무엇이 공개 가능한지를 계약으로 표시하고, 공개 채널은 사람 승인을 요구하며, 승인한 그 내용과 그 렌더 결과만 나가도록 hash로 잠근다. 구현과 운영 부담이 가장 크다.

## Decision

옵션 3을 채택한다. 지금 구현하는 것은 **계약과 경계**이고, Instagram flow 자체는 설계만 한다 (`INTEGRATIONS_AND_SAFETY.md` §6.3).

- **visibility는 기본 PRIVATE다.** `Claim.visibility` 가 `PUBLIC_OK` 가 되려면 공개 소스의 짧은 인용이고 우리 문장으로 재서술 가능해야 한다. 판단은 LLM이 아니라 규칙(`policies/classification/visibility.ts`)이 한다. `Artifact.visibility` 는 포함된 모든 claim의 **AND**다 (`CONTRACTS_AND_DATA.md` §5.4).
- **채널별 정책표**는 `INTEGRATIONS_AND_SAFETY.md` §6.2다. notion과 obsidian은 PRIVATE 허용에 POLICY 자동 승인, discord와 email은 PRIVATE 허용이되 revision당 1회 발송, **instagram과 web은 `PUBLIC_OK` 필수이고 USER 승인이 필수**다.
- **승인은 내용과 렌더 결과를 함께 잠근다.** `ApprovalRecord` 가 `contentHash` 와 `renderedAssetHash` 를 가진다 (`CONTRACTS_AND_DATA.md` §5.3). `PublishArtifact` 는 승인 `contentHash` 가 현재 contentHash와 다르면 승인을 무효로 보고 중단하며, 승인에 `renderedAssetHash` 가 있으면 렌더 결과 hash 일치도 확인한다 (`PIPELINES_AND_POLICIES.md` §9).
- **PUBLIC 채널에 승인이 없으면 발행하지 않고 `PENDING_APPROVAL` 로 중단한다.** 승인은 `ai-radar approve <artifactId> --channel <ch>` 로 사람이 한다.
- **수정 불가 채널의 정정은 새 Artifact다.** in-place 수정 대신 `RETRACTION` Artifact를 만들고 새 승인을 받으며, 원본 `PublicationRecord` 는 `RETRACTED` 로 표시한다.
- **중복 게시 방지와 애매한 결과 처리.** `publications` PK와 `externalId` 조회로 중복을 막고, 타임아웃 후 성공 여부가 불명하면 `Publisher.verify(externalId)` 로 확인한 뒤에만 재시도한다. 실패는 `attempt` 를 올리며 최대 N회다.
- **구조적 보장: Collector, Analyzer, Librarian 어느 것도 `Publisher` Port를 주입받지 않는다** (`INTEGRATIONS_AND_SAFETY.md` §5.2, §6.3). 분석 단계에서 발행이 일어날 경로가 코드 구조상 없고, 아키텍처 테스트가 import로 확인한다.
- **공개 콘텐츠도 근거에 묶인다.** 모든 카드 문장은 `claimIds` 를 가지며 출처 카드가 자동 생성된다. 소스 라이선스 조건은 `SourceDescriptor.license` 에 기록되어 public-safe 선택의 입력이 된다 (`PIPELINES_AND_POLICIES.md` §2.1).
- 요구 사항과 담당 계약의 대응표는 `INTEGRATIONS_AND_SAFETY.md` §6.3 마지막 표에 있다.

**UNVERIFIED EXTERNAL CONSTRAINT** (`INTEGRATIONS_AND_SAFETY.md` §6.3): Instagram Graph API의 게시 절차(컨테이너 생성 후 게시), 캐러셀 제한, 비즈니스 계정 요구, rate limit이 확인되지 않았다. 확인 방법은 구현 착수 시 Meta 공식 문서와 샌드박스 계정으로 검증한 뒤 `adapters/instagram/README.md` 에 기록하는 것이다.

## Consequences

- 공개 게시는 사람이 승인한 정확한 revision과 정확한 렌더 결과로만 나간다. 승인 후 내용이 바뀌면 자동으로 막힌다.
- `PRIVATE` 이 기본이므로 분류 규칙을 만들지 않은 상태에서는 공개 채널로 나갈 수 있는 것이 없다. 안전한 쪽으로 실패한다.
- 승인·게시·재시도·철회가 모두 테이블 상태로 남아 감사할 수 있다.
- Instagram을 구현하지 않아도 계약은 이미 존재하므로, 나중에 붙일 때 추가되는 것은 Renderer와 Publisher adapter뿐이다.
- Discord와 Email 같은 개인 채널은 자동 승인이라 승인 피로가 생기지 않는다.

## Tradeoffs

- 공개 콘텐츠는 자동화되지 않는다. 사람이 승인하지 않으면 아무것도 나가지 않는다. 이는 의도된 비용이다.
- visibility 규칙이 보수적이라 초기에는 `PUBLIC_OK` claim이 거의 없을 수 있다. 공개할 재료가 부족해 보이는 기간이 생긴다.
- 승인과 렌더 결과 hash를 잠그므로, 렌더러를 고치면 기존 승인이 무효가 되어 재승인이 필요하다.
- 아직 쓰지 않는 계약(`ApprovalRecord`, `RETRACTION`, `renderedAssetHash`)을 지금 유지해야 한다.
- 규칙 기반 visibility는 완전하지 않다. 라이선스 판단 같은 회색 지대는 여전히 사람 몫이다.

## Revisit conditions

- Instagram Graph API를 실제로 검증했을 때(위 UNVERIFIED 항목). 게시 절차가 설계와 다르면 flow와 재시도 규칙을 갱신한다.
- `PUBLIC_OK` claim 비율이 한 달 이상 전체의 5% 미만이라 공개 Artifact를 만들 재료가 없을 때. visibility 규칙이 과하게 보수적인지 다시 본다.
- 승인 대기 Artifact가 7일 이상 쌓이거나 10건을 넘을 때. 승인 UX(터미널 대 Notion 승인 DB)를 다시 결정한다.
- 잘못된 공개 게시가 1건이라도 발생할 때. 원인을 이 ADR의 경계 중 어디가 뚫렸는지로 분류하고 규칙을 강화한다.
- 공개 채널이 2개를 넘거나, 조직 계정 등 개인 외 계정으로 게시하게 될 때. 승인자 개념(`approvedBy`)을 사람 1명 가정에서 확장해야 한다.
