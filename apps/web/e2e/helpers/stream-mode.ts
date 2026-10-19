// R2006 (owner ruling 2026-10-19, "Option C"): a fixture streams the SCORE by default wherever the score can stream — the
// organiser's Go live, the phone's own start and the automatic start all read the stored mode through
// `effectiveStreamMode` (src/lib/stream-settings.ts). CI's e2e-parallel job names a dummy compositor image (e2e.yml), so
// there every start is composed unless the fixture stores "Camera only".
//
// A walkthrough that follows the CAMERA's lifecycle — the phone publishing makes the session live, its input dying makes
// it lost — stores Camera only on the fixtures it starts, through the organiser's real settings route. The composed
// default itself is driven end to end by overlay-compositor.spec.ts. On a server with no compositor image (e2e-serial,
// e2e-mobile) the stored mode changes nothing: the camera was the only thing that could stream.
import { expect, type APIRequestContext } from "@playwright/test";
import { apiJson } from "../helpers";

/** Stores "Camera only" (`streamMode: "passthrough"`) on each fixture and proves the answer says so. Returns how many it
 *  stored; an empty list is a failure, never a no-op (TEST-STRATEGY anti-vacuity). */
export async function storeCameraOnly(request: APIRequestContext, fixtureIds: readonly string[]): Promise<number> {
  expect(fixtureIds.length, "storeCameraOnly: at least one fixture to store Camera only on").toBeGreaterThan(0);
  let stored = 0;
  for (const id of fixtureIds) {
    const res = await apiJson<{ streamMode: string | null }>(request, `/api/v1/fixtures/${id}/stream-settings`, "PUT", { streamMode: "passthrough" });
    expect(res.status, `PUT stream-settings {streamMode: "passthrough"} on ${id}: ${JSON.stringify(res.error)}`).toBe(200);
    expect(res.data?.streamMode, "the answer is the stored mode").toBe("passthrough");
    stored++;
  }
  return stored;
}
