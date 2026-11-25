// Online Chess credits, Task 11 fix round 1 (review I2): the package doors' refusals reach the organiser through MORE screens than the
// picker, the Format dialog, the builder and the strip - and each must say them in the organiser's language off the CODE, never as the
// server's English `err.message`:
//
//   ONLINE_CAMERAS_NEED_UPGRADE   division-settings.tsx's camera save                     -> settingsSaveErrorText
//   ONLINE_ROUNDS_NEED_SIZE /     the Swiss rounds dialog, Add a round (stages panel and  -> swissStageRefusal, swissFinishRefusal and
//   ONLINE_ROUNDS_ABOVE_MAX       the Entrants tab's recovery button)                        swissDoorRefusalText (the Entrants tab's reader)
//                                 Generate / Complete / Delete                            -> classifyActError
//                                 Rebuild                                                 -> rebuildErrorText
//   ONLINE_FORMAT_NOT_SUPPORTED   Add stage (and the Generate that follows it)            -> addStageErrorText
//
// Every refusal is the REAL one the server's gates build, carried over the REAL wire (the v1 handler's Response parsed by the real
// apiV1), so `code` and `extra` are exactly what a browser holds. Expected sentences come from each locale's own dictionary, filled with
// the leaf's numbers (the ladder), never from the mapper under test. A reader that printed `err.message` would fail in es/fr/nl, and a
// door nobody mapped would fail in every locale.
import { describe, expect, it, vi } from "vitest";
import { swissDoorRefusalText } from "@/lib/swiss-door-refusal";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { addStageErrorText, classifyActError, rebuildErrorText, swissFinishRefusal, swissStageRefusal } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { ONLINE_SIZES, includedRounds } from "@/lib/online-chess-package";
import { v1 } from "@/server/api-v1/http";
import { camerasNeedUpgrade, formatNotSupported, roundsAboveMax, roundsNeedSize } from "@/server/usecases/online-package/format";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<Locale, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const msgIn = (locale: Locale) => (key: string, vars?: Record<string, string | number>) => t(DICTS[locale], key, vars);
const pluralIn = (locale: Locale) => (key: string, n: number, vars?: Record<string, string | number>) => t(DICTS[locale], `${key}.other`, { count: n, ...vars });

/** The server's error as the browser receives it: the REAL v1 handler's Response, parsed by the REAL apiV1. */
async function overTheWire(err: Error): Promise<ApiV1Error> {
  const real = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  const res = await v1(async () => {
    throw err;
  });
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => res) as typeof fetch;
  try {
    await real.apiV1("/api/v1/the-door");
  } catch (e) {
    return e as ApiV1Error;
  } finally {
    globalThis.fetch = saved;
  }
  throw new Error("premise: the wire answered ok");
}

// The numbers, from the leaf's ladder: 8 rounds do not fit 16 players, and the smallest size that includes them is the one to offer.
const ROUNDS_ASKED = 8;
const FROM_SIZE = ONLINE_SIZES[0]!;
const NEXT_SIZE = ONLINE_SIZES.find((s) => includedRounds(s) >= ROUNDS_ASKED)!;
const MAX_ROUNDS = includedRounds(ONLINE_SIZES.at(-1)!);
const CAMERA_DIVISIONS = [{ id: "d1", name: "Under 12", owed: 2 }, { id: "d2", name: "Open", owed: 4 }];

const CASES = [
  { label: "ONLINE_ROUNDS_NEED_SIZE", server: () => roundsNeedSize(FROM_SIZE, ROUNDS_ASKED), key: "onlineChess.roundsNeedSize", vars: { nextSize: NEXT_SIZE } },
  { label: "ONLINE_ROUNDS_ABOVE_MAX", server: () => roundsAboveMax(MAX_ROUNDS + 1), key: "onlineChess.roundsAboveMax", vars: { max: MAX_ROUNDS } },
  { label: "ONLINE_FORMAT_NOT_SUPPORTED", server: () => formatNotSupported("league"), key: "onlineChess.format.refused", vars: {} },
  { label: "ONLINE_CAMERAS_NEED_UPGRADE", server: () => camerasNeedUpgrade(CAMERA_DIVISIONS), key: "onlineChess.camerasNeedUpgrade", vars: { names: "Under 12, Open" } },
] as const;
type Case = (typeof CASES)[number];
const byLabel = (label: Case["label"]) => CASES.find((c) => c.label === label)!;

