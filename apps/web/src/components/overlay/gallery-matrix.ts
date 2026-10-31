// The staff overlay gallery's cells and moment samples (R2007; spec 2026-10-15 §4.8). PURE: no server import, no
// React — the gallery page builds the cell list on the server and the e2e renders it 1:1, so this file is the gallery's
// ONE cell source (review I3) and every sweep over the gallery is a sweep over these cells.
//
// A cell is one (template × sport × scene × snapshot kind), plus one per moment sample in each scene whose moments
// fire, plus one per Result-card variant, plus (R4 S7) one per sponsor slot each template declares, per sport, and one
// per carousel scene for each carousel sport. Templates come from the registry passed IN, never from `OVERLAY_TEMPLATES`
// directly: `template-extensibility.test.ts` hands it a registry with a throwaway entry and expects that entry's cells.
import type { RecentEvent } from "@/lib/overlay-recent-types";
import { SPONSOR_STYLE_BY_SIZE, planSponsors, type SponsorCard, type SponsorPlan, type SponsorStyle } from "@/lib/sponsor-plan";
import { OVERLAY_SPORT_KEYS } from "./overlay-tokens";
import { OVERLAY_SCENES, SPONSOR_CAROUSEL_SCENES, type OverlaySceneDef, type SceneId } from "./overlay-scenes";
import { templatesForSportFrom, type TemplateRegistry } from "./template-registry";

export type GallerySnapshotKind = "warming" | "live" | "ended";
export const GALLERY_SNAPSHOT_KINDS: readonly GallerySnapshotKind[] = ["warming", "live", "ended"];

export interface MomentSample {
  id: string;
  sportKey: string;
  /** The `MOMENT_RULES` key this sample exercises — an engine event type, `derived.setWon` or `derived.pointState`. */
  ruleKey: string;
  event: RecentEvent;
}

const AT = "2026-10-15T19:30:00.000Z";
/** A sample event: `seq` 41 throughout (any value above the slab's baseline of `seq − 1`), at a fixed instant. */
const ev = (type: string, payload: RecentEvent["payload"], derived?: RecentEvent["derived"]): RecentEvent => ({
  seq: 41,
  type,
  at: AT,
  payload,
  ...(derived ? { derived } : {}),
});
const person = (name: string) => ({ name, masked: false });

/**
 * Decision 7: at least one sample per `(sport, rule key)` in `MOMENT_RULES`, and three for cricket's `cricket.ball`
 * (six, four, wicket — spec §4.8 names all three): 19 at pin. Each is a `RecentEvent` carrying exactly the fields its
 * rule reads (`server/overlay/recent.ts` is the shape's producer); the gallery derives the slab from it through the real
 * `momentsFor`, never a typed headline. `gallery-matrix.test.ts` holds the coverage exact and proves each one fires
 * through its own rule.
 */
