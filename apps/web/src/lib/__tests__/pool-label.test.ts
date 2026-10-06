// The pool label (2026-10-06): one pool's display name, built from its KEY in
// the reader's dictionary. `pools.name` is only ever stored as the English
// "Pool " + key (`server/usecases/stages.ts`), so no surface may print it.
//
// Expected words come out of the dictionary FILES (`public` namespace), never
// through the helper under test. Sport-independent by construction — a pool
// is a stage's partition, whatever the sport — so there is no sport sweep.
import { describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { poolLabel } from "@/lib/pool-label";

const FILES: Record<string, Record<string, string>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };

describe("poolLabel", () => {
  it("every locale's file declares the label with a {key} slot, and the word matches its own table.pool", () => {
    let checked = 0;
    for (const [locale, file] of Object.entries(FILES)) {
      expect(file["table.poolLabel"], locale).toContain("{key}");
      // The label is that locale's pool word followed by the key — the brief's
      // rule that the word matches the locale's existing `table.pool`.
      expect(file["table.poolLabel"], locale).toBe(`${file["table.pool"]} {key}`);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("names a pool from its key in each locale", () => {
    let checked = 0;
    for (const [locale, file] of Object.entries(FILES)) {
      for (const key of ["A", "B", "P"]) {
        expect(poolLabel(file, key), `${locale} ${key}`).toBe(file["table.poolLabel"].replace("{key}", key));
        checked += 1;
      }
    }
    expect(checked).toBe(12);
    // The defect's witness: Spanish is not the stored English name.
    expect(poolLabel(esPublic, "A")).not.toBe("Pool A");
  });

  it("a missing or empty key is the bare pool word — never 'Pool ' with nothing after it, nor 'undefined'", () => {
    let checked = 0;
    for (const [locale, file] of Object.entries(FILES)) {
      for (const key of [null, undefined, ""]) {
        expect(poolLabel(file, key), `${locale} ${String(key)}`).toBe(file["table.pool"]);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });
});
