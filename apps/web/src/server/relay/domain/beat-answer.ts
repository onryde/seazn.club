// Capture QR v2 §6.3.3 — the beat answer. Pure. `beatAnswer` decides the state (first row that applies wins, the
// CLAIM_ROWS shape); `wireBeatAnswer` puts it on the wire as capture's R5 union (`CaptureBeatAnswer`, final).
// The use-case (T8b) sends exactly what wireBeatAnswer returns, and stores ITS pollSeconds as the answered cadence.
import type { CaptureBeatAnswer, CaptureStartedBy } from "@/server/api-v1/capture-schemas";
import { POLL_STARTING_SECONDS } from "../config";
import type { WireEndReason } from "./end-reason";
import type { ClaimOutcome } from "./pairing";
import type { SlotState } from "./slot";

export type BeatAnswerInput = {
  claim: ClaimOutcome | null;          // null when the beat carried no claim
  callerCurrent: boolean;              // judged BEFORE this beat's own `ended` is applied (§6.3.3 row 2)
  namedEnded: { sid: string; endReason: WireEndReason } | null;  // the beat's sid or stopped, if terminal
  slot: SlotState;
  open: { sid: string; startedBy: CaptureStartedBy } | null;
};
export type BeatAnswerCore =
  | { state: "taken" } | { state: "replaced" }
  | { state: "over"; sid: string; endReason: WireEndReason }
  | { state: "waiting"; starting: boolean }
  | { state: "go-live"; sid: string; startedBy: CaptureStartedBy }
  | { state: "live"; sid: string };

/** The open session the armed and live rows answer with. Those slots are derived FROM an open session (§5.4). */
const openOf = (i: BeatAnswerInput): NonNullable<BeatAnswerInput["open"]> => {
  if (i.open === null) throw new RangeError(`beatAnswer: slot ${i.slot} needs the open session, and open is null`);
  return i.open;
};

/** §6.3.3, first row that applies wins. Rows 1–2 before row 3 is G0-g: who holds the slot is answered first. */
const ANSWER_ROWS: readonly { row: number; when: (i: BeatAnswerInput) => boolean; then: (i: BeatAnswerInput) => BeatAnswerCore }[] = [
  { row: 1, when: (i) => i.claim?.result === "taken", then: () => ({ state: "taken" }) },
  { row: 2, when: (i) => !i.callerCurrent, then: () => ({ state: "replaced" }) },
  { row: 3, when: (i) => i.namedEnded !== null, then: (i) => ({ state: "over", sid: i.namedEnded!.sid, endReason: i.namedEnded!.endReason }) },
  { row: 4, when: (i) => i.slot === "empty" || i.slot === "paired", then: () => ({ state: "waiting", starting: false }) },
  { row: 5, when: (i) => i.slot === "starting", then: () => ({ state: "waiting", starting: true }) },
  { row: 6, when: (i) => i.slot === "armed", then: (i) => ({ state: "go-live", sid: openOf(i).sid, startedBy: openOf(i).startedBy }) },
  { row: 7, when: (i) => i.slot === "live" || i.slot === "live_dead", then: (i) => ({ state: "live", sid: openOf(i).sid }) },
];

/** A claim outcome already says whether the caller is current after it: accept/takeover (and T8's none) leave it current,
 *  taken/replaced do not. A caller that disagrees with its own claim would get the wrong row, so it is refused. */
const CURRENT_AFTER: Record<ClaimOutcome["result"], boolean> = { accept: true, takeover: true, none: true, taken: false, replaced: false };

export function beatAnswer(i: BeatAnswerInput): BeatAnswerCore {
  if (i.claim !== null && CURRENT_AFTER[i.claim.result] !== i.callerCurrent) {
    throw new RangeError(`beatAnswer: claim ${i.claim.row} (${i.claim.result}) contradicts callerCurrent=${i.callerCurrent}`);
  }
  const hit = ANSWER_ROWS.find((r) => r.when(i));
  // Every SlotState is named in rows 4–7, so a miss is a new slot state with no §6.3.3 row.
  if (hit === undefined) throw new RangeError(`beatAnswer: no §6.3.3 row for slot ${i.slot}`);
  return hit.then(i);
}

/** The common fields (§6.3.3): sent on EVERY 2xx, replaced and taken included (ask 1), although the contract only
 *  requires them on waiting, go-live, live and over. */
export type BeatAnswerCommon = {
  label: string; scheduledStart: number | null; autoAllowed: boolean; destinationName: string | null;
  overlayUrl: string | null; pollSeconds: number;
};

/** R5: one branch per state, each strict. Fields are picked by name, so a wider caller object never leaks a key onto the
 *  strict wire. Row 5 (`starting`) answers POLL_STARTING_SECONDS whatever cadence the caller computed. `device` is
 *  PR-2's (G0-e) and never sent here. */
export function wireBeatAnswer(core: BeatAnswerCore, common: BeatAnswerCommon): CaptureBeatAnswer {
  const fields = {
    label: common.label, scheduledStart: common.scheduledStart, autoAllowed: common.autoAllowed,
    destinationName: common.destinationName, overlayUrl: common.overlayUrl,
    pollSeconds: core.state === "waiting" && core.starting ? POLL_STARTING_SECONDS : common.pollSeconds,
  };
  switch (core.state) {
    case "waiting": return { state: "waiting", ...fields };
    case "go-live": return { state: "go-live", sid: core.sid, startedBy: core.startedBy, ...fields };
    case "live": return { state: "live", sid: core.sid, ...fields };
    case "over": return { state: "over", sid: core.sid, endReason: core.endReason, ...fields };
    case "replaced": return { state: "replaced", ...fields };
    case "taken": return { state: "taken", ...fields };
  }
}
