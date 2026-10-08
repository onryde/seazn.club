// EngineError taxonomy — spec 03 §7.
import { describe, expect, it } from "vitest";
import { EngineError, EngineErrorCode } from "./errors.ts";

describe("EngineError", () => {
  it("carries a typed code, message and optional data", () => {
    const error = new EngineError("SEQ_CONFLICT", "expected seq 4, got 2", { expected: 4 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EngineError");
    expect(error.code).toBe("SEQ_CONFLICT");
    expect(error.message).toBe("expected seq 4, got 2");
    expect(error.data).toEqual({ expected: 4 });
  });

  it(".is(code) matches the instance code", () => {
    const error = new EngineError("WRONG_PHASE", "not live");
    expect(error.is("WRONG_PHASE")).toBe(true);
    expect(error.is("INVALID_EVENT")).toBe(false);
  });

  it("static is() narrows unknown errors, optionally by code", () => {
    const error: unknown = new EngineError("ELIGIBILITY", "too old for U16");
    expect(EngineError.is(error)).toBe(true);
    expect(EngineError.is(error, "ELIGIBILITY")).toBe(true);
    expect(EngineError.is(error, "CONFIG_INVALID")).toBe(false);
    expect(EngineError.is(new Error("plain"))).toBe(false);
    expect(EngineError.is("nope")).toBe(false);
  });

  it("code taxonomy matches spec 03 §7", () => {
    expect(EngineErrorCode.options).toEqual([
      "INVALID_EVENT",
      "WRONG_PHASE",
      "ALREADY_DECIDED",
      "LINEUP_INVALID",
      "CONFIG_INVALID",
      "SEQ_CONFLICT",
      "STAGE_NOT_READY",
      // PROMPT-17 scheduling console (doc 12 §2 blocking conflicts)
      "SCHEDULE_CONFLICT",
      // PROMPT-61 draw guard + PROMPT-59 combined qualification (v13)
      "DRAW_NOT_ALLOWED",
      "QUALIFICATION_INVALID",
      "ELIGIBILITY",
      // PROMPT-03 registry additions
      "MODULE_NOT_FOUND",
      "MODULE_DUPLICATE",
      // W4a (#425) §7 core time model — appended last, existing order frozen
      "NON_MONOTONIC_TIME",
      "UNKNOWN_PHASE",
      "EXPEDITE_WRONG_WINNER",
      "SUB_WINDOW_EXCEEDED",
      // S5 (#431) — tennis game-penalty awards, appended last, existing order frozen
      "GAME_AWARD_DURING_TIEBREAK",
      // F2 (unified progression field) — placeDescriptors/
      // validateProgressionAgainstShapes moved from apps/web's
      // stage-seeding.ts into the engine; these four codes moved with them,
      // string-for-string, so the wire-visible error.code an existing client
      // sees is unchanged. Appended last, existing order frozen.
      "SEEDING_RULES_MISSING",
      "SEEDING_MAP_SLOT_INVALID",
      "SEEDING_MAP_SOURCE_INVALID",
      "SEEDING_BESTNTH_UNEQUAL_POOLS",
      // F3 Task 3 (P6) — seeded_map source resolved against >1 progression
      // source. Appended last, existing order frozen.
      "SEEDING_MAP_SOURCE_AMBIGUOUS",
      // W2a (spec §7) — brackets always finish. Appended last, existing order frozen.
      // A settle on a fixture that is not level and not an un-outcomed abandon, or already settled.
      "SETTLE_NOT_APPLICABLE",
      // boardgame.tiebreak outside phase "tiebreak".
      "TIEBREAK_NOT_APPLICABLE",
      // A generic draw in a bracket kind (GN-KO-1); every other level result is held (X-BR-2).
      "LEVEL_RESULT_IN_BRACKET",
      // Assertion: a level result reached bracket seating (X-BR-1). Only a bug reaches it.
      "LEVEL_RESULT_SEATED",
    ]);
  });
});
