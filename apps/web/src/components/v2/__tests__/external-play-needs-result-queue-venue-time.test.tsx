// Owner ruling 2026-10-25 (follow-up to the Arbiter Panel's D1, PR #1016): the Fixtures tab's online "needs result" queue reads every
// time of day in the VENUE's zone, as the panel does, and says whose clock it is ("15:36 (Tokyo time)") only after mount and only
// when the viewer's own zone sits at another UTC offset at that instant.
//
// Driven through the real queue, the real `useFmt` and the real flag cards: the hook harness renders the island so its mount effect
// runs (the queue paints no time of day until it has mounted), with function components that take no hooks expanded so the flag
// cards' text is in the tree. Only the viewer's browser zone is replaced (the hook reads `Intl` after mount and answers `null` on a
// server render), as the panel's D1 suite does. Every expected clock face is read from Intl at test time and every sentence out of
// the English dictionary, never typed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

/** The viewer's browser zone: the real hook answers `null` on a server render and the browser's zone after mount. */
const viewer = vi.hoisted(() => ({ zone: null as string | null }));
vi.mock("@/lib/use-client-snapshot", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/use-client-snapshot")>()), useBrowserZone: () => viewer.zone }));

const EN_UI: Dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
const en = EN_UI as unknown as Record<string, string>;
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(dict, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(dict, key, count, "en", vars),
    useLocale: () => "en",
  };
});

import { useFmt, type Fmt } from "../arbiter-flag-cards";
import { ExternalPlayNeedsResultQueue, type ExternalPlayQueueProps } from "../external-play-needs-result-queue";

// Instants on 2026-10-24 (New York is still on daylight time until 2026-11-01).
const FOUND_AT = "2026-10-24T06:36:00.000Z";
const WINDOW_FROM = "2026-10-24T06:18:00.000Z";
const WINDOW_SECONDS = 21 * 60;
const CAM_FROM = "2026-10-24T06:31:05.000Z";
const CAM_TO = "2026-10-24T06:34:14.000Z";
const DEV_FROM = "2026-10-24T06:50:10.000Z";
const DEV_TO = "2026-10-24T06:52:40.000Z";
const WINDOW_TO = new Date(Date.parse(WINDOW_FROM) + WINDOW_SECONDS * 1000).toISOString();
const TIMED_INSTANTS = [FOUND_AT, WINDOW_FROM, WINDOW_TO, CAM_FROM, CAM_TO, DEV_FROM, DEV_TO] as const;

/** A clock face read from Intl at test time (never typed): "15:36" or, with seconds, "15:31:05". */
const face = (iso: string, tz: string, seconds = false) =>
  new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23", timeZone: tz }).format(new Date(iso));
/** The same face with the venue's name, as the dictionary words it. */
const labelled = (time: string, city: string) => en["arbiter.venueTime"]!.replace("{time}", time).replace("{city}", city);
const fill = (key: string, vars: Record<string, string>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), en[key]!);

/** The zone this test process formats in when handed none: what an unzoned `Intl` call (the bug) would print. */
const RUNTIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

// The venue and the viewer are CHOSEN against the zone this process runs in (a developer's machine can be in Tokyo, CI is UTC): a venue is
// usable only when it reads a different clock face from the runtime's for EVERY instant below, or a clock that wrongly formats in the
// runtime zone would print the venue's own face and pass. The city is typed from the zone's IANA id, as the e2e does; `sameClock` is a
// zone at the venue's UTC offset on these dates.
type VenueChoice = { tz: string; city: string; sameClock: string };
const VENUE_CANDIDATES: readonly VenueChoice[] = [
  { tz: "Asia/Tokyo", city: "Tokyo", sameClock: "Asia/Seoul" },
  { tz: "Pacific/Auckland", city: "Auckland", sameClock: "Antarctica/McMurdo" },
  { tz: "Asia/Kolkata", city: "Kolkata", sameClock: "Asia/Colombo" },
];
const VIEWER_CANDIDATES = ["America/New_York", "Europe/Berlin", "America/Los_Angeles"] as const;

/** Whether two zones read a different face (to the second) for every timed instant. */
const alwaysDiffer = (a: string, b: string) => TIMED_INSTANTS.every((iso) => face(iso, a, true) !== face(iso, b, true));

