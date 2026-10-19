// PostHog session-replay `$snapshot` events go through `before_send`, and the page URL in their rrweb frames is scrubbed there.
//
// posthog-js 1.399 (lazy-loaded-session-recorder.js -> posthog-core.js `capture`): the recorder buffers rrweb frames and flushes
// them as `$snapshot` events through `instance.capture('$snapshot', { $snapshot_data: [frame, ...], ... })`, and `capture` runs
// `config.before_send` on every event it builds, `$snapshot` included. Only the DOM-carrying frames (FullSnapshot, a DOM
// Mutation, a StyleSheetRule) are gzipped first (`compressEventSync`), which is why a secret painted into the DOM needs
// `ph-no-capture` (scrub-secret-painters.test.ts). The other frames are plain objects:
//  - the Meta frame (rrweb `EventType.Meta`, type 4) is `{ type, data: { href, width, height }, timestamp }`: the page's URL,
//    which on `/claim/<secret>`, `/join/<token>`, `/checkin/<code>` and `/magic-link?token=` IS the credential;
//  - the Custom frame the recorder adds on a client-side route change (`$url_changed`, `{ href }`).
// The deep walk in `posthogBeforeSend` reaches both, because it walks `properties.$snapshot_data` like any other value.
//
// The frames here are built with the SDK's own `EventType` enum (posthog-js/rrweb-types), in the property layout
// `_captureSnapshot` sends, and the event goes through the same `posthogBeforeSend` instrumentation-client.ts installs. The
// secrets are minted by the app's real minters over the fake sql tag, and the pages are the app's own route builders.
//
// Sport: not applicable — a replay frame's URL is sport-agnostic.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import { EventType } from "posthog-js/rrweb-types";

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { createLoginLink } from "@/lib/login-link";
import { routes } from "@/lib/routes";
import { posthogBeforeSend } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const json = (v: unknown) => JSON.stringify(v);

/** The rrweb Meta frame as the recorder emits it (`rawEvent.data.href` is the page's URL, masked only by the SDK's own params list). */
const meta = (href: string, timestamp = 1_760_000_000_000) => ({ type: EventType.Meta, data: { href, width: 390, height: 844 }, timestamp });
/** The Custom frame `_pageViewFallBack` adds when the SPA changes route. */
const urlChanged = (href: string, timestamp = 1_760_000_000_500) => ({ type: EventType.Custom, data: { tag: "$url_changed", payload: { href } }, timestamp });
/** A `$snapshot` event as `_captureSnapshot` hands it to `capture` (and so to `before_send`): the frames are `$snapshot_data`. */
const snapshot = (frames: unknown[], pathname = "/"): CaptureResult =>
  ({
    uuid: "01990000-0000-7000-8000-000000000000",
    event: "$snapshot",
    properties: {
      $snapshot_bytes: json(frames).length,
      $snapshot_data: frames,
      $session_id: "01990000-0000-7000-8000-0000000000aa",
      $window_id: "01990000-0000-7000-8000-0000000000bb",
      $lib: "web",
      $lib_version: "1.399.0",
      $pathname: pathname,
    },
    timestamp: new Date("2026-10-19T10:00:00Z"),
  }) as unknown as CaptureResult;

type Frame = { type: number; data: Record<string, unknown>; timestamp: number };
const framesOf = (e: CaptureResult | null): Frame[] => (e?.properties as { $snapshot_data: Frame[] }).$snapshot_data;

/** The installed SDK's own source: the premise of this file is read from it, so a posthog-js upgrade that moves it fails here first. */
const sdk = (rel: string) => fs.readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("posthog-js/package.json")), "lib/src", rel), "utf8");

