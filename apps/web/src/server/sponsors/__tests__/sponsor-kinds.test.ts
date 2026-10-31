// R4 sponsors on stream, S5 — the pure half: what the engine's declared break kinds become once S5 mints them, swept over
// the REAL modules' `naturalBreaks.kinds` (never a typed list).
//   * S8 m8: every kind fits the heartbeat's `breakKind` bound, and every moment id S5 mints fits its `momentId` bound —
//     read off the contract twin itself (`RelayAiring`), so the bounds move with it.
//   * the moment id grammar: `breakKindOfMomentId` inverts `sponsorMomentId` for every kind, and refuses everything else.
//   * S4's owed sweep: each dial × each declaring sport, the eligible count is the spec's size rule (§3.2), sizes read
//     from the sport's declaration.
//   * the rotation lock key: one per org whatever the uuid's case, and never the money lock's (F8).
// Every sweep reports how many items it checked; zero is a failure.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { eligibleBreaks, sponsorMomentId, type BreakOpened, type SponsorFrequency } from "@/lib/sponsor-plan";
import { RelayAiring } from "@/server/api-v1/schemas";
import { orgMoneyLockKey } from "@/server/usecases/stream-credits";
import { breakKindOfMomentId, sponsorRotationLockKey } from "../assign";

/** `sponsor_assignments.seq` / `score_events.seq` are Postgres `int`: the widest seq a moment id can carry. */
const INT4_MAX = 2 ** 31 - 1;

/** Every (module, kind, size) the engine declares. */
const DECLARED = builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => ({ sport: m.key, kind: k.kind, size: k.size })));

const startItem = (momentId: string, breakKind: string) => ({
  kind: "start", momentId, cardId: "00000000-0000-4000-8000-000000000000", style: "banner", source: "rotation", breakKind,
  at: "2026-10-31T14:00:00.000Z",
});

describe("S8 m8 — the declared kinds and S5's moment ids fit the heartbeat's bounds", () => {
  it("every engine-declared kind fits `breakKind`, and its widest moment id fits `momentId`", () => {
    let checked = 0;
    for (const d of DECLARED) {
      const momentId = sponsorMomentId(INT4_MAX, d.kind);
      const parsed = RelayAiring.safeParse(startItem(momentId, d.kind));
      expect(parsed.success, `${d.sport} ${d.kind} (${momentId}): ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      checked++;
    }
    expect(checked, `${checked} declared kinds checked`).toBeGreaterThan(0);
    expect(new Set(DECLARED.map((d) => d.sport)).size, "the 8 declaring sports (spec §3.1)").toBe(8);
    // The probe can fail: an oversized kind and an oversized moment id are each refused by the same twin.
    const wide = "k".repeat(200);
    expect(RelayAiring.safeParse(startItem(sponsorMomentId(1, "over_end"), wide)).success).toBe(false);
    expect(RelayAiring.safeParse(startItem(sponsorMomentId(1, wide), "over_end")).success).toBe(false);
  });
});

describe("the moment id grammar — breakKindOfMomentId", () => {
  it("inverts sponsorMomentId for every declared kind at every seq shape", () => {
    let checked = 0;
    for (const d of DECLARED) {
      for (const seq of [0, 1, 9, 10, 1234, INT4_MAX]) {
        expect(breakKindOfMomentId(sponsorMomentId(seq, d.kind)), `${seq} ${d.kind}`).toBe(d.kind);
        checked++;
      }
    }
    expect(checked).toBe(DECLARED.length * 6);
    expect(checked).toBeGreaterThan(0);
  });

  it("names no break kind for any other id: a scene showing, a score moment, a malformed seq, an empty kind", () => {
    const others = [
      "scene:starting_soon:178000000", // P5's carousel id
      "12:wicket", "12:goal.home", // score moments (`${seq}:${kind}`)
      "12:sponsor.", "12:sponsor", "sponsor.over_end", ":sponsor.over_end",
      "01:sponsor.over_end", "-1:sponsor.over_end", "1.5:sponsor.over_end", "x:sponsor.over_end", " 1:sponsor.over_end",
      "",
    ];
    for (const id of others) expect(breakKindOfMomentId(id), JSON.stringify(id)).toBeNull();
    expect(others.length).toBeGreaterThan(0);
  });
});

describe("S4's owed sweep — each dial × each declaring sport", () => {
  /** Spec §3.2, verbatim: "Light = every major; Normal = every major + every 3rd minor; Busy = every major + every minor". */
  const SPEC_NORMAL_EVERY = 3;
  const DIALS: readonly SponsorFrequency[] = ["light", "normal", "busy"];

  it("the eligible count is the spec's size rule, sizes read from the sport's own declaration", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const kinds = m.naturalBreaks?.kinds;
      if (kinds === undefined) continue;
      // Seven rounds of every declared kind: enough minors that "every 3rd" has to count across kinds and rounds.
      const breaks: BreakOpened[] = [];
      for (let round = 0; round < 7; round++) {
        for (const k of kinds) breaks.push({ seq: breaks.length + 1, at: new Date(Date.UTC(2026, 9, 31, 14, 0, breaks.length)).toISOString(), kind: k.kind, size: k.size });
      }
      const majors = breaks.filter((b) => kinds.find((k) => k.kind === b.kind)!.size === "major").length;
      const minors = breaks.length - majors;
      const want: Record<SponsorFrequency, number> = {
        light: majors,
        normal: majors + Math.floor(minors / SPEC_NORMAL_EVERY),
        busy: majors + minors,
      };
      for (const dial of DIALS) {
        expect(eligibleBreaks(breaks, dial).length, `${m.key} ${dial}`).toBe(want[dial]);
        checked++;
      }
      // Normal takes the 3rd, 6th, … minor of the FIXTURE, whatever its kind.
      const minorSeqs = breaks.filter((b) => b.size === "minor").map((b) => b.seq);
      const normalMinors = eligibleBreaks(breaks, "normal").filter((b) => b.size === "minor").map((b) => b.seq);
      expect(normalMinors, `${m.key}: every 3rd minor`).toEqual(minorSeqs.filter((_, i) => (i + 1) % SPEC_NORMAL_EVERY === 0));
    }
    expect(checked, `${checked} sport × dial cases`).toBe(8 * DIALS.length);
  });
});

describe("the rotation lock key", () => {
  it("is one key per org whatever the uuid's case, namespaced apart from the stream-credits money lock (F8)", () => {
    const org = "0A1B2C3D-0000-4000-8000-00000000ABCD";
    expect(sponsorRotationLockKey(org)).toBe(sponsorRotationLockKey(org.toLowerCase()));
    expect(sponsorRotationLockKey(org)).toBe(`sponsor-rotation-org:${org.toLowerCase()}`);
    expect(sponsorRotationLockKey(org)).not.toBe(orgMoneyLockKey(org));
  });
});
