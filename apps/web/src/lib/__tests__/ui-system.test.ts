// PROMPT-32 golden/unit acceptance: chip-state vocabulary, logo fallback
// chain, typed-confirm arming, messages interpolation, division hue
// stability. All pure — the e2e suite covers the rendered behaviour.
import { describe, expect, it } from "vitest";
import {
  competitionChipState,
  divisionChipState,
  CHIP_SORT,
  type CompetitionChipSignals,
} from "@/components/ui/status-chip";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { initials } from "@/components/ui/entity-logo";
import { isConfirmArmed } from "@/lib/typed-confirm";
import { msg, messages } from "@/lib/messages";
import { divisionHue, divisionAccent } from "@/lib/division-hue";
import { nextLine } from "@/components/v2/org-home/home-rules";

/** A competition whose divisions say nothing yet: none in play, no window open, none started or finished, nothing played. */
const QUIET: CompetitionChipSignals = { inPlay: 0, registrationOpen: false, divisions: 2, divisionsActive: 0, divisionsCompleted: 0, played: 0 };
const sig = (over: Partial<CompetitionChipSignals>): CompetitionChipSignals => ({ ...QUIET, ...over });
// Every competition status the schema allows (competitions.status check).
const COMPETITION_STATUSES = ["draft", "published", "live", "completed", "archived"] as const;

describe("status chip vocabulary (v3/03 §1)", () => {
  // UI5 item 6 (owner, 2026-11-03: "why does it saying registration open even though no registration opened in division
  // level"). The card's chip is read off its DIVISIONS, never off `competitions.status` alone: "published" means public, not
  // taking sign-ups. Ladder (controller, given to the owner): archived; a match in play -> Live; a division's registration
  // window open -> Registration open; every division completed -> Completed; a division started or a result in -> In
  // progress; else Draft.
  it("the empty case first: a competition whose divisions say nothing is Draft, whatever its status but the two terminal ones", () => {
    let checked = 0;
    for (const status of COMPETITION_STATUSES) {
      if (status === "archived" || status === "completed") continue;
      expect(competitionChipState(status, QUIET), status).toBe("draft");
      checked++;
    }
    expect(competitionChipState("draft", sig({ divisions: 0 })), "no division at all").toBe("draft");
    expect(checked).toBe(3);
  });

  it("the owner's case: published, under way, no division's window open - In progress, never Registration open", () => {
    const underWay = sig({ divisionsActive: 1, played: 3 });
    expect(competitionChipState("published", underWay)).toBe("in_progress");
    expect(competitionChipState("live", underWay)).toBe("in_progress");
    // ...and "published" with nothing started and no window is not a sign-up either.
    expect(competitionChipState("published", QUIET)).not.toBe("registration");
  });

  it("one rung each: Live, Registration open, Completed, In progress, Archived", () => {
    expect(competitionChipState("published", sig({ inPlay: 1, divisionsActive: 1 })), "a match in play").toBe("live");
    expect(competitionChipState("draft", sig({ registrationOpen: true })), "a window open").toBe("registration");
    expect(competitionChipState("live", sig({ divisionsCompleted: 2, played: 9 })), "every division completed").toBe("completed");
    expect(competitionChipState("completed", QUIET), "the organiser wrapped it up").toBe("completed");
    expect(competitionChipState("published", sig({ divisionsActive: 1 })), "a division started, nothing played yet").toBe("in_progress");
    expect(competitionChipState("published", sig({ played: 1 })), "a result in, no division active").toBe("in_progress");
    expect(competitionChipState("archived", sig({ inPlay: 2, registrationOpen: true })), "archived").toBe("archived");
    expect(competitionChipState("live", sig({ inPlay: 2 }), { archived: true }), "archived by option").toBe("archived");
  });

  it("precedence, each pair where the two rungs disagree", () => {
    // Live beats a window open, and a window open beats under way: a running competition still taking entries says so.
    expect(competitionChipState("live", sig({ inPlay: 1, registrationOpen: true, divisionsActive: 1 }))).toBe("live");
    expect(competitionChipState("live", sig({ registrationOpen: true, divisionsActive: 1, played: 4 }))).toBe("registration");
    // Completed needs EVERY division: one of two finished, the other still running, is in progress.
    expect(competitionChipState("live", sig({ divisionsCompleted: 1, divisionsActive: 1, played: 6 }))).toBe("in_progress");
    expect(competitionChipState("live", sig({ divisionsCompleted: 1, played: 6 })), "one finished, one not started").toBe("in_progress");
    // A match in play outranks the organiser's "completed" (the public chip's rule: in play is on now, whatever the status).
    expect(competitionChipState("completed", sig({ inPlay: 1, divisionsCompleted: 1, divisionsActive: 1 }))).toBe("live");
  });

  it("refuses signals no read can produce, rather than print a chip off them", () => {
    expect(() => competitionChipState("live", sig({ divisionsCompleted: 3 }))).toThrow(RangeError);
    expect(() => competitionChipState("live", sig({ divisionsActive: 2, divisionsCompleted: 1 }))).toThrow(RangeError);
    expect(() => competitionChipState("live", sig({ inPlay: -1 }))).toThrow(RangeError);
    expect(() => competitionChipState("live", sig({ played: 0.5 }))).toThrow(RangeError);
  });

  it("maps division statuses; a registration window promotes setup", () => {
    expect(divisionChipState("setup")).toBe("draft");
    expect(divisionChipState("setup", { registrationOpen: true })).toBe("registration");
    expect(divisionChipState("scheduled")).toBe("scheduled");
    expect(divisionChipState("active")).toBe("live");
    expect(divisionChipState("completed")).toBe("completed");
    expect(divisionChipState("active", { archived: true })).toBe("archived");
  });

  it("sorts Live first, then Registration open, In progress, Draft, Completed, Archived", () => {
    const order = ["archived", "draft", "in_progress", "live", "completed", "registration"] as const;
    const sorted = [...order].sort((a, b) => CHIP_SORT[a] - CHIP_SORT[b]);
    expect(sorted).toEqual(["live", "registration", "in_progress", "draft", "completed", "archived"]);
  });

  it("every chip state has a label in all four locales, In progress included", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>)) {
      for (const state of Object.keys(CHIP_SORT)) {
        const key = state === "in_progress" ? "chip.inProgress" : `chip.${state}`;
        expect(dict[key], `${locale} ${key}`).toBeTruthy();
        checked++;
      }
      if (locale !== "en") expect(dict["chip.inProgress"], `${locale} is translated`).not.toBe(uiEn["chip.inProgress" as keyof typeof uiEn]);
    }
    expect(checked).toBe(4 * Object.keys(CHIP_SORT).length);
  });
});

