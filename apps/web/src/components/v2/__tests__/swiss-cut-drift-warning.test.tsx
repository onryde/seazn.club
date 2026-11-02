import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import { swissCutDriftStageIds, swissCutDriftText, type SwissCutDrift } from "@/lib/swiss-cut-drift";
import { plural as pluralRuntime } from "@/lib/i18n-runtime";
import type { Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import es from "@/dictionaries/es/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// W3 Task 17 (RB3-19, X-SW-25) — "a correction after the bracket started: the bracket stands, the desk warns". The
// warning is an amber notice in the Swiss stage's card, naming by DISPLAY NAME who would qualify on today's table instead
// of whom. `apps/web` vitest is `environment: "node"`: these assertions see MARKUP, not layout — the 320/768/1280 bar is
// settled in a browser (screenshots in the T17 artifact).
//
// What the panel is handed is the answer to GET /stages/{id}/swiss-cut (`getSwissCutDrift`), keyed by Swiss stage id and
// read by the division page for an organiser: the usecase's own cases live in
// `server/usecases/__tests__/swiss-signed-rules-pin.test.ts`.

const names: Record<string, string> = { e1: "Ana Ruiz", e2: "Bo Chen", e3: "Cy Dube", e4: "Di Eze" };

const stage = (id: string, seq: number, kind: string, status: string) => ({
  id,
  seq,
  kind,
  name: kind === "swiss" ? "Swiss" : "Knockout",
  config: kind === "swiss" ? { rounds: 3 } : {},
  progression: null,
  status,
});

const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: names,
  activeEntrantIds: Object.keys(names),
  stages: [stage("s1", 1, "swiss", "complete"), stage("s2", 2, "knockout", "active")],
  fixtures: [],
};

const WARNING = /<div[^>]*data-testid="swiss-cut-drift-warning"[^>]*>([\s\S]*?)<\/div>/;

/** The warning's text, entities decoded, or null when the panel renders none. Anchored on `="` (React serialises an
 *  omitted prop as `"$undefined"`, so a bare `data-*` probe would pass in both states). */
function warningOf(html: string): { text: string; tag: string } | null {
  const m = WARNING.exec(html);
  if (!m) return null;
  const text = m[1]!
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
  return { text, tag: m[0].slice(0, m[0].indexOf(">") + 1) };
}

describe("StagesPanel — the Swiss cut drift warning (X-SW-25)", () => {
  it("X-SW-25 the desk shows the amber warning with both names", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit swissCutDrift={{ s1: { out: ["e3"], in: ["e4"] } }} />);
    const warning = warningOf(html);
    expect(warning, "the warning renders").not.toBeNull();
    expect(warning!.text).toBe(
      "A result was corrected after the knockout began. The bracket stands. On today's table Di Eze would qualify instead of Cy Dube.",
    );
    // The house amber notice (the roster-drift banner's treatment), announced politely: a notice, not an alert.
    expect(warning!.tag).toContain("border-amber-200");
    expect(warning!.tag).toContain("bg-amber-50");
    expect(warning!.tag).toContain('role="status"');
    // Names, never ids.
    expect(warning!.text).not.toMatch(/\be[1-4]\b/);
  });

  it("X-SW-25 the desk shows the amber warning with both names — several moving at once are joined with the locale's conjunction", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit swissCutDrift={{ s1: { out: ["e2", "e3"], in: ["e4", "e1"] } }} />,
    );
    expect(warningOf(html)!.text).toBe(
      "A result was corrected after the knockout began. The bracket stands. On today's table Di Eze and Ana Ruiz would qualify instead of Bo Chen and Cy Dube.",
    );
  });

  it("X-SW-25 no warning when drift is null — nothing supplied, nothing for this stage, or a viewer who cannot edit", () => {
    // Nothing supplied (the prop's default), and the answer for a stage that has no drift (the stage is simply absent).
    expect(warningOf(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />)), "no prop").toBeNull();
    expect(warningOf(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit swissCutDrift={{}} />)), "empty").toBeNull();
    // A drift keyed to another stage never lands on this card.
    expect(
      warningOf(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit swissCutDrift={{ other: { out: ["e3"], in: ["e4"] } }} />)),
      "another stage's",
    ).toBeNull();
    // Positive pair of the viewer case: the same drift renders for the organiser (the case above), and not for a viewer.
    expect(
      warningOf(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} swissCutDrift={{ s1: { out: ["e3"], in: ["e4"] } }} />)),
      "a viewer",
    ).toBeNull();
  });

  it("X-SW-25 the warning sits on the Swiss card only: a drift handed to the knockout's id renders nothing", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit swissCutDrift={{ s2: { out: ["e3"], in: ["e4"] } }} />);
    expect(warningOf(html)).toBeNull();
  });
});

