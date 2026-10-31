// The gallery's cell matrix and its moment samples (R2007 step 5.1; spec 2026-10-15 §4.8).
//
// Every expected count is computed from the DECLARATIONS — `MOMENT_RULES`, `OVERLAY_SCENES`, `GALLERY_SNAPSHOT_KINDS`,
// `templatesForSport` — never from `galleryMatrix`'s own output, and every sweep prints what it checked and fails on 0.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOMENT_RULES, momentsFor } from "@/lib/overlay-moments";
import { t } from "@/lib/i18n-runtime";
import type { OverlayMsg } from "@/lib/overlay-model";
import { OVERLAY_SPORT_KEYS } from "../overlay-tokens";
import { OVERLAY_SCENES, SPONSOR_CAROUSEL_SCENES, type OverlaySceneDef } from "../overlay-scenes";
import { OVERLAY_TEMPLATES, templatesForSport } from "../template-registry";
import { SPONSOR_STYLE_BY_SIZE } from "@/lib/sponsor-plan";
import { SPONSOR_SHORT_CODE_PATTERN } from "@/lib/sponsor-short-code";
import {
  GALLERY_CAROUSEL_SPORTS,
  GALLERY_MOMENT_SAMPLES,
  GALLERY_RESULT_VARIANT_SPORTS,
  GALLERY_SNAPSHOT_KINDS,
  GALLERY_SPONSOR_CARDS,
  GALLERY_SPONSOR_FACE_SPORTS,
  galleryCells,
  galleryMatrix,
  gallerySponsorPlan,
  type ResultVariant,
} from "../gallery-matrix";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));
const msg: OverlayMsg = (key, vars) => t(DICT, key, vars);
const NAMES = ["MKR", "NOR"] as const;

describe("GALLERY_MOMENT_SAMPLES — exact coverage of MOMENT_RULES", () => {
  it("every (sport, rule key) has a sample, and cricket.ball has three (six, four, wicket)", () => {
    let entries = 0;
    for (const [sport, rules] of Object.entries(MOMENT_RULES)) {
      for (const ruleKey of Object.keys(rules)) {
        entries++;
        const covering = GALLERY_MOMENT_SAMPLES.filter((s) => s.sportKey === sport && s.ruleKey === ruleKey);
        expect(covering.length, `${sport} / ${ruleKey} has no sample`).toBeGreaterThan(0);
      }
    }
    const balls = GALLERY_MOMENT_SAMPLES.filter((s) => s.sportKey === "cricket" && s.ruleKey === "cricket.ball");
    expect(balls).toHaveLength(3);
    console.log(`rule entries covered: ${entries}, samples: ${GALLERY_MOMENT_SAMPLES.length}`);
    expect(entries, "anti-vacuity: no rule entry").toBeGreaterThan(0);
    expect(GALLERY_MOMENT_SAMPLES.length, "anti-vacuity: no sample").toBeGreaterThan(0);
  });

  it("every sample names a rule that exists — no sample for a rule the overlay does not have", () => {
    for (const s of GALLERY_MOMENT_SAMPLES) {
      expect(MOMENT_RULES[s.sportKey]?.[s.ruleKey], `${s.id}: ${s.sportKey} / ${s.ruleKey}`).toBeDefined();
    }
  });

  it("sample ids are unique", () => {
    const ids = GALLERY_MOMENT_SAMPLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every sample FIRES through its own rule and through the real momentsFor", () => {
    let fired = 0;
    for (const s of GALLERY_MOMENT_SAMPLES) {
      const own = MOMENT_RULES[s.sportKey]![s.ruleKey]!(s.event, { msg, sportKey: s.sportKey, sides: NAMES });
      expect(own, `${s.id}: its own rule (${s.ruleKey}) returned nothing`).not.toBeNull();
      const moments = momentsFor(s.sportKey, [s.event], s.event.seq - 1, msg, NAMES);
      expect(moments.length, `${s.id}: momentsFor raised nothing`).toBeGreaterThan(0);
      fired++;
    }
    console.log(`samples fired: ${fired}`);
    expect(fired).toBe(GALLERY_MOMENT_SAMPLES.length);
    expect(fired, "anti-vacuity").toBeGreaterThan(0);
  });

  it("cricket's three yield the SIX, FOUR and OUT headlines", () => {
    const headlines = GALLERY_MOMENT_SAMPLES.filter((s) => s.sportKey === "cricket" && s.ruleKey === "cricket.ball")
      .map((s) => momentsFor("cricket", [s.event], s.event.seq - 1, msg, NAMES)[0]?.headline)
      .sort();
    expect(headlines).toEqual(
      [msg("overlay.moment.six"), msg("overlay.moment.four"), msg("overlay.moment.out")].sort(),
    );
  });
});

