// W5 app PR A, Task 3 fix round 1 (X-BD-7; owner R24: a one-pool division shows no letter): a one-pool group now has a pool row, but its table is
// headed by the stage's name alone. `poolNaming` / `poolCaption` are the ONE authority; this sweep pins the helper over the four locales and the
// eight surfaces that print a pool caption, each of which must go through it (a surface that kept `snap.pool_id ? "Stage - Group A"` regresses).
// Every sweep reports its count; zero checked is a failure; the empty case comes first.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { poolNaming, poolCaption, poolLabel } from "../pool-label";

const DICTS: Record<string, Dict> = { en: en as unknown as Dict, es: es as unknown as Dict, fr: fr as unknown as Dict, nl: nl as unknown as Dict };
const P = (id: string, key: string, stage_id: string) => ({ id, key, stage_id });

const keysOf = (m: Map<string, string | null>) => [...m].filter(([, k]) => k !== null).map(([id, k]) => [id, k]);

describe("poolNaming", () => {
  it("the empty case first: no pools names none", () => {
    expect(poolNaming([]).size).toBe(0);
  });

  it("a stage with ONE pool names none (a one-pool group reads as a league); a stage with two names both", () => {
    expect(poolNaming([P("a", "A", "s1")]).get("a")).toBeNull();
    expect(keysOf(poolNaming([P("a", "A", "s1"), P("b", "B", "s1")]))).toEqual([["a", "A"], ["b", "B"]]);
  });

  it("per stage, not per division: a one-pool stage beside a two-pool stage names only the two-pool stage's pools", () => {
    const named = poolNaming([P("a", "A", "s1"), P("b", "A", "s2"), P("c", "B", "s2")]);
    expect(keysOf(named).map(([id]) => id)).toEqual(["b", "c"]);
    expect(named.get("a")).toBeNull();
  });

  it("a read with no stage_id (one stage's pools) is judged as one stage", () => {
    expect(keysOf(poolNaming([{ id: "a", key: "A" }])).length).toBe(0);
    expect(keysOf(poolNaming([{ id: "a", key: "A" }, { id: "b", key: "B" }])).length).toBe(2);
  });
});

describe("poolCaption", () => {
  it("every locale: a named pool is 'Stage - <that locale's pool word> A'; a one-pool stage and a stage-wide table are the bare stage name; a pool the read does not list keeps the bare pool word", () => {
    let checked = 0;
    const two = poolNaming([P("a", "A", "s1"), P("b", "B", "s1")]);
    const one = poolNaming([P("x", "A", "s2")]);
    for (const [loc, dict] of Object.entries(DICTS)) {
      expect(poolCaption(dict, "Groups", "a", two), loc).toBe(`Groups \u2014 ${poolLabel(dict, "A")}`);
      expect(poolCaption(dict, "Groups", "x", one), `${loc}: one pool`).toBe("Groups");
      expect(poolCaption(dict, "Groups", null, two), `${loc}: stage-wide`).toBe("Groups");
      expect(poolCaption(dict, "Groups", "nope", two), `${loc}: unlisted`).toBe(`Groups \u2014 ${poolLabel(dict, undefined)}`);
      checked += 4;
    }
    expect(checked).toBe(16);
  });
});

// The eight surfaces the review named. Each must name its pools through the one authority: a source scan, because nothing else renders all
// eight (a public page, a PDF, a poster, a slideshow...). Behaviour is proven where a test can reach it (poster-draw.test.ts, the DB
// tests of single-pool-id.test.ts for the board, the desk's chip list and the capture stage); this pins the call, per surface, to the
// token that surface owes. The list is the review's, typed here; a ninth surface is a new line.
const SURFACES: readonly (readonly [string, RegExp])[] = [
  ["app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx", /\blistNamedPools\(/],
  ["app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx", /\bpoolNaming\(/],
  ["app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx", /\bpoolNaming\(/],
  ["app/embed/divisions/[id]/[widget]/page.tsx", /\bpoolNaming\(/],
  ["server/public-site/competition-hub.ts", /\bpoolNaming\(/],
  ["server/slideshow-data.ts", /\bpoolNaming\(pools\)/],
  ["server/slideshow-data.ts", /\bpoolNaming\(data\.pools\)/],
  ["server/usecases/exports.ts", /\bpoolNaming\(/],
  ["lib/poster-draw.ts", /\bpoolNaming\(pools\)/],
  ["app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx", /\bpoolCaption\(publicDict, stage\.name, p\.id, named\)/],
  ["app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx", /\bpoolCaption\(dict, stage\.name, snap\.pool_id, poolKey\)/],
  ["app/embed/divisions/[id]/[widget]/page.tsx", /\bpoolCaption\(dict, stage\.name, snap\.pool_id, poolKey\)/],
  ["server/public-site/competition-hub.ts", /\bpoolCaption\(dict, stage\.name, snap\.pool_id, poolKey\)/],
  ["server/slideshow-data.ts", /\bpoolCaption\(publicDict, stage\.name, p\.id, named\)/],
  ["server/slideshow-data.ts", /\bpoolCaption\(publicDict, stage\.name, snap\.pool_id, poolNamed\)/],
  ["server/usecases/exports.ts", /\bpoolCaption\(publicDict, table\.stage_name, table\.pool_id, poolKey\)/],
  ["server/usecases/capture-stage.ts", /\binSeveralPoolsSql\(/],
  ["server/usecases/fixtures.ts", /\binSeveralPoolsSql\(/],
];

describe("every surface that prints a pool caption goes through the one helper", () => {
  it("each surface calls its token and none builds \"Stage - Group A\" itself", () => {
    let checked = 0;
    for (const [rel, token] of SURFACES) {
      const src = readFileSync(join(__dirname, "../..", rel), "utf8");
      expect(src, `${rel} must call ${token}`).toMatch(token);
      expect(src, `${rel} must not build "Stage - Group A" itself`).not.toMatch(/`\$\{[a-zA-Z.]*(stage|table)[_.]?[nN]ame\} \u2014 \$\{poolLabel\(/);
      checked += 1;
    }
    expect(checked).toBe(18);
    expect(new Set(SURFACES.map(([rel]) => rel)).size, "the review's eight surfaces, plus the board's pool_key").toBe(9);
  });
});