// Match Day PB1 x W3 T17 — a COMPLETED stage's card starts as one line, its body `hidden`; the warning lives in that body, on a
// COMPLETED Swiss. The tests above hand the panel NO fixtures, and a completed stage with no match has nothing to fold, so they
// never saw the fold at all. These give the Swiss its played rounds, and drive the page's own producer
// (`swissCutDriftStageIds`, the function the division page calls for `attentionStageIds`) into the real panel. The seam's generic
// behaviour — a listed card starts open, a tap folds it, a warning that ARRIVES after a fold re-opens it ONCE and the next fold
// holds — is pinned for every kind in stages-panel-collapse.test.tsx ("the attention seam", "a warning that arrives after the
// person folded the card re-opens it"); it is not re-proved here. The browser half is e2e/w3-swiss-app-a.spec.ts "X-SW-25", which
// loads the real page and asserts the warning VISIBLE on the completed Swiss.
describe("StagesPanel — the cut-drift warning is never folded away (Match Day PB1 attention seam)", () => {
  const DRIFT: SwissCutDrift = { out: ["e3"], in: ["e4"] };
  /** Two decided rounds on a Swiss, so it has real matches to fold. */
  const played = (stageId: string) =>
    [1, 2].flatMap((round) =>
      [1, 2].map((board) => ({
        id: `${stageId}-${round}-${board}`,
        stage_id: stageId,
        pool_id: null,
        round_no: round,
        seq_in_round: board,
        fixture_no: (round - 1) * 2 + board,
        home_entrant_id: board === 1 ? "e1" : "e3",
        away_entrant_id: board === 1 ? "e2" : "e4",
        scheduled_at: null,
        venue: null,
        court_label: null,
        court_id: null,
        court_name: null,
        status: "decided",
        outcome: { kind: "win", winner: board === 1 ? "e1" : "e3" },
      })),
    );
  const swissStage = (id: string, seq: number) => ({ id, seq, kind: "swiss", name: `Swiss ${seq}`, config: { rounds: 2 }, progression: null, status: "complete" });
  const props = { ...baseProps, stages: [swissStage("s1", 1)], fixtures: played("s1") };
  /** What the division page does: build the attention list from the same stages / editability / drift map it hands the panel. */
  const render = (over: { canEdit?: boolean; drift?: Record<string, SwissCutDrift>; stages?: ReturnType<typeof swissStage>[]; fixtures?: ReturnType<typeof played> } & { attention?: "page" | "absent" } = {}) => {
    const stages = over.stages ?? props.stages;
    const canEdit = over.canEdit ?? true;
    const drift = over.drift;
    const attention = over.attention === "absent" ? undefined : swissCutDriftStageIds(stages, canEdit, drift);
    return renderToStaticMarkup(
      <StagesPanel {...props} stages={stages} fixtures={over.fixtures ?? props.fixtures} canEdit={canEdit} swissCutDrift={drift} attentionStageIds={attention} />,
    );
  };
  const expandedOf = (html: string, stageId: string): string | null => {
    const card = html.slice(html.indexOf(`data-stage-id="${stageId}"`));
    return /data-testid="stage-collapse-toggle"[^>]*aria-expanded="(true|false)"|aria-expanded="(true|false)"[^>]*data-testid="stage-collapse-toggle"/.exec(card)?.slice(1).find((g) => g !== undefined) ?? null;
  };
  const bodyTag = (html: string, stageId: string): string | null => new RegExp(`<div[^>]*\\sid="stage-body-${stageId}"[^>]*>`).exec(html)?.[0] ?? null;
  const hiddenOf = (html: string, stageId: string): boolean | null => {
    const tag = bodyTag(html, stageId);
    return tag === null ? null : /\shidden(=""|\s|>)/.test(tag);
  };

  it("a completed Swiss WITH a drift renders expanded, its body shown, and the warning inside that body", () => {
    const html = render({ drift: { s1: DRIFT } });
    expect(expandedOf(html, "s1"), "still collapsible: the person can fold it").toBe("true");
    expect(hiddenOf(html, "s1"), "the body is shown").toBe(false);
    const warning = warningOf(html);
    expect(warning, "the warning renders").not.toBeNull();
    expect(warning!.text).toContain("Di Eze would qualify instead of Cy Dube");
    expect(html.indexOf('data-testid="swiss-cut-drift-warning"'), "inside the card's body, not above it").toBeGreaterThan(html.indexOf('id="stage-body-s1"'));
    expect(html).not.toContain('data-testid="stage-collapsed-summary"');
  });

  it("the SAME completed Swiss WITHOUT a drift renders collapsed: toggle closed, body hidden, no warning, the one-line summary", () => {
    for (const drift of [undefined, {}] as const) {
      const html = render({ drift });
      expect(expandedOf(html, "s1"), JSON.stringify(drift)).toBe("false");
      expect(hiddenOf(html, "s1"), JSON.stringify(drift)).toBe(true);
      expect(warningOf(html), JSON.stringify(drift)).toBeNull();
      expect(html, JSON.stringify(drift)).toContain('data-testid="stage-collapsed-summary"');
    }
  });

  it("the wiring is what opens it: the same drift with NO attention list leaves the warning inside a hidden body (the inert-seam shape this exists to prevent)", () => {
    const html = render({ drift: { s1: DRIFT }, attention: "absent" });
    expect(warningOf(html), "premise: the warning is in the markup").not.toBeNull();
    expect(expandedOf(html, "s1")).toBe("false");
    expect(hiddenOf(html, "s1"), "and the body that holds it is hidden: nobody would see it").toBe(true);
  });

  it("a viewer's card never opens for a warning they cannot see (positive pair: the organiser's, above)", () => {
    const html = render({ canEdit: false, drift: { s1: DRIFT } });
    expect(warningOf(html)).toBeNull();
    expect(expandedOf(html, "s1")).toBe("false");
    expect(hiddenOf(html, "s1")).toBe(true);
  });

  it("per stage: of two completed Swiss cards only the one with the drift opens", () => {
    const stages = [swissStage("s1", 1), swissStage("s3", 2)];
    const html = render({ stages, fixtures: [...played("s1"), ...played("s3")], drift: { s3: DRIFT } });
    expect([expandedOf(html, "s1"), expandedOf(html, "s3")], "premise: both cards have a toggle").toEqual(["false", "true"]);
    expect([hiddenOf(html, "s1"), hiddenOf(html, "s3")]).toEqual([true, false]);
    expect(html.split('data-testid="swiss-cut-drift-warning"').length - 1, "exactly one warning on the page").toBe(1);
  });
});

