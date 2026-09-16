import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalPlayCta } from "../external-play-cta";
import { playUrlForStatus } from "@/server/external-play/public-view";
import type { PublicExternalPlay } from "@/server/external-play/public-view";

const msg = (key: string) => key;

describe("playUrlForStatus", () => {
  it("returns a play URL only for ready/live", () => {
    const base: PublicExternalPlay = {
      status: "ready",
      playUrl: "https://lichess.org/abc",
      whitePlayUrl: null,
      blackPlayUrl: null,
      lastError: null,
    };
    expect(playUrlForStatus(base)).toBe("https://lichess.org/abc");
    expect(playUrlForStatus({ ...base, status: "pending" })).toBeNull();
    expect(playUrlForStatus({ ...base, status: "needs_organiser" })).toBeNull();
    expect(playUrlForStatus({ ...base, status: "finished" })).toBeNull();
  });
});

describe("ExternalPlayCta", () => {
  it("renders Play on Lichess when ready", () => {
    const html = renderToStaticMarkup(
      <ExternalPlayCta
        externalPlay={{
          status: "ready",
          playUrl: "https://lichess.org/abc",
          whitePlayUrl: null,
          blackPlayUrl: null,
          lastError: null,
        }}
        scheduledLabel="Wed 12:00"
        msg={msg}
      />,
    );
    expect(html).toContain('data-testid="external-play-cta"');
    expect(html).toContain("https://lichess.org/abc");
    expect(html).toContain("externalPlay.playOnLichess");
  });

  it("renders waiting copy when pending", () => {
    const html = renderToStaticMarkup(
      <ExternalPlayCta
        externalPlay={{
          status: "pending",
          playUrl: null,
          whitePlayUrl: null,
          blackPlayUrl: null,
          lastError: null,
        }}
        scheduledLabel="Wed 12:00"
        msg={msg}
      />,
    );
    expect(html).toContain('data-testid="external-play-waiting"');
    expect(html).not.toContain("lichess.org");
  });

  it("renders needs-organiser messaging", () => {
    const html = renderToStaticMarkup(
      <ExternalPlayCta
        externalPlay={{
          status: "needs_organiser",
          playUrl: "https://lichess.org/abc",
          whitePlayUrl: null,
          blackPlayUrl: null,
          lastError: "abort",
        }}
        scheduledLabel={null}
        msg={msg}
      />,
    );
    expect(html).toContain('data-testid="external-play-needs-organiser"');
    expect(html).toContain("externalPlay.needsOrganiser");
    expect(html).not.toContain('data-testid="external-play-cta"');
  });

  it("names delay clocks when that is why the organiser is needed", () => {
    const html = renderToStaticMarkup(
      <ExternalPlayCta
        externalPlay={{
          status: "needs_organiser",
          playUrl: null,
          whitePlayUrl: null,
          blackPlayUrl: null,
          lastError: "delay_unsupported",
        }}
        scheduledLabel={null}
        msg={msg}
      />,
    );
    expect(html).toContain("externalPlay.reason.delayUnsupported");
  });
});
