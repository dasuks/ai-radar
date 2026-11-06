# Readable community Discord implementation plan

> For agentic workers: use subagent-driven-development for independent tasks, review each task and the integrated result.

**Goal:** Tomorrow's daily posts include practical release/community discovery and readable explanations while existing posts remain unchanged.
**Architecture:** Reuse SourceAdapter/RSS, document and evidence stores, Discord edition/renderer; add only official Threads adapter and v2 editorial contract.
**Tech Stack:** Existing TypeScript, HttpClient, SQLite stores, Codex LlmProvider, RSS/Atom.
**Spec:** docs/adr/0011-community-sources-readable-discord.md

## Global constraints

No live posts, commits, pushes, secret output or existing message edits. Existing uncommitted connection work is user work and retained. Keep this workspace because the active scheduled task uses it; all tests/previews exclude Publisher side effects. External auth failures must be disclosed. Routing follows C:/dev/ai/MODEL_ROUTING.md. User already authorized changes; no redundant permission round.

## Task 1: Editorial root cause (assigned worker)

Files: src/domain/artifacts/discord-edition.ts; src/application/discord/*; src/adapters/rendering/discord/edition-renderer.ts; test/discord-edition.test.ts; test/discord-pipeline.test.ts.

- [x] Keep old body v1 readable and add body v2 with nullable example/caveat; avoid unnecessary labels and duplicate lead/detail. Maintain link validation and length rejection.
- [x] Enrich the existing brief candidates from Stores documents/claims/evidence in application/discord. Only known source item facts and URLs; allow extra document URLs but original post links required. No private notes/howToApply fields. More than three available source URLs must not silently discard a story.
- [x] Bump editorial/prompt version and include enriched inputs in cache; add usage via recorder. Generic concrete examples only when needed, no invented effectiveness.
- [x] Tests at builder/renderer/stage seam: legacy, optional content, grounded links, untrusted input boundary, cache invalidation, no-fill selection, dry preview, failed delivery isolation.

## Task 2: Community sources (root + source worker after research)

Files: config/sources.json; src/runtime/config/app-config.ts; src/runtime/composition/build-daily-pipeline.ts; src/adapters/sources/threads/{index,normalize}.ts; matching source/config tests; operating docs (no .env.example exists).

- [x] Add verified GitHub release Atom and native Reddit top/day feeds via existing createRssSources, no second RSS parser. Reject promoted unsupported popularity claims in editorial guidance.
- [x] Implement Threads profile_posts official API according to primary docs verified by research worker. Pass token only from runtime config. Register one configured profile and explicit missing-auth source failure; do not pretend live coverage.
- [x] Tests for dated posts, permalink/body/linked resources, invalid schema, pagination limits/checkpoints, auth/rate-limit/timeout, and token-safe errors.

## Task 3: Integration/review (root)

- [x] Inspect live read-only feed probes and generate local editorial preview, without rerunning today's Publisher or updating Notion/Vault.
- [x] Run npm run typecheck and npm test. Read-only cross-review with gpt-6-astra via codex exec per MODEL_ROUTING. Fix material findings, rerun affected checks.
- [x] Document enabled sources, missing Threads authorization, next schedule, and a readable before/after sample. Request final reader feedback on the concrete sample.

## Progress ledger

Ruling: Keep current user-selected workspace and existing uncommitted work, do not create a disconnected worktree that the user's scheduled run cannot use. No commit under user rule. Tasks own disjoint files; root alone changes composition/config. Task 1 produces v2 builder/renderer; Task 2 only registers source adapters. Both consume existing domain contracts and Http/Llm ports. Root reviews shared integration. No publication command is permitted for verification.


## Verification (2026-10-06)

- Typecheck and all 275 tests passed after the final editorial revision. Read-only cross-review found no material issue.
- Real RSS/Atom probes: Reddit 20, Codex 4, Claude Code 2, Vercel AI 10, Agents SDK 0 documents in the sampled window; all completed.
- Live local LLM preview uses actual source documents and claim extraction, with no Publisher. Reader sample: docs/research/2026-10-06-discord-v2-preview.md. Editorial prompt version 3 uses natural polite Korean and explains unfamiliar terms through concrete actions.
- Threads API implementation is complete, but token/grant/target access remains unverified. No live Threads coverage is claimed.
- Reddit feed is temporary through the announced November 13 retirement. User explicitly chose to include it.
- Existing messages were not edited or reposted. Scheduled daily run remains 07:00 KST, next October 7. First scheduled delivery with these changes remains to be observed.

- Follow-up: user requested midnight; existing Windows task changed to 00:00 KST daily and next-run time verified. No pipeline was run during the schedule change.
