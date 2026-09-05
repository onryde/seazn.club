// Spectator surface W1, Task 13 — the Timeline tab: one localised line per
// recorded ledger event, newest first, for every sport that is not cricket.
//
// ---------------------------------------------------------------------------
// Not derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. THE ORDER IS THE DOCUMENT'S, NOT OURS. `buildTimeline` already sorts
//    newest first and puts a DERIVED line (a set won, a period ending)
//    immediately above the event that caused it — an ordering `seq` alone
//    cannot express, because those two lines share a `seq`. Re-sorting here on
//    `seq` would quietly undo it. So this maps and never sorts.
//
// 2. `localiseParams` IS THE FIX FOR A REAL GAP. `buildTimeline` puts engine
//    ENUM TOKENS into params verbatim — a card `colour` of "yellow", a tennis
//    point `kind` of "double_fault" — because its templates are one-per-event-
//    type and cannot branch per enum member. Left alone, a Dutch reader gets
//    "yellow kaart". Here each param value that has a `term.<token>` key is
//    swapped for that key's text, and everything else passes through UNCHANGED:
//    side names, person names and free text must never be mangled by a term
//    lookup. The guard is deliberately narrow — a bare token shape, and the key
//    must actually exist — because the alternative failure (a club called "Red"
//    printing as "red") is worse than an untranslated token.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { TabPanel } from "./tab-panel";

type Params = Record<string, string | number>;

export interface TimelineTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  /** Part of the shared panel signature; never read — see CommentaryTab. */
  data: LiveFixtureData;
}

/** Bare engine tokens only: letters, digits and underscores. A side name with
 *  a space, a dot or an accent can never reach the lookup. */
const TOKEN = /^[A-Za-z0-9_]+$/;

/**
 * Swap any param value that names an engine enum member for its localised
 * term, leaving everything else exactly as delivered. See note 2.
 *
 * Exported for its own unit tests: both branches matter, and the
 * passes-through branch is the one that protects real names.
 */
export function localiseParams(dict: PublicDict, params: Params | undefined): Params | undefined {
  if (params === undefined) return undefined;
  const out: Params = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "string" && TOKEN.test(value)) {
      // `lookup`, not `t` — `t` RETURNS THE KEY on a miss, so asking it whether
      // a term exists would answer "yes, it is `term.Red`" for every value.
      const term = lookup(dict, `term.${value}`);
      out[name] = typeof term === "string" ? term : value;
      continue;
    }
    out[name] = value;
  }
  return out;
}

const EMPHASIS_CLASS: Record<string, string> = {
  normal: "text-ink",
  score: "font-semibold text-ink",
  strong: "font-semibold text-accent",
};

function SideBadge({ side, seq }: { side: SideT; seq: number }): ReactNode {
  return (
    <span
      data-testid={`mc-side-badge-${seq}`}
      title={side.name}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold uppercase"
    >
      {side.short || side.name.slice(0, 3)}
    </span>
  );
}

export function TimelineTab({ doc, dict }: TimelineTabProps): ReactNode {
  const lines = doc.timeline ?? [];
  return (
    <TabPanel id="timeline" className="grid gap-1">
      <h2 className="sr-only">{t(dict, "matchCentre.timeline")}</h2>
      {/* See note 1: delivered order, preserved. */}
      {lines.map((line) => {
        const side = line.sideIndex === null ? null : doc.header.sides[line.sideIndex];
        return (
          <div
            key={`${line.seq}-${line.text.key}`}
            data-testid={`mc-timeline-line-${line.seq}`}
            data-emphasis={line.emphasis}
            className="flex items-start gap-2 border-b border-zinc-200/50 px-1 py-1.5 text-[13px] last:border-0"
          >
            {line.marker === null ? null : (
              <span
                data-testid={`mc-marker-${line.seq}`}
                className="w-12 shrink-0 tabular-nums text-[11px] text-ink-muted"
              >
                {line.marker}
              </span>
            )}
            <span className={`min-w-0 flex-1 ${EMPHASIS_CLASS[line.emphasis] ?? ""}`}>
              {t(dict, line.text.key, localiseParams(dict, line.text.params))}
            </span>
            {side === null ? null : <SideBadge side={side} seq={line.seq} />}
          </div>
        );
      })}
    </TabPanel>
  );
}
