import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageResponse } from "next/og";
import { drawableImage } from "@/server/og/drawable";
import { CardFrame, OG_SIZE } from "@/server/og/card";
import { PostShareCard, postCardModel, STORY_SIZE } from "@/server/og/post-card";
import { ogTheme } from "@/server/og/model";

/**
 * The BACKSTOP, on its own.
 *
 * `share-image-surfaces.test.tsx` proves every live surface resolves its logo
 * through the fetcher. This file proves the layer underneath it: hand a satori
 * frame a URL DIRECTLY — the way a surface written next year, by someone who
 * has not read any of this, would — and it draws the card without a crest
 * rather than making the request.
 *
 * Without this, removing the guard from the frames is a mutant nothing kills:
 * the loaders pass a `data:` URI either way, so the two layers would be
 * covering for each other.
 */

const REMOTE = "https://cdn.attacker.example/logo.png";
const STORAGE = "https://projectref.supabase.co/storage/v1/object/public/assets/orgs/o1/logo.webp";
const BYTES =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("drawableImage", () => {
  it("passes bytes through", () => {
    expect(drawableImage(BYTES)).toBe(BYTES);
    expect(drawableImage("data:image/webp;base64,AAAA")).toBe("data:image/webp;base64,AAAA");
  });

  it("refuses everything satori would have to FETCH or resolve", () => {
    expect(drawableImage(REMOTE)).toBeNull();
    expect(drawableImage(STORAGE)).toBeNull();
    expect(drawableImage("http://cdn.example/logo.png")).toBeNull();
    expect(drawableImage("//cdn.example/logo.png")).toBeNull();
    expect(drawableImage("/assets/logo.png")).toBeNull();
    expect(drawableImage("data:text/html;base64,AAAA")).toBeNull();
    expect(drawableImage("")).toBeNull();
    expect(drawableImage(null)).toBeNull();
    expect(drawableImage(undefined)).toBeNull();
  });
});

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      // satori pulls its resvg wasm through fetch as a `data:` URI.
      if (url.startsWith("data:")) return real(input as RequestInfo, init);
      throw new Error(`the frame asked for ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const remoteRequests = () => requested.filter((u) => !u.startsWith("data:"));
const render = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("the shared satori frames refuse a URL handed to them directly", () => {
  it("CardFrame draws the masthead without a crest, and asks for nothing", async () => {
    const theme = ogTheme();
    const frame = (logo: string | null) =>
      new ImageResponse(
        (
          <CardFrame theme={theme} orgName="Southend Cricket Club" logo={logo}>
            <div style={{ display: "flex" }}>Southend Premier League</div>
          </CardFrame>
        ),
        OG_SIZE,
      );

    // The URL render is the one this test is NAMED for, so its requests are
    // read before anything is reset. Asserting after the reset — as this test
    // once did — only ever witnessed the null render.
    const withUrl = await render(frame(REMOTE) as unknown as Response);
    const askedForWithUrl = remoteRequests();
    requested = [];
    const withNothing = await render(frame(null) as unknown as Response);

    expect(askedForWithUrl).toEqual([]);
    expect(remoteRequests()).toEqual([]);
    // Identical to the card an org with no logo gets — no gap, no empty box.
    expect(withUrl.equals(withNothing)).toBe(true);
  });

  it("PostShareCard does the same", async () => {
    const card = (logo: string | null) =>
      new ImageResponse(
        <PostShareCard
          model={postCardModel({
            branding: [null],
            branded: false,
            orgName: "Southend Cricket Club",
            logo,
            kind: "news",
            title: "Season opens on Saturday",
          })}
          eyebrow="NEWS"
          size="story"
        />,
        STORY_SIZE,
      );

    // Same shape, same fix: read the URL render's requests before the reset.
    const withUrl = await render(card(REMOTE) as unknown as Response);
    const askedForWithUrl = remoteRequests();
    requested = [];
    const withNothing = await render(card(null) as unknown as Response);

    expect(askedForWithUrl).toEqual([]);
    expect(remoteRequests()).toEqual([]);
    expect(withUrl.equals(withNothing)).toBe(true);
  });

  it("…and both still DRAW a crest that arrived as bytes", async () => {
    // The anti-vacuous half: a frame that simply never drew a logo would pass
    // both tests above and the feature would be gone.
    const theme = ogTheme();
    const frame = (logo: string | null) =>
      new ImageResponse(
        (
          <CardFrame theme={theme} orgName="Southend Cricket Club" logo={logo}>
            <div style={{ display: "flex" }}>Southend Premier League</div>
          </CardFrame>
        ),
        OG_SIZE,
      );
    const withBytes = await render(frame(BYTES) as unknown as Response);
    const withNothing = await render(frame(null) as unknown as Response);
    expect(withBytes.equals(withNothing)).toBe(false);
    expect(remoteRequests()).toEqual([]);
  });
});
