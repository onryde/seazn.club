"use client";

// X-SR-6 + review M-3: the line under a bracket stage's rules that says a LEVEL match will wait for the organiser.
//
// Two modes, never both, and neither is a rule written here - both are read off the engine:
//   - "off":   every decider the stage's cfg carries is switched off, so a level match is held (lot, seed or the
//              organiser's call). `decidersAllOff` reads the public line's own on/off table.
//   - "level": a decider is on and a match can STILL end level behind it (extra time with no shoot-out, an overtime with
//              no shoot-out, a super over that may tie again). `SportModule.canEndLevel` answers, through
//              `bracketMayEndLevel`; the web holds no table of which deciders settle a match.
// It is given the RESOLVED cfg (`resolvedStageCfg`, after the sport's bracket overlay), never the stage's raw rules, so
// chess - whose bracket forces its tie-break on - is not called "off" over an empty stored list (carry G1).
import { useMsg } from "@/components/i18n/dict-provider";
import type { StageKind } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { deciderNotice } from "./stage-row-model";

export function DecidersNotice({
  module,
  kind,
  resolved,
}: {
  module: AnySportModule;
  kind: StageKind;
  /** The stage's resolved cfg, or null when the schema refuses it (a half-typed edit): then nothing is said. */
  resolved: Record<string, unknown> | null;
}) {
  const msg = useMsg();
  if (resolved === null) return null;
  const mode = deciderNotice(module, kind, resolved);
  if (mode === null) return null;
  return (
    <p
      role="status"
      data-testid={mode === "off" ? "stage-deciders-off" : "stage-deciders-level"}
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900"
    >
      {msg(mode === "off" ? "stageRules.decidersOff" : "stageRules.decidersMayEndLevel")}
    </p>
  );
}
