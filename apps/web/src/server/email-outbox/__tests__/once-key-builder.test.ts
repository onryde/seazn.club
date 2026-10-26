// The once-key builder (phase 3 wave 2, T1).
//
// Ruling R-T1f: `email_outbox_once_idx` is unique on (kind, dedupe_key) across EVERY organisation, so a once-key must embed a globally
// unique id (a row UUID or a Stripe id). `enqueueEmailOnce` refuses an empty or blank key, but a producer that read a missing id and built
// `${id}:created` hands it "undefined:created", which is not blank: one key for the whole kind, in every organisation, and every later email
// of the kind silently skipped. `onceKey` refuses the missing id itself, by name (`OutboxDedupeKeyError`), before any key exists.
//
// The expected keys are the spec's shapes (§5 and the kind table's "Ref · once-key" column: `<dispute id>:created`, a bare charge id),
// typed here, never built by the code under test. Imported from the public surface, which is what a producer imports.
// Sport: not applicable (these emails do not vary by sport).
import { describe, expect, it } from "vitest";
import { OutboxDedupeKeyError, onceKey, type OutboxKind } from "@/server/email-outbox";

type Case = {
  name: string;
  kind: OutboxKind;
  refType: string;
  id: string | null | undefined;
  suffix: string | undefined;
  /** The key, or `refused` when the builder must throw `OutboxDedupeKeyError`. */
  expected: string | "refused";
};

const CASES: readonly Case[] = [
  { name: "a dispute id and a suffix", kind: "registration_dispute_alert", refType: "dispute", id: "dp_1", suffix: "created", expected: "dp_1:created" },
  { name: "a charge id, no suffix", kind: "pass_revoked", refType: "charge", id: "ch_1", suffix: undefined, expected: "ch_1" },
  { name: "no id (undefined) with a suffix", kind: "registration_dispute_alert", refType: "dispute", id: undefined, suffix: "created", expected: "refused" },
  { name: "a null id with a suffix", kind: "registration_dispute_lost", refType: "dispute", id: null, suffix: "lost", expected: "refused" },
  { name: "a blank id, no suffix", kind: "pass_revoked", refType: "charge", id: "  ", suffix: undefined, expected: "refused" },
];

describe("onceKey (no database)", () => {
  it("builds `<id>` or `<id>:<suffix>`, and refuses a missing or blank id by name (the spec's table, one row at a time)", () => {
    let checked = 0;
    for (const c of CASES) {
      const call = (): string => onceKey(c.kind, c.refType, c.id, c.suffix);
      if (c.expected === "refused") {
        expect(call, c.name).toThrow(OutboxDedupeKeyError);
      } else {
        expect(call(), c.name).toBe(c.expected);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row of the table was judged").toBe(5);
    expect(checked).toBe(CASES.length);
    // Both outcomes are in the table, so a builder that always returned (or always threw) would be seen.
    expect(CASES.filter((c) => c.expected === "refused").length).toBeGreaterThan(0);
    expect(CASES.filter((c) => c.expected !== "refused").length).toBeGreaterThan(0);
  });

  it("the refusal names the kind and the ref type, and neither the id nor the suffix", () => {
    const suffix = "sfx_7q2";
    let checked = 0;
    for (const id of [undefined, null, "  "]) {
      let err: unknown;
      try {
        onceKey("registration_dispute_alert", "dispute", id, suffix);
      } catch (e) {
        err = e;
      }
      expect(err, `id ${JSON.stringify(id)}: refused`).toBeInstanceOf(OutboxDedupeKeyError);
      const e = err as OutboxDedupeKeyError;
      expect(e.name).toBe("OutboxDedupeKeyError");
      expect(e.code).toBe("EMAIL_OUTBOX_BAD_DEDUPE_KEY");
      // The positive pair: the message names what was being queued.
      expect(e.message).toContain("registration_dispute_alert");
      expect(e.message).toContain("dispute");
      // ...and not the key's parts: neither the suffix nor the missing id as it would print (`${undefined}`, `${null}`).
      expect(e.message).not.toContain(suffix);
      expect(e.message).not.toContain("undefined");
      expect(e.message).not.toContain("null");
      expect(e.message).not.toContain(`${String(id)}:`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every refused id was judged").toBe(3);
  });
});
