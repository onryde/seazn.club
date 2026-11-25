// "Open in app" links (spec 2026-11-25 §5.5). `/app/(stream|score|day)#<fragment>` carries a LIVE credential after the `#`:
// the capture QR text as base64url (stream), a device-link token (score) or a Match Day code (day). The signed-in page that
// holds the anchor runs analytics, so the fragment must not survive `scrubScoreUrl`, plain or percent-encoded at any depth.
// BARE_TOKEN already catches a `dl_` / `md_` secret; the stream fragment has no prefix, so only the /app rules see it.
//
// The links are built by the app's own builders (lib/open-in-app.ts) over the app's own QR text (`captureQrV2Text`), and
// `$elements_chain` is built by the installed posthog-js, not typed here.
//
// Sport: not applicable — an app link is sport-agnostic.
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import { captureQrV2Text } from "../capture-qr";
import { dayAppLink, scoreAppLink, streamAppLink } from "../open-in-app";
import { holdsCredential, posthogBeforeSend, scrubScoreUrl } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const qr = { v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22) } as const;
/** A fixture's code (four keys) and a court code's (`exp` fifth). */
const stream = streamAppLink(ORIGIN, captureQrV2Text(qr));
const courtStream = streamAppLink(ORIGIN, captureQrV2Text({ ...qr, exp: 1_764_000_000 }));
const score = scoreAppLink(ORIGIN, `dl_${"b".repeat(43)}`);
const day = dayAppLink(ORIGIN, `${ORIGIN}/day/md_${"c".repeat(43)}`)!;

const LINKS = [
  ["stream", stream],
  ["stream (court code)", courtStream],
  ["score", score],
  ["day", day],
] as const;
const KINDS = ["stream", "score", "day"] as const;
/** A fragment no other rule knows: if it goes, the /app rule (and its pre-check trigger) took it. */
const PLAIN_FRAGMENT = "abcDEF_-123";

const fragmentOf = (link: string) => link.slice(link.indexOf("#") + 1);
const kindOf = (link: string) => /\/app\/([a-z]+)#/.exec(link)![1]!;
const encode = (value: string, depth: number): string => (depth === 0 ? value : encode(encodeURIComponent(value), depth - 1));

describe("the fixtures witness the new rules", () => {
  it("the stream fragment and the plain fragment are invisible to every other rule", () => {
    for (const fragment of [fragmentOf(stream), fragmentOf(courtStream), PLAIN_FRAGMENT]) {
      expect(fragment.length).toBeGreaterThan(8);
      expect(scrubScoreUrl(`${ORIGIN}/elsewhere#${fragment}`)).toBe(`${ORIGIN}/elsewhere#${fragment}`);
    }
  });
});

describe("a plain /app link", () => {
  it.each(KINDS)("%s: any fragment is replaced", (kind) => {
    expect(scrubScoreUrl(`${ORIGIN}/app/${kind}#${PLAIN_FRAGMENT}`)).toBe(`${ORIGIN}/app/${kind}#[token]`);
    expect(scrubScoreUrl(`/app/${kind}#${PLAIN_FRAGMENT}`)).toBe(`/app/${kind}#[token]`);
  });

  it.each(LINKS)("%s: the built link loses its whole fragment, and a second pass changes nothing", (_name, link) => {
    const out = scrubScoreUrl(link);
    expect(out).toBe(`${ORIGIN}/app/${kindOf(link)}#[token]`);
    expect(scrubScoreUrl(out)).toBe(out);
  });

  it("the whole fragment goes, a part after a `.`, `&`, `/`, `=` or `?` too", () => {
    expect(scrubScoreUrl(`${ORIGIN}/app/stream#ab.cd&e=f/g?h`)).toBe(`${ORIGIN}/app/stream#[token]`);
  });

  it("a prefix run inside a stream fragment does not leave the front of it behind", () => {
    for (const prefix of ["dl_", "md_", "qm_"]) {
      expect(scrubScoreUrl(`${ORIGIN}/app/stream#eyJ2${prefix}${"z".repeat(40)}`)).toBe(`${ORIGIN}/app/stream#[token]`);
    }
  });

  it("stops where the string around it goes on: a space, a quote, an angle bracket, a backslash", () => {
    for (const tail of [" failed", '" x', "' x", "<br>", '\\" x']) {
      expect(scrubScoreUrl(`see ${ORIGIN}/app/stream#${PLAIN_FRAGMENT}${tail}`)).toBe(`see ${ORIGIN}/app/stream#[token]${tail}`);
    }
  });

  it("every link in one string goes", () => {
    expect(scrubScoreUrl(`a /app/stream#${PLAIN_FRAGMENT} b /app/day#${PLAIN_FRAGMENT}`)).toBe("a /app/stream#[token] b /app/day#[token]");
  });
});

