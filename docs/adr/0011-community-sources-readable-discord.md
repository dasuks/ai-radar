# ADR-0011: Community discovery and readable Discord editions

Date: 2026-10-06. User request: add missing Reddit/Threads coverage and improve tomorrow's posts; leave all already published messages unchanged.

## Evidence and reuse

The repository already has SourceAdapter, RSS/Atom parsing, conditional requests, date filtering, checkpoints, source-failure coverage, document URL extraction, claims/evidence stores, and a Discord renderer. Reuse these rather than introduce a second crawler or editorial pipeline. GitHub official release Atom feeds for openai/codex, anthropics/claude-code, vercel/ai and openai/openai-agents-python returned HTTP 200 with dated entries in a local probe on October 6. Public Reddit top/day Atom returned usable content in the research probe; RSS cannot establish numerical votes. Threads public profile HTML returned no posts. Official API constraints and OSS alternatives are recorded in ../research/2026-10-06-community-collection.md.

Common practice is native feeds first, then a source-specific API adapter for platforms without a usable feed. RSSHub is useful when its route actually receives data; observed Threads HTML does not satisfy its parser. Do not deploy a new RSS service or scrape authenticated browser internals for this change. A small official Threads API adapter is justified because it fits the existing port without introducing another service and can report missing authorization truthfully.

## Root causes

1. config/sources.json contains only five broad feeds; desired coding releases and community discovery were never registered.
2. Discord treats every post as a form with mandatory example, warning, evidence label and repeated summary/detail. This creates filler and hides the actionable change.
3. Discord sees only brief prose, losing original evidence, qualification and resource links that already exist in storage. Adding feed names alone does not fix this loss.

## Decision

- Add native official release feeds and one combined Reddit top/day feed (ClaudeCode, codex, LocalLLaMA, MachineLearning; source failures explicit). No made-up vote totals; top listing is discovery, not quality proof. No meme/general complaint unless a concrete reproducible workflow or impact is supported. Reddit officially retires RSS on November 13, 2026; the user explicitly accepted this temporary connection after disclosure. No unsupported promise of a replacement; reassess before retirement.
- Add official Threads profile collection for choi.openai with a constructor-injected token read only by runtime/config. Missing token or insufficient permissions produce an explicit source failure. Do not call an empty fetch successful. No token logging, credentials in checkpoints, paid service purchases, browser cookie extraction, or access-block bypass.
- Preserve platform timestamps; discovered today is not released today. Do not relabel old tools as launches. Surface reusable engineering methods/skills with concrete mechanics, source links, and material prerequisites.
- Use existing document/evidence/claim stores to enrich Discord candidate input with evidence and public resource URLs. Exclude personal application fields and unauthenticated invented resources. Official claims and user reports must remain distinguishable. Only supplied links may appear in output; retain original article/post links, choose relevant extra docs/repo links without dropping the whole story for having many links.
- Introduce Discord body v2, preserving v1 reads. A useful specific title, concise lead, and explanation that adds new information are required. Optional example and caveat are nullable, rendered only when useful. No forced generic warnings. User clarified the main problem is unfamiliar terminology and stiff wording: prioritize natural explanation, not merely shortening. Explain unfamiliar technology by what it does, keeping useful engineering detail. Source attribution remains compact and linked. Summary 00 still includes every delivered item, never top-N.
- Editorial cache key includes prompt/editorial version and enriched evidence input, not just prior brief hash. Record Discord LLM usage in the Run.
- No live publication during this work. Preview locally with real generation and reviewed fixtures. Existing messages are untouched. The next scheduled run applies the new code on October 7. Threads live activation remains honestly blocked until valid API authorization exists.

## Acceptance and rollback

Typecheck and full tests pass; feed fixtures preserve dates/source URLs; source failure never looks empty-success; v1 remains readable; v2 rejects invented links and unsupported IDs; example/caveat optional; renderer <=2000 characters and all-item summary invariant retained; preview contains no private environment framing. Inspect a real generated preview before completion. Disable added source entries or restore prior renderer/prompt to roll back; never delete journal or republish historical editions.
