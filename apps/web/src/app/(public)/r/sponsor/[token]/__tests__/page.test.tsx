// R4 sponsors on stream, S14 - the public sponsor report page, /r/sponsor/[token] (spec 2026-10-27 §5.2, §7).
// renderToStaticMarkup (apps/web vitest is `environment: "node"`, no DOM). The SEAM is real end to end: S13's createReportLink
// mints the link, the real page renders it through the real `sponsorReport` and the real database, S13's revokeReportLink
// revokes it, and the same page then answers the opaque 404. Only the storage SIGNING boundary is a stub (no Supabase locally),
// plus the request context Next would supply (locale, headers, cookies) and `notFound`, which Next turns into the 404.
//
// What the page must do (brief + controller addenda 2026-11-01):
//   - open with no login: it reads no session, so no cookie is needed;
//   - noindex (robots), and no referrer;
//   - an unknown, a revoked and a malformed token: notFound() - the ONE opaque 404, the same for all three;
//   - rate-limited by `publicRateLimit` (the client's own IP bucket), checked BEFORE the lookup: a throttled visit gets the
//     throttled screen and never the report, and spends no database statement (no oracle). A page cannot answer 429 (Next's
//     HTTP fallbacks are 401/403/404 only), so the throttled screen is the page's form of it - see task-S14-report.md D1;
//   - every figure under its spec §5.2 label; viewers a dash (PR A); each showing's frame a SIGNED url, never the path, or a
//     neutral placeholder;
//   - every string from the dictionary (here: the fr dictionary, so a hard-coded English string cannot pass);
//   - long names truncate: `min-w-0` on every box from the showing card down to the name.
//
// Killers: P1 (rate limit removed) -> "a throttled visit"; P2 (lookup before the limit) -> its statement count;
//          P3 (frame path rendered instead of the signed url) -> "frames"; P4 (robots dropped) -> "metadata".
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomBytes, randomUUID } from "node:crypto";

const ctx = vi.hoisted(() => ({ locale: "fr" as "en" | "es" | "fr" | "nl", ip: "203.0.113.7", cookieReads: [] as string[] }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => ctx.locale }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      ctx.cookieReads.push(name);
      return undefined;
    },
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ "x-forwarded-for": `${ctx.ip}, 10.0.0.1`, "accept-language": "fr" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
const signs = vi.hoisted(() => ({ calls: [] as { orgId: string; path: string; ttl: number }[] }));
vi.mock("@/lib/supabase-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase-storage")>()),
  signedReadUrl: vi.fn(async (orgId: string, path: string, ttl: number) => {
    signs.calls.push({ orgId, path, ttl });
    return `https://storage.test/signed/${signs.calls.length}?sig=${randomBytes(6).toString("hex")}`;
  }),
}));

import { sql, statementCount } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { getDictionary, t, plural } from "@/lib/i18n";
import { fmtIsoDay, fmtOnScreen } from "@/lib/sponsor-report";
import { fmtNumber } from "@/lib/format";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { airingFramePath } from "@/server/sponsors/airings";
import { createReportLink, revokeReportLink } from "@/server/sponsors/report";
import SponsorReportPage, { generateMetadata } from "../page";
import SponsorReportNotFound from "../not-found";

const HAS_DB = !!process.env.DATABASE_URL;
const LONG = "Harbourside Building Supplies and Timber Co"; // 43 characters (Review Focus 5)
const fr = await getDictionary("fr", "ui");

/** The limiter's counter, per key, as Redis would keep it: the test decides the count. */
const counted = new Map<string, number>();
let overLimit = false;
beforeEach(() => {
  counted.clear();
  overLimit = false;
  signs.calls = [];
  ctx.locale = "fr";
  ctx.ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  ctx.cookieReads = [];
  __setRateLimitCounterForTests(async (key) => {
    const n = (counted.get(key) ?? 0) + 1;
    counted.set(key, n);
    return { count: overLimit ? 61 : n, ttlMs: 30_000 };
  });
});
afterEach(() => __setRateLimitCounterForTests(null));
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** React's own text escaping, so an expected string compares with the markup it renders to. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const render = async (token: string) => renderToStaticMarkup(await SponsorReportPage({ params: Promise.resolve({ token }) }));
const notFoundOf = async (token: string) => {
  await expect(render(token)).rejects.toThrow("NOT_FOUND");
};