describe("EntityLogo fallback chain (v3/03 §5)", () => {
  it("initials: single word takes two letters, multi-word takes first+last", () => {
    expect(initials("Riverside")).toBe("RI");
    expect(initials("Northside Netters")).toBe("NN");
    expect(initials("A B C United")).toBe("AU");
    expect(initials("  ")).toBe("?");
  });
});

describe("typed-confirm arming (v3/03 §3)", () => {
  it("no challenge → armed", () => {
    expect(isConfirmArmed(undefined, "")).toBe(true);
  });
  it("mismatch blocks confirm; exact match arms", () => {
    expect(isConfirmArmed("U16 Boys", "")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "u16 boys")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "U16 Boys ")).toBe(false);
    expect(isConfirmArmed("U16 Boys", "U16 Boys")).toBe(true);
  });
});

describe("messages layer (v3/11 gap 4)", () => {
  it("interpolates placeholders and leaves unknown ones intact", () => {
    expect(msg("confirm.leaveOrg.body", { name: "Acme" })).toContain("Acme");
    expect(msg("confirm.typed.instruction")).toContain("{name}");
  });
  it("every message is non-empty English", () => {
    for (const [key, value] of Object.entries(messages)) {
      expect(value.length, key).toBeGreaterThan(0);
    }
  });
});

describe("division hue (v3/03 §1)", () => {
  it("is stable for an id and stays off the brand violet band (260–290°)", () => {
    const id = "3c9f1c2e-1111-4eee-9c60-000000000042";
    expect(divisionHue(id)).toBe(divisionHue(id));
    for (let i = 0; i < 50; i++) {
      const hue = divisionHue(`division-${i}`);
      expect(hue < 260 || hue > 290).toBe(true);
    }
    expect(divisionAccent(id)).toMatch(/^hsl\(\d+ 62% 48%\)$/);
  });
});

