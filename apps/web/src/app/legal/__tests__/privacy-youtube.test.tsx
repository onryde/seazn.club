import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// YouTube Connect T19 (spec §3.4, DP III.A.1 / III.A.2 / III.D.2 revocation / III.E.4). Google's YouTube API Services Developer Policies
// require the privacy policy of a client that uses OAuth ("Authorized Data") to: say it uses YouTube API Services (III.A.2.b), link
// Google's privacy policy (c), say what is accessed / collected / stored / used (d) and shared (e), say that a user can revoke access at
// Google's security-permissions page (h), and say how to reach the owner (i); the Terms of Service link is III.A.1.
//
// WHERE THE EXPECTED VALUES COME FROM. The three URLs are the policy's own literals (developers.google.com/youtube/terms/
// developer-policies, re-read 2026-10-29): the rulebook, not our constants, so a constant that drifts from the policy reds here.
// The day counts are read from the declarations in server/youtube/daily.ts (the one authority for the 30-day ceiling, the 25-day
// re-confirmation and the dead-grant purge window), never typed into this file, so moving a constant moves the policy text's test with it.
//
// The page is static English like the rest of /legal (the sibling tests pin its sentences the same way): no dictionary is involved.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import SubProcessorsPage from "../sub-processors/page";
import { GOOGLE_THIRD_PARTY_ACCESS_URL } from "@/lib/youtube";

// ─── the rulebook ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const POLICY_GOOGLE_PRIVACY = "http://www.google.com/policies/privacy"; // III.A.2.c, exactly as Google spells it (http)
const POLICY_PERMISSIONS = "https://security.google.com/settings/security/permissions"; // III.A.2.h
const POLICY_YOUTUBE_TOS = "https://www.youtube.com/t/terms"; // III.A.1

// ─── the engine's own declarations ────────────────────────────────────────────────────────────────────────────────────────────────────
const src = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const dailySrc = src("../../../server/youtube/daily.ts");
const declaredDays = (name: string): number => {
  const m = dailySrc.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!m) throw new Error(`${name} is no longer declared as a plain number in server/youtube/daily.ts; read the new declaration here`);
  return Number(m[1]);
};
const CEILING = declaredDays("YOUTUBE_DATA_CEILING_DAYS");
const REFRESH = declaredDays("YOUTUBE_REFRESH_AFTER_DAYS");
// The purge window is declared in lib/youtube (the Streaming page tells the customer the same figure); daily.ts re-exports it.
const libYoutubeSrc = src("../../../lib/youtube.ts");
const DEAD = Number(libYoutubeSrc.match(/export const YOUTUBE_DEAD_GRANT_PURGE_DAYS = (\d+);/)?.[1] ?? NaN);
if (!Number.isFinite(DEAD)) throw new Error("YOUTUBE_DEAD_GRANT_PURGE_DAYS is no longer declared as a plain number in lib/youtube.ts; read the new declaration here");
// How long an unfinished connection attempt (the sealed token and the picker's channel names) lives: connect-flow.ts's own declaration.
const connectFlowSrc = src("../../../server/youtube/connect-flow.ts");
const PENDING_SECONDS = Number(connectFlowSrc.match(/export const PENDING_LIFETIME_SECONDS = (\d+);/)?.[1] ?? NaN);
const PENDING_MINUTES = PENDING_SECONDS / 60;

// ─── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const html = renderToStaticMarkup(<PrivacyPage />);
/** Tags stripped, the entities React writes for an apostrophe/quote/ampersand decoded, whitespace collapsed: so a sentence that spans
 *  an inline link or a <strong> can be asserted as a sentence. */
const text = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** One <section>: from its opening tag to its close. */
const sections = html.split("<section").slice(1).map((s) => `<section${s.slice(0, s.indexOf("</section>"))}`);
const sectionOf = (id: string) => sections.find((s) => s.startsWith(`<section id="${id}"`)) ?? "";
const yt = sectionOf("youtube-api-services");
const ytText = text(yt);

