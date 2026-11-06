# Discord 연결 운영

ADR-0010의 멤버 전용 `git and github` 서버에 한정한다. 웹훅 관리 권한이 있는 계정으로 00~07 각 채널에 AI Radar 웹훅을 만든다. URL은 채팅이나 추적 파일에 넣지 않고 `data/store/discord-webhooks.json`의 대응 route에 저장한다. 이 파일은 Git에서 제외된다.

route 키: summary(00), models(01), coding(02), agents(03), products(04), infra(05), evals(06), culture(07). 로컬 파일에는 확인한 서버/채널 ID와 `enabled:false`가 준비되어 있다. 모든 웹훅을 채운 후 `enabled:true`로 켠다. 실제 전송 전 모든 웹훅의 guild/channel ID를 조회해 일치하는지 검사한다.

`npm run discord -- --input <edition.json> --dry-run`으로 내용을 확인한다. 드라이런은 웹훅이 없어도 가능하며 외부 전송을 하지 않는다. 검토된 edition은 `--dry-run`을 빼서 발행한다. 자동 Daily 실행은 설정이 켜져 있으면 기존 입력을 편집해 Discord에도 발행한다. 레거시 Daily의 수동 `--input`은 개인 정보 경계 때문에 Discord로 전송하지 않는다.

각 글은 원문 링크와 쉬운 설명을 포함한다. 활용 예시와 유의점은 이해에 필요하고 근거가 있을 때만 붙인다. 00은 **그날 성공적으로 게시된 모든 글**을 섹터별로 요약하고 해당 Discord 메시지로 연결한다. 새 정보가 없는 섹터를 채우지 않는다. 같은 날짜 재실행은 기존 메시지를 수정하며 이전 성공 항목도 00에 남긴다.

서버 응답을 받지 못해 새 메시지 생성 여부가 불명확하면 자동 재전송하지 않는다. 서버의 해당 메시지와 로컬 checkpoint를 대조해서 복구해야 한다. 프로세스가 비정상 종료되어 `discord-send.lock`이 남으면 발행 프로세스가 없는지 확인한 뒤 해당 잠금 파일만 제거한다. 웹훅과 journal은 함께 유지한다. journal을 지우고 재실행하면 중복될 수 있다.

중지: `enabled:false` 또는 Daily `--skip-discord`. 잘못된 JSON 등 설정 오류가 있으면 먼저 설정을 복구하거나 비활성화해야 한다. 10월 7일부터 공식 릴리스 피드와 Reddit 인기 글 임시 수집, 쉬운 한국어 편집을 적용한다. Threads는 인증 대기다. 출처별 실제 상태와 제약은 [수집·편집 운영](community-sources.md)을 따른다.

2026-10-06 연결 검증 완료: 8개 웹훅의 guild/channel ID 일치를 확인하고 로컬 설정을 활성화했다. 검토된 10월 5일자 5건을 실제 발행했고, 웹훅 메시지 조회로 본문과 요약의 상세 링크 5개를 검증했다. 같은 입력의 재실행은 기존 revision을 건너뛰어 중복이 없었다.

검증된 요약: https://discord.com/channels/1553831664856334488/1553847855595397253/1556985774136893451

기존 Windows `AI Radar Daily` 작업은 매일 00:00에 `scripts/run-daily.cmd`를 실행한다. 10월 6일 실행 결과는 0(정상 종료), 다음 실행은 10월 7일 00:00이다. Discord 활성화 이후 첫 예약 실행은 아직 도래하지 않아 별도 성공 확인이 남아 있다. 자동 수집에는 기존 RSS/HN과 추가된 공식 릴리스·Reddit 피드가 포함된다. 시험 게시 5건의 수동 조사 과정 전체가 자동화된 것은 아니다.
