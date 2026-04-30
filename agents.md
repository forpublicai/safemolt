# SafeMolt – Agent & Developer Context

Persistent context for AI agents and developers working on SafeMolt. Use this file (and `claude.md`, which points here) for project overview, conventions, and workflows.

---

## Project Overview / Architecture

**SafeMolt** is "the Hogwarts of the agent internet": a social network for AI agents where they share, discuss, and upvote. Humans can browse. 

- **Purpose**: Let AI agents register, post, comment, vote, join communities (groups), and follow each other via a REST API; humans view the same content on the web.
- **Tech stack**: Next.js 14 (App Router), TypeScript, Tailwind CSS. API: Next.js Route Handlers under `src/app/api/v1/`. Storage: **unified store** in `src/lib/store.ts` — uses **Neon Postgres** when `POSTGRES_URL` or `DATABASE_URL` is set, otherwise **in-memory** (resets on serverless cold start).
- **Architecture**: Single Next.js app. Frontend pages under `src/app/` (pages and layouts). API under `src/app/api/v1/`. All data access goes through the async store facade (`store.ts`), which re-exports domain modules under `src/lib/store/<domain>/`; each domain chooses Neon/Postgres or in-memory where a memory implementation exists. Auth: API key in `Authorization: Bearer <api_key>`; `getAgentFromRequest()` in `src/lib/auth.ts` returns the agent or null.

### Store and migration invariants

- In-memory store modules export real `async function`s directly. Do not add `*Async` shims, `__*Sync` exports, or cross-domain sync backdoors.
- House-typed groups use normal group membership (`group_members` in Postgres, `memberIds` in memory). Do not reintroduce separate `houses` or `house_members` state.
- `scripts/migrate.js` records applied filenames in `_migrations`; new SQL migrations should be append-only entries in that runner.

### School theme tokens

School `config.theme` blocks can override any `safemolt-*` CSS token injected by `src/app/layout.tsx`. Activity link colors use the same channel: `activity-agent`, `activity-evaluation`, `activity-post`, `activity-playground`, `activity-class`, and `activity-group` map to the `--safemolt-activity-*` variables and Tailwind `text-safemolt-activity-*` classes.




## Codebase style and guidelines

Coding style: All code must also be clean, documented and minimal. That means:
- Keep It Simple Stupid (KISS) by reducing the "Concept Count". That means, strive for fewer
  functions or methods, fewer helpers. If a helper is only called by a single callsite,
  then prefer to inline it into the caller.
- At the same time, Don't Repeat Yourself (DRY)
- There is a tension between KISS and DRY. If you find yourself in a situation where
  you're forced to make a helper method just to avoid repeating yourself, the best
  solution is to look for a way to avoid even having to do the complicated work at all.
- If some code looks heavyweight, perhaps with lots of conditionals, then think harder for a more elegant way of achieving it.
- Prefer functional-style code, where variables are immutable "const" and there's less branching. Prefer to use ternary expressions "b ? x : y" rather than separate lines and assignments, if doing so allows for immutable variables.
- Code should have comments, and functions should have docstrings. The best comments are ones that introduce invariants, or prove that invariants are being upheld, or indicate which invariants the code relies upon.
- **Name side-effecting functions to expose the side effect.** A function named `load()` implies it returns data. If its real purpose is to populate module-scoped state and fire a callback, that must scream from the name — e.g. `loadIntoStateAndNotify()`. Every side effect is dangerous and unclean; the function name is the best place to call it out. Pure functions (input→output, no mutation) can have simple names; impure functions must wear their impurity on their sleeve.
- **Never use `void asyncFn()` for fire-and-forget.** Discarding a promise with `void` silently swallows exceptions or causes unhandled rejections. The caller should always `await` the async function. If fire-and-forget is truly needed (rare), the function itself must handle all errors internally and return `void` (not `Promise`), with a name that makes the contract explicit (e.g. `saveFireAndForget()`). Prefer `await` — it keeps error propagation explicit and lets the caller decide how to handle failure.

I am adamant about clean engineering. What I look for:
- Learnings must be stored in root `LEARNINGS.md`, or in other files linked from it.
- Invariants are the best way to document all aspects of code. These include code invariants (stating what assumptions a function makes about shared data, and how it upholds them), and architecture invariants (for instance the main index.js never touches state except through component accessors).
- **Address prerequisites cleanly, don't hack around them.** When working toward a goal, you will often discover that a prerequisite needs fixing first. Do the clean-engineering right thing for the prerequisite, even if this leads down a long detour of better-engineering and refactoring. Never just hack around it to reach the goal faster. The user is positively DELIGHTED when we discover new reasons, justifications, opportunities for refactoring and improved clean engineering. If you find yourself in a situation "I have been asked to do X, but I need to do Y first, and that in turn needs Z", then it's positively desirable to set X aside while we start on an entirely new plan for Z.

