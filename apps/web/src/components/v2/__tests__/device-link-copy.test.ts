import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { ApiV1Error } from "@/lib/client-v1";
import { failureKey, liveCopy } from "../device-link-copy";

const fmt = (iso: string) => `AT(${iso})`;

describe("device-link panel copy (scorer sheets §4.2)", () => {
  it("a sealed link (null expiry) says 'until the match is over' — never an epoch date", () => {
    expect(liveCopy(null, fmt)).toEqual({ key: "dlink.liveUntilOver" });
  });
  it("a dated row keeps the existing dated line (the key that already exists — no new legacy copy, ruling Q3)", () => {
    expect(liveCopy("2026-09-23T23:59:59Z", fmt)).toEqual({ key: "dlink.live", vars: { date: "AT(2026-09-23T23:59:59Z)" } });
  });
});

// Controller ruling (T3 fix round): a sealed link has no expiry since Task 2 —
// it works until the match is finalized or cancelled. The panel's description
// used to promise "today only" in every locale, which is now false on every
// hand-over screen. Pin the new lifetime per locale (the copy IS the source of
// truth here), and refuse the old "today" meaning in any of them.
const DESC: Record<string, string> = {
  en: en["dlink.desc"],
  es: es["dlink.desc"],
  fr: fr["dlink.desc"],
  nl: nl["dlink.desc"],
};
const LIFETIME: Record<string, string> = {
  en: "until it's finalized or cancelled",
  es: "hasta que se finalice o se cancele",
  fr: "jusqu'à ce qu'elle soit finalisée ou annulée",
  nl: "tot die is afgerond of geannuleerd",
};

describe("dlink.desc says how long a device link lives (no expiry since Task 2)", () => {
  it.each(Object.keys(DESC))("%s: works until the match is finalized or cancelled", (locale) => {
    expect(DESC[locale]).toContain(LIFETIME[locale]);
  });

  it.each(Object.keys(DESC))("%s: never promises 'today only' again", (locale) => {
    expect(DESC[locale]).not.toMatch(/\btoday\b|aujourd|\bhoy\b|vandaag|heute/i);
    // The rest of the sentence is still true and still there: the scorer
    // placeholder (who holds the phone scores as the {scorer}).
    expect(DESC[locale]).toContain("{scorer}");
  });
});

// Final review M3: a device link also stops scoring once its result moves the
// competition on (403 RESULT_CARRIED_FORWARD; the pad goes View-only), which in
// a knockout is the moment the result is entered, long before anyone
// finalizes. "Until finalized or cancelled" alone promised more than the link
// does. The clause is pinned per locale, in the verb that locale's own
// carried-forward refusal uses (`scorepad.refusal.carriedForward`), and it
// must follow the lifetime it qualifies.
const MOVED_ON: Record<string, string> = {
  en: "or its result moves the competition on",
  es: "o su resultado haga avanzar la competición",
  fr: "ou que son résultat fasse avancer la compétition",
  nl: "of de uitslag de competitie verder zet",
};

describe("dlink.desc also says the link stops once its result moves the competition on (review M3)", () => {
  it.each(Object.keys(DESC))("%s: the carried-forward bound, right after the lifetime", (locale) => {
    const desc = DESC[locale]!;
    expect(desc).toContain(MOVED_ON[locale]);
    expect(desc.indexOf(MOVED_ON[locale]!)).toBeGreaterThan(desc.indexOf(LIFETIME[locale]!));
  });
});

// Owner ruling (2026-09-23): the plain-Revoke warning says NO replacement is
// made and points at Revoke & reissue by ITS ON-SCREEN LABEL in that locale —
// read from the same dictionary, so a relabel moves this test with it. Its first
// sentence is the reissue warning's, word for word: both doors kill the QR.
const DICTS = { en, es, fr, nl } as Record<string, Record<string, string>>;

