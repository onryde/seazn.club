// refusal-copy.test.ts — R6 fix pass 3, gap 1. Two obligations:
//
//   1. the resolver never emits server prose, for ANY code; and
//   2. the code list stays equal to the server's own `statusCode()` map, so a
//      new non-engine code cannot arrive without copy. That map lives in
//      `@/server/api-v1/http.ts`, which the pad bundle may not IMPORT (the
//      purity gate in `server-boundary.test.ts`) — so it is read here as TEXT,
//      the same trick `_globals-css.ts` uses for the compiled stylesheet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MessageKey } from "@/lib/messages";
import type { MsgFn } from "@/lib/scoring-vocab";
import { ENGINE_ERROR_KEY } from "@/lib/scoring-vocab";
import en from "@/dictionaries/en/ui.json";
import { REFUSAL_FALLBACK, REFUSAL_KEY, refusalText } from "../refusal-copy";
import { isPermanentRefusal } from "../transport";

const identityMsg = ((key: string) => key) as MsgFn;
const dict = en as Record<string, string>;

describe("refusalText", () => {
  it("renders nothing when nothing was refused", () => {
    expect(refusalText(null, identityMsg)).toBeNull();
  });

  it("prefers the engine's own localized copy for an engine code", () => {
    expect(refusalText({ code: "WRONG_PHASE", message: "raw engine prose" }, identityMsg)).toBe(
      "engineError.WRONG_PHASE",
    );
  });

  it("gives a known wire code the pad's own words", () => {
    expect(refusalText({ code: "PAYMENT_REQUIRED", message: "Plan upgrade required: x" }, identityMsg)).toBe(
      "scorepad.refusal.planLocked",
    );
  });

  it("gives an unknown code the generic fallback rather than the server's string", () => {
    expect(refusalText({ code: "SOMETHING_NEW", message: "a brand new english sentence" }, identityMsg)).toBe(
      REFUSAL_FALLBACK,
    );
  });

  // The defect in one assertion: whatever the server says, the scorer must
  // never read it. Swept over every code this pad can be handed.
  it("never returns the server's message for ANY code, engine or wire or unknown", () => {
    // W1 (entitlements v18): was `scoring.match_timeline`, a slug the server
    // can no longer put in this field — V390 deleted the row and the same wave
    // deleted its gate. `cricket.dls` is the one feature the scoring door still
    // refuses on, so the fixture is a refusal production can actually produce.
    const prose = "Plan upgrade required: cricket.dls";
    const codes = [...Object.keys(ENGINE_ERROR_KEY), ...Object.keys(REFUSAL_KEY), "UNKNOWN", "INTERNAL", ""];
    for (const code of codes) {
      const text = refusalText({ code, message: prose }, identityMsg);
      expect(text, `code ${code} leaked the server's prose`).not.toBe(prose);
      expect(text, `code ${code} leaked a feature slug`).not.toContain("cricket.dls");
    }
  });
});

describe("every refusal key has real copy in the shipped dictionary", () => {
  it("resolves to a non-empty English string, and never to the key itself", () => {
    const keys: MessageKey[] = [...Object.values(REFUSAL_KEY), REFUSAL_FALLBACK];
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) {
      expect(dict[key], `${key} is missing from en/ui.json`).toBeTruthy();
      expect(dict[key]).not.toBe(key);
    }
  });

  it("every one of them tells the scorer the action did NOT land", () => {
    // The whole defect was a scorer believing a refused penalty was on the
    // sheet, so "not recorded" is load-bearing copy, not tone.
    for (const key of Object.values(REFUSAL_KEY)) {
      expect(dict[key]?.toLowerCase(), `${key}: "${dict[key]}"`).toContain("not recorded");
    }
    expect(dict[REFUSAL_FALLBACK]?.toLowerCase()).toContain("recorded");
  });
});

describe("the wire-code list tracks the server's own statusCode() map", () => {
  /** `case 4xx: return "CODE";` lines from the real server file. */
  function serverCodesFor(statuses: readonly number[]): string[] {
    const src = readFileSync(join(process.cwd(), "src/server/api-v1/http.ts"), "utf8");
    const found: string[] = [];
    for (const status of statuses) {
      const m = new RegExp(`case ${status}:\\s*return "([A-Z_]+)"`).exec(src);
      if (m?.[1] !== undefined) found.push(m[1]);
    }
    return found;
  }

  it("covers every permanently-refusing 4xx status the server can answer with", () => {
    // 409 renegotiates and 429 is retryable, so neither belongs here — which
    // `isPermanentRefusal` is the authority on, not this list.
    const permanent = [400, 401, 402, 403, 404].filter(isPermanentRefusal);
    expect(permanent).toEqual([400, 401, 402, 403, 404]);
    for (const code of serverCodesFor(permanent)) {
      expect(REFUSAL_KEY[code], `server code ${code} reaches the pad with no copy`).toBeDefined();
    }
  });

  // W1 (2026-09-21): this used to pin against `http.ts` ALONE, and that was
  // the whole truth while every code the pad could see came from a status.
  // It no longer is. Two producers joined it, and both are real:
  //
  //   - `scoring.ts` throws four 409s with an EXPLICIT code, bypassing
  //     `statusCode()` entirely — the terminal undo refusals;
  //   - `pipeline.ts` MINTS `QUEUE_STALLED` client-side when an event has
  //     spent its conflict-pass ceiling. No server ever sends it.
  //
  // So the guard is "minted by a real producer", not "absent from one file" —
  // widened rather than weakened: a code belonging to no producer at all still
  // fails, which is the invention this test exists to catch.
  it("does not invent codes: every entry is minted by a real producer", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const http = read("src/server/api-v1/http.ts");
    const scoring = read("src/server/usecases/scoring.ts");
    const pipeline = read("src/components/v2/scorepad/pipeline.ts");

    for (const code of Object.keys(REFUSAL_KEY)) {
      const producer = http.includes(`return "${code}"`)
        ? "http.ts statusCode()"
        : scoring.includes(`"${code}"`)
          ? "scoring.ts explicit refusal"
          : pipeline.includes(`code: "${code}"`)
            ? "pipeline.ts (client-minted)"
            : null;
      expect(producer, `${code} is minted by nothing: no status map, no usecase throw, no client path`).not.toBeNull();
    }
  });
});
