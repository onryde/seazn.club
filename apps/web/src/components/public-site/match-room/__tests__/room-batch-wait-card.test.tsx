// Capacity test 11, the card (spec §6.1 (1), §8.1): the batch wait paints "Your check-in opens at HH:MM" in the viewer's zone
// and locale, rounded UP to the minute, in all four locales - and a round that was never opened still paints its own card.
//
// Expected words are the spec's (English) and the dictionaries' own (the other three: parity is the point); the rounding cases
// are written from the rule "never name a minute before the door opens" (spec §6.1 (1)), not read back from the component.
// A static render is the pre-mount frame (no time of day is ever server-rendered); the mounted time is match-room.spec.ts's.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { BatchWaitCard } from "../room-cards";
import { Screen } from "../room-shell";
import { initialRoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import { formatPromisedTime, formatTimeOfDay } from "../room-time";
import type { RoomSnapshot } from "../room-snapshot";

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const RAW_KEY = /externalPlay\.room\./;

describe("formatPromisedTime: the minute the page names is never before the door", () => {
  it("rounds UP to the next minute and leaves an instant already on a minute alone (UTC)", () => {
    const CASES: [string, string][] = [
      ["2026-10-01T12:00:00.000Z", "12:00"], // on the minute: not moved
      ["2026-10-01T12:00:00.001Z", "12:01"], // a millisecond past: the next minute
      ["2026-10-01T12:00:20.000Z", "12:01"], // would be 12:00 under round-to-nearest
      ["2026-10-01T12:00:40.000Z", "12:01"],
      ["2026-10-01T12:59:30.000Z", "13:00"], // across the hour
      ["2026-10-01T23:59:01.000Z", "00:00"], // across midnight, a 24-hour clock
    ];
    for (const [iso, want] of CASES) expect(formatPromisedTime(iso, "en", "UTC"), iso).toBe(want);
    expect(CASES.length, "cases checked").toBe(6);
  });

  it("is the VIEWER's zone: the same instant reads differently in New York and Kolkata (a half-hour zone), and never before the door in either", () => {
    const iso = "2026-10-01T12:00:20.000Z";
    const seen = new Map<string, string>();
    for (const [zone, want] of [["UTC", "12:01"], ["America/New_York", "08:01"], ["Asia/Kolkata", "17:31"]] as const) {
      seen.set(zone, formatPromisedTime(iso, "en", zone));
      expect(seen.get(zone), zone).toBe(want);
    }
    expect(new Set(seen.values()).size, "three zones, three different faces").toBe(3);
    // The unrounded face of the same instant, to show the rounding is the only difference.
    expect(formatTimeOfDay(iso, "en", "UTC")).toBe("12:00");
  });

  it("with no zone named it is the process's own (the page never names one: the viewer's browser zone applies)", () => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const iso = "2026-10-01T12:00:20.000Z";
    expect(formatPromisedTime(iso, "en")).toBe(formatPromisedTime(iso, "en", own));
  });
});

