// Every ABSOLUTE date/time the scheduling panels read or write resolves on the
// VENUE clock — `settings.orgTz`, the governing zone (#448) — never on the
// organiser's browser.
//
// THE BUG THIS PINS. `<input type="datetime-local">` has no offset. Both panels
// used to turn its value into an instant with `new Date(value)` and back with
// `toLocalInput(iso)`, which resolves through whatever zone the BROWSER is in.
// The two errors cancel for one organiser — type 12:00, see 12:00 — so nothing
// on screen looked wrong, while the instant actually stored was their noon, not
// the venue's. The solver reads that instant on `orgTz` and schedules against a
// window nobody asked for. The server was never at fault: an ISO instant
// carries its offset and is never re-zoned.
//
// WHY THE ZONE PAIR MATTERS. A test whose venue zone equals the process zone
// passes against the broken code — the two lanes coincide and no assertion can
// separate them. `Pacific/Auckland` is UTC+12/+13: 19 hours from
// `America/Los_Angeles`, across the date line, and on the far side of midnight
// from this process. `guards` at the bottom fails loudly if that ever stops
// being true rather than reporting a vacuous green.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  blackoutRowError,
  ConstraintsPanel,
  draftsToBlackouts,
  toBlackoutDrafts,
} from "../constraints-panel";
import { SettingsPanel, StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
import { toLocalInput } from "@/lib/schedule-board";
import { zonedDateInput, zonedDateTimeInput } from "@/lib/zoned-datetime";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { BoardConfig } from "@/components/v2/board/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  storedConfig: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "PUT") return {};
      return { division_id: "d1", config: api.storedConfig };
    }),
  };
});

/** The venue zone throughout. NZST is UTC+12 in August (NZDT +13 from 27 Sep). */
const ORG_TZ = "Pacific/Auckland";
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const label = (key: keyof typeof enUi) => enUi[key] as string;
const flush = () => new Promise((r) => setTimeout(r, 0));
const byText = (els: ReactElement[], type: string, text: string) =>
  els.find((el) => el.type === type && propsOf(el).children === text);
const fieldNamed = (els: ReactElement[], name: string) =>
  els.filter((el) => propsOf(el).label === name);

function putBody(): { config: Record<string, unknown> } {
  const put = api.calls.find((c) => c.options?.method === "PUT");
  if (!put) throw new Error(`no PUT — calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`);
  return put.options!.json as { config: Record<string, unknown> };
}

beforeEach(() => {
  api.calls.length = 0;
  api.storedConfig = {};
});

// ---------------------------------------------------------------------------
// 1. Blackout windows — constraints-panel.tsx
// ---------------------------------------------------------------------------

/** Noon on 1 Aug 2026 at the venue. In UTC that is midnight the same morning;
 *  in a Los Angeles browser it is 17:00 the PREVIOUS day. */
const VENUE_NOON = "2026-08-01T12:00";
const VENUE_NOON_ISO = "2026-08-01T00:00:00.000Z";
const VENUE_ONE_PM = "2026-08-01T13:00";
const VENUE_ONE_PM_ISO = "2026-08-01T01:00:00.000Z";

