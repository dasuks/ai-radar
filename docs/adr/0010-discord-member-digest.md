# ADR-0010: Member Discord editorial delivery

Date: 2026-10-05. Status: accepted for implementation by the user's connection request.

## Decision

Connect the existing daily pipeline to the member-only `git and github` server. Route useful, evidence-backed public-source items into 01 models/API, 02 coding tools/skills, 03 agent engineering, 04 AI product development, 05 infrastructure/cost, 06 evaluation/security, 07 AI literacy. Do not fill quotas. Use Korean informational prose, **활용 예시** for examples applicable to any reader, explicit evidence/limitations, and original and practical resource links. Never use private Vault notes or server conversations as source material.

00 summarizes **every successfully delivered item that day**, grouped by sector, with Discord message links. It is not another top-N filter. Empty sectors are omitted. A daily delivery journal retains earlier successful items across reruns and partial failures.

The user explicitly authorized automatic member-server delivery in this conversation. This is a scoped exception to INTEGRATIONS §6.2's former per-revision approval for all third-party Discord recipients: a configured member-only server and public-source editorial edition may use POLICY approval. Public servers, other destinations and private user information are not authorized by this exception. The existing PUBLIC-channel approval boundary remains intact. This narrowly brings the Discord output seam from Phase 6 forward; Trend and Librarian v2 are not prerequisites and are not claimed complete.

## Implementation boundary

Introduce DISCORD_EDITION artifact and WRITE_DISCORD task; separate selection/application, pure rendering, webhook adapter and runtime configuration. Existing Notion/Obsidian artifacts retain their semantics. Discord messages update in place with a revision indication, an explicit override of the old hypothetical append-only Discord rule.

One webhook per configured channel. Verify guild/channel metadata before writes. Secrets live only in gitignored local configuration. `allowed_mentions.parse=[]`, bounded payload sizes, `wait=true`, persist delivery progress, retry only definite rate limits. An ambiguous creation result is held for reconciliation, never blindly resent. Known message edits are retryable. No delete operations. Dry runs perform no webhook requests and no delivery journal writes. A single-process file lock protects concurrent daily deliveries.

## Acceptance

Tests cover all seven routes, general-audience prose, source validation, selection failures producing no noisy fallback, all-item summaries, partial retries, reruns, length limits, mention suppression, 429, ambiguous send prevention, guild/channel mismatch, no-secret errors and dry run. `npm run typecheck` and `npm test` must pass. Verify real webhook metadata and a reviewed first edition before enabling scheduled delivery. Rollback: disable Discord configuration or use --skip-discord.

## External references

- https://docs.discord.com/developers/resources/webhook
- https://docs.discord.com/developers/topics/rate-limits

UNVERIFIED EXTERNAL CONSTRAINT: live webhook permissions and channel IDs until metadata verification; Reddit/Threads automatic collection availability remains separate from connecting this output. Existing source coverage must be disclosed rather than claiming the manual web research process is already automated.
