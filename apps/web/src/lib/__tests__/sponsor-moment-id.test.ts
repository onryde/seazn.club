// R4 sponsors on stream, final review m3: the moment-id grammar has ONE authority, lib/sponsor-moment-id.ts.
//
// Expected values: the shapes are the plan's (P5: `scene:<sceneId>:<floor(startedAtMs / 10 000)>`; S4: the queue's
// `${seq}:${kind}` with kind `sponsor.<breakKind>`), the break kinds the engine's own `naturalBreaks` declarations (swept
// over the whole sport registry, count reported), and the scenes the carousel's own declaration (`SPONSOR_CAROUSEL_SCENES`).
// The last `it` is the authority guard: no other production file spells either shape.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { carouselMomentId } from "@/components/overlay/sponsor-card";
import { SCENE_CAROUSEL_MS, sponsorMomentId as planMomentId } from "@/lib/sponsor-plan";
import { SPONSOR_MOMENT_KIND_PREFIX as QUEUE_PREFIX, isSponsorMomentId as queueIsSponsor } from "@/lib/overlay-moments";
import {
  SPONSOR_MOMENT_KIND_PREFIX,
  breakKindOfMomentId,
  isSponsorMomentId,
  sceneMomentId,
  sceneOfMomentId,
  sponsorMomentId,
  sponsorMomentKind,
} from "../sponsor-moment-id";

const DECLARED_KINDS = [...new Set(builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => k.kind)))];

describe("the break card's id: <seq>:sponsor.<breakKind>", () => {
  it("round-trips every break kind a shipped sport declares, at seq 0 and a later seq (count reported)", () => {
    let checked = 0;
    for (const kind of DECLARED_KINDS) {
      for (const seq of [0, 1, 37]) {
        const id = sponsorMomentId(seq, kind);
        expect(id).toBe(`${seq}:sponsor.${kind}`);
        expect(breakKindOfMomentId(id), id).toBe(kind);
        expect(sceneOfMomentId(id), `${id} is not a scene id`).toBeNull();
        expect(isSponsorMomentId(id), `${id} is a sponsor queue id`).toBe(true);
        checked++;
      }
    }
    expect(DECLARED_KINDS.length, "the registry declares break kinds").toBeGreaterThan(0);
    expect(checked).toBe(DECLARED_KINDS.length * 3);
  });

  it("the queue kind is the prefix + the break kind, and the queue id is `${seq}:${kind}`", () => {
    expect(SPONSOR_MOMENT_KIND_PREFIX).toBe("sponsor.");
    expect(sponsorMomentKind("over_end")).toBe("sponsor.over_end");
    expect(sponsorMomentId(12, "over_end")).toBe(`12:${sponsorMomentKind("over_end")}`);
  });

  it("refuses what the shape is not: a leading zero, a signed or fractional seq, no seq, an empty kind, another prefix (count reported)", () => {
    const bad = ["01:sponsor.over_end", "-1:sponsor.over_end", "1.5:sponsor.over_end", ":sponsor.over_end", "1:sponsor.", "1:sponsorover_end", "1:score.goal", "sponsor.over_end", ""];
    let refused = 0;
    for (const id of bad) {
      expect(breakKindOfMomentId(id), JSON.stringify(id)).toBeNull();
      refused++;
    }
    expect(refused).toBe(bad.length);
    // A score moment's queue id is not a sponsor's.
    expect(isSponsorMomentId("12:goal")).toBe(false);
    expect(isSponsorMomentId("12:set_end")).toBe(false);
  });
});

describe("the carousel showing's id: scene:<sceneId>:<bucket>", () => {
  it("round-trips every scene the carousel airs in, through the carousel's own builder (P5's bucket), and is never a break id (count reported)", () => {
    let checked = 0;
    for (const scene of SPONSOR_CAROUSEL_SCENES) {
      for (const startedAtMs of [0, SCENE_CAROUSEL_MS - 1, SCENE_CAROUSEL_MS, 1_730_000_123_456]) {
        const id = carouselMomentId(scene, startedAtMs);
        expect(id).toBe(`scene:${scene}:${Math.floor(startedAtMs / 10_000)}`);
        expect(sceneOfMomentId(id), id).toBe(scene);
        expect(breakKindOfMomentId(id), `${id} is not a break id`).toBeNull();
        checked++;
      }
    }
    expect(SPONSOR_CAROUSEL_SCENES.length).toBeGreaterThan(0);
    expect(checked).toBe(SPONSOR_CAROUSEL_SCENES.length * 4);
    expect(sceneMomentId("starting", 7)).toBe("scene:starting:7");
  });

  it("refuses what the shape is not: a leading zero, a negative or fractional bucket, a scene with a colon, no scene (count reported)", () => {
    const bad = ["scene:starting:01", "scene:starting:-1", "scene:starting:1.5", "scene:a:b:1", "scene::1", "scene:starting", "starting:1", ""];
    let refused = 0;
    for (const id of bad) {
      expect(sceneOfMomentId(id), JSON.stringify(id)).toBeNull();
      refused++;
    }
    expect(refused).toBe(bad.length);
  });
});

describe("one authority", () => {
  it("the planner's and the queue's names are this module's, not copies", () => {
    expect(planMomentId).toBe(sponsorMomentId);
    expect(QUEUE_PREFIX).toBe(SPONSOR_MOMENT_KIND_PREFIX);
    expect(queueIsSponsor).toBe(isSponsorMomentId);
  });

  it("no other production file spells either shape: the `:sponsor.` join, the `sponsor.` prefix literal, or a `scene:` id (comments ignored; files scanned reported)", () => {
    const SRC = join(__dirname, "../..");
    const AUTHORITY = "lib/sponsor-moment-id.ts";
    const SPELLINGS: Array<[string, RegExp]> = [
      ["the break id's `:sponsor.` join", /:sponsor\\?\./],
      ["the `sponsor.` prefix as a literal", /["'`]sponsor\.["'`]/],
      ["a `scene:` id", /["'`/^]scene:/],
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel === AUTHORITY) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [what, re] of SPELLINGS) if (re.test(code)) offenders.push(`${rel}: ${what}`);
    }
    expect(files.length, "production files scanned").toBeGreaterThan(500);
    expect(offenders).toEqual([]);
    // The guard is not vacuous: the authority itself trips every spelling.
    const own = stripComments(readFileSync(join(SRC, AUTHORITY), "utf8"));
    expect(SPELLINGS.filter(([, re]) => re.test(own)).map(([w]) => w)).toEqual(SPELLINGS.map(([w]) => w));
  });
});