describe("galleryMatrix — the size, from the declarations", () => {
  const VARIANTS: ResultVariant[] = GALLERY_RESULT_VARIANT_SPORTS.flatMap((sportKey) => [
    { status: "forfeited", sportKey },
    { status: "abandoned", sportKey },
  ]);

  it("plain + moment + variant + sponsor + carousel cells, keys unique", () => {
    const cells = galleryMatrix(
      OVERLAY_TEMPLATES,
      OVERLAY_SPORT_KEYS,
      OVERLAY_SCENES,
      GALLERY_MOMENT_SAMPLES,
      VARIANTS,
      GALLERY_CAROUSEL_SPORTS,
      GALLERY_SPONSOR_FACE_SPORTS,
    );
    const firing = OVERLAY_SCENES.filter((s) => s.momentsFire).length;
    const carouselScenes = OVERLAY_SCENES.filter((s) => SPONSOR_CAROUSEL_SCENES.includes(s.id)).length;
    let expected = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      expected += templatesForSport(sport).length * OVERLAY_SCENES.length * GALLERY_SNAPSHOT_KINDS.length;
      // R4 S7: template × sport × each slot the template declares (spec 2026-10-27 §3.5), plus the plain face's (m3).
      const faces = (GALLERY_SPONSOR_FACE_SPORTS as readonly string[]).includes(sport) ? 2 : 1;
      for (const def of templatesForSport(sport)) expected += Object.keys(def.sponsorSlots).length * faces;
    }
    for (const s of GALLERY_MOMENT_SAMPLES) expected += templatesForSport(s.sportKey).length * firing;
    for (const v of VARIANTS) expected += templatesForSport(v.sportKey).length;
    for (const sport of GALLERY_CAROUSEL_SPORTS) expected += templatesForSport(sport).length * carouselScenes;
    expect(carouselScenes, "premise: the shipped scenes carry the carousel somewhere").toBeGreaterThan(0);
    console.log(`cells: ${cells.length}, expected from the declarations: ${expected}`);
    expect(expected, "anti-vacuity").toBeGreaterThan(0);
    expect(cells).toHaveLength(expected);
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
  });

  it("each cell kind carries exactly its own fields", () => {
    const cells = galleryCells(OVERLAY_TEMPLATES, VARIANTS);
    const kinds = { plain: 0, moment: 0, variant: 0, sponsor: 0, carousel: 0 };
    const cardIds = GALLERY_SPONSOR_CARDS.map((c) => c.id);
    for (const c of cells) {
      const own = [c.momentSampleId !== null, c.resultStatus !== null, c.sponsorSlot !== null, c.carousel].filter(Boolean);
      expect(own.length, `${c.key}: at most one kind`).toBeLessThanOrEqual(1);
      expect(c.sponsorCard === null, `${c.key}: a card id exactly on sponsor cells`).toBe(c.sponsorSlot === null);
      if (c.sponsorSlot !== null) {
        kinds.sponsor++;
        expect(cardIds, c.key).toContain(c.sponsorCard);
        expect(c.scene, c.key).toBe("live");
        expect(c.snapshot, c.key).toBe("live");
        expect(Object.keys(OVERLAY_TEMPLATES[c.templateId as "bar" | "bug"].sponsorSlots), c.key).toContain(c.sponsorSlot);
      } else if (c.carousel) {
        kinds.carousel++;
        expect(SPONSOR_CAROUSEL_SCENES, c.key).toContain(c.scene);
        expect(GALLERY_CAROUSEL_SPORTS as readonly string[], c.key).toContain(c.sportKey);
        // Starting soon is before the match: the warming snapshot (its match card shows the start); otherwise live.
        expect(c.snapshot, c.key).toBe(c.scene === "starting" ? "warming" : "live");
      } else if (c.momentSampleId !== null) {
        kinds.moment++;
        expect(c.snapshot, c.key).toBe("live");
        expect(c.resultStatus, c.key).toBeNull();
        expect(GALLERY_MOMENT_SAMPLES.find((s) => s.id === c.momentSampleId)?.sportKey, c.key).toBe(c.sportKey);
      } else if (c.resultStatus !== null) {
        kinds.variant++;
        expect(c.snapshot, c.key).toBe("ended");
        expect(c.scene, c.key).toBe("live");
      } else {
        kinds.plain++;
        expect(GALLERY_SNAPSHOT_KINDS, c.key).toContain(c.snapshot);
      }
      expect(templatesForSport(c.sportKey).map((d) => d.id), c.key).toContain(c.templateId);
    }
    console.log(`plain: ${kinds.plain}, moment: ${kinds.moment}, variant: ${kinds.variant}, sponsor: ${kinds.sponsor}, carousel: ${kinds.carousel}`);
    expect(kinds.plain).toBeGreaterThan(0);
    expect(kinds.moment).toBeGreaterThan(0);
    expect(kinds.sponsor).toBeGreaterThan(0);
    expect(kinds.carousel).toBeGreaterThan(0);
    expect(kinds.variant).toBe(VARIANTS.reduce((n, v) => n + templatesForSport(v.sportKey).length, 0));
  });

  it("galleryCells is galleryMatrix over the shipped sports, scenes, samples and carousel sports", () => {
    expect(galleryCells(OVERLAY_TEMPLATES, VARIANTS)).toEqual(
      galleryMatrix(
        OVERLAY_TEMPLATES,
        OVERLAY_SPORT_KEYS,
        OVERLAY_SCENES,
        GALLERY_MOMENT_SAMPLES,
        VARIANTS,
        GALLERY_CAROUSEL_SPORTS,
        GALLERY_SPONSOR_FACE_SPORTS,
      ),
    );
  });

  it("the empty case: no sports, no samples, no variants, no carousel sports → no cells", () => {
    expect(galleryMatrix(OVERLAY_TEMPLATES, [], OVERLAY_SCENES, [], [], [])).toEqual([]);
  });
});

