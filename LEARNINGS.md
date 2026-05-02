# Learnings

`LEARNINGS.md` is for durable engineering wisdom that should survive refactors and apply across the platform. Use the **scope ladder** when deciding where a new insight should live:
- **Repo-wide and durable** (works across apps/repos): put it in `LEARNINGS.md`.
- **App-specific architecture/policy** (states, flows, contracts, UX rules): put it in app architecture notes (for example `ai/ARCHITECTURE.md`).
- **Symbol-local contract** (one module/function/type behavior): put it in code docblocks near the symbol.
- **Naming/API smell** (callers keep misusing it): prefer renaming/re-shaping the API over adding prose.
- Quick test: if it remains true after renaming modules and shipping new features, it is likely `LEARNINGS.md`; if it depends on current product behavior, it belongs in architecture docs.

## Durable Patterns

- Lazy per-user provisioning should use a request-scoped cache around the public entry point, as in `ensureProvisionedPublicAiAgentForRequest`. That keeps repeated React Server Component reads idempotent within a render without hiding the underlying side effect.
- Serverless background work needs durable claim records when duplicate side effects matter. In-process sets only dedupe within one warm process. The portable SQL idiom is `INSERT ... ON CONFLICT DO NOTHING RETURNING 1`: exactly one caller sees a non-empty return, does the work, and releases the claim in a `finally`.
- Public facades should describe the supported product surface, not every legacy storage concern. When preserving old data paths, keep their types and functions private to implementation modules until they are either reintroduced as a real contract or deleted.
- Migration runners should record successfully applied filenames in a database table and skip from that table on later runs. Idempotent SQL is still useful for first adoption on existing databases, but the durable invariant should be explicit state, not repeated error-message matching.
- When a nullable value changes SQL shape, prefer separate query branches over `${maybeNull} IS NULL` parameter tricks. Postgres/Neon can fail to infer the type of a null placeholder before it knows the surrounding expression.
- Verify framework rendering assumptions with the real production build. A page marked for revalidation can still be forced dynamic if its data client performs no-store work during prerender, as Neon serverless SQL does.
- Restoring a disabled quality gate is useful even when inherited baseline debt requires temporary rule disables. Keep the command honest (`next lint`, not `echo`), push temporary debt into visible rule-level disables, and narrow those disables by file or rule as cleanup progresses.
- Measure hot paths with `Server-Timing` or route smoke numbers before and after cache changes. Without timing headers and repeated route samples, performance work drifts into folklore.
- Validate CDN-facing HTTP contracts on the real hosting edge, not only the local production server. Cache normalization, platform auth cookies, redirect aliases, and hop-by-hop header handling can all differ from `next start`.
- When a denormalized table becomes the user-visible read model, write that projection in the awaited entity-write path. Fire-and-forget is for optional observational side effects, not for data the UI now depends on.
- When two product paths execute the same platform action surface, share a provider-agnostic runtime and inject provider calls at the edge. Tool execution, allowlists, and action logging are platform invariants; OpenAI, Anthropic, and router message dialects are adapters.
- Keep cache keys aligned with every semantic input. If a cached function varies by argument, route, school, user, or sort order, that value must appear in the cache key or the cache will serve valid-looking wrong data.
- Do not pair an indexed hot-path predicate with a non-indexable `OR` fallback unless you have measured the plan. Prefer separate query branches or one deliberate search strategy so the intended index remains usable.
- Full-text search plus recency ordering needs its own measured query shape. If Postgres can satisfy `ORDER BY occurred_at DESC LIMIT n` with a recency index, it may scan that index and evaluate sparse text matches row by row instead of using the GIN predicate. A materialized search candidate CTE can make the invariant explicit: filter by the text index first, then sort the smaller match set.
- When a derived projection cites a primary entity, use the same `(entity_kind, entity_id)` tuple everywhere that entity is referenced. Context caches, backfills, and API cursors become simpler when they do not translate between synthetic projection IDs and source entity IDs.

## Patterns To Reuse

- **Per-user lazy provisioning with request-level dedupe.** When you need a per-user resource that gets created on first touch and reused for the rest of the request, use the pattern in `src/lib/provision-public-ai-agent.ts:ensureProvisionedPublicAiAgentForRequest`. It wraps provisioning in React's `cache()` so multiple components in one render share the same Promise, then idempotently upserts in the database to handle concurrent first-touches across requests. Do not invent a new pattern; do not roll your own per-request memo. If the file moves or the API changes, update this entry.
