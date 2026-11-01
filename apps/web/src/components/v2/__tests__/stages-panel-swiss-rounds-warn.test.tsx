// W3 Task 11 (X-SW-16; brief M8) — the warn verdict's CONSUMER. The server returns `swiss_rounds` on a Generate whose
// round count is above the field's safe maximum (rulebook-W3-swiss.md §3.2 "allowed, with a plain warning"), or (fix
// round 1, ruling on review m2) whose running field shrank under the count while this round still paired; nothing in a
// unit of `swissRoundsWarnNotice` proves the desk SAYS it. This drives the real island: the rail's Pair next is pressed,
// the Generate answers with a judgement, and the panel's AMBER line is read back (review m1: a caution is never the
// green success box).
//
// Every case runs in English and in French (review m6): a non-English locale is the only way a raw English sentence and
// the localised one differ. The expected sentence is that locale dictionary's own copy filled with the judgement's
// numbers, never read off the function under test. Single-sport by nature: the notice reads a judgement's numbers; no
// sport field reaches it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { ApiV1Error } from "@/lib/client-v1";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import enUi from "@/dictionaries/en/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

type Loc = "en" | "fr";
const DICTS: Record<Loc, Record<string, string>> = {
  en: enUi as unknown as Record<string, string>,
  fr: frUi as unknown as Record<string, string>,
};
const active = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }));
// Stable per-locale functions, as the real hooks' useMemo gives.
const MSG = {
  en: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.en as unknown as Dict, key, vars),
  fr: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.fr as unknown as Dict, key, vars),
};
const PLURAL = {
  en: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.en as unknown as Dict, key, count, "en", vars),
  fr: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.fr as unknown as Dict, key, count, "fr", vars),
};
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMsg: () => MSG[active.locale],
  useMsgPlural: () => PLURAL[active.locale],
  useLocaleOrDefault: () => active.locale,
}));
const LOCALES: Loc[] = ["en", "fr"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const ENTRANTS = ["e1", "e2", "e3", "e4", "e5", "e6"];
const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "pro" as const,
  entrantNames: Object.fromEntries(ENTRANTS.map((e) => [e, e.toUpperCase()])),
  activeEntrantIds: ENTRANTS,
  entrantSeeds: Object.fromEntries(ENTRANTS.map((e, i) => [e, i + 1])),
  canEdit: true,
  stages: [{ id: "s1", seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 5 }, progression: null, status: "active" }],
  fixtures: [],
};

/** The panel's amber warning line(s), as text. */
const warningLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-amber-50"))
    .map((el) => textOf(el));
/** The panel's green notice line(s), as text. */
const noticeLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-emerald-50"))
    .map((el) => textOf(el));
/** The panel's red error line(s), as text. */
const errorLines = (tree: ReactElement[]): string[] =>
  tree
    .filter((el) => el.type === "p" && String(propsOf(el).className ?? "").includes("bg-red-50"))
    .map((el) => textOf(el));

async function pressPairNext(answer: () => Promise<unknown>) {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation((path: string) => (String(path).endsWith("/generate") ? answer() : Promise.resolve({})));
  const island = renderIsland(StagesPanel, props);
  await flush();
  const rails = island.tree().filter((el) => el.type === StageRail);
  expect(rails, "the Swiss stage's rail").toHaveLength(1);
  await (propsOf(rails[0]!).onAct as (id: string, action: string) => Promise<boolean>)("s1", "generate");
  await flush();
  expect(apiV1Mock.mock.calls.some(([path]) => String(path) === "/api/v1/stages/s1/generate"), "Pair next reached the server").toBe(true);
  return island;
}

describe.each(LOCALES)("StagesPanel — the Swiss round-count warning after Pair next (X-SW-16) [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });

  it("X-SW-16 a warn verdict renders the safe-max notice after Pair next — amber, not in the green success box", async () => {
    // §3.2's table for a field of 6 under 5 rounds: 3 recommended, safe max 3, hard max 5.
    const island = await pressPairNext(async () => ({
      created: 0,
      existing: 0,
      fixtures: [],
      swiss_rounds: { verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 },
    }));
    const warn = fill(D["swiss.rounds.warn.other"]!, { safeMax: 3, recommended: 3, hardMax: 5 });
    expect(warn, "premise: the copy names the three numbers").toMatch(/3 .*3.* 5/);
    expect(warningLines(island.tree())).toEqual([warn]);
    expect(noticeLines(island.tree()), "the green box says only what the press did").toEqual([D["schedule.notice.nothingNew"]]);
  });

  it("a shrunk verdict (a running Swiss paired a round its smaller field still reaches) renders the finish-after line — amber", async () => {
    // 6 × 5 after two withdrawals: a field of 4 reaches at most 3 rounds (§3.2's table), and round 2 still pairs.
    const island = await pressPairNext(async () => ({
      created: 0,
      existing: 0,
      fixtures: [],
      swiss_rounds: { verdict: "shrunk", rounds: 5, field: 4, recommended: 2, safeMax: 2, hardMax: 3, canFinish: true },
    }));
    const shrunk = fill(D["swiss.rounds.shrunkWarn.other"]!, { field: 4, count: 3 });
    expect(shrunk, "premise: the copy names the field and the reachable rounds").toMatch(/4 .*3/);
    expect(warningLines(island.tree())).toEqual([shrunk]);
    expect(noticeLines(island.tree())).toEqual([D["schedule.notice.nothingNew"]]);
  });

  it("X-SW-16 an ok verdict renders no warn line (and neither does an answer without one)", async () => {
    for (const swiss_rounds of [{ verdict: "ok", recommended: 3, safeMax: 4, hardMax: 7 }, undefined]) {
      const island = await pressPairNext(async () => ({ created: 0, existing: 0, fixtures: [], ...(swiss_rounds ? { swiss_rounds } : {}) }));
      expect(noticeLines(island.tree()), String(swiss_rounds?.verdict)).toEqual([D["schedule.notice.nothingNew"]]);
      expect(warningLines(island.tree()), String(swiss_rounds?.verdict)).toEqual([]);
    }
  });

  it("a refused Pair next says SWISS_ROUNDS_ABOVE_MAX in the reader's language, with what the shrunk field still pairs", async () => {
    // The server's 409 after withdrawals shrank a 6 × 5 Swiss to 4 and rounds 2 and 3 were played: round 4 is beyond
    // what a field of 4 reaches (§3.2: at most 3 rounds).
    const island = await pressPairNext(() =>
      Promise.reject(
        new ApiV1Error(SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message, 409, "SWISS_ROUNDS_ABOVE_MAX", {
          rounds: 5,
          field: 4,
          hardMax: 3,
          canFinish: true,
        }),
      ),
    );
    expect(errorLines(island.tree())).toEqual([
      `${D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(D["swiss.rounds.shrunk.other"]!, { field: 4, count: 3 })}`,
    ]);
    expect(noticeLines(island.tree())).toEqual([]);
    expect(warningLines(island.tree())).toEqual([]);
    if (locale !== "en") expect(errorLines(island.tree())[0], "never the server's English").not.toContain(SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message);
  });
});
