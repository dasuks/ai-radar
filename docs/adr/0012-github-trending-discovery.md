# ADR-0012: GitHub Trending discovery with README evidence

2026-10-06 — accepted by user request “깃허브만 ㄱㄱ”. Threads authorization is outside this change.

Reuse the Phase 2/3 SourceAdapter seam, relevance policy, collection checkpoints, evidence extraction, ranking and Discord delivery. No new scheduler, publisher, metric engine or global ranking table. Existing messages remain unchanged; the midnight task picks up the source automatically.

Upstream practice: [trending-collection](https://github.com/hanishrao/trending-collection) scrapes GitHub Trending by period and offers RSS/JSON. Both daily/all.json and weekly/all.json returned fresh snapshots in local probes. Its weekly title incorrectly says Daily, so period comes from the requested endpoint, never that title. Use its JSON as a discovery mirror, then GitHub's public README endpoint as primary feature evidence. RSS alone lacks README evidence and would create separate daily/weekly documents for the same repository. This is why a small source adapter is appropriate instead of a second RSS parser or scraper service.

One source merges daily/weekly by repository name, reads bounded README excerpts, and injects the existing AI relevance policy. Unknown publication dates remain null. Snapshot date/rank is explicitly discovery context, never release date or evidence of quality. No exact GitHub-wide ranking or star-growth measurement is claimed. Source metrics remain empty.

Only fixed upstream and GitHub API hosts are fetched; repository names are validated. No repository code is installed/executed. README content enters the existing untrusted evidence boundary. Checkpoints suppress unchanged description/README even when ranks or snapshot dates change. Changed README is a new candidate, not automatic publication. A 48-hour snapshot freshness guard, HTTP errors, malformed items, deadlines, read limits and partial failures remain visible. README failures produce no unsupported item.

Limits: mirror availability is third-party dependent; only listed repositories are covered, and keyword relevance can miss or over-include projects. README excerpts are at most 16,000 characters; up to 40 README requests and 25 emitted documents per run. GitHub unauthenticated rate limits can yield partial coverage. First scheduled production delivery remains unverified until it runs. Disable githubTrending in config/sources.json to roll back.

Validation: fixture tests at SourceAdapter boundary, real read-only collection/normalization, typecheck and full suite. No Discord/Notion/Vault publication during verification.

Verified on 2026-10-06: live probe merged 29 repositories and normalized 25 README-backed candidates; PARTIAL correctly reported the item cap, with no HTTP/parse errors. Typecheck and all 279 tests passed. Read-only cross-review identified a mirror rate-limit incorrectly blocking the healthy period; fixed by separating mirror and README rate-budget stopping, with regression fixtures for either period returning 403/429/500. The full suite passed again. Existing 00:00 KST task's next run was verified as October 7. No publication commands were run.
