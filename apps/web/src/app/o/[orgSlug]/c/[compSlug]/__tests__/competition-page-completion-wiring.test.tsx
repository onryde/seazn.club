// W4 T21 review, the competition page's two completion seams, pinned through the real page (an async server component
// called directly) and read off the components that consume them — the shape of divisions-limit-explanation-wiring:
//  - I1: the page hands the wrap-up prompt the competition's open stages (`openStagesOf`), so its one-tap "Mark
//    completed" warns as the settings select does. A missing prop defaults to an empty list, which renders NO warning
//    at all — invisible to tsc.
//  - M2: the page threads a decided final's stage into each ledger row's status line, so a played-out, uncompleted
//    bracket never reads "· complete" beside its red pill.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import type { Attention } from "@/lib/division-phase";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

const h = vi.hoisted(() => ({
  status: "live",
  endsOn: "2020-01-31" as string | null,
  frozen: false,
  openStages: [] as { stageId: string }[],
  askedFor: [] as string[],
  canEdit: true,
  openStagesFails: false,
  logError: vi.fn(),
  // M2: one division whose desk row carries this attention, finished, 3 of 3 played.
  divisions: [] as { id: string; name: string; slug: string; sport_key: string; logo_storage_path: null; logo_url: null }[],
  attention: [] as Attention[],
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: h.canEdit,
  }),
}));
vi.mock("@/server/logger", () => ({
  log: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1", org_id: "org-1", name: "Summer League", slug: "summer-league", description: null,
    starts_on: null, ends_on: h.endsOn, visibility: "private", branding: null, status: h.status,
    created_at: new Date().toISOString(), discoverable: false, discovery: null, frozen: h.frozen,
  }),
  openStagesOf: async (_auth: unknown, competitionId: string) => {
    h.askedFor.push(competitionId);
    if (h.openStagesFails) throw new Error("connection terminated");
    return h.openStages;
  },
}));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions: async () => h.divisions }));
vi.mock("@/server/usecases/card-stats", () => ({ listDivisionCardStats: async () => new Map(), formatLabel: () => "Knockout", nextLine: () => null }));
vi.mock("@/server/usecases/competition-desk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/competition-desk")>()),
  getCompetitionDesk: async (): Promise<CompetitionDesk> => ({
    in_play: 0, in_play_fixtures: [], up_next: null, fixtures_today: 0, now: "2026-11-07T12:00:00.000Z",
    divisions: new Map(
      h.divisions.map((d) => [
        d.id,
        {
          phase: "finished" as const, attention: h.attention,
          played: 3, total: 3, unscheduled: 0, in_play: 0, entrants: 4, next: null, needs_draw_stage: null,
          fixture_names: {}, display_tz: "UTC",
        },
      ]),
    ),
  }),
}));
vi.mock("@/server/public-site/data", () => ({ resolveLogoUrl: () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([{ trial_used_at: null }]);
  },
}));
vi.mock("@/lib/billing", () => ({ checkoutTrialDays: () => 14 }));

import Page from "../page";
import { CompetitionWrapUpPrompt } from "@/components/competition-wrap-up-prompt";
import { DivisionLedger, type LedgerRow } from "@/components/v2/desk/division-ledger";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";

async function prompt(): Promise<ReactElement | undefined> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) });
  return walk(el).find((e) => e.type === CompetitionWrapUpPrompt);
}

beforeEach(() => {
  h.status = "live";
  h.endsOn = "2020-01-31";
  h.frozen = false;
  h.openStages = [];
  h.askedFor = [];
  h.canEdit = true;
  h.openStagesFails = false;
  h.logError.mockReset();
  h.divisions = [];
  h.attention = [];
});

describe("the wrap-up prompt's open stages are wired from the server (W4 T21 I1)", () => {
  it("empty case first: no wrap-up owed (no end date, or already completed) — no prompt, and no read", async () => {
    h.endsOn = null;
    expect(await prompt()).toBeUndefined();
    h.endsOn = "2020-01-31";
    h.status = "completed";
    expect(await prompt()).toBeUndefined();
    expect(h.askedFor, "the open-stage read runs only when the prompt shows").toEqual([]);
  });

  it("past its end date: the page asks for THIS competition's open stages and hands them to the prompt unchanged", async () => {
    const rows = [{ stageId: "s-1" }, { stageId: "s-2" }];
    h.openStages = rows;
    const p = await prompt();
    expect(p, "premise: the prompt shows past the end date").toBeDefined();
    expect(h.askedFor).toEqual(["comp-1"]);
    expect(propsOf(p!).openStages).toBe(rows);
    expect(propsOf(p!).canCompleteStages).toBe(true);
  });

  it("a viewer who cannot edit gets no prompt past the end date — and the page never reads open stages for them", async () => {
    // B-desk re-review N4: the gate's `canEdit` half, on its own. The end date HAS passed, so only canEdit says no.
    h.canEdit = false;
    h.openStages = [{ stageId: "s-1" }];
    expect(await prompt()).toBeUndefined();
    expect(h.askedFor).toEqual([]);
    h.canEdit = true;
    expect(await prompt(), "premise: the same competition prompts its editor").toBeDefined();
  });

  it("a failed open-stage read never blanks the page: the prompt still shows, with no warning, and the failure is logged", async () => {
    // B-desk re-review N2: the same contract as the page's desk summary read (spec §Error handling).
    h.openStagesFails = true;
    const p = await prompt();
    expect(p, "the page still renders its wrap-up prompt").toBeDefined();
    expect(propsOf(p!).openStages).toEqual([]);
    expect(h.askedFor).toEqual(["comp-1"]);
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ event: "wrapup_open_stages_failed", competitionId: "comp-1" });
  });

  it("a frozen competition still lists them, but offers no Complete stage", async () => {
    h.frozen = true;
    h.openStages = [{ stageId: "s-1" }];
    const p = await prompt();
    expect(p).toBeDefined();
    expect(propsOf(p!).canCompleteStages).toBe(false);
  });
});

describe("the ledger's status line hears of a decided final (W4 T21 M2)", () => {
  async function line(): Promise<string> {
    h.endsOn = null; // no wrap-up prompt: this is about the ledger row
    h.divisions = [{ id: "d1", name: "Cup", slug: "cup", sport_key: "generic", logo_storage_path: null, logo_url: null }];
    const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) });
    const ledger = walk(el).find((e) => e.type === DivisionLedger);
    expect(ledger, "premise: the page mounts the ledger").toBeDefined();
    const rows = propsOf(ledger!).rows as LedgerRow[];
    expect(rows).toHaveLength(1);
    return rows[0]!.statusLine;
  }

  it("empty case first: a finished division with no decided final reads the finished sentence", async () => {
    expect(await line()).toBe(t(en, "desk.status.finished", { played: 3, total: 3 }));
  });

  it("a decided final on an open stage: the row names the stage still to complete", async () => {
    h.attention = [{ kind: "final_decided", stageName: "Knockout" }];
    const s = await line();
    expect(s).toBe(t(en, "desk.status.finalDecided", { played: 3, total: 3, stage: "Knockout" }));
    expect(s).not.toBe(t(en, "desk.status.finished", { played: 3, total: 3 }));
  });
});
