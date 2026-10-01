// Capture QR v2 §5.4 — the slot, DERIVED from the pairing and the open session; never stored. Pure.
//
// Order: the session rows come first. T19 (§5.5) names a slot `starting` or `armed` with no current pairing, so the
// session decides the slot whenever one is open; `empty` and `paired` describe a slot with no open session.
// §3: a "live slot" is one whose open session has received ingest (`first_ingest_at` is not null).
import { type SessionState, isActive } from "./session";

export type SlotState = "empty" | "paired" | "starting" | "armed" | "live" | "live_dead";

type SlotInput = { hasCurrent: boolean; open: { state: SessionState; firstIngestAt: Date | null } | null; dead: boolean };
const ingested = (i: SlotInput): boolean => i.open !== null && i.open.firstIngestAt !== null;

const SLOT_ROWS: readonly { when: (i: SlotInput) => boolean; slot: SlotState }[] = [
  // live (warming = a reconnect, live, ending), and live·dead when the A14 condition holds (T4).
  { when: (i) => ingested(i) && i.dead, slot: "live_dead" },
  { when: (i) => ingested(i), slot: "live" },
  { when: (i) => i.open?.state === "requested" || i.open?.state === "provisioning", slot: "starting" },
  { when: (i) => i.open?.state === "warming", slot: "armed" },
  // Two combinations §5.4 does not list (a spec gap, recorded for the controller):
  //  - `live` before `first_ingest_at` is recorded (a composed runner playing first): live — the phone is publishing,
  //    and a `waiting` answer would stop it;
  //  - `ending` with no ingest ever (stopped while starting or armed): starting — the phone waits rather than going
  //    live into a stop. Its next beat after the session ends hears `over`.
  { when: (i) => i.open?.state === "live", slot: "live" },
  { when: (i) => i.open?.state === "ending", slot: "starting" },
  { when: (i) => i.open === null && i.hasCurrent, slot: "paired" },
  { when: (i) => i.open === null, slot: "empty" },
];

export function slotState(i: SlotInput): SlotState {
  if (i.open !== null && !isActive(i.open.state)) {
    throw new RangeError(`slotState: a ${i.open.state} session is not open — pass null when the slot has no open session`);
  }
  const hit = SLOT_ROWS.find((r) => r.when(i));
  // Every active state is named above and `open === null` is the last row, so a miss is a new SessionState.
  if (hit === undefined) throw new RangeError(`slotState: no §5.4 row for ${JSON.stringify(i.open)}`);
  return hit.slot;
}
