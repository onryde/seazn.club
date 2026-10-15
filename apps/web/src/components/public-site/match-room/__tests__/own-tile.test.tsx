// T14 — the player's OWN camera tile (canvas: dark tile, "You · mic off").
// Local preview only; the stream arrives from use-own-camera, never a token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnTile } from "../own-tile";

const t = (key: string) => key;

describe("OwnTile", () => {
  it("declares the mic muted and says so in words (spec §5.3: chess needs no audio)", () => {
    const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} t={t} />);
    expect(html).toContain('data-testid="room-own-tile"');
    expect(html).toContain('data-mic="muted"');
    expect(html).toContain("externalPlay.room.micMuted");
  });

  it("the video element is muted and inline, and NEVER a monitoring claim (spec §5.4, D8)", () => {
    const html = renderToStaticMarkup(<OwnTile policy="optional" stream={null} t={t} />);
    expect(html).toMatch(/<video[^>]*muted/);
    expect(html).toMatch(/<video[^>]*playsInline|<video[^>]*playsinline/i);
    expect(html.toLowerCase()).not.toContain("monitor");
  });

  it("policy off renders nothing at all (no meeting exists, zero video spend)", () => {
    expect(renderToStaticMarkup(<OwnTile policy="off" stream={null} t={t} />)).toBe("");
  });

  it("the check-in variant shows the camera and mic chips instead of the room label — Camera on only while it is", () => {
    const on = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="checkin" cameraOn t={t} />);
    expect(on).toContain("externalPlay.room.checkin.cameraOn");
    expect(on).toContain("externalPlay.room.checkin.micOff");
    expect(on).not.toContain("externalPlay.room.micMuted");
    const off = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="checkin" cameraOn={false} t={t} />);
    expect(off, "never claims a camera that is not on").not.toContain("externalPlay.room.checkin.cameraOn");
    expect(off).toContain("externalPlay.room.checkin.micOff");
  });

  it("no participant or auth token can reach the markup — the tile takes a stream, not a token", () => {
    // Structural: the props type has no token field; a stray one is ignored.
    const html = renderToStaticMarkup(
      <OwnTile policy="required" stream={null} t={t} {...({ participant: { authToken: "jwt-secret" } } as object)} />,
    );
    expect(html).not.toContain("jwt-secret");
  });

  // T17B fix 2, D23: the frozen frame between Check in's stop and the SDK's first frame. D23-fix: the picture can go
  // while the words stay (`connecting`), and the words are announced by an always-mounted live region.
  describe("the hand-over cover (D23)", () => {
    const frame = {} as HTMLCanvasElement;
    const announce = (html: string) => /<span[^>]*data-testid="room-own-tile-announce"[^>]*>([^<]*)<\/span>/.exec(html);
    const WORDS = "externalPlay.room.checkin.connecting";

    it("with no cover (the empty case) nothing is laid over the tile — and the live region is already there, empty", () => {
      for (const variant of ["checkin", "room"] as const) {
        const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant={variant} t={t} />);
        expect(html, variant).not.toContain("room-own-tile-frozen");
        expect(html, variant).not.toContain(WORDS);
        const live = announce(html);
        expect(live, `${variant}: always mounted, so a screen reader hears the words when they arrive`).not.toBeNull();
        expect(live![1], variant).toBe("");
        expect(live![0], variant).toMatch(/role="status"/);
        expect(live![0], variant).toMatch(/class="[^"]*\bsr-only\b/);
      }
    });

    it("a cover is laid over the tile and says it is connecting — at check-in and in the room; the live region carries the same words", () => {
      for (const variant of ["checkin", "room"] as const) {
        const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant={variant} frozen={frame} t={t} />);
        expect(html, variant).toContain('data-testid="room-own-tile-frozen"');
        expect(html, variant).toMatch(/data-testid="room-own-tile-connecting"[^>]*>externalPlay\.room\.checkin\.connecting</);
        expect(announce(html)![1], `${variant}: announced`).toBe(WORDS);
        // Said once to a screen reader: the visible chip is hidden from them, the live region speaks.
        expect(/<span[^>]*data-testid="room-own-tile-connecting"[^>]*>/.exec(html)![0], variant).toMatch(/aria-hidden="true"/);
      }
    });

    it("the words alone (the picture's bound passed) still cover the tile: no picture, the chip, the announcement", () => {
      for (const variant of ["checkin", "room"] as const) {
        const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant={variant} connecting t={t} />);
        expect(html, variant).toContain('data-testid="room-own-tile-frozen"');
        expect(html, variant).not.toContain("<canvas");
        expect(html, variant).toMatch(/data-testid="room-own-tile-connecting"[^>]*>externalPlay\.room\.checkin\.connecting</);
        expect(announce(html)![1], variant).toBe(WORDS);
      }
    });

    it("the cover sits ABOVE the video and the silhouette, and BELOW the chips (source order decides the stack)", () => {
      const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="checkin" cameraOn frozen={frame} t={t} />);
      const at = (needle: string) => html.indexOf(needle);
      expect(at("<video")).toBeGreaterThan(-1);
      expect(at('data-testid="room-own-tile-frozen"')).toBeGreaterThan(at("<video"));
      expect(at('data-testid="room-own-tile-frozen"')).toBeLessThan(at("externalPlay.room.checkin.micOff"));
    });

    it("inside the cover the picture comes FIRST and the words after it — a later sibling paints over an earlier one", () => {
      const html = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="checkin" frozen={frame} t={t} />);
      const picture = html.indexOf("<canvas");
      const words = html.indexOf('data-testid="room-own-tile-connecting"');
      expect(picture, "premise: the picture is a canvas").toBeGreaterThan(-1);
      expect(words, "premise: the words are a chip").toBeGreaterThan(-1);
      expect(picture).toBeLessThan(words);
      // The picture is mirrored and cropped as the live video is (same classes), so the cover and the camera line up.
      const videoClass = /<video[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
      const canvasClass = /<canvas[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
      for (const c of ["-scale-x-100", "object-cover", "inset-0", "h-full", "w-full"]) {
        expect(videoClass.split(" "), `video ${c}`).toContain(c);
        expect(canvasClass.split(" "), `canvas ${c}`).toContain(c);
      }
    });

    it("the phone's small tile does not DRAW the words (no room for a sentence — the live region still speaks them); the check-in and desktop tiles show them", () => {
      const chip = (html: string) => /<span[^>]*data-testid="room-own-tile-connecting"[^>]*>/.exec(html)![0];
      const room = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="room" frozen={frame} t={t} />);
      expect(chip(room)).toMatch(/class="[^"]*\smax-md:hidden\b/);
      expect(announce(room)![1], "announced all the same").toBe(WORDS);
      const checkin = renderToStaticMarkup(<OwnTile policy="required" stream={null} variant="checkin" frozen={frame} t={t} />);
      expect(chip(checkin)).not.toMatch(/max-md:hidden|sr-only/);
    });

    it("the words exist in every locale, each its own (the brief's English typed from it)", () => {
      const LOCALES = ["en", "es", "fr", "nl"] as const;
      const seen = new Set<string>();
      let checked = 0;
      for (const l of LOCALES) {
        const d = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
        const copy = d["externalPlay.room.checkin.connecting"];
        expect(typeof copy === "string" && copy.length > 0, l).toBe(true);
        seen.add(copy!);
        checked += 1;
      }
      expect(checked).toBe(LOCALES.length);
      expect(seen.size, "four locales, four sentences").toBe(LOCALES.length);
      const en = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Record<string, string>;
      expect(en["externalPlay.room.checkin.connecting"]).toBe("Connecting your camera…");
    });

    it("policy off draws no tile at all, cover or not — and no live region", () => {
      expect(renderToStaticMarkup(<OwnTile policy="off" stream={null} frozen={frame} t={t} />)).toBe("");
      expect(renderToStaticMarkup(<OwnTile policy="off" stream={null} connecting t={t} />)).toBe("");
    });
  });
});