export const GALLERY_MOMENT_SAMPLES: readonly MomentSample[] = [
  {
    id: "cricket-six",
    sportKey: "cricket",
    ruleKey: "cricket.ball",
    event: ev("cricket.ball", { person: person("Rashida Okonkwo"), runs: 6, boundary: 6 }),
  },
  {
    id: "cricket-four",
    sportKey: "cricket",
    ruleKey: "cricket.ball",
    event: ev("cricket.ball", { person: person("Tomasz Wiśniewski"), runs: 4, boundary: 4 }),
  },
  {
    id: "cricket-wicket",
    sportKey: "cricket",
    ruleKey: "cricket.ball",
    event: ev("cricket.ball", { person: person("Rashida Okonkwo"), runs: 0, wicketKind: "caught" }, { batter: { runs: 47, balls: 31 } }),
  },
  {
    id: "cricket-superover-six",
    sportKey: "cricket",
    ruleKey: "cricket.superover.ball",
    event: ev("cricket.superover.ball", { person: person("Tomasz Wiśniewski"), runs: 6, boundary: 6 }),
  },
  {
    id: "football-goal",
    sportKey: "football",
    ruleKey: "football.goal",
    event: ev("football.goal", { side: 0, person: person("Ada Okafor"), penalty: true }),
  },
  {
    id: "football-card",
    sportKey: "football",
    ruleKey: "football.card",
    event: ev("football.card", { side: 1, person: person("Callum MacLeod-Brennan"), colour: "yellow" }),
  },
  {
    id: "hockey-goal",
    sportKey: "hockey",
    ruleKey: "hockey.goal",
    event: ev("hockey.goal", { side: 0, person: person("Ines van der Berg"), kind: "pc" }),
  },
  {
    id: "hockey-card",
    sportKey: "hockey",
    ruleKey: "hockey.suspension.start",
    event: ev("hockey.suspension.start", { side: 1, person: person("Priya Raghunathan"), class: "green" }),
  },
  {
    id: "icehockey-goal",
    sportKey: "icehockey",
    ruleKey: "icehockey.goal",
    event: ev("icehockey.goal", { side: 0, person: person("Mikko Lehtonen"), kind: "pp" }),
  },
  {
    id: "icehockey-penalty",
    sportKey: "icehockey",
    ruleKey: "icehockey.suspension.start",
    event: ev("icehockey.suspension.start", { side: 1, person: person("Jean-Sébastien Tremblay"), class: "minor" }),
  },
  {
    id: "tennis-ace",
    sportKey: "tennis",
    ruleKey: "tennis.point",
    event: ev("tennis.point", { side: 0, person: person("Elena Kovačević"), kind: "ace" }),
  },
  {
    id: "tennis-set",
    sportKey: "tennis",
    ruleKey: "derived.setWon",
    event: ev("tennis.point", { side: 0 }, { setWon: { set: 1, winner: 0, home: 6, away: 4 } }),
  },
  {
    id: "tennis-match-point",
    sportKey: "tennis",
    ruleKey: "derived.pointState",
    event: ev("tennis.point", { side: 0 }, { pointState: { kind: "match", side: 0, fresh: true } }),
  },
  {
    id: "badminton-game",
    sportKey: "badminton",
    ruleKey: "derived.setWon",
    event: ev("badminton.rally", { side: 0 }, { setWon: { set: 1, winner: 0, home: 21, away: 17 } }),
  },
  {
    id: "badminton-game-point",
    sportKey: "badminton",
    ruleKey: "derived.pointState",
    event: ev("badminton.rally", { side: 1 }, { pointState: { kind: "set", side: 1, fresh: true } }),
  },
  {
    id: "tabletennis-game",
    sportKey: "tabletennis",
    ruleKey: "derived.setWon",
    event: ev("tabletennis.rally", { side: 1 }, { setWon: { set: 2, winner: 1, home: 9, away: 11 } }),
  },
  {
    id: "tabletennis-match-point",
    sportKey: "tabletennis",
    ruleKey: "derived.pointState",
    event: ev("tabletennis.rally", { side: 0 }, { pointState: { kind: "match", side: 0, fresh: true } }),
  },
  {
    id: "volleyball-set",
    sportKey: "volleyball",
    ruleKey: "derived.setWon",
    event: ev("volleyball.rally", { side: 0 }, { setWon: { set: 3, winner: 0, home: 25, away: 23 } }),
  },
  {
    id: "volleyball-set-point",
    sportKey: "volleyball",
    ruleKey: "derived.pointState",
    event: ev("volleyball.rally", { side: 1 }, { pointState: { kind: "set", side: 1, fresh: true } }),
  },
];

/** A Result-card variant other than "decided by play" (void, walkover, abandoned, …; review m11). */
export interface ResultVariant {
  status: string;
  sportKey: string;
}

/** The two sports result variants are drawn for: cricket (the bar default, the longest card text) and badminton (the
 *  bug default). The card layout is sport-agnostic apart from the score line, so two sports cover both templates'
 *  defaults. */
export const GALLERY_RESULT_VARIANT_SPORTS = ["cricket", "badminton"] as const;

/** R4 S7: the two sports carousel cells are drawn for — the two templates' defaults, as for result variants. The card
 *  layout is sport-agnostic apart from the palette, which the sponsor slot cells already sweep across every sport. */
export const GALLERY_CAROUSEL_SPORTS = GALLERY_RESULT_VARIANT_SPORTS;

