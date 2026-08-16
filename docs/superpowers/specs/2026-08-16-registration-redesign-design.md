# Registration Redesign — Design

**Date:** 2026-08-16
**Status:** Approved (brainstorm session with owner)
**Scope:** Public registration flow + org panel registration management, both rebuilt. Greenfield stance confirmed by owner: old surfaces are removed, not migrated around.

## 1. Context

Registration today: public form at `/shared/[orgSlug]/[competitionSlug]/register` (`components/public-site/register-form.tsx`, ~836 lines, one registration per submit, `entrant_kind` fixed per division), org side on an ad-hoc route `/o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations` mixing a settings form (`registration-settings.tsx`) and a list (`registrations-panel.tsx`). Backend already supports: open/close window, capacity + waitlist, custom form fields, payment (Stripe, `registration.paid` entitlement), guardian/privacy consent booleans, age/gender eligibility via `divisions.eligibility` jsonb, roster as a jsonb column, automatic registration→entrant promotion (`usecases/registrations.ts`).

Gaps this redesign closes:

1. No multi-entry registration (club rep with several teams; entries across divisions).
2. No way for a player to join an existing team entry — captains type rosters; those players never consent.
3. No free-agent path into team divisions.
4. Category (open/mens/womens/mixed) and age limits are buried in `eligibility` jsonb — invisible on the public page until validation rejects; roster players are never individually validated.
5. Consent is boolean-level; no per-person record for roster members.
6. Organiser has no approval control and no cross-division view.

## 2. Decisions (owner rulings)

