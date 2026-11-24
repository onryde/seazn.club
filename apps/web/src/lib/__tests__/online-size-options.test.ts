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
import { formatStagesFor } from "@/lib/division-builder/format-choice";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { capacityLoweredOf, onlineSizeChoice, onlineSizeDefault, onlineSizeOptions, refundedOf, swissRoundsOf, switchOffRefundOf, type OnlineSizeOption } from "@/lib/online-size-options";
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

describe("swissRoundsOf over the stages the builder REALLY sends (the producer seam)", () => {
  // The builder counts what `formatStagesFor` produces, the very drafts Create posts: a fixture of `{kind, config.rounds}` would prove the
  // fixture. (`template.build` alone is NOT the producer: it leaves a Swiss at its own default; the rounds knob is stamped after.)
  // Each template is built at a rounds knob no default shares (7), so a reader that took a default or read the wrong field fails.
  it("counts the rounds knob for every template that holds a Swiss stage, and none for the rest (sweep)", () => {
    let withSwiss = 0;
    let without = 0;
    for (const t of STAGE_TEMPLATES) {
      const stages = formatStagesFor(t.key, { qualified: 4, swissRounds: 7, poolCount: 2, legs: 1, standingsCarry: "none", thirdPlace: "shared" });
      const swissStages = stages.filter((s) => s.kind === "swiss").length;
      expect(swissRoundsOf(stages), t.key).toBe(swissStages * 7);
      if (swissStages > 0) withSwiss += 1;
      else without += 1;
    }
    expect(withSwiss).toBeGreaterThan(0); // anti-vacuity: some template is Swiss...
    expect(without).toBeGreaterThan(0); // ...and some is not
    expect(withSwiss + without).toBe(STAGE_TEMPLATES.length);
  });
});

describe("onlineSizeChoice: the size the select shows", () => {
  const facts = { ...base, locked: null } as const;

  it("untouched, it follows the places and rounds: the smallest size that holds both", () => {
    expect(onlineSizeChoice({ ...facts, picked: null, held: 0, rounds: 5 })).toBe(16);
    expect(onlineSizeChoice({ ...facts, picked: null, held: 0, rounds: 7 })).toBe(32);
    expect(onlineSizeChoice({ ...facts, picked: null, held: 33, rounds: 0 })).toBe(64);
    expect(onlineSizeChoice({ ...facts, picked: null, held: 17, rounds: 9 })).toBe(128);
  });

  it("a pick that still fits stands, however far over the default it is", () => {
    expect(onlineSizeChoice({ ...facts, picked: 128, held: 0, rounds: 5 })).toBe(128);
    expect(onlineSizeChoice({ ...facts, picked: 16, held: 0, rounds: 6 })).toBe(16);
  });

  it("a pick the rounds, the held places or the plan have since closed is dropped for the default", () => {
    expect(onlineSizeChoice({ ...facts, picked: 16, held: 0, rounds: 8 })).toBe(64); // 16 includes 6 rounds
    expect(onlineSizeChoice({ ...facts, picked: 32, held: 40, rounds: 0 })).toBe(64); // 32 is under the 40 held
    expect(onlineSizeChoice({ ...facts, picked: 256, planCap: 64, held: 0, rounds: 5 })).toBe(16); // over the plan
  });

  it("no size holds the places and the rounds: nothing is chosen for the organiser", () => {
    expect(onlineSizeChoice({ ...facts, picked: null, held: 0, rounds: 11 })).toBeNull();
    expect(onlineSizeChoice({ ...facts, picked: 64, held: 0, rounds: 11 })).toBeNull();
    expect(onlineSizeChoice({ ...facts, picked: null, held: 257, rounds: 0 })).toBeNull();
  });

  it("a locked package (paid or frozen) is its own size, whatever the facts say now", () => {
    expect(onlineSizeChoice({ ...facts, locked: 32, picked: 128, held: 0, rounds: 5 })).toBe(32);
    expect(onlineSizeChoice({ ...facts, locked: 32, picked: null, held: 100, rounds: 11 })).toBe(32);
  });

  it("the choice is never a greyed size, or null (sweep over held x rounds x plan cap x pick)", () => {
    let checked = 0;
    for (const held of [0, 17, 64, 129]) {
      for (const rounds of [0, 6, 8, 10, 11]) {
        for (const planCap of [null, 32, 100, 256]) {
          for (const picked of [null, ...ONLINE_SIZES]) {
            const size = onlineSizeChoice({ ...facts, held, rounds, planCap, picked });
            checked += 1;
            if (size === null) continue;
            const disabled = reasonOf(onlineSizeOptions({ ...base, held, rounds, planCap }), size);
            // The default ignores the plan (an over-plan default is the save's own 402), so only held and rounds are held to it.
            expect(disabled === null || disabled === "plan", `held ${held} rounds ${rounds} cap ${planCap} picked ${picked}`).toBe(true);
          }
        }
      }
    }
    expect(checked).toBe(4 * 5 * 4 * 6);
  });
});

