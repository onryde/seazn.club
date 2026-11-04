// FMT5: every format-change refusal the server raises (`replaceStages`, server/usecases/stages.ts) lives in ONE client-safe
// table (`lib/format-change.ts`): its status, the server's English and the `formatChange.err.<CODE>` key the Format dialog
// says it with. These tests pin the table against the brief's codes and the four dictionaries, so a code added without
// copy, or copy in one locale only, is red here rather than a raw wire code on an organiser's screen.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { FORMAT_CHANGE_REFUSALS, isFormatChangeCode, previewOf, type FormatChangeCode } from "@/lib/format-change";
import { formatChangeRefusalText } from "@/lib/format-change-copy";
import { ApiV1Error } from "@/lib/client-v1";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";

// Typed here, not read from the table under test: a code dropped from the table, or one added without a ruling, fails.
const CODES = ["FORMAT_LOCKED", "FORMAT_CHANGE_CONFIRM", "FORMAT_CHANGE_STALE", "FORMAT_STREAM_LIVE"] as const;

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("FORMAT_CHANGE_REFUSALS (FMT5)", () => {
  it("holds exactly the brief's codes", () => {
    expect(Object.keys(FORMAT_CHANGE_REFUSALS).sort()).toEqual([...CODES].sort());
  });

  it("every code's key is in all 4 dictionaries with the same placeholders, and en says the server's English", () => {
    let checked = 0;
    for (const code of CODES) {
      const row = FORMAT_CHANGE_REFUSALS[code];
      expect(row.key, code).toBe(`formatChange.err.${code}`);
      expect(row.status, code).toBe(409);
      // The owner's sentence for the locked state (mock fmtcard1 §4), typed here rather than read from the table.
      if (code === "FORMAT_LOCKED") expect(row.message).toBe("Format is locked once scoring starts.");
      expect(LOCALES.en[row.key], code).toBe(row.message);
      for (const [loc, dict] of Object.entries(LOCALES)) {
        const text = dict[row.key];
        expect(typeof text, `${loc} ${row.key}`).toBe("string");
        expect(text.trim().length, `${loc} ${row.key}`).toBeGreaterThan(0);
        expect(placeholders(text), `${loc} ${row.key}`).toEqual(placeholders(row.message));
        checked++;
      }
    }
    expect(checked).toBe(CODES.length * 4);
  });

  it("isFormatChangeCode accepts the codes and nothing else", () => {
    for (const code of CODES) expect(isFormatChangeCode(code), code).toBe(true);
    for (const other of ["SCHEDULE_LOCKED", "toString", "", undefined, 3]) expect(isFormatChangeCode(other), String(other)).toBe(false);
  });

  it("previewOf reads a refusal's preview, and refuses a body without one", () => {
    const preview = { dry_run: true, stages: [], fixtures: 0, slots: 0, courts: 0, officials: 0, lineups: 0, device_links: 0, calls: 0, voided_scores: 0, token: null };
    expect(previewOf({ code: "FORMAT_CHANGE_CONFIRM" satisfies FormatChangeCode, preview })).toBe(preview);
    expect(previewOf({ code: "FORMAT_LOCKED" })).toBeNull();
    expect(previewOf({ preview: { ...preview, dry_run: false } })).toBeNull();
    expect(previewOf(null)).toBeNull();
    expect(previewOf("x")).toBeNull();
  });
});

// The Format dialog's three PUTs can be refused by more than the FORMAT_* codes: the board writes' shared refusals (a
// frozen schedule, an online game already on a board), the stage body's (a Swiss with no rounds, chess individual-only).
// Each is said in the reader's language off its CODE; the wire's English never reaches the screen. Codes are typed
// literally (the server's wire values), sentences read from the en dictionary.
describe("formatChangeRefusalText: every refusal the dialog can meet, in words (FMT5)", () => {
  const msg = (key: MessageKey, vars?: Record<string, string | number>) => tRuntime(en as never, key, vars);
  const said = (code: string, extra: Record<string, unknown> = {}) =>
    formatChangeRefusalText(new ApiV1Error("the wire's English", 409, code, extra), msg, "FALLBACK");
  const D = en as Record<string, string>;

  it("each code's own sentence, never the wire's English (counted)", () => {
    const cases: [string, string][] = [
      ["FORMAT_LOCKED", D["formatChange.err.FORMAT_LOCKED"]!],
      ["FORMAT_CHANGE_CONFIRM", D["formatChange.err.FORMAT_CHANGE_CONFIRM"]!],
      ["FORMAT_CHANGE_STALE", D["formatChange.err.FORMAT_CHANGE_STALE"]!],
      ["SCHEDULE_LOCKED", D["stage.error.scheduleFrozen"]!],
      ["ONLINE_GAME_EXISTS", D["externalPlay.onlineGameExists"]!],
      ["STAGE_SWISS_ROUNDS_REQUIRED", D["stage.err.swissRoundsRequired"]!],
      ["CHESS_INDIVIDUAL_ONLY", D["divset.err.chessIndividualOnly"]!],
    ];
    let checked = 0;
    for (const [code, want] of cases) {
      expect(want.length, `${code}: premise: the sentence exists`).toBeGreaterThan(0);
      expect(said(code), code).toBe(want);
      expect(said(code), code).not.toContain("the wire's English");
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a live stream names its match, or 'This match' when the refusal carries no number", () => {
    expect(said("FORMAT_STREAM_LIVE", { fixture_no: 7 })).toBe(D["formatChange.err.FORMAT_STREAM_LIVE"]!.replace("{match}", "Match 7"));
    expect(said("FORMAT_STREAM_LIVE")).toBe(D["formatChange.err.FORMAT_STREAM_LIVE"]!.replace("{match}", D["rules.err.thisMatch"]!));
  });

  it("anything else falls to the Settings saves' one reader (settingsSaveErrorText): a non-Error says the fallback", () => {
    expect(formatChangeRefusalText(undefined, msg, "FALLBACK")).toBe("FALLBACK");
    expect(formatChangeRefusalText("boom", msg, "FALLBACK")).toBe("FALLBACK");
  });
});
