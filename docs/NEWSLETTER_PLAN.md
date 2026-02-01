# Newsletter “Notify me” – Plan

Plan for making the Newsletter “Notify me” email signup functional. Review and adjust before implementation.

---

## Phase 1 – Done

- **Schema:** `newsletter_subscribers` table in `scripts/schema.sql` (id, email UNIQUE, subscribed_at, source); migration run via `npm run db:migrate`.
- **Store:** `subscribeNewsletter(email, source?)` in store-db (INSERT … ON CONFLICT DO NOTHING), store-memory (Set), and store facade.
- **API:** `POST /api/newsletter/subscribe` – JSON body `{ email, source? }`, validate email, rate limit 5/min per IP (in-memory), idempotent on duplicate email; returns 200 `{ success, message }` or 400/429/500.
- **Frontend:** Newsletter component – email input, required privacy checkbox, submit → loading/success/error states; success shows “Thanks! We'll be in touch.”
- **Docs:** agents.md File Map updated; this plan updated.

## Phase 2 – Confirmation + Unsubscribe (Done)

- **Schema:** Added `confirmation_token` (UNIQUE), `confirmed_at`, `unsubscribed_at` to `newsletter_subscribers`; ALTER for existing DBs; unique index on token.
- **Store:** `subscribeNewsletter` now returns `{ token }`; added `confirmNewsletter(token)` and `unsubscribeNewsletter(token)` (store-db + store-memory + facade).
- **Email:** Resend in `src/lib/email.ts`; `sendNewsletterConfirmation(baseUrl, to, token)` sends email with “Confirm” and “Unsubscribe” links. Env: `RESEND_API_KEY`, `RESEND_FROM` (optional; default `SafeMolt <onboarding@resend.dev>`).
- **API:** `POST /api/newsletter/subscribe` sends confirmation email when Resend is configured; message “Check your email to confirm” or “You're on the list.” `GET /api/newsletter/confirm?token=` sets `confirmed_at`, redirects to `/?newsletter=confirmed`. `GET /api/newsletter/unsubscribe?token=` sets `unsubscribed_at`, redirects to `/?newsletter=unsubscribed`.
- **Frontend:** `NewsletterBanner` on home reads `?newsletter=` and shows “You're confirmed!”, “You're unsubscribed.”, or “Something went wrong.”; success message from API (e.g. “Check your email to confirm”).

---

## 1. Goal and scope

**Goal:** When a visitor enters their email and clicks “Notify me”, we persist it and show clear success/error feedback. Optionally send a confirmation email.

**Out of scope for initial pass:** Sending actual newsletters (Mailchimp, etc.), unsubscribe flow, admin UI. Those can be added later.

---

## 2. Options

| Approach | Pros | Cons |
|----------|------|------|
| **A. Store only** | Simple, no email provider, works with existing Neon DB | No confirmation email; you export list and email manually |
| **B. Store + confirmation email** | Double opt-in, cleaner list, user sees “check your inbox” | Needs email provider (Resend, SendGrid), token + verified flag |
| **C. Third-party only** | No DB table, e.g. Mailchimp/ConvertKit form embed | Less control, external UI, may cost |

**Recommendation:** Start with **A** (store only). Add **B** later if you want confirmation emails. This plan assumes A with a clear path to B.

---

## 3. Data model

**New table: `newsletter_subscribers`**

- `id` – primary key (e.g. UUID or `sub_` + short id).
- `email` – TEXT, UNIQUE, NOT NULL (normalized: lowercase, trimmed).
- `subscribed_at` – TIMESTAMPTZ, default NOW().
- `source` – TEXT, optional (e.g. `"homepage"` for later analytics).
- *(If you add confirmation later)* `verified_at` – TIMESTAMPTZ NULL; `confirmation_token` – TEXT NULL; index on token.

**Migration:** New file `scripts/schema-newsletter.sql` or append to existing `schema.sql`, then run `npm run db:migrate` (or a one-off migration step for the new table only).

---

## 4. API

**Endpoint:** `POST /api/newsletter/subscribe` (no auth required).

**Request:** JSON body `{ "email": "user@example.com" }`. Optional: `source` string.

**Validation:**

- `email` required, non-empty string.
- Format: basic email regex or use a small validator (e.g. “contains @ and a dot”).
- Normalize: trim, lowercase before store.

**Behavior:**

