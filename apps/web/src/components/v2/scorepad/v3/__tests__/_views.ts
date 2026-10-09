// W2a Task 12 — a `PadHostView` for any sport, built from the REAL module fold (class 1: a hand-patched state
// proves the patch, not the pad). The underscore-prefixed sibling of `_cricket-fold.ts` / `_football-fold.ts`.
import { initSquads, type EventEnvelope } from "@seazn/engine/core";
import type { FidelityBand, ModuleEvent } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { foldClient } from "../../module-client";
import type { PadHostView } from "../types";

export interface LiveViewOpts {
  /** The fixture's stage kind; null (the default) is a fixture with no stage. */
  stageKind?: string | null;
  /** Parsed through the module's own `configSchema` — a sport with required cfg fields (generic) must pass them. */
  cfg?: Record<string, unknown>;
  /** The ledger to fold, in order. Default: `core.start` alone — phase live. Voids carry `voids` (the target's id is
   *  `e-<seq>`, seq counting from 1 in this list). */
  events?: readonly { type: string; payload: unknown; voids?: string }[];
  band?: FidelityBand;
  canOrganise?: boolean;
  personNames?: Readonly<Record<string, string>>;
  entrantNames?: PadHostView["entrantNames"];
}

export function liveView(sportKey: string, o: LiveViewOpts = {}): PadHostView {
  const sport = builtinModules.find((m) => m.key === sportKey);
  if (!sport) throw new Error(`liveView: no sport "${sportKey}" in the registry`);
  const cfg = sport.configSchema.parse(o.cfg ?? {});
  const lineups = defaultLineupPair(sport.positions);
  const events: EventEnvelope[] = (o.events ?? [{ type: "core.start", payload: {} }]).map((e, i) =>
    makeEnvelope(i + 1, { type: e.type, payload: e.payload } as ModuleEvent, e.voids),
  );
  const state = foldClient(sport, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: sport.summary(state as never),
    phase: "live",
    band: o.band ?? 3,
    entitlements: {},
    personNames: o.personNames ?? {},
    squads: initSquads(lineups),
    events,
    contextOverrides: {},
    stageKind: o.stageKind ?? null,
    canOrganise: o.canOrganise ?? true,
    entrantNames: o.entrantNames ?? {},
  };
}
