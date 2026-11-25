// Online Chess runs Swiss and knockout events (spec 2026-11-23-online-chess-credits-design.md §3 decision 9, §8.1; plan Task 11): on a
// division that plays online, the Format dialog's picker greys every format that builds a league, group or ladder stage and says
// "Not available for Online Chess"; the dialog's Save refuses such a pick; and the server's own refusals (ONLINE_FORMAT_NOT_SUPPORTED,
// ONLINE_ROUNDS_NEED_SIZE, ONLINE_ROUNDS_ABOVE_MAX) are said in the organiser's words, not the server's English.
//
// Driven through the REAL Format dialog on the hook harness (its handlers, its picker). Expected values: a format is refused iff it
// builds a stage of a kind the LEAF declares refused (`ONLINE_REFUSED_STAGE_KINDS`, read from the template's own builder), plus three
// hand-typed spot checks from the spec (league refused, Swiss and knockout open); every sentence is the en dictionary's, never the
// component's own formatter.
//
// single-sport: Online Chess is boardgame only (online-play.ts); the sweep covers every format that sport is offered.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { LegsChoice } from "@/components/v2/legs-choice";
import { DivisionFormatDialog, type DivisionFormatProps, type DivisionFormatStage } from "@/components/v2/rules/division-format";
import { ApiV1Error } from "@/lib/client-v1";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { ONLINE_REFUSED_STAGE_KINDS } from "@/lib/online-chess-package";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { camerasNeedUpgrade, formatNotSupported, roundsAboveMax, roundsNeedSize } from "@/server/usecases/online-package/format";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const UI = uiEn as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const SPORT = "boardgame";
const KINDS = engineEntrantKinds(SPORT);
const OFFER = templatesForSport(SPORT, KINDS).map((t) => t.key);
const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 };
/** From the leaf's declaration (not from the helper under test): a format is refused online iff it builds a refused kind. */
const refusedOnline = (key: string) => buildTemplateStages(key, KNOBS).some((s) => ONLINE_REFUSED_STAGE_KINDS.includes(s.kind));

const props = (over: Partial<DivisionFormatProps>): DivisionFormatProps => ({
  divisionId: "d1", sportKey: SPORT, stages: [], offer: OFFER, entrantKinds: KINDS, templateLocks: {}, carryAllowed: true, viewerPlan: "pro",
  entrants: 6, places: 2, matchMinutes: 30, locked: false, canEdit: true, ...over,
});
const expand = (node: ReactNode): ReactElement[] =>
  walk(node).flatMap((el) => {
    if (el.type === Modal) return [el, ...expand(propsOf(el).footer as ReactNode)];
    if (el.type === LegsChoice) return [el, ...expand(expandWithHooks(LegsChoice, propsOf(el) as Parameters<typeof LegsChoice>[0]))];
    return [el];
  });
const dialog = (over: Partial<DivisionFormatProps> = {}) => renderIsland(DivisionFormatDialog, { ...props(over), onClose: vi.fn() }, expand);
type H = ReturnType<typeof dialog>;
const stored = (template: string): DivisionFormatStage[] =>
  buildTemplateStages(template, { ...KNOBS }).map((d) => ({ name: d.name, kind: d.kind, config: d.config ?? null, progression: d.progression ?? null }));
const cardOf = (h: H, key: string): ReactElement => {
  const card = h.tree().find((e) => e.type === "label" && propsOf(e)["data-template"] === key);
  if (!card) throw new Error(`no format card for ${key}`);
  return card;
};
const inCard = (card: ReactElement, id: string) => walk(card).find((e) => propsOf(e)["data-testid"] === id);
const radioOf = (card: ReactElement) => walk(card).find((e) => e.type === "input" && propsOf(e).type === "radio")!;
const saveButton = (h: H) => h.tree().find((e) => propsOf(e)["data-testid"] === "division-format-save")!;
const errorText = (h: H) => h.tree().find((e) => propsOf(e)["data-testid"] === "division-format-error");
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  apiV1Mock.mockReset();
});

