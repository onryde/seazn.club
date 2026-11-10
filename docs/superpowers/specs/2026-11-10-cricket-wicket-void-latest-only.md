# A cricket wicket is voidable only while it is the latest ball; "Void back to here" for an older one

Owner ruling, 2026-11-10 ("apply rec", the controller's recommendation put to the owner). Status: built, PR
`feat(cricket): a wicket is voidable only while it is the latest ball; void back to here`.

## The question

An organiser scores 12/2 after two overs, a wicket falls in over 3, play goes on to 20/3, and the organiser voids the
wicket. What happens?

Reading the code, before this change:

- The server accepted it. `assertUndoTarget` (`apps/web/src/server/usecases/scoring.ts`) refused only a missing,
  already-voided or `core.void` target.
- The engine replayed the ledger without the wicket. `resolveVoids` (`@seazn/engine`, `core/events.ts`) strips the void and
  its target and folds the rest; it places no restriction on which earlier entry is voided.
- The result was a card that was no longer what was played. The over boundaries shift, the bowler rules (consecutive
  overs, the per-bowler maximum) are not re-checked on replay, the dismissed batter is no longer out, and the incoming
  batter keeps batting because later balls name him. (The fold test in
  `apps/web/src/lib/__tests__/cricket-wicket-void.test.ts` shows it: 7 for 0, with the four still credited to the batter
  who came in for a wicket that no longer happened.)

## The ruling

1. **A cricket wicket can be voided only while it is the latest active ball of the match.** Once any later active ball
   exists, its row shows no Void and the **server refuses** the void (`409 UNDO_WICKET_NOT_LATEST`), so scorer accounts,
   API keys and device links follow the same rule.
2. **"Void back to here"** on such a wicket's row in the organiser console voids every active entry newer than the wicket,
   newest first, then the wicket itself, after a confirm that names the count ("Voids 9 entries — re-score them after").
   Each void is the ordinary `core.void` of the then-latest entry, so the rule in (1) never blocks the sequence. If a step is
   refused (a scorer wrote meanwhile, a conflict), the sequence stops, the ledger is read again and the line says how many
   were voided.
3. Every other entry keeps today's per-row Void. "Void last entry" is unchanged. Decided/finalized behaviour is unchanged.

## How it is built

| Piece | Where |
|---|---|
| The rule, in one place for both sides: what carries a wicket, "behind a later ball", the ids to void back, the sequence runner | `apps/web/src/lib/cricket-wicket-void.ts` (pure; the pad bundle's purity gate allows it) |
| The server refusal | `assertUndoTarget`: one query adds `wicket` and `laterBall` to the target lookup; the refusal is the fourth terminal 409 of that function |
| The wire code | `UNDO_WICKET_NOT_LATEST` in `TERMINAL_CONFLICT_CODES` (`scorepad/transport.ts`; a resend is refused identically, so the pad must not renegotiate), `REFUSAL_KEY` (`refusal-copy.ts`) and `scoringErrorText` (the console's line, in the reader's language) |
| The ledger panel | `scorepad/v3/activity.tsx`: `activityRowState` gains `wicketBehindBall` and `canVoid` is false for it on every surface; `onVoidBack` (a prop, omitted on a device link) shows "Void back to here", armed and confirmed like Void |
| The console | `fixture-console.tsx`: `voidBack` runs `runVoidBack` over `post("core.void", ..., { expectedSeq })`, each step on the next seq, one resync at the end |
| Copy | `pad.activity.voidBack`, `pad.activity.voidBackHint`, `score.voidBackStopped`, `scorepad.refusal.undoWicketNotLatest`, in en/es/fr/nl |
| API docs | `docs/api-v1-breaking-changes.md` and the developers changelog |

### Decisions inside the ruling

- **"Later" means a later ACTIVE BALL** (`cricket.ball` or `cricket.superover.ball`), in any innings, super overs included.
  A wicket followed only by non-ball entries (a bowler change, a powerplay, a note) is still the latest ball and stays
  voidable. A later ball that is itself voided does not count. A ball in another fixture does not count.
- **Sport-scoped by the event type** (`cricket.*`); no engine change. Another sport's event that merely carries a `wicket`
  key is untouched.
- **The count in the confirm includes the wicket and every active entry after it, balls or not.** The non-ball entries are
  voided too, because the sequence must leave the ledger as it was before the wicket, not as a strange mixture. They are
  re-scored by hand after, as the confirm says.
- **A device link sees no control on such a row.** It cannot run the sequence (it voids only its own entries, one at a
  time), so the row shows neither Void nor "Void back to here". The organiser's console is where the sequence lives.
- **One resync, at the end.** Each step carries its own `expected_seq` (the ledger's last seq, then +1 per void), so a
  scorer who wrote in the middle makes the next step answer `SEQ_CONFLICT` and the sequence stops there.
- The terminal 409 is classified as terminal in the pad's transport: a resend of the same void is refused identically, and
  a queue head that could never succeed is the wedge W1 removed.

## What is not changed

- **The engine.** `resolveVoids` is untouched; the rule is the web's, at the door.
- Void of any other entry (a plain ball, a bowler change, a non-cricket event) and "Void last entry".
- A decided or cancelled fixture: the panel offers no void of any kind there, as before.
- Existing ledgers. A wicket already voided out of order stays voided; the fold still replays it the way it always did. The
  rule judges new writes only.
- No change to the pad's own take-back (the ribbon's single undo voids the latest entry, which the rule always allows).

## Tests

- `apps/web/src/server/usecases/__tests__/scoring-undo-wicket.test.ts` (real DB): the latest wicket, with a bowler change
  after it, is voidable; a wicket with a later ball is refused with the new code and, through `scoreEvent`, writes nothing;
  an older non-wicket ball is voidable; a voided later ball does not count; the void-back sequence passes step by step; a
  super-over wicket; another fixture's ball; another sport's `wicket` key; a null wicket.
- `apps/web/src/lib/__tests__/cricket-wicket-void.test.ts`: the predicates, `voidBackIds`, `runVoidBack` (order, seq, stop at
  the first refusal, empty), and the engine fold after a void back (3 for 0, equal to the pre-wicket scripted ledger).
- `apps/web/src/components/v2/scorepad/v3/__tests__/activity-void-back.test.tsx`: the row shows "Void back to here" and no Void;
  the latest wicket keeps Void; the confirm names the count; Cancel writes nothing; every locale has the copy.
- `apps/web/src/components/v2/__tests__/fixture-console-void-back.test.tsx`: the console sends one `core.void` per id,
  newest first, each on the next seq; a refused step stops and the line says "Voided 1 of 3 entries"; the server's own
  refusal reads in the reader's words; a decided fixture offers no sequence.
- Mutated once each: the server guard (three ways: removed, wicket test dropped, later-ball test dropped), the row condition
  in `activityRowState`, the "behind a later ball" predicate, the seq increment, the stop-on-refusal, and the console's
  decided-fixture gate. Each fails a test.
- `apps/web/e2e/scorepad-v3-cricket.spec.ts` ("voiding an OLDER event ... writes core.void for THAT event") voids the older of
  two plain balls, not a wicket, so it is unchanged. The browser claims (the row on a phone, the armed confirm at 320) are
  device-only and not made here.
