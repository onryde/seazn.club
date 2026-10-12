// T16 (spec §5.4, controller addendum 3) — registration states that a division
// plays online, and its camera requirement, on the ENTRIES step: BEFORE signup,
// not at T−10. The wire fields come from `publicRegistrationInfo`
// (registration-public-info.test.ts drives them against the database). The
// required case carries the owner-approved player notice verbatim
// (`onlineChess.camera.playerNotice`, camera-policy-copy.test.ts holds its
// wording); nothing here says the player is monitored — there is no mandatory
// observer (D8).
//
// Copy is read from each locale's own dictionary through the real translator.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
}));

import { DivisionCard } from "../division-card";
import type { DivisionLike } from "../types";
import type { PublicDivisionInfo } from "@/server/usecases/registrations";

const DIVISION: DivisionLike = {
  division_id: "div-1",
  name: "Online Open",
  entrant_kind: "individual",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: false,
  open: true,
  closed_reason: null,
  capacity: null,
  remaining: null,
  taken: 0,
  opens_at: null,
  closes_at: null,
  fee_cents: 0,
  free_agent_fee_cents: null,
  currency: "GBP",
  payment_method: "offline",
  form_fields: [],
  eligibility_note: null,
};
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const card = (o: Partial<DivisionLike>, imPlaying = true, locale: Loc = "en") => {
  current.locale = locale;
  return renderToStaticMarkup(<DivisionCard division={{ ...DIVISION, ...o }} locale={locale} selfEligibility={null} imPlaying={imPlaying} />);
};
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);

describe("the ENTRIES step states online play and the camera, before signup", () => {
  it("the empty case first: a division that does not play online says nothing about it (old wire too)", () => {
    let checked = 0;
    for (const o of [{ online_play: false, camera_policy: "off" as CameraPolicy }, { online_play: false, camera_policy: "required" as CameraPolicy }, {}]) {
      const h = card(o);
      expect(h, JSON.stringify(o)).toContain("Online Open");
      expect(h, JSON.stringify(o)).not.toContain('data-testid="division-online-play"');
      expect(h, JSON.stringify(o)).not.toContain('data-testid="division-camera-requirement"');
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("each camera policy, online: the online line always; required adds the duty and the approved notice; optional says optional; off says nothing about a camera", () => {
    let checked = 0;
    for (const policy of CAMERA_POLICIES) {
      const h = card({ online_play: true, camera_policy: policy });
      expect(h, policy).toContain('data-testid="division-online-play"');
      expect(h, policy).toContain(esc(s("en", "register.online.lichess")));
      if (policy === "off") {
        expect(h, policy).not.toContain('data-testid="division-camera-requirement"');
      } else {
        expect(h, policy).toContain(`data-testid="division-camera-requirement" data-policy="${policy}"`);
        expect(h, policy).toContain(esc(s("en", `register.camera.${policy}`)));
      }
      const notice = esc(s("en", "onlineChess.camera.playerNotice"));
      if (policy === "required") expect(h, policy).toContain(notice);
      else expect(h, `${policy}: the notice states a duty only 'required' carries`).not.toContain(notice);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared policy").toBe(CAMERA_POLICIES.length);
  });

  it("the seam: the server's own wire object (typed PublicDivisionInfo, so a renamed field fails tsc) renders the notice as handed", () => {
    const wire: PublicDivisionInfo = {
      ...DIVISION,
      slug: "online-open",
      sport_key: "boardgame",
      currency: "GBP",
      opens_at: null,
      closes_at: null,
      age_cutoff_month: null,
      age_cutoff_day: null,
      youth: false,
      waitlisted: 0,
      eligibility_note: null,
      online_play: true,
      camera_policy: "required",
    };
    current.locale = "en";
    const h = renderToStaticMarkup(<DivisionCard division={wire} locale="en" selfEligibility={null} imPlaying />);
    expect(h).toContain('data-testid="division-camera-requirement" data-policy="required"');
  });

  it("stated whoever is looking — information about the division, not a per-viewer verdict", () => {
    expect(card({ online_play: true, camera_policy: "required" }, false)).toContain(esc(s("en", "register.camera.required")));
  });

  it("every locale says it in its own words, and none says the player is monitored", () => {
    const MONITORED = /monitor|surveil|vigil|bewaak|toezicht|observ/i;
    let checked = 0;
    for (const loc of LOCALES) {
      const h = card({ online_play: true, camera_policy: "required" }, true, loc);
      for (const key of ["register.online.lichess", "register.camera.required", "register.camera.optional"]) {
        const text = s(loc, key);
        if (loc !== "en") expect(text, `${loc} ${key}: translated`).not.toBe(s("en", key));
        expect(text, `${loc} ${key}`).not.toMatch(MONITORED);
        if (key !== "register.camera.optional") expect(h, `${loc} ${key}`).toContain(esc(text));
        checked += 1;
      }
    }
    expect(checked).toBe(LOCALES.length * 3);
  });
});
