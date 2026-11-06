# Tomorrow's format: local preview only

Not published. Source snapshot: 2026-10-06.

[coding]
## 코딩 AI가 읽고 고치는 파일을 실시간으로 볼 수 있어요

GhosttyEXTREME 제작자는 Claude Code의 파일 읽기·수정 과정과 여러 세션의 진행 상태를 한 화면에 보여주는 도구를 소개했어요.

제작자 설명에 따르면, 파일을 읽거나 고칠 때 Claude Code가 보내는 알림과 대화 기록을 이용해 터미널 옆 편집기에 작업 내용을 표시해요. 파일 지도에서는 읽기와 수정을 색으로 구분하고, 세션 목록에서는 작업 중인지 사용자 승인을 기다리는지 보여줘요. 작업이 끝나면 수정 전후의 차이를 검토함에 모으며, 특정 줄에 남긴 의견을 다음 작업 지시로 보낼 수 있어요.

**유의할 점** 제작자의 공개 소개에 근거한 기능 설명이에요. 현재 Apple silicon 기반 macOS를 지원하며, 제작자도 아직 미흡한 부분이 있다고 밝혔어요.

[제작자 소개 · Reddit](<https://www.reddit.com/r/ClaudeCode/comments/1wycbbr/i_built_a_terminal_where_you_can_watch_claude>) · [공개 소스 저장소](<https://github.com/steventsvik/GhosttyEXTREME>)

2026-10-06 · 수정 1

---

[coding]
## 긴 웹페이지에서 못 읽은 분량을 확인하고 이어 읽을 수 있어요

Claude Code 2.1.290은 웹페이지 읽기 도구 WebFetch가 100,000자를 넘는 본문을 알림 없이 누락하던 문제를 수정했어요.

공식 변경 기록에 따르면, 이제 WebFetch는 읽지 못한 분량이 얼마나 남았는지 알려줘요. 본문 읽기를 시작할 위치를 지정하는 offset도 받아서 남은 부분을 이어 읽을 수 있어요. 긴 문서에서는 첫 결과에 전체 내용이 들어왔는지 확인하고, 빠진 부분을 추가로 요청할 수 있어요.

[공식 변경 기록](<https://github.com/anthropics/claude-code/releases/tag/v2.1.290>)

2026-10-06 · 수정 1
