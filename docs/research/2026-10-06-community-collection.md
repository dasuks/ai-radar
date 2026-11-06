# 2026-10-06 community collection evidence

Scope: read-only official documentation, upstream OSS code, and unauthenticated HTTP probes from this workspace on October 6, 2026. No tokens/cookies, external writes, Discord changes, or access-control workarounds. HTTP success below is an observation, not an availability guarantee.

## Decision

Reuse `RssSource` for official GitHub release Atom feeds and, **temporarily**, one combined Reddit daily-top Atom feed. Threads public HTML is not a working post source for `@choi.openai` in this environment; prefer the official public-profile-posts API once authorized. Surface missing authorization or collection failures as incomplete coverage, never as “no new posts.” No durable, unauthenticated Reddit replacement was established.

This follows existing practice: [Upvote RSS](https://github.com/johnwarne/upvote-rss) uses authenticated Reddit access for score-based filtering and comments; [RSSHub's Threads route](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/threads/index.ts) converts profile HTML into RSS. Neither removes platform access requirements. AI Radar already owns fetching, normalization, checkpoints, and reporting, so deploying another aggregator would duplicate these responsibilities without solving the observed blockers. No comparative adoption statistics were collected.

## Reddit: usable now, announced retirement

Reddit's [official infrastructure announcement](https://www.reddit.com/r/modnews/comments/1wubgvt/continuing_our_infrastructure_updates_whats/) says RSS support ends **November 13, 2026**, and explicitly states there is no replacement for feeds outside communities the user moderates. The [official developer migration announcement](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/) says unregistered/unresponsive apps begin losing public API access January 12, 2027 and remaining public API access ends March 2027. Do not describe RSS or a newly added OAuth collector as a permanent solution.

Live probes (ordinary GET; `User-Agent: AI-Radar-source-research/1.0`):

| Endpoint | Observed result |
| --- | --- |
| `https://www.reddit.com/r/ClaudeAI/top/.rss?t=day&limit=5` | HTTP 200, valid Atom with October 5–6 posts; a subsequent request received 429 |
| `https://www.reddit.com/r/codex/top/.rss?t=day&limit=5` | HTTP 429; not retried |
| `https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=5` | HTTP 403; no bypass attempted |
| `https://www.reddit.com/r/ClaudeCode+codex+LocalLLaMA+MachineLearning/top/.rss?t=day&limit=20` | HTTP 200, 20 real Atom entries |

The combined feed includes `author`, subreddit `category`, `content`, `id`, original discussion `link`, `updated`, `published`, and `title`; sampled entries have no numeric score/comment-count fields. Example: ID `t3_1wy76fh`, category `ClaudeCode`, published `2026-10-05T12:23:46+00:00`, [original discussion](https://www.reddit.com/r/ClaudeCode/comments/1wy76fh/why_wait_to_be_replaced_when_i_can_replace_myself/). These are real posts, but popularity does not establish practical value: sampled top results include memes and complaints. Preserve source selection as “Reddit daily top”; do not manufacture vote counts or endorsements. Apply the existing practical-value selection after collection.

One combined request is preferable to several simultaneous subreddit requests, given observed 429 responses. Larger communities can dominate combined rankings, so this is not a per-subreddit quota guarantee. Respect response limits and failures; do not alternate hosts or proxies to evade a block. A configured temporary feed should make its retirement date visible.

For numeric popularity/comments, the [official Data API wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) requires OAuth. [Listing API documentation](https://www.reddit.com/dev/api/) describes top/time filters and cursor pagination. Existing OAuth approval and post-retirement availability were not verified. Upvote RSS's older app-registration instructions must not override Reddit's newer migration announcement.

## Threads: official API available, target access not verified

Meta's [official Postman public-profile-posts request](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api?entity=request-34203612-74fb48b1-ad1a-480e-b200-4dcdb8126a2f) documents OAuth-authenticated `GET https://graph.threads.net/profile_posts?username=threads&fields=...` with an exact username. Use `choi.openai` for this target. Meta's collection describes creating a Threads-use-case Meta app, user authorization, token exchange and token refresh. It also documents `profile_lookup` for exact public profile lookup. These are distinct from the authenticated user's `/me/threads` endpoint.

The permission to investigate is `threads_profile_discovery` alongside `threads_basic`. Meta's [published collection scope list](https://www.postman.com/meta/threads/request/k46c8l0/get-app-scoped-user-s-profile-information) includes this permission; [RestFB's upstream permission implementation documentation](https://restfb.com/javadoc/com/restfb/scope/FacebookPermissions.html) identifies public profiles and their public posts as its capability. Meta developer documentation pages could not be retrieved here. Therefore **UNVERIFIED EXTERNAL CONSTRAINT**: confirm exact required scopes, app-review/access level, target eligibility, rate limits and returned media fields in Meta's current dashboard/docs, then perform one authorized target read. Do not assert that merely creating a token guarantees access.

Minimum setup/verification: create or select the user's Meta app with Threads use case; authorize an account using the required granted permissions; store a user access token through runtime configuration; call `profile_posts` for `choi.openai`; verify IDs, text, timestamps, permalinks and pagination before enabling automatic collection. Use the API's real timestamp and permalink. Public-post numeric engagement fields have not been verified; leave absent metrics empty. Token expiry/refresh needs an explicit operational path for unattended daily use.

Implementation reference: [Meta's exact public-profile request](https://www.postman.com/meta/threads/request/34203612-116161fc-75af-4a09-a972-66d6f64ddb10) documents `username` and `fields` but provides **no sample response**. Start with `GET https://graph.threads.net/profile_posts?username=choi.openai&fields=id,text,timestamp,permalink,username,media_type`. These media field names appear in [Meta's media-list collection variables](https://www.postman.com/meta/threads/request/ozyoo16/get-a-list-of-all-a-user-s-threads). Related list examples use a `data` array and `paging.cursors.after`; do not claim a captured successful target payload. A bounded parser can accept these shapes and mark remaining pagination as partial, but target paging parameters remain part of authorized verification. The collection declares OAuth 2.0 and token exchange returns `token_type: bearer`; exact `Authorization: Bearer` acceptance for this endpoint has not been independently exercised. Keep tokens out of logged URLs and never follow an arbitrary returned paging URL with credentials.

Public-path probes:

- `https://www.threads.com/@choi.openai` returned HTTP 200 and approximately 610 KB of HTML. Across 32 JSON script blocks there were **zero** `thread_items`, **zero** `taken_at`, and no extracted post objects. Profile metadata exists, but it is not post evidence. No `bio_links` or `external_url` was exposed; no author-linked RSS/blog was established.
- [RSSHub extraction code](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/threads/utils.ts) looks for `script[data-sjs]` containing `thread_items`; its route throws when none exists. The observed HTML therefore does not support this method for the requested account.
- `https://rsshub.app/threads/choi.openai` returned HTTP 403. No public RSSHub feed was validated. Do not install RSSHub and claim Threads collection is fixed on the strength of route existence alone.

## Official releases and useful repositories

Both first-party repository feeds returned HTTP 200 and valid Atom:

- [Claude Code releases](https://github.com/anthropics/claude-code/releases.atom): `v2.1.291`, updated `2026-10-06T03:55:19Z`; `v2.1.290`, updated `2026-10-05T23:33:17Z`.
- [Codex releases](https://github.com/openai/codex/releases.atom): latest observed entries included `0.161.0-alpha.13.1` and `0.162.0-alpha.16`. Keep prerelease status explicit and avoid flooding a practical daily digest with every alpha patch. Atom `updated` does not independently establish original release publication time; GitHub release API can verify `published_at` when the distinction matters.

For useful repository discovery, preserve GitHub project links found in HN/Reddit/release content and evaluate upstream README/release evidence. A repo's latest commit or star total alone does not prove it launched today, is trending today, or is useful. A new GitHub-wide popularity crawler was not validated in this research.

## Existing seams to reuse

- `src/adapters/sources/rss/feed.ts` already parses Atom IDs, categories, authors, content and dates.
- `rss-source.ts` already applies collection windows, dedupe/checkpoints and HTTP failure handling; `normalize.ts` retains original/embedded links and does not invent engagement metrics.
- `src/adapters/sources/hackernews/` demonstrates the existing `SourceAdapter` API collection seam, bounded requests and honest partial coverage.
- A Threads API adapter should use this source seam with credentials passed from runtime configuration, without adding a second scheduler or renderer. Existing Discord messages remain untouched; this research authorizes no publishing changes.