describe("dlink.revokeWarn: no replacement, and the way to get one (owner ruling 2026-09-23)", () => {
  it("en is the owner's sentence, verbatim", () => {
    expect(en["dlink.revokeWarn"]).toBe(
      "The QR already handed out or printed for this match will stop working. No replacement is made — use Revoke & reissue if you need a new one.",
    );
  });

  it.each(Object.keys(DICTS))("%s: opens with the reissue warning and names that locale's Revoke & reissue control", (locale) => {
    const d = DICTS[locale]!;
    const warn = d["dlink.revokeWarn"]!;
    expect(warn.startsWith(d["dlink.reissueWarn"]!), warn).toBe(true);
    expect(warn).toContain(d["dlink.reissue"]!);
    expect(warn.length, "a second sentence follows the shared one").toBeGreaterThan(d["dlink.reissueWarn"]!.length + 20);
  });
});

// Review finding 3 (T3 fix round 1): every refusal the hand-over routes send
// (ensure, reissue, revoke) reaches the organiser as a LOCALISED sentence,
// chosen by code, then status — never the server's English. The table below is
// what `lib/api-v1/http.ts` actually puts on the wire for these routes:
// `HttpError(status, message, code?)` with `code ?? statusCode(status)`, so a
// 422 arrives as code "ERROR" and only its status tells it apart.
describe("failureKey — a device-link refusal as the organiser reads it", () => {
  const refusal = (status: number, code: string, message = "server english") =>
    new ApiV1Error(message, status, code);

  // Empty case first: something that is not an API refusal at all (a dropped
  // connection surfaces as a TypeError from fetch) gets the generic line.
  it("a non-API failure (network TypeError) is the generic line", () => {
    expect(failureKey(new TypeError("Failed to fetch"))).toBe("dlink.failed");
    expect(failureKey("boom")).toBe("dlink.failed");
    expect(failureKey(undefined)).toBe("dlink.failed");
  });

  it.each([
    ["the fixture is finalized/cancelled (422, code ERROR)", refusal(422, "ERROR", "fixture is finalized — nothing left to score"), "dlink.error.matchOver"],
    ["the per-IP mint budget is spent (429)", refusal(429, "RATE_LIMITED", "Too many requests — slow down and try again."), "dlink.error.rateLimited"],
    ["the fixture or link is gone (404)", refusal(404, "NOT_FOUND", "fixture not found"), "dlink.error.notFound"],
    ["the caller may not manage links (403)", refusal(403, "FORBIDDEN", "Device links can only be managed with a session login"), "dlink.error.forbidden"],
    // Task 3 review carry: an expired organiser session is not "try again" —
    // retrying cannot work until they sign in again.
    ["the organiser's session has expired (401)", refusal(401, "UNAUTHENTICATED", "Not signed in"), "dlink.error.signedOut"],
    ["the server has no key (503 DEVICE_LINK_KEK_MISSING)", refusal(503, "DEVICE_LINK_KEK_MISSING"), "dlink.kekMissing"],
  ])("%s", (_label, err, key) => {
    expect(failureKey(err)).toBe(key);
  });

  // The right answer differs from every mapped constant here: the same 503
  // WITHOUT the KEK code, a 500, and a status nobody mapped all fall back.
  it.each([
    ["a 503 that is not the missing key", refusal(503, "INTERNAL")],
    ["a 500", refusal(500, "INTERNAL")],
    ["an unmapped 409", refusal(409, "CONFLICT")],
  ])("%s falls back to the generic line", (_label, err) => {
    expect(failureKey(err)).toBe("dlink.failed");
  });

  it("every key it can return exists, in all four locales, as a full sentence", () => {
    const keys = ["dlink.failed", "dlink.kekMissing", "dlink.error.matchOver", "dlink.error.rateLimited", "dlink.error.notFound", "dlink.error.forbidden", "dlink.error.signedOut"];
    for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, string>][]) {
      for (const key of keys) {
        expect(dict[key], `${locale} ${key}`).toMatch(/\S.*[.!]$/);
      }
    }
  });
});
