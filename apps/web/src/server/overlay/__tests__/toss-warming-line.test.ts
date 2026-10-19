// R2005 change 11 — the warming card's toss line, for EVERY sport whose engine module declares a toss.
//
// #974 left a known gap: carrom declares `carrom.toss`, but the overlay read only cricket's, so after a recorded carrom
// toss the card still said "Toss pending" until play began. This sweep closes it for every toss sport at once:
//
//  - THE SET is the engine registry's — every `builtinModules` entry whose `eventSchemas` has `<key>.toss` — never the
//    app's `EVENT_KEY` table and never a hand list. A new toss sport with no row below fails the sweep by name.
//  - EACH ROW folds a REAL recorded toss through the engine (`foldFrom`, the loader's own pure half) and projects it
//    exactly as `load.ts` does (`projectOverlayLiveData` + the cricket bundle), then builds the line through the real
//    `warmingLine`. The expected copy is the en dictionary's own template for that sport's key, filled with the team
//    the toss names — the AWAY side, so a projection that always answers "home" cannot pass.
//  - THE SEQUENCE: no toss → pending; the toss → its sport's copy; the toss VOIDED → pending again.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import type { EventEnvelope } from "@seazn/engine/core";
import en from "@/dictionaries/en/public.json";
import { t } from "@/lib/i18n-runtime";
import { warmingLine } from "@/lib/overlay-openers";
import { overlayTossOf } from "@/lib/overlay-toss";
import { foldFrom } from "@/server/engine-db/fold";
import { projectOverlayLiveData } from "../project";
import { nameCricketBundle, overlayCricketBundleIds } from "../recent";

const dict = en as Record<string, string>;
const msg = (key: string, vars?: Record<string, string | number>) => t(dict, key, vars);
const SIDE_NAMES: [string, string] = ["Kings", "Royals"];
const START = "Sat 14:30";
const PENDING = msg("overlay.slate.warmingLineTossPending", { start: START });

type Lineups = ReturnType<typeof defaultLineupPair>;
/** Per toss sport: the payload its module's toss schema takes (naming the AWAY side), and the dictionary key + vars
 *  its line must read. Typed from each engine schema (`CricketToss`, `CarromToss`) and from the dictionaries. */
const ROWS: Record<string, { payload: (l: Lineups) => unknown; copy: (team: string) => [string, Record<string, string>] }> = {
  cricket: {
    payload: (l) => ({ wonBy: l.away.entrantId, elected: "bowl" }),
    copy: (team) => ["overlay.toss.wonAndElected", { team, choice: dict["overlay.toss.bowl"]! }],
  },
  carrom: {
    payload: (l) => ({ firstBreak: l.away.entrantId }),
    copy: (team) => ["overlay.toss.breaksFirst", { team }],
  },
};

const tossSports = builtinModules.filter((m) => Object.hasOwn(m.eventSchemas ?? {}, `${m.key}.toss`));

/** Fold `stream` and project it as `load.ts` does; then the warming line the stage would show. */
function lineAfter(sportKey: string, stream: ReadonlyArray<{ type: string; payload: unknown; voids?: string }>): string {
  const sportModule = builtinModules.find((m) => m.key === sportKey)!;
  const cfg = sportModule.configSchema.parse(SIM_CONFIGS[sportKey] ?? {});
  const lineups = defaultLineupPair(sportModule.positions);
  const envelopes: EventEnvelope[] = stream.map((e, i) => makeEnvelope(i + 1, { type: e.type, payload: e.payload } as never, e.voids));
  const folded =
    envelopes.length === 0 ? null : foldFrom("fx", { sportKey, module: sportModule, cfg, lineups, envelopes, stageKind: null });
  const cricket = nameCricketBundle(
    folded ? overlayCricketBundleIds({ sportKey, module: sportModule, cfg, lineups }, folded.active) : { live: null, toss: null, lastClosedOver: null, scoringStarted: false, highlights: null },
    () => undefined,
  );
  const data = projectOverlayLiveData({
    row: { status: "scheduled", summary: null, outcome: null, last_seq: folded?.lastSeq ?? null },
    folded,
    venueTz: "UTC",
    cricketLive: cricket.live,
    cricketToss: cricket.toss,
    lastClosedOver: cricket.lastClosedOver,
    scoringStarted: cricket.scoringStarted,
    highlights: cricket.highlights,
  });
  return warmingLine({ sportKey, toss: overlayTossOf(data), sideNames: SIDE_NAMES, startContext: START, msg });
}

describe("the warming card's toss line — every sport whose engine module declares a toss", () => {
  it("every registry toss sport has a row here (a new one fails by name)", () => {
    expect(tossSports.map((m) => m.key).filter((k) => !(k in ROWS)), "toss sports with no row").toEqual([]);
  });

  it("no toss → pending; the toss → that sport's own copy naming the team; the toss voided → pending again", () => {
    let checked = 0;
    for (const sportModule of tossSports) {
      const key = sportModule.key;
      const row = ROWS[key]!;
      const lineups = defaultLineupPair(sportModule.positions);
      const toss = { type: `${key}.toss`, payload: row.payload(lineups) };
      const [copyKey, vars] = row.copy(SIDE_NAMES[1]);
      const expected = msg(copyKey, vars);
      expect(expected, `${key}: the dictionary has ${copyKey}`).not.toBe(copyKey);

      expect(lineAfter(key, []), `${key}: no toss`).toBe(PENDING);
      const told = lineAfter(key, [toss]);
      expect(told, `${key}: the toss`).toBe(expected);
      expect(told, `${key}: names the team`).toContain(SIDE_NAMES[1]);
      expect(told, `${key}: never pending once tossed`).not.toBe(PENDING);
      expect(lineAfter(key, [toss, { type: "core.void", payload: {}, voids: "e-1" }]), `${key}: voided`).toBe(PENDING);
      checked++;
    }
    console.log(`toss sports checked: ${checked}`);
    expect(checked).toBe(tossSports.length);
    expect(checked, "the registry's toss sports are cricket and carrom today").toBeGreaterThanOrEqual(2);
  });

  it("the sports themselves: cricket and carrom both declare a toss (the set is not silently smaller)", () => {
    expect(tossSports.map((m) => m.key).sort()).toEqual(expect.arrayContaining(["carrom", "cricket"]));
  });
});
