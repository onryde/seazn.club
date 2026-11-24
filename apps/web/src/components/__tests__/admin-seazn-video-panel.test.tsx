// The staff "Seazn video" table on /admin/orgs/[id] (Seazn-hosted video Task 31): the org's last Seazn sessions, what the daily
// pass measured for each (live and replay minutes, through which UTC day), and each replay part's state. Staff-only, desktop-only
// (/admin: 1280, AGENTS.md), English only (an /admin surface: no dictionary). A server component with no state: rendered to static
// markup here; the walkthrough (e2e/walkthrough/stream-credits-admin.spec.ts) renders it on the real page.
//
// What it must say is the brief's and the plan's, typed here: minutes AS STORED (numeric(12,1) text — never re-rounded or
// re-formatted into another number), "—" for a half never measured, the part words, and that the minutes are estimates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SeaznVideoSession } from "@/server/usecases/seazn-cost";
import { AdminSeaznVideoPanel } from "../admin-seazn-video-panel";

const row = (over: Partial<SeaznVideoSession> = {}): SeaznVideoSession => ({
  sessionId: "s-1", fixture: "Harbour FC v Ridge United", endedAt: new Date("2026-11-21T19:42:00.000Z"),
  liveMinutes: "15.5", replayMinutes: "4.0", liveThrough: "2026-11-22", replayThrough: "2026-11-22",
  parts: [{ partNo: 1, state: "playable", deletedReason: null }], ...over,
});
// The limit is DELIBERATELY not the production 50: a panel that typed its own number passes with 50 and fails with this.
const render = (rows: SeaznVideoSession[], limit = 7) => renderToStaticMarkup(<AdminSeaznVideoPanel rows={rows} limit={limit} />);
const rowsOf = (html: string) => html.match(/data-testid="seazn-video-row"/g)?.length ?? 0;

