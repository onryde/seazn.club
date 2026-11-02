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
import { poolLabel, poolLabelsInOrder } from "@/lib/pool-label";

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

// Match Day E1 fix round 1 (m2): the run sheet names a pool on each round's bar. The page hands it the division's pools in display order
// with their labels, built by the two authorities (`poolLabel`, `comparePools`) - never a third spelling of either.
describe("poolLabelsInOrder", () => {
  const POOLS = [
    { id: "p-c", key: "C", name: "Pool C" },
    { id: "p-a", key: "A", name: "Pool A" },
    { id: "p-b", key: "B", name: "Pool B" },
    { id: "p-10", key: "10", name: "Pool 10" },
    { id: "p-2", key: "2", name: "Pool 2" },
  ];

  it("the empty case: no pools, no labels", () => {
    expect(poolLabelsInOrder(enPublic, [])).toEqual([]);
  });

  it("every locale: display order (key, natural), each label the locale's own word from the dictionary file", () => {
    let checked = 0;
    for (const [locale, file] of Object.entries(FILES)) {
      const out = poolLabelsInOrder(file, POOLS);
      expect(out.map((p) => p.id), `${locale}: order`).toEqual(["p-2", "p-10", "p-a", "p-b", "p-c"]);
      expect(out.map((p) => p.label), `${locale}: labels`).toEqual(["2", "10", "A", "B", "C"].map((key) => file["table.poolLabel"].replace("{key}", key)));
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(poolLabelsInOrder(frPublic, POOLS)[2]!.label).not.toBe(poolLabelsInOrder(enPublic, POOLS)[2]!.label);
  });
});