describe("the warning copy in every locale (swiss.cutDrift.warning)", () => {
  const DICTS = { en, fr, es, nl } as const;
  const plural = (dict: Record<string, string>, locale: Locale) => (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(dict, key, count, locale, vars);

  it("X-SW-25 every locale carries both plural forms, each with its {in} and {out}, and none is the English sentence (anti-vacuity: 4 locales x 2 forms)", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const form of ["one", "other"]) {
        const value = (dict as Record<string, string>)[`swiss.cutDrift.warning.${form}`];
        expect(value, `${locale}.${form}`).toBeTruthy();
        expect(value, `${locale}.${form} names who comes in`).toContain("{in}");
        expect(value, `${locale}.${form} names who goes out`).toContain("{out}");
        if (locale !== "en") expect(value, `${locale}.${form} is translated`).not.toBe((en as Record<string, string>)[`swiss.cutDrift.warning.${form}`]);
        checked += 1;
      }
    }
    expect(checked).toBe(8);
  });

  it("X-SW-25 names are joined per locale: Ana and Bo read with the locale's own conjunction", () => {
    const drift = { out: ["e2", "e3"], in: ["e4", "e1"] };
    const said = Object.entries(DICTS).map(([locale, dict]) => [locale, swissCutDriftText(drift, names, locale, plural(dict as Record<string, string>, locale as Locale))] as const);
    expect(said).toHaveLength(4);
    const by = Object.fromEntries(said);
    expect(by.en).toContain("Di Eze and Ana Ruiz");
    expect(by.fr).toContain("Di Eze et Ana Ruiz");
    expect(by.es).toContain("Di Eze y Ana Ruiz");
    expect(by.nl).toContain("Di Eze en Ana Ruiz");
    for (const [locale, text] of said) {
      expect(text, `${locale}: no placeholder left`).not.toMatch(/[{}]/);
      expect(text, `${locale}: out names`).toContain("Bo Chen");
    }
  });

  it("X-SW-25 an id the names do not know reads '?', never the id", () => {
    const text = swissCutDriftText({ out: ["ghost-id"], in: ["e4"] }, names, "en", plural(en as Record<string, string>, "en"));
    expect(text).toContain("Di Eze would qualify instead of ?");
    expect(text).not.toContain("ghost-id");
  });
});
