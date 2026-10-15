import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// Final review I-4: online chess sends a player's camera video through Cloudflare RealtimeKit and keeps an OAuth
// token for their Lichess account. Both pages a data subject reads must say so: the sub-processor list names the
// processor, and the privacy policy says what is processed, who sees the video, and how long anything is kept.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import SubProcessorsPage from "../sub-processors/page";

const privacy = renderToStaticMarkup(<PrivacyPage />);
const subProcessors = renderToStaticMarkup(<SubProcessorsPage />);
/** The table row naming one service: from its name cell to the row's end. */
const rowOf = (html: string, name: string) => {
  const at = html.indexOf(`>${name}</td>`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</tr>", at));
};

describe("sub-processors — Cloudflare carries the match-room camera video (I-4)", () => {
  it("lists Cloudflare once, for RealtimeKit's camera video and Stream, with a location and a policy link", () => {
    const row = rowOf(subProcessors, "Cloudflare");
    expect(row, "a Cloudflare row").not.toBe("");
    expect(subProcessors.split(">Cloudflare</td>").length - 1, "exactly one").toBe(1);
    expect(row).toContain("RealtimeKit");
    expect(row).toContain("camera video");
    expect(row).toContain("Stream");
    expect(row).toContain("https://www.cloudflare.com/privacypolicy/");
  });

  it("is dated 14 October 2026", () => {
    expect(subProcessors).toContain("Last updated: 14 October 2026");
  });
});

describe("privacy — the online-chess camera and the Lichess account link (I-4)", () => {
  /** The section itself, so a sentence elsewhere on the page cannot satisfy it. */
  const section = (() => {
    const at = privacy.indexOf("Online chess: camera video and your Lichess account");
    return at < 0 ? "" : privacy.slice(at, privacy.indexOf("</section>", at));
  })();

  it("has its own section", () => {
    expect(section).not.toBe("");
  });

  it("is dated 15 October 2026: the camera sentence changed that day (D16 states the guarantee)", () => {
    expect(privacy).toContain("Last updated: 15 October 2026");
  });

  it("says what is processed: camera video during a match, the Lichess username and the OAuth token", () => {
    expect(section).toContain("Lichess username");
    expect(section).toContain("OAuth token");
    expect(section).toContain("encrypted");
    expect(section).toContain("camera video");
  });

  it("says that the opponent cannot see the camera - the one guarantee the page may make (D16, design §5.6.7) - and that organisers can watch both", () => {
    // Final re-review N-4 hedged this sentence to what the room was SET UP to show, because the player preset's
    // max_video_streams = 0 is a device limit, not a security boundary (camera-loader.ts). D16 changed the ground: each
    // player is in a meeting of their own, so there is no opponent stream to subscribe to. The sentence may now be
    // absolute (§5.6.7, "Copy"), and it is the ONE sentence of the bullet excepted from the absolutes check below.
    const GUARANTEE = "Your opponent can’t see your camera.";
    expect(section).toContain(GUARANTEE);
    const camera = section.slice(section.indexOf("Your camera:"), section.indexOf("</li>", section.indexOf("Your camera:")));
    expect(camera, "the camera bullet").not.toBe("");
    expect(camera, "the guarantee is in the camera bullet").toContain(GUARANTEE);
    // The hedged sentence it replaces is gone.
    expect(section).not.toContain("is not set up to show your video");
    // The rest of the bullet is still held to the rule: nothing else absolute.
    const rest = camera.replace(GUARANTEE, "");
    expect(rest, "the exception removed exactly the guarantee").not.toContain("can’t see your camera");
    for (const absolute of [/\bnever\b/i, /\bcannot\b/i, /\bcan&#x27;t\b/i, /\bcan’t\b/i, /\bguarantee/i]) expect(rest).not.toMatch(absolute);
    expect(section).toContain("can watch both players");
  });

  it("says how long each thing is kept: the video not recorded, the token until unlinked, the flags with the records", () => {
    expect(section).toContain("We do not record the video");
    expect(section).toContain("Unlinking");
    expect(section).toContain("competition&#x27;s records");
  });

  it("the claim 'we do not record the video' is held by the code: the meeting is created with a title alone, and no recording API is called", () => {
    // An assumption is a guard: if a recording is ever started, this fails beside the sentence it falsifies.
    const src = readFileSync(join(__dirname, "../../../server/external-play/video/realtimekit.ts"), "utf8");
    // D16: a meeting per player, so the title carries the side - the one literal that names the meeting.
    expect(src).toContain('{ method: "POST", body: { title: `seazn-fixture-${fixtureId}-${side}` } }');
    expect(src).not.toMatch(/record_on_start|\/recordings/);
  });
});
