// Capacity tests 32 and 34, the cards (spec §6.1 (2) and (3), §8.1): the check-in line card and the seat-429 wait, painted by the REAL
// check-in component in all four locales. `left` (null, "silent", "camera") reaches its own string, the warning shows only when the
// server said so, the line REPLACES the preflight actions (no button, no deadline countdown) and the seat wait shuts the button.
//
// Expected words: the spec's English for `en` (the owner-visible copy), the dictionaries' own for the other three (parity is the point:
// a copied English string repeats and is caught). A static render is the pre-mount frame; the live announcements are an effect and
// are driven in the browser (match-room.spec.ts).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { Checkin } from "../checkin";
import type { LineCardView } from "../line-card";
import { LINE_ABANDON_AFTER_MS, type LineWire, type RoomSnapshot } from "../room-snapshot";

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const NAMES = Object.keys(LOCALES) as Locale[];
const RAW_KEY = /externalPlay\.room\./;

const WIRE: LineWire = { position: 7, etaS: 30, pollMs: 3_000, closesAt: "2026-10-15T10:30:00.000Z", mayTimeOut: false, left: null };
const view = (over: Partial<LineWire> = {}, closesAt: string | null = "10:30"): LineCardView => {
  const wire = { ...WIRE, ...over };
  return { wire, closesAt, left: wire.left };
};

function Painted({ line, seatWaitS = null }: { line: LineCardView | null; seatWaitS?: number | null }) {
  const t = useT();
  const plural = usePlural();
  return (
    <Checkin
      snap={{
        you: { colour: "white", name: "Bo Lind", checkedIn: false },
        opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
        meta: { limitSeconds: 600, incrementSeconds: 5 } as RoomSnapshot["meta"],
        cameraPolicy: "off",
      }}
      closesIn="09:12"
      closesAt="10:20"
      stream={null}
      cameraOn={false}
      busy={false}
      line={line}
      seatWaitS={seatWaitS}
      onCheckIn={() => {}}
      t={t as never}
      plural={plural as never}
    />
  );
}

const paint = (locale: Locale, line: LineCardView | null, seatWaitS: number | null = null) =>
  renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <Painted line={line} seatWaitS={seatWaitS} />
    </DictProvider>,
  );
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const dictOf = (l: Locale) => LOCALES[l] as Record<string, string>;
const testid = (html: string, id: string) => new RegExp(`data-testid="${id}"`).test(html);

describe("the line card says why the player is at the back again: `left` reaches its own string (test 32)", () => {
  it("English is the spec's copy for each of the three values", () => {
    const silent = words(paint("en", view({ left: "silent" })));
    const camera = words(paint("en", view({ left: "camera" })));
    expect(silent).toContain("You left the line, so you are at the back again.");
    expect(silent).not.toContain("Your camera did not start in time");
    expect(camera).toContain("Your camera did not start in time, so you are at the back again.");
    expect(camera).not.toContain("You left the line");
    expect(testid(paint("en", view({ left: null })), "room-line-left"), "null: no explanation at all").toBe(false);
  });

  it("every locale: null shows no notice, `silent` and `camera` each their own translated string, no raw key (12 renders counted)", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const locale of NAMES) {
      const d = dictOf(locale);
      const none = paint(locale, view({ left: null }));
      const silent = paint(locale, view({ left: "silent" }));
      const camera = paint(locale, view({ left: "camera" }));
      expect(testid(none, "room-line-left"), `${locale}: null shows nothing`).toBe(false);
      expect(silent, `${locale}: silent`).toContain('data-left="silent"');
      expect(camera, `${locale}: camera`).toContain('data-left="camera"');
      expect(words(silent), `${locale}: silent words`).toContain(d["externalPlay.room.state.line.left"]);
      expect(words(camera), `${locale}: camera words`).toContain(d["externalPlay.room.state.line.leftCamera"]);
      expect(words(silent), `${locale}: silent is not the camera string`).not.toContain(d["externalPlay.room.state.line.leftCamera"]);
      expect(words(camera), `${locale}: camera is not the silent string`).not.toContain(d["externalPlay.room.state.line.left"]);
      for (const html of [none, silent, camera]) expect(html, `${locale}: no raw key`).not.toMatch(RAW_KEY);
      seen.add(d["externalPlay.room.state.line.left"]!);
      seen.add(d["externalPlay.room.state.line.leftCamera"]!);
      checked += 3;
    }
    expect(checked, "renders checked").toBe(12);
    expect(seen.size, "eight different strings: nothing is a copy of another locale's or of its sibling").toBe(8);
  });
});

