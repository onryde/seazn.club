# W10 — sweep: privacy, Sentry, shadow invariants (lane)

**Goal.** When this wave is done a youth player's name can no longer leak
through a recap or weekly digest post, browser errors reach Sentry in
production, and the server quietly checks every real table, bracket and
pairing against the programme's invariants after each write — so a broken
table reaches the team before an organiser sees it. Four unrelated issues
(#858, #853, #843, and #878 itself) are closed along the way.

## Read first

- `_RULES.md` (R2, R5, R14a, R23, R25) and `_INDEX.md` (rulings 1, 21; the
  recommendation that #878 ships early from this lane).
- Design §7.3 (invariants with preconditions), §7.3a (anti-vacuity counts),
  §7.5 item 3 (production shadow invariants: log, never refuse, off the
  critical path), §8 (W10 row and lanes paragraph), §10.
- Audits: `audit-2026-09-27/ST-standings.md` (G22; G6 for the shared lines).
- Issues #878, #858, #853, #843. Memory: the #881 `/ingest` proxy note and
  "local server sends analytics to live PostHog".

## Prerequisites

A parallel lane (R2). **Before starting, list this lane's file set and prove it
disjoint from the wave in flight**, and record the proof in `_INDEX.md`.
Known collision: `apps/web/src/server/usecases/org-posts.ts` — ST-G22
(`:1077`, `:1263`) sits beside W5's ST-G6 (`:1070`, `:1256`). If W5 is in
flight, sequence ST-G22 with it.

Shadow invariants additionally need **#878 merged** (§7.5) and the harness's
invariant functions with anti-vacuity counts (W1a + W1b merged) — they reuse
those functions, not a copy.

## Scope

Routed items, copied from design §8, in this order:

**ST-G22 first** (recap/digest bypasses youth-name masking — a privacy defect),
#878 browser Sentry, then **production shadow invariants** (§7.5, reusing the
harness's invariant functions), #858 admin URL, #853 player card, #843 roster
i18n.

## Lifecycle (design §10)

1. Rulebook `rulebook-W10-sweep.md` (drafted when the lane starts: the masking
   rule ST-G22 must meet, and the shadow-invariant policy — which invariants,
   their preconditions, sampling, what is logged) → **sign-off**.
2. Reference: no format family; the shadow check reuses the harness invariants.
3. Truth run: reproduce ST-G22 end to end first — the audit marks it
   "inferred (masking path not traced end to end)" (R5). 4. Plan → implementer
   → reviewer; TDD; four test types; mutate every guard. 5. Gates. 6. No bench
   gate. 7. Drive, PR, e2e.

## Decisions owed (put to the owner as recommendations)

- **O6** — shadow-invariant policy (which invariants run in production, the
  sampling rate, the Sentry event's contents); the masking rule for posts if
  the consent model is silent on them.

## Done when

Ruling 19 on the lane's items: zero ❌ from them; nothing previously ✅/⛔ red
anywhere; §10.5 gates (four locales + `gen-keys` for #843, R23). Shadow
invariants proven by a deliberately broken table in a test environment reaching
Sentry — and by a write that is **not** refused or slowed when it fires.

## Traps

1. **A shadow invariant without preconditions pages on legitimate states**
   (§7.3): shared 3rd, joint winners, expunge, void, cut short, late entry. A
   noisy check gets muted, and a muted check is no check.
2. **Log, never refuse, off the critical path** (§7.5). Any throw escaping the
   check into the request is a production outage caused by a test.
3. **Anti-vacuity in production** (§7.3a): an invariant that checked zero
   items is a failure there too — log the count, or an empty table passes forever.
4. **The repo is public and Sentry payloads are data** (R14a): the event must
   not carry names, tokens or youth data — the very thing ST-G22 fixes.
5. **Local servers send analytics to live PostHog**, and #878's fix lives in a
   Turbopack/Sentry config path that `tsc` does not see — verify in a prod
   build that the client actually initialises, not that the file compiles.

## Output and handoff

Update the W10 row, the disjointness proof, decision log and "False premises
found" in `_INDEX.md` as they happen (R22).
