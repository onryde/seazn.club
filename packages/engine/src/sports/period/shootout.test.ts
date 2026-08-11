// Shared shootout primitive — regression coverage for the App 12 / GWS
// retake case (#416, W5). Before this session `taken[kick.side]++`
// (shootout.ts:38) fired unconditionally, so a VOIDED kick — a foul the
// rulebook sends to a retake rather than a recorded attempt
// (hockey/DOMAIN.md:65, "a foul during the shoot-out") — was counted as a
// real attempt, overstating how many of the entitlement that side had used.
// The fix threads an additive `void?: boolean` through the kick and excludes
// a void kick from every tally (`taken`, `scored`, `expectedKicker`'s own
// alternation count) — it contributes nothing, as if it never happened; the
// retake that follows is a separate, later kick event.
import { describe, expect, it } from "vitest";
import { expectedKicker, shootoutDecision, shootoutTally, type ShootoutKick } from "./shootout.ts";

const kick = (side: "home" | "away", scored: boolean, voided?: boolean): ShootoutKick => ({
  side,
  scored,
  ...(voided === undefined ? {} : { void: voided }),
});

describe("shootoutDecision — a void kick is not a taken attempt", () => {
  it("REGRESSION: a void kick must not let the early-decision math fire a kick early", () => {
    // Home scores 3 of 3. Away misses 2 of 2 real attempts, then a 3rd kick
    // that is VOIDED (encroachment, retake pending). Away has genuinely used
    // only 2 of their 5 entitlements and could still draw level (3-3) before
    // sudden death, so this must NOT be decided yet.
    //
    // Pre-fix, the void kick still incremented `taken.away` to 3, so
    // `remaining("away")` read 2 instead of 3 and `3 > 0 + 2` wrongly fired —
    // this exact sequence returned "home" before the fix.
    const kicks: ShootoutKick[] = [
      kick("home", true),
      kick("away", false),
      kick("home", true),
      kick("away", false),
      kick("home", true),
      kick("away", false, true), // away's 3rd kick: voided, not a real attempt
    ];
    expect(shootoutDecision(kicks, 5)).toBeNull();
  });

  it("a genuinely exhausted entitlement (no void) still decides at the same point", () => {
    // Same scoreline as above but the third away kick is a REAL miss, not a
    // void — sanity check that the fix did not also break the ordinary
    // early-decision case it must keep firing.
    const kicks: ShootoutKick[] = [
      kick("home", true),
      kick("away", false),
      kick("home", true),
      kick("away", false),
      kick("home", true),
      kick("away", false),
      kick("home", true), // home's 4th, still 4-0
    ];
    // home has 4 with 1 attempt left (5 total); away has 0 with 1 left.
    // 4 > 0 + 1 → decided.
    expect(shootoutDecision(kicks, 5)).toBe("home");
  });

  it("REGRESSION, sudden-death branch: a voided sudden-death response must not decide the pair early", () => {
    // attempts=2 for a short regulation. 1-1 then 2-2: level after both
    // sides' nominal attempts, so it correctly rolls into sudden death.
    // Home then scores the sudden-death kick; away's response in the same
    // pair is VOIDED (a foul), so away is still owed a real response before
    // this pair can decide anything.
    //
    // Pre-fix, `taken.away` still advanced to 3 on the void kick, which put
    // BOTH sides at `taken >= attempts` and made `remaining("away")` read 0
    // instead of 1 — `3 > 2 + 0` wrongly decided "home" one kick early.
    const kicks: ShootoutKick[] = [
      kick("home", true),
      kick("away", true),
      kick("home", true),
      kick("away", true), // 2-2, level after regulation attempts — not decided
      kick("home", true), // sudden death: home's kick, 3rd scored
      kick("away", false, true), // away's response in the pair: voided
    ];
    expect(shootoutDecision(kicks, 2)).toBeNull();
  });

  it("backward compatible: a kick recorded before this field existed (no `void` key at all) counts exactly as before", () => {
    const kicks: ShootoutKick[] = [
      { side: "home", scored: true },
      { side: "away", scored: false },
    ];
    // Sanity: identical to the same sequence built with `void` explicitly
    // absent via the helper.
    expect(shootoutDecision(kicks, 5)).toEqual(
      shootoutDecision([kick("home", true), kick("away", false)], 5),
    );
  });
});

describe("expectedKicker — the same taken tally as shootoutDecision (placer/verifier fork closed)", () => {
  it("a void kick does not advance whose turn it is — the SAME side retakes", () => {
    // Home kicks, away kicks, home's kick is voided — home retakes next, not away.
    const kicks: ShootoutKick[] = [
      kick("home", true),
      kick("away", true),
      kick("home", false, true), // home's kick voided
    ];
    expect(expectedKicker(kicks)).toBe("home");
  });

  it("REGRESSION shape: without the fix this would read \"away\" (taken.home=2, taken.away=1)", () => {
    // Explicit contrast with the case above: confirms the assertion is
    // actually discriminating and not accidentally true either way.
    const withoutVoidHandling = (list: ShootoutKick[]): "home" | "away" | null => {
      const taken = { home: 0, away: 0 };
      for (const k of list) taken[k.side]++;
      if (taken.home === taken.away) return list[0]?.side ?? null;
      return taken.home < taken.away ? "home" : "away";
    };
    const kicks: ShootoutKick[] = [kick("home", true), kick("away", true), kick("home", false, true)];
    expect(withoutVoidHandling(kicks)).toBe("away"); // the bug's answer
    expect(expectedKicker(kicks)).toBe("home"); // the fixed answer
  });

  it("normal alternation is unaffected: no void kicks anywhere", () => {
    expect(expectedKicker([])).toBeNull();
    expect(expectedKicker([kick("home", true)])).toBe("away");
    expect(expectedKicker([kick("home", true), kick("away", false)])).toBe("home");
  });
});

describe("shootoutTally — a void kick's `scored` value is never displayed", () => {
  it("a void kick that happened to carry scored:true does not inflate the scorebug", () => {
    const kicks: ShootoutKick[] = [kick("home", true), kick("away", true, true)];
    // Away's kick is void — whatever `scored` says on it, it must not count.
    expect(shootoutTally(kicks)).toEqual({ home: 1, away: 0 });
  });

  it("ordinary tallying is unaffected: no void kicks anywhere", () => {
    const kicks: ShootoutKick[] = [kick("home", true), kick("away", false), kick("home", false), kick("away", true)];
    expect(shootoutTally(kicks)).toEqual({ home: 1, away: 1 });
  });
});
