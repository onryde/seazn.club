// T16 fix round 1, I5 — the register page (force-dynamic) reads THIS viewer's Lichess link state, only when a
// division plays online, and hands it to the stepper; the consent step's card renders from it. On the way back from a
// link start it also reads the `?lichess=` outcome. Every other registration makes no read at all.
//
// The page is an async server component: called with its doors mocked, its returned tree walked (no DOM here).
// Single-sport by construction: only a boardgame division plays online.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const doors = vi.hoisted(() => ({
  info: vi.fn(),
  getCurrentUser: vi.fn(),
  getLichessLink: vi.fn(),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/server/usecases/registrations", () => ({ publicRegistrationInfo: (...a: unknown[]) => doors.info(...a) }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => doors.getCurrentUser() }));
// `lichessGrantPlays` is the REAL one: the page's verdict on a stored link is the seat gate's own predicate, and a double
// of it here would prove the double (a fixture on both ends). Only the link READ is a door.
vi.mock("@/server/usecases/external-accounts", async () => {
  const actual = await vi.importActual<typeof import("@/server/usecases/external-accounts")>("@/server/usecases/external-accounts");
  return { lichessGrantPlays: actual.lichessGrantPlays, PLAY_SCOPES: actual.PLAY_SCOPES, getLichessLink: (id: string) => doors.getLichessLink(id) };
});

import { RegisterStepper } from "@/components/public-site/register/register-stepper";
import { PLAY_SCOPES } from "@/server/usecases/external-accounts";
import RegisterPage from "../page";

const DIVISION = {
  division_id: "div-1", name: "Open Swiss", entrant_kind: "individual", category: null, age_min: null, age_max: null,
  requires_dob: false, requires_gender: false, allow_free_agents: false, open: true, closed_reason: null, capacity: null,
  remaining: null, taken: 0, opens_at: null, closes_at: null, fee_cents: 0, free_agent_fee_cents: null, currency: "gbp",
  payment_method: "offline", form_fields: [], eligibility_note: null,
};
const infoWith = (online: boolean) => ({
  competition: { id: "c1", name: "Autumn Rapid", slug: "autumn-rapid", starts_on: null, ends_on: null },
  org: { name: "Northfield Chess Club", slug: "northfield", logo_url: null },
  divisions: [{ ...DIVISION, online_play: online, camera_policy: "off" }],
});
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, out);
  else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}
async function stepperLichess(search: Record<string, string> = {}) {
  const root = await RegisterPage({
    params: Promise.resolve({ orgSlug: "northfield", competitionSlug: "autumn-rapid" }),
    searchParams: Promise.resolve(search),
  });
  const s = elements(root).filter((el) => el.type === RegisterStepper);
  expect(s, "anti-vacuity: the stepper is on the page").toHaveLength(1);
  return (s[0]!.props as { lichess?: unknown }).lichess;
}

beforeEach(() => {
  doors.info.mockReset();
  doors.getCurrentUser.mockReset().mockResolvedValue(null);
  doors.getLichessLink.mockReset().mockResolvedValue(null);
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
});
afterEach(() => void vi.unstubAllEnvs());

describe("register page — the viewer's Lichess link state (I5)", () => {
  it("the empty case first: no division plays online — null, and neither the session nor a link is read", async () => {
    doors.info.mockResolvedValue(infoWith(false));
    expect(await stepperLichess({ lichess: "linked" })).toBeNull();
    expect(doors.getCurrentUser).not.toHaveBeenCalled();
    expect(doors.getLichessLink).not.toHaveBeenCalled();
  });

  it("online, signed out: not linked, and no link read for nobody", async () => {
    doors.info.mockResolvedValue(infoWith(true));
    expect(await stepperLichess()).toEqual({ configured: true, linkedUsername: null, needsReconsent: false, flash: null });
    expect(doors.getLichessLink).not.toHaveBeenCalled();
  });

  it("online, signed in and linked, back from the start: who it is linked as, and the outcome", async () => {
    doors.info.mockResolvedValue(infoWith(true));
    doors.getCurrentUser.mockResolvedValue({ id: "u1" });
    doors.getLichessLink.mockResolvedValue({ username: "ada_okonkwo", externalUserId: "ada", scopes: [...PLAY_SCOPES], consentedAt: new Date("2026-10-01T00:00:00Z") });
    expect(await stepperLichess({ lichess: "linked" })).toEqual({ configured: true, linkedUsername: "ada_okonkwo", needsReconsent: false, flash: "linked" });
    expect(doors.getLichessLink.mock.calls).toEqual([["u1"]]);
  });

  // Owner ruling 2026-10-25: the card must know when the link cannot play, by the seat gate's own predicate.
  it("online, signed in, linked but the link cannot play (identity-only, or short of any one play scope): needsReconsent - the registration gate's own verdict", async () => {
    doors.info.mockResolvedValue(infoWith(true));
    doors.getCurrentUser.mockResolvedValue({ id: "u1" });
    const consentedAt = new Date("2026-10-01T00:00:00Z");
    const stored = [
      { label: "identity-only", scopes: [], consentedAt: null },
      { label: "scopes, no consent stamp", scopes: [...PLAY_SCOPES], consentedAt: null },
      ...PLAY_SCOPES.map((dropped) => ({ label: `without ${dropped}`, scopes: PLAY_SCOPES.filter((x) => x !== dropped), consentedAt })),
    ];
    let checked = 0;
    for (const link of stored) {
      doors.getLichessLink.mockResolvedValue({ username: "ada", externalUserId: "ada", scopes: link.scopes, consentedAt: link.consentedAt });
      expect(await stepperLichess(), link.label).toEqual({ configured: true, linkedUsername: "ada", needsReconsent: true, flash: null });
      checked++;
    }
    expect(checked, "anti-vacuity: rows swept").toBe(2 + PLAY_SCOPES.length);
    // The pair: a full grant, and a wider one, need nothing.
    for (const scopes of [[...PLAY_SCOPES], [...PLAY_SCOPES, "email:read"]]) {
      doors.getLichessLink.mockResolvedValue({ username: "ada", externalUserId: "ada", scopes, consentedAt });
      expect(await stepperLichess(), scopes.join(",")).toMatchObject({ linkedUsername: "ada", needsReconsent: false });
    }
  });

  it("a hand-typed ?lichess= value is not an outcome; an unconfigured server says so", async () => {
    doors.info.mockResolvedValue(infoWith(true));
    vi.stubEnv("LICHESS_CLIENT_ID", "");
    expect(await stepperLichess({ lichess: "<script>" })).toEqual({ configured: false, linkedUsername: null, needsReconsent: false, flash: null });
  });
});