describe("metadata", () => {
  it("is noindex, nofollow and no-referrer, with a localised title - read from the locale alone, no database", async () => {
    const before = statementCount();
    const meta = await generateMetadata();
    expect(statementCount() - before, "the title needs no lookup").toBe(0);
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.referrer).toBe("no-referrer");
    expect(meta.title).toBe(t(fr, "sponsorReport.meta.title"));
  });
});

describe("a throttled visit", () => {
  it("gets the throttled screen, never the report or the 404, and spends no statement; the client's own IP is the bucket", async () => {
    // A token that would open nothing: if the limiter ran AFTER the lookup this would be a 404 (and a statement).
    overLimit = true;
    const before = statementCount();
    const html = await render(randomBytes(32).toString("base64url"));
    expect(statementCount() - before, "checked before the lookup").toBe(0);
    expect(html).toContain(esc(t(fr, "sponsorReport.throttled.title")));
    expect(html).toContain(esc(t(fr, "sponsorReport.throttled.body")));
    expect(html).toContain('data-testid="sponsor-report-throttled"');
    expect(html).not.toContain('data-testid="sponsor-report"');
    expect([...counted.keys()], "the bucket is the client's first forwarded address").toEqual([`rl:pubv1:${ctx.ip}`]);
  });
});

describe.skipIf(!HAS_DB)("the seam: S13's real link, the real page, the real revoke", () => {
  it("opens with no session, shows the figures under their labels, then 404s after the revoke - and again", async () => {
    const { auth } = await seedOrg("pro");
    const rig = await divisionRig(auth, { entrants: 2 });
    const [{ name: orgName }] = await sql<{ name: string }[]>`select name from organizations where id = ${auth.orgId}`;
    const [sponsor] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, name, tier, logo_path) values (${auth.orgId}, ${LONG}, 'gold', 'https://cdn.example/logo.png') returning id`;
    const targetId = await rigTarget(auth.orgId);
    const createdBy = await rigUser();
    const [session] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
      select f.id, ${auth.orgId}, 'passthrough', 'completed', ${targetId}, ${createdBy}, d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${rig.fixtureIds[0]!}
      returning id`;
    // Two closed showings (8 s with a frame, 15 s without) and two stream visits, one site visit (not counted).
    const air = async (momentId: string, start: string, ms: number) => {
      const [r] = await sql<{ id: string }[]>`
        insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style, started_at, ended_at)
        values (${auth.orgId}, ${sponsor!.id}, ${LONG}, ${rig.fixtureIds[0]!}, ${session!.id}, ${momentId}, 'rotation', 'over_end', 'lower_third',
                ${new Date(start)}, ${new Date(new Date(start).getTime() + ms)}) returning id`;
      return r!.id;
    };
    await air("1:sponsor.over_end", "2026-06-02T10:00:00.000Z", 8_000);
    await air("2:sponsor.over_end", "2026-06-02T11:00:00.000Z", 15_000);
    const path = airingFramePath(auth.orgId, session!.id, "1:sponsor.over_end");
    await sql`insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${session!.id}, '1:sponsor.over_end', ${auth.orgId}, ${path})`;
    for (const source of ["stream", "stream", "site"]) {
      await sql`insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at) values (${auth.orgId}, ${sponsor!.id}, ${rig.fixtureIds[0]!}, ${source}, '2026-06-02T10:01:00Z')`;
    }
    const link = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    const token = link.url.split("/").at(-1)!;
    expect(link.url, "premise: S13's shape").toBe(`/r/sponsor/${token}`);

    const html = await render(token);
    expect(ctx.cookieReads.filter((name) => /session|auth|sid/i.test(name)), "no session is read").toEqual([]);
    expect(html).toContain('data-testid="sponsor-report"');
    // The figures, each under its label, typed from what was seeded: 23 s on screen across 2 showings; 2 stream visits.
    expect(html).toContain(esc(t(fr, "sponsorReport.heading", { sponsor: LONG, org: orgName! })));
    expect(html).toContain(fmtOnScreen("fr", 23_000));
    expect(html).toContain(esc(plural(fr, "sponsorReport.stat.onScreen", 2, "fr", { count: fmtNumber("fr", 2) })));
    expect(html).toMatch(new RegExp(`data-testid="report-stream-visits"[^>]*>${fmtNumber("fr", 2)}<`));
    expect(html).toContain(esc(plural(fr, "sponsorReport.stat.visits", 2, "fr")));
    expect(html, "viewers: a dash with its words for a screen reader").toMatch(/data-testid="report-viewers"[^>]*><span aria-hidden="true">—<\/span>/);
    expect(html).toContain(esc(t(fr, "sponsorReport.notAvailable")));
    expect(html).toContain(fmtIsoDay("fr", "2026-06-01"));
    expect(html).toContain(fmtIsoDay("fr", "2026-06-30"));
    expect(html).toContain('src="https://cdn.example/logo.png"');

    // Frames: one signed (TTL at most an hour, never the path), one placeholder.
    expect(signs.calls).toHaveLength(1);
    expect(signs.calls[0]).toMatchObject({ orgId: auth.orgId, path });
    expect(signs.calls[0]!.ttl).toBeLessThanOrEqual(3600);
    expect(html).toContain('src="https://storage.test/signed/1?sig=');
    expect(html).not.toContain(path);
    expect(html).not.toContain(path.split("/").at(-1)!);
    expect((html.match(/data-testid="report-showing"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="report-frame-missing"/g) ?? []).length).toBe(1);
    expect(html).toContain(esc(t(fr, "sponsorReport.frame.missing")));
    expect(html).toContain(esc(t(fr, "sponsors.onStream.break.over_end")));
    expect(html).toContain(esc(t(fr, "sponsorReport.match.sides", { home: "A", away: "B" })));
    expect(html, "the token is not printed on the page").not.toContain(token);
    // Print: the button is chrome, and print hides it.
    expect(html).toMatch(/<button[^>]*class="[^"]*\bprint:hidden\b[^"]*"[^>]*>[^<]*<\/button>/);
    expect(html).toContain(esc(t(fr, "sponsorReport.print")));

    await revokeReportLink(auth, auth.orgId, link.id);
    await notFoundOf(token);
    await notFoundOf(token);
  });

  it("an unknown, a malformed and a revoked token are each the 404 (the positive pair: a live one opens)", async () => {
    const { auth } = await seedOrg("pro");
    const [sponsor] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, tier) values (${auth.orgId}, 'Pair Co', 'partner') returning id`;
    const live = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    const gone = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    await revokeReportLink(auth, auth.orgId, gone.id);
    let checked = 0;
    for (const token of [randomBytes(32).toString("base64url"), "%E0%A4%A", "../../etc", "", gone.url.split("/").at(-1)!]) {
      await notFoundOf(token);
      checked++;
    }
    expect(checked).toBe(5);
    const html = await render(live.url.split("/").at(-1)!);
    expect(html).toContain("Pair Co");
    // The empty period: zero figures, the empty-list sentence, no showing card.
    expect(html).toContain(esc(t(fr, "sponsorReport.showings.empty")));
    expect(html).not.toContain('data-testid="report-showing"');
  });

  it("a deleted sponsor's link is the 404 (its links cascade with it)", async () => {
    const { auth } = await seedOrg("pro");
    const [sponsor] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, tier) values (${auth.orgId}, 'Gone Co', 'partner') returning id`;
    const link = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    expect(await render(link.url.split("/").at(-1)!)).toContain("Gone Co");
    await sql`delete from sponsors where id = ${sponsor!.id}`;
    await notFoundOf(link.url.split("/").at(-1)!);
  });

  it("every locale renders its own copy, never English in another locale (counted)", async () => {
    const { auth } = await seedOrg("pro");
    const [sponsor] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, tier) values (${auth.orgId}, ${`Locale Co ${randomUUID().slice(0, 4)}`}, 'partner') returning id`;
    const link = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    const en = await getDictionary("en", "ui");
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      ctx.locale = locale;
      const dict = await getDictionary(locale, "ui");
      const html = await render(link.url.split("/").at(-1)!);
      for (const key of ["sponsorReport.showings.title", "sponsorReport.footnote", "sponsorReport.print", "sponsorReport.stat.viewers"] as const) {
        expect(html, `${locale} ${key}`).toContain(esc(t(dict, key)));
        if (locale !== "en") expect(t(dict, key), `${locale} ${key} is translated`).not.toBe(t(en, key));
        checked++;
      }
    }
    expect(checked).toBe(16);
  });
});

describe.skipIf(!HAS_DB)("long names", () => {
  it("a 43-character side name truncates: min-w-0 on every box from the showing card to the name, and the name carries truncate", async () => {
    const { auth } = await seedOrg("pro");
    const rig = await divisionRig(auth, { entrants: 2 });
    await sql`update entrants set display_name = ${LONG} where division_id = ${rig.divisionId}`;
    const [sponsor] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, tier) values (${auth.orgId}, ${LONG}, 'gold') returning id`;
    await sql`
      insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at, ended_at)
      values (${auth.orgId}, ${sponsor!.id}, ${LONG}, ${rig.fixtureIds[0]!}, '1:sponsor.set_end', 'rotation', 'set_end', 'lower_third',
              '2026-06-02T10:00:00Z', '2026-06-02T10:00:08Z')`;
    const link = await createReportLink(auth, auth.orgId, { sponsorId: sponsor!.id, competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    const html = await render(link.url.split("/").at(-1)!);
    const card = html.slice(html.lastIndexOf("<li", html.indexOf('data-testid="report-showing"')));
    const name = t(fr, "sponsorReport.match.sides", { home: LONG, away: LONG });
    // The name as TEXT (its `title` attribute holds it too, inside the tag).
    const at = card.indexOf(`>${esc(name)}<`) + 1;
    expect(at, "premise: the name is in the card").toBeGreaterThan(0);
    // Every element still OPEN at the name, from the card down, must be min-w-0 (an `<img>` is void and closes itself).
    const open: string[] = [];
    for (const m of card.slice(0, at).matchAll(/<(\/?)([a-z]+)([^>]*)>/g)) {
      if (m[2] === "img") continue;
      if (m[1] === "/") open.pop();
      else open.push(`<${m[2]}${m[3]}>`);
    }
    expect(open.length, "the chain was walked").toBeGreaterThanOrEqual(3);
    for (const tag of open) expect(tag, "each box on the chain").toMatch(/class="[^"]*\bmin-w-0\b/);
    expect(open.at(-1), "the name itself truncates").toMatch(/\btruncate\b/);
    expect(open.at(-1), "and the full name is still there for a hover").toContain(`title="${esc(name)}"`);
  });
});

describe("the 404", () => {
  it("is the same markup whatever the token was (it takes no props and reads no token), in the reader's locale", async () => {
    const one = renderToStaticMarkup(await SponsorReportNotFound());
    const two = renderToStaticMarkup(await SponsorReportNotFound());
    expect(one).toBe(two);
    expect(one).toContain(esc(t(fr, "sponsorReport.notFound.title")));
    expect(one).toContain(esc(t(fr, "sponsorReport.notFound.body")));
    expect(one).toContain('data-testid="sponsor-report-not-found"');
  });
});
