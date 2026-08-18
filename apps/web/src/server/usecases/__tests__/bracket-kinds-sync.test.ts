// B (round-4 review, "smaller, still real"): BRACKET_STAGE_KINDS
// (packages/engine/src/competition/progression.ts) is a THIRD hand-copied
// literal of the same 4 strings as apps/web's two BRACKET_KINDS constants
// (usecases/stages.ts, server/engine-db/competition.ts) — three independent
// lists that must stay identical by hand, no shared source. Both
// placeDescriptors' ruling-13 bracket-target guard (progression.ts) and
// completeStageIfReady's kind dispatch (engine-db/competition.ts) fail OPEN
// on an unrecognised kind (progression.ts's own doc comment: an
// absent/unrecognised targetKind means "unknown, don't refuse") — so a
// future 5th bracket-shaped stage kind added to two of these lists and
// missed in the third would silently disable ruling 13's guard for that
// kind: no test red, no runtime error, just a quietly-worse draw. Pure, no
// DB — this file exists solely as the cross-file tripwire; it does not
// belong thematically inside any of the three files it watches.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS as USECASES_BRACKET_KINDS } from "../stages";
import { BRACKET_KINDS as ENGINE_DB_BRACKET_KINDS } from "../../engine-db/competition";
import { BRACKET_STAGE_KINDS as ENGINE_BRACKET_STAGE_KINDS } from "@seazn/engine/competition";

describe("the three hand-copied bracket-kind lists stay in sync", () => {
  it("usecases/stages.ts, engine-db/competition.ts and the engine's progression.ts all name the SAME set of bracket-shaped stage kinds", () => {
    const fromUsecases = new Set(USECASES_BRACKET_KINDS);
    const fromEngineDb = new Set(ENGINE_DB_BRACKET_KINDS);
    const fromEngine = new Set(ENGINE_BRACKET_STAGE_KINDS);
    expect(fromEngineDb).toEqual(fromUsecases);
    expect(fromEngine).toEqual(fromUsecases);
  });
});
