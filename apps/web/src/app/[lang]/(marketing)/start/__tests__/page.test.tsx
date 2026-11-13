import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// prerender, not renderToStaticMarkup: the shell nests async server components (MarketingNav awaits getCurrentUser).
import { prerender } from "react-dom/static";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The /start page hands its island only what it parsed (start-wizard redesign, plan 2026-11-13 Task 4; review-t3 m3/m4):
// the link's query through T3's `parseStartPrefill`, today from the server clock (UTC less one day), the free plan's cap
// and the quick match offer as live reads — each read failing soft. HTML assertions anchor on `="` (AGENTS.md).
//
// Producers (review focus 4): /play and the hero send a key, The Draw a name + size + format, older links a name + size +
// date; garbage of every field is dropped field by field.

const { getCurrentUser, cap, offer } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  cap: vi.fn<() => Promise<number | null>>(),
  offer: vi.fn(),
}));
vi.mock("next/font/google", () => ({ Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }) }));
vi.mock("@/lib/auth", () => ({ getCurrentUser }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/start",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/funnel", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/funnel")>()), funnelEntrantCap: cap }));
vi.mock("@/server/usecases/quick-match-sports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/quick-match-sports")>()),
  listQuickMatchSports: offer,
}));

import StartPage, { dynamic } from "../page";
import { parseStartPrefill } from "../prefill";
import { StartWizard, type StartWizardProps } from "@/components/start-wizard";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

type Search = Record<string, string | string[]>;

async function islandProps(search: Search, lang = "en"): Promise<StartWizardProps> {
  const root = await StartPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve(search) });
  const found: StartWizardProps[] = [];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === StartWizard) found.push(el.props as unknown as StartWizardProps);
    visit(el.props.children);
  };
  visit(root);
  expect(found, "the page mounts one wizard").toHaveLength(1);
  return found[0]!;
}

async function html(lang: string, search: Search = {}): Promise<string> {
  const { prelude } = await prerender(await StartPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve(search) }));
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const dict = (locale: Locale, file: "ui" | "marketing"): Record<string, string> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../dictionaries", locale, `${file}.json`), "utf8")) as Record<string, string>;
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const NOW = new Date("2026-11-13T00:30:00Z"); // Friday 00:30 UTC: still Thursday the 12th west of UTC.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  getCurrentUser.mockResolvedValue(null);
  cap.mockResolvedValue(64);
  offer.mockResolvedValue([{ sport_key: "badminton" }, { sport_key: "tabletennis" }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("/start hands the wizard only what it parsed", () => {
  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("every producer's link reaches the island as T3's parser reads it, and no raw value reaches it", async () => {
    const today = "2026-11-12";
    const rows: [string, Search][] = [
      ["/play and the hero (a key)", { sport: "tabletennis" }],
      ["the hero, ice hockey", { sport: "icehockey" }],
      ["The Draw's Make it real", { sport: "Football", entrants: "16", format: "groups-knockout" }],
      ["an older link", { sport: "Badminton", entrants: "8", date: "2026-11-21" }],
      ["garbage", { sport: "<script>x</script>", entrants: "1e3", date: "2026-02-30", format: "ladder" }],
      ["repeated", { sport: ["quidditch", "tennis"], entrants: ["12", "8"] }],
      ["nothing", {}],
    ];
    let checked = 0;
    for (const [label, search] of rows) {
      const props = await islandProps(search);
      expect(props.initial, label).toEqual(parseStartPrefill(search, today));
      expect(JSON.stringify(props.initial), `${label}: nothing raw`).not.toMatch(/script|quidditch|ladder|1e3|2026-02-30/);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // The rows are not all the empty answer (anti-vacuity: a parser reading nothing would pass the toEqual above).
    expect((await islandProps({ sport: "Football", entrants: "16", format: "groups-knockout" })).initial).toEqual({
      sportKey: "football",
      entrants: 16,
      date: null,
      format: "groups-knockout",
    });
  });

  it("today is the server's UTC day less one: a same-day link from west of UTC is kept, the day before is dropped", async () => {
    const props = await islandProps({ date: "2026-11-12" });
    expect(props.today).toBe("2026-11-12");
    expect(props.initial.date, "Thursday the 12th is still today in the Americas").toBe("2026-11-12");
    expect((await islandProps({ date: "2026-11-11" })).initial.date).toBeNull();
    vi.setSystemTime(new Date("2027-01-01T05:00:00Z"));
    expect((await islandProps({})).today).toBe("2026-12-31");
  });

  it("the cap and the quick match offer are the live reads; either failing is not a 500", async () => {
    const live = await islandProps({});
    expect(live.maxEntrants).toBe(64);
    expect(live.playSports).toEqual(["badminton", "tabletennis"]);
    expect(cap).toHaveBeenCalledTimes(1);

    cap.mockResolvedValueOnce(null);
    expect((await islandProps({})).maxEntrants, "unlimited").toBeNull();

    cap.mockRejectedValueOnce(new Error("db down"));
    offer.mockRejectedValueOnce(new Error("db down"));
    const down = await islandProps({});
    expect(down.maxEntrants).toBeNull();
    expect(down.playSports).toEqual([]);
  });
});

describe("/start's server HTML: the night wizard on its first question, in every locale", () => {
  it("opens on the link's sport, worded from the dictionaries, with no raw key and the no-script line", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const page = await html(lang, { sport: "tabletennis" });
      const words = { ...dict(lang, "marketing"), ...dict(lang, "ui") };
      expect(page, lang).toContain('data-start-wizard="true"');
      expect(page).toContain('data-step="sport"');
      // The chip the server writes checked is the link's sport (no script needed to see it).
      const checkedChips = (page.match(/<input[^>]*name="sport"[^>]*>/g) ?? []).filter((tag) => /\schecked=""/.test(tag));
      expect(checkedChips, lang).toHaveLength(1);
      expect(checkedChips[0]).toContain('value="tabletennis"');
      expect((page.match(/<input[^>]*name="sport"[^>]*>/g) ?? []).length, "every funnel sport is a chip").toBe(FUNNEL_SPORTS.length);
      for (const key of ["start.heading", "start.wizard.q.sport", "start.wizard.help.sport", "start.wizard.next", "start.wizard.noScript"]) {
        expect(page, `${lang} ${key}`).toContain(escapeHtml(words[key]!));
      }
      expect(page, `${lang}: the GET form names the page's own path`).toContain(`action="/${lang}/start"`);
      expect(page).not.toMatch(/start\.wizard\.|sport\.[a-z]+</);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});