describe("an online division's Format dialog greys the formats Online Chess does not run", () => {
  it("every format the sport is offered: a league, group or ladder one is greyed, unpickable and says why; the rest are open (anti-vacuity: both kinds)", () => {
    const h = dialog({ onlinePlay: true });
    const refused: string[] = [];
    const open: string[] = [];
    for (const key of OFFER) {
      const card = cardOf(h, key);
      const note = inCard(card, `division-builder-online-reason-${key}`);
      if (refusedOnline(key)) {
        refused.push(key);
        expect(note, `${key}: the reason`).toBeDefined();
        expect(textOf(note!), key).toBe(UI["onlineChess.format.pickerNote"]);
        expect(propsOf(radioOf(card)).disabled, `${key}: unpickable`).toBe(true);
        expect(propsOf(card)["aria-disabled"], key).toBe("true");
      } else {
        open.push(key);
        expect(note, `${key}: no reason`).toBeUndefined();
        expect(propsOf(radioOf(card)).disabled, `${key}: pickable`).toBeFalsy();
        expect(inCard(card, `division-builder-estimate-${key}`), `${key}: shows its estimate`).toBeDefined();
      }
    }
    expect(refused.length, "anti-vacuity: the sport is offered formats Online Chess refuses").toBeGreaterThan(0);
    expect(open.length, "anti-vacuity: and ones it runs").toBeGreaterThan(0);
    // spot checks typed from the spec ("Swiss and knockout"), so the leaf's list and the helper cannot drift together unseen
    for (const k of ["league", "league_ko", "groups_ko", "ladder"]) expect(refused, k).toContain(k);
    for (const k of ["swiss", "knockout", "swiss_knockout", "double_elim"]) expect(open, k).toContain(k);
    expect(UI["onlineChess.format.pickerNote"]).toBe("Not available for Online Chess");
  });

  it("the positive pair: the same dialog on a division that does NOT play online greys nothing for the format", () => {
    for (const onlinePlay of [false, undefined]) {
      const h = dialog({ onlinePlay });
      let checked = 0;
      for (const key of OFFER) {
        expect(inCard(cardOf(h, key), `division-builder-online-reason-${key}`), `${key} online=${String(onlinePlay)}`).toBeUndefined();
        expect(propsOf(radioOf(cardOf(h, key))).disabled, key).toBeFalsy();
        checked += 1;
      }
      expect(checked, "anti-vacuity").toBe(OFFER.length);
    }
  });

  it("a stored league on an online division (legacy) stays picked and greyed, and the dialog will not Save it", () => {
    const h = dialog({ onlinePlay: true, stages: stored("league") });
    const card = cardOf(h, "league");
    expect(propsOf(radioOf(card)).checked, "picked").toBe(true);
    expect(propsOf(radioOf(card)).disabled, "greyed").toBe(true);
    expect(propsOf(saveButton(h)).disabled, "Save refused until a runnable format is picked").toBe(true);
  });

  it("a runnable stored format saves: Save is not refused for it, and the online flag changes nothing for it", () => {
    const h = dialog({ onlinePlay: true, stages: stored("swiss") });
    expect(propsOf(saveButton(h)).disabled).toBeFalsy();
  });

  it("picking a runnable format after a refused one lifts the refusal (the sequence)", () => {
    const h = dialog({ onlinePlay: true, stages: stored("league") });
    expect(propsOf(saveButton(h)).disabled).toBe(true);
    (propsOf(radioOf(cardOf(h, "swiss"))).onChange as () => void)();
    expect(propsOf(saveButton(h)).disabled).toBeFalsy();
  });
});

describe("the server's Online Chess refusals at a format save, in the organiser's words", () => {
  const SERVER_WORDING = "server wording - English only";
  const asApi = (e: { status: number; code?: string; extra?: unknown }) => new ApiV1Error(SERVER_WORDING, e.status, String(e.code), (e.extra ?? {}) as Record<string, unknown>);
  const saveRefusedWith = async (e: { status: number; code?: string; extra?: unknown }) => {
    apiV1Mock.mockReset().mockRejectedValue(asApi(e));
    const h = dialog({ onlinePlay: true, stages: stored("swiss") });
    (propsOf(saveButton(h)).onClick as () => void)();
    await flush();
    expect(errorText(h), "an error is shown").toBeDefined();
    return textOf(errorText(h)!);
  };

  it("ONLINE_FORMAT_NOT_SUPPORTED, ONLINE_ROUNDS_NEED_SIZE (with the size to move to), ONLINE_ROUNDS_ABOVE_MAX", async () => {
    expect(await saveRefusedWith(formatNotSupported("league"))).toBe(UI["onlineChess.format.refused"]);
    expect(await saveRefusedWith(roundsNeedSize(16, 8))).toBe(fill(UI["onlineChess.roundsNeedSize"]!, { nextSize: 64 }));
    expect(await saveRefusedWith(roundsAboveMax(11))).toBe(fill(UI["onlineChess.roundsAboveMax"]!, { max: 10 }));
  });

  it("ONLINE_CAMERAS_NEED_UPGRADE names the divisions", async () => {
    expect(await saveRefusedWith(camerasNeedUpgrade([{ id: "d9", name: "Under 12", owed: 2 }]))).toBe(fill(UI["onlineChess.camerasNeedUpgrade"]!, { names: "Under 12" }));
  });

  it("none of them shows the server's own English", async () => {
    for (const e of [formatNotSupported("group"), roundsNeedSize(16, 8), roundsAboveMax(12)]) expect(await saveRefusedWith(e)).not.toContain(SERVER_WORDING);
  });
});