- **Public flows supported:** club rep registering N teams in one flow; player joining an existing team via link; free agents; all composing with today's individual/pair flows.
- **Org IA:** competition-level Registration hub with Settings and Registrants tabs. Division-level registration route is deleted.
- **Eligibility:** first-class `category` + age band on divisions; badges on public page; every roster player validated; mixed ⇒ roster needs both genders.
- **Consent:** per-person; join/claim link is the consent moment for players someone else entered.
- **Names are public by default.** Registering = consent to public name, stated plainly in the consent step copy. Opt-out later (claim/profile) flips public rendering to initials. Youth divisions keep the existing `player_name_display` override.
- **Approval:** per-division toggle `auto` (default, today's behavior) | `manual` (organiser approves/rejects pending entries).
- **Public flow shape:** stepper + cart, one payment per cart.
- **Currency (addendum 2026-08-16, decided after RS001 started — lands as RS001b):** one preferred currency per org (`organizations.currency`), selected from the platform allowlist (`SUPPORTED_CURRENCIES` minus registration exclusions = `REGISTRATION_CURRENCIES`); per-division `registration_settings.currency` is dropped. The same restricted list applies when payment is collected offline (no free-text display currency). Carts are single-currency by construction. INR is a member only if RS001b's live destination-charge verify passes — subscription INR proves nothing (platform charge, no `transfer_data`).
- **Greenfield:** old form, old org route, old roster jsonb, old single-entry POST route all removed. Prod holds zero registration data (owner-confirmed 2026-08-16), so there is no backfill anywhere — columns drop and constraints are strict from day one. No feature flags; PR sequencing keeps every merge shippable.

## 3. Data model

New tables:

**`registration_groups`** — one cart/submission. `id`, `org_id`, `competition_id`, `contact_name`, `contact_email`, `user_id` (nullable), `ref_code` (public reference), `access_token_hash`, `locale`, `amount_cents` (charged subtotal), payment fields (mirroring today's registration payment columns: `payment_method`, Stripe refs, `expires_at`), `currency` (org currency snapshotted at submit — later org-currency changes never touch existing groups), timestamps. Every registration belongs to a group (size 1 is normal).

**`registration_players`** — replaces `registrations.roster` jsonb. `id`, `registration_id`, `org_id`, `full_name`, `email` (nullable), `dob` (nullable), `gender` (nullable, `m|f|x`), `source` (`captain_entered | self_joined`), `consent_status` (`pending | granted | guardian`), `consent_at`, `claim_token_hash` (nullable), `person_id` (nullable, set at materialization), `squad_number`/`is_captain` carried where provided. Per-player dob/gender required only when the division's category/age rules need them.

Changed tables:

- **`registrations`**: add `group_id` FK NOT NULL, `join_code` (nullable, team entries), `free_agent` boolean default false, status enum gains `rejected`. Drop `roster` jsonb. Per-entry `status` and `amount_cents` stay — a cart can be partially waitlisted.
- **`divisions`**: add `category` (`open|mens|womens|mixed`, null = open), `age_min`, `age_max` (years, evaluated against season start year as today). `eligibility` jsonb stays for custom extra rules; `eligibilityIssues()` evaluates first-class columns plus jsonb.
- **`registration_settings`**: add `approval` (`auto|manual`, default auto), `allow_free_agents` boolean default false; **drop `currency`** (org-level now; RS001b delta). Everything else unchanged.
- **`organizations`**: add `currency` (text NOT NULL default `gbp`, DB CHECK over `REGISTRATION_CURRENCIES`) — every fee in the org is priced, displayed and charged in it. Set in org settings; Connect sync prefills it from the connected account's `default_currency` only while the org is still at the default.

Statuses: `pending → confirmed | waitlisted | rejected`, plus existing `paid`, `withdrawn`, `expired`. `rejected` is terminal, only reachable in manual mode. Waitlist promotion stays oldest-first (existing `waitlistPositions`), with manual promote allowed.

## 4. Public flow — stepper + cart

Route stays `/shared/[orgSlug]/[competitionSlug]/register`. New client flow, server component wrapper as today.

- **Step 1 — Who.** Contact name + email. "I'm playing" toggle; dob/gender collected once, only if any division needs them or the registrant plays.
- **Step 2 — Entries.** Division cards with badges: category, age band, fee, capacity (`12/16` / `waitlist` / `closes <date>`). Adding an entry follows the division's `entrant_kind`: team (name it), pair, individual, free-agent (when `allow_free_agents`). Same division may appear twice (Team A, Team B). Divisions the registrant cannot enter *as a player* are greyed with the reason but stay pickable for team entries (a club rep is not the player).
- **Step 3 — Details.** Per entry: roster builder (typed or pasted, reusing today's `parseRoster`), per-player dob/gender fields only when required by the division, live per-player eligibility including the mixed-composition meter ("needs at least one of each gender"); custom `form_fields` answers; partner name for pairs. Free-agent entries need nothing extra.
- **Step 4 — Consent.** Privacy (required, versioned) — copy states names are public by default and opt-out is available anytime; media consent (optional); guardian block when the registrant is a minor. Notice that captain-entered players will be asked to confirm when they join/claim.
- **Step 5 — Review & pay.** Line items per entry. Submit runs one row-locked transaction: capacity re-checked per entry; entries flipping to waitlist are shown before payment and are **not charged** (pay on promotion, reusing `expires_at` machinery). One Stripe checkout for the payable subtotal, in the group's snapshotted org currency (single-currency cart by construction; the endpoint validates the currency ∈ `REGISTRATION_CURRENCIES` before minting the session — a clean 422, never a Stripe error on the public page). Honeypot + both rate-limit buckets kept.

**After submit:** group status page `/shared/.../register/status?ref=<GROUP_REF>` — per-entry status, roster fill meter, captain's copy-join-link, cancel entry.

**Join flow:** `/shared/.../register?join=<CODE>` → "Joining Team A · Mens Open" → steps 1+4 only → inserts a `registration_players` row (`source='self_joined'`, own consent, own dob/gender when required). Full roster → clean error. Rate-limited like registration.

**API:** new `POST .../register` accepting the group shape (zod: group contact + entries[] with players[]); replaces `PublicRegisterRequest` single-entry schema (old schema + endpoint deleted in P1 with the rest of the old surfaces). Join flow gets its own endpoint `POST .../register/join`.

Single-entry divisions ride the same stepper with a cart of one; step 2 collapses when the competition has one open division.

## 5. Org panel — Registration hub

New route `/o/[orgSlug]/c/[compSlug]/registration`, linked from the competition overview. Two tabs.

**Settings tab.** Division rows: status pill (open/scheduled/closed), window, capacity meter, fee, kind, category/age badges, approval mode, free-agent flag. Row opens the config panel: existing `registration_settings` fields plus category/age (writing to `divisions`), approval toggle, `allow_free_agents`; existing form-fields builder and payment section (`registration.paid` gate) fold into this panel. Currency is org-level: the panel shows a read-only currency chip linking to org settings — the select (codes + `Intl.DisplayNames` names, `REGISTRATION_CURRENCIES` only) lives on the org settings page, no per-division currency input anywhere. Per-division public register link with copy button.

**Registrants tab.** Cross-division table; filters: division, status, kind, free-agent, consent-pending; text search. Columns: name, division, kind (team shows roster fill `5/7`), status, payment, submitted. Row expands to: full entry, roster with per-player consent status, answers, cart siblings (same group). Actions: approve/reject (manual mode), withdraw, promote-from-waitlist, assign free agent → picker of that division's team entries (inserts into the team's `registration_players` / `entrant_members` when already materialized), copy join link, resend confirmation, CSV export.

Deletions (all in P1, since the schema change breaks them and prod has zero registration data): `/o/.../d/[divSlug]/registrations` route; `registrations-panel.tsx`, `registration-list.tsx`, old `registration-settings.tsx`; old public `register-form.tsx` + its endpoint/schema. Internal links (division page `routes.divisionRegistrations`, division page.tsx:225) are removed in P1 and re-pointed at the hub in P2 with the division pre-filtered via query param.

`/admin` bar does not apply — this is organiser-facing, full polish + mobile bar (320/768/1280, no horizontal scroll; new surfaces added to the `mobile.spec.ts` seven-width matrix).

## 6. Materialization (registration → entrant)

Unchanged in shape: confirm still creates `entrants` + `entrant_members` idempotently (`entrant_id` set once). Change: members now come from `registration_players` (with `person_id` created/linked at that moment) instead of roster jsonb. Free agents materialize as members of the team they were assigned to, or stay unmaterialized until assigned. Per-person name-public default lands in `persons.consent.public_name = true`; opt-out later flips it and public surfaces render initials (youth divisions keep `player_name_display` behavior).

## 7. Phasing (all shippable, no flags)

1. **P1 — schema + backend + old-surface removal.** Migrations (no backfill — prod is empty); the org-currency/allowlist delta (RS001b) follows as its own PR immediately after the base schema merges; group submit usecase + endpoint, join endpoint, per-player eligibility incl. mixed rule, approval transitions, waitlist pay-on-promotion path. All old registration surfaces deleted here (old form, old endpoint + zod schema, old org route + panel/settings components) because the schema change breaks them; the public register page renders its existing "registration closed/unavailable" state until P3.
2. **P2 — org hub.** Settings + Registrants tabs; organisers can configure divisions (category/age, approval, free agents) before the public flow exists. Registrants tab starts empty.
3. **P3 — public stepper.** New form wired to the P1 endpoint; registration surface live end-to-end.
4. **P4 — consent claim/opt-out surfaces + free-agent assignment UI + polish.** Cleanup of anything left.

Registration is intentionally unavailable to the public between P1 and P3 merges — acceptable because prod has zero registration usage today (owner-confirmed).

## 8. Testing

- **Unit:** group submit atomicity + capacity race (row-lock), per-player eligibility incl. mixed composition, approval transitions incl. `rejected`, join-code add + full-roster rejection, waitlist ordering, payable-subtotal computation.
- **E2E (Playwright):** multi-team cart with Stripe test payment; join link end-to-end; manual approval flow; hub actions (approve, promote, assign free agent); new public + hub surfaces in `mobile.spec.ts` (seven widths).
- **Smoke:** group registration happy path.
- **Regression:** existing single-entry divisions register unchanged via the stepper (cart of one).
- **Currency:** drift test (DB CHECK set == `REGISTRATION_CURRENCIES`); zero-decimal guard (every member is 2-decimal — fee math is `×100`); test-mode destination-charge checkout test per member; ONE live INR destination-charge verify in RS001b (owner-sanctioned) decides INR's membership.
- **i18n:** every new string in all 4 locale dictionaries; grep existing e2e assertions before changing any user-facing text.
- **Screenshots:** 1280 / 768 / 320 for both surfaces.

## 9. Non-goals

Consent ledger table, marketing consent, cross-competition carts, mandatory player accounts (claim stays optional), public team pages, any scheduling/engine change. Waitlist auto-promotion cron unchanged.
