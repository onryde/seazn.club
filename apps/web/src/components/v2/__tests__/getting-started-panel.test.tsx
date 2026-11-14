// The getting-started panel (/start "Sent stepper", owner-approved 2026-11-14, mock sss14a section 4): where the funnel claim
// lands, the five steps carried on from the Sent screen, each ticked from the getting-started read, the first step not done
// highlighted with its way on. Driven with the read stood in (it is the DB half, tested in getting-started.test.ts) and the
// real dictionaries in every locale.
//
// Expected values: the step states are the rule (lib/getting-started-steps.ts, restated in its own test); the words are the
// dictionary files on disk; the links are the console's URLs, typed here (the org's settings, the division's entrants tab
// at its add form, its fixtures tab, its schedule page); the date is Intl's in the locale.
// Sport: not applicable — the panel reads no sport (the steps are the same for every sport).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GettingStarted } from "@/server/usecases/getting-started";

const read = vi.hoisted(() => ({ funnelGettingStarted: vi.fn() }));
vi.mock("@/server/usecases/getting-started", () => read);
const logged = vi.hoisted(() => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/server/logger", () => logged);

import { GettingStartedPanel, type GettingStartedPanelProps } from "../getting-started-panel";
import { GettingStartedStepper, type StepperItem } from "@/components/getting-started-stepper";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";

const dictOf = (locale: Locale): Dict =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "ui.json"), "utf8")) as Dict;
/** A dictionary sentence with its slots filled — read from the file, never from the panel. */
const w = (dict: Dict, key: string, vars: Record<string, string | number> = {}) => {
  const raw = dict[key];
  if (typeof raw !== "string") throw new Error(`test: no ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), raw);
};

const AUTH = { orgId: "org-1", via: "session", userId: "user-1", role: "owner", keyId: null } as const;
const HREF = {
  rename: "/o/acme/settings",
  players: "/o/acme/c/open/d/singles?tab=entrants#add-entrant",
  generate: "/o/acme/c/open/d/singles?tab=fixtures",
  schedule: "/o/acme/c/open/d/singles/schedule",
} as const;

const props = (locale: Locale, patch: Partial<GettingStartedPanelProps> = {}): GettingStartedPanelProps => ({
  auth: AUTH,
  competition: { id: "comp-1", name: "Riverside Open", starts_on: null },
  orgSlug: "acme",
  compSlug: "open",
  divSlug: "singles",
  courts: 0,
  entrantKind: "individual",
  dict: dictOf(locale),
  locale,
  ...patch,
});
const progress = (patch: Partial<Omit<GettingStarted, "entrants">> & { count?: number; target?: number | null } = {}): GettingStarted => {
  const { count = 0, target = 8, ...rest } = patch;
  return { orgRenamed: false, fixturesGenerated: false, fixtureScheduled: false, ...rest, entrants: { count, target } };
};

function findAll(node: ReactNode, test: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, test, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (test(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, test, out);
  return out;
}
const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join("")
    : isValidElement(node)
      ? textOf((node.props as { children?: ReactNode }).children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";

async function render(locale: Locale, p: GettingStarted | null, patch: Partial<GettingStartedPanelProps> = {}) {
  read.funnelGettingStarted.mockResolvedValue(p);
  const tree = (await GettingStartedPanel(props(locale, patch))) as ReactNode;
  const steppers = findAll(tree, (el) => el.type === GettingStartedStepper);
  return { tree, steppers, items: steppers.length === 1 ? ((steppers[0]!.props as { items: StepperItem[] }).items) : [] };
}

beforeEach(() => {
  read.funnelGettingStarted.mockReset();
  logged.log.error.mockReset();
});

describe("hidden: a competition no /start draft built, or one with a match scheduled", () => {
  it("renders nothing, and reads the caller's own competition", async () => {
    let checked = 0;
    // null: the read stopped at the draft (no /start draft built it, review I2); no target; a match on the schedule.
    for (const p of [null, progress({ target: null }), progress({ fixturesGenerated: true, fixtureScheduled: true, count: 8, orgRenamed: true })]) {
      const { tree } = await render("en", p);
      expect(tree, JSON.stringify(p)).toBeNull();
      expect(read.funnelGettingStarted).toHaveBeenLastCalledWith(AUTH, "comp-1");
      checked++;
    }
    expect(checked).toBe(3);
    expect(logged.log.error, "nothing failed").not.toHaveBeenCalled();
  });

  it("a read that fails renders nothing and is logged, so the division page around it never 500s (review I2)", async () => {
    const boom = new Error("connection reset");
    read.funnelGettingStarted.mockRejectedValue(boom);
    const tree = await GettingStartedPanel(props("en"));
    expect(tree).toBeNull();
    expect(logged.log.error).toHaveBeenCalledTimes(1);
    expect(logged.log.error.mock.calls[0]![0]).toMatchObject({ event: "getting_started_failed", competitionId: "comp-1", err: boom });
  });
});

describe("step 3 names what the division takes: players, teams or pairs (review m2)", () => {
  // The kind is the division's default entrant kind (the engine's entrant model, as the page computes it); the words are
  // the dictionary's, one family per kind.
  const KINDS = [
    ["individual", "start.next.players.title", "start.next.players.progress", "start.next.action.players"],
    ["team", "start.next.teams.title", "start.next.teams.progress", "start.next.action.teams"],
    ["pair", "start.next.pairs.title", "start.next.pairs.progress", "start.next.action.pairs"],
  ] as const;

  it("every kind in every locale: the title, the count and the way on", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      for (const [kind, title, count, action] of KINDS) {
        const { items } = await render(locale, progress({ orgRenamed: true, count: 3 }), { entrantKind: kind });
        const step = items.find((i) => i.key === "players")!;
        const label = `${locale} ${kind}`;
        expect(step.title, label).toBe(w(dict, title));
        expect(step.hint, label).toBe(w(dict, count, { count: 3, target: 8 }));
        expect(step.action, label).toEqual({ href: HREF.players, label: w(dict, action) });
        checked++;
      }
      // The three families are three different sentences in this locale (a copy-paste across kinds would pass the above).
      expect(new Set(KINDS.map(([, , count]) => w(dict, count, { count: 3, target: 8 }))).size, locale).toBe(3);
    }
    expect(checked).toBe(LOCALES.length * KINDS.length);
  });
});

describe("shown: the current step carries its way on, in every locale", () => {
  // [the read, the current step, the ticks count]
  const CASES: readonly [string, GettingStarted, keyof typeof HREF, number][] = [
    ["just claimed (the empty case): rename", progress(), "rename", 1],
    ["renamed, no players: add players", progress({ orgRenamed: true }), "players", 2],
    ["renamed, field full: generate", progress({ orgRenamed: true, count: 8 }), "generate", 3],
    ["renamed, generated: schedule", progress({ orgRenamed: true, count: 8, fixturesGenerated: true }), "schedule", 4],
  ];

  it("one stepper; only the current step has an action, and it links to where the step is done", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      for (const [title, p, current, done] of CASES) {
        const label = `${locale} ${title}`;
        const { tree, steppers, items } = await render(locale, p);
        expect(steppers, label).toHaveLength(1);
        expect(items.map((i) => i.key), label).toEqual(["open", "rename", "players", "generate", "schedule"]);
        expect(items.find((i) => i.state === "current")?.key, label).toBe(current);
        expect(items.filter((i) => i.action !== undefined).map((i) => [i.key, i.action]), label).toEqual([
          [current, { href: HREF[current], label: w(dict, `start.next.action.${current}`) }],
        ]);
        // The header: the competition's name, and the ticks out of five.
        expect(textOf(tree), label).toContain(w(dict, "start.next.landing.title", { name: "Riverside Open" }));
        expect(textOf(tree), label).toContain(w(dict, "start.next.landing.done", { done, total: 5 }));
        // The steps' words are the dictionary's; step 3 counts the field against the target.
        expect(items.map((i) => i.title), label).toEqual(["open", "rename", "players", "generate", "schedule"].map((k) => w(dict, `start.next.${k}.title`)));
        expect(items.find((i) => i.key === "players")!.hint, label).toBe(
          w(dict, "start.next.players.progress", { count: p.entrants.count, target: 8 }),
        );
        expect((steppers[0]!.props as { tone: string; across: boolean }).tone).toBe("light");
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * CASES.length);
  });

  it("step 5 names the club's courts and the first day when there are some, and neither when not", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
        new Date("2026-11-21T00:00:00Z"),
      );
      const courtsWord = w(dict, `start.next.courts.${new Intl.PluralRules(locale).select(3)}`, { count: 3 });
      const rows: [Partial<GettingStartedPanelProps>, string][] = [
        [{ courts: 3, competition: { id: "comp-1", name: "Riverside Open", starts_on: "2026-11-21" } }, w(dict, "start.next.schedule.courtsDate", { courts: courtsWord, date: day })],
        [{ courts: 3 }, w(dict, "start.next.schedule.courts", { courts: courtsWord })],
        [{ courts: 0, competition: { id: "comp-1", name: "Riverside Open", starts_on: "2026-11-21" } }, w(dict, "start.next.schedule.date", { date: day })],
        [{ courts: 0 }, w(dict, "start.next.schedule.plain")],
      ];
      for (const [patch, want] of rows) {
        const { items } = await render(locale, progress(), patch);
        expect(items.find((i) => i.key === "schedule")!.hint, `${locale} ${JSON.stringify(patch)}`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * 4);
  });
});
