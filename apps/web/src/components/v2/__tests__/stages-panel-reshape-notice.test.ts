// `reshapeNotice` — the organiser-facing half of the Swiss eager reconcile.
//
// Before this, Generate reported only how many fixtures it SEATED, so a
// pre-Start field change could delete boards across every unpaired round —
// taking the times and courts pinned on them — and say nothing. The owner's
// reported problem was staleness they could not see; a silent fix for it is
// the same defect wearing a different hat.
//
// `apps/web` vitest is `environment: "node"`, so the component itself cannot be
// rendered here. `reshapeNotice` is exported pure for exactly that reason (the
// same reason `attachmentWarning` and `rebuildBlockedMessage` are), and this
// file drives it through the REAL dictionaries and the REAL `plural()` runtime
// rather than a stub — a fixture on both ends proves the fixture.
import { describe, expect, it } from "vitest";
import { reshapeNotice, type SwissReshapeWire } from "../stages-panel";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<Locale, Dict> = {
  en: en as Dict,
  es: es as Dict,
  fr: fr as Dict,
  nl: nl as Dict,
};
const LOCALES = Object.keys(DICTS) as Locale[];

/** The real runtime, bound to a real dictionary — no stubbed translator. */
function bind(locale: Locale) {
  const dict = DICTS[locale];
  return {
    msg: (key: string, vars?: Record<string, string | number>) => tRuntime(dict, key, vars),
    msgPlural: (key: string, count: number, vars?: Record<string, string | number>) =>
      pluralRuntime(dict, key, count, locale, vars),
  };
}

function notice(locale: Locale, reshaped: SwissReshapeWire | undefined): string | null {
  const { msg, msgPlural } = bind(locale);
  return reshapeNotice(reshaped, msg, msgPlural, locale);
}

const NOTHING: SwissReshapeWire = {
  matches_added: 0,
  matches_removed: 0,
  byes_added: 0,
  byes_removed: 0,
};

describe("reshapeNotice — a Generate that changed nothing stays silent", () => {
  it("returns null when the server sent no reshape at all", () => {
    for (const locale of LOCALES) expect(notice(locale, undefined)).toBeNull();
  });

  // Defence in depth: the server already omits an all-zero reshape, so this
  // pins that a zero-filled one would not start announcing itself either.
  it("returns null for an all-zero reshape", () => {
    for (const locale of LOCALES) expect(notice(locale, NOTHING)).toBeNull();
  });

  it("suppresses every clause whose count is zero", () => {
    const out = notice("en", { ...NOTHING, matches_removed: 2 })!;
    expect(out).toContain("2 matches removed");
    expect(out).not.toContain("added");
    expect(out).not.toContain("bye");
  });
});

describe("reshapeNotice — counts read as counts, in every locale", () => {
  // This programme has shipped "1 fixtures" five times. Every count goes
  // through `plural()`, so ONE is the case that witnesses it.
  it("uses the singular for one and the plural for more, in all four locales", () => {
    for (const locale of LOCALES) {
      const one = notice(locale, { ...NOTHING, matches_removed: 1 })!;
      const many = notice(locale, { ...NOTHING, matches_removed: 3 })!;
      expect(one).not.toBeNull();
      expect(one).not.toBe(many);
      // A missing `.one`/`.other` key makes `plural()` return the KEY itself.
      expect(one).not.toContain("schedule.notice.");
      expect(many).not.toContain("schedule.notice.");
      expect(many).toContain("3");
    }
  });

  it("never leaves an uninterpolated placeholder or a raw key behind", () => {
    const full: SwissReshapeWire = {
      matches_added: 2,
      matches_removed: 1,
      byes_added: 3,
      byes_removed: 1,
    };
    for (const locale of LOCALES) {
      const out = notice(locale, full)!;
      expect(out).not.toMatch(/\{\w+\}/);
      expect(out).not.toContain("schedule.notice.");
      expect(out.length).toBeGreaterThan(20);
    }
  });

  it("lists every non-zero clause, joined for the caller's locale", () => {
    const out = notice("en", {
      matches_added: 2,
      matches_removed: 1,
      byes_added: 1,
      byes_removed: 0,
    })!;
    expect(out).toContain("2 matches added");
    expect(out).toContain("1 match removed");
    expect(out).toContain("1 bye added");
    expect(out).not.toContain("byes removed");
    // `Intl.ListFormat`, not a hardcoded separator.
    expect(out).toContain("and");
  });
});

