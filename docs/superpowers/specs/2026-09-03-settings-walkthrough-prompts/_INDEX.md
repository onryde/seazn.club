# Settings walkthroughs — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-03-settings-walkthrough-design.md`
- **W1 plan:** `../../plans/2026-09-03-settings-walkthrough-w1.md`
- **Branch:** `feat/settings-walkthrough`

## Why this programme exists

~105 settings controls across five surface families; seven existing tests that
change a value and assert it persisted; zero coverage of competition settings
or `/admin/settings`. Nearly every control is gated by a role or entitlement
check expressed as a client `disabled` prop, and `apps/web` vitest is
`environment: "node"` — it cannot see a rendered button's enabled state.

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1 | `/admin/settings` + 4 legacy redirects; `setOwnerStaffRoleSql` ships with it | Planned, not started |
| W2 | `/o/{org}/settings` 7 tabs — drive+persist (sponsors CRUD half) | Not started |
| W3 | `/o/{org}/settings` 7 tabs — gating matrix + first mutation sweep | Not started |
| W4 | `settings/{connect,credits,add-ons}`, billing's uncovered panels, sponsor monetize half | Not started |
| W5 | Competition settings — frozen, visibility, discoverable | Not started |
| W6 | Division schedule + constraints — full bounds table | Not started |
| W7 | Division registration settings — partial-save, money bounds | Not started |
| W8 | Fix wave + programme review + second mutation sweep | Not started |

W0 (foundations) was **folded into W1**, and `e2e/settings-support.ts` was cut
from it. A support module with no consumer is an inert seam: W1's only shared
helper needs `withDb`, so it belongs in `e2e/helpers.ts` beside
`setOwnerStaffSql`. `settings-support.ts` arrives in W2 with real consumers.

## Owner rulings

Rulings BY THE OWNER. Recommendations I made are in the next section and are
**not** interchangeable with these. Never carry either to a peer session as
the other.

1. **Scope is the whole programme**, all five surface families, both axes —
   not a thin slice and not one surface (2026-09-03).
2. **Walkthroughs must be optimized and fast** (2026-09-03). This is why the
   ≤60s budget and the seven speed rules in `_RULES.md` exist, and why the
   matrix's API half runs without a browser.
3. **Money paths run against the real Stripe sandbox**, using the connected
   account we already hold — `acct_1U8o7FBlv9TBkyYa` (2026-09-03).
4. **Sponsors is in scope** (2026-09-03), which is what split it across W2 and
   W4 — see the recommendation below.
5. **Subagent dispatches use Opus 5** (2026-09-03). Note this overrides
   `AGENTS.md`'s "never override `model:` on a dispatch".

## Recommendations I made (NOT owner rulings)

1. **Fix the two `/admin/settings` defects in W1 rather than W8.** The design
   says test-only through W7, but a knowingly-red test cannot sit in the CI
   leg for eight waves. Both fixes are a few lines on a staff-only surface.
   Owner has not ruled on this; flagged at handoff.
2. **`/admin` is de facto English-only.** `admin-platform-settings.tsx`
   hardcodes every string today. The repo rule says any new user-facing string
   ships to all four locale dictionaries, and `/admin` is not one of the two
   declared exceptions (`content/help/**`, `apps/web/src/games/**`). Adding
   one more hardcoded English string is consistent with the file and
   inconsistent with the rule. Needs an owner call.

## Findings

Recorded as they are found, not held to the end. Each is a hypothesis until
driven — see `_RULES.md` §8.

| # | Finding | Confidence | Wave |
| --- | --- | --- | --- |
| F1 | `/admin/settings` Save renders enabled for a `support`-role staff user; `PUT` throws `AuthError` → **401**. Page gates on `requireStaff()`, route on `requireSuperadmin()`, component's only `disabled` is `busy \|\| !valid`. | High — both files read | W1 |
| F2 | Clearing the fee input saves **0%**. `parsed = Number("") = 0`, so `valid` is true, the button stays enabled, and zod accepts 0. Platform cut zeroed by clearing a field and clicking Save. | High — read, not yet driven | W1 |
| F3 | `step={0.5}` is enforced by nothing. `valid` checks only finite/0–100, and the zod schema is `min(0).max(100)` with no `multipleOf`. `2.7` is accepted end to end. | High — read, not yet driven | W1 |

## False premises found

Recorded so the next session does not re-derive them.

1. **`AuthError` maps to 401, not 403.** A first draft of W1's gate test
   asserted 403. `lib/http.ts:34` returns 401.
2. **`setOwnerStaffSql` cannot express `support`.** It hardcodes
   `staff_role = 'superadmin'`. Testing the staff-but-not-superadmin gate
   needs a new `setOwnerStaffRoleSql(orgId, role)`.
3. **`/settings/*` are not pages.** All four are `redirect()` shims into
   `/o/{orgSlug}/settings/**`, and all four preserve their query string.
4. **`settings/billing` has almost nothing that is not Stripe.** An earlier
   scoping line said W4 would take "billing's non-Stripe controls"; the actual
   uncovered set is the billing-group panel, the operator console's per-org
   credit cap editor, promo apply/remove and the cancel-reason select.
