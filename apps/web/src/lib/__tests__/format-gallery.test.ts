// Format gallery gates (v3/06 §4):
//  1. enumeration — every engine stage kind has an explainer family, so a
//     new format cannot ship undocumented;
//  2. the canned stage graphs actually run through the real engine preview;
//  3. the recommendation function's golden ranking for 16 entrants /
//     2 courts / 4 hours.
import { describe, expect, it } from "vitest";
import { StageKind, ProgressionSchema } from "@/server/api-v1/schemas";
import { FORMAT_FAMILIES, FormatDiagram, familyForKind, formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures } from "@/server/usecases/stages";
import { recommendFormats } from "@/lib/format-recommend";
import { helpUrl } from "@/lib/help";
import { stageNeedsAdvancedFormatsGate } from "@/server/usecases/format-gates";
import { generateAmericano } from "@seazn/engine/scheduling";
import { SWISS_ROUNDS_BANDS, swissRoundsGuidance } from "@/lib/swiss-rounds";
import { buildTemplateStages } from "@/lib/format-templates";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

describe("format gallery enumeration", () => {
  it("every engine stage kind has an explainer family", () => {
    for (const kind of StageKind.options) {
      expect(familyForKind(kind), `stage kind '${kind}' has no gallery family`).toBeTruthy();
    }
  });

  it("every family resolves through helpUrl (picker + tips deep-links)", () => {
    for (const f of FORMAT_FAMILIES) {
      expect(helpUrl(`formats/${f.slug}`)).toBe(`/help/formats/${f.slug}`);
    }
    expect(helpUrl("formats/overview")).toBe("/help/formats");
  });

  // The scout finding this closes: DIAGRAMS is a slug→SVG lookup and
  // FormatDiagram renders `null` for a slug it does not know — so a family
  // added without one ships a blank panel on /help/formats and
  // /help/formats/<slug> with every other suite green. Nothing enumerated it
  // before.
  it("every family has a hand-authored diagram (a missing one renders blank, silently)", () => {
    const missing = FORMAT_FAMILIES.filter((f) => FormatDiagram({ slug: f.slug }) === null).map(
      (f) => f.slug,
    );
    expect(missing).toEqual([]);
  });

  it("every family's canned stage graph runs through the real engine", () => {
    for (const f of FORMAT_FAMILIES) {
      const phases = previewDivisionFixtures(f.cannedStages, 8);
      expect(phases.length, f.slug).toBe(f.cannedStages.length);
      for (const phase of phases) {
        // Either concrete fixtures or an honest live-draw note — never blank.
        expect(
          phase.sections.length > 0 || (phase.note ?? "").length > 10,
          `${f.slug} / ${phase.title} rendered empty`,
        ).toBe(true);
      }
    }
  });
});

