# Registration Redesign (RS) — session index

**One session per prompt file.** Read `_RULES.md`, then this file, then the
session's prompt. This file is the compaction anchor: every ruling, false
premise, and status change gets written here **as it happens**.

Design of record: `../2026-08-16-registration-redesign-design.md` (approved
2026-08-16 in the brainstorm session; owner rulings in its §2).

## Order

Main chain RS001 → RS002 → RS003 is sequential (schema → usecases → endpoints).
After RS003 two lanes are file-disjoint and may run in either order or
interleaved: **org lane** RS004 → RS005 → RS009, **public lane** RS006 → RS007
→ RS008. RS010 is last, after both lanes.

| Session | Prompt file | Depends on | Status |
|---|---|---|---|
| RS001 | `RS001-schema-and-demolition.md` | — | TODO |
| RS002 | `RS002-core-usecases.md` | RS001 | TODO |
| RS003 | `RS003-public-endpoints.md` | RS002 | TODO |
| RS004 | `RS004-hub-settings-tab.md` | RS003 | TODO |
| RS005 | `RS005-hub-registrants-tab.md` | RS004 | TODO |
| RS006 | `RS006-public-stepper.md` | RS003 | TODO |
| RS007 | `RS007-status-page-join-payments.md` | RS006 | TODO |
| RS008 | `RS008-consent-claim-optout.md` | RS007 | TODO |
| RS009 | `RS009-free-agents.md` | RS005, RS003 | TODO |
| RS010 | `RS010-closeout-e2e-smoke-help.md` | all | TODO |

Public registration is **intentionally down** between the RS001 and RS006
merges (owner-accepted; prod has zero registration usage). The register page
serves its closed/unavailable state during that window.

## Owner rulings (from the 2026-08-16 brainstorm — trust these)

1. **All three new public flows**: club rep registering N teams in one cart;
   player joining an existing team entry via link; free agents into team
   divisions.
2. **Org IA**: competition-level Registration hub (`/o/.../c/[compSlug]/registration`),
   Settings + Registrants tabs. Division-level registration route deleted.
3. **Eligibility first-class**: `divisions.category` (`open|mens|womens|mixed`,
   null = open) + `age_min`/`age_max`; badges on the public page; **every roster
   player validated**, not just the submitter; mixed ⇒ roster needs both
   genders (≥1 of each).
4. **Consent per person**; join/claim is the consent moment for players entered
   by someone else.
5. **Names public by default**; registering = consent to public name, stated in
   the consent copy; opt-out later → initials on public surfaces; youth
   divisions keep `player_name_display`.
6. **Approval**: per-division `auto` (default) | `manual`; new terminal status
   `rejected`.
7. **Public flow**: stepper + cart, one payment per cart; waitlisted entries
   are **never charged** at submit (pay on promotion).
8. **Greenfield, zero prod data**: no backfill, no flags, no compat shims; old
   surfaces deleted in RS001.

## False premises found

(none yet — record them here with the session that found them)

## Gotchas discovered

(none yet)