describe("privacy — the YouTube API Services disclosure (T19, DP III.A.2)", () => {
  it("premises: the section exists, and the day counts it will be held to were read and differ", () => {
    expect(yt, "the section with id=\"youtube-api-services\"").not.toBe("");
    expect(CEILING, "read from daily.ts").toBeGreaterThan(0);
    expect(REFRESH, "read from daily.ts").toBeGreaterThan(0);
    expect(DEAD, "read from daily.ts").toBeGreaterThan(0);
    expect(PENDING_MINUTES, "read from connect-flow.ts; a whole number of minutes (the page says minutes)").toBeGreaterThan(0);
    expect(Number.isInteger(PENDING_MINUTES)).toBe(true);
    // The three numbers are different facts: a page that said one twice could not be told from one that said both.
    expect(new Set([REFRESH, CEILING, DEAD]).size, "three distinct windows").toBe(3);
    expect(REFRESH).toBeLessThan(CEILING);
    expect(DEAD, "the dead-grant purge is sooner than the ceiling (DP III.D.2: counted from a revocation)").toBeLessThan(CEILING);
  });

  /** The seven things DP III.A.2 (with the override on disconnect) owes the page. Each is a predicate over the section; `ran` proves each
   *  one was evaluated, so a renamed id that empties `yt` cannot leave a vacuous green. */
  const ran = new Set<string>();
  const ITEMS: [string, () => string[]][] = [
    // Each predicate returns what is MISSING; [] is a pass.
    ["says Seazn uses YouTube API Services (III.A.2.b)", () => ["Seazn Club uses YouTube API Services"].filter((n) => !ytText.includes(n))],
    ["links Google's privacy policy (III.A.2.c)", () => [`href="${POLICY_GOOGLE_PRIVACY}"`].filter((n) => !yt.includes(n))],
    // Both ends of one seam: the policy's literal, AND the constant the Disconnect notice links (F2: one revocation URL, the policy's).
    ["links Google's security-permissions page to revoke (III.A.2.h), the same URL the Disconnect notice uses", () =>
      [`href="${POLICY_PERMISSIONS}"`, `href="${GOOGLE_THIRD_PARTY_ACCESS_URL}"`].filter((n) => !yt.includes(n))],
    ["links the YouTube Terms of Service (III.A.1) and says users are bound by them", () =>
      [`href="${POLICY_YOUTUBE_TOS}"`].filter((n) => !yt.includes(n)).concat(["agree to be bound by the YouTube Terms of Service"].filter((n) => !ytText.includes(n)))],
    ["names what is accessed, stored, used and shared, and how long it is kept (III.A.2.d/e, III.E.4)", () => {
      // PER BULLET: a needle that also appears in another bullet or paragraph (the refresh token is named three times) would let
      // its own bullet lose it unseen.
      const bullet = (label: string) => text(yt.match(new RegExp(`<li><strong>${label}</strong>.*?</li>`))?.[0] ?? "");
      const WANT: [label: string, needles: string[]][] = [
        ["What we access:", ["id and title", "live broadcasts and live streams"]],
        ["What we store:", [
          "channel id and title", "refresh token (encrypted at rest)", "its id, which is also its video id, and its title", "stream keys",
          // F3a (final review M1): the keyed fingerprint of the channel id is stored too, and it is what survives a Disconnect.
          "a keyed one-way fingerprint of the channel id",
        ]],
        ["How we use it:", ["only to stream", "replay link", "do not sell it"]],
        ["Who it is shared with:", [
          "Google", "We share it with no one else",
          // F3c (final review M3): the stream relay's providers carry the stream, and the stream key goes to the first of them.
          "our stream relay, which our sub-processors run", "Cloudflare", "the stream key we created on your channel", "Fly.io", "score overlay",
          "see the sub-processors list",
          // F3d (final review M4): the filter reads the visibility Seazn asked YouTube for, not YouTube's live setting.
          "a broadcast that Seazn Club created as Private is not shown there", "it is not read back from YouTube",
        ]],
        // M2: every kind of thing the section says is stored has its own real retention, named in this bullet (read from the code: the token,
        // channel and account id live while connected (revokeConnection / purgeConnectionData clear them); the daily pass owns the 30-day
        // ceiling; an unfinished attempt expires after PENDING_LIFETIME_SECONDS and the daily pass deletes it; the consent record and the two
        // choices stay on the revoked row until the organisation goes).
        ["How long we keep it:", [
          "the refresh token, the channel id and title and the Google account identifier are kept while the channel is connected",
          `refreshed or deleted within ${CEILING} days`, `after ${REFRESH} days`,
          `has not been confirmed within ${CEILING} days`, `nothing has used for ${CEILING} days`,
          "The sealed token and channel names of a connection that was started and not finished",
          // F1 (final review C1): what is promised is what the code does - deleted by the save, otherwise by the daily pass after the
          // attempt expires. The picker's Cancel deletes nothing (the guard test below holds that), so the page says so.
          `are deleted when the channel is connected, and otherwise by the next daily check after the attempt expires, ${PENDING_MINUTES} minutes after it was started`,
          "choosing Cancel in the channel picker does not delete them sooner",
          "are not data from YouTube", "after a disconnect too, for as long as your organisation's account exists on Seazn Club",
          // F3a/F3e: the exception to "everything" is named where "everything" is promised, and the idle key's delete reaches YouTube.
          "we delete everything we stored from YouTube for it (except the channel fingerprint described under Disconnecting below)",
          "asking YouTube to delete the stream where we can",
        ]],
      ];
      const missing: string[] = [];
      let checked = 0;
      for (const [label, needles] of WANT) {
        const b = bullet(label);
        if (b === "") missing.push(`the "${label}" bullet`);
        for (const n of needles) {
          checked++;
          if (!b.includes(n)) missing.push(`"${n}" in "${label}"`);
        }
      }
      expect(checked, "anti-vacuity: every needle was tried").toBe(WANT.reduce((n, [, ns]) => n + ns.length, 0));
      expect(checked).toBe(32);
      return missing;
    }],
    ["says Disconnect deletes at once what was stored and asks Google to revoke", () => {
      const disconnect = text(yt.match(/<p[^>]*><strong>Disconnecting and revoking access\.<\/strong>.*?<\/p>/)?.[0] ?? "");
      return disconnect === ""
        ? ["the Disconnecting paragraph"]
        : ["Disconnecting deletes at once everything we stored from YouTube", "refresh token", "stream keys", "replay links", "channel id and title", "asks Google to revoke",
            "any reconnection of the channel that was started and not finished",
            // F3a (M1): what survives, why, and that it is not the channel id.
            "One thing is kept", "archived rather than deleted", "the history of earlier streams refers to it",
            "a keyed one-way fingerprint of the channel id", "we cannot turn it back into the channel id",
            "for as long as your organisation's account exists on Seazn Club", "The same applies when we delete a connection that stopped working",
            // F3e (M5): what Disconnect does AT YouTube, where it can, and what it leaves.
            "ends any broadcast of ours that is still running", "deletes any broadcast of ours that never went live",
            "deletes the stream keys it created on your channel", "those stay at YouTube",
            "Finished broadcasts and their videos stay on your channel", "we delete only our record of them",
            // M1: the revoke is NOT unconditional - it is skipped on purpose for an account another connected channel uses (disconnect.ts
            // `accountIsShared`) and cannot be made without a readable token - so the sentence says so.
            "unless another connected channel uses the same Google account", "cannot be read"]
            .filter((n) => !disconnect.includes(n))
            // Disconnect has no waiting period (the dead-grant purge below has one, so the section may say "7 days" - not THIS paragraph).
            .concat(/\b(7|seven|\d+) (calendar )?days\b/i.test(disconnect) ? ["NO waiting period in the Disconnect paragraph: it deletes at once"] : []);
    }],
    ["gives a contact for privacy questions and complaints (III.A.2.i)", () => ['href="mailto:privacy@seazn.club"'].filter((n) => !yt.includes(n))],
  ];

  it.each(ITEMS)("%s", (name, missing) => {
    ran.add(name);
    expect(missing(), `missing from the YouTube section: ${name}`).toEqual([]);
  });

  it("checked === 7: every required item was evaluated (zero checked is a failure)", () => {
    expect(ITEMS.length).toBe(7);
    expect(ran.size, "the seven items above ran before this one").toBe(7);
  });
});

