import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// YouTube Connect T19 fix round 1, F3 (DP III.A.1). Google's Developer Policies require an API client's OWN terms of use to state that, by
// using the client, users agree to be bound by the YouTube Terms of Service (and to link them). The Streaming page's consent copy says it
// at the moment of connecting; the Terms of Service page is where the client's terms live, so it has to say it too, and point at the
// privacy policy's YouTube section (what is accessed, stored, used, shared, how to revoke).
//
// WHERE THE EXPECTED VALUES COME FROM. The ToS URL is the policy's own literal (III.A.1, re-read 2026-10-29), not our constant, so a
// constant that drifts from the policy reds here. The pointer's fragment is checked against the id the REAL privacy page renders (both ends
// of the link), and the "Last updated" line against LEGAL_VERSION (the sibling privacy test's own rule: the version a consent stamp names
// is the date the page shows). The page is static English like the rest of /legal.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import TermsPage from "../terms/page";
import PrivacyPage from "../privacy/page";
import { LEGAL_VERSION } from "@/lib/legal";

const POLICY_YOUTUBE_TOS = "https://www.youtube.com/t/terms"; // III.A.1

const html = renderToStaticMarkup(<TermsPage />);
const privacyHtml = renderToStaticMarkup(<PrivacyPage />);
/** Tags stripped, React's entity for an apostrophe decoded, whitespace collapsed. */
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const sections = html.split("<section").slice(1).map((s) => `<section${s.slice(0, s.indexOf("</section>"))}`);
const headingOf = (s: string) => text(s.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1] ?? "").replace(/^\d+\.\s*/, "");
const yt = sections.find((s) => s.startsWith('<section id="youtube-live-streaming"')) ?? "";
const ytText = text(yt);

describe("terms — the YouTube Terms of Service sentence (T19 fix round 1 F3, DP III.A.1)", () => {
  it("premise: the section exists", () => {
    expect(yt, 'the section with id="youtube-live-streaming"').not.toBe("");
    expect(ytText.length, "it has real copy").toBeGreaterThan(150);
  });

  const ran = new Set<string>();
  const ITEMS: [string, () => string[]][] = [
    ["says using Seazn's YouTube features means agreeing to be bound by the YouTube Terms of Service", () =>
      ["agree to be bound by the YouTube Terms of Service"].filter((n) => !ytText.includes(n))],
    ["links the YouTube Terms of Service (the policy's URL)", () => [`href="${POLICY_YOUTUBE_TOS}"`].filter((n) => !yt.includes(n))],
    ["points at the privacy policy's YouTube section, and the page it points at has that id", () => {
      const missing: string[] = [];
      const href = yt.match(/href="(\/legal\/privacy#[^"]+)"/)?.[1];
      if (!href) return ["an href to /legal/privacy#<section>"];
      const id = href.split("#")[1]!;
      if (!privacyHtml.includes(`<section id="${id}"`)) missing.push(`<section id="${id}"> on the privacy page`);
      // The seam is the YouTube section itself, not any anchor that happens to exist.
      if (id !== "youtube-api-services") missing.push('the fragment "youtube-api-services"');
      return missing;
    }],
    ["is dated by LEGAL_VERSION, the version a consent stamp names", () => {
      const [y, m, d] = LEGAL_VERSION.split("-").map(Number);
      const shown = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
      return text(html).includes(`Last updated: ${shown}`) ? [] : [`Last updated: ${shown}`];
    }],
  ];

  it.each(ITEMS)("%s", (name, missing) => {
    ran.add(name);
    expect(missing(), `missing: ${name}`).toEqual([]);
  });

  it("checked === 4: every item was evaluated (zero checked is a failure)", () => {
    expect(ITEMS.length).toBe(4);
    expect(ran.size).toBe(4);
  });
});

describe("terms — regression: every section that existed before F3 still renders", () => {
  // Snapshot of /legal/terms as of b437ee5e73 (14 July 2026 text): each heading (number stripped: the YouTube section is inserted at 8 and
  // the later ones moved down one) with a sentence distinctive of its body.
  const BEFORE: [title: string, anchor: string][] = [
    ["Acceptance", "These Terms form a binding contract between you and Seazn Club."],
    ["Service description", "Seazn Club is a tournament management platform for sports clubs, academies, and events."],
    ["Accounts", "You must be at least 16 years old to create an account."],
    ["Subscriptions and billing", "Pro subscriptions are billed monthly in advance."],
    ["Entry-fee chargebacks", "Seazn Club covers Stripe's dispute fees."],
    ["Acceptable use", "Reverse-engineer, scrape, or abuse the API beyond normal use."],
    ["Your data", "You retain ownership of data you upload."],
    ["Availability and SLA", "We aim for high availability but do not guarantee uninterrupted access."],
    ["Limitation of liability", "is limited to the amount you paid us in the 12 months preceding the claim"],
    ["Termination", "You may close your account at any time from Settings → Account."],
    ["Governing law", "These Terms are governed by the laws of England and Wales."],
    ["Changes", "at least 14 days before they take effect"],
    ["Contact", "legal@seazn.club"],
  ];

  it("keeps all thirteen headings in order with the YouTube section after 'Your data'", () => {
    const titles = sections.map(headingOf);
    const want = [...BEFORE.slice(0, 7).map(([t]) => t), "YouTube live streaming", ...BEFORE.slice(7).map(([t]) => t)];
    expect(titles).toEqual(want);
  });

  it("numbers its sections 1..14 with no repeat or gap", () => {
    const numbers = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
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

  it("does not move a sentence of the old sections into the new one", () => {
    expect(ytText.length, "anti-vacuity: the YouTube section is there to be compared").toBeGreaterThan(150);
    for (const [, anchor] of BEFORE) expect(ytText).not.toContain(anchor);
  });
});
