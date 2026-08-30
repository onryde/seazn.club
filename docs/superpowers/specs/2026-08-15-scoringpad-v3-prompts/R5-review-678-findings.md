# R5 / PR #678 — review findings, 2026-08-30

Source: `/code-review medium 678`, run against `main...HEAD` plus the
uncommitted worktree. Recorded here rather than left in chat.

**Verification status is mine, not the reviewer's.** A finding is CONFIRMED
only where this file says I reproduced it. The rest are CLAIMED.

| # | Sev | File | Claim | Status |
|---|---|---|---|---|
| 1 | High | `skins/volleyball.tsx:828` | `fieldsTheRotation` reads `state.squads` but the engine is fed `view.squads`, which `pad-host.tsx:747` always materialises — so engine and skin take opposite branches, and the serve-anchor tile becomes permanent furniture for a rotation the engine can never resolve | CLAIMED |
| 2 | High | `skins/volleyball.tsx:1355` + `core/lineup.ts:485` | `buildLiberoEvent` stamps `exemption: "libero"` unconditionally and `liberoCandidatesFor` offers ANY bench member with `timesOff > 0`, so an ORDINARY player can be re-entered unlimited times on the libero's uncapped channel, bypassing FIVB 15.6 | **CONFIRMED, FIXED** — see below |
| 3 | Med | `skins/volleyball.tsx:873` | The extended anchor gate offers the tile mid-set where the engine cannot act: declaring the correct side changes nothing, declaring the other side blanks the server strip for the rest of the set | CLAIMED |
| 4 | Med | `skins/volleyball.tsx:1339` | Return position derives from the returning player's OWN `lastPositionKey`, never the slot being vacated — so picking OFF=libero, ON=a different returning player strands the player FIVB 19.3.2.3 requires back | CLAIMED |
| 5 | Med | `badminton.tsx:584`, `tabletennis.tsx:311`, `volleyball.tsx:474` | `big:` reads the OPEN game only and `pointsOf` returns 0 when none is open, so a DECIDED match shows a giant `0` vs `0` | CLAIMED |
| 6 | Low | `tabletennis.tsx:486` | Deuce clause tests `=== target - 1` exactly, so "Deuce" shows at 10-10 then vanishes at 11-11, 12-12 — where it matters most | CLAIMED |
| 7 | Low | `tabletennis.tsx:477`, `badminton.tsx:525` | `Math.min(gameNumber, bestOf)` still names a game nobody played on a decided match (best-of-5 at 3-0 reads "Game 4") | CLAIMED |
| 8 | Low | `tabletennis.tsx:1211`, `badminton.tsx:1215`, `volleyball.tsx:1499` | `join([scorer, server])` de-dupes nothing; in singles the same person is both whenever the server wins, so the row reads "Lin Dan · Lin Dan" | CLAIMED |
| 9 | Low | `lib/scoring-vocab.ts:692` | Badminton registers no `timeout` vocabulary on the reasoning that it is unreachable, but it IS reachable when `records.timeouts` is set; the ribbon then reads "badminton.timeout recorded". `pad.badminton.ribbon.timeout` missing from all four dictionaries | CLAIMED |
| 10 | Low | `e2e/tmpmeta.mobile.spec.ts` | A throwaway spec saying "delete before commit" was sitting in the worktree | **CONFIRMED, DELETED** |

## Reviewer checked and found clean

All `pad.*`/`scorepad.*`/`eventCopy.*` keys the three skins reference exist in
`en`, with es/fr/nl at exact parity. The `voids_event_id` fix end to end.
`serveTurnIndexOf`/`servePointsAtTurnStart` at the deuce and expedite pivots.
`resolveVoids` now degrading instead of throwing into render. The `anyExemption`
bypass in `bringOn` (only `REPLAY_LINEUP_POLICY` sets it, and that policy is
already `reentry: "unlimited"`). The `minor` tile 40→44px change.

## Note on #2 — this one is mine

The pad's own `liberoBlockedReason` was, incidentally, the thing blocking this
abuse path before this session: it refused any candidate with `timesOn >= 1`.
Making it return `null` (correct for a real libero, per FIVB 19.3.2.1) removed
the only guard, at the same time as the engine bypass removed the other one.
The fix is not to restore the count check — that would re-break the libero —
but to bound the EXEMPTION to transactions that actually involve the libero.


## #2 — CONFIRMED against the real engine, then fixed (2026-08-30)

Reproduced through the production path, not argued: `buildSwap(...).buildEvent(
anyOnField, "H-p3")` for an ORDINARY player who had already used FIVB 15.6's
one return was accepted by the real `reduceLineupEvent` — `probe.ok === true`.
No libero took part in the transaction at all.

**Fixed at the rule's home, not at the symptom.** `LineupExemption` grew
`requiresRole`, and volleyball declares `{ libero: { requiresRole: "libero" } }`.
An exemption is now EARNED rather than claimed: one of the two players must
carry the role, or the replacement is refused `exemption-role-absent` and the
ordinary count refusals apply again.

**EITHER player satisfies it, deliberately.** A libero replacement runs both
ways and both are 19.3.2.1 exchanges — the libero coming on for a back-row
player, and that player coming back on for the libero. A rule reading only the
incoming player would exempt the first and refuse the second, which is half of
normal play.

Cricket is untouched: `concussion` declares no `requiresRole`, because neither
the concussed player nor their replacement carries such a role.

**The pad states the same rule earlier.** The ON list is built before the OFF
pick, so the skin cannot ask "is one of these two the libero"; what it can ask
is whether such an OFF pick EXISTS — `liberoOnCourt`. An ordinary candidate is
greyed out with dedicated copy (`pad.volleyball.swap.refused.notLibero`, four
locales) when no libero is on court, so the refusal is never earned at the tap.

**A test premise died with it, and that is the interesting part.** The existing
MUTATION PROOF took "any real on-field player" as the OFF half, on the written
premise that the re-entry checks read only the incoming player. True when
written; false now. It named the libero instead, and says why.
