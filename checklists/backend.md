---
domain: backend
---

# Backend checklist

APIs, data and runtime behaviour. Security lines live in `security.md`.

## API design and contracts
- [ ] correct HTTP status codes (400/401/403/404/409/422/500) — never `200 {error}`
- [ ] one consistent error envelope across the whole API
- [ ] versioning (/v1 or header) so the API can evolve without breaking clients
- [ ] backward compatible — add fields freely, deprecate before removing or renaming
- [ ] (*) idempotency keys on POSTs that must not double-execute (payments, orders)
- [ ] pagination/filter/sort conventions consistent — never return an unbounded list
- [ ] typed contract (OpenAPI or shared types) so clients cannot drift

## Reliability
- [ ] (*) no unhandled rejections or crashes — return a sane response, never a stack trace or a dead process
- [ ] (*) timeout on every network call
- [ ] (*) concurrency and race conditions guarded with transactions, atomic ops or locks
- [ ] retries with backoff and jitter on flaky externals; the operation must be idempotent
- [ ] circuit breakers or fallbacks — a down dependency fails fast instead of dragging the system down
- [ ] graceful degradation — the core path survives when a non-critical dependency is down
- [ ] backups exist AND a restore has been tested; RTO and RPO are known

## Database and migrations
- [ ] (*) indexes on every column filtered, sorted or joined on — verify with EXPLAIN
- [ ] (*) kill N+1 — never query inside a loop; batch, join, or bulk-write
- [ ] pagination at the DB, never load an unbounded set into memory
- [ ] foreign keys with deliberate on-delete rules, no bare text ids
- [ ] transactions for multi-step writes that must all-succeed-or-all-fail
- [ ] migrations versioned and reversible in source control, never hand-edited in prod
- [ ] zero-downtime migrations (expand -> backfill -> switch -> contract)
- [ ] (*) connection pooling sized sanely — never a connection per request at scale

## Performance
- [ ] (*) no heavy or blocking work on the request path — offload to background jobs or queues
- [ ] cache expensive reads WITH a real invalidation story
- [ ] cache stampede guard — single-flight or jittered TTLs
- [ ] no `SELECT *`, no over-fetching, no serial round trips that could be one query

## Observability
- [ ] (*) structured (JSON) logs with enough context to debug, and no secrets or PII
- [ ] (*) correlation/request id threaded through every log line of a request
- [ ] monitoring and alerting — you learn it broke from a metric, not an angry user
- [ ] health checks and graceful shutdown — reports liveness, drains in-flight work on deploy

## Cost
- [ ] (*) budget alerts on every paid platform (cloud, AI APIs, SaaS)
- [ ] (*) cap unbounded paid calls (LLM-per-row, unthrottled webhook, retry storm)
- [ ] no zombie resources — idle instances, orphaned buckets, forgotten subscriptions
