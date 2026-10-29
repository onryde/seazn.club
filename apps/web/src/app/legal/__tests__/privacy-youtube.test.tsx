import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// YouTube Connect T19 (spec §3.4, DP III.A.1 / III.A.2 / III.D.2 revocation / III.E.4). Google's YouTube API Services Developer Policies
// require the privacy policy of a client that uses OAuth ("Authorized Data") to: say it uses YouTube API Services (III.A.2.b), link
// Google's privacy policy (c), say what is accessed / collected / stored / used (d) and shared (e), say that a user can revoke access at
// Google's security-permissions page (h), and say how to reach the owner (i); the Terms of Service link is III.A.1.
//
// WHERE THE EXPECTED VALUES COME FROM. The three URLs are the policy's own literals (developers.google.com/youtube/terms/
// developer-policies, re-read 2026-10-29): the rulebook, not our constants, so a constant that drifts from the policy reds here.
// The day counts are read from the declarations in server/youtube/daily.ts (the one authority for the 30-day ceiling and the 25-day
// re-confirmation), never typed into this file, so moving a constant moves the policy text's test with it.
//
// The page is static English like the rest of /legal (the sibling tests pin its sentences the same way): no dictionary is involved.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";

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
    // The two numbers are different facts: a page that said the ceiling twice could not be told from one that said both.
    expect(REFRESH).not.toBe(CEILING);
    expect(REFRESH).toBeLessThan(CEILING);
  });

  /** The seven things DP III.A.2 (with the override on disconnect) owes the page. Each is a predicate over the section; `ran` proves each
   *  one was evaluated, so a renamed id that empties `yt` cannot leave a vacuous green. */
  const ran = new Set<string>();
  const ITEMS: [string, () => string[]][] = [
    // Each predicate returns what is MISSING; [] is a pass.
    ["says Seazn uses YouTube API Services (III.A.2.b)", () => ["Seazn Club uses YouTube API Services"].filter((n) => !ytText.includes(n))],
    ["links Google's privacy policy (III.A.2.c)", () => [`href="${POLICY_GOOGLE_PRIVACY}"`].filter((n) => !yt.includes(n))],
    ["links Google's security-permissions page to revoke (III.A.2.h)", () => [`href="${POLICY_PERMISSIONS}"`].filter((n) => !yt.includes(n))],
    ["links the YouTube Terms of Service (III.A.1) and says users are bound by them", () =>
      [`href="${POLICY_YOUTUBE_TOS}"`].filter((n) => !yt.includes(n)).concat(["agree to be bound by the YouTube Terms of Service"].filter((n) => !ytText.includes(n)))],
    ["names what is accessed, stored, used and shared, and how long it is kept (III.A.2.d/e, III.E.4)", () => {
      // PER BULLET: a needle that also appears in another bullet or paragraph (the refresh token is named three times) would let
      // its own bullet lose it unseen.
      const bullet = (label: string) => text(yt.match(new RegExp(`<li><strong>${label}</strong>.*?</li>`))?.[0] ?? "");
      const WANT: [label: string, needles: string[]][] = [
        ["What we access:", ["id and title", "live broadcasts and live streams"]],
        ["What we store:", ["channel id and title", "refresh token (encrypted at rest)", "its id, which is also its video id, and its title", "stream keys"]],
        ["How we use it:", ["only to stream", "replay link", "do not sell it"]],
        ["Who it is shared with:", ["Google", "We share it with no one else"]],
        ["How long we keep it:", [
          "refresh token", `refreshed or deleted within ${CEILING} days`, `after ${REFRESH} days`,
          `has not been confirmed within ${CEILING} days`, `nothing has used for ${CEILING} days`,
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
      expect(checked).toBe(16);
      return missing;
    }],
    ["says Disconnect deletes at once what was stored and asks Google to revoke", () =>
      ["Disconnecting deletes at once everything we stored from YouTube", "refresh token", "stream keys", "replay links", "channel id and title", "asks Google to revoke"]
        .filter((n) => !ytText.includes(n))
        .concat(/\b(7|seven) (calendar )?days\b/i.test(ytText) ? ["NO mention of a 7-day purge: Disconnect deletes at once"] : [])],
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
  it("a grant that stops working (revoked at Google) is deleted after the declared dead-grant window", () => {
    // The window is the ceiling by declaration: guard the assumption instead of commenting it.
    expect(dailySrc).toMatch(/export const YOUTUBE_DEAD_GRANT_PURGE_DAYS = YOUTUBE_DATA_CEILING_DAYS;/);
    expect(ytText).toContain(`not reconnected within ${CEILING} days`);
    expect(ytText).toContain("removed Seazn Club at Google");
  });

  it("a private broadcast is not shown on public match pages; a replay link is shown to anyone who can open the page", () => {
    expect(ytText).toContain("a broadcast that is private on YouTube is not shown there");
    expect(ytText).toContain("anyone who can open that page");
  });

  it("the device paragraph (III.A.2.g): nothing loads until the tap, a thumbnail only before it, Google's cookies after - and points at the Cookie Policy", () => {
    expect(ytText).toContain("Nothing from the player loads until you tap play");
    expect(ytText).toContain("only the video's thumbnail");
    expect(ytText).toContain("may store cookies or similar data on your device");
    expect(yt).toContain('href="/legal/cookie-policy"');
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
