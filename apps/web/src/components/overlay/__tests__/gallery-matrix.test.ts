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
import { OVERLAY_SCENES, type OverlaySceneDef } from "../overlay-scenes";
import { OVERLAY_TEMPLATES, templatesForSport } from "../template-registry";
import {
  GALLERY_MOMENT_SAMPLES,
  GALLERY_RESULT_VARIANT_SPORTS,
  GALLERY_SNAPSHOT_KINDS,
  galleryCells,
  galleryMatrix,
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

  it("plain + moment + variant cells, keys unique", () => {
    const cells = galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, OVERLAY_SCENES, GALLERY_MOMENT_SAMPLES, VARIANTS);
    const firing = OVERLAY_SCENES.filter((s) => s.momentsFire).length;
    let expected = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      expected += templatesForSport(sport).length * OVERLAY_SCENES.length * GALLERY_SNAPSHOT_KINDS.length;
    }
    for (const s of GALLERY_MOMENT_SAMPLES) expected += templatesForSport(s.sportKey).length * firing;
    for (const v of VARIANTS) expected += templatesForSport(v.sportKey).length;
    console.log(`cells: ${cells.length}, expected from the declarations: ${expected}`);
    expect(expected, "anti-vacuity").toBeGreaterThan(0);
    expect(cells).toHaveLength(expected);
    expect(new Set(cells.map((c) => c.key)).size).toBe(cells.length);
  });

  it("each cell kind carries exactly its own fields", () => {
    const cells = galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, OVERLAY_SCENES, GALLERY_MOMENT_SAMPLES, VARIANTS);
    const kinds = { plain: 0, moment: 0, variant: 0 };
    for (const c of cells) {
      if (c.momentSampleId !== null) {
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
    console.log(`plain: ${kinds.plain}, moment: ${kinds.moment}, variant: ${kinds.variant}`);
    expect(kinds.plain).toBeGreaterThan(0);
    expect(kinds.moment).toBeGreaterThan(0);
    expect(kinds.variant).toBe(VARIANTS.reduce((n, v) => n + templatesForSport(v.sportKey).length, 0));
  });

  it("galleryCells is galleryMatrix over the shipped sports, scenes and samples", () => {
    expect(galleryCells(OVERLAY_TEMPLATES, VARIANTS)).toEqual(
      galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, OVERLAY_SCENES, GALLERY_MOMENT_SAMPLES, VARIANTS),
    );
  });

  it("the empty case: no sports, no samples, no variants → no cells", () => {
    expect(galleryMatrix(OVERLAY_TEMPLATES, [], OVERLAY_SCENES, [], [])).toEqual([]);
  });
});

describe("decision 8 (D14) — a scene's momentsFire is the one authority for moment cells", () => {
  it("a scene that does not fire gets plain cells but NO moment cell", () => {
    const scenes: OverlaySceneDef[] = [
      { id: "live", labelKey: "stream.scene.live", momentsFire: true },
      { id: "held", labelKey: "stream.scene.live", momentsFire: false },
    ];
    const cells = galleryMatrix(OVERLAY_TEMPLATES, OVERLAY_SPORT_KEYS, scenes, GALLERY_MOMENT_SAMPLES, []);
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