// F2 (unified progression field): cannedStages' `qualification:` sites
// (":289" stepladder, ":298" page_playoff, plus groups-knockout's `take`)
// were NOT decorative — they feed the real engine through
// previewDivisionFixtures (dispatch note). Converted onto `progression`
// (rankRange collapses topN).
//
// F3 (day-one fixtures, owner ruling R1/R4): timing flipped to "setup" —
// same as format-templates.ts's equivalent templates, matching R4's scope
// (picker's six plus this gallery's three). groups-knockout's `take` also
// moved off the hand-rolled `picks` A/B interleave onto `topNPerGroup`
// (owner ruling R5). Placement is `rank_order`, not `snake` (owner ruling
// 11): `snake` belongs to a group/pool TARGET, not a knockout one —
// see format-templates.ts's groups_ko for the full citation — and this
// canned entry feeds the identical knockout target format-templates.ts's
// groups_ko does.
describe("cannedStages emit progression, not qualification (F2)", () => {
  it("groups-knockout's knockout stage carries a topNPerGroup TakeRule, rank_order, setup", () => {
    const family = formatFamily("groups-knockout")!;
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("stepladder's finals stage carries rankRange(1,4), setup — the topN:4 replacement", () => {
    const family = formatFamily("stepladder")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("page_playoff's playoffs stage carries rankRange(1,4), setup — the topN:4 replacement", () => {
    const family = formatFamily("page_playoff")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("swiss_playoff's canned graph is a rank-adjacent swiss feeding rankRange(1,4), setup", () => {
    const family = formatFamily("swiss_playoff")!;
    expect(family.cannedStages.map((s) => s.kind)).toEqual(["swiss", "page_playoff"]);
    // The pairing model is the format. A canned graph that dropped it would
    // preview (and document) a format the picker does not actually build.
    expect(family.cannedStages[0]!.config).toMatchObject({ pairing: "rank_adjacent" });
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
    // NOT Pro: page_playoff needs `formats.double_elim`, which every plan has had since V393 (Community included), so
    // a Pro badge here is a paywall that does not exist. See the gate-derived test below.
    expect(family.pro).toBeUndefined();
  });

  it("swiss_knockout's canned graph is a rank-adjacent swiss feeding a plain knockout", () => {
    const family = formatFamily("swiss_knockout")!;
    expect(family.cannedStages.map((s) => s.kind)).toEqual(["swiss", "knockout"]);
    expect(family.cannedStages[0]!.config).toMatchObject({ pairing: "rank_adjacent" });
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.config).toEqual({});
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  // Product decision, not an oversight: both halves are free kinds, so the
  // badge must not claim otherwise. `league_ko` is the precedent — the
  // server gate (usecases/format-gates.ts) refuses nothing here, and a
  // `pro: true` badge over an ungated format is a paywall that does not
  // exist. Asserted as an explicit `undefined` rather than a falsy check so
  // that a later `pro: false` (which reads the same to a user and different
  // to every `f.pro` consumer) has to be a deliberate edit to this line.
  it("swiss_knockout is NOT Pro, and neither is swiss_playoff - no half of either needs the advanced layer", () => {
    expect(formatFamily("swiss_knockout")!.pro).toBeUndefined();
    expect(formatFamily("swiss_playoff")!.pro).toBeUndefined();
  });

  // The badge follows the SERVER gate, derived rather than typed: a family is Pro exactly when one of its stage kinds
  // needs `formats.advanced` (usecases/format-gates.ts, the one definition createStages and the builder's locks use).
  // Double elimination and the page playoff are NOT in that set: `formats.double_elim` is on for Community (V393;
  // builder-template-locks-live.test.ts reads the plan rows).
  it("a family carries the Pro flag exactly when the gate says one of its stage kinds needs formats.advanced", () => {
    let checked = 0;
    let flagged = 0;
    for (const f of FORMAT_FAMILIES) {
      const gated = f.kinds.some((kind) => stageNeedsAdvancedFormatsGate({ kind }));
      expect(f.pro === true, `${f.slug}: pro flag vs the advanced gate`).toBe(gated);
      checked++;
      if (gated) flagged++;
    }
    expect(checked, "anti-vacuity: every family was judged").toBe(FORMAT_FAMILIES.length);
    expect(flagged, "the gate must flag something (americano, ladder), or the equality above is vacuous").toBeGreaterThanOrEqual(2);
    for (const slug of ["double_elim", "page_playoff", "swiss_playoff"]) expect(formatFamily(slug)!.pro, `${slug} is free on every plan`).toBeUndefined();
  });

  it("every family's cannedStages progression is either null or a schema-valid ProgressionSpec", () => {
    for (const f of FORMAT_FAMILIES) {
      for (const stage of f.cannedStages) {
        expect(stage).not.toHaveProperty("qualification");
        if (stage.progression === null) continue;
        const parsed = ProgressionSchema.safeParse(stage.progression);
        expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
      }
    }
  });
});

describe("recommendFormats golden — 16 entrants, 2 courts, 4 hours", () => {
  it("ranks knockout first (only bracket that fits 16 court-slots)", () => {
    const picks = recommendFormats({ entrants: 16, courts: 2, hours: 4 });
    expect(picks).toHaveLength(3);
    // Capacity = 2 courts × 8 slots = 16 matches; knockout (15) is the only
    // model that fits, so it must lead; the rest are least-overrun first.
    expect(picks[0]!.slug).toBe("knockout");
    expect(picks[0]!.matches).toBe(15);
    expect(picks.map((p) => p.slug)).toEqual(["knockout", "double_elim", "groups-knockout"]);
    // Numbers and a slug only: the strip words each pick from its dictionary (format-recommend-strip-i18n.test.tsx).
    for (const p of picks) expect(Object.keys(p).sort()).toEqual(["estHours", "matches", "perEntrant", "slug"]);
  });

  it("with a full weekend the league leads (most play per entrant)", () => {
    const picks = recommendFormats({ entrants: 8, courts: 2, hours: 12 });
    expect(picks[0]!.slug).toBe("league"); // 28 matches fit 48 slots
  });
});

// Plain-false statements the four dictionaries made about three formats (help fix round 1). Each premise comes from the
// engine's or the app's own declaration, never from a number typed here; the phrase lists below are the denylist half.
const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

describe("format copy does not promise what the engine does not do", () => {
  it("americano: the rotation does NOT pair everyone with everyone, so no locale says it does", () => {
    let checked = 0;
    for (const players of [8, 12, 16]) {
      const ids = Array.from({ length: players }, (_, i) => `P${i + 1}`);
      const rounds = generateAmericano(ids, { mode: "americano", rounds: players - 1, courtCount: players / 4 });
      const partners = new Set<string>();
      for (const r of rounds) for (const m of r.matches) for (const t of [m.team1, m.team2]) partners.add([...t].sort().join("-"));
      expect(partners.size, `${players} players: the premise (not every pair partners)`).toBeLessThan((players * (players - 1)) / 2);
      checked += 1;
    }
    expect(checked, "anti-vacuity: field sizes checked").toBe(3);
    const claims: Record<string, RegExp> = {
      en: /everyone partners everyone|plays with everyone|partners everyone/i,
      es: /todos son pareja de todos|todos juegan con todos/i,
      fr: /tout le monde joue avec tout le monde|partenaire de tout le monde/i,
      nl: /iedereen (speelt )?met iedereen/i,
    };
    const overclaim: Record<string, RegExp> = { en: /maximum mixing/i, es: /máxima mezcla/i, fr: /brassage maximal/i, nl: /maximale menging/i };
    let texts = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      for (const key of ["format.americano.tagline", "format.americano.bestFor", "format.americano.tradeoff", "format.americano.body.0", "format.americano.body.1"]) {
        expect(dict[key], `${loc} ${key}`).toBeTruthy();
        expect(dict[key], `${loc} ${key}`).not.toMatch(claims[loc]!);
        expect(dict[key], `${loc} ${key} (no 'maximum mixing' either)`).not.toMatch(overclaim[loc]!);
        texts += 1;
      }
    }
    expect(texts, "anti-vacuity: texts scanned").toBe(20);
  });

  it("knockout + plate: the template takes every first-match loss, so no locale says 'round-1 losers'", () => {
    const stages = buildTemplateStages("ko_plate", { qualified: 8 } as never);
    const plate = stages.find((s) => s.name === "Plate");
    expect(plate?.progression?.sources[0]?.take).toEqual([{ kind: "firstLosses" }]);
    const claims: Record<string, RegExp> = { en: /round-1 losers/i, es: /perdedores de la ronda 1/i, fr: /perdants du 1er tour/i, nl: /verliezers van ronde 1/i };
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      expect(dict["format.template.ko_plate.help"], loc).toBeTruthy();
      expect(dict["format.template.ko_plate.help"], loc).not.toMatch(claims[loc]!);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("swiss playoff / swiss knockout: the round count is a suggestion capped at half the field, and says so", () => {
    // premise: for a small field the suggestion is below the band number, so 'the number of rounds follows the field' is not the rule
    expect(swissRoundsGuidance(4).recommended).toBeLessThan(SWISS_ROUNDS_BANDS[0]!.rounds);
    const numbers = SWISS_ROUNDS_BANDS.map((b) => String(b.upTo));
    const claims: Record<string, RegExp> = { en: /follows the field/i, es: /sigue al cuadro/i, fr: /suit la taille/i, nl: /volgt het veld/i };
    const halfCap: Record<string, RegExp> = { en: /never more than half/i, es: /nunca más de la mitad/i, fr: /jamais plus de la moitié/i, nl: /nooit meer dan de helft/i };
    const canChange: Record<string, RegExp> = { en: /you can change it/i, es: /puedes cambiarlo/i, fr: /vous pouvez le modifier/i, nl: /je kunt het aanpassen/i };
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      for (const key of ["format.swiss_playoff.body.0", "format.swiss_knockout.body.0"]) {
        expect(dict[key], `${loc} ${key}`).not.toMatch(claims[loc]!);
        for (const n of numbers) expect(dict[key], `${loc} ${key} keeps the band figure ${n}`).toContain(n);
        expect(dict[key], `${loc} ${key} says the count is capped at half the field`).toMatch(halfCap[loc]!);
        expect(dict[key], `${loc} ${key} says the organiser can change it`).toMatch(canChange[loc]!);
        checked += 1;
      }
    }
    expect(checked).toBe(8);
  });
});