describe("blackout windows resolve on the venue clock", () => {
  function panelProps(config: Record<string, unknown> = {}) {
    return {
      divisionId: "d1",
      initialSettings: { division_id: "d1", config: { courts: ["Court 1"], ...config } },
      canEdit: true,
      orgTz: ORG_TZ,
    };
  }

  it("stores a typed window as the instant it names at the VENUE", async () => {
    api.storedConfig = { courts: ["Court 1"] };
    const island = renderIsland(ConstraintsPanel, panelProps());
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();

    const type = (name: string, value: string) =>
      (propsOf(fieldNamed(island.tree(), label(name as keyof typeof enUi))[0]!).onChange as (v: string) => void)(
        value,
      );
    type("constraints.blackout.from", VENUE_NOON);
    type("constraints.blackout.to", VENUE_ONE_PM);

    (propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).onClick as () => void)();
    await flush();

    expect(putBody().config.blackouts).toEqual([
      { from: VENUE_NOON_ISO, to: VENUE_ONE_PM_ISO },
    ]);
    // The browser lane would have stored a different instant entirely. Pinning
    // the gap keeps this assertion honest if the fixture zone ever changes.
    expect(new Date(VENUE_NOON).toISOString()).not.toBe(VENUE_NOON_ISO);
  });

  it("shows a stored window on the venue clock, not the reader's", () => {
    const stored = [{ from: VENUE_NOON_ISO, to: VENUE_ONE_PM_ISO }];
    const island = renderIsland(ConstraintsPanel, panelProps({ blackouts: stored }));
    expect(propsOf(fieldNamed(island.tree(), label("constraints.blackout.from"))[0]!).value).toBe(
      VENUE_NOON,
    );
    expect(propsOf(fieldNamed(island.tree(), label("constraints.blackout.to"))[0]!).value).toBe(
      VENUE_ONE_PM,
    );
    // What the panel used to render for the same instant.
    expect(toLocalInput(VENUE_NOON_ISO)).not.toBe(VENUE_NOON);
  });

  it("round-trips stored rows byte-for-byte through the editor", () => {
    const stored = [
      { from: VENUE_NOON_ISO, to: VENUE_ONE_PM_ISO },
      { court: "Court 2", from: "2026-09-27T20:00:00.000Z", to: "2026-09-27T21:00:00.000Z" },
    ];
    // The second row is 09:00–10:00 on Auckland's spring-forward day, so a
    // round trip that mishandles the 23-hour day loses an hour here.
    expect(draftsToBlackouts(toBlackoutDrafts(stored, ORG_TZ), ORG_TZ)).toEqual(stored);
  });

  it("refuses a plainly inverted range", () => {
    const island = renderIsland(ConstraintsPanel, panelProps({
      blackouts: [{ from: VENUE_ONE_PM_ISO, to: VENUE_NOON_ISO }],
    }));
    expect(island.text()).toContain(label("constraints.blackout.errorOrder"));
    const save = byText(island.tree(), "button", label("constraints.blackout.save"));
    expect(save === undefined || propsOf(save).disabled === true).toBe(true);
  });

  it("orders from/to by the instants they name on the VENUE clock", () => {
    // The case that separates "compare the two strings" from "compare the two
    // instants", and it needs the spring-forward gap to exist at all.
    //
    // Auckland skips 02:00–02:59 on 27 Sep 2026. Typing 02:30 there names a
    // time that does not happen, and it resolves FORWARD past the transition to
    // 03:30 NZDT — later than the 03:00 the organiser typed as the END. On the
    // venue clock the window is inverted and must be refused. Read in a zone
    // with no transition that day (London) the same two strings are an ordinary
    // 30-minute window and would be stored happily.
    const GAP_FROM = "2026-09-27T02:30";
    const GAP_TO = "2026-09-27T03:00";

    // The premise, stated directly: the verdict is zone-dependent, so this
    // cannot pass against an implementation that ignores the zone it is given.
    expect(blackoutRowError({ court: "", from: GAP_FROM, to: GAP_TO }, ORG_TZ)).toBe("order");
    expect(blackoutRowError({ court: "", from: GAP_FROM, to: GAP_TO }, "Europe/London")).toBeNull();

    // And through the form the organiser actually types into.
    const island = renderIsland(ConstraintsPanel, panelProps());
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();
    const type = (name: string, value: string) =>
      (propsOf(fieldNamed(island.tree(), label(name as keyof typeof enUi))[0]!).onChange as (v: string) => void)(
        value,
      );
    type("constraints.blackout.from", GAP_FROM);
    type("constraints.blackout.to", GAP_TO);
    expect(island.text()).toContain(label("constraints.blackout.errorOrder"));
    expect(
      propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. boardset.startAt / endAt and the play-hours expansion — settings-panel
// ---------------------------------------------------------------------------

/** 12:00 on 1 Aug at the venue; 20:00 on 3 Aug UTC is already the 4th there. */
const BOARD_CONFIG: BoardConfig = {
  startAt: VENUE_NOON_ISO,
  endAt: "2026-08-03T20:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

function settingsProps(over: Partial<BoardConfig> = {}) {
  return {
    divisionId: "d1",
    config: { ...BOARD_CONFIG, ...over },
    canEdit: true,
    constraintsAllowed: true,
    venueCap: "Court",
    orgTz: ORG_TZ,
    defaultOpen: true,
    onSaved: () => {},
    onError: (err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  };
}

describe("boardset.startAt / endAt resolve on the venue clock", () => {
  it("fills both fields from the stored instants on the venue calendar", () => {
    const island = renderIsland(SettingsPanel, settingsProps());
    expect(propsOf(fieldNamed(island.tree(), label("boardset.startAt"))[0]!).value).toBe(VENUE_NOON);
    // 2026-08-03T20:00Z is 08:00 on the FOURTH in Auckland. A browser-zone read
    // shows the third, so this pins the calendar day and not just the hour.
    expect(propsOf(fieldNamed(island.tree(), label("boardset.endAt"))[0]!).value).toBe("2026-08-04");
    expect(zonedDateInput(BOARD_CONFIG.endAt!, PROCESS_TZ)).not.toBe("2026-08-04");
  });

  it("stores what the organiser typed as venue time", async () => {
    const island = renderIsland(SettingsPanel, settingsProps());
    (propsOf(fieldNamed(island.tree(), label("boardset.startAt"))[0]!).onChange as (v: string) => void)(
      "2026-08-02T09:30",
    );
    (propsOf(fieldNamed(island.tree(), label("boardset.endAt"))[0]!).onChange as (v: string) => void)(
      "2026-08-05",
    );
    (propsOf(byText(island.tree(), "button", label("boardset.save"))!).onClick as () => void)();
    await flush();

    // 09:30 on 2 Aug at UTC+12 is 21:30 the previous day.
    expect(putBody().config.startAt).toBe("2026-08-01T21:30:00.000Z");
    // The end date stores the last minute of that day AT THE VENUE.
    expect(putBody().config.endAt).toBe("2026-08-05T11:59:00.000Z");
  });

  it("round-trips: an untouched panel saves the instants it was given", async () => {
    // The strongest shape of the whole fix — open, save, and the stored value is
    // unchanged. A read and a write that disagree about the zone would drift the
    // start by the offset on every save the organiser makes.
    const island = renderIsland(SettingsPanel, settingsProps());
    (propsOf(byText(island.tree(), "button", label("boardset.save"))!).onClick as () => void)();
    await flush();
    expect(putBody().config.startAt).toBe(VENUE_NOON_ISO);
  });
});

describe("play hours expand and prefill on the venue clock", () => {
  /** 09:00–18:00 at the venue on 1–2 Aug 2026 (NZST, UTC+12). */
  const VENUE_WINDOWS = [
    { from: "2026-07-31T21:00:00.000Z", to: "2026-08-01T06:00:00.000Z" },
    { from: "2026-08-01T21:00:00.000Z", to: "2026-08-02T06:00:00.000Z" },
  ];

  it("prefills the daily hours from stored windows on the venue clock", () => {
    const island = renderIsland(
      SettingsPanel,
      settingsProps({ sessionWindows: VENUE_WINDOWS, endAt: "2026-08-02T11:59:00.000Z" }),
    );
    expect(propsOf(fieldNamed(island.tree(), label("boardset.playFrom"))[0]!).value).toBe("09:00");
    expect(propsOf(fieldNamed(island.tree(), label("boardset.playUntil"))[0]!).value).toBe("18:00");
    // Read in this process's own zone these windows are uniform too — just at
    // completely different hours. That is what the panel used to show.
    expect(toLocalInput(VENUE_WINDOWS[0]!.from).slice(11)).not.toBe("09:00");
  });

  it("expands typed hours into one window per venue day", async () => {
    const island = renderIsland(
      SettingsPanel,
      settingsProps({ endAt: "2026-08-02T11:59:00.000Z" }),
    );
    (propsOf(fieldNamed(island.tree(), label("boardset.playFrom"))[0]!).onChange as (v: string) => void)(
      "09:00",
    );
    (propsOf(fieldNamed(island.tree(), label("boardset.playUntil"))[0]!).onChange as (v: string) => void)(
      "18:00",
    );
    (propsOf(byText(island.tree(), "button", label("boardset.save"))!).onClick as () => void)();
    await flush();
    expect(putBody().config.sessionWindows).toEqual(VENUE_WINDOWS);
  });
});

// ---------------------------------------------------------------------------
// The zone the fields speak, said out loud
// ---------------------------------------------------------------------------

describe("both panels name the zone their times are in", () => {
  const DICTS: [Locale, Dict][] = [
    ["en", enUi as Dict],
    ["es", esUi as Dict],
    ["fr", frUi as Dict],
    ["nl", nlUi as Dict],
  ];

  /** `schedule.tz.caption` already exists in all four locales (the stages panel
   *  uses it), so this surfaces the venue zone without inventing new copy. */
  const caption = (dict: Dict) => (dict["schedule.tz.caption"] as string).replace("{tz}", ORG_TZ);

  for (const [locale, dict] of DICTS) {
    it(`settings panel states the venue zone (${locale})`, () => {
      const html = renderToStaticMarkup(
        <DictProvider dict={dict} locale={locale}>
          <StandaloneScheduleSettings
            divisionId="d1"
            config={BOARD_CONFIG}
            canEdit
            constraintsAllowed
            venueCap="Court"
            orgTz={ORG_TZ}
          />
        </DictProvider>,
      );
      expect(html).toContain(caption(dict));
    });

    it(`blackout editor states the venue zone (${locale})`, () => {
      const html = renderToStaticMarkup(
        <DictProvider dict={dict} locale={locale}>
          <ConstraintsPanel
            divisionId="d1"
            initialSettings={{ division_id: "d1", config: { courts: ["Court 1"] } }}
            canEdit
            orgTz={ORG_TZ}
          />
        </DictProvider>,
      );
      expect(html).toContain(caption(dict));
    });
  }

  it("uses the existing key rather than a new English-only string", () => {
    for (const [locale, dict] of DICTS) {
      expect(dict, locale).toHaveProperty("schedule.tz.caption");
      expect(dict["schedule.tz.caption"], locale).toContain("{tz}");
    }
    for (const [locale, dict] of DICTS.slice(1)) {
      expect(dict["schedule.tz.caption"], locale).not.toBe(enUi["schedule.tz.caption"]);
    }
  });
});

describe("guards — the premise these assertions rest on", () => {
  it("runs in a process zone that disagrees with the venue zone", () => {
    expect(PROCESS_TZ).not.toBe(ORG_TZ);
    // A browser-zone implementation cannot satisfy the expectations above by
    // coincidence: the same instant reads as a different wall clock here.
    expect(zonedDateTimeInput(VENUE_NOON_ISO, PROCESS_TZ)).not.toBe(VENUE_NOON);
    expect(toLocalInput(VENUE_NOON_ISO)).toBe(zonedDateTimeInput(VENUE_NOON_ISO, PROCESS_TZ));
    // And the venue zone is far enough out that the CALENDAR DAY moves too,
    // which is what the endAt assertions turn on.
    expect(zonedDateInput(BOARD_CONFIG.endAt!, ORG_TZ)).not.toBe(
      zonedDateInput(BOARD_CONFIG.endAt!, PROCESS_TZ),
    );
  });
});