describe("reshapeNotice — the lost layout is said out loud, and only when it happened", () => {
  // The whole point. A removed board takes its `scheduled_at` and `court_id`
  // with it, and that is the sentence an organiser needs.
  it("adds the cleared-slots sentence when matches were removed", () => {
    for (const locale of LOCALES) {
      const removed = notice(locale, { ...NOTHING, matches_removed: 1 })!;
      const cleared = tRuntime(DICTS[locale], "schedule.notice.reshapedSlotsCleared");
      expect(removed).toContain(cleared);
    }
  });

  it("omits it when nothing was removed", () => {
    for (const locale of LOCALES) {
      const added = notice(locale, { ...NOTHING, matches_added: 2 })!;
      const cleared = tRuntime(DICTS[locale], "schedule.notice.reshapedSlotsCleared");
      expect(added).not.toContain(cleared);
    }
  });

  // A bye needs neither a court nor a slot, so losing one costs no layout.
  it("omits it when only a bye was removed", () => {
    const out = notice("en", { ...NOTHING, byes_removed: 2 })!;
    expect(out).toContain("2 byes removed");
    expect(out).not.toContain(tRuntime(DICTS.en, "schedule.notice.reshapedSlotsCleared"));
  });
});

describe("reshapeNotice — the copy is organiser vocabulary, not chess vocabulary", () => {
  // "board" is internal: in these dictionaries `board.*` already means the
  // SCHEDULING board, so a Swiss shell called a "board" on screen would collide
  // with a different product concept as well as read as chess.
  it("never says 'board' in any locale", () => {
    const full: SwissReshapeWire = {
      matches_added: 2,
      matches_removed: 2,
      byes_added: 2,
      byes_removed: 2,
    };
    for (const locale of LOCALES) {
      expect(notice(locale, full)!.toLowerCase()).not.toContain("board");
    }
  });
});

describe("reshapeNotice — all four dictionaries carry every key it reads", () => {
  const KEYS = [
    "schedule.notice.reshaped",
    "schedule.notice.reshapedSlotsCleared",
    "schedule.notice.reshapedMatchesAdded.one",
    "schedule.notice.reshapedMatchesAdded.other",
    "schedule.notice.reshapedMatchesRemoved.one",
    "schedule.notice.reshapedMatchesRemoved.other",
    "schedule.notice.reshapedByesAdded.one",
    "schedule.notice.reshapedByesAdded.other",
    "schedule.notice.reshapedByesRemoved.one",
    "schedule.notice.reshapedByesRemoved.other",
  ];

  it("has a non-empty, non-English-fallback value for each key in each locale", () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const val = (DICTS[locale] as Record<string, unknown>)[key];
        expect(typeof val, `${locale} ${key}`).toBe("string");
        expect((val as string).length, `${locale} ${key}`).toBeGreaterThan(0);
        if (locale !== "en") {
          // Not a copy of the English string — the four-dictionary rule exists
          // so translations are TRANSLATED, not duplicated.
          expect(val, `${locale} ${key} is still English`).not.toBe(
            (DICTS.en as Record<string, unknown>)[key],
          );
        }
      }
    }
  });

  it("keeps the {changes} and {count} placeholders every locale's runtime needs", () => {
    for (const locale of LOCALES) {
      const d = DICTS[locale] as Record<string, string>;
      expect(d["schedule.notice.reshaped"]).toContain("{changes}");
      for (const key of KEYS.filter((k) => k.endsWith(".other"))) {
        expect(d[key], `${locale} ${key}`).toContain("{count}");
      }
    }
  });
});
