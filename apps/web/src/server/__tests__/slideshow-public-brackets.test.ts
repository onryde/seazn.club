// ST-G7 (W4 app A Task 23) — a finished bracket is drawn as a bracket on /present, never as a standings table.
//
// Every bracket stage writes a placement snapshot when it completes (`completeStageIfReady`: the engine's
// `placementTable(finalRanks)` — rank only, every count zero). The public slideshow drew one standings slide per
// snapshot whatever its stage was, so a finished knockout came back as an all-zero "table" beside its own bracket
// slide. The organiser board never did: it walks table stages only.
//
// Swept over every stage kind the ENGINE declares (`StageKind.options`), partitioned by the engine's own bracket set
// (`BRACKET_STAGE_KINDS`) — the expected answer comes from those declarations, never from the slideshow's own sets. The
// snapshot is the engine's own placement table, the exact rows production stores. Pure, no DB.
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { BRACKET_STAGE_KINDS, placementTable } from "@seazn/engine/competition";
import { buildPublicDivisionSlides, type PublicSlideInput } from "../slideshow-data";
import enPublic from "@/dictionaries/en/public.json";

const ENTRANTS = ["e1", "e2", "e3", "e4"];
const entrants = ENTRANTS.map((id, i) => ({ id, display_name: ["Mexico", "Canada", "Japan", "Ghana"][i]! }));
const placement = () => placementTable(ENTRANTS).rows as unknown as PublicSlideInput["standings"][number]["rows"];

const standingsCaptions = (slides: Awaited<ReturnType<typeof buildPublicDivisionSlides>>) =>
  slides.flatMap((s) => (s.kind === "standings" ? [s.caption] : []));

describe("ST-G7 a finished knockout is not a standings table in /present", () => {
  it("every engine stage kind: a bracket's placement snapshot draws no table; a table stage's snapshot draws one", async () => {
    const kinds = StageKind.options;
    const bracket = kinds.filter((k) => BRACKET_STAGE_KINDS.has(k));
    const table = kinds.filter((k) => !BRACKET_STAGE_KINDS.has(k));
    let checked = 0;
    for (const kind of kinds) {
      const input: PublicSlideInput = {
        division: { id: "d1", name: "Open" },
        stages: [{ id: "s1", kind, name: `Stage ${kind}` }],
        pools: [],
        fixtures: [],
        standings: [{ stage_id: "s1", pool_id: null, rows: placement() }],
        entrants,
      };
      const captions = standingsCaptions(await buildPublicDivisionSlides(input));
      expect(captions, kind).toEqual(BRACKET_STAGE_KINDS.has(kind) ? [] : [`Stage ${kind}`]);
      checked++;
    }
    // Anti-vacuity: every declared kind ran, and both halves of the partition are non-empty.
    expect(checked).toBe(kinds.length);
    expect(bracket.length, "bracket kinds swept").toBeGreaterThan(0);
    expect(table.length, "table kinds swept").toBeGreaterThan(0);
    expect(bracket.length + table.length).toBe(kinds.length);
  });

  it("a group then a finished knockout: the pools keep their tables, the knockout keeps only its bracket slide", async () => {
    const pool = (key: string) => `Groups — ${enPublic["table.poolLabel"].replace("{key}", key)}`;
    const ko = (id: string, round_no: number, seq_in_round: number, home: string, away: string, winner: string) => ({
      id, stage_id: "sk", round_no, seq_in_round, home_entrant_id: home, away_entrant_id: away,
      status: "decided", summary: { headline: "2–1" }, outcome: { kind: "win", winner, loser: winner === home ? away : home },
    });
    const input: PublicSlideInput = {
      division: { id: "d1", name: "Open" },
      stages: [
        { id: "sg", kind: "group", name: "Groups" },
        { id: "sk", kind: "knockout", name: "Finals" },
      ],
      pools: [
        { id: "pA", stage_id: "sg", key: "A" },
        { id: "pB", stage_id: "sg", key: "B" },
      ],
      fixtures: [ko("k1", 1, 1, "e1", "e4", "e1"), ko("k2", 1, 2, "e2", "e3", "e2"), ko("kf", 2, 1, "e1", "e2", "e1")],
      standings: [
        { stage_id: "sg", pool_id: "pA", rows: placementTable(["e1", "e3"]).rows as never },
        { stage_id: "sg", pool_id: "pB", rows: placementTable(["e2", "e4"]).rows as never },
        // The knockout's placement snapshot, as `completeStageIfReady` writes it on completion.
        { stage_id: "sk", pool_id: null, rows: placementTable(["e1", "e2", "e3", "e4"]).rows as never },
      ],
      entrants,
    };
    const slides = await buildPublicDivisionSlides(input);
    expect(standingsCaptions(slides)).toEqual([pool("A"), pool("B")]);
    // The knockout is still on the screen — as the bracket it is.
    expect(slides.filter((s) => s.kind === "bracket").map((s) => (s as { title: string }).title)).toEqual(["Finals"]);
  });
});
