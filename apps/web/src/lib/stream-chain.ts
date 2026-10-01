// lib/stream-chain.ts — spec 2026-09-30 §3.2, the Signal-path table as ONE pure mapping. `SignalChain`
// (components/v2/stream-signal-chain.tsx) draws it; the Stream button's dot reads the same session through
// `streamButtonState` (T9b). No React, no clock: D3's 30 s are the SERVER's measure on the projection (M6).
import { destinationWarning, type StreamSessionView } from "@/lib/stream-session-view";

export type NodeTone = "slate" | "amber" | "lime" | "red";
export type LinkStyle = "idle" | "connecting" | "flowing" | "problem";
export type ChainWord =
  | "notConnected" | "ready" | "notLive" | "inUse" | "waiting" | "connected" | "receiving" | "live" | "connecting"
  | "notReceiving" | "noSignal" | "ending";
export interface ChainNode { tone: NodeTone; word: ChainWord; mark: "dot" | "bang" | null }
export interface Chain { phone: ChainNode; link1: LinkStyle; seazn: ChainNode; link2: LinkStyle; dest: ChainNode }

const node = (tone: NodeTone, word: ChainWord, mark: ChainNode["mark"] = null): ChainNode => ({ tone, word, mark });

type ChainView = Pick<StreamSessionView, "state" | "ingest" | "output">;

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
export function chainFor(view: ChainView | null, opts: { destInUse?: boolean } = {}): Chain | null {
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
      if (view.ingest && view.ingest.state !== "connected") {
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
