import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// YouTube Connect T19 (parked from T16, controller override O2). The public match page shows a recorded match with YouTube's player,
// and a player may store things on a visitor's device, so the cookie policy has to say when. DP III.A.2.g asks the same of the privacy
// policy ("information on users' devices, including via cookies or similar technology").
//
// WHERE THE EXPECTED VALUES COME FROM. The two hosts the note names are read off the markup of the REAL player component
// (components/public-site/match-centre/replay-embed.tsx): the host its facade loads before a tap, and the host its iframe loads after
// one. The page is held to the component, not to a constant typed here, and the component's facade is held to "no player before a tap".
// The Google privacy URL is the policy's own literal (DP III.A.2.c). The page is static English like the rest of /legal.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import CookiePolicyPage from "../page";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ReplayStage } from "@/components/public-site/match-centre/replay-embed";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { PublicReplayPart } from "@/lib/youtube";

const POLICY_GOOGLE_PRIVACY = "http://www.google.com/policies/privacy"; // DP III.A.2.c, exactly as Google spells it (http)
// Not made for kids: the only kind of replay that is ever embedded (a made-for-kids one is a link out: see the made-for-kids cases).
const PART: PublicReplayPart = { partNo: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", madeForKids: false };

const stage = (mode: "facade" | "playing") =>
  renderToStaticMarkup(
    <DictProvider dict={uiEn as Dict} locale="en">
      <ReplayStage
        part={PART} mode={mode} multi={false} pageOrigin="https://seazn.club"
        onPlay={() => {}} iframeRef={{ current: null }} onFrameLoad={() => {}} openRef={{ current: null }}
      />
    </DictProvider>,
  );
/** The hosts a piece of markup would make a browser fetch: every `src="https://host/..."`. */
const sourceHosts = (markup: string): string[] => [...markup.matchAll(/\bsrc="(https:\/\/[^"/]+)/g)].map((m) => new URL(m[1]!).hostname);
const bare = (host: string) => host.replace(/^www\./, "");

const facade = stage("facade");
const playing = stage("playing");
const THUMB_HOSTS = sourceHosts(facade);
const PLAYER_HOSTS = sourceHosts(playing);

const html = renderToStaticMarkup(<CookiePolicyPage />);
/** Tags stripped, React's entity for an apostrophe decoded, whitespace collapsed. */
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const sections = html.split("<section").slice(1).map((s) => `<section${s.slice(0, s.indexOf("</section>"))}`);
const yt = sections.find((s) => s.startsWith('<section id="youtube-player"')) ?? "";
const ytText = text(yt);

