// W5 T14b (owner 2026-11-18) - the pool-winners banner (division page) and strip (hub Table tab). Static markup only (node
// vitest, no DOM): testids, order, text and class tokens; no pixel is claimed here - the e2e walk and the screenshots own those.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { PoolWinner } from "@/server/public-site/champion";
import { poolWinnerLines } from "@/server/public-site/pool-winners";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { PoolWinnersBanner } from "../pool-winners-banner";
import { TableTab } from "../matches-hub/table-tab";
import { hubDoc, tableView } from "./hub-fixtures";

const DICTS = { en, es, fr, nl } as unknown as Record<string, Dict>;
const word = (locale: string, key: string) => (DICTS[locale] as unknown as Record<string, string>)[key]!;
const LONG = "Alexandria-Montgomery-Featherstonehaugh Wanderers Reserve XI";
const NAMES: Record<string, string> = { a: "Maya Kapoor", b: LONG, c: "Leo Ng" };
const winners = (...e: (string | null)[]): PoolWinner[] => e.map((entrantId, i) => ({ poolId: `p${i + 1}`, key: "ABCDEFGH"[i]!, entrantId }));
const lines = (w: PoolWinner[], locale = "en") => poolWinnerLines(w, DICTS[locale]!, (id) => NAMES[id] ?? "-");
const banner = (w: PoolWinner[], locale = "en") => renderToStaticMarkup(<PoolWinnersBanner lines={lines(w, locale)} dict={DICTS[locale]!} />);

describe("poolWinnerLines", () => {
  it("EMPTY: no winners -> no lines (never a phantom row)", () => {
    expect(poolWinnerLines(null, en as Dict, () => "x")).toEqual([]);
  });
  it("labels each pool from its KEY in the reader's locale and names the winner; a pool with none is null", () => {
    const l = lines(winners("a", null, "c"), "fr");
    expect(l.map((x) => x.label)).toEqual(["Poule A", "Poule B", "Poule C"]);
    expect(l.map((x) => x.name)).toEqual(["Maya Kapoor", null, "Leo Ng"]);
  });
});

describe("PoolWinnersBanner", () => {
  it("EMPTY: no lines -> nothing at all", () => {
    expect(renderToStaticMarkup(<PoolWinnersBanner lines={[]} dict={en as Dict} />)).toBe("");
  });

  it("one entry per pool in order, the heading once, ONE trophy, and never the word Champion", () => {
    const h = banner(winners("a", "b", "c"));
    expect(h).toContain('data-testid="division-pool-winners"');
    expect(h.split('data-testid="division-pool-winner"').length - 1).toBe(3);
    expect(h).toContain(">Group winners<");
    expect(h.indexOf(">Group A<")).toBeLessThan(h.indexOf(">Group B<"));
    expect(h.indexOf(">Group B<")).toBeLessThan(h.indexOf(">Group C<"));
    for (const n of ["Maya Kapoor", LONG, "Leo Ng"]) expect(h).toContain(`>${n}<`);
    expect(h.split("🏆").length - 1).toBe(1);
    expect(h).not.toContain(">Champion<");
    expect(h).not.toContain("division-title-champion");
  });

  it("a long name WRAPS (no truncate) inside a min-w-0 chain, one column at the smallest width", () => {
    const h = banner(winners("a", "b"));
    expect(h).not.toContain("truncate");
    expect(h).toContain("[overflow-wrap:anywhere]");
    expect(h).toContain("grid-cols-1");
    expect(h.split("min-w-0").length - 1).toBeGreaterThanOrEqual(4);
  });

  it("a pool without a single winner says so, and the other pools keep their winner", () => {
    const h = banner(winners("a", null));
    expect(h).toContain('data-testid="division-pool-winner-none"');
    expect(h).toContain(">No single winner<");
    expect(h).toContain(">Maya Kapoor<");
    expect(banner(winners("a", "c"))).not.toContain("division-pool-winner-none"); // the positive pair
  });

  it("every locale reads its own words (heading, pool label, no-winner line)", () => {
    let checked = 0;
    for (const locale of Object.keys(DICTS)) {
      const h = banner(winners("a", null), locale);
      expect(h, locale).toContain(`>${word(locale, "title.poolWinners")}<`);
      expect(h, locale).toContain(`>${word(locale, "table.poolLabel").replace("{key}", "A")}<`);
      expect(h, locale).toContain(`>${word(locale, "title.poolWinnerNone")}<`);
      checked++;
    }
    expect(checked).toBe(4);
    expect(new Set(Object.keys(DICTS).map((l) => word(l, "title.poolWinners"))).size, "four distinct headings").toBe(4);
  });
});

describe("the hub Table tab's pool-winners strip", () => {
  const doc = (poolWinners?: CompetitionHubDocT["poolWinners"]) =>
    hubDoc({
      tables: [tableView("g-a", "groups", { caption: "Group stage - Group A" }), tableView("g-b", "groups", { caption: "Group stage - Group B" }), tableView("other", "league")],
      ...(poolWinners ? { poolWinners } : {}),
    });
  const render = (d: CompetitionHubDocT) => renderToStaticMarkup(<TableTab doc={d} dict={en as Dict} />);
  const pw: NonNullable<CompetitionHubDocT["poolWinners"]> = [
    { divisionId: "d-groups", divisionSlug: "groups", pools: [{ poolId: "p1", label: "Group A", entrantId: "a", name: "Maya Kapoor" }, { poolId: "p2", label: "Group B", entrantId: null, name: null }] },
  ];

  it("a division with pool winners gets ONE strip, in its own group only; the other division gets none", () => {
    const h = render(doc(pw));
    expect(h.split('data-testid="mh-table-pool-winners-groups"').length - 1).toBe(1);
    expect(h).not.toContain("mh-table-pool-winners-league");
    expect(h.split('data-testid="mh-table-pool-winner"').length - 1).toBe(2);
    expect(h).toContain(">Group winners<");
    expect(h).toContain(">Maya Kapoor<");
    expect(h).toContain(">No single winner<");
    expect(h).not.toContain("mh-table-champion-");
  });

  it("without the field (an older cached document) the tab renders as before - no strip, no crash", () => {
    const h = render(doc());
    expect(h).not.toContain("mh-table-pool-winners");
    expect(h).toContain('data-testid="mh-table-heading-groups"');
  });
});