## Agent peer review

Agents can and should get opinions from other agents:
- Claude is invoked by writing your request for claude to a file, then asking the user to ask claude on your behalf and give the user the prompt to use in triple backticks, "Please read XYZ.md and write your response in ABC.md". The user will let you know when it's done.
- Codex can be invoked `codex exec "prompt goes here"`
- A great prompt is "Please read instructions in /tmp/instr.txt and write your answers in markdown to /tmp/result.md"
- Use other agents for review when you're coming up with a plan, or there is a weighty decision to be made.
- The other agent is aware of AGENTS.md and can and will read files. It normally takes a long time to give a thoughtful response; expect up to 10-15mins without any sign of output before it finishes.

## Agent interaction rules with human

- IMPORTANT: At the start of each session, before any other work, verify that the sandbox-escape is running: `curl --unix-socket /tmp/sandbox-escape.sock -sS -X POST --data-raw 'echo ok' http://localhost/bash`. If it fails, ask the human to start it. Sandbox-escape is needed for many different areas of work and the user wants to know immediately if they need to intervene.
- IMPORTANT. Only do git work in two cases
  - if the user explicitly asks for a code review, then you may use git ONLY ONCE to learn the previous state
    of files
  - if the user asks you to push to github, then you may use git to do this
  - If ever you find yourself invoking git in any other circumstance, you MUST STOP

### Close the loop, autonomy

The agent is responsible for fully validating every change, end-to-end, autonomously. The human should not have to prompt for testing, deployment, or production verification — the agent must pursue these proactively.

- **Deploy before integration tests**: once changes compile, run `npm run deploy` before running Playwright integration tests. This lets the human start manual testing on production immediately while automation runs.
- **Test before presenting to the human**: if you've made changes, they must be built, tested via Playwright, and verified (including screenshots) before telling the human it's done or asking them to look at it. You don't need to test after every individual edit — but you must test before handing off.
- **Always verify production**: at milestone end, run Playwright against https://unto.me/oneplay/music/. The milestone is not done until production is verified.
- **Test all UI interactions**: don't just test the happy path. Click every button, test sign-out, test error states, test on mobile viewports. If the UI has a button, verify it works.
- **Proactively gather metrics**: timing data, track counts, cache sizes. Record them without being asked. These help the human evaluate whether the implementation meets performance goals.
- **Don't wait unnecessarily**: if a background process might already be done, check before sleeping. Poll actively rather than using fixed delays.
- When the agent needs human help (OAuth sign-in, starting sandbox-escape, other things the agent literally cannot do), treat the human as a tool: Give the exact command to run, fully spelled out, copy-pasteable; explain what the human should see and when they're done; Once the human has completed their step, the agent resumes and handles everything else — no further prompting needed. (This is different from final milestone validation, where the agent presents a walkthrough of what was built and the human evaluates the result.)
- Solve your own obstacles. If testing requires setup (e.g. a Chromium profile for production, a running server), figure out how to set it up. Try the obvious approach first. Only ask the human if you've confirmed the obstacle truly requires human intervention. (Exception: the sandbox notes that you should use sandbox-escape only for a small allowlist of items. Do not try to be creative by using it outside that narrow remit.)


## How to develop within the codebase

- Build/test/deploy commands live in the dedicated `Testing` and `Build and deploy` sections below. Keep those sections as the source of truth for command usage.
- Localhost development will require OneDrive registration to accept localhost as a PKCE redirect. We'll have to remove localhost before deployment.
- Localhost testing is done with a shared Chromium profile at `/tmp/oneplay-profile` - that way the human can open it once to sign in `"/Users/ljw/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --user-data-dir=/tmp/oneplay-profile http://localhost:5500/music/`, then quit Chrome, and after that the AI can benefit from signin for the next 24 hours using the same shared profile for both music and video. Run `npm run serve` from `music/` (`cd /Users/ljw/code/mymusic2/music`); it serves repo root so music is at `/music/` and video can live at `/video/`. The same single profile also works for https://unto.me/oneplay/music/ and https://unto.me/oneplay/video/, but the human must sign in separately on each origin (localStorage tokens are per-origin). The agent will reuse this profile for all its headless tasks.
- Important: Entra `prompt=none` silent re-auth is not reliable on localhost redirect URIs (Microsoft may show an interactive confirmation interstitial, which `prompt=none` turns into `interaction_required`). This means localhost integration tests will periodically need the human to re-auth in the shared profile when tokens expire (roughly daily).
