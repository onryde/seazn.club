# RS005 — Registrants tab: cross-division list + actions

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS004's shell contract), then this. Org-panel UI session — load
`frontend-design:frontend-design`.

Branch `feat/rs005-registrants-tab` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §5 (Registrants tab).

## Why

The organiser's operational view: who registered, in what state, and the
levers (approve/reject, promote, withdraw). Built on RS002's `listRegistrations`
read model + transitions; the tab RS004 left as a designed placeholder.

## Scope

1. **Table**: columns name, division, kind (team shows roster fill `5/7`),
   status, payment, submitted-at. Filters: division, status, kind, free-agent,
   consent-pending; text search. Server-driven (the read model filters), URL
   state in query params so views are shareable. Sensible default sort
   (newest first), waitlist section shows position numbers.
2. **Row expand**: full entry — contact, dob/gender where present, answers
   (custom form fields), roster with per-player consent_status chips, cart
   siblings (other entries in the same group, linked), payment state, ref
   code, join code (team entries) with copy.
3. **Actions** (each wired to RS002 transitions, with confirm dialogs where
   destructive, optimistic UI where safe):
   - approve / reject — visible only when the division is `approval=manual`
     and status pending
   - withdraw (any non-terminal)
   - promote from waitlist (badge shows oldest-first candidate; explicit
     override allowed)
   - resend confirmation email (reuse the mailer RS001 preserved; if none
     survived, minimal re-add)
   - copy join link
   - CSV export (all current filters applied, server-generated, columns
     documented in the help page later — RS010)
4. **API**: org-side endpoints for list + transitions (session-auth'd,
   owner/admin), api-v1 pattern; openapi:gen.
5. **Empty state**: designed (no data exists in prod until RS006 ships) —
   points the organiser at the Settings tab + register link.

## Acceptance criteria

- [ ] Seeded fixture set (script or test seed: 2 divisions, mixed statuses,
      a group with 3 entries, a waitlist chain, a manual division) drives all
      of: filter combinations, expand, every action, CSV content — Playwright
- [ ] Approve on manual division → status confirmed + entrant materialized
      (assert the entrant appears in the division's entrants tab)
- [ ] Reject → terminal; the row shows it and approve is gone
- [ ] Promote respects oldest-first default and explicit override; paid
      division promote → pay-on-promotion state visible on the row
- [ ] Registrant counts on the hub nav card update
- [ ] ×4 locales; screenshots 1280/768/320; in the seven-width matrix
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — filter param parsing, CSV serialization, action authz.
- **E2E** — the seeded loop above + widths. **Smoke** — deferred RS010.
- **Regression** — reject-is-terminal; waitlist order display matches
  RS002's promotion order (placer/verifier-fork class of bug: ONE source).

## Gotchas

- The list is the READ path for the same rows RS002 mutates — reuse the
  usecase read model; a second SQL path here WILL drift (repo's recurring
  placer-vs-verifier bug class).
- Consent-pending filter: `registration_players.consent_status='pending'`
  EXISTS-join — index from RS001 covers it; check the plan on the seeded set.
- Fixture seeding: use the test schema, never `seed:demo` into a shared DB
  (it reds unrelated sweep suites).
- CSV: escape properly (names contain commas/quotes); assert bytes, not just
  status 200.

## Execution

Scout: entrants-tab rendering for the materialization assert, mailer
remnants, api-v1 org-side route conventions. One implementer loop; reviewer
focus: authz on every action route, read-model reuse (no forked SQL),
optimistic-UI rollback on 4xx, i18n.

## On close

`_INDEX.md`: RS005 → DONE + PR#, whether RS009's free-agent assignment can
fold into a light follow-up or needs its full session, mailer verdict.
Memory + snapshot.
