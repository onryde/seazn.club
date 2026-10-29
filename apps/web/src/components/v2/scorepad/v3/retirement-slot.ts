// W2e Task 32 (B2-3; D3 (3) as amended by D15; checklist M12b) -- "player injured, no replacement: the team plays short".
//
// `core.lineup.retirement` (a person off, nobody on) already existed in the engine and behind the HTTP door; no pad control
// sent it, which is why the catalogue carried M12b as a known no-path. This is that control for the four sports where a
// retirement changes something: football, volleyball, hockey and ice hockey (spec 6.2; cricket and generic have disposition
// rows instead -- CK-DV-3, GN-DV-1). It is COPIED FROM THE PERIOD PAD'S SWAP SLOT (`period-shared.ts`'s `buildSwap`): a
// `SwapSlot` per side, opened by a tile, whose picker is the swap sheet's OFF step -- and which stops there
// (`SwapSlot.offOnly`), because nobody comes on. One DOM for phone and desktop: it is an ordinary tile and an ordinary sheet.
//
// ONE PLACE, FOUR SKINS. The slot's event, reason, gate and id live here so the four pads cannot drift; what only a skin can
// know is passed in -- whether play is on (each sport's own phase vocabulary), the entrant, and WHO IS ON THE FIELD (football
// keeps its own live `onPitch`; `view.squads` is its frozen kickoff sheet, the staleness `SwapSlot.offCandidates` documents).
import { onFieldPersons } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import type { CandidateMeta, PadHostView, SwapSlot, TileSpec } from "./types";

type Side = "home" | "away";
const SIDES: readonly Side[] = ["home", "away"];

/** The one event this control sends. A kernel lineup event, so every sport's fold accepts it through `reduceLineupEvent`
 *  and `createSkinDispatch` admits it without the sport's spec declaring it (`KERNEL_DISPATCHABLE`). */
export const RETIREMENT_TYPE = "core.lineup.retirement";

/** What the pad records as the reason. The engine takes any non-empty string (`LineupRetirement.reason`); the control's own
 *  words are "injured", which is the thing a scorer is telling the ledger. */
export const RETIREMENT_REASON = "injured";

/**
 * The band at which the control appears -- the swap slot's own. `core.lineup.retirement` is a core event with no
 * `padSpec.fidelity` entry, so this is a pad policy, not an engine one: who is on the field is exactly the detail band 2
 * buys (`period-shared.ts`'s `SWAP_BAND`, which this must equal -- pinned equal in `__tests__/w2e-retirement.test.ts`, kept as
 * its own constant only because `period-shared.ts` imports THIS file for the hockey pads and the reverse import would be a
 * cycle).
 */
export const RETIREMENT_BAND: FidelityBand = 2;

/** The slot id, and the tile's `{swap: id}`. One per side. */
export function retireSlotId(side: Side): string {
  return `retire-${side}`;
}

/** The tile that opens a side's retirement picker. `minor`: it is the rarer action next to Sub, and the board's four columns
 *  are not the place for a second standard tile per side. The side is the sublabel, as every per-side tile on these pads. */
export function retirementTile(side: Side): TileSpec {
  return {
    id: retireSlotId(side),
    label: "pad.retirement.action",
    sublabel: side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away",
    kind: "minor",
    span: 2,
    phases: ["live"],
    action: { swap: retireSlotId(side) },
  };
}

export interface RetirementInput {
  /** Whether the sport's own phase says play is on: football's `PLAY_PHASES`, the period kernel's play phases, volleyball's
   *  `live`. The same gate each skin's swap slot is built under, which only that skin can read. */
  readonly inPlay: boolean;
  /** The side's entrant id, as the skin writes it into every other event's `by`. */
  readonly by: string;
  /** Who is on the field now. Defaults to the engine's own reader over `view.squads`; football passes its folded `onPitch`,
   *  because for football `view.squads` is the kickoff sheet and never moves. */
  readonly onField?: readonly string[];
  /** Row decoration (shirt number, captain) -- the swap sheet's own, so the picker reads like the Sub picker. */
  readonly candidateMeta?: Readonly<Record<string, CandidateMeta>>;
}

/**
 * The retirement slot for one side, or `null` when the control does not apply: below the swap band, outside play, or with
 * nobody on the field to retire. The tile is offered iff this is non-null (`retirementTilesOf`), so the two halves of the
 * control cannot disagree about whether it exists.
 */
export function buildRetirement(view: PadHostView, side: Side, input: RetirementInput): SwapSlot | null {
  if (!input.inPlay || view.band < RETIREMENT_BAND) return null;
  const onField = input.onField ?? onFieldPersons(view.squads[side]);
  if (onField.length === 0) return null;
  return {
    id: retireSlotId(side),
    // One question, asked once: the sheet has no ON step, so the ON label is never rendered.
    offLabel: "pad.retirement.off",
    onLabel: "pad.retirement.off",
    side,
    eventType: RETIREMENT_TYPE,
    policyOk: true,
    offOnly: true,
    offCandidates: onField,
    candidates: [],
    ...(input.candidateMeta === undefined ? {} : { candidateMeta: input.candidateMeta }),
    buildEvent: (off: string) => {
      // The pad never offers anyone else; a stray id is a caller defect, so it fails loudly here and never reaches the
      // ledger as an event the engine would refuse (`takeOff`: not on the field).
      if (!onField.includes(off)) throw new Error(`retirement: ${off} is not on the field for ${side}`);
      return { type: RETIREMENT_TYPE, payload: { side: input.by, personId: off, reason: RETIREMENT_REASON } };
    },
  };
}

/** The tiles for the sides that have a slot -- derived from the slots, never from a second condition. */
export function retirementTilesOf(slots: readonly (SwapSlot | null)[]): TileSpec[] {
  return SIDES.flatMap((side) => (slots.some((slot) => slot?.id === retireSlotId(side)) ? [retirementTile(side)] : []));
}

/** Both sides' slots, nulls dropped. */
export function retirementSlotsOf(view: PadHostView, input: (side: Side) => RetirementInput): SwapSlot[] {
  return SIDES.flatMap((side) => {
    const slot = buildRetirement(view, side, input(side));
    return slot === null ? [] : [slot];
  });
}