describe("the line card in four locales: the place, the estimate, the instruction, when check-in closes", () => {
  it("English: the spec's words; the position names the number, the estimate rounds up, the instruction names the abandon seconds", () => {
    const html = paint("en", view());
    const w = words(html);
    expect(w).toContain("You are number 7 in line");
    expect(w).toContain("About 30 seconds");
    expect(w).toContain(`Keep this page open: if you leave it for more than ${LINE_ABANDON_AFTER_MS / 1_000} seconds you go to the back of the line.`);
    expect(w).toContain("Your board's check-in closes at 10:30.");
    expect(html).toContain('data-position="7"');
  });

  it("every locale: title with the number, an estimate with its unit, the body with the abandon seconds, the close time; no raw key", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const d = dictOf(locale);
      const w = words(paint(locale, view({ position: 12, etaS: 30 })));
      expect(w, `${locale}: title`).toContain(d["externalPlay.room.state.line.title"]!.replace("{position}", "12"));
      expect(w, `${locale}: estimate`).toContain(d["externalPlay.room.state.line.eta.seconds.other"]!.replace("{count}", "30"));
      expect(w, `${locale}: body`).toContain(d["externalPlay.room.state.line.body"]!.replace("{seconds}", String(LINE_ABANDON_AFTER_MS / 1_000)));
      expect(w, `${locale}: closes`).toContain(d["externalPlay.room.state.line.closes"]!.replace("{time}", "10:30"));
      expect(w, `${locale}: no raw key`).not.toMatch(RAW_KEY);
      checked += 1;
    }
    expect(checked, "locales checked").toBe(4);
  });

  it("the estimate in minutes above 90 s, in every locale; singular and plural each their own string", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const d = dictOf(locale);
      expect(words(paint(locale, view({ etaS: 91 }))), `${locale}: 91 s is two minutes`).toContain(d["externalPlay.room.state.line.eta.minutes.other"]!.replace("{count}", "2"));
      expect(words(paint(locale, view({ etaS: 60 }))), `${locale}: 60 s is still seconds`).toContain(d["externalPlay.room.state.line.eta.seconds.other"]!.replace("{count}", "60"));
      checked += 2;
    }
    expect(checked).toBe(8);
  });

  it("before mount the close time is absent (a time of day is never server-rendered), and no stray {time} placeholder", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const html = paint(locale, view({}, null));
      expect(testid(html, "room-line-closes"), locale).toBe(false);
      expect(html, locale).not.toContain("{time}");
      expect(testid(html, "room-line-position"), `${locale}: the place is still shown`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("the warning shows exactly when the server said so (the wire's `mayTimeOut`)", () => {
  it("true: the amber notice in every locale; false: none (both sides, 8 renders)", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const d = dictOf(locale);
      const warned = paint(locale, view({ mayTimeOut: true }));
      const calm = paint(locale, view({ mayTimeOut: false }));
      expect(testid(warned, "room-line-may-time-out"), `${locale}: warned`).toBe(true);
      expect(words(warned), `${locale}: warned words`).toContain(d["externalPlay.room.state.line.mayTimeOut"]);
      expect(testid(calm, "room-line-may-time-out"), `${locale}: calm`).toBe(false);
      expect(words(calm), `${locale}: calm has no warning words`).not.toContain(d["externalPlay.room.state.line.mayTimeOut"]);
      // The screen-reader region exists in both and says nothing before the first warning has been spoken (the effect).
      expect(testid(calm, "room-line-announce"), `${locale}: the live region is always there`).toBe(true);
      checked += 2;
    }
    expect(checked, "renders checked").toBe(8);
  });
});

