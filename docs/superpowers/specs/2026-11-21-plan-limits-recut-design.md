# Plan limits re-cut: Community vs Pro, Event Pass dropped

**Status:** design approved by the owner, 2026-11-21 ("apply rec, drop event pass"; then "apply rec, drop totally": Event Pass removed completely, and team entrants do NOT count against `teams.max`). Implementation waits until W5 round-robin app PR B has merged ("write the design doc, but implement later").

**Lineage:**
- [entitlements v18](2026-09-08-entitlements-v18-w4-outcomes.md)
- the pricing re-cut of 2026-11-16 (PR #1239, V526)
- the W5 PR B stress findings F8 (per-format maximum entrants)

## 1. Intent

The owner wants more organisers to move from Community (free) to Pro. The push should come from growth (bigger events, more events, a regular season) and from Pro's leverage (lower fee, embeds, live updates, auto news, sponsor tiers). It must never come from a wall that hits in the middle of an event, or from anything a player sees.

The principle stands: **charge for leverage, never for correctness.**

## 2. Goals, non-goals, anti-goals

**Goals:**
- Tighten Community's size limits so that a real club season, an open, or several events at once needs Pro.
- Make Pro's size promise honest. Pro offers "up to the format's maximum", never a number the product cannot start.
- Show the limit and the saving BEFORE the organiser hits it.
- Remove Event Pass completely.

**Non-goals:**
- A plan-based limit on the NUMBER OF MATCHES. The owner said "leave it".
- A competition-wide entrant cap. Limits stay per division, because every heavy step (Start, locks, standings, the public page) is per division.
- Any change to scoring, stages, remote scoring, double elim, custom points or tie-breaks. These stay free on every plan, per the rulings of 2026-10-19/20 and 2026-11-02.
- New prices. The fee %, stream credits and AI credits stay as set on 2026-11-16.

**Anti-goals** (this fails even if it ships, if any of these happen):
- A player sees a paywall, an upgrade prompt or the word "plan".
- A running division is blocked. Late entry, Reinstate and a stage's progression keep working past the cap.
- A Pro organiser is promised a size the format cannot start.
- A price, limit or format name typed in two places that drift apart.

## 3. Decisions (owner-approved)

### 3.1 Limits

| Key | Community, before → after | Pro, before → after |
|---|---|---|
| `entrants.per_division.max` | 64 → **32** | 256 → **unlimited by plan**; the per-format technical maximum applies (§3.2) |
| `teams.max` (saved club teams, org-wide) | 8 → **16** | 100 (unchanged) |
| `competitions.max_active` | 3 → **2** | unlimited (unchanged) |
| `divisions.per_competition.max` | 4 (unchanged) | 20 (unchanged) |

What `teams.max` covers (verified 2026-11-21 on origin/main): it counts only saved teams in the club hierarchy (`usecases/teams.ts` `createTeam`) and bulk-imported teams (`usecases/imports.ts`). A team ENTRANT in a division does not create a `teams` row and does not count against it. The two limits are independent. The cut to 16 is about the club roster (two small leagues' worth of saved teams), not division size.

### 3.2 Per-format maximum (technical, the same on every plan)

This is built in W5 PR B, batch B4. A division's maximum entrants for a format is the largest n for which the engine's own fixture count for that format and shape fits the measured Start line budget. That budget is the most lines Start writes inside the request ceiling: Cloudflare cuts a request at about 100 s, and the budget keeps a margin under it.

Only the league (all-play-all) grows explosively:
- 512 entrants is 130,816 matches in a league;
- 511 in a knockout;
- about 1,023 in double elim;
- about 900 in groups → knockout;
- 2,304 in a 9-round Swiss, generated per round.

So in practice the league tops out around 100, and the other formats reach 512 or more once Start is set-based. A bigger server or database speeds the work up but does not remove the 100 s ceiling. Async Start would remove it. That is a later option and is not part of this design.

Effective cap = min(plan cap, format maximum). On Pro the plan cap is unlimited, so Pro's promise is "up to the format's maximum", shown with the number for the chosen format.

### 3.3 Where the organiser sees it

Only organisers (owners, admins, staff) see these prompts. Players never do.
1. **Builder, before the wall:** choosing a format shows "Community: up to 32 entrants · Pro: up to {formatMax}". On Pro it shows "Up to {formatMax} entrants for a {format}".
2. **At 80% full:** a quiet line on the division and registration desk: "{n} of {cap} places. Pro raises this to {formatMax}, and your card fee drops from 5% to 2%, saving about {saving} on this division." The saving is computed from the division's entry fee × entrants, using the same fee constants the price list uses. It only appears when the division has a card entry fee; otherwise the line names the size only.
3. **At the cap:**
   - Public registration closes with the ordinary "This division is full" notice. Nothing about plans is shown.
   - The organiser's desk shows the upgrade prompt, and the existing `entrants.per_division.max` refusal copy points to the upgrade page.
   - Adding an entrant by hand past the cap is refused with the same prompt.
4. **Never mid-event:** the cap is checked at create, registration, manual add and Start. Late entry into a running stage, Reinstate, a withdrawal-then-replacement, and progression into a later stage are NOT capped by plan. The technical format maximum still applies wherever lines are minted.
5. **Two active competitions (Community):** creating or publishing a third shows the upgrade prompt at that moment, the existing `competitions.max_active` door. Archiving or completing one frees a slot.

### 3.4 Event Pass removed

Event Pass is the one-time per-competition pass (rungs M and L; it is already off the public plan list).
- **Remove it:** the Stripe one-time price, the pass purchase flow, the pass rung in the entitlement resolver, the pass column in the pricing page and upgrade page, pass copy in all 4 locales, and the pass-to-Pro credit redemption (`server/usecases/pass-credit.ts`).
- **Dropped completely, not only its formats.** The pass is a paid one-off product, not a format, so no format is removed. Its knock-on effect: `formats.advanced` (Americano, ladder), which Pro and the pass both sold, becomes **Pro only**. A one-off organiser buys one month of Pro instead.
- **Prod has no customer passes:** prod data is the owner's own tests. Run a census before building: count the active pass grants. Zero means a hard delete, as `pro_plus` was in V290 and `business` before it, with no grandfathering. More than zero means the owner decides before the build starts.
- **One migration** deletes the pass plan rows and entitlement rows, and re-sets the Community numbers (§3.1). Take the next free version at build time (main is at V539 on 2026-11-21, and W5 PR B holds a pending V538 → V540+).
- **Copy-truth:** every pricing and feature sentence that names the pass, or quotes 64/256/8/3, is updated. This includes `lib/copy-truth.ts`, `lib/feature-copy.ts`, the pricing page, the help tree (English only) and the blog.

## 4. Approaches considered

1. **Plan-based match limit.** Rejected by the owner ("leave it"). It charges for event size, which is the event itself; it caps fee revenue on the largest events; and it bites mid-event, because late entry and progression add matches.
2. **A flat entrant number per plan, the same for every format.** Rejected. One number is too tight for knockouts or too loose for leagues (100 vs 130,816 matches at 512).
3. **Chosen:** smaller Community size limits plus a per-format technical maximum. Pro = up to the format maximum. Prompts before the wall, never mid-event, never to players.

## 5. Constraints

- **Entitlements live in the DB** (`plans`, `plan_entitlements`). The live catalog can differ from the migrations, so read prod (SELECT-only, standing OK) before writing the migration.
- **No entitlement pin tests** (owner standing rule). Test the BEHAVIOUR at the doors (cap and cap+1, the mid-event exemptions), not a table of the numbers.
- **Copy** goes in all 4 locale dictionaries; the help and blog trees are English only. Run `i18n:gen-keys`.
- **UI** at 320, 768 and 1280, with no horizontal scroll. `/admin` is 1280 only.
- **One PR,** after W5 PR B merges. Its migration is numbered at build time.

## 6. Left to the builder

- The exact component for the 80% line. Reuse the existing upgrade-gate and paywall patterns (`components/upgrade-gate.tsx`, the `paywallFeature` handling in `division-builder.tsx`).
- How the saving is rounded and formatted. Use the org's currency and existing money formatting.
- Whether the per-format maximum is shown as a number or a short sentence in the format picker, kept within the house theme.
- The census query and migration mechanics for removing Event Pass.

## 7. Acceptance

- Community: entrant 32 accepted, 33 refused, at create, registration, manual add and Start. Late entry and Reinstate past 32 on a running stage are accepted.
- Community: a third active competition is refused, and archiving one allows it.
- Community: saved team 16 accepted, 17 refused. A division's 20th team entrant is unaffected.
- Pro: a league at the format maximum is accepted, and +1 is refused with the technical reason, not an upgrade prompt.
- No player-facing page contains upgrade or plan copy. This is a sweep over the public registration and division pages, and must report a count, with zero counted as a failure.
- Event Pass: no route, price, copy or entitlement row remains. A grep over `apps/web/src`, the dictionaries and `content/` returns nothing (except migration history), and the pricing page shows two plans.
