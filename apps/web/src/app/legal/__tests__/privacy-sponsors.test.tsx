import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// R4 sponsors on stream, final review 2 m10: the privacy page says what the sponsor features keep, as they behave TODAY.
//   - Proof-of-play stills (S9): one still of the composed stream a moment after a sponsor card airs; it can show players.
//     Kept in the private `sponsor-frames` bucket with the showing's record (sponsor_airing_frames, keyed by the session),
//     shown only through the sponsor report link (S13/S14: created and revoked by the org) as a signed url
//     (REPORT_FRAME_TTL_SEC). Deleting the sponsor cascades its LINKS (V492) but sets the airing's sponsor null and leaves
//     the airing and its frame: nothing shows it again, and it is not deleted then. It goes with the organisation (V492:
//     org cascade, the tombstone drain removes the object), and a frame no airing row names is purged by the first daily
//     relay sweep that finds its session ended more than ORPHAN_FRAME_GRACE_MS ago (purgeOrphanFrames, step 7d): so
//     WITHIN the grace plus one sweep period (fix batch 3, B2 - the page used to say "one day after", the grace alone).
//   - Short links (S10): `/s/` keeps sha256(ip) in a window - CLICK_DEDUPE_WINDOW_SECONDS to count a repeat tap once, and
//     SPONSOR_LINK_MISS_LIMIT's window for a miss (the 429 budget). The raw IP is in no row and no key.
// The page is static English like the rest of /legal (the sibling tests pin its sentences the same way): no dictionary.
// Every duration is read from its DECLARATION and spoken through the table below, never typed beside the sentence, so
// moving a constant reds here until the page says the new value.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import { CLICK_DEDUPE_WINDOW_SECONDS } from "@/server/sponsors/clicks";
import { ORPHAN_FRAME_GRACE_MS } from "@/server/sponsors/airings";
import { REPORT_FRAME_TTL_SEC } from "@/server/sponsors/report";
import { SPONSOR_LINK_MISS_LIMIT } from "@/lib/rate-limit";

// The relay sweep's cadence is declared in apps/cron-worker, outside the Fly image's build context, so it is imported with
// a computed specifier tsc never resolves (the email-outbox route test's pattern); vitest loads the REAL schedule.
const cronSrc = (file: string) => new URL(`../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly { id: string; due: { kind: string } }[] };
const SWEEP = JOBS.find((j) => j.id === "relay-sweep");
/** The sweep's period, in seconds, from its `due` (a kind not listed here is a red that names it). */
const SWEEP_PERIOD_SECONDS: number = (() => {
  const period = ({ daily: 86_400, weekly: 7 * 86_400 } as Record<string, number>)[SWEEP?.due.kind ?? "missing"];
  if (period === undefined) throw new Error(`relay-sweep's due is ${JSON.stringify(SWEEP?.due)}: the page and this test owe its period`);
  return period;
})();

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'").replace(/&hellip;|&#8230;/g, "…").replace(/\s+/g, " ");
const page = text(renderToStaticMarkup(<PrivacyPage />));

/** How the page speaks a duration, in seconds. A constant moved to a value not listed here is a red that names it. */
const SPOKEN: Record<number, string> = { 60: "one minute", 3600: "an hour", 86_400: "one day", 172_800: "two days" };
const spoken = (seconds: number): string => {
  const words = SPOKEN[seconds];
  if (words === undefined) throw new Error(`no words for ${seconds} s: the page and this table both owe the new value`);
  return words;
};

/** The text from one label to the next ("" when either is missing), so a sentence elsewhere on the page cannot satisfy it. */
function between(from: string, to: string): string {
  const at = page.indexOf(from);
  const end = page.indexOf(to, at + from.length);
  return at < 0 || end < 0 ? "" : page.slice(at, end);
}

describe("privacy - the sponsor features (final review 2, m10)", () => {
  it("proof-of-play stills: captured when a card airs, can show players, private, shown only through the org's revocable report link, with when they are deleted", () => {
    const stills = between("Sponsor proof-of-play stills:", "Sponsor short links:");
    expect(stills.length, "anti-vacuity: the entry was found").toBeGreaterThan(200);
    for (const sentence of [
      "streams a match with the score overlay and one of its sponsors' cards appears on air, we capture one still picture of the stream",
      "The still can show players.",
      "kept in private storage with the record of that showing",
      "shown to that sponsor only through a private report link that the organisation creates and can revoke",
      `each view uses a web address that expires within ${spoken(REPORT_FRAME_TTL_SEC)}`,
      "Deleting the sponsor ends its report links, so its stills are no longer shown to anyone, but they stay with the organisation's records of its showings.",
      "They are deleted when the organisation's account is deleted",
      // The upper bound: the grace, then up to one sweep period until the sweep that finds it past the grace.
      `a still whose showing was never recorded is deleted within ${spoken(ORPHAN_FRAME_GRACE_MS / 1000 + SWEEP_PERIOD_SECONDS)} after the stream ends`,
    ]) {
      expect(stills, sentence).toContain(sentence);
    }
  });

  it("short links: a one-way SHA-256 hash of the IP, held for the dedupe window (and the miss window), the IP itself never stored", () => {
    const links = between("Sponsor short links:", "3. Legal basis");
    expect(links.length, "anti-vacuity: the entry was found").toBeGreaterThan(100);
    for (const sentence of [
      "when someone follows a sponsor's short link (seazn.club/s/…), we count the click.",
      `we keep a one-way SHA-256 hash of the visitor's IP address for ${CLICK_DEDUPE_WINDOW_SECONDS} seconds`,
      `for a link that does not exist, we keep the hash for ${spoken(SPONSOR_LINK_MISS_LIMIT.windowSeconds)}`,
      "The IP address itself is never stored.",
    ]) {
      expect(links, sentence).toContain(sentence);
    }
  });
});
