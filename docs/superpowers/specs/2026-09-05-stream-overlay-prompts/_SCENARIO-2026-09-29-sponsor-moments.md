# Scenario — sponsor moments on the stream overlay (owner, 2026-09-29)

**Status: CAPTURED, scheduled AFTER R2 (composed video). Not designed, not in a wave.**
Owner: "Ok, store it and remember after R2 but make sure that we can extend easily."

## The ask
Push a sponsor card into the live stream at natural breaks, chosen by match events:
cricket after over 3 / every N overs / innings break; tennis and badminton at a set end or a changeover;
football at half-time.

## What already exists (checked 2026-09-29 at relay-d; re-verify before designing)
- `apps/web/src/components/overlay/moment-queue.ts` is a PURE reducer over a caller-supplied clock, with in/hold/out
  phases and moment ids `${seq}:${kind}`.
- `use-moment-queue.ts` is the hook around it. `lib/overlay-moments.ts` derives moments from score events.
- There is an end-of-over card (`overlay-end-of-over.tsx`) and a match/end slate (`overlay-slate.tsx`,
  spec `2026-09-12-overlay-match-card-layer-design.md`).
- No sponsor content, storage or rules exist anywhere.

## Why after R2
In R1, phone (passthrough) streams carry NO overlay, so sponsors would reach only OBS browser-source (Tier A) streams.
R2 composes the overlay into the video. Sponsors then reach phone streams too, and the cards survive in replays
and clips, which is what sponsors pay for.

## Extensibility requirements (owner: "make sure that we can extend easily")
1. **A sponsor card is just another moment kind**, and it goes through the SAME moment queue: same priority, never
   covering a score change, never mid-rally or mid-over. Do not build a second overlay pipeline.
2. **Triggers come from the engine's own declarations** (end of over, wicket, innings break, set end, changeover,
   half-time, and so on), exposed as a per-sport trigger vocabulary from the sport module. There is no hand-typed
   per-sport table in the overlay. A new sport gets sponsor triggers by declaring its breaks.
3. **The rule is data, not code**: `{trigger, every?/at?, duration, cooldown, priority, schedule window}`.
   New trigger kinds or rule fields must be additive, not a rewrite.
4. **Content is a provider seam**: org upload today (assets capability or storage), possibly a sponsor network later.
   Scope levels: org → competition → division → fixture, with the most specific winning.
5. **Placement uses slots, not a hardcoded position**: full-width slab, corner bug, lower third. Themes declare which
   slots they support (`theme-registry.ts`).
6. **Proof of display is a log**: `(fixture, sponsor, rule, shown_at, duration)`. It is the basis for sponsor reports
   and, later, YouTube viewer counts (needs "Connect with YouTube").
7. **Composed (R2) and OBS (Tier A) render the SAME moment stream**, so a card shows identically in both.

## Watch-outs
- Fatigue: cooldown plus breaks-only are as important as the triggers.
- YouTube's paid-promotion disclosure is the channel's checkbox. We remind the club; we cannot set it without OAuth.
- The scoring QR must never enter composited output (R3 scenario risk 2). The same applies to any sponsor
  "scan me" QR design: keep it separate from credentials.
- Plan gating: likely a paid-plan feature. It is the owner's call at design time.

## Next step when R2 lands
Brainstorm → spec → plan (superpowers:brainstorming), frontend-design skill, ≥2 UI options for the rules editor,
4 locales.
