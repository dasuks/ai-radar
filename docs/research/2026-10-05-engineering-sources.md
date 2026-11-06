# 2026-10-05 Engineering and skills evidence

Research scope: October 5, 2026 KST, through approximately 20:15 KST. Sources read directly; no installation or runtime validation performed.

## Selected: Supercov skill added to agentic-awesome-skills

- Event: agentic-awesome-skills v18.15.0 adds Supercov and byagent among 12 skills. This is a **catalog addition**, not proof either underlying tool launched today.
- Exact date verified using GitHub API: `published_at: 2026-10-04T23:30:47Z`, October 5 08:30:47 KST.
- [Release](https://github.com/sickn33/agentic-awesome-skills/releases/tag/v18.15.0)
- [API timestamp](https://api.github.com/repos/sickn33/agentic-awesome-skills/releases/tags/v18.15.0)
- [Supercov upstream](https://github.com/supercorp-ai/supercov)
- [Addition PR](https://github.com/sickn33/agentic-awesome-skills/pull/1787)
- Confirmed from upstream README: run the existing suite through `npx supercov -- npm test`; query uncovered lines/branches/conditions; have the coding agent write a small targeted test; rerun and compare evidence. Claude Code and Codex plugin install paths are documented.
- Practical editorial inference: useful when asking an agent for more tests currently produces repetitive tests without identifying missing behavior. For AI Radar, candidate application is error and retry branches in collection/publishing, but no effectiveness test was performed here.
- Coverage itself is local/free and needs no account per README. Optional code-quality/security/assertion analysis calls TypeSafe AI and needs an API key. Do not imply all functions are local/free.
- Category: 06 평가·보안. Suggested title: “테스트를 더 만들기 전에, 빠진 분기부터 찾는 Supercov 스킬”.
- Do not imply high coverage proves correctness or that the catalog maintainer's review equals independent effectiveness verification.

## Optional experiment: byagent document review loop

- Same catalog release and timestamp as above.
- [Upstream repository](https://github.com/anup-a/agent-artifacts)
- [Actual skill](https://github.com/anup-a/agent-artifacts/blob/main/skills/byagent/SKILL.md)
- [Catalog addition PR](https://github.com/sickn33/agentic-awesome-skills/pull/1788)
- Tool author documents Markdown/HTML publishing to a shareable URL; line comments can be retrieved by an agent, acted upon, and resolved; republishing the same directory retains the URL.
- Practical editorial inference: turn an agent report into a reviewable web page, let a reader mark an unclear sentence, then have the agent revise that sentence instead of copying long feedback into chat.
- Category: 02 AI 코딩도구 (document output/review skill), optionally 04 AI 제품개발 if editorial taxonomy prefers product collaboration.
- Limitations verified in source: new artifacts default to public; internal work needs explicit private publishing; guest pages are public, max three, and expire 24 hours after guest key creation. Private pages require signed-in workspace membership and do not offer viewer commenting. Thus do not imply private team commenting has parity with public commenting.
- The upstream skill explicitly encourages automatic publishing after report creation, so users should inspect behavior before adoption. No installation or publishing was performed. This is directly relevant functionality, not a hypothetical warning.
- Repository web page showed zero stars at retrieval. Do not call this popular or community-proven. PR author says the catalog-adapted copy was not tested separately. Lower confidence than a widely used recommendation; best presented as an experiment candidate or omitted for strict quality.

## Investigated but not selected

- [pstack-claude](https://github.com/michael-denyer/pstack-claude): direct API observed 1,280 stars. Created May 26, 2026, not new today. Today KST commits exist, but substantive one is UTF-8 BOM/unreadable session sheet consistency fix (0.9.67), too minor for a daily roundup unless users already have this plugin.
- [Today's pstack commit](https://github.com/michael-denyer/pstack-claude/commit/c1123fe2aaf7963a777f2a4171bf829116873064): 2026-10-04T16:08:19Z = October 5 01:08 KST.
- [pstack changelog](https://github.com/michael-denyer/pstack-claude/blob/main/CHANGES.md): prior 0.9.65 has interesting architecture-first correction skill, but today's timestamp not established for that feature, so don't recast it as today's news.
- Generic skill trending lists mix recently updated projects and suspicious low-star entries; updates alone do not establish meaningful new features or popularity.

## Claim boundaries

- Two selected candidates share one catalog release; consolidate under a single release if the final digest risks padding.
- Current popularity and effectiveness were not established for Supercov/byagent. Say “오늘 카탈로그에 추가된 실험 후보,” not “오늘 사람들이 많이 추천한 스킬.”
- All practical suggestions are inferences from documented capabilities, not firsthand use.
