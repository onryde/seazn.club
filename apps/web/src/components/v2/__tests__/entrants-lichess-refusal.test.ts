// The organiser's roster refusal for an online-play division (fix round 1, owner 2026-10-25): the server's two reasons
// - no Lichess link, and a link that cannot play - are said in the organiser's language, naming the people the payload
// names, never as the server's English. The refusals under test are the REAL gate's (assertPersonIdsLinkedForOnlinePlay),
// fed through the mapping; the expected words come from the dictionaries, never from a string typed here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "@/lib/errors";
import { assertPersonIdsLinkedForOnlinePlay, type LichessLinkState } from "@/server/usecases/external-accounts";
import { classifyJoinFailure } from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/register/join/view-model";
import { LOCALES } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import {
  isLichessRefusalCode,
  LICHESS_REFUSAL_FAMILY,
  lichessRefusalText,
  type LichessRefusalDeps,
} from "../entrants-lichess-refusal";

const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<(typeof LOCALES)[number], Dict>;

const PEOPLE: Record<string, string> = { "p-ada": "Ada Okonkwo", "p-bo": "Bo Lindqvist", "p-cy": "Cy Nakamura" };

function depsFor(locale: (typeof LOCALES)[number], known: Record<string, string> = PEOPLE): LichessRefusalDeps {
  const dict = DICTS[locale];
  return {
    nameOf: (id) => known[id],
    list: (names) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names),
    plural: (key, count, vars) => pluralRuntime(dict, key, count, locale, vars),
    text: (key) => tRuntime(dict, key),
  };
}