describe("the premise: a $snapshot goes through before_send, and a Meta frame is a plain object of the shape this test builds", () => {
  it("the recorder sends every flushed buffer with capture('$snapshot', ...), and capture runs before_send before it queues the event", () => {
    const recorder = sdk("extensions/replay/external/lazy-loaded-session-recorder.js");
    expect(recorder).toMatch(/_captureSnapshot = function \(properties\) \{[^}]*this\._instance\.capture\('\$snapshot', properties,/);
    const core = sdk("posthog-core.js");
    const capture = core.slice(core.indexOf("PostHog.prototype.capture = function"));
    const run = capture.indexOf("this._runBeforeSend(data)");
    const queue = capture.indexOf("this._requestQueue.enqueue(requestOptions)");
    expect(run, "capture runs before_send").toBeGreaterThan(0);
    expect(queue, "capture queues the event").toBeGreaterThan(run);
    // No branch on the event name between the two: `$snapshot` is not exempt.
    expect(capture.slice(run - 300, run)).not.toMatch(/\$snapshot/);
  });

  it("only the DOM frames are gzipped before the event is built (FullSnapshot, Mutation, StyleSheetRule); Meta and Custom are plain", () => {
    const recorder = sdk("extensions/replay/external/lazy-loaded-session-recorder.js");
    const start = recorder.indexOf("function shouldCompressEvent(event)");
    const body = recorder.slice(start, recorder.indexOf("\n}", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("EventType.FullSnapshot");
    expect(body).toContain("IncrementalSource.Mutation");
    expect(body).toContain("IncrementalSource.StyleSheetRule");
    expect(body).not.toMatch(/EventType\.(Meta|Custom|Plugin)/);
  });

  it("the SDK's EventType names Meta 4 and Custom 5 (the numbers rrweb writes into the frame)", () => {
    expect(EventType.Meta).toBe(4);
    expect(EventType.Custom).toBe(5);
    expect(meta(`${ORIGIN}/x`)).toEqual({ type: 4, data: { href: `${ORIGIN}/x`, width: 390, height: 844 }, timestamp: expect.any(Number) });
  });
});

describe("posthogBeforeSend scrubs the page URL of the frames in a $snapshot event", () => {
  const cases = async () => {
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const checkin = await mintCheckinToken("00000000-0000-4000-8000-000000000003", new Date(Date.now() + 24 * 3600_000));
    const claim = mintClaimSecret();
    const login = await createLoginLink(USER_ID);
    return [
      { name: "claim page", secret: claim, href: `${ORIGIN}${routes.claim(claim)}` },
      { name: "org invite page", secret: invite, href: `${ORIGIN}/join/${invite}` },
      { name: "check-in page", secret: checkin, href: `${ORIGIN}${routes.checkin(checkin)}` },
      { name: "claim page, localised", secret: claim, href: `${ORIGIN}/fr${routes.claim(claim)}` },
      { name: "claim page with a query and a hash", secret: claim, href: `${ORIGIN}${routes.claim(claim)}?from=mail#top` },
      { name: "sign-in link", secret: login, href: `${ORIGIN}/magic-link?token=${login}&next=%2Fdashboard` },
      { name: "login page returning to a claim", secret: claim, href: `${ORIGIN}/login?next=${encodeURIComponent(routes.claim(claim))}` },
    ];
  };

  it("a Meta frame (type 4) loses the secret in data.href; width, height, timestamp and the rest of the event stay", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { name, secret, href } of await cases()) {
      expect(secret.length, `${name}: the minter gave a secret`).toBeGreaterThan(8);
      const input = snapshot([meta(href)]);
      const before = structuredClone(input);
      const out = posthogBeforeSend(input);
      const [frame] = framesOf(out);
      if (!frame) {
        failures.push(`${name}: no frame`);
        continue;
      }
      if (json(out).includes(secret)) failures.push(`${name}: the secret survived: ${frame.data.href}`);
      if (frame.type !== EventType.Meta || frame.data.width !== 390 || frame.data.height !== 844 || frame.timestamp !== 1_760_000_000_000) failures.push(`${name}: the frame changed beyond its href`);
      if (frame.data.href === href) failures.push(`${name}: href unchanged`);
      if (out?.event !== "$snapshot" || (out.properties as Record<string, unknown>).$session_id !== (before.properties as Record<string, unknown>).$session_id) failures.push(`${name}: event identity changed`);
      if (json(input) !== json(before)) failures.push(`${name}: the input was mutated`);
      checked++;
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(checked).toBe(7);
  });

  it("a Custom $url_changed frame (type 5, payload.href) loses it too", async () => {
    let checked = 0;
    for (const { name, secret, href } of await cases()) {
      const out = posthogBeforeSend(snapshot([urlChanged(href)]));
      expect(json(out), name).not.toContain(secret);
      const [frame] = framesOf(out);
      expect(frame?.type, name).toBe(EventType.Custom);
      expect((frame?.data.payload as { href: string }).href, name).not.toBe(href);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("a buffer of several frames keeps its order and scrubs each URL; frames that carry no URL keep their reference", async () => {
    const [claim] = await cases();
    const plain = { type: EventType.IncrementalSnapshot, data: { source: 2, type: 1, id: 7, x: 10, y: 20 }, timestamp: 1_760_000_000_250 };
    const frames = [meta(`${ORIGIN}/o/club`), plain, meta(claim!.href), urlChanged(claim!.href)];
    const out = posthogBeforeSend(snapshot(frames));
    const got = framesOf(out);
    expect(got.map((f) => f.type)).toEqual([4, 3, 4, 5]);
    expect(got[0]!.data.href).toBe(`${ORIGIN}/o/club`);
    expect(got[1]).toBe(plain);
    expect(json(out)).not.toContain(claim!.secret);
    expect(got.filter((f) => f.type === EventType.Meta)).toHaveLength(2);
  });

  it("the positive pair: a Meta frame on an ordinary page, and on a slug named like a secret route, is not touched", () => {
    const hrefs = [`${ORIGIN}/`, `${ORIGIN}/o/join/c/claim/d/checkin`, `${ORIGIN}${routes.competition("claim", "join")}`, `${ORIGIN}/pricing?plan=pro`];
    for (const href of hrefs) {
      const input = snapshot([meta(href)]);
      const out = posthogBeforeSend(input);
      expect(framesOf(out)[0]!.data.href, href).toBe(href);
    }
  });

  it("a snapshot taken on a staff page is dropped, and a null event stays dropped", () => {
    expect(posthogBeforeSend(snapshot([meta(`${ORIGIN}/admin/orgs`)], "/admin/orgs"))).toBeNull();
    expect(posthogBeforeSend(null)).toBeNull();
  });
});
