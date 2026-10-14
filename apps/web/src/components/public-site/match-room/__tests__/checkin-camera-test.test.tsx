// T17B fix 2, D15: the check-in's camera test, as the player sees it. Under "required" Check in waits for a tested,
// frame-producing camera; each refusal says what to do in the player's language and offers Test again; pressing
// Check in releases the test camera BEFORE the seat is asked for (controller ruling (c): the SDK then takes the camera
// as it always has). Under "optional" and "off" the check-in is today's, unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { Checkin } from "../checkin";
import { cameraTest, type CameraTestView } from "../camera-test";
import type { RoomSnapshot } from "../room-snapshot";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8"))]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
}
const fakeStream = (track = new FakeTrack()) =>
  ({ getTracks: () => [track], getVideoTracks: () => [track], track }) as unknown as MediaStream & { track: FakeTrack };

const FAILURES = ["denied", "notFound", "inUse", "other", "ended"] as const;
const FAILURE_KEY = {
  denied: "externalPlay.room.checkin.test.denied",
  notFound: "externalPlay.room.checkin.test.notFound",
  inUse: "externalPlay.room.checkin.test.inUse",
  other: "externalPlay.room.checkin.test.other",
  ended: "externalPlay.room.checkin.test.ended",
} as const;

type Policy = RoomSnapshot["cameraPolicy"];
function props(locale: (typeof LOCALES)[number], policy: Policy, view: CameraTestView | null, onCheckIn = () => {}) {
  const d = DICTS[locale];
  const t = (key: string, vars?: Record<string, string | number>) =>
    (d[key] ?? key).replace(/\{(\w+)\}/g, (m, v: string) => (vars && v in vars ? String(vars[v]) : m));
  return {
    snap: {
      you: { colour: "white", name: "Bo Lind", checkedIn: false },
      opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
      meta: { limitSeconds: 600, incrementSeconds: 5 } as RoomSnapshot["meta"],
      cameraPolicy: policy,
    } as Parameters<typeof Checkin>[0]["snap"],
    closesIn: "18:42",
    closesAt: "19:20",
    stream: null,
    cameraOn: false,
    busy: false,
    onCheckIn,
    cameraTest: view === null ? null : { view, onTest: () => {}, onFrame: () => {}, onHandOver: () => {} },
    t: t as never,
    plural: ((k: string) => k) as never,
  };
}
const paint = (...a: Parameters<typeof props>) => decode(renderToStaticMarkup(<Checkin {...props(...a)} />));
const ctaDisabled = (html: string) => {
  const tag = /<button[^>]*data-testid="room-checkin-cta"[^>]*>/.exec(html)?.[0];
  expect(tag, "premise: the Check in button was painted").toBeDefined();
  return /\sdisabled=""/.test(tag!);
};

const s = fakeStream();
const VIEWS: [string, CameraTestView, boolean][] = [
  ["idle", { status: "idle", stream: null, failure: null }, true],
  ["asking", { status: "testing", stream: null, failure: null }, true],
  ["showing, no frame yet", { status: "testing", stream: s, failure: null }, true],
  ["live", { status: "live", stream: s, failure: null }, false],
  ...FAILURES.map((f): [string, CameraTestView, boolean] => [`failed ${f}`, { status: "failed", stream: null, failure: f }, true]),
  ["handed (Check in pressed, retried)", { status: "handed", stream: null, failure: null }, false],
];