- If DB: insert into `newsletter_subscribers`. On unique conflict (email already exists), treat as success (idempotent) and return 200.
- If in-memory: same idea with a Set or array in memory (or skip persistence when no DB and return “coming soon”).
- Return 200 with `{ "success": true, "message": "You're on the list." }`.
- On validation error: 400 with `{ "success": false, "error": "Invalid email" }`.
- On server/DB error: 500 with generic message.

**Rate limiting (recommended):** Limit by IP (e.g. 5 requests per minute per IP) to avoid abuse. Use a simple in-memory map when no DB, or a small `newsletter_rate_limits` table keyed by IP if you prefer DB-backed limits.

---

## 5. Frontend (Newsletter component)

**Current:** Static “Notify me” button, no input.

**Changes:**

1. **Email input** – `<input type="email" />` with placeholder “Your email”, required, client-side validation (required + basic format).
2. **Privacy checkbox** – “I agree to receive email updates and accept the Privacy Policy” with `<input type="checkbox" />`; submit disabled until checked (or submit and validate on server).
3. **Submit** – Button “Notify me” submits the form (no page reload): `fetch POST /api/newsletter/subscribe` with JSON body.
4. **States:**
   - **Idle** – Form visible, button enabled when email + checkbox valid.
   - **Loading** – Button disabled, “Subscribing…” or spinner.
   - **Success** – Hide form (or disable it), show “Thanks! We’ll be in touch.”
   - **Error** – Show API error message under the form or near the button.
5. **Accessibility** – Labels, `aria-invalid` on error, focus management after submit.

**Implementation detail:** Keep it a client component; use `useState` for email, checkbox, loading, success, error. No need for a form library for this single form.

---

## 6. Environment and security

**Env (for “store only”):** None required. DB connection already uses `POSTGRES_URL` / `DATABASE_URL`.

**Env (when you add confirmation email later):** e.g. `RESEND_API_KEY` and `FROM_EMAIL` (or similar) for Resend.

**Security:**

- Rate limit by IP on `POST /api/newsletter/subscribe` (see above).
- Optional: honeypot field (hidden input); if filled, reject. Optional later: Turnstile or similar.
- Don’t expose internal errors; return generic “Something went wrong” for 500.

---

## 7. Implementation phases

**Phase 1 – MVP (store only)**  
1. Add `newsletter_subscribers` table (schema + migration).  
2. Implement `POST /api/newsletter/subscribe` (validate, normalize, insert; idempotent on duplicate email).  
3. Add optional IP rate limit (in-memory or DB).  
4. Update Newsletter UI: email input, privacy checkbox, submit, loading/success/error states.  
5. Document in README or agents.md: “Newsletter signups are stored in `newsletter_subscribers`; no email is sent yet.”

**Phase 2 – Optional later**  
- Confirmation email (Resend/SendGrid): send link with token, set `verified_at` when clicked; optional “verified” filter when exporting.  
- Unsubscribe: token in link, set `unsubscribed_at` or delete row.  
- Export: simple script or admin route to export emails (CSV) for manual campaigns.

---

## 8. File checklist (Phase 1)

| Item | Action |
|------|--------|
| `scripts/schema.sql` (or new migration) | Add `newsletter_subscribers` table. |
| `src/app/api/newsletter/subscribe/route.ts` | New: POST handler, validate, store, rate limit. |
| Store layer | Either raw SQL in route (Neon `sql`) or add `subscribeNewsletter(email)` to store + store-db; keep store-memory stub (no-op or in-memory set). |
| `src/components/Newsletter.tsx` | Form with email, checkbox, submit, loading/success/error. |
| `docs/NEWSLETTER_PLAN.md` | This file; update after implementation with “Done” and any deviations. |
| `agents.md` | Optional: one line under File Map or Critical Notes for newsletter API and table. |

---

## 9. Open decisions

1. **Rate limit:** In-memory (resets on cold start) vs DB table? Recommendation: in-memory for Phase 1 (simpler); move to DB if you need persistence across restarts.
2. **Duplicate email:** Treat as success (idempotent) vs “already subscribed” message? Recommendation: idempotent 200 to avoid leaking whether the email exists.
3. **Privacy checkbox:** Required before submit (UX + legal) vs optional? Recommendation: required and enforce in frontend; optional server-side check.

Once you’re happy with this plan, we can implement Phase 1 step by step.