describe("privacy — what the YouTube section says about the other halves of the lifecycle", () => {
  it("a grant that stops working (revoked at Google) is deleted after the DECLARED dead-grant window - not the ceiling's", () => {
    expect(ytText).toContain(`not reconnected within ${DEAD} days`);
    expect(ytText).toContain("removed Seazn Club at Google");
    // M1: and the revoke at Google is stated with the same conditions as Disconnect's (purgeDeadGrant: not for a shared account, not
    // without a token that opens).
    expect(ytText).toContain("and, unless another connected channel uses the same Google account or the token cannot be read, ask Google to revoke the grant");
    // The negative pair: the window it replaced (the ceiling's) is not promised there.
    expect(ytText).not.toContain(`not reconnected within ${CEILING} days`);
  });

  it("F1 (final review C1): an unfinished connect is NOT promised deleted 'when it is finished or cancelled' - the picker's Cancel deletes nothing", () => {
    // The negative pair of the needles above (a negative alone is vacuous): the old wording is gone, and the true clause is there.
    expect(ytText).not.toMatch(/\bcancell?ed\b/i);
    expect(ytText).not.toContain("deleted when it is finished");
    expect(ytText).toContain("deleted when the channel is connected, and otherwise by the next daily check");
  });

  it("F1: the sentence is held by the code - Cancel only navigates, no route deletes a pending grant on request, and the daily pass deletes the expired ones", () => {
    // An assumption is a guard. If a DELETE route or a deleting Cancel is added, the page UNDERSTATES what happens (not a false promise,
    // but stale copy): this fails beside the sentence so the copy is revisited with the code.
    const panel = src("../../../components/v2/youtube-connect-panel.tsx");
    expect(panel, "the picker's cancel handler").toContain("const cancel = () => router.replace(STREAMING_PAGE_HREF);");
    const pendingRoute = src("../../../app/api/v1/orgs/[id]/youtube-connections/pending/[pendingId]/route.ts");
    expect(pendingRoute, "the pending route is read-only").toContain("export async function GET(");
    expect(pendingRoute).not.toMatch(/export (async )?function (DELETE|POST|PUT|PATCH)\b/);
    expect(dailySrc, "the daily pass's pending leg").toContain("delete from youtube_connect_pending where expires_at < ${now}");
    // And the 'next daily check' really is a daily one: the pass that holds the leg rides the relay-sweep firing at 04:17 UTC.
    const schedule = src("../../../../../cron-worker/src/schedule.ts");
    expect(schedule).toMatch(/id: "relay-sweep",[\s\S]*?due: \{ kind: "daily", hourUtc: 4 \}/);
  });

  it("M2: the section no longer says 'everything else' is refreshed or deleted within 30 days (the account id, the consent record and a pending grant each have their own retention)", () => {
    expect(ytText).not.toContain("Everything else we store from YouTube");
    expect(ytText).not.toContain("the refresh token and the channel details are kept");
  });

  it("M3: the second API Service is Google's authorisation (OAuth) service for the YouTube permission - Seazn does not use Google sign-in here", () => {
    expect(ytText).toContain("Google's authorisation (OAuth) service for the YouTube permission");
    expect(ytText, "the sign-in product is a different service (the login uses it; this feature does not)").not.toContain("Google sign-in");
  });

  it("a Private broadcast is not shown on public match pages; a replay link is shown to anyone who can open the page", () => {
    expect(ytText).toContain("a broadcast that Seazn Club created as Private is not shown there");
    expect(ytText).toContain("anyone who can open that page");
    // F3d (M4): it is the visibility Seazn ASKED for, and the page says it does not follow YouTube's live setting. The old claim is gone.
    expect(ytText).toContain("That is the visibility Seazn Club asked YouTube for when it created the broadcast");
    expect(ytText).toContain("so a visibility you change later in YouTube is not followed here");
    expect(ytText).not.toContain("private on YouTube");
  });

  it("F3d: the sentence is held by the code - the public view filters on the broadcast row's own privacy, and nothing reads privacyStatus back from YouTube", () => {
    // Both halves are assumptions: if a refresh ever reads the live visibility, or the view starts reading YouTube's, this page is wrong.
    const view = src("../../../../../../db/migration/deltas/V480__youtube_broadcast_actual_times.sql");
    expect(view, "the public parts view").toContain("and b.privacy in ('unlisted', 'public')");
    const dir = join(__dirname, "../../../server/youtube");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length, "anti-vacuity: the server/youtube sources were listed").toBeGreaterThan(10);
    const mentions = files.map((f) => [f, (readFileSync(join(dir, f), "utf8").match(/privacyStatus/g) ?? []).length] as const).filter(([, n]) => n > 0);
    // Exactly one mention, in the create call (google.ts) that WRITES the privacy: no file reads it back.
    expect(mentions, "privacyStatus appears once, in the create call").toEqual([["google.ts", 1]]);
    expect(src("../../../server/youtube/google.ts")).toContain("status: { privacyStatus: a.privacy, selfDeclaredMadeForKids: a.madeForKids }");
  });

  it("F3c: the processors the page names are on the sub-processors list it links, and the stream key goes to Cloudflare's ingest only", () => {
    expect(yt, "the link to the list").toContain('href="/legal/sub-processors"');
    const list = text(renderToStaticMarkup(<SubProcessorsPage />));
    for (const name of ["Cloudflare", "Fly.io"]) expect(list, `${name} is on the sub-processors list`).toContain(name);
    expect(list, "Cloudflare's listed purpose covers the live-stream ingest").toContain("live-stream video ingest");
    // The key is handed to Cloudflare as a live-input output (addOutput) and the session effect reads it for no other port.
    const effect = src("../../../server/usecases/stream-sessions.ts");
    expect(effect).toContain("deps.drivers.ingest.addOutput(inputId, target");
    expect(effect, "the composed destination key never reaches the Machine (spec 5.3)").toContain("a composed destination key reaches Cloudflare and never the Machine");
  });

  it("F3e: Disconnect's YouTube clean-up and the idle key's delete are held by the code; a finished broadcast is left alone", () => {
    const d = src("../../../server/youtube/disconnect.ts");
    const windDown = d.slice(d.indexOf("async function windDown("), d.indexOf("/** Test-only seam"));
    expect(windDown.length, "anti-vacuity: windDown was found").toBeGreaterThan(300);
    expect(windDown).toMatch(/case "live":\s*case "testing":\s*await attempt\(\(\) => port\.complete\(/);
    expect(windDown).toMatch(/case "created":\s*case "ready":\s*await attempt\(\(\) => port\.deleteBroadcast\(/);
    expect(windDown, "a finished, revoked or absent broadcast asks YouTube for nothing").toMatch(/case "complete":\s*case "revoked":\s*case "absent":\s*return;/);
    expect(d).toContain("port.deleteStream(at.value, streamId)");
    // The dead-grant purge asks Google to REVOKE only (its token is dead): the page does not promise a YouTube clean-up there.
    expect(dailySrc).toContain("await revokeConnection(tx, c.org_id, c.id)");
    expect(dailySrc).toContain("p.port.deleteStream(at, streamId)");
  });

  it("F3a: the fingerprint outliving a Disconnect is held by the code - nothing clears it, the destination is archived (never deleted), history references it", () => {
    const dir = join(__dirname, "../../../server/youtube");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length, "anti-vacuity").toBeGreaterThan(10);
    const bad = files.filter((f) => /dest_fingerprint\s*=\s*null|delete from org_stream_targets/.test(readFileSync(join(dir, f), "utf8")));
    expect(bad, "no server/youtube source clears the fingerprint or deletes a destination row").toEqual([]);
    const tokenStore = src("../../../server/youtube/token-store.ts");
    expect(tokenStore, "revoke ARCHIVES the destination").toContain("set archived_at = coalesce(archived_at, now()), label = ${DISCONNECTED_LABEL}");
    expect(tokenStore, "and the fingerprint is stored on it at connect, so there is something to survive").toContain("dest_fingerprint");
    expect(src("../../../server/youtube/connections.ts"), "the fingerprint is of the CHANNEL id").toContain("fingerprintYoutubeChannel(channelId)");
    expect(src("../../../../../../db/migration/deltas/V410__stream_sessions.sql"), "history (stream sessions) references the destination row").toMatch(/target_id\s+uuid not null references org_stream_targets\(id\)/);
  });

  it("the device paragraph (III.A.2.g): nothing loads until the tap, a thumbnail only before it, Google's cookies after - and points at the Cookie Policy", () => {
    expect(ytText).toContain("Nothing from the player loads until you tap play");
    expect(ytText).toContain("only the video's thumbnail");
    expect(ytText).toContain("may store cookies or similar data on your device");
    // F3f (M6): the player is third-party content from YouTube, not Seazn's.
    expect(ytText).toContain("which is third-party content from YouTube, not part of Seazn Club");
    // M4: loading either one sends the visitor's address to Google.
    expect(ytText).toContain("each send your IP address and browser details to Google");
    expect(yt).toContain('href="/legal/cookie-policy"');
  });

  it("a made-for-kids replay is a link to YouTube, not a player (owner 2026-10-29, DP III.E.4.j) - the paragraph says so, and says nothing is fetched for it", () => {
    expect(ytText).toContain("A replay of a video made for kids is a link to YouTube, not a player");
    expect(ytText).toContain("nothing is fetched from YouTube for it until you follow the link");
  });

  it("the sentence 'deletes at once' is held by the code: the purge runs inside the disconnect transaction, then the Google revoke is asked for", () => {
    // An assumption is a guard: if Disconnect ever defers its purge (a 7-day sweep, say), this fails beside the sentence it falsifies.
    const d = src("../../../server/youtube/disconnect.ts");
    const begin = d.indexOf("sql.begin(");
    const purge = d.indexOf("await purgeConnectionData(tx, connectionId)");
    const commitEnd = d.indexOf("// Committed:");
    const revoke = d.indexOf('port.revoke(token), c, "revoke"');
    expect(begin, "the transaction").toBeGreaterThan(-1);
    expect(purge, "the purge call").toBeGreaterThan(begin);
    expect(commitEnd, "the transaction's end").toBeGreaterThan(purge);
    expect(revoke, "the Google revoke").toBeGreaterThan(commitEnd);
  });
});

describe("privacy — regression: every section that existed before T19 still renders (O4)", () => {
  // Snapshot of /legal/privacy as of main da17c2bc50 (19 October 2026 text): each heading (number stripped - the YouTube section is
  // inserted at 7 and the later ones moved down one) with a sentence distinctive of its body. The sibling tests pin sections 5 and 6 in
  // full; this pins that no section was lost, retitled or emptied by the insertion.
  const BEFORE: [title: string, anchor: string][] = [
    ["Who we are", "operates the tournament management platform at seazn.club"],
    ["Data we collect", "Account data: email address, display name, avatar URL."],
    ["Legal basis (GDPR)", "processing necessary to provide the service you signed up for"],
    ["How we use your data", "We do not sell your data or use it for advertising."],
    ["Automated grouping when we build a schedule", "treated as one player while a timetable is built"],
    ["Online chess: camera video and your Lichess account", "plays from a match room on seazn.club with their camera on"],
    ["Sub-processors", "We share data with trusted sub-processors to operate the service."],
    ["Data retention", "Billing records are retained for 7 years for tax compliance."],
    ["Your rights (GDPR)", "Settings → Account → Export my data"],
    ["Cookies", "No advertising cookies."],
    ["Security", "Staff access is logged and audited."],
    ["Changes", "at least 14 days in advance"],
    ["Contact", "Privacy questions:"],
  ];
  const headingOf = (s: string) => text(s.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1] ?? "").replace(/^\d+\.\s*/, "");

  it("keeps all thirteen headings, in their order, with the YouTube section inserted after the online-chess section", () => {
    const titles = sections.map(headingOf);
    const want = [...BEFORE.slice(0, 6).map(([t]) => t), "YouTube live streaming (YouTube API Services)", ...BEFORE.slice(6).map(([t]) => t)];
    expect(titles).toEqual(want);
  });

  it("each old section still holds its own distinctive sentence (13 checked)", () => {
    let checked = 0;
    for (const [title, anchor] of BEFORE) {
      const s = sections.find((x) => headingOf(x) === title);
      expect(s, `the "${title}" section`).toBeDefined();
      expect(text(s!), `the "${title}" section's body`).toContain(anchor);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(13);
  });

  it("does not move a sentence of the old sections into the new one (the YouTube text is its own section)", () => {
    expect(ytText.length, "anti-vacuity: the YouTube section is there to be compared").toBeGreaterThan(500);
    for (const [, anchor] of BEFORE) expect(ytText).not.toContain(anchor);
  });
});
