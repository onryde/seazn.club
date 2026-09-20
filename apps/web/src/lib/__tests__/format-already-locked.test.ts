// The Start-tournament dialog states whether the FORMAT is already locked.
// Until 2026-09-20 it said "already locked — fixtures exist" unconditionally,
// and was shown on a division whose own page read "No fixtures yet". Found by
// driving the product, not by a test — which is why this file reads the
// server's real guard rather than restating it. Same shape as
// `start-promotes-competition.test.ts` and `open-entry-stages.test.ts`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAlreadyLocked } from "@/lib/format-already-locked";

describe("whether a division's format is already locked when Start is offered", () => {
  it("matches the FORMAT_LOCKED guard replaceStages actually runs", () => {
    const source = readFileSync(join(process.cwd(), "src/server/usecases/stages.ts"), "utf8");
    const flat = source.replace(/\n\s*/g, " ");
    const guard =
      /select 1 from fixtures f join stages s on s\.id = f\.stage_id\s*where s\.division_id = \$\{[^}]+\} limit 1/.exec(
        flat,
      );
    expect(guard, "the FORMAT_LOCKED guard is no longer the shape this mirror assumes").not.toBeNull();
    // The POINT of the mirror is the absence of a narrowing clause: the guard
    // counts ANY fixture row, in any status, in any stage of the division. A
    // server that started ignoring, say, `scheduled` rows would make
    // `fixtureCount > 0` wrong, and a presence-only assertion on the select
    // could not see it.
    expect(guard![0], "the guard now filters on something this client cannot see").not.toMatch(
      /status|outcome|and f\./,
    );
    // And it must still be the clause that throws FORMAT_LOCKED, not some
    // other lookup that happens to have the same shape.
    const after = flat.slice(flat.indexOf(guard![0]) + guard![0].length, flat.indexOf(guard![0]) + guard![0].length + 200);
    expect(after, "this select no longer guards FORMAT_LOCKED").toContain("FORMAT_LOCKED");
  });

  it("is false for a division with no fixtures — the quick-start path", () => {
    // THE regression case. `/start` generates the fixtures itself, so on a
    // division that has never generated, the format is NOT locked at the
    // moment the dialog renders. This is the exact state the live defect was
    // seen in: zero fixtures, "Generate fixtures" on screen behind the dialog.
    expect(formatAlreadyLocked(0)).toBe(false);
  });

  it("is true as soon as one fixture exists anywhere in the division", () => {
    // One row locks the whole stage graph — the guard has no stage filter, so
    // a single fixture in a single stage is enough. Boundary first, then a
    // realistic field.
    expect(formatAlreadyLocked(1)).toBe(true);
    expect(formatAlreadyLocked(15)).toBe(true);
  });
});