describe("decision 8 (D14) — a scene's momentsFire is the one authority for moment cells", () => {
  it("a scene that does not fire gets plain cells but NO moment cell", () => {
    const scenes: OverlaySceneDef[] = [
      { id: "live", labelKey: "stream.scene.live", momentsFire: true },
      { id: "held", labelKey: "stream.scene.live", momentsFire: false },
    ];
    const cells = galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, scenes, GALLERY_MOMENT_SAMPLES, [], []);
    const moments = cells.filter((c) => c.momentSampleId !== null);
    expect(moments.length, "anti-vacuity").toBeGreaterThan(0);
    for (const c of moments) expect(c.scene, c.key).toBe("live");
    const held = cells.filter((c) => (c.scene as string) === "held");
    expect(held.length, "the held scene still has its plain cells").toBeGreaterThan(0);
    expect(held.filter((c) => c.momentSampleId !== null)).toHaveLength(0);
  });

  it("for every shipped scene, its moment cells number momentsFire ? the samples' template count : 0", () => {
    const cells = galleryCells(OVERLAY_TEMPLATES, []);
    const perScene = GALLERY_MOMENT_SAMPLES.reduce((n, s) => n + templatesForSport(s.sportKey).length, 0);
    let scenes = 0;
    let firing = 0;
    for (const scene of OVERLAY_SCENES) {
      scenes++;
      if (scene.momentsFire) firing++;
      const got = cells.filter((c) => c.scene === scene.id && c.momentSampleId !== null).length;
      expect(got, scene.id).toBe(scene.momentsFire ? perScene : 0);
    }
    console.log(`scenes checked: ${scenes}, moment-firing: ${firing}`);
    expect(scenes, "anti-vacuity").toBeGreaterThan(0);
    expect(firing, "anti-vacuity").toBeGreaterThan(0);
  });
});

