// Match Day C7: the org Competitions home — the today deck, the quiet roster and its stub, the Show finished switch — rendered.
//
// The rules, from the owner's rulings (2026-11-01, progress.md lines 534-543), not from the code:
//  - the page is titled "Competitions"; "Matchday console" is gone everywhere; the Directory button is gone from this page (it
//    stays in the top nav, which the layout draws, not this page);
//  - a competition with matches TODAY stands out in the today deck and carries Open Match Day, linking the Match Day route; a
//    Draft one with matches today too; one with none today is a quiet card, never in the deck;
//  - with no match today anywhere the deck says so (its empty state) and offers no Open Match Day;
//  - sports come from the divisions: one named, two named, three or more as "N sports" with the full list in title/aria;
//  - a quiet card with no upcoming match shows B's stub ("No fixtures yet" / "No match scheduled"); the action in it is an
//    editor's — a viewer reads the stub and is offered nothing they cannot do;
//  - "Show finished" keeps finished competitions hidden by default; the switch shows them.
//
// "Today" itself — the clock, the zone, midnight — is decided by `competitionsFixturesToday` and pinned against a real database
// in match-day-home-today.test.ts. Here its answer is the input, and what is under test is what the page does with it.
//
// Rendered through react-dom/server (vitest runs `environment: "node"`, no jsdom), as org-home-pass-menu.test.tsx does.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { routes } from "@/lib/routes";
import type { NextFixture } from "@/server/usecases/card-stats";

type Stats = {
  competition_id: string;
  divisions: number;
  entrants: number;
  played: number;
  total: number;
  sports: string[];
  next: NextFixture | null;
};

const h = vi.hoisted(() => ({
  canEdit: true,
  locale: "en" as "en" | "fr",
  competitions: [] as Array<{ id: string; name: string; slug: string; status: string; ends_on: string | null }>,
  stats: new Map<string, Stats>(),
  today: new Map<string, number>(),
}));

vi.mock("@/server/page-auth", () => ({
  requireOrgPage: async () => ({
    auth: { orgId: "org-1", via: "session", userId: null, role: h.canEdit ? "owner" : "viewer", keyId: null },
    user: { id: "u-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: h.canEdit ? "owner" : "viewer" },
    canEdit: h.canEdit,
  }),
}));
vi.mock("@/server/usecases/competitions", () => ({
  listCompetitions: async () => ({ items: h.competitions, next_cursor: null }),
}));
// PARTIAL: `nextLine` stays real — the quiet card's "Next:" line is its answer.
vi.mock("@/server/usecases/card-stats", async (orig) => ({
  ...(await orig<typeof import("@/server/usecases/card-stats")>()),
  listCompetitionCardStats: async () => h.stats,
}));
vi.mock("@/server/usecases/match-day", () => ({
  competitionsFixturesToday: async (_auth: unknown, ids: readonly string[]) => ({
    day: "2026-11-08",
    tz: "Europe/Amsterdam",
    // Only what was asked for: a page that forgot to pass a competition must not be rescued by the stub.
    counts: new Map([...h.today].filter(([id]) => ids.includes(id))),
  }),
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[], ...vals: unknown[]) => {
    void vals;
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/entitlements", async (orig) => ({
  ...(await orig<typeof import("@/lib/entitlements")>()),
  orgPlanKey: async () => "pro",
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => h.locale }));
vi.mock("@/components/billing-banner", () => ({ BillingBanner: () => null }));
// <CardMenu> is a client popover that renders its items only once opened; here it says whose menu it is.
vi.mock("@/components/ui/card-menu", () => ({
  CardMenu: (p: { name: string }) => <span data-card-menu={p.name} />,
}));

import Page from "../page";

const en = uiEn as Record<string, string>;
const fr = uiFr as Record<string, string>;
const LOCALES: Record<string, Record<string, string>> = { en, fr, es: uiEs, nl: uiNl };

const comp = (slug: string, status: string, name = slug) => ({ id: `id-${slug}`, name, slug, status, ends_on: null });
const stats = (slug: string, over: Partial<Stats> = {}): Stats => ({
  competition_id: `id-${slug}`,
  divisions: 1,
  entrants: 4,
  played: 0,
  total: 6,
  sports: ["badminton"],
  next: { home: "Ann", away: "Bob", court_label: "Court 2", scheduled_at: "2026-11-08T14:10:00.000Z", in_play: false },
  ...over,
});

function seed(rows: Array<[ReturnType<typeof comp>, Stats, number]>) {
  h.competitions = rows.map(([c]) => c);
  h.stats = new Map(rows.map(([, s]) => [s.competition_id, s]));
  h.today = new Map(rows.filter(([, , n]) => n > 0).map(([c, , n]) => [c.id, n]));
}

const render = async (query: Record<string, string> = {}): Promise<string> =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve(query) }),
  );

