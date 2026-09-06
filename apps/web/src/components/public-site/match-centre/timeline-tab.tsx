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
//    lookup. The guard is deliberately narrow — the param NAME must be one the
//    builder fills from an enum, the value must be a bare token, and the key
//    must actually exist — because the alternative failure (a club called
//    "Red" printing as "red", or an official's note saying "HT" becoming
//    "Half-time") is worse than an untranslated token.
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

/**
 * The param NAMES whose values are engine enum members.
 *
 * Narrowed from "any value that looks like a token": sniffing the value swept
 * up free text too, so an official's note reading "HT" — or any single
 * uppercase word in `{detail}` or `{text}` — was silently replaced with
 * "Half-time". The producer decides what a param MEANS, and these six are the
 * ones `buildTimeline` fills from an enum (`colour`, `kind`, `phase`, `key`,
 * `method`, `to`). Everything else passes through untouched, which is what
 * protects side names, person names and free text.
 *
 * `elected` — Task 14 (spectator surface W1) — is a seventh: the cricket
 * toss's `matchCentre.toss` Msg (`match-centre.ts`'s `buildCricketView`)
 * fills it from `card.toss.elected`, the engine's own `z.enum(["bat",
 * "bowl"])` (`packages/engine/src/sports/cricket/cricket.ts:242`), the same
 * shape as every other member here. Left out, a French/Spanish/Dutch reader
 * saw the bare English word "bat"/"bowl" inside an otherwise-translated
 * sentence — the 8b review gap this task's dispatch named. `term.bat`/
 * `term.bowl` were added to all four `public.json` files for it.
 *
 * `outcome` (football penalty/shot result — `ShotOutcome`/`PenaltyOutcome`,
 * `packages/engine/src/sports/football/football.ts:306,399`) and `level`
 * (`SetBasedSanctionLevel`, `packages/engine/src/sports/setbased/kernel.ts:
 * 219`) are the SAME shape — a bare engine enum token landing in a Msg param
 * — but were left OUT of this set deliberately: no `public.json` carries a
 * `term.<value>` key for any of their members (scored/saved/missed/blocked;
 * warning/penalty/expulsion/disqualification) in any locale, and this task's
 * own dispatch restricts it to the toss/enum keys it actually needs — adding
 * them here today would be a harmless no-op (an enum name with no matching
 * `term.*` key falls through to the raw value, same as before), not a fix.
 * Recorded for whichever task next adds those dictionary entries.
 */
const ENUM_PARAMS = new Set(["colour", "kind", "phase", "key", "method", "to", "elected"]);

/** Bare engine tokens only: letters, digits and underscores. Belt and braces
 *  beside the name check — an enum member never contains a space. */
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
    if (ENUM_PARAMS.has(name) && typeof value === "string" && TOKEN.test(value)) {
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

/**
 * The entrant chip. `min-w-[24px] px-0.5`, never a fixed `w-6`: it stays square for
 * the two- and three-character codes that are the common case, and GROWS for a
 * four-character one rather than spilling its glyphs outside the box. A fixed
 * 24px box is narrower than the widest label the abbreviation ladder can
 * produce (`public-site.ts`'s `BADGE_MAX_CHARS`), and every screenshot this
 * programme has taken happened to be cricket, whose team codes are three
 * characters — so the overflow was real and invisible at the same time.
 * Sizing to the CONTENT settles it without depending on anyone's measurement
 * of a font at 10px. `sets-tab.tsx`'s row badge is the same chip and carries
 * the same classes; they are two renderings of one object.
 *
 * `tabular-nums` is not decoration. A content-sized chip is only as wide as its
 * glyphs, and the disambiguation tie-break's whole output differs by exactly
 * one digit — `AND1` against `AND2`. Driving the real page measured those at
 * 30px and 32px, because "2" is wider than "1" in a proportional face, so the
 * two chips in the Sets table's stacked rows started their names 2px apart.
 * Tabular figures make every ordinal the same advance, which removes the
 * raggedness for exactly the case the tie-break creates.
 *
 * What `tabular-nums` does NOT fix, and is accepted: two sides whose labels
 * differ in LENGTH (`KY` against `ANDE`) still produce different widths. That
 * is inherent to sizing by content, and the alternative — one fixed width wide
 * enough for four characters — turns every two-character label into a lozenge.
 * The floor keeps the common case square; the ragged case is the rarer one.
 */
function SideBadge({ side, seq }: { side: SideT; seq: number }): ReactNode {
  return (
    <span
      data-testid={`mc-side-badge-${seq}`}
      title={side.name}
      className="inline-flex h-6 min-w-[24px] shrink-0 items-center justify-center rounded-md bg-accent/15 px-0.5 text-[10px] font-bold uppercase tabular-nums"
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
