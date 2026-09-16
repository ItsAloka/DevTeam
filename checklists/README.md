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

Domain names come from DevTeam's domain vocabulary (`web`, `backend`, `mobile`, `desktop`, `game`,
`ml`, `data`, `devops`, `docs`, `embedded`, `security`, plus any you add). A domain with no file
here is not offered when you create a task — an empty list buys nothing.

To add a domain: create `<name>.md` here and register the name with DevTeam
(`devteam domain add <name>`).

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