/** The outer HTML of every element carrying `data-testid="<id>"`, in document order (balanced on its own tag name). */
function blocks(html: string, id: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(\\w+)[^>]*data-testid="${id}"`, "g");
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[1]!;
    let depth = 0;
    const tagRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
    tagRe.lastIndex = m.index;
    for (let t = tagRe.exec(html); t; t = tagRe.exec(html)) {
      depth += t[0].startsWith("</") ? -1 : t[0].endsWith("/>") ? 0 : 1;
      if (depth === 0) {
        out.push(html.slice(m.index, t.index + t[0].length));
        break;
      }
    }
  }
  return out;
}
const slugOf = (block: string) => /data-comp="([^"]+)"/.exec(block)?.[1];
const amp = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

beforeEach(() => {
  h.canEdit = true;
  h.locale = "en";
  seed([]);
});

describe("the org Competitions home — title, and what is gone", () => {
  it("is titled Competitions, with no 'Matchday console' eyebrow and no Directory button", async () => {
    seed([[comp("summer", "live"), stats("summer"), 0]]);
    const html = await render();
    expect(html).toMatch(new RegExp(`<h1[^>]*>${en["org.home.title"]}</h1>`));
    expect(en["org.home.title"]).toBe("Competitions");
    expect(html).not.toContain("Matchday console");
    expect(html).not.toContain('href="/directory"');
    expect(html).not.toMatch(/>Directory</);
    // The positive pair: the header's own action is still there.
    expect(html).toContain(`href="${routes.competitionNew("riverside")}"`);
  });

  it("'Matchday console' and its key are gone from every locale, and nothing reads the removed keys", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      expect(dict["org.home.eyebrow"], locale).toBeUndefined();
      expect(dict["org.home.directory"], locale).toBeUndefined();
      expect(Object.values(dict).some((v) => /matchday console/i.test(v)), locale).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the today deck", () => {
  it("puts every competition with a match today in the deck with Open Match Day — a Draft one too — and the rest in the roster", async () => {
    seed([
      [comp("cricket-cup", "published", "Cricket Cup"), stats("cricket-cup", { played: 26, total: 40 }), 3],
      [comp("city-open", "draft", "City Open"), stats("city-open"), 1],
      [comp("quiet-league", "live", "Quiet League"), stats("quiet-league", { played: 5 }), 0],
    ]);
    const html = await render();
    const deck = blocks(html, "org-home-today");
    expect(deck).toHaveLength(1);
    const rows = blocks(deck[0]!, "org-home-today-row");
    expect(rows.map(slugOf)).toEqual(["cricket-cup", "city-open"]);
    let checked = 0;
    for (const row of rows) {
      const slug = slugOf(row)!;
      const open = blocks(row, "org-home-open-match-day");
      expect(open, slug).toHaveLength(1);
      expect(open[0], slug).toContain(`href="${routes.competitionMatchDay("riverside", slug)}"`);
      expect(open[0], slug).toContain(en["desk.tools.openMatchDay"]);
      checked++;
    }
    expect(checked).toBe(2);
    // The Draft one is in the deck as a Draft: the chip still says so.
    expect(rows[1]).toContain('data-chip="draft"');
    // Nothing on today: a quiet card, and no Open Match Day anywhere on it.
    const cards = blocks(html, "org-home-card");
    expect(cards.map(slugOf)).toEqual(["quiet-league"]);
    expect(cards[0]).not.toContain("org-home-open-match-day");
    expect(html.match(/data-testid="org-home-open-match-day"/g)).toHaveLength(2);
    // The deck's line: the organisation's day, and how many competitions are on.
    expect(deck[0]).toContain("Sunday 8 November, 2 competitions with matches");
  });

  it("shows the match in the deck in the organisation's zone: 14:10Z is 15:10 in Amsterdam, and a live one reads Now", async () => {
    seed([
      [comp("a", "live"), stats("a"), 2],
      [comp("b", "live"), stats("b", { next: { home: "Cat", away: "Dan", court_label: "Court 1", scheduled_at: null, in_play: true } }), 1],
    ]);
    const [a, b] = blocks(blocks(await render(), "org-home-today")[0]!, "org-home-today-row");
    expect(a).toContain(">15:10<"); // UTC would print 14:10
    expect(a).not.toContain(">14:10<");
    expect(a).toContain("Court 2");
    expect(a).toMatch(/Ann.*vs.*Bob/);
    expect(b).toContain(`>${en["org.home.today.now"]}<`);
  });

  it("with no match today anywhere, the deck says so and offers no Open Match Day", async () => {
    seed([
      [comp("one", "live"), stats("one"), 0],
      [comp("two", "draft"), stats("two"), 0],
    ]);
    const html = await render();
    expect(blocks(html, "org-home-today")).toHaveLength(0);
    const empty = blocks(html, "org-home-today-empty");
    expect(empty).toHaveLength(1);
    expect(empty[0]).toContain(en["org.home.today.empty"]!.replace("{date}", "Sunday 8 November"));
    expect(html).not.toContain("org-home-open-match-day");
    expect(blocks(html, "org-home-card").map(slugOf)).toEqual(["one", "two"]);
  });

  it("groups the quiet roster: under way (live, or a match played) before not started", async () => {
    seed([
      [comp("fresh", "published"), stats("fresh"), 0],
      [comp("going", "published"), stats("going", { played: 2 }), 0],
      [comp("live-zero", "live"), stats("live-zero"), 0],
    ]);
    const html = await render();
    const groups = blocks(html, "org-home-group");
    expect(groups.map((g) => /data-group="([^"]+)"/.exec(g)?.[1])).toEqual(["underWay", "notStarted"]);
    expect(blocks(groups[0]!, "org-home-card").map(slugOf).sort()).toEqual(["going", "live-zero"]);
    expect(blocks(groups[1]!, "org-home-card").map(slugOf)).toEqual(["fresh"]);
  });

  it("speaks French in French: the deck's Open Match Day and its line", async () => {
    h.locale = "fr";
    seed([[comp("x", "live"), stats("x"), 1]]);
    const deck = blocks(await render(), "org-home-today")[0]!;
    expect(deck).toContain(fr["desk.tools.openMatchDay"]);
    expect(deck).toContain(amp(fr["org.home.today.title"]!));
    expect(deck).not.toContain(en["desk.tools.openMatchDay"]);
  });
});

describe("the sports line — from the divisions", () => {
  it("names one, names two, and reads 'N sports' from three, with the full list in the title", async () => {
    seed([
      [comp("s1", "live"), stats("s1", { sports: ["badminton"] }), 0],
      [comp("s2", "live"), stats("s2", { sports: ["badminton", "tennis"] }), 0],
      [comp("s3", "live"), stats("s3", { sports: ["badminton", "cricket", "tennis"] }), 0],
      [comp("s4", "live"), stats("s4", { sports: ["badminton", "cricket", "tennis", "football"] }), 0],
      [comp("s0", "live"), stats("s0", { sports: [] }), 0],
    ]);
    const cards = new Map(blocks(await render(), "org-home-card").map((c) => [slugOf(c), c]));
    const sports = (slug: string) => blocks(cards.get(slug)!, "org-home-sports");
    expect(sports("s1")[0]).toContain(">Badminton<");
    expect(sports("s2")[0]).toContain(">Badminton and Tennis<");
    expect(sports("s3")[0]).toContain(">3 sports<");
    expect(sports("s3")[0]).toContain('title="Badminton, Cricket and Tennis"');
    expect(sports("s3")[0]).toMatch(/class="sr-only"[^>]*>Badminton, Cricket and Tennis</);
    expect(sports("s4")[0]).toContain(">4 sports<");
    expect(sports("s4")[0]).toContain('title="Badminton, Cricket, Tennis and Football"');
    expect(sports("s0"), "no division, no sports line").toHaveLength(0);
  });
});

describe("B's stub on a quiet card", () => {
  it("reads 'No fixtures yet' with Set up the draw, 'No match scheduled' with Schedule matches, and nothing while a match is coming", async () => {
    seed([
      [comp("empty", "draft", "Empty Cup"), stats("empty", { total: 0, next: null, sports: [] }), 0],
      [comp("idle", "live", "Idle League"), stats("idle", { played: 3, next: null }), 0],
      [comp("busy", "live"), stats("busy", { played: 3 }), 0],
    ]);
    const cards = new Map(blocks(await render(), "org-home-card").map((c) => [slugOf(c), c]));
    const stub = (slug: string) => blocks(cards.get(slug)!, "org-home-stub");

    const [noFixtures] = stub("empty");
    expect(noFixtures).toContain('data-stub="no_fixtures"');
    expect(noFixtures).toContain(en["card.progress.none"]);
    expect(noFixtures).toContain(`href="${routes.competition("riverside", "empty")}"`);
    expect(noFixtures).toContain(`aria-label="${en["org.home.stub.setUpFor"]!.replace("{name}", "Empty Cup")}"`);

    const [noMatch] = stub("idle");
    expect(noMatch).toContain('data-stub="no_match"');
    expect(noMatch).toContain(en["org.home.stub.noMatch"]);
    expect(noMatch).toContain(`href="${routes.competitionSchedule("riverside", "idle")}"`);
    expect(noMatch).toContain(en["org.home.stub.schedule"]);

    expect(stub("busy"), "a match is coming: the card says Next, not the stub").toHaveLength(0);
    expect(cards.get("busy")).toContain(en["card.next.upcoming"]);
  });

  it("a viewer reads the stub but is offered no action", async () => {
    h.canEdit = false;
    seed([[comp("idle", "live"), stats("idle", { played: 3, next: null }), 0]]);
    const [s] = blocks(await render(), "org-home-stub");
    expect(s).toContain(en["org.home.stub.noMatch"]);
    expect(s).not.toContain("<a ");
  });
});

describe("Show finished", () => {
  const rows = (): Array<[ReturnType<typeof comp>, Stats, number]> => [
    [comp("running", "live"), stats("running"), 0],
    [comp("done", "completed"), stats("done", { played: 6, next: null }), 0],
    [comp("shelved", "archived"), stats("shelved", { next: null }), 0],
  ];

  it("hides finished competitions by default, and the switch says how many and is off", async () => {
    seed(rows());
    const html = await render();
    expect(blocks(html, "org-home-card").map(slugOf)).toEqual(["running"]);
    const [sw] = blocks(html, "org-home-finished-toggle");
    expect(sw).toContain('role="switch"');
    expect(sw).toContain('aria-checked="false"');
    expect(sw).toContain('href="/o/riverside?finished=1"');
    expect(sw).toContain(en["org.home.showFinished"]!.replace("{n}", "2"));
  });

  it("the switch on shows them, in their own group last, and turns back off to the plain page", async () => {
    seed(rows());
    const html = await render({ finished: "1" });
    const groups = blocks(html, "org-home-group");
    expect(groups.map((g) => /data-group="([^"]+)"/.exec(g)?.[1])).toEqual(["underWay", "finished"]);
    expect(blocks(groups[1]!, "org-home-card").map(slugOf)).toEqual(["done", "shelved"]);
    const [sw] = blocks(html, "org-home-finished-toggle");
    expect(sw).toContain('aria-checked="true"');
    expect(sw).toContain('href="/o/riverside"');
  });

  it("a finished competition stays hidden even with a match today (the deck is for competitions still running)", async () => {
    seed([...rows().slice(0, 1), [comp("done", "completed"), stats("done", { next: null }), 2]]);
    const html = await render();
    expect(html).not.toContain('data-comp="done"');
    expect(blocks(html, "org-home-today")).toHaveLength(0);
  });

  it("no finished competition: no switch at all; every one finished: the page says so and the switch is the way out", async () => {
    seed(rows().slice(0, 1));
    expect(await render()).not.toContain("org-home-finished-toggle");
    seed(rows().slice(1));
    const html = await render();
    expect(blocks(html, "org-home-all-finished")[0]).toContain(en["org.home.allFinished"]);
    expect(html).toContain('data-testid="org-home-finished-toggle"');
    expect(html).not.toContain("org-home-today-empty");
  });
});
