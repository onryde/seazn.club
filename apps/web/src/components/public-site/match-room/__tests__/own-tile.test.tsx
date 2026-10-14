// T14 — the player's OWN camera tile (canvas: dark tile, "You · mic off").
// Local preview only; the stream arrives from use-own-camera, never a token.
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
});
