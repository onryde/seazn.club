import { afterEach, describe, expect, it, vi } from "vitest";
import offer from "@/lib/quick-match-offer.generated.json";
import { LOCALES } from "@/lib/i18n-constants";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { parseStartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import { HERO_SPORT_SELECT_ID } from "../hero-scenes";
import { HeroEventLink } from "../hero-event-link";

// The home hero's organiser door (start wizard plan 2026-11-13 Task 5): the quiet "Set up an event" link under the quick
// match Start follows the hero's Sport select, so /start opens on the sport the visitor picked. The select is the server's
// (the quick match form works with no script), so the link reads it the way the hero's art does (hero-vignette.tsx: its
// value is the snapshot, its `change` events the subscription). The server's HTML, and a page without the script, carry the
// plain `/<lang>/start`: there the select's choice is unknown, and a link that named the default would send the wrong sport
// after a change.
//
// Both ends are real: the link's own store against a select-shaped element the stubbed document hands out by the id the
// quick match form renders (pinned from QuickMatchCta's markup in hero-vignette.test.tsx), and /start's own parser
// (`parseStartPrefill`) reading what the link sends. Sports come from the offer's generated file (what the select lists).

const OFFERED = [...new Set(offer.offered.map((o) => o.sport_key))];
const TODAY = "2026-11-13";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeSelect(value: string) {
  const listeners = new Set<() => void>();
  return {
    value,
    addEventListener(type: string, fn: () => void) {
      if (type === "change") listeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === "change") listeners.delete(fn);
    },
    choose(next: string) {
      this.value = next;
      for (const fn of [...listeners]) fn();
    },
    get listening() {
      return listeners.size;
    },
  };
}
const onPage = (select: ReturnType<typeof fakeSelect> | null) =>
  vi.stubGlobal("document", { getElementById: (id: string) => (id === HERO_SPORT_SELECT_ID ? select : null) });

type LinkProps = { href: string; "data-testid"?: string; className?: string; children?: unknown };
const mount = (lang: string, hydrate: boolean) =>
  renderIsland(
    HeroEventLink,
    { lang, "data-testid": "hero-event-link", className: "min-h-11", children: "Set up an event" },
    undefined,
    { hydrate },
  );
/** The one link the door renders, and its props. */
function link(i: ReturnType<typeof mount>): LinkProps {
  const [root] = i.tree();
  expect(root, "the door renders a link").toBeDefined();
  return propsOf(root!) as LinkProps;
}
function arrival(href: string) {
  const url = new URL(href, "https://seazn.test");
  return { path: url.pathname, params: [...url.searchParams.keys()], sport: parseStartPrefill(Object.fromEntries(url.searchParams), TODAY).sportKey };
}

describe("HeroEventLink: the organiser's door follows the hero's Sport select", () => {
  it("the empty case first: the server's HTML (no script) is plain `/<lang>/start`, its words and testid passed through", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      onPage(fakeSelect("football"));
      const l = link(mount(lang, false));
      expect(l.href, lang).toBe(`/${lang}/start`);
      expect(l["data-testid"]).toBe("hero-event-link");
      expect(l.className).toBe("min-h-11");
      expect(l.children).toBe("Set up an event");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("no select on the page (the empty offer): plain `/<lang>/start`, subscribed to nothing, no throw", () => {
    onPage(null);
    expect(link(mount("en", true)).href).toBe("/en/start");
  });

  it("once the script runs it carries the select's sport, follows every change, and /start opens on each one", () => {
    const select = fakeSelect(OFFERED[0]!);
    onPage(select);
    const i = mount("en", true);
    expect(arrival(link(i).href), "the select's opening sport").toEqual({ path: "/en/start", params: ["sport"], sport: OFFERED[0] });
    expect(select.listening, "subscribed once").toBe(1);
    let checked = 0;
    for (const key of [...OFFERED.slice(1), OFFERED[0]!]) {
      select.choose(key);
      expect(arrival(link(i).href), key).toEqual({ path: "/en/start", params: ["sport"], sport: key });
      checked++;
    }
    // Anti-vacuity, and a differential: a door stuck on one sport cannot pass more than one.
    expect(checked, "offered sports swept").toBe(OFFERED.length);
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(select.listening, "still one listener").toBe(1);
    i.unmount();
    expect(select.listening, "unsubscribed on unmount").toBe(0);
  });

  it("a sport the browser restored into the select (back navigation) shows once hydrated, in the page's language", () => {
    onPage(fakeSelect("icehockey"));
    expect(link(mount("nl", true)).href).toBe("/nl/start?sport=icehockey");
  });

  it("a value /start would drop (blank, a sport the funnel does not list) is plain `/<lang>/start`", () => {
    const select = fakeSelect("badminton");
    onPage(select);
    const i = mount("fr", true);
    let checked = 0;
    for (const raw of ["", "generic", "quidditch"]) {
      select.choose(raw);
      expect(link(i).href, JSON.stringify(raw)).toBe("/fr/start");
      checked++;
    }
    expect(checked).toBe(3);
    select.choose("tennis");
    expect(link(i).href, "and back to a sport").toBe("/fr/start?sport=tennis");
  });
});
