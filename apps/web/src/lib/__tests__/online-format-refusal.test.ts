// Which formats cannot play Online Chess (spec 2026-11-23-online-chess-credits-design.md §3 decision 9, §8.1): Swiss and knockout events
// only. The organiser's screens grey the Lichess option on a format that holds a league, group or ladder stage, and grey those formats'
// cards on an online division, from the SAME rule the server's stage door enforces (`assertOnlineFormat`) - the sweep over every
// template asks the server as the second authority.
//
// The expected sets are typed from the spec's own words (Swiss and knockout events run; league, group and ladder do not), never read
// back from the module under test. Anti-vacuity: the sweep reports how many templates it checked, and the refused AND the allowed
// halves must each be non-empty (an all-refused or all-allowed answer proves nothing).
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { onlineRefusedKind, templateRefusedOnline } from "@/lib/online-format-refusal";
import { assertOnlineFormat } from "@/server/usecases/online-package/format";

/** Decision 9: Swiss and knockout events run online - Swiss, Swiss + play-off, Swiss + knockout, knockout, double elimination, the
 *  plate and the qualifying-into-main draw, which are knockouts. Typed from the spec. */
const RUNS_ONLINE = ["swiss", "swiss_playoff", "swiss_knockout", "knockout", "double_elim", "ko_plate", "qualifying_main"];
/** A league, a group or a ladder anywhere in the format refuses it; americano and mexicano are neither Swiss nor knockout. */
const REFUSED_ONLINE = ["league", "league_ko", "groups_ko", "group_only", "group_stepladder", "group_playoffs", "americano", "mexicano", "ladder"];

describe("onlineRefusedKind: the first stage kind Online Chess does not run", () => {
  it("names the first refused kind, in stage order, and null for a format that runs", () => {
    expect(onlineRefusedKind(["league", "knockout"])).toBe("league");
    expect(onlineRefusedKind(["swiss", "group", "ladder"])).toBe("group");
    expect(onlineRefusedKind(["ladder"])).toBe("ladder");
    expect(onlineRefusedKind(["swiss", "knockout"])).toBeNull();
    expect(onlineRefusedKind(["swiss", "page_playoff"])).toBeNull();
    expect(onlineRefusedKind(["knockout", "double_elim", "stepladder"])).toBeNull();
  });

  it("the empty case: a division with no stage yet has no format to refuse", () => {
    expect(onlineRefusedKind([])).toBeNull();
  });

  it("a kind nobody listed is refused (a new format runs online only when somebody says so)", () => {
    expect(onlineRefusedKind(["swiss", "some_future_kind"])).toBe("some_future_kind");
  });
});

describe("templateRefusedOnline: every format card, against the spec and against the server's stage door", () => {
  it("the typed lists cover every template exactly once (premise)", () => {
    expect([...RUNS_ONLINE, ...REFUSED_ONLINE].sort()).toEqual(STAGE_TEMPLATES.map((t) => t.key).sort());
  });

  it("refuses the spec's refused formats and runs the spec's Swiss and knockout formats", () => {
    let checked = 0;
    for (const key of REFUSED_ONLINE) {
      expect(templateRefusedOnline(key), key).toBe(true);
      checked += 1;
    }
    for (const key of RUNS_ONLINE) {
      expect(templateRefusedOnline(key), key).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(STAGE_TEMPLATES.length);
    expect(REFUSED_ONLINE.length).toBeGreaterThan(0);
    expect(RUNS_ONLINE.length).toBeGreaterThan(0);
  });

  it("agrees with the server's `assertOnlineFormat` over every template's own stage kinds", () => {
    let checked = 0;
    for (const t of STAGE_TEMPLATES) {
      const kinds = t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 }).map((s) => s.kind);
      let serverRefuses = false;
      try {
        assertOnlineFormat(kinds);
      } catch {
        serverRefuses = true;
      }
      expect(templateRefusedOnline(t.key), t.key).toBe(serverRefuses);
      checked += 1;
    }
    expect(checked).toBe(STAGE_TEMPLATES.length);
  });

  it("an unknown template key is not 'refused' (nothing to judge)", () => {
    expect(templateRefusedOnline("no_such_template")).toBe(false);
  });
});
