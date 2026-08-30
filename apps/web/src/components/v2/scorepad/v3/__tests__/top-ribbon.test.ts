// R3/F (F1) — THE TOP RIBBON CARRIES THE SKIN'S DETAIL.
//
// `buildRibbon` has taken an optional `detail` since the 2026-08-17 sign-off
// review (D2), and every skin that needs one builds one — `cricketBallDetail`,
// `footballDetail`. But `pad-host.tsx` called `buildRibbon` with FOUR arguments
// for the top ribbon and threaded `activityDetail` into the Activity panel
// ONLY, so `pad.ribbon.withDetail` never fired on the ribbon at all. Confirmed
// on a real 320 capture: the ribbon read "Goal recorded" while the dock
// directly beneath it held the scorer's name.
//
// Two things are asserted here, and the second is the one that matters:
//
//  1. `latestRowDetail` resolves the NEWEST row's detail with the same
//     oldest-first, voided-skipping history the panel gives that row.
//  2. `buildTopRibbon`'s text is IDENTICAL to the caption the REAL
//     `ActivityPanel` renders on its newest row — compared against the
//     rendered markup, not against a second call to `buildRibbon`. A test that
//     re-derived the expected string would prove only that this file can add
//     two numbers the same way twice; the panel is the independent path, and
//     the two disagreeing IS the defect.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPanel, latestRowDetail, type ActivityDetailResolver, type ActivityEvent } from "../activity";
import { buildTopRibbon } from "../pad-host";
import type { MsgFn } from "../ribbon";
import type { ActivityDetailContext } from "../types";
import { footballDetail } from "../skins/football";
import { cricketBallDetail } from "../skins/cricket";

/** Key-echoing `t`, the convention every v3 suite uses: it makes the KEY and
 *  its vars visible in the assertion, so "the detail was woven in" is provable
 *  without pulling a dictionary in. */
const t: MsgFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

/** The SAME stub, typed as `ActivityDetailContext["t"]` rather than `MsgFn`.
 *  These are not interchangeable and the difference is the whole point of the
 *  seam below: `MsgFn` accepts only a `MessageKey`, a skin's `activityDetail`
 *  declares a `t` that accepts any `string`, and a narrower-key function is
 *  NOT assignable to a wider-key parameter. Retyping the bag inline here
 *  instead of importing `ActivityDetailContext` is what made this file fail
 *  `tsc` while all of its tests passed — vitest never typechecks a test. */
const detailT: ActivityDetailContext["t"] = (key, vars) =>
  vars ? `${key}(${JSON.stringify(vars)})` : key;

const NAMES: Record<string, string> = { p1: "Rivera", p2: "Okafor", b1: "Khan" };
const nameOf = (id: string) => NAMES[id] ?? id;

/** The adapter `pad-host.tsx` itself builds from `skin.activityDetail` — a
 *  skin method takes ONE `ActivityDetailContext` bag, the panel and the ribbon
 *  both pass three positional arguments, and the host is the seam. Written
 *  once here so every case below exercises the production shape. */
function resolverFor(
  detail: (ctx: ActivityDetailContext) => string | undefined,
  cfg?: unknown,
): ActivityDetailResolver {
  return (eventType, payload, history) =>
    detail({ t: detailT, eventType, payload, history, cfg, personNames: NAMES });
}

function ev(seq: number, type: string, payload: Record<string, unknown>, voids: string | null = null): ActivityEvent {
  return { id: `e${seq}`, seq, type, payload, voids };
}

/** The caption text the real panel renders on its newest row. Parsed out of
 *  the markup rather than recomputed — see this file's header. */
