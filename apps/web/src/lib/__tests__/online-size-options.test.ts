// The Online Chess size select's option rules (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6): which of the five sizes an
// organiser may pick, and why one is greyed. The client list mirrors the server's own refusal order (`refusalFor`, quote.ts: frozen,
// below_held, plan, rounds_above_max, rounds), so the select can never offer a size the save would refuse for a reason the client
// already knew - and never grey one the server would take.
//
// Expected values come from the spec's examples and the leaf's declarations (the ladder, the rounds each size includes, the price
// table), never from the module under test; the sweep below ALSO reads the server's `refusalFor` as the second authority.
// Anti-vacuity: every sweep reports how many cells it checked, and zero is a failure.
import { describe, expect, it } from "vitest";
import { ONLINE_SIZES, includedRounds, packagePrice, sizeAllowedByPlan, type OnlineSize } from "@/lib/online-chess-package";
import { onlineSizeDefault, onlineSizeOptions, swissRoundsOf, type OnlineSizeOption } from "@/lib/online-size-options";
import { refusalFor } from "@/server/usecases/online-package/quote";

const reasonOf = (o: readonly OnlineSizeOption[], size: OnlineSize) => o.find((x) => x.size === size)?.disabled;
const base = { planCap: null, held: 0, rounds: 0, cameras: false, paid: null } as const;

describe("onlineSizeOptions: the five sizes, each with its rounds and price from the leaf", () => {
  it("lists every size on the ladder once, in order, with the leaf's rounds and price", () => {
    const withoutCameras = onlineSizeOptions(base);
    const withCameras = onlineSizeOptions({ ...base, cameras: true });
    expect(withoutCameras.map((o) => o.size)).toEqual([16, 32, 64, 128, 256]);
    expect(withoutCameras.map((o) => o.rounds)).toEqual([6, 7, 8, 9, 10]); // P1: log2(size) + 2
    expect(withoutCameras.map((o) => o.price)).toEqual([1, 2, 4, 8, 16]); // decision 5
    expect(withCameras.map((o) => o.price)).toEqual([2, 4, 8, 16, 32]);
    expect(withoutCameras.every((o) => o.disabled === null && o.diff === null)).toBe(true);
    for (const o of withoutCameras) {
      expect(o.rounds).toBe(includedRounds(o.size));
      expect(o.price).toBe(packagePrice(o.size, false));
    }
  });

  it("a size above the plan's cap is disabled with the plan reason; a size pack's 96 still reaches 128 (P17)", () => {
    expect(onlineSizeOptions({ ...base, planCap: 32 }).map((o) => o.disabled)).toEqual([null, null, "plan", "plan", "plan"]);
    expect(onlineSizeOptions({ ...base, planCap: 96 }).map((o) => o.disabled)).toEqual([null, null, null, null, "plan"]);
    expect(onlineSizeOptions({ ...base, planCap: 256 }).map((o) => o.disabled)).toEqual([null, null, null, null, null]);
  });

  it("a size below the places already held is disabled with the held reason (a full 32 keeps 32)", () => {
    expect(onlineSizeOptions({ ...base, held: 40 }).map((o) => o.disabled)).toEqual(["held", "held", null, null, null]);
    expect(onlineSizeOptions({ ...base, held: 32 }).map((o) => o.disabled)).toEqual(["held", null, null, null, null]);
    expect(onlineSizeOptions({ ...base, held: 33 }).map((o) => o.disabled)).toEqual(["held", "held", null, null, null]);
  });

  it("a size that includes fewer Swiss rounds than the division counts is disabled with the rounds reason", () => {
    expect(onlineSizeOptions({ ...base, rounds: 8 }).map((o) => o.disabled)).toEqual(["rounds", "rounds", null, null, null]);
    expect(onlineSizeOptions({ ...base, rounds: 6 }).map((o) => o.disabled)).toEqual([null, null, null, null, null]);
    // More than any size includes: every size says rounds.
    expect(onlineSizeOptions({ ...base, rounds: 11 }).map((o) => o.disabled)).toEqual(["rounds", "rounds", "rounds", "rounds", "rounds"]);
  });

  it("when two reasons hold, the server's order wins: held, then plan, then rounds", () => {
    // 16: held 40 AND plan cap 8 AND 9 rounds - the answer is the first the server would give.
    expect(reasonOf(onlineSizeOptions({ ...base, held: 40, planCap: 8, rounds: 9 }), 16)).toBe("held");
    // 64 includes 8 rounds, so 9 rounds are too many for it too - but the plan reason comes before the rounds one.
    expect(reasonOf(onlineSizeOptions({ ...base, held: 0, planCap: 16, rounds: 9 }), 64)).toBe("plan");
    // Without the plan limit the same size says rounds, and the first size that covers 9 rounds says nothing.
    expect(reasonOf(onlineSizeOptions({ ...base, held: 0, planCap: 256, rounds: 9 }), 64)).toBe("rounds");
    expect(reasonOf(onlineSizeOptions({ ...base, held: 0, planCap: 256, rounds: 9 }), 128)).toBeNull();
  });

  it("a PAID row labels every size with its difference to what was paid; its own size is 0 (P13, P19)", () => {
    // Paid at 32 without cameras (2 credits): 64 is +2, 16 is -1, 32 itself 0.
    const o = onlineSizeOptions({ ...base, paid: { size: 32, camerasPaid: false } });
    expect(o.map((x) => x.diff)).toEqual([-1, 0, 2, 6, 14]);
    // Paid with cameras at 32 (4): the price never drops below what was paid for cameras (P19), so the cameras flag follows the row.
    const withCameras = onlineSizeOptions({ ...base, cameras: true, paid: { size: 32, camerasPaid: true } });
    expect(withCameras.map((x) => x.diff)).toEqual([-2, 0, 4, 12, 28]);
    // A paid camera is never lowered (P19): even when the division's own camera switch has been turned off since, the sizes are priced
    // WITH the camera, so the shown prices and differences match what the server's quote asks.
    const switchedOff = onlineSizeOptions({ ...base, cameras: false, paid: { size: 32, camerasPaid: true } });
    expect(switchedOff.map((x) => x.diff)).toEqual([-2, 0, 4, 12, 28]);
    expect(switchedOff.map((x) => x.price)).toEqual(withCameras.map((x) => x.price));
  });

  it("an unpaid row has no difference to show", () => {
    expect(onlineSizeOptions({ ...base, cameras: true }).every((o) => o.diff === null)).toBe(true);
  });

  it("sweep: every (held, rounds, plan cap) cell agrees with the server's refusal order, size by size", () => {
    const helds = [0, 1, 16, 17, 32, 33, 64, 65, 128, 129, 256];
    const roundsList = [0, 1, 6, 7, 8, 9, 10, 11, 15];
    const caps = [null, 8, 16, 32, 48, 64, 96, 128, 256];
    const SERVER_TO_CLIENT = { below_held: "held", plan: "plan", rounds: "rounds", rounds_above_max: "rounds" } as const;
    let checked = 0;
    for (const held of helds) {
      for (const rounds of roundsList) {
        for (const planCap of caps) {
          const options = onlineSizeOptions({ ...base, held, rounds, planCap });
          expect(options).toHaveLength(ONLINE_SIZES.length);
          for (const o of options) {
            const server = refusalFor(o.size, { cameras: false, rounds, held, planCap }, false);
            const expected = server === null ? null : SERVER_TO_CLIENT[server as keyof typeof SERVER_TO_CLIENT];
            expect(o.disabled, `size ${o.size}, held ${held}, rounds ${rounds}, plan cap ${planCap}`).toBe(expected);
            checked += 1;
          }
        }
      }
    }
    expect(checked, "anti-vacuity: every cell was compared with the server").toBe(helds.length * roundsList.length * caps.length * ONLINE_SIZES.length);
    expect(checked).toBeGreaterThan(900);
  });

  it("the plan rule is the leaf's own: sizeAllowedByPlan, not a copy", () => {
    for (const cap of [null, 8, 16, 32, 48, 64, 96, 128, 256]) {
      for (const o of onlineSizeOptions({ ...base, planCap: cap })) expect(o.disabled === "plan").toBe(!sizeAllowedByPlan(o.size, cap));
    }
  });
});

