# Checklists

One file per domain. **You write these. DevTeam only reads them.**

When a task declares a domain, every verifying role on that task (Reviewer, Security Reviewer,
Tester) is handed the matching file's path, plus its critical lines inlined in the brief, and is
told to walk the sections the change actually touches before giving a verdict.

Add a line whenever you learn something the hard way. That is the whole maintenance story.

## Files

| File | Feeds |
|---|---|
| `web.md` | tasks tagged `web` |
| `backend.md` | tasks tagged `backend` |
| `mobile.md` | tasks tagged `mobile` |
| `desktop.md` | tasks tagged `desktop` |
| `ml.md` | tasks tagged `ml` |
| `security.md` | **every** task — pulled in regardless of domain |

The task dialog offers DevTeam's built-in names (`web`, `backend`, `mobile`, `desktop`, `game`,
`ml`, `data`, `devops`, `docs`, `embedded`, `security`) plus every file in this directory, and shows
each one's item count. A built-in with no file here is dimmed and shows `—`: you can still tag work
with it, but reviewers get nothing extra until you write the list.

**To add a domain, create `<name>.md` here.** That is the whole step — the file *is* the
registration, and the name appears in the task dialog on the next load. There is no "add domain"
button, because a registered name with no file promises the team a check that cannot happen.

Names must be lowercase slugs (`ar-vr`, `blockchain`). A file named after a synonym of a built-in
(`frontend.md`, `api.md`, `ai.md`) is ignored — two names for one domain split your lessons across
two lists and starve both; add the lines to `web.md`, `backend.md` or `ml.md` instead. `README.md`
is this file, not a domain.

Deleting a file removes the domain from the picker. Tasks already tagged with it keep the tag and
stay editable; they simply get no checklist.

## Format

```markdown
---
domain: web
applies_to: [reviewer, security-reviewer]
---

## Security & auth
- [ ] (*) input validation on every value from user/url/header/external api
- [ ] injection blocked -> parameterised queries only, never string-built SQL
- [-] MFA / OTP (not applicable to this project)
```

- **Frontmatter** is optional. `applies_to` limits the file to those roles; omit it and the file
  feeds any role that asks. `domain` defaults to the filename.
- `## Heading` starts a section. Reviewers are asked to name which sections they walked, so keep
  section names meaningful — they are how you audit whether a review was real.
- `- [ ] text` is one item. One line = one thing to check.
- `(*)` right after the checkbox marks the item **critical**. Only critical items are inlined into
  the brief; the rest live in the file for the reviewer to read. Missing a critical one should mean
  a breach, a bill, or an outage — keep that bar high or the brief fills with noise.
- `- [-] text` is an item you have ruled out. Parsed and then ignored.
- `- [x] text` reads the same as `- [ ]`. The boxes are for you; DevTeam does not tick them.
- Items are capped at 220 characters. Write one imperative line, not a paragraph.

## Keeping them honest

These are long on purpose. The point is not that a reviewer reads 150 lines every time — it is that
when a change touches uploads, or auth, or money, the relevant twenty lines are one file away and
already written down. Walk only the sections your change actually touches.