function newestRowCaption(events: readonly ActivityEvent[], resolveDetail: Parameters<typeof ActivityPanel>[0]["resolveDetail"]): string {
  const html = renderToStaticMarkup(
    ActivityPanel({
      events,
      ownEventIds: new Set<string>(),
      deviceLinkId: null,
      personNames: NAMES,
      t,
      resolveDetail,
    }) as never,
  );
  // Rows render newest-first (`orderedActivity`). Targeted by the caption's
  // OWN marker rather than "the first <span> in the <li>", which is what this
  // used to do and what R7/C1 broke: the merged panel put the #seq column
  // ahead of the caption, and a positional regex read "#2" as the sentence.
  const row = /data-role="v3-activity-caption"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  expect(row, "no activity row rendered").not.toBeNull();
  return row![1]!.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

describe("latestRowDetail", () => {
  const events = [
    ev(1, "core.start", {}),
    ev(2, "football.goal", { by: "H", scorer: "p1" }),
    ev(3, "football.card", { by: "A", color: "yellow", person: "p2" }),
  ];

  it("resolves the NEWEST event, not the oldest — the ribbon shows what just happened", () => {
    const seen: string[] = [];
    latestRowDetail(events, (type) => {
      seen.push(type);
      return type;
    });
    expect(seen).toEqual(["football.card"]);
  });

  it("hands that event the same history the panel would — older rows, oldest first, voided ones skipped", () => {
    const withVoid = [...events, ev(4, "core.void", {}, "e2"), ev(5, "football.goal", { by: "H", scorer: "p2" })];
    let history: readonly { type: string }[] | undefined;
    latestRowDetail(withVoid, (_type, _payload, h) => {
      history = h;
      return undefined;
    });
    // e2 is voided by e4, so it must not appear; core.void itself is a real
    // row and does. Oldest first.
    expect(history?.map((h) => h.type)).toEqual(["core.start", "football.card", "core.void"]);
  });

  it("is undefined with no events, and with a skin that declares no activityDetail", () => {
    expect(latestRowDetail([], () => "x")).toBeUndefined();
    expect(latestRowDetail(events, undefined)).toBeUndefined();
  });
});

describe("buildTopRibbon", () => {
  it("is null with nothing recorded", () => {
    expect(buildTopRibbon([], nameOf, t, resolverFor(footballDetail))).toBeNull();
  });

  it("weaves the skin's detail into the ribbon through pad.ribbon.withDetail", () => {
    const ribbon = buildTopRibbon(
      [ev(1, "core.start", {}), ev(2, "football.goal", { by: "H", scorer: "p1", assist: "p2" })],
      nameOf,
      t,
      resolverFor(footballDetail),
    );
    expect(ribbon?.text).toContain("pad.ribbon.withDetail");
    expect(ribbon?.text).toContain("Rivera");
    expect(ribbon?.undoable).toBe(true);
  });

  it("reads EXACTLY what the activity panel's newest row reads — football", () => {
    const events = [
      ev(1, "core.start", {}),
      ev(2, "football.goal", { by: "H", scorer: "p1", assist: "p2", penalty: true }),
    ];
    const resolve = resolverFor(footballDetail);
    expect(buildTopRibbon(events, nameOf, t, resolve)!.text).toBe(newestRowCaption(events, resolve));
  });

  it("reads EXACTLY what the activity panel's newest row reads — cricket, including the history-dependent half", () => {
    // Two balls from DIFFERENT bowlers: `cricketBallDetail`'s bowler-changed
    // note fires only when it can see the previous ball, so this pins that the
    // ribbon gets the same `history` the panel's own row does — the half a
    // "just pass the payload" wiring would silently drop.
    const events = [
      ev(1, "core.start", {}),
      ev(2, "cricket.ball", { bowler: "b1", runs: { bat: 1 } }),
      ev(3, "cricket.ball", { bowler: "p2", runs: { bat: 4 } }),
    ];
    const resolve = resolverFor(cricketBallDetail, { ballsPerInnings: null });
    const ribbon = buildTopRibbon(events, nameOf, t, resolve)!;
    expect(ribbon.text).toContain("pad.cricket.ribbon.ball.bowlerChanged");
    expect(ribbon.text).toBe(newestRowCaption(events, resolve));
  });

  it("keeps the plain per-type line for a skin with no detail for this event", () => {
    const events = [ev(1, "core.start", {}), ev(2, "football.period", { phase: "HT" })];
    // `undefined` resolver = a skin that declares no activityDetail at all.
    expect(buildTopRibbon(events, nameOf, t, undefined)!.text).toBe(newestRowCaption(events, undefined));
  });
});
