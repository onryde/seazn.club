// W2b design round, audit 3.1 (Important) — a double walkover credits nobody, but its summary still carries a 0 / 0
// pair of side lines. The division schedule (`schedule.tsx`), the results matrix and the share title already hide them
// ("would read as an unplayed match"); the hub's match card and knockout node (`hubHeader`) and the match centre's
// court card (`buildMatchCentre` → `header.scoreLines`) painted them — one result drawn two ways. Both builders now
// read the SAME reader the schedule does (`forfeitTag(...).kind === "double_walkover"`) and carry no score lines.
//
// Every outcome here is a REAL fold, swept over the sport registry: each sport that admits a double walkover before
// play is a case, and the premise (its summary DOES carry side lines) is asserted per case, so a sport whose summary
// had none could not pass vacuously. The pair: a one-sided walkover in the same sport keeps its credited lines.
//
// A sixth host the audit did not list, seen in the design round's 320 crop: the division bracket tile's forfeit footer
// (`public-site/bracket.tsx`) painted the summary's "0–0" headline beside "2× w/o". It now reads the same reader.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { foldMatchWithStoppage, outcomeOf, resolveVoids, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { buildMatchCentre, type MatchCentreInput } from "../match-centre";
import { hubHeader } from "../competition-hub";
import type { PublicFixture } from "../data";
import type { SideT } from "../match-centre-schema";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/public.json";
import { Bracket } from "@/components/public-site/bracket";
import { publicScheduleCopy } from "../schedule-copy";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { getDictionary } from "@/lib/i18n";
import { msg } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";

const EN = en as unknown as Dict;
type Module = (typeof builtinModules)[number];

function scene(m: Module, ledger: (l: ReturnType<typeof defaultLineupPair>) => { type: string; payload: unknown }[]) {
  const cfg = m.configSchema.parse(Object.values(m.variants ?? {})[0] ?? {});
  const l = defaultLineupPair(m.positions);
  const events: EventEnvelope[] = ledger(l).map((e, i) => makeEnvelope(i + 1, e));
  const f = foldMatchWithStoppage(m as never, cfg as never, l, events);
  const outcome = outcomeOf(m as never, f) as PublicFixture["outcome"];
  const sides: [SideT, SideT] = [
    { entrantId: l.home.entrantId, name: "Riverside FC", short: "RIV", colour: null, badgeUrl: null },
    { entrantId: l.away.entrantId, name: "Harbour United", short: "HAR", colour: null, badgeUrl: null },
  ];
  const fixture = {
    id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: l.home.entrantId, away_entrant_id: l.away.entrantId, home_slot_label: null, away_slot_label: null,
    scheduled_at: "2026-10-09T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
    status: "forfeited", outcome, summary: m.summary(f.state as never) as PublicFixture["summary"], last_seq: events.length,
    abandon_reason: null,
  } as PublicFixture;
  const input: MatchCentreInput = {
    fixture, sportKey: m.key, cfg, events: resolveVoids(events), lineups: { home: [], away: [] }, sides, venueTz: "UTC",
    locale: "en", now: new Date("2026-10-09T12:00:00.000Z"), hrefs: { division: "/d", competition: "/c", calendar: null },
    stage: null, moduleVersion: null, formatLabel: null, resolveMsg: (msg) => t(EN, msg.key, msg.params),
  };
  const summaryLines = sides.map((s) => fixture.summary?.perSide?.find((p) => p.entrantId === s.entrantId)?.line ?? null);
  return {
    outcome,
    fixture,
    summaryLines,
    hub: hubHeader(fixture, sides, m.key, "2026-10-09T12:00:00.000Z").scoreLines,
    centre: buildMatchCentre(input).header.scoreLines,
    l,
  };
}

const doubleWalkover = () => [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }];

/** The division bracket tile's forfeit footer row, as the public bracket renders it for this one fixture. */
async function bracketFooter(fixture: PublicFixture): Promise<string> {
  const dict = await getDictionary("en", "public");
  const h = renderToStaticMarkup(
    createElement(Bracket, {
      kind: "knockout", fixtures: [fixture], fixtureHref: (id: string) => `/f/${id}`, lookup: msg,
      entrantNames: Object.fromEntries([fixture.home_entrant_id!, fixture.away_entrant_id!].map((id, i) => [id, i === 0 ? "Riverside FC" : "Harbour United"])),
      slotText: (_stageId: string, label: never) => resolveSlotLabel(label, msg, "schedule.tbd"),
      copy: { ...publicScheduleCopy(dict, msg), forfeit: forfeitCopyOf((k) => t(dict, k)) }, tz: "UTC", locale: "en",
    }),
  );
  const at = h.indexOf('data-testid="bracket-forfeit"');
  if (at < 0) throw new Error("premise: the tile has no forfeit footer");
  return h.slice(at, h.indexOf("</span></span>", at) + 14);
}

describe("a double walkover paints no score lines on the hub card, the draw node or the court card (audit 3.1)", () => {
  it("every sport that admits one: its summary carries side lines (the premise), and no host shows them", async () => {
    const checked: string[] = [];
    const refused: string[] = [];
    for (const m of builtinModules) {
      let s: ReturnType<typeof scene>;
      try {
        s = scene(m, doubleWalkover);
      } catch {
        refused.push(m.key);
        continue;
      }
      if ((s.outcome as { kind?: string } | null)?.kind !== "double_walkover") {
        refused.push(m.key);
        continue;
      }
      expect(s.summaryLines.every((x) => typeof x === "string" && x !== ""), `${m.key}: premise — the summary carries a 0 / 0 to hide`).toBe(true);
      expect(s.hub, `${m.key}: hubHeader (match card, knockout node)`).toEqual([null, null]);
      expect(s.centre, `${m.key}: buildMatchCentre (court card)`).toEqual([null, null]);
      const headline = s.fixture.summary?.headline;
      expect(typeof headline === "string" && headline !== "", `${m.key}: premise — the summary carries a headline to hide`).toBe(true);
      const footer = await bracketFooter(s.fixture);
      expect(footer, `${m.key}: the bracket tile still carries its tag`).toContain('data-testid="bracket-forfeit-tag"');
      expect(footer, `${m.key}: the bracket tile (division bracket)`).not.toContain(`>${headline}<`);
      checked.push(m.key);
    }
    console.log(`audit 3.1 sweep: ${checked.length} sports checked (${checked.join(", ")}); not admitted: ${refused.join(", ") || "none"}`);
    expect(checked.length, `sports checked: ${checked.join(", ")}`).toBeGreaterThanOrEqual(5);
  });

  it("the pair: a one-sided walkover in the same sports keeps its credited lines on every host", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      let s: ReturnType<typeof scene>;
      try {
        s = scene(m, (l) => [{ type: "core.forfeit", payload: { by: l.away.entrantId, reason: "walkover" } }]);
      } catch {
        continue;
      }
      if ((s.outcome as { kind?: string } | null)?.kind !== "award") continue;
      if (!s.summaryLines.every((x) => typeof x === "string" && x !== "")) continue;
      expect(s.hub, `${m.key}: hub keeps the credited score`).toEqual(s.summaryLines);
      expect(s.centre, `${m.key}: court card keeps the credited score`).toEqual(s.summaryLines);
      expect(await bracketFooter(s.fixture), `${m.key}: the bracket tile keeps the credited headline`).toContain(`>${s.fixture.summary!.headline}<`);
      checked++;
    }
    expect(checked, `sports checked: ${checked}`).toBeGreaterThanOrEqual(5);
  });
});