/** The door -> the reader its error goes through -> the codes that door can receive (the server's own throw sites). */
const DOORS: { door: string; read: (err: ApiV1Error, l: Locale) => string; codes: Case["label"][] }[] = [
  { door: "camera save (division-settings.tsx)", read: (e, l) => settingsSaveErrorText(e, msgIn(l) as never, "fallback"), codes: ["ONLINE_CAMERAS_NEED_UPGRADE", "ONLINE_FORMAT_NOT_SUPPORTED"] },
  { door: "Swiss rounds dialog / Add a round (swissStageRefusal)", read: (e, l) => swissStageRefusal(e, msgIn(l) as never, pluralIn(l) as never, l).text, codes: ["ONLINE_ROUNDS_NEED_SIZE", "ONLINE_ROUNDS_ABOVE_MAX"] },
  { door: "Finish the Swiss (swissFinishRefusal)", read: (e, l) => swissFinishRefusal(e, msgIn(l) as never, pluralIn(l) as never, l).text, codes: ["ONLINE_ROUNDS_NEED_SIZE", "ONLINE_ROUNDS_ABOVE_MAX"] },
  { door: "Entrants tab recovery doors (swissDoorRefusalText)", read: (e, l) => swissDoorRefusalText(e.code, e.extra, msgIn(l) as never, pluralIn(l) as never) ?? e.message, codes: ["ONLINE_ROUNDS_NEED_SIZE", "ONLINE_ROUNDS_ABOVE_MAX"] },
  { door: "Generate / Complete / Delete (classifyActError)", read: (e, l) => classifyActError(e, msgIn(l) as never, l).text, codes: ["ONLINE_ROUNDS_NEED_SIZE", "ONLINE_ROUNDS_ABOVE_MAX"] },
  { door: "Rebuild (rebuildErrorText)", read: (e, l) => rebuildErrorText(e, msgIn(l) as never, pluralIn(l) as never, l), codes: ["ONLINE_ROUNDS_NEED_SIZE", "ONLINE_ROUNDS_ABOVE_MAX"] },
  { door: "Add stage (addStageErrorText)", read: (e, l) => addStageErrorText(e, msgIn(l) as never, l), codes: ["ONLINE_FORMAT_NOT_SUPPORTED", "ONLINE_ROUNDS_NEED_SIZE"] },
];

describe("premises", () => {
  it("each refusal crosses the wire with its code and the facts its sentence names; the four locales' sentences differ (else the sweep is vacuous)", async () => {
    const wire = await Promise.all(CASES.map((c) => overTheWire(c.server())));
    expect(wire.every((w) => w instanceof ApiV1Error)).toBe(true);
    expect(wire.map((w) => w.code)).toEqual(CASES.map((c) => c.label));
    expect(wire[0]!.extra.nextSize, "the size to move to rides the wire").toBe(NEXT_SIZE);
    expect(Array.isArray(wire[3]!.extra.divisions) && (wire[3]!.extra.divisions as unknown[]).length, "the camera refusal names its divisions").toBe(CAMERA_DIVISIONS.length);
    for (const c of CASES) {
      const sentences = new Set(LOCALES.map((l) => msgIn(l)(c.key, c.vars)));
      expect(sentences.size, `${c.label}: the locales' sentences differ`).toBeGreaterThanOrEqual(3);
      expect(sentences.has(c.server().message), `${c.label}: the dictionary is not the server's English`).toBe(false);
    }
  });
});

describe("every screen that can receive a package refusal says it in the reader's language", () => {
  it("door x code x locale: the dictionary's sentence, every slot filled, never the server's English", async () => {
    let checked = 0;
    for (const door of DOORS) {
      for (const label of door.codes) {
        const c = byLabel(label);
        const server = c.server();
        const wire = await overTheWire(server);
        for (const locale of LOCALES) {
          const shown = door.read(wire, locale);
          const expected = msgIn(locale)(c.key, c.vars);
          expect(shown, `${door.door} / ${label} / ${locale}`).toBe(expected);
          expect(shown, `${door.door} / ${label} / ${locale}: every slot filled`).not.toMatch(/\{\w+\}/);
          if (locale !== "en") expect(shown, `${door.door} / ${label} / ${locale}: never the server's English`).not.toBe(server.message);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: every door x code x locale was read").toBe(DOORS.reduce((n, d) => n + d.codes.length, 0) * LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an error that is none of the four codes keeps each reader's own handling (the positive pair)", async () => {
    const other = new ApiV1Error("Something else, in English", 409, "SOME_OTHER_CODE", {});
    for (const door of DOORS) expect(door.read(other, "fr"), door.door).toContain("Something else, in English");
  });

  it("a refusal missing the fact its sentence names keeps the server's words rather than a half-filled sentence", () => {
    const bare = new ApiV1Error("Rounds need a bigger size, server English", 422, "ONLINE_ROUNDS_NEED_SIZE", {});
    expect(settingsSaveErrorText(bare, msgIn("fr") as never, "x")).toBe(bare.message);
    expect(swissStageRefusal(bare, msgIn("fr") as never, pluralIn("fr") as never, "fr").text).toBe(bare.message);
  });
});
