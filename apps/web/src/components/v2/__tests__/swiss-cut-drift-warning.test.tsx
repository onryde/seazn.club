import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import { swissCutDriftText } from "@/lib/swiss-cut-drift";
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
