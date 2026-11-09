// W3 Task 11 (X-SW-16) — the console's Start refused because a Swiss has more rounds than its field can pair. The server's
// SWISS_ROUNDS_ABOVE_MAX is English wire text; before this the button painted `err.message` verbatim in every locale. This
// presses production's own Start (then the confirmation) and reads the red line back: the dictionary's refusal sentence,
// then the field's guidance (rulebook §3.2 for a field of 4: 2 rounds recommended, at most 3).
//
// Runs in English and in French (review m6): the English dictionary sentence equals the server's message, so only a
// non-English locale tells the localised path from `err.message`.
//
// Single-sport by nature: the refusal's details are numbers; no sport field reaches the button.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import enUi from "@/dictionaries/en/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/acme/c/champs/d/open",
}));

const net = vi.hoisted(() => ({ answer: null as null | { status: number; code: string; message: string; extra: Record<string, unknown> } }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: () =>
      net.answer
        ? Promise.reject(new actual.ApiV1Error(net.answer.message, net.answer.status, net.answer.code, net.answer.extra))
        : Promise.resolve({ generated: 0 }),
  };
});

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
}));

import { LaunchActions } from "../launch-actions";
import { StartConfirmDialog } from "../start-confirm-dialog";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

type LaunchProps = Parameters<typeof LaunchActions>[0];
const props: LaunchProps = {
  divisionId: "d1",
  orgSlug: "acme",
  compSlug: "champs",
  divSlug: "open",
  status: "setup",
  canEdit: true,
  fixtures: [],
  entrantNames: {},
  stages: [{ kind: "swiss", progression: null, config: { rounds: 5 } }],
  competitionStatus: "published",
  competitionVisibility: "public",
  viewerPlan: "pro",
};

const redLines = (tree: ReactElement[]): string[] =>
  tree.filter((el) => el.type === "span" && String(propsOf(el).className ?? "").includes("text-red-600")).map((el) => String(propsOf(el).children));

async function pressStart() {
  const island = renderIsland(LaunchActions, props);
  const button = island.tree().find((el) => propsOf(el)["data-testid"] === "launch-start-division");
  expect(button, "the Start button").toBeDefined();
  (propsOf(button!).onClick as () => void)();
  await flush();
  const confirmation = island.tree().find((el) => el.type === StartConfirmDialog);
  expect(confirmation, "the start confirmation").toBeDefined();
  (propsOf(confirmation!).onConfirm as () => void)();
  await flush();
  await flush();
  return island;
}

describe.each(["en", "fr"] as const)("LaunchActions — Start refused above a Swiss's hard maximum (X-SW-16) [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });

  it("says the refusal and the field's guidance in the reader's language, never the server's English alone", async () => {
    net.answer = {
      status: 422,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      message: SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message,
      extra: { rounds: 5, field: 4, hardMax: 3, canFinish: false },
    };
    const island = await pressStart();
    expect(redLines(island.tree())).toEqual([
      `${D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(D["swiss.rounds.guidance.other"]!, { n: 4, count: 2, hardMax: 3 })}`,
    ]);
    if (locale !== "en") expect(redLines(island.tree())[0], "never the server's English").not.toContain(SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message);
  });

  it("the negative pair: a refusal of another code keeps its own message", async () => {
    net.answer = { status: 422, code: "SOMETHING_ELSE", message: "division has no stages to start", extra: {} };
    const island = await pressStart();
    expect(redLines(island.tree())).toEqual(["division has no stages to start"]);
  });
});

// W4 B2 fix round 1 (G1) and round 2 (item 2): Start reconciles a root knockout drawn before its roster moved IN PLACE only,
// and refuses by name when the bracket would have to be drawn again (KO_START_NEEDS_UPDATE_DRAW — Update draw is the door that
// redraws, with its notice). Same door, same rule as the Swiss refusal above: the reader's language, never the server's
// English sentence.
describe.each(["en", "fr"] as const)("LaunchActions — Start refused: the knockout draw needs updating first [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });

  it("says the knockout table's refusal in the reader's language", async () => {
    const row = KNOCKOUT_REFUSALS.KO_START_NEEDS_UPDATE_DRAW;
    net.answer = { status: row.status, code: "KO_START_NEEDS_UPDATE_DRAW", message: row.en, extra: {} };
    const island = await pressStart();
    expect(redLines(island.tree())).toEqual([D[row.key]]);
    if (locale !== "en") expect(redLines(island.tree())[0], "never the server's English").not.toBe(row.en);
  });

  // W4 T15 (X-PL-1, X-QM-5): the first knockout refusal with a hole in its sentence at this door. The bound rides on the envelope.
  it("says a size refusal with its bound filled, for Knockout + Plate and for a qualifying cut's depth", async () => {
    const plate = KNOCKOUT_REFUSALS.KO_PLATE_TOO_FEW;
    net.answer = { status: plate.status, code: "KO_PLATE_TOO_FEW", message: plate.en, extra: { min: 4 } };
    expect(redLines((await pressStart()).tree())).toEqual([D[plate.key]]);
    const main = KNOCKOUT_REFUSALS.QUALIFYING_MAIN_TOO_FEW;
    net.answer = { status: main.status, code: "QUALIFYING_MAIN_TOO_FEW", message: fill(main.en, { min: 8 }), extra: { min: 8 } };
    const lines = redLines((await pressStart()).tree());
    expect(lines).toEqual([fill(D[main.key]!, { min: 8 })]);
    expect(lines[0], "no hole left in the sentence").not.toContain("{min}");
  });
});