describe("BatchWaitCard in the four locales", () => {
  const render = (locale: Locale, time: string | null) =>
    renderToStaticMarkup(
      <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
        <Card time={time} />
      </DictProvider>,
    );
  function Card({ time }: { time: string | null }) {
    const t = useT();
    return <BatchWaitCard time={time} t={t as never} />;
  }
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

  it("English is the spec's copy: title, the body naming the time, and the time on its own line", () => {
    const html = render("en", "14:10");
    const words = text(html);
    expect(words).toContain("Your check-in opens soon");
    expect(words).toContain("Your board is in a later group so that everyone can check in without queueing.");
    expect(words).toContain("Keep this page open: it will let you in at 14:10.");
    expect(html).toContain('data-testid="room-state-batch-wait"');
    expect(html).toMatch(/data-testid="room-batch-wait-time"[^>]*>[^<]*14:10/);
  });

  it("every locale names the time in the body and the time line, shows no raw key, and none of the not-opened copy", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = LOCALES[locale] as Record<string, string>;
      const html = render(locale, "14:10");
      const words = text(html);
      expect(words, `${locale}: title`).toContain(d["externalPlay.room.state.batchWait.title"]);
      expect(words, `${locale}: body with the time`).toContain(d["externalPlay.room.state.batchWait.body"]!.replace("{time}", "14:10"));
      expect(words, `${locale}: time line`).toContain(d["externalPlay.room.state.batchWait.time"]!.replace("{time}", "14:10"));
      expect(html, `${locale}: no raw key`).not.toMatch(RAW_KEY);
      expect(words, `${locale}: not the not-opened title`).not.toContain(d["externalPlay.room.state.notOpened.title"]);
      expect(d["externalPlay.room.state.batchWait.body"], `${locale}: the body takes a {time}`).toContain("{time}");
      checked += 1;
    }
    expect(checked, "locales checked").toBe(4);
    // The four titles are four different words (a copied English string would repeat).
    const titles = new Set((Object.keys(LOCALES) as Locale[]).map((l) => (LOCALES[l] as Record<string, string>)["externalPlay.room.state.batchWait.title"]));
    expect(titles.size).toBe(4);
  });

  it("before mount the card carries no time of day at all (never server-rendered), and no stray {time} placeholder", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = render(locale, null);
      expect(html, locale).not.toContain("room-batch-wait-time");
      expect(html, locale).not.toContain("{time}");
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("the screen: a stamped round whose batch has not opened is the batch wait; an unopened round is not", () => {
  function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
    return {
      fixtureId: "f1",
      serverNow: new Date(T0).toISOString(),
      phase: "before",
      scheduledAt: null,
      roundOpenedAt: new Date(T0 - 60_000).toISOString(),
      opensAt: new Date(T0 + 120_000).toISOString(),
      deadline: new Date(T0 + 120_000 + 10 * 60_000).toISOString(),
      links: { fixture: "/fx", standings: "/st" },
      meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 21, limitSeconds: 300, incrementSeconds: 5 },
      orgSlug: "org",
      you: { colour: "white", name: "Bo Lind", checkedIn: false },
      opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
      cameraPolicy: "required",
      opponentCamera: null,
      ownParticipantId: null,
      frozen: null,
      canAct: false,
      otherAccount: null,
      onlineChessOff: false,
      boardClosed: false,
      creation: null,
      game: null,
      held: false,
      result: null,
      watchUrl: null,
      realtime: null,
      ...over,
    };
  }
  function Painted({ s }: { s: RoomSnapshot }) {
    const t = useT();
    const plural = usePlural();
    const noop = async () => null;
    const state = initialRoomState(s, T0);
    return (
      <Screen
        screen={roomScreen(state)}
        state={state}
        room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
        camera={{ status: "idle", stream: null, enable: () => {} }}
        presence={null}
        busy={false}
        tryAgain={() => {}}
        relinkHref="/link"
        locale="en"
        t={t as never}
        plural={plural as never}
        reload={() => {}}
      />
    );
  }
  const paint = (locale: Locale, s: RoomSnapshot) =>
    renderToStaticMarkup(
      <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
        <Painted s={s} />
      </DictProvider>,
    );

  it("phase before with a stamp paints the batch-wait card in every locale, and the not-opened card is absent", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const s = snap();
      expect(roomScreen(initialRoomState(s, T0)).kind).toBe("batchWait");
      const html = paint(locale, s);
      expect(html, `${locale}: batch wait`).toContain('data-testid="room-state-batch-wait"');
      expect(html, `${locale}: not the not-opened card`).not.toContain('data-testid="room-state-not-opened"');
      expect(html, `${locale}: no raw key`).not.toMatch(RAW_KEY);
      checked += 1;
    }
    expect(checked, "locales checked").toBe(4);
  });

  it("the pair: a round that was never opened (phase not_opened) paints the not-opened card and not the batch wait", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const s = snap({ phase: "not_opened", roundOpenedAt: null, opensAt: null, deadline: null });
      expect(roomScreen(initialRoomState(s, T0)).kind).toBe("notOpened");
      const html = paint(locale, s);
      expect(html, `${locale}: not-opened`).toContain('data-testid="room-state-not-opened"');
      expect(html, `${locale}: not the batch wait`).not.toContain('data-testid="room-state-batch-wait"');
      checked += 1;
    }
    expect(checked, "locales checked").toBe(4);
  });
});