describe("AdminSeaznVideoPanel", () => {
  it("EMPTY CASE FIRST: no Seazn session — the panel and its heading still render, with the empty line and no table", () => {
    const html = render([]);
    expect(html).toContain('data-testid="seazn-video-panel"');
    expect(html).toContain(">Seazn video<");
    expect(html).toContain('data-testid="seazn-video-empty"');
    expect(html).not.toContain("<table");
    expect(rowsOf(html)).toBe(0);
  });

  it("a row: the fixture, the end in UTC, both halves' minutes exactly as stored with the day they run through, and each part's state", () => {
    const html = render([row()]);
    expect(rowsOf(html)).toBe(1);
    expect(html).toContain('data-session-id="s-1"');
    expect(html).toContain("Harbour FC v Ridge United");
    expect(html).toContain("2026-11-21 19:42 UTC");
    expect(html).toContain(">15.5<");
    expect(html).toContain(">4.0<");
    expect(html.match(/through 2026-11-22/g), "both halves' days").toHaveLength(2);
    expect(html).toContain('data-testid="seazn-video-part" class="block">Part 1: playable<');
    expect(html).not.toContain('data-testid="seazn-video-empty"');
  });

  it("never measured, not ended, no fixture, no parts: each reads — rather than a zero or a blank; a removed part says who removed it", () => {
    const html = render([
      row({ sessionId: "s-2", fixture: null, endedAt: null, liveMinutes: null, replayMinutes: null, liveThrough: null, replayThrough: null, parts: [] }),
      row({ sessionId: "s-3", parts: [{ partNo: 1, state: "deleted", deletedReason: "org_deleted" }, { partNo: 2, state: "deleted", deletedReason: "organiser" }, { partNo: 3, state: "encoding", deletedReason: null }, { partNo: 4, state: "deleted", deletedReason: "fixture_deleted" }] }),
    ]);
    expect(rowsOf(html)).toBe(2);
    const s2 = html.slice(html.indexOf('data-session-id="s-2"'), html.indexOf('data-session-id="s-3"'));
    expect(s2.match(/>—</g)?.length, "fixture, ended, live, replay, parts").toBe(5);
    expect(s2).not.toContain(">0<");
    expect(s2).not.toContain("through");
    expect(html).toContain("Part 1: deleted (org deleted)");
    expect(html).toContain("Part 2: deleted (by organiser)");
    expect(html).toContain("Part 3: encoding");
    expect(html, "Task 31b (V551)").toContain("Part 4: deleted (fixture deleted)");
  });

  // Task 31 fix round 1 (review m8): both minute columns are NOT NULL DEFAULT 0 (V552), so a delivery row written by ONE half reads
  // the other half as 0.0 with no day. That half was never measured — not "measured, nobody watched" — and reads "—". Keyed on BOTH:
  // a copy's last read before its removal can add minutes to a session the daily pass never reached (through still null).
  it("m8: a half with 0.0 and no day was never measured and reads —; minutes with no day (a removed copy's last read) read as stored; 0.0 with a day is a measured zero", () => {
    const cell = (html: string, half: "live" | "replay") => html.match(new RegExp(`data-testid="seazn-video-${half}-minutes"[^>]*>([^<]*)<`))?.[1];
    const day = (html: string, half: "live" | "replay") => html.match(new RegExp(`data-testid="seazn-video-${half}-through"[^>]*>([^<]*)<`))?.[1] ?? null;
    const cases: [string, Partial<SeaznVideoSession>, [string, string | null], [string, string | null]][] = [
      ["live measured, replay never", { replayMinutes: "0.0", replayThrough: null }, ["15.5", "through 2026-11-22"], ["—", null]],
      ["replay measured, live never", { liveMinutes: "0.0", liveThrough: null }, ["—", null], ["4.0", "through 2026-11-22"]],
      ["a removed copy's last read only", { liveMinutes: "0.0", liveThrough: null, replayMinutes: "7.5", replayThrough: null }, ["—", null], ["7.5", null]],
      ["a measured zero", { liveMinutes: "0.0", replayMinutes: "0.0" }, ["0.0", "through 2026-11-22"], ["0.0", "through 2026-11-22"]],
    ];
    let checked = 0;
    for (const [what, over, live, replay] of cases) {
      const html = render([row(over)]);
      expect([cell(html, "live"), day(html, "live")], `${what}: live`).toEqual(live);
      expect([cell(html, "replay"), day(html, "replay")], `${what}: replay`).toEqual(replay);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("says the minutes are estimates, and how many sessions it shows — from its prop, never a number of its own", () => {
    const html = render([row()]);
    expect(html).toMatch(/estimates/i);
    expect(html).toContain("Last 7 Seazn sessions");
    expect(render([row()], 50)).toContain("Last 50 Seazn sessions");
  });

  // Phase 3 review I2 (controller ruling 2026-11-24): the live column counts what Cloudflare SERVED from the match's recordings —
  // live viewing, the replay before the replay host's copy took over, and the one-off copy to the replay host — so it is named
  // "Cloudflare minutes delivered", never "live". Review m5: a day is read once, at about 04:17 UTC the next day; a vendor that reports
  // later is under-counted for good, an accepted estimate error the caveat names.
  it("I2/m5: the Cloudflare column is named for what it counts; the caveat says what it holds, the one-off copy included, and that a day is never read again", () => {
    const html = render([row()]);
    expect(html).toContain(">Cloudflare min delivered<");
    expect(html).not.toMatch(/>Live min</);
    const caveat = html.match(/data-testid="seazn-video-caveat"[^>]*>([^<]*)</)?.[1] ?? "";
    expect(caveat.length, "PREMISE: the caveat rendered").toBeGreaterThan(0);
    expect(caveat).toContain("Cloudflare minutes delivered");
    expect(caveat).toMatch(/live viewing, the replay before the replay host&#x27;s copy took over, and the\s+one-off copy to the replay host/);
    expect(caveat).toMatch(/a day is\s+never read again/);
    expect(caveat, "the old wording claimed the match feed").not.toMatch(/match feed/);
    expect(caveat).toMatch(/estimates/);
  });

  it("the admin org page mounts it with the staff read and the usecase's own limit (the seam, read from the page's source)", () => {
    const page = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../../app/admin/orgs/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/const seaznVideo = await seaznVideoForOrg\(id\);/);
    expect(page).toMatch(/<AdminSeaznVideoPanel rows=\{seaznVideo\} limit=\{SEAZN_STAFF_SESSIONS_LIMIT\} \/>/);
  });
});
