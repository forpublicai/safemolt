# CRAP baseline — 2026-07-24

CRAP (Change Risk Anti-Patterns) combines cyclomatic complexity with test coverage:
`CRAP(m) = cc(m)^2 * (1 - cov(m))^3 + cc(m)`. A method is only "cheap to change" if it is
either simple or well covered. Tooling: [`@barney-media/crap-typescript`](https://www.npmjs.com/package/@barney-media/crap-typescript)
(Apache-2.0) over Istanbul/Jest coverage.

## Commands

```bash
npm run quality:crap
```

`npm run quality:crap:report` regenerates the machine-readable `ai/validation/crap-report.json`.
Both exclude the nested `packages/` workspace (its own Jest run fails in this repo's harness).

## Reporting gate, not a merge blocker

Per the setup decision: report CRAP, don't fail CI on it yet. The immediate stable guard is
ESLint's built-in `complexity` rule at **max 12**, wired as a **warning** in `.eslintrc.json`
so `npm run lint` surfaces new offenders without blocking. Choose a CRAP threshold after a
few milestones of baseline movement.

## Baseline numbers

| Metric | Value |
|---|---|
| Methods analyzed | 1901 |
| Above default threshold (CRAP > 8) | 851 (44.8%) |
| Of those, **0% covered** | 730 |
| ESLint `complexity` > 12 warnings | 100 |
| Worst complexity (single function) | 52 — `lib/activity.ts:220 buildActivityFromFeedItem` |

The dominant driver is coverage, not complexity: 730 of 851 failures are uncovered code where
CRAP degenerates to `cc² + cc`. Adding a test to a cc=30 route drops it from 930 to ~30.

## Top 15 offenders

| CRAP | cc | cov | Location |
|---|---|---|---|
| 1056 | 32 | 0% | `app/api/v1/agents/me/route.ts:81` PATCH |
| 930 | 30 | 0% | `app/api/dashboard/admissions/staff/application/route.ts:31` POST |
| 930 | 30 | 0% | `app/api/v1/groups/route.ts:77` POST |
| 870 | 29 | 0% | `lib/admissions/index.ts:169` getAdmissionsStatusForAgent |
| 870 | 29 | 0% | `lib/playground/llm.ts:33` chatCompletionHfRouter |
| 812 | 28 | 0% | `app/api/v1/groups/[name]/settings/route.ts:6` PATCH |
| 756 | 27 | 0% | `app/classes/[id]/ClassDetailClient.tsx:41` ClassDetailClient |
| 702 | 26 | 0% | `lib/playground/session-manager.ts:656` getActiveSession |
| 600 | 24 | 0% | `app/api/v1/agents/register/route.ts:8` POST |
| 600 | 24 | 0% | `lib/evaluations/loader.ts:18` loadEvaluations |
| 600 | 24 | 0% | `lib/memory/providers/chroma-provider.ts:148` listAgentRecords |
| 592 | 52 | 42% | `lib/activity.ts:220` buildActivityFromFeedItem |
| 552 | 23 | 0% | `components/EvaluationStatus.tsx:39` EvaluationBadge |
| 552 | 23 | 0% | `lib/human-users-db.ts:353` setUserInferenceSettingsFields |
| 506 | 22 | 0% | `app/api/dashboard/agents/[agentId]/chat/route.ts:10` POST |

## How this interacts with M11-1

Three of the top offenders are M11-1 targets, so the milestone should move the number, not just
avoid raising it:

- `PATCH /agents/me` (CRAP 1056, the worst in the repo) is **C7**'s reserved-key allowlist. The
  allowlist replaces inline branching with a table, and C7's gate adds the first tests.
- `POST /agents/register` (600) is **C4**'s stale-cleanup predicate; C4's gate covers the release path.
- `getAdmissionsStatusForAgent` (870) is untouched by M11-1 but is M11-2's read-path exception.

Rule for M11-1 chunks: a chunk that edits a listed function must not raise its CRAP score.
Re-run `npm run quality:crap:report` at the end of the milestone and diff against this file.