export interface GalleryCell {
  key: string;
  templateId: string;
  sportKey: string;
  scene: SceneId;
  snapshot: GallerySnapshotKind;
  momentSampleId: string | null;
  resultStatus: string | null;
  /** R4 S7: a sponsor card pinned in this slot (scene "live", snapshot "live"); null otherwise. */
  sponsorSlot: SponsorStyle | null;
  /** R4 S7: WHICH gallery card a sponsor cell pins (`GALLERY_SPONSOR_CARDS`); null on every other cell. */
  sponsorCard: string | null;
  /** R4 S7: the scene carousel's cell (a carousel scene, its cards and no airing). */
  carousel: boolean;
}

/** R4 S7: the gallery's sponsor cards. The title carries the brief's realistic 43-character name, a logo and a short code
 *  — every part of the card's face at its longest; the gold has neither logo nor code (the monogram, no link). */
export const GALLERY_SPONSOR_CARDS: readonly SponsorCard[] = [
  {
    id: "gallery-card-title",
    sponsorId: "gallery-sponsor-title",
    name: "Northbridge Athletic Football & Social Club",
    logoUrl: `data:image/svg+xml,${encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='#16365c'/><path d='M14 46 32 14l18 32z' fill='#f2b705'/></svg>",
    )}`,
    tier: "title",
    onStream: true,
    shortCode: "NB7K",
  },
  { id: "gallery-card-gold", sponsorId: "gallery-sponsor-gold", name: "Harbourside Building Supplies", logoUrl: null, tier: "gold", onStream: true },
];

/** Fix round 1 (m3): the sports whose sponsor cells ALSO pin the plain face — the gold card, no logo (the monogram) and
 *  no short code (no link) — the two templates' defaults, as for result variants. */
export const GALLERY_SPONSOR_FACE_SPORTS = GALLERY_RESULT_VARIANT_SPORTS;

/** The REAL planner's plan for a gallery sponsor cell: one break at the sample seq (41) whose size is the slot's look
 *  (`SPONSOR_STYLE_BY_SIZE`), so the airing is exactly what a broadcast would draw there — naming `cardId` (default: the
 *  title, the first gallery card), the only card ticked. `null` style: the carousel's plan — every card, no airing.
 *  Refuses by name when the planner plans otherwise. */
export function gallerySponsorPlan(style: SponsorStyle | null, cardId: string = GALLERY_SPONSOR_CARDS[0]!.id): SponsorPlan {
  const size = (Object.keys(SPONSOR_STYLE_BY_SIZE) as (keyof typeof SPONSOR_STYLE_BY_SIZE)[]).find(
    (k) => SPONSOR_STYLE_BY_SIZE[k].style === style,
  );
  const plan = planSponsors({
    breaks: size === undefined ? [] : [{ seq: 41, at: AT, kind: size === "major" ? "innings_break" : "over_end", size }],
    windowSeqs: size === undefined ? [] : [41],
    settings: { enabled: true, frequency: "busy" },
    cards: size === undefined ? GALLERY_SPONSOR_CARDS : GALLERY_SPONSOR_CARDS.filter((c) => c.id === cardId),
    assignedCards: [],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: Date.parse(AT) + 1_000,
    complete: true,
  }).plan;
  if (plan === null || plan.airings.length !== (size === undefined ? 0 : 1)) {
    throw new Error(`overlay gallery: the planner planned ${plan?.airings.length ?? "no plan"} airing(s) for ${String(style)}`);
  }
  if (size !== undefined && plan.airings[0]!.cardId !== cardId) {
    throw new Error(`overlay gallery: no gallery card ${cardId} aired for ${String(style)}`);
  }
  return plan;
}

/**
 * Plain cells: every non-retired template suiting the sport × sport × scene × snapshot kind.
 * Moment cells: every non-retired template suiting the sample's sport × sample × every scene whose `momentsFire` is
 * true (snapshot "live"; decision 8). A scene with `momentsFire: false` gets none.
 * Variant cells: every non-retired template suiting the variant's sport × variant (scene "live", snapshot "ended").
 * Sponsor cells (R4 S7, spec 2026-10-27 §3.5): every non-retired template suiting the sport × sport × each slot the
 * template DECLARES (scene "live", snapshot "live"), pinning the title card's full face; for `faceSports`, a second
 * cell per slot pins the gold card's plain face (no logo, no link; fix round 1, m3).
 * Carousel cells (R4 S7): every non-retired template suiting a carousel sport × each scene in `scenes` that carries the
 * carousel (`SPONSOR_CAROUSEL_SCENES`); Starting soon reads the warming snapshot, any other the live one.
 */
