// T17B fix 1 — the player's match room is the one document that may use the camera.
//
// next.config.js sends `Permissions-Policy: camera=(), …` site-wide. Inherited by the room, it blocked
// getUserMedia (Chrome: "camera is not allowed in this document"), so a `required` board could never seat and
// no game was ever made — and every camera e2e stayed green, because none of them read the served header.
//
// This resolves the headers a path is served with the way Next does: each rule is matched with Next's OWN route
// builder (router-utils/filesystem buildCustomRoute, the matcher the server uses), in config order, and a later
// rule's key REPLACES an earlier one (resolve-routes: `resHeaders[key] = value`). The browser half — the served
// header on a real response, and `allowsFeature('camera')` in the document — is match-room.spec.ts's.
import { describe, expect, it } from "vitest";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import { nextConfig } from "../../../next.config.js";
import { routes } from "@/lib/routes";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/** The headers next.config serves `pathname` with, and how many rules matched (anti-vacuity). */
async function servedHeaders(pathname: string): Promise<{ headers: Record<string, string>; matched: number }> {
  const rules = (await (nextConfig as { headers: () => Promise<HeaderRule[]> }).headers()) ?? [];
  const headers: Record<string, string> = {};
  let matched = 0;
  for (const rule of rules) {
    if (buildCustomRoute("header", rule).match(pathname) === false) continue;
    matched += 1;
    for (const h of rule.headers) headers[h.key] = h.value;
  }
  return { headers, matched };
}

const policyKeys = (h: Record<string, string>) => Object.keys(h).filter((k) => k.toLowerCase() === "permissions-policy");

// Literals from the T17B ruling, never read from next.config: the room's own player's camera, for this document
// only (RealtimeKit calls getUserMedia in the page — no iframe); no microphone (players have no audio; the room
// joins with `audio: false`) and no location, anywhere.
const ROOM = "camera=(self), microphone=(), geolocation=()";
const ELSEWHERE = "camera=(), microphone=(), geolocation=()";
const ROOM_PATH = routes.sharedFixturePlay("club", "spring-open", "open", "0b9a4c1e-5d2f-4c1a-9e1e-1f2a3b4c5d6e");

describe("Permissions-Policy (T17B fix 1): the camera is the match room's, and only the room's", () => {
  it("the room's path is served camera=(self) — one Permissions-Policy header, never a second, stricter one beside it — and keeps every other security header", async () => {
    const { headers, matched } = await servedHeaders(ROOM_PATH);
    expect(matched, "premise — the catch-all and the room's own rule both match").toBeGreaterThanOrEqual(2);
    expect(policyKeys(headers), "one Permissions-Policy key").toEqual(["Permissions-Policy"]);
    expect(headers["Permissions-Policy"]).toBe(ROOM);
    expect(headers["X-Frame-Options"], "still not frameable").toBe("SAMEORIGIN");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("every other path keeps the camera off: the site, the board's own public page, the arbiter panel (it only receives), an embed, the room's API, and paths that merely look like the room — counted", async () => {
    const others = [
      "/",
      "/shared/club/spring-open/open/fixtures/0b9a4c1e-5d2f-4c1a-9e1e-1f2a3b4c5d6e",
      routes.sharedFixturePlay("club", "spring-open", "open", "f1").replace("/play", "/players"),
      "/o/club/c/spring-open/d/open/arbiter",
      "/embed/club/spring-open",
      "/api/v1/fixtures/0b9a4c1e-5d2f-4c1a-9e1e-1f2a3b4c5d6e/external-play/room",
      `${ROOM_PATH}/extra`,
      `${ROOM_PATH}x`,
      "/shared/club/spring-open/fixtures/f1/play",
    ];
    let checked = 0;
    for (const path of others) {
      const { headers, matched } = await servedHeaders(path);
      expect(matched, `${path}: premise — the catch-all matches`).toBeGreaterThanOrEqual(1);
      expect(policyKeys(headers), path).toEqual(["Permissions-Policy"]);
      expect(headers["Permissions-Policy"], path).toBe(ELSEWHERE);
      checked += 1;
    }
    expect(checked, "anti-vacuity: paths").toBe(others.length);
  });
});
