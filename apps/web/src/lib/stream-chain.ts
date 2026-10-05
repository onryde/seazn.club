// lib/stream-chain.ts — spec 2026-09-30 §3.2, the Signal-path table as ONE pure mapping. `SignalChain`
// (components/v2/stream-signal-chain.tsx) draws it; the Stream button's dot reads the same session through
// `streamButtonState` (T9b). No React, no clock: D3's 30 s are the SERVER's measure on the projection (M6).
import {
  d3Warning, destinationWarning, phoneNoSignal, reconnectReasonOf, type StreamSessionView,
} from "@/lib/stream-session-view";
import type { StreamLostCountdown, StreamPhone } from "@/server/api-v1/schemas";

export type NodeTone = "slate" | "amber" | "lime" | "red";
export type LinkStyle = "idle" | "connecting" | "flowing" | "problem";
export type ChainWord =
  | "notConnected" | "ready" | "notLive" | "inUse" | "waiting" | "connected" | "receiving" | "live" | "connecting"
  | "notReceiving" | "noSignal" | "ending"
  // Capture QR v2 §6.12 (T11): the phone node's own words once the phone has a read model.
  | "paired" | "notAnswering" | "starting" | "reconnecting";
export interface ChainNode { tone: NodeTone; word: ChainWord; mark: "dot" | "bang" | null }
export interface Chain { phone: ChainNode; link1: LinkStyle; seazn: ChainNode; link2: LinkStyle; dest: ChainNode }

const node = (tone: NodeTone, word: ChainWord, mark: ChainNode["mark"] = null): ChainNode => ({ tone, word, mark });

type ChainView = Pick<StreamSessionView, "state" | "ingest" | "output">;

/** Capture QR v2 (T11): the phone's facts from the `stream-phone` read model, and the server's countdown (`current`).
 *  Passed only for a v2 session — a LEGACY one (C-1, pairing_id null) passes none and draws today's chain exactly. */
export interface CaptureFacts { phone: StreamPhone["phone"]; countdown: StreamLostCountdown | null }

/**
 * §6.12's phone node over §3.2's row. Only the PHONE node moves; every link, Seazn and the destination stay the table's.
 *  - Ready: Paired (lime) while present, Not answering (amber) while silent, Not connected with no phone;
 *  - waiting: Starting (amber) — unless the server counts down to ask 10 (`warming`, `phone_lost`): then the phone
 *    stopped checking in, and the node says so as the strip under it does — Not answering, with the "!" (B8 re-review
 *    item 1). The SAME fact as the strip's sentence (`current`'s countdown), never the read model's `present`: inside ask
 *    10's window the phone is not silent yet (§6.9's threshold IS ask 10's end). The warming timeout's countdown keeps
 *    Starting with no mark: that phone still checks in (the signed-off mockup's warming state). A warming RECONNECT
 *    counted down to W19 (`live`) is Reconnecting… with the "!", as live is;
 *  - live with the input not connected: "Reconnecting…" instead of "No signal". The "!" stays on the phone while the
 *    server counts down, is dropped while the phone still beats with a reason (the strip says it), and otherwise follows
 *    the D3 box as today.
 */
function capturePhone(view: ChainView | null, row: Chain, capture: CaptureFacts): ChainNode {
  if (!view) {
    if (!capture.phone) return row.phone;
    return capture.phone.present ? node("lime", "paired") : node("amber", "notAnswering");
  }
  switch (view.state) {
    case "requested":
    case "provisioning":
    case "warming":
      // A warming RECONNECT (§5.4: first ingest set) is counted down to W19's end, `live` — the strip says the video
      // stopped, so the node says Reconnecting…, as it does live.
      if (capture.countdown?.kind === "live") return node("amber", "reconnecting", "bang");
      return capture.countdown?.reason === "phone_lost" ? node("amber", "notAnswering", "bang") : node("amber", "starting");
    case "live": {
      if (!phoneNoSignal(view)) return row.phone;
      const bang = capture.countdown !== null || (d3Warning(view) === "phone" && reconnectReasonOf(capture.phone) === null);
      return node("amber", "reconnecting", bang ? "bang" : null);
    }
    default: return row.phone;
  }
}

