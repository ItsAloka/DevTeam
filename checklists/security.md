---
domain: security
applies_to: [reviewer, security-reviewer]
---

# Security checklist

Pulled into every task regardless of domain. `(*)` = missing it is a breach.

## The ones that bite first
- [ ] (*) no session/access token in localStorage -> httpOnly + Secure + SameSite cookie
- [ ] (*) every permission enforced server-side (hiding a button is not security)
- [ ] (*) storage buckets private -> no public guessable links, use signed/expiring or auth-gated URLs
- [ ] (*) rate limit on every auth, write and expensive endpoint
- [ ] (*) password strength policy + login throttling (block "1234")

## Input and injection
- [ ] (*) input validation on every value from user/url/header/external API — schema-validate, reject, do not coerce
- [ ] (*) injection blocked -> parameterised queries only, never string-built SQL
- [ ] (*) XSS blocked -> output-encode/sanitize all rendered user content, sanitize stored HTML at write
- [ ] mass-assignment guard -> whitelist updatable fields, never spread req.body into a DB row
- [ ] SSRF -> block internal IPs and metadata endpoints if the server fetches a user-supplied URL
- [ ] open-redirect / OAuth callback validated against an allowlist

## AuthN and authZ
- [ ] (*) authN + authZ on every protected route — is it them, AND are they allowed THIS object
- [ ] (*) IDOR blocked -> every query scoped to the current user/tenant; A cannot fetch B's row by id
- [ ] sessions -> short-lived access token, rotating refresh, revoke on logout, reuse detection
- [ ] passwords hashed with bcrypt/argon2 — never MD5/SHA fast hashes, never plaintext
- [ ] MFA / OTP available for sensitive accounts
- [ ] account-enumeration safe -> login/forgot/signup give identical response and timing
- [ ] CSRF -> SameSite cookies or anti-CSRF token on state-changing requests

## Secrets, transport and headers
- [ ] (*) secrets never hardcoded or committed -> env/secret store, scan repo + git history, gitleaks in CI
- [ ] (*) HTTPS/TLS everywhere, no mixed content, auto-renewing certs
- [ ] CORS locked to known origins — never `*` with credentials
- [ ] security headers -> CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- [ ] webhook signatures verified (HMAC on inbound webhooks)

## Uploads, deps and abuse
- [ ] file-upload safety -> validate real type, size and dimensions; re-encode images; store in a private bucket
- [ ] dependencies -> audit clean, lockfile committed, Dependabot/Renovate, least-privilege CI tokens
- [ ] bot/abuse -> CAPTCHA on signup and UGC, throttle per-user AND per-IP
- [ ] (*) no unhandled rejection leaks a stack trace or internals to the caller

## Data and privacy
- [ ] PII minimisation -> collect the least, encrypt sensitive fields at rest
- [ ] (*) real deletion path -> a user can actually be deleted (cascade or anonymise)
- [ ] retention policy -> data has a lifespan
- [ ] (*) structured logs carry NO secrets or PII (redact)
- [ ] audit trail -> auth/admin/money/data-change actions logged who-what-when, tamper-evident
- [ ] regulatory -> know whether GDPR or HIPAA applies before storing