describe("the check-in's camera test (D15) — camera required", () => {
  it("Check in waits before the test, while testing, after every failure; opens for a live, frame-proven camera (counted)", () => {
    let checked = 0;
    for (const [name, view, disabled] of VIEWS) {
      expect(ctaDisabled(paint("en", "required", view)), name).toBe(disabled);
      checked += 1;
    }
    expect(checked).toBe(5 + FAILURES.length);
    expect(ctaDisabled(paint("en", "required", null)), "required with no test wired: a guard, closed").toBe(true);
  });

  it("a 'live' view whose track has ended underneath is not a camera: Check in waits", () => {
    const dead = fakeStream();
    dead.track.readyState = "ended";
    expect(ctaDisabled(paint("en", "required", { status: "live", stream: dead, failure: null }))).toBe(true);
  });

  it("each failure says what to do, in its own words in every locale, with Test again (counted)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const seen = new Set<string>();
      for (const f of FAILURES) {
        const html = paint(l, "required", { status: "failed", stream: null, failure: f });
        const copy = DICTS[l][FAILURE_KEY[f]];
        expect(typeof copy === "string" && copy.length > 0, `${l} ${f}`).toBe(true);
        expect(html, `${l} ${f}`).toContain(`data-failure="${f}"`);
        expect(html, `${l} ${f}`).toContain(copy);
        expect(html, `${l} ${f}: Test again`).toMatch(
          new RegExp(`data-testid="room-checkin-test-cta"[^>]*>${DICTS[l]["externalPlay.room.checkin.test.again"]}<`),
        );
        seen.add(copy!);
        if (l !== "en") expect(copy, `${l} ${f}: translated`).not.toBe(DICTS.en[FAILURE_KEY[f]]);
        checked += 1;
      }
      expect(seen.size, `${l}: five failures, five sentences`).toBe(FAILURES.length);
    }
    expect(checked).toBe(LOCALES.length * FAILURES.length);
    // The brief's English, typed from it.
    expect(DICTS.en[FAILURE_KEY.denied]).toBe("Allow the camera in your browser's address bar, then try again");
    expect(DICTS.en[FAILURE_KEY.notFound]).toBe("No camera found — connect one or use another device");
    expect(DICTS.en[FAILURE_KEY.inUse]).toBe("Your camera is in use by another app or tab");
  });

  it("before the test: Test camera and the reason Check in waits; testing: the button waits; live and handed: no test button", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const idle = paint(l, "required", VIEWS[0]![1]);
      expect(idle).toMatch(new RegExp(`data-testid="room-checkin-test-cta"[^>]*>${DICTS[l]["externalPlay.room.checkin.test.cta"]}<`));
      expect(idle).toContain(DICTS[l]["externalPlay.room.checkin.test.needed"]);
      const asking = paint(l, "required", VIEWS[1]![1]);
      const tag = /<button[^>]*data-testid="room-checkin-test-cta"[^>]*>[^<]*</.exec(asking)?.[0] ?? "";
      expect(tag, `${l}: the test button waits while asking`).toMatch(/\sdisabled=""/);
      expect(tag).toContain(DICTS[l]["externalPlay.room.checkin.test.starting"]);
      for (const v of [VIEWS[3]![1], VIEWS.at(-1)![1]]) {
        expect(paint(l, "required", v), `${l} ${v.status}`).not.toContain('data-testid="room-checkin-test-cta"');
      }
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the test camera is what the preview shows; 'Camera on' only once it is proven", () => {
    expect(paint("en", "required", VIEWS[0]![1])).toContain('data-stream="off"');
    expect(paint("en", "required", VIEWS[2]![1])).toContain('data-stream="on"');
    expect(paint("en", "required", VIEWS[2]![1])).not.toContain(DICTS.en["externalPlay.room.checkin.cameraOn"]);
    expect(paint("en", "required", VIEWS[3]![1])).toContain(DICTS.en["externalPlay.room.checkin.cameraOn"]);
  });

  it("Check in releases the test camera BEFORE the seat is asked for (the ruling's order) — a real session, the real button", async () => {
    const stream = fakeStream();
    let view: CameraTestView = { status: "idle", stream: null, failure: null };
    const session = cameraTest(async () => stream, (v) => (view = v));
    await session.start();
    session.frame(stream);
    expect(view.status, "premise: a proven camera").toBe("live");
    const atJoin: string[] = [];
    const onCheckIn = vi.fn(() => atJoin.push(stream.track.readyState));
    const p = props("en", "required", view, onCheckIn);
    const tree = Checkin({ ...p, cameraTest: { view, onTest: () => {}, onFrame: () => {}, onHandOver: session.handOver } });
    const buttons = walk(tree).filter((el: ReactElement) => propsOf(el)["data-testid"] === "room-checkin-cta");
    expect(new Set(buttons).size, "one Check in").toBe(1);
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onCheckIn).toHaveBeenCalledTimes(1);
    expect(atJoin, "the test track had ended when the seat was asked for").toEqual(["ended"]);
    expect(view.status).toBe("handed");
  });
});

describe("the check-in under 'optional' and 'off' — today's, unchanged (the empty case)", () => {
  it("no camera test, and Check in is pressable at once (counted)", () => {
    let checked = 0;
    for (const policy of ["optional", "off"] as const) {
      for (const l of LOCALES) {
        const html = paint(l, policy, null);
        expect(html, `${policy} ${l}`).not.toContain('data-testid="room-checkin-test');
        expect(ctaDisabled(html), `${policy} ${l}`).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(2 * LOCALES.length);
  });
});