describe("capacityLoweredOf: what a save says it did to the registration capacity (plan Task 11 item 3)", () => {
  it("reads PATCH /divisions' `online.capacityLoweredTo`", () => {
    expect(capacityLoweredOf({ id: "d", online: { capacityLoweredTo: 32, refunded: null } })).toBe(32);
    expect(capacityLoweredOf({ online: { capacityLoweredTo: 16 } })).toBe(16);
  });

  it("is null for every answer that lowered nothing, or that is not the shape (the empty cases)", () => {
    const none: unknown[] = [
      null, undefined, "x", 7, [], {}, { online: null }, { online: {} }, { online: { capacityLoweredTo: null } },
      { online: { capacityLoweredTo: 0 } }, { online: { capacityLoweredTo: -16 } }, { online: { capacityLoweredTo: 2.5 } },
      { online: { capacityLoweredTo: "32" } }, { online: "32" },
    ];
    for (const r of none) expect(capacityLoweredOf(r), JSON.stringify(r)).toBeNull();
    expect(none.length).toBeGreaterThan(10);
  });
});

describe("switchOffRefundOf: when switching Online play off refunds a paid package (T11 fix round 1, the review's gap)", () => {
  const paid = (size: OnlineSize, camerasPaid = false) => ({ size, paid: { size, camerasPaid }, frozen: false });
  const unpaid = (size: OnlineSize) => ({ size, paid: null, frozen: false });
  const frozen = (size: OnlineSize) => ({ size, paid: { size, camerasPaid: false }, frozen: true });

  it("a division that plays online, switched off, holding a PAID unfrozen package: the refund, naming the size and what was paid (the leaf's price, camera included)", () => {
    expect(switchOffRefundOf({ storedOnline: true, onlinePlay: "off", stored: paid(64) })).toEqual({ size: 64, price: packagePrice(64, false) });
    expect(switchOffRefundOf({ storedOnline: true, onlinePlay: "off", stored: paid(64, true) })).toEqual({ size: 64, price: packagePrice(64, true) });
    expect(packagePrice(64, true), "premise: the camera changes what was paid").not.toBe(packagePrice(64, false));
  });

  it("every other case asks nothing (the empty cases first): unpaid, frozen, no package, still online, was never online", () => {
    const cases: [string, Parameters<typeof switchOffRefundOf>[0]][] = [
      ["unpaid", { storedOnline: true, onlinePlay: "off", stored: unpaid(32) }],
      ["frozen: the server's call, nothing is refunded", { storedOnline: true, onlinePlay: "off", stored: frozen(32) }],
      ["no live package row", { storedOnline: true, onlinePlay: "off", stored: null }],
      ["still online", { storedOnline: true, onlinePlay: "lichess", stored: paid(32) }],
      ["was not online (a stale row)", { storedOnline: false, onlinePlay: "off", stored: paid(32) }],
    ];
    for (const [label, a] of cases) expect(switchOffRefundOf(a), label).toBeNull();
    expect(cases.length, "anti-vacuity").toBe(5);
  });

  it("every size on the ladder, paid, names its own size and price", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      expect(switchOffRefundOf({ storedOnline: true, onlinePlay: "off", stored: paid(size) })).toEqual({ size, price: packagePrice(size, false) });
      checked += 1;
    }
    expect(checked).toBe(ONLINE_SIZES.length);
  });
});

describe("refundedOf: what a save says its switch-off refund gave back and gave up (PATCH /divisions `online.refunded`)", () => {
  it("returned is the bought credits plus this month's included ones; forfeited is the earlier months' (never added into returned)", () => {
    expect(refundedOf({ online: { capacityLoweredTo: null, refunded: { pack: 3, monthly: 1, forfeited: 2 } } })).toEqual({ returned: 4, forfeited: 2 });
    expect(refundedOf({ online: { refunded: { pack: 0, monthly: 5, forfeited: 0 } } })).toEqual({ returned: 5, forfeited: 0 });
    expect(refundedOf({ online: { refunded: { pack: 2, monthly: 0, forfeited: 0 } } })).toEqual({ returned: 2, forfeited: 0 });
    expect(refundedOf({ online: { refunded: { pack: 0, monthly: 0, forfeited: 3 } } }), "only forfeited: still worth saying").toEqual({ returned: 0, forfeited: 3 });
  });

  it("nothing to say: no field, null, all zeros (an unpaid or frozen switch-off), or a malformed answer", () => {
    const quiet: unknown[] = [
      undefined, null, {}, { online: null }, { online: {} }, { online: { refunded: null } },
      { online: { refunded: { pack: 0, monthly: 0, forfeited: 0 } } },
      { online: { refunded: { pack: -1, monthly: 0, forfeited: 0 } } },
      { online: { refunded: { pack: 1.5, monthly: 0, forfeited: 0 } } },
      { online: { refunded: { pack: "3", monthly: 0, forfeited: 0 } } },
      { online: { refunded: { pack: 1 } } },
    ];
    for (const saved of quiet) expect(refundedOf(saved), JSON.stringify(saved)).toBeNull();
    expect(quiet.length, "anti-vacuity").toBe(11);
  });
});
