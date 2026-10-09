import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalPlayCta } from "../external-play-cta";
import type { PublicExternalPlay } from "@/server/external-play/public-view";

const msg = (key: string) => key;
const render = (status: PublicExternalPlay["status"]) =>
  renderToStaticMarkup(<ExternalPlayCta externalPlay={{ status }} scheduledLabel="Wed 12:00" msg={msg} />);

// D3 deleted the lichess.org mode: no status puts a Lichess play link on the
// public page. Swept over every status the type declares, counted.
const STATUSES: PublicExternalPlay["status"][] = ["pending", "ready", "live", "finished", "needs_organiser"];

describe("ExternalPlayCta", () => {
  it("never renders a Lichess play link, for any status", () => {
    let checked = 0;
    for (const status of STATUSES) {
      const html = render(status);
      expect(html, status).not.toContain('data-testid="external-play-cta"');
      expect(html, status).not.toContain("lichess.org");
      expect(html, status).not.toContain("externalPlay.playOnLichess");
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared status").toBe(5);
  });

  it("renders waiting copy when pending", () => {
    expect(render("pending")).toContain('data-testid="external-play-waiting"');
  });

  it("renders the generic needs-organiser message — never a reason from last_error", () => {
    const html = render("needs_organiser");
    expect(html).toContain('data-testid="external-play-needs-organiser"');
    expect(html).toContain("externalPlay.needsOrganiser");
    expect(html).not.toContain("externalPlay.reason.");
  });

  it("renders nothing once the game is on the board or over", () => {
    let checked = 0;
    for (const status of ["ready", "live", "finished"] as const) {
      expect(render(status), status).toBe("");
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
