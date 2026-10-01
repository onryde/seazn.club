// Capture QR v2 §6.8.4 — domain/end-reason.ts: every DB end and fail reason maps to exactly one wire value.
// Expected values are read from the spec's own table, the DB enum from the V430 fold, and the fail reasons from
// StreamFailReason.options — never from the module under test. R11 (controller, 2026-10-01): a terminal row with
// neither reason (session.ts's completion with `endReason: null`) → `failed`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureEndReason } from "@/server/api-v1/capture-schemas";
import { StreamFailReason } from "@/server/api-v1/schemas";
import { lastCheckList } from "../../__tests__/_stream-migration";
import { DB_END_REASONS, type DbEndReason, TerminalWithoutReason, wireEndReason } from "../end-reason";
import type { FailReason } from "../session";

const SPEC = readFileSync(resolve(import.meta.dirname, "../../../../../../../docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md"), "utf8");
const TABLE = SPEC.slice(SPEC.indexOf("#### 6.8.4 End reasons"), SPEC.indexOf("### 6.9 "));
/** `| end \`stopped\` (organiser) | \`stopped\` | …` and `| fail \`no_inbound_timeout\` | \`no_inbound_timeout\` | …`. */
const NAMED = [...TABLE.matchAll(/^\| (end|fail) `([a-z_]+)`[^|]*\| `([a-z_]+)`/gm)].map((m) => ({ kind: m[1]!, db: m[2]!, wire: m[3]! }));
/** `| every other fail reason (…) | \`failed\` |`. */
const OTHER_FAIL = /^\| every other fail reason[^|]*\| `([a-z_]+)`/m.exec(TABLE)?.[1];
const FAIL_REASONS = StreamFailReason.options as readonly FailReason[];

const expectedFor = (kind: "end" | "fail", db: string): string | undefined =>
  NAMED.find((r) => r.kind === kind && r.db === db)?.wire ?? (kind === "fail" ? OTHER_FAIL : undefined);

describe("the declarations this table is checked against", () => {
  it("the spec's §6.8.4 table parses: five end rows, two named fail rows, and the catch-all", () => {
    expect(NAMED.filter((r) => r.kind === "end")).toHaveLength(5);
    expect(NAMED.filter((r) => r.kind === "fail")).toHaveLength(2);
    expect(OTHER_FAIL).toBe("failed");
  });

  it("DB_END_REASONS is exactly the end_reason list the V430 fold leaves on the column", () => {
    expect([...DB_END_REASONS]).toEqual(lastCheckList("fixture_stream_sessions", "end_reason"));
  });

  it("StreamFailReason declares eleven (the count the sweep must reach)", () => {
    expect(FAIL_REASONS).toHaveLength(11);
  });
});

describe("wireEndReason (§6.8.4)", () => {
  it("every DB end reason and every fail reason maps to exactly the spec's wire value — the count equals both enums", () => {
    let mapped = 0;
    for (const endReason of DB_END_REASONS) {
      expect(wireEndReason({ endReason, failReason: null }), `end ${endReason}`).toBe(expectedFor("end", endReason));
      mapped++;
    }
    for (const failReason of FAIL_REASONS) {
      expect(wireEndReason({ endReason: null, failReason }), `fail ${failReason}`).toBe(expectedFor("fail", failReason));
      mapped++;
    }
    expect(mapped).toBe(DB_END_REASONS.length + StreamFailReason.options.length);
  });

  it("operator_stopped → stopped (only the phone that stopped it ever names this sid)", () => {
    expect(wireEndReason({ endReason: "operator_stopped", failReason: null })).toBe("stopped");
  });

  it("every fail reason the table does not name → failed (no_credits, the timeouts, relay_disabled, the runner's)", () => {
    const named = new Set(NAMED.filter((r) => r.kind === "fail").map((r) => r.db));
    const unnamed = FAIL_REASONS.filter((f) => !named.has(f));
    expect(unnamed).toHaveLength(9);
    for (const failReason of unnamed) expect(wireEndReason({ endReason: null, failReason }), failReason).toBe("failed");
  });

  it("R11: a terminal row with NEITHER reason (session.ts's completion with endReason null) → failed", () => {
    expect(wireEndReason({ endReason: null, failReason: null })).toBe("failed");
  });

  it("every wire value is a CaptureEndReason, and all seven are reached", () => {
    const reached = new Set<string>([wireEndReason({ endReason: null, failReason: null })]);
    for (const endReason of DB_END_REASONS) reached.add(wireEndReason({ endReason, failReason: null }));
    for (const failReason of FAIL_REASONS) reached.add(wireEndReason({ endReason: null, failReason }));
    for (const w of reached) expect(CaptureEndReason.options, w).toContain(w);
    expect([...reached].sort()).toEqual([...CaptureEndReason.options].sort());
  });

  it("an unmappable row throws TerminalWithoutReason — never a null into an answer that requires endReason", () => {
    expect(() => wireEndReason({ endReason: "crashed" as DbEndReason, failReason: null })).toThrow(TerminalWithoutReason);
    expect(() => wireEndReason({ endReason: null, failReason: "storage_exhausted" as FailReason })).toThrow(TerminalWithoutReason);
  });

  it("a row carrying BOTH reasons is refused by name (session.ts's fail() clears endReason; V410 keeps them apart)", () => {
    expect(() => wireEndReason({ endReason: "stopped", failReason: "no_credits" })).toThrow(TerminalWithoutReason);
  });
});
