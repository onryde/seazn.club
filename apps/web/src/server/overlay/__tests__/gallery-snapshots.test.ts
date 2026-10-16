// The gallery's snapshots (R2007 step 5.2 and 5.3; decision 6): engine events folded through the REAL `foldFrom` and
// projected through the REAL `projectOverlayLiveData` — no DB, no hand-built `OverlayLiveData`. Each is then run
// through the overlay's own model and `slateStateOf` (the card layer's authority), so a snapshot that does not show
// the state its kind names fails here, not on a staff member's screen.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overlayModel, type OverlayMsg } from "@/lib/overlay-model";
import { MOMENT_RULES } from "@/lib/overlay-moments";
import { t } from "@/lib/i18n-runtime";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { slateStateOf } from "@/components/overlay/overlay-slate";
import { GALLERY_RESULT_VARIANT_SPORTS, GALLERY_SNAPSHOT_KINDS } from "@/components/overlay/gallery-matrix";
import type { AnySportModule } from "@seazn/engine/sport";
import { GALLERY_SIDES, galleryResultVariants, gallerySnapshots, walkToDecision } from "../gallery-snapshots";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));
const msg: OverlayMsg = (key, vars) => t(DICT, key, vars);

const modelOf = (sportKey: string, data: OverlayLiveData) =>
  overlayModel({
    sportKey,
    data,
    sides: [...GALLERY_SIDES] as [(typeof GALLERY_SIDES)[0], (typeof GALLERY_SIDES)[1]],
    startLabel: null,
    clockLabel: null,
    msg,
    decidedTemplates: decidedOutcomeTemplates((k) => k),
    forfeitCopy: forfeitCopyOf((key) => DICT[key] ?? key),
  });

describe("gallerySnapshots — every sport, every kind, each showing the state it names", () => {
  const snapshots = gallerySnapshots();

  it("11 sports × 3 kinds, and slateStateOf(model) is the kind's own name", () => {
    let n = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      for (const kind of GALLERY_SNAPSHOT_KINDS) {
        const data = snapshots[sport]?.[kind];
        expect(data, `${sport}/${kind} missing`).toBeDefined();
        expect(slateStateOf(modelOf(sport, data!)), `${sport}/${kind}`).toBe(kind);
        n++;
      }
    }
    console.log(`snapshots: ${n}`);
    expect(n, "anti-vacuity").toBeGreaterThan(0);
    expect(n).toBe(33);
    expect(Object.keys(snapshots).sort()).toEqual([...OVERLAY_SPORT_KEYS].sort());
  });

  it("every ended snapshot carries a verdict decided by PLAY — an outcome, decided, and never an award", () => {
    let n = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      const ended = snapshots[sport]!.ended;
      expect(ended.outcome, sport).not.toBeNull();
      expect(ended.status, sport).toBe("decided");
      expect((ended.outcome as { kind?: string }).kind, `${sport}: an award is not play`).not.toBe("award");
      expect(modelOf(sport, ended).decided, sport).toBe(true);
      n++;
    }
    console.log(`ended checked: ${n}`);
    expect(n).toBe(11);
  });

  it("every warming snapshot is a scheduled fixture with nothing folded", () => {
    for (const sport of OVERLAY_SPORT_KEYS) {
      const warming = snapshots[sport]!.warming;
      expect(warming.status, sport).toBe("scheduled");
      expect(warming.summary, sport).toBeNull();
      expect(warming.outcome, sport).toBeNull();
    }
  });

  it("live: a scoring sport has a running score; every sport carries both GALLERY_SIDES names", () => {
    // The score-checked set is DERIVED from MOMENT_RULES: a sport with a moment rule scores as it goes.
    const scoring = Object.entries(MOMENT_RULES)
      .filter(([, rules]) => Object.keys(rules).length > 0)
      .map(([sport]) => sport);
    let scoreChecked = 0;
    let nameChecked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      const live = snapshots[sport]!.live;
      expect(live.status, sport).toBe("in_play");
      const model = modelOf(sport, live);
      if (scoring.includes(sport)) {
        const scored = model.sides.some((s) => /[1-9]/.test(s.big));
        expect(scored, `${sport}: live shows ${model.sides.map((s) => s.big).join(" / ")}`).toBe(true);
        scoreChecked++;
      }
      expect(model.sides.map((s) => s.name), sport).toEqual(GALLERY_SIDES.map((s) => s.name));
      nameChecked++;
    }
    console.log(`live samples score-checked: ${scoreChecked}, name-checked: ${nameChecked}`);
    expect(scoreChecked, "anti-vacuity").toBeGreaterThan(0);
    expect(nameChecked).toBe(11);
  });

  it("GALLERY_SIDES: the second name is the 43-character one that exposed the truncate defect", () => {
    expect(GALLERY_SIDES.map((s) => s.id)).toEqual(["home", "away"]);
    expect(GALLERY_SIDES[1].name).toHaveLength(43);
  });
});