export type PhoneDot = "lime" | "amber" | "slate";

/**
 * The folded "Paired · Show the code again" line's dot — the third voice beside the Phone node and the strip (B8
 * re-review ruling: the same defect class as the node). While the server counts down, it reads THAT fact, as they do:
 * amber exactly when the countdown is about a lost phone (ask 10, W19), lime while the phone still checks in (the warming
 * timeout). Never the read model's `present` then — in ask 10's window it is still true (§6.9's threshold IS ask 10's
 * end). With no countdown it is the read model's, as Ready's node is: present lime, silent amber, no phone slate; and
 * the timeout with the read model unread says nothing of a phone (slate).
 */
export function phoneDot({ phone, countdown }: CaptureFacts): PhoneDot {
  if (countdown?.reason === "phone_lost") return "amber";
  if (!phone) return "slate";
  if (countdown) return "lime";
  return phone.present ? "lime" : "amber";
}

/** The destination half while live: ok → flowing + red Live; not ok under 30 s (or not yet read) → animated + amber
 *  Connecting; not ok for 30 s or more (D3) → amber dashes + amber "!" Not receiving. */
function destinationHalf(view: ChainView): Pick<Chain, "link2" | "dest"> {
  if (view.output?.state === "ok") return { link2: "flowing", dest: node("red", "live", "dot") };
  if (destinationWarning(view)) return { link2: "problem", dest: node("amber", "notReceiving", "bang") };
  return { link2: "connecting", dest: node("amber", "connecting") };
}

/**
 * The chain for a session, or for none (idle). Null for completed and failed: those two keep their summary boxes and
 * draw no chain (§3.2).
 *
 * `destInUse` (mockup state 5): with no session, the PICKED destination is held by another match (a `target_in_use`
 * refusal on it) — the destination node says "In use". It is the idle row's only; a session draws its own destination.
 *
 * "Phone ingest stale" is `ingest.state !== "connected"` while live. A NULL ingest (a failed provider read, N1) is not
 * stale: nothing is decided on an unknown, which is the poll's own rule. For `ending` the phone and Seazn words stay as
 * they were, in slate — a slate "Connected" reads as "was connected", which is honest.
 */
export function chainFor(view: ChainView | null, opts: { destInUse?: boolean; capture?: CaptureFacts } = {}): Chain | null {
  const row = tableRow(view, opts);
  return row && opts.capture ? { ...row, phone: capturePhone(view, row, opts.capture) } : row;
}

function tableRow(view: ChainView | null, opts: { destInUse?: boolean }): Chain | null {
  if (!view) {
    return {
      phone: node("slate", "notConnected"), link1: "idle",
      seazn: node("slate", "ready"), link2: "idle",
      dest: node("slate", opts.destInUse ? "inUse" : "notLive"),
    };
  }
  switch (view.state) {
    case "requested":
    case "provisioning":
    case "warming":
      return { phone: node("amber", "waiting"), link1: "connecting", seazn: node("amber", "waiting"), link2: "idle", dest: node("slate", "notLive") };
    case "live": {
      const half = destinationHalf(view);
      if (phoneNoSignal(view)) {
        // The "!" follows the D3 box (controller ruling 2026-10-01, B5 re-review 2 n-2): past the hold with the phone
        // silent the box points at the phone (I-1), so the "!" sits on the PHONE node. The destination keeps its amber
        // "Not receiving" and its dashes — it is still not receiving; it is not the cause.
        if (d3Warning(view) === "phone") {
          return { phone: node("amber", "noSignal", "bang"), link1: "problem", seazn: node("amber", "waiting"), link2: half.link2, dest: { ...half.dest, mark: null } };
        }
        return { phone: node("amber", "noSignal"), link1: "problem", seazn: node("amber", "waiting"), ...half };
      }
      return { phone: node("lime", "connected"), link1: "flowing", seazn: node("lime", "receiving"), ...half };
    }
    case "ending":
      return { phone: node("slate", "connected"), link1: "idle", seazn: node("slate", "receiving"), link2: "idle", dest: node("slate", "ending") };
    case "completed":
    case "failed":
      return null;
  }
}