describe("onlineSizeDefault: the size an unpicked select opens on", () => {
  it("is the smallest size that holds the places AND covers the rounds (the builder opens on 16 for a 4-round Swiss)", () => {
    expect(onlineSizeDefault({ held: 0, rounds: 0 })).toBe(16);
    expect(onlineSizeDefault({ held: 0, rounds: 4 })).toBe(16);
    expect(onlineSizeDefault({ held: 0, rounds: 6 })).toBe(16);
    expect(onlineSizeDefault({ held: 0, rounds: 7 })).toBe(32);
    expect(onlineSizeDefault({ held: 0, rounds: 10 })).toBe(256);
    expect(onlineSizeDefault({ held: 17, rounds: 0 })).toBe(32);
    expect(onlineSizeDefault({ held: 17, rounds: 9 })).toBe(128);
    expect(onlineSizeDefault({ held: 200, rounds: 6 })).toBe(256);
  });

  it("is null when no size can hold or cover them (above 10 rounds, or above 256 places)", () => {
    expect(onlineSizeDefault({ held: 0, rounds: 11 })).toBeNull();
    expect(onlineSizeDefault({ held: 257, rounds: 0 })).toBeNull();
  });

  it("never lands on a size the options list disables for places or rounds", () => {
    let checked = 0;
    for (const held of [0, 5, 16, 17, 40, 130, 256]) {
      for (const rounds of [0, 3, 6, 7, 9, 10]) {
        const size = onlineSizeDefault({ held, rounds });
        expect(size, `held ${held}, rounds ${rounds}`).not.toBeNull();
        expect(reasonOf(onlineSizeOptions({ ...base, held, rounds }), size!), `held ${held}, rounds ${rounds}`).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBe(42);
  });
});

describe("swissRoundsOf: the rounds a draft's stages declare (P15)", () => {
  it("sums config.rounds over Swiss stages only; knockout, play-off and ladder count nothing", () => {
    expect(
      swissRoundsOf([
        { kind: "swiss", config: { rounds: 5 } },
        { kind: "knockout", config: { rounds: 9 } },
        { kind: "swiss", config: { rounds: 3 } },
        { kind: "page_playoff", config: {} },
      ]),
    ).toBe(8);
    expect(swissRoundsOf([])).toBe(0);
  });

  it("a Swiss stage with no usable round count counts 0 (never read as 1)", () => {
    expect(swissRoundsOf([{ kind: "swiss", config: {} }])).toBe(0);
    expect(swissRoundsOf([{ kind: "swiss", config: { rounds: 0 } }])).toBe(0);
    expect(swissRoundsOf([{ kind: "swiss", config: { rounds: 2.5 } }])).toBe(0);
    expect(swissRoundsOf([{ kind: "swiss", config: { rounds: "4" } }])).toBe(0);
    expect(swissRoundsOf([{ kind: "swiss", config: null }])).toBe(0);
  });
});