/** What the real gate throws for a roster, by the reason it is refused for. */
function gateRefusal(states: [string, LichessLinkState][], ids: string[]): HttpError {
  try {
    assertPersonIdsLinkedForOnlinePlay(new Map(states), ids);
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("the gate did not refuse");
}

const asApiError = (e: HttpError) => ({ code: e.code, extra: e.extra as Record<string, unknown> });

describe("the organiser's Lichess roster refusal, said in every locale", () => {
  const link = gateRefusal([], ["p-ada", "p-bo"]);
  const reconnect = gateRefusal([["p-ada", "reconnect"], ["p-bo", "reconnect"]], ["p-ada", "p-bo"]);

  it("the real gate's two reasons are the two codes the panel maps, and they are different reasons", () => {
    expect([link.code, reconnect.code].every(isLichessRefusalCode), "both server codes are recognised").toBe(true);
    expect(link.code).not.toBe(reconnect.code);
    expect(new Set(Object.keys(LICHESS_REFUSAL_FAMILY)), "the panel maps exactly the codes the gate throws").toEqual(new Set([link.code, reconnect.code]));
    // The join form tells the same two apart by the same codes (one set of reasons across the three surfaces).
    expect(classifyJoinFailure(422, link.code)).toBe("lichessLink");
    expect(classifyJoinFailure(422, reconnect.code)).toBe("lichessReconnect");
    // Both name the people they are true of.
    expect(link.extra).toEqual({ person_ids: ["p-ada", "p-bo"] });
    expect(reconnect.extra).toEqual({ person_ids: ["p-ada", "p-bo"] });
  });

  it("names the people in every locale, in that locale's words, never the server's English", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const texts = new Map<string, string>();
      for (const [label, err] of [["link", link], ["reconnect", reconnect]] as const) {
        const text = lichessRefusalText(asApiError(err), depsFor(locale));
        expect(text, `${locale} ${label}`).not.toBeNull();
        expect(text, `${locale} ${label}: names Ada`).toContain("Ada Okonkwo");
        expect(text, `${locale} ${label}: names Bo`).toContain("Bo Lindqvist");
        expect(text, `${locale} ${label}: no placeholder left`).not.toMatch(/[{}]/);
        expect(text, `${locale} ${label}: not the server's message`).not.toBe(err.message);
        expect(text, `${locale} ${label}: no em dash in the copy`).not.toContain("—");
        texts.set(label, text!);
        checked++;
      }
      expect(texts.get("link"), `${locale}: the two reasons read differently`).not.toBe(texts.get("reconnect"));
      if (locale === "en") {
        // The words carry the reason, independently of which dictionary key the mapping reaches: a swapped mapping reads
        // as the other reason here even though both texts still exist and still differ.
        expect(texts.get("link"), "en: the link reason says link").toMatch(/\blink/i);
        expect(texts.get("link"), "en: and does not say reconnect").not.toMatch(/reconnect/i);
        expect(texts.get("reconnect"), "en: the reconnect reason says reconnect").toMatch(/reconnect/i);
      }
      if (locale !== "en") {
        expect(texts.get("link"), `${locale}: translated, not the English`).not.toBe(lichessRefusalText(asApiError(link), depsFor("en")));
        expect(texts.get("reconnect"), `${locale}: translated, not the English`).not.toBe(lichessRefusalText(asApiError(reconnect), depsFor("en")));
      }
    }
    expect(checked, "anti-vacuity: 2 reasons x every locale").toBe(2 * LOCALES.length);
  });

  it("one person is the singular form and two or more the plural form (the plural machinery is reached)", () => {
    const one = gateRefusal([], ["p-cy"]);
    const keys: string[] = [];
    const record: LichessRefusalDeps = { ...depsFor("en"), plural: (key, count) => (keys.push(`${key}#${count}`), key) };
    lichessRefusalText(asApiError(one), record);
    lichessRefusalText(asApiError(link), record);
    expect(keys).toEqual([`${LICHESS_REFUSAL_FAMILY.LICHESS_LINK_REQUIRED}#1`, `${LICHESS_REFUSAL_FAMILY.LICHESS_LINK_REQUIRED}#2`]);
    // And English really differs between them.
    expect(lichessRefusalText(asApiError(one), depsFor("en"))).not.toBe(lichessRefusalText(asApiError(link), depsFor("en")));
  });

  it("names are all-or-nothing: one person the client cannot name makes it the nameless copy, which names nobody", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const partial = lichessRefusalText(asApiError(link), depsFor(locale, { "p-ada": "Ada Okonkwo" }));
      expect(partial, `${locale}: Ada alone must not read as the only problem`).not.toContain("Ada Okonkwo");
      expect(partial).toBe(tRuntime(DICTS[locale], `${LICHESS_REFUSAL_FAMILY.LICHESS_LINK_REQUIRED}.unnamed`));
      const none = lichessRefusalText({ code: reconnect.code, extra: {} }, depsFor(locale));
      expect(none, `${locale}: no ids at all`).toBe(tRuntime(DICTS[locale], `${LICHESS_REFUSAL_FAMILY.LICHESS_RECONSENT_REQUIRED}.unnamed`));
      expect(none).not.toBe(partial);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("anything else is not its business: other codes, and no code, return null so the caller keeps its own handling", () => {
    for (const err of [{ code: "ENTRANT_KIND_NOT_ALLOWED", extra: { person_ids: ["p-ada"] } }, { code: undefined, extra: {} }, { code: "lichess_link_required" }]) {
      expect(lichessRefusalText(err, depsFor("en"))).toBeNull();
    }
  });

  it("every copy key the mapping can reach exists in every locale (counted)", () => {
    let checked = 0;
    for (const family of Object.values(LICHESS_REFUSAL_FAMILY)) {
      for (const suffix of ["one", "other", "unnamed"]) {
        for (const locale of LOCALES) {
          const value = DICTS[locale][`${family}.${suffix}`];
          expect(typeof value, `${locale} ${family}.${suffix}`).toBe("string");
          expect((value as string).length).toBeGreaterThan(10);
          if (suffix !== "unnamed") expect(value, `${locale} ${family}.${suffix} takes the names`).toContain("{players}");
          checked++;
        }
      }
    }
    expect(checked, "2 families x 3 forms x every locale").toBe(2 * 3 * LOCALES.length);
  });
});