describe("cookie policy — the embedded YouTube player (T19, O2)", () => {
  it("premises: the real component's facade loads one host, its player another, and the section exists", () => {
    expect(THUMB_HOSTS.length, "the facade loads a thumbnail").toBe(1);
    expect(PLAYER_HOSTS.length, "the playing state loads the iframe").toBe(1);
    expect(bare(THUMB_HOSTS[0]!)).not.toBe(bare(PLAYER_HOSTS[0]!));
    expect(yt, 'the section with id="youtube-player"').not.toBe("");
  });

  const ran = new Set<string>();
  const ITEMS: [string, () => void][] = [
    ["has its own section, headed 'YouTube replays'", () => {
      expect(text(yt.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1] ?? "")).toBe("YouTube replays");
    }],
    ["before a tap: only the thumbnail, from the host the facade really loads - and only what WE control is claimed (M4)", () => {
      expect(ytText).toContain("until you tap play");
      expect(ytText).toContain(`from ${bare(THUMB_HOSTS[0]!)}`);
      // What we can vouch for: the REPLAY sets no cookie of ours and loads no Google script or frame before the tap (the facade test and the
      // storage-API scan below hold it). F3b (final review M2): not "our page" - the rest of the public page carries the session cookie
      // and, if accepted, PostHog's, which the cookie table above lists; the sentence says so and the old absolute is gone.
      expect(ytText).toContain("the replay itself sets no cookie of ours and loads no Google script or player");
      expect(ytText).toContain("the rest of the page uses the cookies listed above");
      expect(ytText).not.toContain("our page sets no cookie");
      // What we cannot: whether Google's image server sets one. The old absolute is gone, and the request is said to reach Google.
      expect(ytText).not.toContain("no player, no script and no cookie");
      expect(ytText).toContain("that request reaches Google's servers with your IP address and browser details");
    }],
    ["after a tap: the privacy-enhanced player, from the host the iframe really loads, and Google may set its own cookies", () => {
      expect(ytText).toContain(`loaded from ${bare(PLAYER_HOSTS[0]!)}`);
      expect(ytText).toContain("Google may set its own cookies or similar storage on your device");
      expect(ytText).toContain("not ours");
      // F3f (final review M6): the player is third-party content from YouTube.
      expect(ytText).toContain("The player is third-party content from YouTube");
    }],
    ["links Google's privacy policy for what the player stores (DP III.A.2.c)", () => {
      expect(yt).toContain(`href="${POLICY_GOOGLE_PRIVACY}"`);
    }],
    ["the claim 'no player before a tap' is held by the component: the facade has no iframe or script, and loads only its thumbnail host", () => {
      expect(facade, "the facade is real markup").toContain('data-testid="replay-facade"');
      expect(facade).not.toContain("<iframe");
      expect(facade).not.toContain("<script");
      expect(playing, "and the tap is what mounts the player").toContain("<iframe");
    }],
    ["F3b: the claim 'the replay sets no cookie of ours' is held by the component - it reaches for no cookie or storage API (6 tokens checked)", () => {
      const source = readFileSync(join(__dirname, "../../../../components/public-site/match-centre/replay-embed.tsx"), "utf8");
      expect(source.length, "anti-vacuity: the component source was read").toBeGreaterThan(2000);
      const TOKENS = ["document.cookie", "localStorage", "sessionStorage", "indexedDB", "cookieStore", "navigator.sendBeacon"];
      let checked = 0;
      for (const token of TOKENS) {
        expect(source, `replay-embed.tsx must not use ${token}`).not.toContain(token);
        checked++;
      }
      expect(checked, "anti-vacuity: every token was tried").toBe(6);
      // The positive pair: the scan is looking at the file that renders the facade (it names the facade the markup above came from).
      expect(source).toContain('data-testid="replay-facade"');
    }],
  ];

  it.each(ITEMS)("%s", (name, run) => {
    ran.add(name);
    run();
  });

  it("checked === 6: every item was evaluated (zero checked is a failure)", () => {
    expect(ITEMS.length).toBe(6);
    expect(ran.size).toBe(6);
  });

  it("is dated 29 October 2026", () => {
    expect(text(html)).toContain("Last updated: 29 October 2026");
  });
});

describe("cookie policy — regression: the sections and the cookie table that existed before T19 still render", () => {
  const BEFORE: [heading: string, anchor: string][] = [
    ["What are cookies?", "Cookies are small text files stored on your device by your browser."],
    ["Cookies we set", "Keeps you logged in"],
    ["Third-party cookies", "We do not use advertising cookies."],
    ["Managing cookies", "Essential cookies are required for the service to function and cannot be disabled."],
    ["Contact", "Questions about cookies:"],
  ];
  const headingOf = (s: string) => text(s.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1] ?? "");

  it("keeps its five headings in order with the YouTube section after 'Third-party cookies' (5 checked)", () => {
    const titles = sections.map(headingOf);
    expect(titles).toEqual(["What are cookies?", "Cookies we set", "Third-party cookies", "YouTube replays", "Managing cookies", "Contact"]);
    let checked = 0;
    for (const [heading, anchor] of BEFORE) {
      const s = sections.find((x) => headingOf(x) === heading);
      expect(s, heading).toBeDefined();
      expect(text(s!), heading).toContain(anchor);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(5);
  });

  it("still lists the cookies we set", () => {
    const names = [...html.matchAll(/<td class="font-mono">([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(names.length, "anti-vacuity: the table was read").toBe(5);
    expect(names).toContain("seazn_session");
    expect(names).toContain("seazn_cookie_consent");
  });
});