function pickZones(
  runtimeZone: string,
  venues: readonly VenueChoice[] = VENUE_CANDIDATES,
  viewers: readonly string[] = VIEWER_CANDIDATES,
): VenueChoice & { viewer: string } {
  const venue = venues.find((v) => alwaysDiffer(v.tz, runtimeZone));
  if (!venue) throw new Error(`no candidate venue reads a different clock from this process's zone (${runtimeZone})`);
  const viewer = viewers.find((z) => alwaysDiffer(z, venue.tz));
  if (!viewer) throw new Error(`no candidate viewer zone reads a different clock from the venue ${venue.tz}`);
  return { ...venue, viewer };
}
const { tz: VENUE, city: VENUE_CITY, sameClock: SAME_CLOCK, viewer: VIEWER } = pickZones(RUNTIME_ZONE);

function flaggedBoard(): FlaggedBoard {
  return {
    fixtureId: "fx-1",
    fixtureNo: 12,
    boardNo: 3,
    white: { name: "Jonah Mbeki", personId: "p-w" },
    black: { name: "Elif Demirtas", personId: "p-b" },
    state: { kind: "live" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    canResync: true,
    playable: true,
    canSettle: true,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    flags: [
      { id: "fl-oob", kind: "out_of_band_play", at: FOUND_AT, plies: { from: 51, to: 53 } },
      {
        id: "fl-cam",
        kind: "camera_lost",
        at: "2026-10-24T06:36:00.000Z",
        personName: "Priya Raghunathan",
        windowFrom: WINDOW_FROM,
        report: { offSeconds: 189, windowSeconds: WINDOW_SECONDS, intervals: [{ from: CAM_FROM, to: CAM_TO, confirmedByEvents: true }], connections: 2, sessions: 1 },
      },
      {
        id: "fl-dev",
        kind: "multiple_devices",
        at: "2026-10-24T06:52:40.000Z",
        personName: "Priya Raghunathan",
        report: { devices: 2, seconds: 150, intervals: [{ from: DEV_FROM, to: DEV_TO }] },
      },
    ],
    roundNo: 3,
    stageName: "Open Swiss",
  } as FlaggedBoard;
}

function props(venueTz: string): ExternalPlayQueueProps {
  return { held: [], flagged: [flaggedBoard()], ownFlagged: 0, venueTz };
}

/** Every host element of the tree, with the components that take no hooks (`Names`, `FlagCard`, the camera and devices cards)
 *  called in place so their text is part of it. */
function expandPure(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expandPure(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (typeof node.type === "function") return expandPure((node.type as (p: unknown) => ReactNode)(node.props), out);
  out.push(node);
  return expandPure((node.props as { children?: ReactNode }).children, out);
}

/** The strings a person reads: each element's own text children, joined. A sentence made by the dictionary is one string. */
function readText(tree: ReactElement[]): string {
  return tree
    .map((el) => {
      const c = (el.props as { children?: ReactNode }).children;
      return (Array.isArray(c) ? c : [c]).filter((x): x is string | number => typeof x === "string" || typeof x === "number").join("");
    })
    .join(" | ");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The queue after it has mounted: the nowMs effect has run and the browser's zone has been read. */
async function mountedText(p: ExternalPlayQueueProps): Promise<string> {
  const ui = renderIsland(ExternalPlayNeedsResultQueue, p, expandPure);
  await flush();
  const text = readText(ui.tree());
  ui.unmount();
  // Anti-vacuity: the mount effect ran and the flag cards paint a time at all, so an absent venue name below is a verdict and not an
  // unmounted island.
  expect(text, "premise: the queue has mounted and paints its times").toMatch(new RegExp(`${en["arbiter.flag.foundAt"]!.replace("{time}", "\\d{2}:\\d{2}")}`));
  return text;
}

/** Every sentence of the flagged card that carries a time, in the venue's zone, for a viewer in `viewerCity`'s clock or none. */
function sentences(venue: string, city: string | null) {
  const at = (iso: string, seconds = false) => {
    const t = face(iso, venue, seconds);
    return city === null ? t : labelled(t, city);
  };
  return {
    found: fill("arbiter.flag.foundAt", { time: at(FOUND_AT) }),
    cameraSpan: fill("arbiter.flag.cameraOff.span", { from: at(CAM_FROM, true), to: at(CAM_TO, true) }),
    start: fill("arbiter.flag.timeline.start", { time: at(WINDOW_FROM) }),
    end: fill("arbiter.flag.timeline.end", { time: at(WINDOW_TO) }),
    devicesSpan: fill("arbiter.flag.cameraOff.span", { from: at(DEV_FROM, true), to: at(DEV_TO, true) }),
  };
}

describe("the queue's premises (a test that cannot tell the zones apart proves nothing)", () => {
  it("the venue reads a different face from the viewer, from UTC and from this process's zone for every instant - whatever zone this runs in", () => {
    let checked = 0;
    for (const iso of TIMED_INSTANTS) {
      // The process zone may BE the viewer's or UTC (CI): it must only differ from the venue's, which is what the choice guarantees.
      expect(face(iso, VENUE, true), `${iso}: venue ${VENUE} vs process ${RUNTIME_ZONE}`).not.toBe(face(iso, RUNTIME_ZONE, true));
      expect(face(iso, VENUE, true), `${iso}: venue ${VENUE} vs viewer ${VIEWER}`).not.toBe(face(iso, VIEWER, true));
      expect(face(iso, VENUE, true), `${iso}: venue ${VENUE} vs UTC`).not.toBe(face(iso, "UTC", true));
      checked++;
    }
    expect(checked).toBe(TIMED_INSTANTS.length);
  });

  it("the choice is machine-independent: for a process in any of these zones a venue and a viewer are found, and neither reads the process's clock - counted", () => {
    // Includes the zones a developer's machine or CI runs in, and each candidate itself (the case that used to red this suite).
    const runtimes = ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Auckland", "Asia/Kolkata", "Europe/Berlin", "America/Los_Angeles", "Europe/London", "Asia/Seoul"];
    let checked = 0;
    for (const runtime of runtimes) {
      const pick = pickZones(runtime);
      expect(alwaysDiffer(pick.tz, runtime), `${runtime}: venue ${pick.tz}`).toBe(true);
      expect(alwaysDiffer(pick.viewer, pick.tz), `${runtime}: viewer ${pick.viewer} vs venue ${pick.tz}`).toBe(true);
      expect(alwaysDiffer(pick.sameClock, pick.tz), `${runtime}: the same-clock zone ${pick.sameClock} reads the venue's face`).toBe(false);
      checked++;
    }
    expect(checked).toBe(runtimes.length);
    // The refusals are reachable: nothing to choose from is an error, not a silent default.
    expect(() => pickZones("Asia/Tokyo", [{ tz: "Asia/Tokyo", city: "Tokyo", sameClock: "Asia/Seoul" }])).toThrow(/no candidate venue/);
    expect(() => pickZones("UTC", VENUE_CANDIDATES, ["Asia/Tokyo"])).toThrow(/no candidate viewer zone/);
  });
});

describe("the online queue's clock is the venue's (owner ruling 2026-10-25)", () => {
  it("viewer elsewhere than the venue: every time on the flag cards is the venue's face, named once - counted", async () => {
    viewer.zone = VIEWER;
    const text = await mountedText(props(VENUE));
    const want = sentences(VENUE, VENUE_CITY);
    let checked = 0;
    for (const [name, sentence] of Object.entries(want)) {
      expect(text, `${name}: the venue's face, with the venue's name`).toContain(sentence);
      expect(text, `${name}: named once, never twice`).not.toMatch(new RegExp(`\\(${VENUE_CITY} time\\) \\(`));
      checked++;
    }
    expect(checked, "anti-vacuity: the found-at line, the camera span, both timeline ends, the devices span").toBe(5);
    // Not one of the viewer's, UTC's or this process's faces for any of the seven instants (each differs from the venue's: the premises).
    let absent = 0;
    for (const iso of TIMED_INSTANTS) {
      for (const tz of [VIEWER, "UTC", RUNTIME_ZONE]) {
        for (const seconds of [false, true]) {
          const wrong = face(iso, tz, seconds);
          expect(wrong, `${iso} in ${tz}: a wrong face, not the venue's`).not.toBe(face(iso, VENUE, seconds));
          expect(text, `${iso} in ${tz} must not appear`).not.toContain(wrong);
          absent++;
        }
      }
    }
    expect(absent, "anti-vacuity: seven instants, three wrong zones, with and without seconds").toBe(TIMED_INSTANTS.length * 3 * 2);
  });

  it("the viewer is in the venue's zone, or at its offset: the same times, no name", async () => {
    let checked = 0;
    for (const zone of [VENUE, SAME_CLOCK]) {
      viewer.zone = zone;
      const text = await mountedText(props(VENUE));
      for (const [name, sentence] of Object.entries(sentences(VENUE, null))) {
        expect(text, `${zone} ${name}`).toContain(sentence);
      }
      expect(text, `${zone}: no label`).not.toContain(VENUE_CITY);
      checked++;
    }
    expect(checked, "anti-vacuity: two viewer zones").toBe(2);
  });

  it("the browser's zone cannot be read (null after mount): the venue's times, no name", async () => {
    viewer.zone = null;
    const text = await mountedText(props(VENUE));
    for (const sentence of Object.values(sentences(VENUE, null))) expect(text).toContain(sentence);
    expect(text).not.toContain(VENUE_CITY);
  });

  it("every time is read in the venue's zone passed in, not a fixed one: three venues, three different lines", async () => {
    viewer.zone = "Europe/London";
    const lines = new Set<string>();
    for (const [tz, city] of [
      ["Asia/Tokyo", "Tokyo"],
      ["America/New_York", "New York"],
      ["Pacific/Auckland", "Auckland"],
    ] as const) {
      const text = await mountedText(props(tz));
      const want = sentences(tz, city).found;
      expect(text, tz).toContain(want);
      lines.add(want);
    }
    expect(lines.size, "three venues, three different lines").toBe(3);
  });

  it("a server render (before mount) paints no time of day and no venue name: nothing for the browser to disagree with", () => {
    viewer.zone = VIEWER;
    const html = renderToStaticMarkup(
      <DictProvider dict={EN_UI} locale="en">
        <ExternalPlayNeedsResultQueue {...props(VENUE)} />
      </DictProvider>,
    );
    expect(html, "premise: the flagged card is on screen").toContain('data-testid="external-play-flagged-fx-1"');
    expect(html, "premise: the flag cards are drawn").toContain(en["arbiter.flag.outOfBand.chip"]!);
    expect(html).not.toContain(VENUE_CITY);
    for (const iso of TIMED_INSTANTS) {
      for (const tz of [VENUE, VIEWER, "UTC", RUNTIME_ZONE]) expect(html, `${iso} in ${tz}`).not.toContain(face(iso, tz, true));
    }
    expect(html).not.toContain(en["arbiter.flag.foundAt"]!.replace(" {time}", ""));
  });
});

// useFmt's zone is stated by every caller (owner ruling 2026-10-25 review): a formatter handed no zone must not fall back to the VIEWER's, which
// is the very bug this file exists for. The types allow `null` only beside a null clock (a caller that draws no time of day, round-queue-cards);
// a live clock with no zone is a state the types refuse, so it is reached here through a cast, and answers "no time" rather than a wrong one.
describe("useFmt: the zone is never left to the viewer", () => {
  const NOW = Date.parse("2026-10-24T07:00:00.000Z");
  /** The formatter a component gets for these arguments, read after its first render (and, for a live clock, its mount). */
  function formatterFor(nowMs: number | null, venueTz: string | null): Fmt {
    let seen: Fmt | null = null;
    function Probe() {
      seen = useFmt(nowMs, venueTz as never);
      return null;
    }
    const ui = renderIsland(Probe, {}, expandPure);
    ui.unmount();
    expect(seen, "the probe rendered").not.toBeNull();
    return seen as unknown as Fmt;
  }

  it("a live clock with no zone paints no time of day at all - not the viewer's, not the process's - counted", () => {
    viewer.zone = VIEWER;
    const f = formatterFor(NOW, null);
    let checked = 0;
    for (const iso of TIMED_INSTANTS) {
      expect(f.hm(iso), `hm ${iso}`).toBeNull();
      expect(f.hms(iso), `hms ${iso}`).toBeNull();
      checked += 2;
    }
    expect(checked).toBe(TIMED_INSTANTS.length * 2);
  });

  it("no clock and no zone (the round column's queue draws no time) paints none either", () => {
    viewer.zone = VIEWER;
    const f = formatterFor(null, null);
    for (const iso of TIMED_INSTANTS) {
      expect(f.hm(iso)).toBeNull();
      expect(f.hms(iso)).toBeNull();
    }
  });

  it("the pair: the same live clock WITH a zone paints the venue's face, named for a viewer elsewhere", () => {
    viewer.zone = VIEWER;
    const f = formatterFor(NOW, VENUE);
    for (const iso of TIMED_INSTANTS) {
      expect(f.hm(iso), `hm ${iso}`).toBe(labelled(face(iso, VENUE), VENUE_CITY));
      expect(f.hms(iso), `hms ${iso}`).toBe(labelled(face(iso, VENUE, true), VENUE_CITY));
    }
  });
});