describe("galleryResultVariants — every status whose Result card is not 'decided by play' (review m11)", () => {
  // The expected status set comes from the status UNION and the card layer's own authority, never from the producer:
  // a fixture in that status, with no verdict, shows the ended card.
  const expectedStatuses = FIXTURE_STATUSES.filter(
    (status) =>
      status !== "decided" &&
      slateStateOf(
        modelOf("badminton", { status, summary: null, outcome: null, lastSeq: 1, venueTz: "UTC" } as OverlayLiveData),
      ) === "ended",
  );

  it("premise: the status union yields the ended statuses the brief expects at pin, and any more it grew", () => {
    for (const s of ["cancelled", "forfeited", "abandoned", "needs_decision"]) expect(expectedStatuses).toContain(s);
  });

  it("one variant per (sport, status), each produced through the real producers, each showing the ended card", () => {
    const variants = galleryResultVariants();
    for (const sport of GALLERY_RESULT_VARIANT_SPORTS) {
      const statuses = variants.filter((v) => v.variant.sportKey === sport).map((v) => v.variant.status);
      expect([...statuses].sort(), sport).toEqual([...expectedStatuses].sort());
    }
    let n = 0;
    for (const { variant, snapshot } of variants) {
      expect(snapshot.status, `${variant.sportKey}/${variant.status}`).toBe(variant.status);
      expect(slateStateOf(modelOf(variant.sportKey, snapshot)), `${variant.sportKey}/${variant.status}`).toBe("ended");
      n++;
    }
    console.log(`result variants: ${n} (statuses: ${expectedStatuses.join(", ")})`);
    expect(n, "anti-vacuity").toBeGreaterThan(0);
    expect(n).toBe(GALLERY_RESULT_VARIANT_SPORTS.length * expectedStatuses.length);
  });

  it("the walkover is an AWARD folded from the engine's forfeit — a real verdict, not a row with a word on it", () => {
    for (const { variant, snapshot } of galleryResultVariants()) {
      if (variant.status !== "forfeited") continue;
      expect(snapshot.outcome, variant.sportKey).not.toBeNull();
      expect(modelOf(variant.sportKey, snapshot).decided, variant.sportKey).toBe(true);
    }
  });
});

// Review I-1's rule (outcome-readers.test.ts) as a guard, not a comment: the sample walk records PLAY, so it never hands
// a module an event the kernel folds itself (suspend, resume, settle, the lineup family) or one that ends the match by
// something other than play. It redraws such an event, and a generator that yields nothing else is refused by name.
describe("walkToDecision — the sample walk only ever applies play", () => {
  const stuckOn = (type: string): AnySportModule =>
    ({
      init: () => ({}),
      apply: () => {
        throw new Error(`the walk applied ${type}`);
      },
      outcome: () => null,
      arbitraryEvent: () => ({ type, payload: {} }),
    }) as unknown as AnySportModule;

  it.each(["core.settle", "core.suspend", "core.resume", "core.forfeit", "core.abandon"])(
    "a generator that only yields %s is refused by name, never applied",
    (type) => {
      expect(() => walkToDecision("probe", stuckOn(type), {}, {} as never)).toThrow(
        new RegExp(`probe's generator kept yielding ${type.replace(".", "\\.")}`),
      );
    },
  );

  it("the positive pair: a kernel-owned draw is REDRAWN, and only the play event that follows is applied", () => {
    let draws = 0;
    const applied: string[] = [];
    const redrawn = {
      init: () => ({ decided: false }),
      apply: (_s: unknown, ev: { type: string }) => {
        applied.push(ev.type);
        return { decided: true };
      },
      outcome: (st: { decided: boolean }) => (st.decided ? { kind: "draw" } : null),
      arbitraryEvent: () => (++draws <= 3 ? { type: "core.settle", payload: {} } : { type: "probe.point", payload: {} }),
    } as unknown as AnySportModule;
    const played = walkToDecision("probe", redrawn, {}, {} as never);
    expect(draws, "three settles drawn, then the point").toBe(4);
    expect(applied).toEqual(["probe.point"]);
    expect(played.map((e) => e.type)).toEqual(["probe.point"]);
  });
});
