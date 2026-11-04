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
    const preview = { dry_run: true, stages: [], fixtures: 0, slots: 0, courts: 0, officials: 0, lineups: 0, device_links: 0, calls: 0, token: null };
    expect(previewOf({ code: "FORMAT_CHANGE_CONFIRM" satisfies FormatChangeCode, preview })).toBe(preview);
    expect(previewOf({ code: "FORMAT_LOCKED" })).toBeNull();
    expect(previewOf({ preview: { ...preview, dry_run: false } })).toBeNull();
    expect(previewOf(null)).toBeNull();
    expect(previewOf("x")).toBeNull();
  });
});
