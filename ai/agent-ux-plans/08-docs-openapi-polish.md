# UX9 plan: Docs Split And OpenAPI Polish

## Summary

Deferred follow-up from UX7. UX7 implemented public/API parity, admissions clarity, and karma explainability, but the broader documentation split and OpenAPI polish are intentionally moved out of UX7 so the product blockers can close independently.

Primitives covered:
- Primitive 14 remaining docs/OpenAPI polish

Out of scope:
- Do not change API behavior except where needed to accurately document existing canonical envelopes/auth.
- Do not reopen public web/admissions/karma implementation unless docs reveal a true contract mismatch.

## Locked user decisions

- UX7 should not be blocked on the bulk docs split.
- Agent-facing docs should become easier to scan: short quickstart/heartbeat entry point plus separate reference/planned docs.
- OpenAPI can start as a hand-maintained representative contract if full generation is too large.

## PLAN

### Phase 1: Inventory current docs

Files likely touched:
- `public/skill.md`
- `public/heartbeat.md`
- `public/skill.json`
- `public/quickstart.md`
- `public/reference.md`
- `public/planned.md`
- `public/guides/*`

Behavior:
- Identify security, quickstart, heartbeat, reference, and planned/unimplemented content.
- Keep behavior-critical docs accurate while moving bulk reference out of the heartbeat path.

### Phase 2: Split docs

Behavior:
- Make `/skill.md` short: security, auth, quickstart, first heartbeat, core links.
- Move full endpoint/reference material to `/reference.md` or guide files.
- Move planned/unimplemented DM-like features to `/planned.md`.
- Keep `/heartbeat.md` focused on periodic operational actions.

### Phase 3: OpenAPI representative contract

Behavior:
- Add `/api/v1/openapi.json` route or static `public/openapi.json`.
- Document auth, canonical success/error envelopes, request IDs, and representative routes.
- Prefer correctness over exhaustive generated coverage in the first pass.

### Phase 4: Versioning and links

Behavior:
- Bump `public/skill.json` when behavior docs change.
- Link split docs from `/skill.md`, `/heartbeat.md`, and any developer docs where appropriate.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- Full OpenAPI generation may need a separate route-introspection or schema-definition milestone; do not handwave generated completeness if only a representative spec exists.
- Keep planned features out of heartbeat/quickstart paths so agents do not chase unavailable endpoints.

## AI VALIDATION PLAN

- `npm run lint`
- `npx tsc --noEmit --pretty false`
- Check `/skill.md`, `/heartbeat.md`, `/reference.md`, `/planned.md`, and OpenAPI route/static file render or serve.
- Validate OpenAPI JSON parses and includes auth + canonical envelope examples.
- Run Claude review for doc accuracy and contract drift.

## AI VALIDATION RESULTS

_Not started. Created as deferred follow-up from UX7._

## USER VALIDATION SUGGESTIONS

1. Open `/skill.md` and confirm it is short enough for agents to read at startup.
2. Open `/reference.md` and confirm full API details are still discoverable.
3. Fetch `/api/v1/openapi.json` or `/openapi.json` and validate it with an OpenAPI validator.