describe("R4 S7 — the sponsor cells (spec 2026-10-27 §3.5: template × sport × slot) and the carousel cells", () => {
  it("every template × sport × declared slot has one full-face (title) cell; the face sports one plain-face (gold) cell too", () => {
    const cells = galleryCells(OVERLAY_TEMPLATES, []);
    const [full, plain] = GALLERY_SPONSOR_CARDS;
    let checked = 0;
    let plainChecked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      const faceSport = (GALLERY_SPONSOR_FACE_SPORTS as readonly string[]).includes(sport);
      for (const def of templatesForSport(sport)) {
        for (const slot of Object.keys(def.sponsorSlots)) {
          const at = (id: string) => cells.filter((c) => c.templateId === def.id && c.sportKey === sport && c.sponsorSlot === slot && c.sponsorCard === id);
          expect(at(full!.id), `${def.id} × ${sport} × ${slot}: full face`).toHaveLength(1);
          expect(at(plain!.id), `${def.id} × ${sport} × ${slot}: plain face`).toHaveLength(faceSport ? 1 : 0);
          checked++;
          if (faceSport) plainChecked++;
        }
      }
    }
    console.log(`sponsor cells checked: ${checked} slots, ${plainChecked} with the plain face`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(plainChecked, "anti-vacuity: a plain face").toBeGreaterThan(0);
    expect(cells.filter((c) => c.sponsorSlot !== null)).toHaveLength(checked + plainChecked);
    // Premise (m3): the second gallery card IS the plain face — no logo, no short code.
    expect(plain!.logoUrl).toBeNull();
    expect(plain!.shortCode).toBeUndefined();
    expect(full!.logoUrl).not.toBeNull();
    expect(full!.shortCode).toBeDefined();
  });

  it("carousel cells: every template of each carousel sport, once per carousel scene — and only there", () => {
    const cells = galleryCells(OVERLAY_TEMPLATES, []);
    let checked = 0;
    for (const sport of GALLERY_CAROUSEL_SPORTS) {
      for (const def of templatesForSport(sport)) {
        for (const scene of OVERLAY_SCENES) {
          const hits = cells.filter((c) => c.carousel && c.templateId === def.id && c.sportKey === sport && c.scene === scene.id);
          expect(hits, `${def.id} × ${sport} × ${scene.id}`).toHaveLength(SPONSOR_CAROUSEL_SCENES.includes(scene.id) ? 1 : 0);
          checked++;
        }
      }
    }
    console.log(`carousel (template × sport × scene) combinations checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });

  it("the empty case: no carousel sports, or no carousel scene in the list → no carousel cell", () => {
    expect(galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, OVERLAY_SCENES, [], [], []).filter((c) => c.carousel)).toEqual([]);
    const live = OVERLAY_SCENES.filter((s) => s.id === "live");
    expect(galleryMatrix(OVERLAY_TEMPLATES, [], live, [], [], GALLERY_CAROUSEL_SPORTS)).toEqual([]);
  });

  it("gallerySponsorPlan: the REAL planner's plan — one airing in the slot's own look, naming the 43-character card", () => {
    let checked = 0;
    for (const { style, holdMs } of Object.values(SPONSOR_STYLE_BY_SIZE)) {
      const plan = gallerySponsorPlan(style);
      expect(plan?.airings, style).toHaveLength(1);
      const airing = plan!.airings[0]!;
      expect(airing.style).toBe(style);
      expect(airing.holdMs).toBe(holdMs);
      const card = plan!.cards.find((c) => c.id === airing.cardId);
      expect(card?.name, "the brief's 43-character name").toHaveLength(43);
      expect(card?.shortCode ?? "", "R7: a printable code").toMatch(SPONSOR_SHORT_CODE_PATTERN);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("gallerySponsorPlan(style, gold): the airing names the gold card — the only card in the plan", () => {
    const gold = GALLERY_SPONSOR_CARDS[1]!;
    for (const { style } of Object.values(SPONSOR_STYLE_BY_SIZE)) {
      const plan = gallerySponsorPlan(style, gold.id);
      expect(plan, style).not.toBeNull();
      expect(plan!.airings.map((a) => a.cardId), style).toEqual([gold.id]);
      expect(plan!.cards.map((c) => c.id)).toEqual([gold.id]);
    }
    expect(() => gallerySponsorPlan("banner", "no-such-card"), "a card the gallery does not hold is refused by name").toThrow(
      /no gallery card no-such-card|airing/,
    );
  });

  it("gallerySponsorPlan(null): the carousel's plan — every gallery card, all ticked, no airing", () => {
    const plan = gallerySponsorPlan(null);
    expect(plan?.airings).toEqual([]);
    expect(plan?.cards.map((c) => c.id)).toEqual(GALLERY_SPONSOR_CARDS.map((c) => c.id));
    expect(GALLERY_SPONSOR_CARDS.every((c) => c.onStream)).toBe(true);
    expect(GALLERY_SPONSOR_CARDS.length, "anti-vacuity: the carousel has two cards to rotate").toBeGreaterThan(1);
  });
});