describe("a percent-encoded /app link", () => {
  it("inside another URL, at depth 1 to 3, in either hex case", () => {
    let checked = 0;
    for (const [, link] of LINKS) {
      for (const depth of [1, 2, 3]) {
        const encoded = encode(link, depth);
        for (const value of [encoded, encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())]) {
          const out = scrubScoreUrl(`/x?next=${value}&keep=1`);
          expect(out).not.toContain(fragmentOf(link));
          expect(out).toContain("[token]&keep=1");
          expect(scrubScoreUrl(out)).toBe(out);
          checked++;
        }
      }
    }
    expect(checked).toBe(LINKS.length * 3 * 2);
  });

  it.each(KINDS)("%s: a fragment only the encoded rule can see, and only the fragment goes", (kind) => {
    for (const depth of [1, 2, 3]) {
      const wrap = (fragment: string) => `/x?next=${encode(`/app/${kind}#${fragment}`, depth)}&keep=1`;
      expect(scrubScoreUrl(wrap(PLAIN_FRAGMENT))).toBe(wrap(PLAIN_FRAGMENT).replace(PLAIN_FRAGMENT, "[token]"));
    }
  });

  it("ends at the next encoded delimiter, so the carrying URL's own nested parameters stay", () => {
    const nested = encodeURIComponent(`/login?next=${encodeURIComponent(`/app/stream#${PLAIN_FRAGMENT}`)}&lang=fr`);
    expect(scrubScoreUrl(`/x?r=${nested}`)).toBe(`/x?r=${nested.replace(PLAIN_FRAGMENT, "[token]")}`);
  });

  it("only the `#` encoded (a client that escaped it, so the credential is in the path) goes too", () => {
    for (const hash of ["%23", "%2523"]) {
      expect(scrubScoreUrl(`${ORIGIN}/app/stream${hash}${PLAIN_FRAGMENT}`)).toBe(`${ORIGIN}/app/stream${hash}[token]`);
    }
  });
});

describe("holdsCredential", () => {
  it("is true for every built link, plain and encoded", () => {
    let checked = 0;
    for (const [, link] of LINKS) {
      for (const depth of [0, 1, 2]) {
        expect(holdsCredential(`/x?next=${encode(link, depth)}`)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(LINKS.length * 3);
  });

  it("leaves addresses that are not an app link alone", () => {
    const clean = [
      `${ORIGIN}/product/streaming#try`,
      `${ORIGIN}/app/stream`,
      `${ORIGIN}/app/score#`,
      `${ORIGIN}/app/streaming#try`,
      `${ORIGIN}/app/days#try`,
      `${ORIGIN}/app/settings#try`,
      `${ORIGIN}/apps/stream#try`,
      `${ORIGIN}/webapp/stream#try`,
      `/x?next=${encodeURIComponent("/product/streaming#try")}`,
      `/x?next=${encodeURIComponent("/app/stream")}`,
      `/x?next=${encodeURIComponent("/app/streaming#try")}`,
      `/x?next=${encodeURIComponent("/webapp/stream#try")}`,
    ];
    for (const url of clean) {
      expect(scrubScoreUrl(url)).toBe(url);
      expect(holdsCredential(url)).toBe(false);
    }
    expect(clean.length).toBeGreaterThan(0);
  });
});

/** posthog-js's own serialiser for `$elements_chain` (autocapture always sends it; `$elements` only when the project does not
 *  ask for the string form). */
const require_ = createRequire(import.meta.url);
const { getElementsChainString } = require_(path.join(path.dirname(require_.resolve("posthog-js/package.json")), "lib/src/autocapture-utils.js")) as {
  getElementsChainString: (elements: Record<string, unknown>[]) => string;
};

describe("a PostHog autocapture event of a click on the anchor", () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it.each(LINKS)("%s: $elements, $elements_chain, $external_click_url and the URLs are clean", (_name, link) => {
    const elements = [
      { tag_name: "a", attr__href: link, $el_text: "Open in app", attr__rel: "noreferrer", nth_child: 1, nth_of_type: 1 },
      { tag_name: "div", attr__class: "ph-card", nth_child: 2, nth_of_type: 1 },
    ];
    const chain = getElementsChainString(elements);
    // The premise: the SDK writes the href into the chain TWICE (its own `href` and the `attr__href` attribute), quoted.
    expect(count(chain, `href="${link}"`)).toBe(2);

    const event = {
      uuid: "01990000-0000-7000-8000-000000000000",
      event: "$autocapture",
      properties: {
        $current_url: link,
        $pathname: "/o/club/c/cup",
        $elements: elements,
        $elements_chain: chain,
        $external_click_url: link,
      },
    } as unknown as CaptureResult;
    const planted = count(JSON.stringify(event), fragmentOf(link));
    expect(planted).toBe(5);

    const result = posthogBeforeSend(event)!;
    const text = JSON.stringify(result);
    expect(text).not.toContain(fragmentOf(link));
    const placeholder = `/app/${kindOf(link)}#[token]`;
    expect(count(text, placeholder)).toBe(planted);
    // Only the fragment changed: the chain keeps its quoting and every other attribute.
    expect(result.properties.$elements_chain).toBe(chain.split(link).join(`${ORIGIN}${placeholder}`));
  });
});