export function galleryMatrix(
  registry: TemplateRegistry,
  sports: readonly string[],
  scenes: readonly OverlaySceneDef[],
  samples: readonly MomentSample[],
  variants: readonly ResultVariant[],
  carouselSports: readonly string[],
  faceSports: readonly string[] = [],
): GalleryCell[] {
  const cells: GalleryCell[] = [];
  // `scene.id` is a SceneId for every shipped scene; a test may pass its own scene list to prove the momentsFire rule,
  // and those cells are never rendered.
  const sceneId = (scene: OverlaySceneDef) => scene.id as SceneId;
  for (const sportKey of sports) {
    for (const def of templatesForSportFrom(registry, sportKey)) {
      for (const scene of scenes) {
        for (const snapshot of GALLERY_SNAPSHOT_KINDS) {
          cells.push({
            key: `${def.id}|${sportKey}|${scene.id}|${snapshot}`,
            templateId: def.id,
            sportKey,
            scene: sceneId(scene),
            snapshot,
            momentSampleId: null,
            resultStatus: null,
            sponsorSlot: null,
            sponsorCard: null,
            carousel: false,
          });
        }
      }
      for (const slot of Object.keys(def.sponsorSlots) as SponsorStyle[]) {
        const faces = [GALLERY_SPONSOR_CARDS[0]!, ...((faceSports as readonly string[]).includes(sportKey) ? [GALLERY_SPONSOR_CARDS[1]!] : [])];
        for (const [i, face] of faces.entries()) {
          cells.push({
            key: `${def.id}|${sportKey}|live|sponsor|${slot}${i === 0 ? "" : `|${face.tier}`}`,
            templateId: def.id,
            sportKey,
            scene: "live",
            snapshot: "live",
            momentSampleId: null,
            resultStatus: null,
            sponsorSlot: slot,
            sponsorCard: face.id,
            carousel: false,
          });
        }
      }
    }
  }
  for (const sample of samples) {
    for (const def of templatesForSportFrom(registry, sample.sportKey)) {
      for (const scene of scenes) {
        if (!scene.momentsFire) continue;
        cells.push({
          key: `${def.id}|${sample.sportKey}|${scene.id}|moment|${sample.id}`,
          templateId: def.id,
          sportKey: sample.sportKey,
          scene: sceneId(scene),
          snapshot: "live",
          momentSampleId: sample.id,
          resultStatus: null,
          sponsorSlot: null,
          sponsorCard: null,
          carousel: false,
        });
      }
    }
  }
  for (const variant of variants) {
    for (const def of templatesForSportFrom(registry, variant.sportKey)) {
      cells.push({
        key: `${def.id}|${variant.sportKey}|live|result|${variant.status}`,
        templateId: def.id,
        sportKey: variant.sportKey,
        scene: "live",
        snapshot: "ended",
        momentSampleId: null,
        resultStatus: variant.status,
        sponsorSlot: null,
        sponsorCard: null,
        carousel: false,
      });
    }
  }
  for (const sportKey of carouselSports) {
    for (const def of templatesForSportFrom(registry, sportKey)) {
      for (const scene of scenes) {
        if (!SPONSOR_CAROUSEL_SCENES.includes(sceneId(scene))) continue;
        cells.push({
          key: `${def.id}|${sportKey}|${scene.id}|carousel`,
          templateId: def.id,
          sportKey,
          scene: sceneId(scene),
          snapshot: scene.id === "starting" ? "warming" : "live",
          momentSampleId: null,
          resultStatus: null,
          sponsorSlot: null,
          sponsorCard: null,
          carousel: true,
        });
      }
    }
  }
  return cells;
}

/** The gallery's ONE cell source (review I3): `galleryMatrix` over the shipped sports, scenes and samples. The page
 *  calls it with `OVERLAY_TEMPLATES`, and the extensibility test with a probe registry. */
export function galleryCells(registry: TemplateRegistry, variants: readonly ResultVariant[]): GalleryCell[] {
  return galleryMatrix(
    registry,
    OVERLAY_SPORT_KEYS,
    OVERLAY_SCENES,
    GALLERY_MOMENT_SAMPLES,
    variants,
    GALLERY_CAROUSEL_SPORTS,
    GALLERY_SPONSOR_FACE_SPORTS,
  );
}
