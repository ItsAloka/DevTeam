---
domain: web
---

# Web checklist

Frontend and delivery. Security lines live in `security.md`, which is pulled into every task.

## UI states (every screen, every async view)
- [ ] (*) initial / skeleton state — what shows before data arrives (no blank box, no layout jump)
- [ ] (*) loading / pending state — disable the trigger and show progress so nothing double-fires
- [ ] (*) success / populated state — the real content
- [ ] (*) empty state — DISTINCT from loading and error; a failed fetch must not look like "no results"
- [ ] (*) error / failure state — real message plus a way out (retry, go home), never a blank page or raw 500
- [ ] offline / not-found / unauthorized states handled (404, sign-in prompt, offline hint)
- [ ] walked every route and ticked loading/success/empty/error/edge on each

## Performance
- [ ] (*) responses compressed (gzip/brotli) — confirm it is actually on
- [ ] small bundles, code-split and lazy-loaded, no render-blocking waterfalls
- [ ] modern image formats, explicit dimensions, no layout shift
- [ ] no over-fetching — return only the fields the view needs
- [ ] optimistic UI on user actions, with rollback on failure
- [ ] measure before optimizing — profile; the slow thing is rarely where you think

## Accessibility
- [ ] semantic HTML, headings in order
- [ ] keyboard navigable, visible focus, no trap
- [ ] alt text on meaningful images, empty alt on decorative ones
- [ ] contrast meets AA
- [ ] ARIA only where semantics fall short, never as decoration
- [ ] forms: label every input, associate errors with their field

## Client behaviour
- [ ] timeout on every network call
- [ ] retries with backoff on flaky calls; the operation must be idempotent
- [ ] graceful degradation — the core path survives when a non-critical dependency is down
- [ ] no secrets, keys or tokens in client-side code or the bundle
- [ ] responsive down to ~375px; no horizontal scroll
- [ ] dark and light both render correctly if the app has themes
