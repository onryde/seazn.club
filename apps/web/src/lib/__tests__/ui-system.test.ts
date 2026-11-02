// PROMPT-32 golden/unit acceptance: chip-state vocabulary, logo fallback
// chain, typed-confirm arming, messages interpolation, division hue
// stability. All pure — the e2e suite covers the rendered behaviour.
import { describe, expect, it } from "vitest";
import {
  competitionChipState,
  divisionChipState,
  CHIP_SORT,
} from "@/components/ui/status-chip";
import { initials } from "@/components/ui/entity-logo";
import { isConfirmArmed } from "@/lib/typed-confirm";
import { msg, messages } from "@/lib/messages";
import { divisionHue, divisionAccent } from "@/lib/division-hue";
import { nextLine } from "@/components/v2/org-home/home-rules";

describe("status chip vocabulary (v3/03 §1)", () => {
  it("maps competition statuses to the five chip states", () => {
    expect(competitionChipState("draft")).toBe("draft");
    expect(competitionChipState("published")).toBe("registration");
    expect(competitionChipState("live")).toBe("live");
    expect(competitionChipState("completed")).toBe("completed");
    expect(competitionChipState("archived")).toBe("archived");
    expect(competitionChipState("live", { archived: true })).toBe("archived");
  });

  it("maps division statuses; a registration window promotes setup", () => {
    expect(divisionChipState("setup")).toBe("draft");
    expect(divisionChipState("setup", { registrationOpen: true })).toBe("registration");
    expect(divisionChipState("scheduled")).toBe("scheduled");
    expect(divisionChipState("active")).toBe("live");
    expect(divisionChipState("completed")).toBe("completed");
    expect(divisionChipState("active", { archived: true })).toBe("archived");
  });

  it("sorts Live first, then Registration open, Draft, Completed, Archived", () => {
    const order = ["archived", "draft", "live", "completed", "registration"] as const;
    const sorted = [...order].sort((a, b) => CHIP_SORT[a] - CHIP_SORT[b]);
    expect(sorted).toEqual(["live", "registration", "draft", "completed", "archived"]);
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
