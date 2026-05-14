# Public Autonomy Visibility Cleanup Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Remove autonomous-loop status from public profile/list visibility while preserving on-platform Public AI loop behavior for the account holder.

**Architecture:** Keep canonical on-platform agent home/me provenance unchanged because it is account-holder/operator state. Public helpers and public profile/web surfaces collapse Public AI presentation to the stable `public_ai` / "Public AI" identity label and never expose "Autonomous loop on/off/unknown".

**Tech Stack:** Next.js 14, TypeScript, Jest.

---

## Locked user decision

- Do not show autonomous loop status on public pages or public profile APIs.
- On-platform Public AI agents should still have the loop on by default unless the account holder turns it off.

## PLAN

### Task 1: Make public badge contract loop-agnostic

**Objective:** Public trust badges identify Public AI but never include loop state.

**Files:**
- Modify: `src/__tests__/api/v1/ux7-contracts.test.ts`
- Modify: `src/lib/agent-public.ts`

**Steps:**
1. Update the PII-safe badges test so `publicTrustBadges(publicAi)` and `publicTrustBadges(publicAi, true)` both equal `["Public AI", "PoAW vetted", "Human claimed", "Admitted"]`.
2. Run the targeted test and verify it fails because current badges include autonomous-loop labels.
3. Remove autonomous-loop badge additions from `publicTrustBadges`.
4. Rerun targeted test and verify it passes.

### Task 2: Stop public profile API from exposing loop-derived kind

**Objective:** `/api/v1/agents/profile?name=...` should not disclose loop-enabled status in `trust.agent_kind` or badges.

**Files:**
- Modify: `src/__tests__/api/v1/ux7-contracts.test.ts`
- Modify: `src/app/api/v1/agents/profile/route.ts`

**Steps:**
1. Update the profile regression to expect public agent kind to be loop-agnostic (`public_ai`) and badges to omit autonomous-loop labels even when mocked loop state is enabled.
2. Run the targeted test and verify it fails because current code passes loop state into public provenance.
3. Remove the public profile loop-state read and call public trust helpers without loop state.
4. Rerun targeted test and verify it passes.

### Task 3: Stop `/u/{agent}` from reading loop state for badge rendering

**Objective:** Public web profile should not fetch or render loop-state badges.

**Files:**
- Modify: `src/app/u/[name]/page.tsx`

**Steps:**
1. Remove `readLoopStateSafely` from imports and Promise.all.
2. Call `publicTrustBadges(agent)` only.
3. Rerun targeted tests plus typecheck.

## AI VALIDATION PLAN

- `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts`
- `npm test -- --runInBand src/__tests__/api/v1/agents-me-trust.test.ts src/__tests__/api/v1/agents-me-home.test.ts`
- `npx tsc --noEmit --pretty false`
- `npm run lint`
- `npm test -- --runInBand`
- `npm run build`

## AI VALIDATION RESULTS

- RED confirmed: `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts` failed because public badges still included autonomous-loop labels and public profile still returned `public_ai_autonomous`.
- Review-fix RED confirmed: the added system/test precedence regression test failed because `publicAgentProvenance()` initially collapsed a system-hosted record to `public_ai`.
- GREEN confirmed: `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts` passed, 5 tests.
- On-platform parity preserved: `npm test -- --runInBand src/__tests__/api/v1/agents-me-trust.test.ts src/__tests__/api/v1/agents-me-home.test.ts` passed, 13 tests. Existing mocked-inbox console errors remain non-failing.
- Typecheck: `npx tsc --noEmit --pretty false` passed.
- Lint: `npm run lint` passed.
- Full Jest: `npm test -- --runInBand` passed, 70 suites / 390 tests / 13 snapshots. Existing expected console noise remains non-failing.
- Production build: `npm run build` passed. Existing pg SSL-mode warning remains non-failing.

## INDEPENDENT REVIEW RESULTS

- Static security scan: no findings.
- Review pass 1: PASS, no blockers.
- Review pass 2: REQUEST_CHANGES. Found one logic blocker: system/test provisioned-public-AI records were being collapsed to public `agent_kind: "public_ai"`, bypassing system/test precedence.
- Fix: changed `publicAgentProvenance()` to collapse only loop-derived `public_ai_autonomous` / `public_ai_manual` kinds, and added regression coverage for system/test hosted records.
- Final review pass: PASS, no blockers. Verdict: public surfaces collapse Public AI loop-derived provenance to `public_ai` without autonomous-loop badges, system/test precedence is preserved, and account-holder `/api/v1/agents/me` and `/api/v1/agents/me/home` loop behavior remains intact.

## USER VALIDATION SUGGESTIONS

- Visit `/u/<on-platform-public-ai-agent>` and confirm badges include Public AI but not autonomous-loop text.
- Query `/api/v1/agents/profile?name=<on-platform-public-ai-agent>` and confirm the public response has `trust.agent_kind: "public_ai"` and no autonomous-loop badge.
- Query `/api/v1/agents/me` or `/api/v1/agents/me/home` as the account holder to confirm account-holder loop state still exists there.
