// Push nudges (spec 2026-11-24 §2.1, plan Task 5 / T1.3): what the beat suites serve `realtime` through — a stub port that
// records every mint — and the contract's own realtime facts, read from the PUBLISHED file the phone team vendors
// (docs/contracts/capture-beat.v1.json), never from the code under test.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CaptureRealtimePort } from "../stream-sessions";

type Json = Record<string, unknown>;
const CONTRACT = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../../../../docs/contracts/capture-beat.v1.json"), "utf8"),
) as Json;

/** Every node the published contract declares under a `realtime` key (one per answer branch that admits it). */
export function contractRealtimeNodes(): { description: string; properties: Record<string, Json> }[] {
  const found: { description: string; properties: Record<string, Json> }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === "realtime" && v !== null && typeof v === "object" && "properties" in (v as Json)) {
        found.push(v as { description: string; properties: Record<string, Json> });
      }
      walk(v);
    }
  };
  walk(CONTRACT);
  return found;
}

/** The beat answer's branches as the published file declares them: each `state` and whether it admits `realtime`. */
export function contractAnswerBranches(): { state: string; realtime: boolean }[] {
  const oneOf = ((CONTRACT.$defs as Record<string, Json>).answer!.oneOf ?? []) as Json[];
  return oneOf.map((b) => {
    const props = b.properties as Record<string, Json>;
    const state = props.state?.const;
    if (typeof state !== "string") throw new Error("an answer branch declares no state const");
    return { state, realtime: "realtime" in props };
  });
}

/** "Each token lives N minutes": the token's life the contract's prose promises the phone, in SECONDS. Every node states
 *  the same N, and at least one node is read (zero read is a failure, not a default). */
export function contractTokenSeconds(): number {
  const nodes = contractRealtimeNodes();
  if (nodes.length === 0) throw new Error("the contract declares no realtime node");
  const minutes = nodes.map((n) => {
    const m = /Each token lives (\d+) minutes/.exec(n.description);
    if (m === null) throw new Error("a realtime node's prose states no token life");
    return Number(m[1]);
  });
  if (new Set(minutes).size !== 1) throw new Error(`the realtime nodes disagree on the token life: ${minutes.join(", ")}`);
  return minutes[0]! * 60;
}

/** The url pattern every realtime node declares (all equal; at least one read). */
export function contractUrlPatterns(): string[] {
  return contractRealtimeNodes().map((n) => {
    const p = (n.properties.url as Json | undefined)?.pattern;
    if (typeof p !== "string") throw new Error("a realtime node's url declares no pattern");
    return p;
  });
}

/** The project the rig's port serves; the suites set NEXT_PUBLIC_SUPABASE_URL to it (the guard compares hosts). */
export const RIG_SUPABASE_URL = "https://rigproject.supabase.co";
export const RIG_ANON_KEY = "sb_publishable_rig_anon";

export type Mint = { pairingId: string; expiresAt: Date; token: string };
export type StubRealtime = CaptureRealtimePort & { mints: Mint[] };

/** A port whose every mint is recorded and recognisable (`rig-token.<n>.<pairing>.<expiresAt ms>`), so an answer's token
 *  can be traced to the one call that made it. `config` defaults to the rig's project; `mint` may be replaced (a throw). */
export function stubRealtime(opts: { config?: { url: string; apikey: string } | null; mint?: (pairingId: string, expiresAt: Date) => Promise<string> } = {}): StubRealtime {
  const mints: Mint[] = [];
  const config = opts.config === undefined ? { url: RIG_SUPABASE_URL, apikey: RIG_ANON_KEY } : opts.config;
  return {
    mints,
    config: () => config,
    async mint(pairingId, expiresAt) {
      const token = opts.mint
        ? await opts.mint(pairingId, expiresAt)
        : `rig-token.${mints.length + 1}.${pairingId}.${expiresAt.getTime()}`;
      mints.push({ pairingId, expiresAt, token });
      return token;
    },
  };
}