describe("the line REPLACES the preflight actions; the card around it stays", () => {
  it("with a line: no Check in button, no deadline countdown, no seat-wait note; the opponent row and the heading remain", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const html = paint(locale, view());
      expect(testid(html, "room-line"), `${locale}: the line`).toBe(true);
      expect(testid(html, "room-checkin-cta"), `${locale}: no button`).toBe(false);
      expect(testid(html, "room-checkin-countdown"), `${locale}: no deadline countdown`).toBe(false);
      expect(testid(html, "room-seat-wait"), `${locale}: no seat-wait note`).toBe(false);
      expect(testid(html, "room-checkin-opponent"), `${locale}: the opponent row stays`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("the positive pair - without a line the button and the countdown are there and no line is: nothing is hidden for good", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const html = paint(locale, null);
      expect(testid(html, "room-line"), `${locale}: no line`).toBe(false);
      expect(testid(html, "room-checkin-cta"), `${locale}: the button`).toBe(true);
      expect(testid(html, "room-checkin-countdown"), `${locale}: the countdown`).toBe(true);
      expect(html, `${locale}: the button is pressable`).not.toMatch(/<button[^>]*data-testid="room-checkin-cta"[^>]*\sdisabled=""|disabled=""[^>]*data-testid="room-checkin-cta"/);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("the seat 429 wait: the button is shut and says why, in every locale (test 34's strings)", () => {
  const shut = (html: string) => /<button[^>]*data-testid="room-checkin-cta"/.test(html) && /disabled=""/.test(/<button[^>]*data-testid="room-checkin-cta"[^>]*>/.exec(html)?.[0] ?? html.match(/<button[^>]*>/)?.[0] ?? "");

  it("waiting: the button is disabled, the note carries the title and the seconds; not waiting: the button is pressable and there is no note (8 renders)", () => {
    let checked = 0;
    for (const locale of NAMES) {
      const d = dictOf(locale);
      const waiting = paint(locale, null, 23);
      const free = paint(locale, null, null);
      expect(shut(waiting), `${locale}: waiting shuts the button`).toBe(true);
      expect(shut(free), `${locale}: free leaves it open`).toBe(false);
      expect(waiting, `${locale}: waiting`).toContain('data-waiting="true"');
      expect(free, `${locale}: free`).toContain('data-waiting="false"');
      expect(words(waiting), `${locale}: title`).toContain(d["externalPlay.room.state.seatWait.title"]);
      expect(words(waiting), `${locale}: countdown`).toContain(d["externalPlay.room.state.seatWait.countdown"]!.replace("{seconds}", "23"));
      expect(testid(free, "room-seat-wait-countdown"), `${locale}: no countdown when free`).toBe(false);
      expect(waiting, `${locale}: no raw key`).not.toMatch(RAW_KEY);
      checked += 2;
    }
    expect(checked, "renders checked").toBe(8);
  });

  it("English is the spec's words, and the three other locales translate all three strings (12 strings, none equal to English)", () => {
    expect(words(paint("en", null, 23))).toContain("Too many tries in a row");
    expect(words(paint("en", null, 23))).toContain("Try again in 23 s");
    expect(en["externalPlay.room.state.seatWait.ready"]).toBe("You can try again now.");
    let checked = 0;
    for (const locale of ["es", "fr", "nl"] as const) {
      for (const k of ["title", "countdown", "ready"] as const) {
        const key = `externalPlay.room.state.seatWait.${k}`;
        expect(dictOf(locale)[key], `${locale}.${k}`).toBeTruthy();
        expect(dictOf(locale)[key], `${locale}.${k}: translated`).not.toBe((en as Record<string, string>)[key]);
        checked += 1;
      }
    }
    expect(checked).toBe(9);
  });

  it("a countdown that has reached its end (null) is no wait: the note is quiet and the button is back", () => {
    for (const locale of NAMES) {
      const html = paint(locale, null, null);
      expect(testid(html, "room-seat-wait-countdown"), locale).toBe(false);
      expect(shut(html), locale).toBe(false);
    }
  });

  it("while the line shows, a wait number changes nothing the card paints: a 429 never pauses the line (test 31, the card half)", () => {
    for (const locale of NAMES) {
      expect(paint(locale, view(), 23), locale).toBe(paint(locale, view(), null));
    }
  });
});