describe("card meta lines (v3/03 §1)", () => {
  // Match Day C7 review I1: the quiet card's "Next:" line reads as the deck beside it does — the organisation's zone, the
  // locale's own order and its own word for "vs" — so the f() below is what the org home passes it.
  const EN = { locale: "en", tz: "Europe/Amsterdam", day: "2026-11-08", vs: "vs" };

  it("nextLine answers null for no fixture, and refuses one with a side still to be decided instead of printing 'TBD'", () => {
    expect(nextLine(null, EN)).toBeNull();
    // card-stats' query never returns such a fixture (D4a); the line refuses it too rather than inventing a placeholder.
    expect(nextLine({ home: "Arun", away: null, court_label: null, scheduled_at: null, in_play: false }, EN)).toBeNull();
    expect(nextLine({ home: null, away: "Dev", court_label: "Court 2", scheduled_at: null, in_play: true }, EN)).toBeNull();
    // An unscheduled fixture with both sides is an answer: just the pair (the positive pair of the refusals above).
    expect(nextLine({ home: "Arun", away: "Dev", court_label: null, scheduled_at: null, in_play: false }, EN)).toMatchObject({
      when: null,
      pair: "Arun vs Dev",
      text: "Arun vs Dev",
      live: false,
    });
  });

  it("nextLine reports `live` separately instead of baking a 'Now:' prefix into the text — the caller picks exactly one label, so a live fixture never renders both 'Next:' and 'Now:' stacked together (design/fix-ui/02-console-org.md)", () => {
    const line = nextLine({ home: "A", away: "B", court_label: "Court 2", scheduled_at: "2026-11-08T14:10:00Z", in_play: true }, EN);
    expect(line).toEqual({ when: null, court: "Court 2", pair: "A vs B", live: true, text: "Court 2, A vs B" });
    // No baked-in label of either kind — the raw fixture text alone.
    expect(line?.text).not.toMatch(/^(Next|Now):/);
  });

  it("nextLine prints the time in the organisation's zone, 24-hour, in the locale's order, with the locale's word for 'vs'", () => {
    // 14:10Z is 15:10 in Amsterdam in November (UTC+1); the server's own zone (UTC on Fly) would print 14:10.
    const sameDay = nextLine({ home: "A", away: "B", court_label: null, scheduled_at: "2026-11-08T14:10:00Z", in_play: false }, EN);
    expect(sameDay?.when).toBe("15:10");
    // Another day: the date in front, English day-month (owner ruling 2026-09-16), never US "Mon, Nov 9" or "02:10 PM".
    const monday = nextLine({ home: "A", away: "B", court_label: null, scheduled_at: "2026-11-09T14:10:00Z", in_play: false }, EN);
    expect(monday?.when).toBe("Mon 9 Nov 15:10");
    // French: its own weekday and month, and "contre".
    const fr = nextLine(
      { home: "A", away: "B", court_label: null, scheduled_at: "2026-11-09T14:10:00Z", in_play: false },
      { ...EN, locale: "fr", vs: "contre" },
    );
    expect(fr?.pair).toBe("A contre B");
    expect(fr?.when).toMatch(/^lun\.? 9 nov\.? 15:10$/);
  });
});

describe("pin tip copy (PROMPT-33 follow-up)", () => {
  it("schedule.locking explains BOTH halves: auto passes skip pins, manual moves still work", async () => {
    const { TIPS } = await import("@/config/tips");
    const tip = TIPS["schedule.locking"];
    // The old copy implied a pinned slot was immovable — it isn't. Any future
    // edit must keep saying that manual moves stay allowed and point at the
    // division freeze for full read-only.
    expect(tip.body).toMatch(/Auto-schedule|auto pass/i);
    expect(tip.body).toMatch(/still drag|move .* yourself/i);
    expect(tip.body).toMatch(/freeze/i);
  });

  it("schedule.locking never quotes the retired pin/lock EMOJI (board redesign, 2026-08-10)", async () => {
    // Regression: the board redesign (docs/superpowers/specs/2026-08-10-
    // board-view-redesign-design.md) replaced the raw 📌/🔒 glyphs on the
    // fixture card with real lucide icons (Pin/Lock), but this tip — rendered
    // right on the same page (`<Tip id="schedule.locking" />` in
    // schedule-board.tsx) — still told the user to look for the OLD glyphs in
    // its copy. Caught by scripts/smoke.ts's `boardRedesignSuite`: SSR'd page
    // markup still carried the emoji, in the dictionaries, even though no
    // fixture card does anymore. `Tip`'s rendered body text comes from
    // `useMsg("tips.<id>.body")`, i.e. the DICTIONARIES — not this config
    // object's own `.body` field (only its `helpSlug` is read at runtime) —
    // so the four dictionaries are the ones that actually reach the page and
    // must be checked directly, not just this config's mirror of them.
    const PIN = "\u{1F4CC}"; // 📌
    const LOCK = "\u{1F512}"; // 🔒
    const { TIPS } = await import("@/config/tips");
    const configBody = TIPS["schedule.locking"].body;
    expect(configBody).not.toContain(PIN);
    expect(configBody).not.toContain(LOCK);

    const [uiEn, uiNl, uiFr, uiEs] = await Promise.all([
      import("@/dictionaries/en/ui.json"),
      import("@/dictionaries/nl/ui.json"),
      import("@/dictionaries/fr/ui.json"),
      import("@/dictionaries/es/ui.json"),
    ]);
    for (const [locale, dict] of [
      ["en", uiEn.default],
      ["nl", uiNl.default],
      ["fr", uiFr.default],
      ["es", uiEs.default],
    ] as const) {
      const body = (dict as Record<string, string>)["tips.schedule.locking.body"];
      expect(body, `${locale} tips.schedule.locking.body`).not.toContain(PIN);
      expect(body, `${locale} tips.schedule.locking.body`).not.toContain(LOCK);
    }
  });
});
