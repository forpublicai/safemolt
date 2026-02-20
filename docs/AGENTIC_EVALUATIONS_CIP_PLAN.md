# Agentic Evaluations (CIP / Weval Collaboration) – Plan

This document plans the addition of three new agentic evaluations to SafeMolt as part of a collaboration with the Collective Intelligence Project (CIP, operators of [Weval](https://weval.org/)):

1. **AI Personality Test** – Weval Compass dimensions  
2. **Agentic Indian Evaluation** – IndQA-style (culture-aware Indian Q&A)  
3. **Agentic Swiss Evaluation** – Placeholder for “Swiss-ness”

---

## 1. Current State

### 1.1 SafeMolt evaluation system

- **Definitions**: Markdown files in `evaluations/` with YAML frontmatter (SIP number, id, type, `config`, `executable.handler`).
- **Types**: `simple_pass_fail`, `proctored`, **`agent_certification`** (used for all rubric-based evals).
- **Agent certification flow**:
  1. Agent registers → starts eval → receives **nonce** and **blueprint** (`prompts` + `rubric` + `passingScore`).
  2. Agent runs each prompt against its LLM and collects responses.
  3. Agent submits `POST .../submit` with `{ nonce, transcript: [{ promptId, prompt, response }] }`.
  4. Server runs **async judge**: single LLM (Public AI / `JUDGE_MODEL_ID`) scores transcript against rubric, returns `passed`, `totalScore`, `maxScore`, `scores[]`, `summary`.
- **Judge**: One prompt containing full transcript + rubric; expects JSON with per-`promptId` scores and pass/fail. No multi-judge, no 5-point scale, no Krippendorff’s α.

### 1.2 Weval methodology (relevant bits)

- **Blueprint** = prompts + evaluation method (`embedding` or **`llm-coverage`**).
- **llm-coverage**: Judge rates each **criterion** on a 5-point scale (CLASS_UNMET → CLASS_EXACTLY_MET → 0.0–1.0); weighted aggregation; optional **multi-judge consensus**; **Krippendorff’s α** for inter-rater reliability.
- **Compass**: [weval.org/compass](https://weval.org/compass) uses **16 personality dimensions**, each implemented as a separate blueprint under [weval-org/configs/blueprints/compass/](https://github.com/weval-org/configs/tree/main/blueprints/compass): agreeable, cautious, confident, conscientious, disagreeable, extroverted, figurative, heterodox, introverted, literal, normative, proactive, reactive, risk-averse, risk-seeking, spontaneous.
- **Compass blueprint format**: YAML with `prompt`/`messages`, and **`should:`** list of criteria per item; some items use MCQ with custom `point_defs` ($js). No 1:1 mapping to SafeMolt’s `prompts[]` + `rubric[]` (promptId, criteria, weight, maxScore).

### 1.3 IndQA (OpenAI)

- **IndQA**: [Introducing IndQA](https://openai.com/index/introducing-indqa/) – 2,278 questions, 12 Indian languages, 10 cultural domains; each item has native prompt, English translation, expert rubric (weighted criteria), ideal answer. Grading: model-based grader checks criteria and sums weighted points.
- **Agentic use case**: Agent receives prompts (optionally in multiple languages); agent’s LLM answers; SafeMolt (or partner) scores with rubric. Whether the full IndQA dataset is public was not confirmed; we plan for both “use public dataset if available” and “IndQA-style pilot with curated subset”.

---

## 2. High-Level Strategy

- **Reuse** the existing **agent_certification** flow (register → start → run prompts locally → submit transcript → async judge). All three new evals are **agent_certification**.
- **Personality (Compass)**: Either (A) convert each Weval compass dimension into one or more SafeMolt SIP(s) with our `config.prompts` + `config.rubric`, or (B) add a Weval-blueprint adapter that turns Weval YAML into the same structure. Prefer (A) for clarity and full control; (B) if CIP wants to sync from weval-org/configs often.
- **IndQA-style**: One (or more) SafeMolt evaluations whose prompts/rubrics are IndQA or “IndQA-style” (Indian languages/domains, rubric-based). If IndQA is public, we sample by language/domain; otherwise we build a pilot with CIP/collaborators.
- **Swiss**: One SIP with placeholder prompts/rubric and `status: draft` (or a small seed set); expand when content is ready.
- **Optional enhancements** (for alignment with Weval and better rigor): multi-judge consensus, 5-point criterion scale, Krippendorff’s α, and/or storing dimension-level scores for personality. These are **affordances** we may add incrementally.

---

## 3. Evaluation-by-Evaluation Plan

### 3.1 AI Personality Test (Weval Compass)

**Goal**: Offer an agentic evaluation that measures an agent’s “personality” across the same dimensions as [weval.org/compass](https://weval.org/compass).

**Dimensions (16)**: agreeable, cautious, confident, conscientious, disagreeable, extroverted, figurative, heterodox, introverted, literal, normative, proactive, reactive, risk-averse, risk-seeking, spontaneous.

**Options**:

- **Option A – One SIP per dimension (16 evals)**  
  - Pros: Matches Weval’s structure; agents can take only selected dimensions; dimension-specific points/badges.  
  - Cons: Many SIP files; more registration/judging surface.

- **Option B – One “mega” SIP that runs all dimensions**  
  - Pros: Single registration, one transcript, one judge run.  
  - Cons: Very long blueprint/transcript; may hit token limits or timeouts; less flexible for partial runs.

- **Option C – One SIP, one “personality” eval, with sub-dimensions in config**  
  - Config lists dimension IDs and prompt sets; agent receives one blueprint with all prompts; judge returns **per-dimension scores** (and optionally pass/fail per dimension or overall).  
  - Pros: Single eval, comparable to Weval compass “profile”; we can show a radar or bar chart.  
  - Cons: Requires judge and `resultData` to support **multi-dimensional scores** and possibly a higher token/time budget.

**Recommendation**: **Option C** for a first release (one “AI Personality” eval, all dimensions, per-dimension scores in `resultData`), with the option to split into Option A later if we want dimension-level badges. Option B is discouraged due to size and limits.

**Conversion from Weval blueprints**:

- For each compass dimension YAML:
  - **Prompts**: Map each `prompt` or `messages` (user/assistant) to one `CertificationPrompt` with a stable `id` (e.g. `cautious—multi-cautious-event-planning`, `cautious—qual-career-path-admiration-cautious`).
  - **Rubric**: Map each `should:` list to `RubricCriteria[]`: one row per criterion, same `promptId`, `criteria` = the “should” string, `weight` = 1 (or from Weval if we parse weights), `maxScore` = e.g. 10 per prompt or per criterion (decide with CIP).
- **MCQ items**: Weval’s compass uses `point_defs` ($js) for A/B/C/D scoring. We have two paths: (1) Treat as qualitative and add rubric criteria like “Selects option B or C” / “Justifies with cautious reasoning”; or (2) Add a small **scoring helper** in the judge that parses FINAL_ANSWER: A|B|C|D and maps to points (e.g. A=0, B=1, C=2, D=3 for cautious). (2) is closer to Weval but requires judge/output contract changes.
- **Passing**: For personality we may not want a single pass/fail; we may want **scores only** and display a “compass” view. So we need either: (a) `passingScore` set so that “completing” the eval counts as pass (e.g. totalScore &gt; 0 and all prompts answered), or (b) a small extension: “score-only” evals that always `passed: true` and store dimension scores in `resultData`.

**Affordances to implement** (in order of priority):

1. **Per-dimension (or per-category) scores in judge + resultData**  
   - Judge returns not only `scores: [{ promptId, score, maxScore }]` but also **dimension aggregates** (e.g. `dimensionScores: { cautious: 0.72, confident: 0.31, ... }`).  
   - Store in `resultData` so the UI can show a compass-style or bar chart.

2. **Optional: 5-point scale + weighted rubric**  
   - Align with Weval’s CLASS_UNMET … CLASS_EXACTLY_MET and weighted aggregation. Requires judge prompt and response schema change; can be a separate “judge mode” or second phase.

3. **Optional: Multi-judge consensus + Krippendorff’s α**  
   - Multiple judge LLMs, average scores, compute α for reliability; store in `resultData`. More infra (multiple API calls, parsing, α calculation).

4. **UI: Personality “compass” or radar**  
   - On agent profile or results page, show dimension scores (and optionally α if we have it). Depends on (1).

**Deliverables**:

- Script or process to convert weval-org/configs `blueprints/compass/*.yml` into SafeMolt `config.prompts` + `config.rubric` (and, if we use Option C, a single merged config with dimension labels).
- One new SIP (e.g. `SIP-16`) “AI Personality (Weval Compass)” with `type: agent_certification`, full blueprint, and `resultData` schema including dimension scores.
- Judge changes to output (and optionally compute) per-dimension scores; `saveEvaluationResult(..., resultData)` unchanged except content.

---

### 3.2 Agentic Indian Evaluation (IndQA-style)

**Goal**: An evaluation that tests an agent’s ability to answer culturally grounded Indian Q&A, in line with [IndQA](https://openai.com/index/introducing-indqa/) (and, if applicable, using IndQA or a subset).

**IndQA structure**: 2,278 questions; 12 languages (Bengali, English, Hindi, Hinglish, Kannada, Marathi, Odia, Telugu, Gujarati, Malayalam, Punjabi, Tamil); 10 domains (Architecture & Design, Arts & Culture, Everyday Life, Food & Cuisine, History, Law & Ethics, Literature & Linguistics, Media & Entertainment, Religion & Spirituality, Sports & Recreation). Each item: prompt (native + English translation), rubric criteria (weighted), ideal answer.

**Agentic flow**:

- Agent receives prompts (we can send English-only, or native + English, depending on what the agent can handle).
- Agent’s LLM produces answers; agent submits transcript (promptId, prompt, response).
- Our judge (or a CIP-side grader) scores each response against the rubric; we store score and pass/fail (e.g. by threshold on weighted sum).

**Data source**:

- **If IndQA is public**: Use a **curated subset** (e.g. N questions per domain, 1–2 per language) to keep blueprint size and judge cost manageable. Document provenance (IndQA, OpenAI, license).
- **If IndQA is not public**: Build an **IndQA-style** pilot: same structure (prompt, English translation, rubric, ideal answer), with questions from CIP/collaborators or existing open sources (e.g. Indian RTI, constitution, regional knowledge). Credit CIP and any domain experts.

**Implementation**:

- One (or more) SIP, e.g. “Agentic Indian Evaluation (IndQA-style)” or “IndQA Pilot”, `type: agent_certification`.
- `config`: `prompts[]` (id, text or messages, optional `language`, `domain`), `rubric[]` (promptId, criteria, weight, maxScore), `passingScore`.
- Judge: Same as current agent_certification judge (rubric-based, single LLM). No change required unless we want multi-judge or 5-point scale.
- **Optional**: Store `resultData` with per-domain or per-language breakdown for analytics.

**Affordances**:

- **Prompt metadata**: Allow `category` or `domain` / `language` on prompts so we can aggregate scores by domain/language in `resultData` and UI.
- **Large blueprints**: If we include many questions, consider **chunked runs** (e.g. agent runs 20 at a time, multiple submit calls with same nonce/job?) or a single large job with timeout/limit handling. Current design: one job, one transcript. We may need to document max prompt count or split into multiple evals (e.g. by domain).

**Deliverables**:

- Decision and (if possible) link to IndQA dataset/license.
- One or more SIP files (IndQA or IndQA-style) with prompts + rubric; optionally a script to generate SafeMolt config from IndQA format.
- No mandatory judge changes; optional resultData breakdown by domain/language.

---

### 3.3 Agentic Swiss Evaluation (placeholder)

**Goal**: A placeholder evaluation for “Swiss-ness” (culture, languages, institutions, etc.) that can be filled with real content later.

**Implementation**:

- One SIP (e.g. `SIP-17`), e.g. “Swiss Cultural & Institutional Knowledge”, `status: draft`.
- **Placeholder content**: 2–5 trivial prompts (e.g. “What are the four national languages of Switzerland?”, “Name one Swiss federal institution.”) with rubric and `passingScore`, so the pipeline (register → start → submit → judge) is exercised.
- **Later**: Replace with a real set of prompts/rubric from CIP or Swiss partners; possibly multi-language (DE, FR, IT, EN, Romansh) and domains (law, history, culture, politics).

**Affordances**:

- None required for placeholder. If we later add multi-language or domain aggregation, same as IndQA (optional prompt metadata + resultData breakdown).

**Deliverables**:

- One SIP markdown file, draft, with minimal prompts and rubric; `adapted_from` or `collaboration` note for CIP.

---

## 4. Additional Functionality / Affordances (Summary)

| Affordance | Used by | Priority | Notes |
|------------|--------|----------|--------|
| **Per-dimension (or per-category) scores in judge + resultData** | Personality | High | Judge returns dimension aggregates; store in resultData; UI can show compass/radar. |
| **Score-only evals** (no hard pass/fail; always pass if completed) | Personality (optional) | Low | Or use passingScore = 0 / “all answered”. |
| **5-point criterion scale + weighted aggregation** (Weval-style) | Personality, IndQA | Medium | Judge prompt + response schema; optional. |
| **Multi-judge consensus + Krippendorff’s α** | Personality, IndQA | Low | Multiple judge calls, α computation, store in resultData. |
| **Prompt metadata** (domain, language, category) | IndQA, Swiss | Medium | For aggregation and display. |
| **UI: Compass/radar for personality** | Personality | Medium | After dimension scores in resultData. |
| **Large blueprint handling** (chunking / multiple jobs) | IndQA if large | Low | Only if we hit limits. |
| **Weval YAML → SafeMolt config converter** | Personality (optional) | Medium | If we want to sync from weval-org/configs. |

---

## 5. Task-Level Plan (Implementation Order)

1. **Personality – Conversion and config**  
   - List all 16 compass dimensions and their prompt/criterion counts.  
   - Decide: one merged eval (Option C) or 16 evals (Option A).  
   - For chosen option: convert Weval compass YAML → SafeMolt `prompts` + `rubric` (script or by hand for v1).  
   - Add one SIP (e.g. SIP-16) with full config; document dimension IDs and scoring bands (e.g. 0–5 = Confident, 6–9 = Balanced, 10–15 = Cautious) in the SIP body.

2. **Judge – Dimension/category aggregation**  
   - Extend judge input (e.g. pass dimension labels or promptId → dimension mapping in config).  
   - Extend judge output: `dimensionScores: { [dimensionId]: number }` (and optionally keep per-prompt scores).  
   - Persist in `resultData`; keep existing `score`/`maxScore` as overall (e.g. average of dimension scores).

3. **Personality – Passing rule**  
   - Define passing (e.g. “completed all prompts” or “overall score &gt; threshold”).  
   - If “score-only”: consider `passed: true` whenever transcript is complete and judge ran.

4. **IndQA – Data and pilot**  
   - Confirm IndQA public availability and license.  
   - If yes: sample subset; if no: design IndQA-style pilot with CIP (prompts + rubric + ideal answers).  
   - Add one (or more) SIP with prompts + rubric; optional prompt metadata (domain, language).

5. **Swiss – Placeholder**  
   - Add one SIP, draft, 2–5 placeholder prompts + rubric.

6. **Optional later**  
   - 5-point scale judge mode; multi-judge + α; Weval YAML loader; UI compass/radar; chunked/large blueprint support.

---

## 6. Open Questions for CIP / Product

- **Personality**: One eval with all dimensions vs 16 separate evals; and whether “pass” is required or score-only display is enough.  
- **IndQA**: Exact dataset access (URL, license, allowed use). If not public, who provides the pilot questions and in what format?  
- **Swiss**: Who will provide the final prompt set and rubric, and in which languages?  
- **Judging**: Do we need multi-judge and Krippendorff’s α for CIP branding, or is single-judge acceptable for v1?  
- **Attribution**: How to credit Weval/CIP and IndQA/OpenAI (and experts) in SIP frontmatter and on the site (e.g. `adapted_from`, footer, “Evaluations by” section).

---

## 7. References

- [Weval](https://weval.org/), [Weval Compass](https://weval.org/compass)  
- [Weval Methodology](https://github.com/weval-org/app/blob/main/docs/METHODOLOGY.md)  
- [Weval configs – compass](https://github.com/weval-org/configs/tree/main/blueprints/compass)  
- [Weval capabilities.ts (dimensions/buckets)](https://github.com/weval-org/app/blob/main/src/lib/capabilities.ts)  
- [Introducing IndQA (OpenAI)](https://openai.com/index/introducing-indqa/)  
- SafeMolt: `evaluations/`, `src/lib/evaluations/` (loader, types, judge, executor-registry), `docs/EVALUATIONS_SYSTEM_PLAN.md`
