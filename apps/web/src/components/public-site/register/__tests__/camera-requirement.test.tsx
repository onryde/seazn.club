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
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
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
  // DivisionCard now reads usePlural for its places-left line (B3 T12); this file renders cards with no capacity.
  usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS[current.locale as Loc], key, count, current.locale as Loc, vars),
}));

import { DivisionCard } from "../division-card";
import { StepConsent } from "../step-consent";
import { selectedCameraRequirements } from "../online-play-note";
import { EMPTY_CART } from "../types";
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

  // M6 (T16 fix round 1): the canvas (RegisterEntriesPhone) and the brief give the notice the house amber when the
  // camera is REQUIRED — a duty — and the quiet lavender otherwise; never the sky blue it shipped with.
  it("M6: the notice's tone follows the duty — amber when the camera is required, lavender otherwise, never sky", () => {
    const AMBER = ["bg-[#fef3c7]", "border-[#f5d27a]", "text-[#713f12]"];
    const LAVENDER = ["bg-[#f3effc]", "text-[#4a3a6b]"];
    let checked = 0;
    for (const policy of CAMERA_POLICIES) {
      const h = card({ online_play: true, camera_policy: policy });
      const cls = /data-testid="division-online-play"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-testid="division-online-play"/.exec(h);
      const classes = (cls?.[1] ?? cls?.[2] ?? "").split(/\s+/);
      expect(classes.length > 1, `${policy}: the notice's classes were read`).toBe(true);
      for (const c of policy === "required" ? AMBER : LAVENDER) expect(classes, `${policy}: ${c}`).toContain(c);
      for (const c of policy === "required" ? LAVENDER : AMBER) expect(classes, `${policy}: not ${c}`).not.toContain(c);
      expect(classes.some((c) => c.includes("sky")), `${policy}: no sky`).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(CAMERA_POLICIES.length);
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

// Walk-fix F4: a single-division competition skips ENTRIES, so the division card above never renders there - CONSENT
// states the camera requirement instead, in the same words and tones (the stepper's wiring is pinned in
// register-stepper-interaction.test.tsx, "the camera requirement on CONSENT").
describe("the CONSENT step states the camera requirement of each selected online division", () => {
  const consent = (cameraRequirements: { name: string; policy: "required" | "optional" }[] | undefined, locale: Loc = "en") => {
    current.locale = locale;
    return renderToStaticMarkup(
      <StepConsent
        contact={{ name: "", email: "", phone: null, dob: null, gender: null, guardian_name: null, guardian_consent: false } as never}
        onContactChange={() => undefined}
        consent={{ privacy_consent: false, media_consent: false } as never}
        onConsentChange={() => undefined}
        cart={EMPTY_CART}
        orgName="Northfield Chess Club"
        errors={{}}
        cameraRequirements={cameraRequirements}
      />,
    );
  };

  it("the empty case first: none (or an old caller passing nothing) - no camera note; the consent still renders", () => {
    for (const reqs of [[], undefined]) {
      const h = consent(reqs);
      expect(h).not.toContain('data-testid="reg-consent-camera"');
      expect(h).not.toContain(esc(s("en", "register.camera.required")));
      expect(h).toContain('data-testid="reg-consent-grant"');
    }
  });

  it("required: the division, the duty and the approved notice, amber, above the privacy consent - in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const h = consent([{ name: "Online Open", policy: "required" }], loc);
      const box = /<div[^>]*data-testid="reg-consent-camera"[^>]*>/.exec(h);
      expect(box, `${loc}: the note`).not.toBeNull();
      expect(box![0], loc).toContain('data-policy="required"');
      expect(box![0], loc).toContain("bg-[#fef3c7]");
      expect(h, loc).toContain("Online Open");
      expect(h, loc).toContain(esc(s(loc, "register.camera.required")));
      expect(h, loc).toContain(esc(s(loc, "onlineChess.camera.playerNotice")));
      expect(h.indexOf('data-testid="reg-consent-camera"'), loc).toBeLessThan(h.indexOf('data-testid="reg-consent-grant"'));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("optional says optional, lavender, without the duty's notice; two divisions get one note each", () => {
    const h = consent([
      { name: "Online Open", policy: "optional" },
      { name: "Junior Online", policy: "required" },
    ]);
    const boxes = [...h.matchAll(/<div[^>]*data-testid="reg-consent-camera"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toContain('data-policy="optional"');
    expect(boxes[0]).toContain("bg-[#f3effc]");
    expect(boxes[1]).toContain('data-policy="required"');
    expect(h).toContain(esc(s("en", "register.camera.optional")));
    // The notice belongs to the required division alone: once, not twice.
    expect(h.split(esc(s("en", "onlineChess.camera.playerNotice"))).length - 1).toBe(1);
  });
});

describe("selectedCameraRequirements — which selected divisions CONSENT states a camera for", () => {
  const d = (id: string, online_play: boolean | undefined, camera_policy: CameraPolicy | undefined) => ({
    division_id: id,
    name: `Division ${id}`,
    online_play,
    camera_policy,
  });
  const cart = (...ids: string[]) => ({ entries: ids.map((division_id) => ({ division_id })) }) as never;

  it("the empty case first: an empty cart states nothing", () => {
    expect(selectedCameraRequirements(cart(), [d("a", true, "required")])).toEqual([]);
  });

  it("online with a policy only, in the cart's order, each once; not online / off / old wire / unknown id state nothing", () => {
    const divisions = [
      d("req", true, "required"),
      d("opt", true, "optional"),
      d("off", true, "off"),
      d("otb", false, "required"), // not online: no camera to require, whatever the field says
      d("old", undefined, undefined),
    ];
    const got = selectedCameraRequirements(cart("opt", "otb", "req", "off", "opt", "old", "ghost"), divisions);
    expect(got).toEqual([
      { name: "Division opt", policy: "optional" },
      { name: "Division req", policy: "required" },
    ]);
  });
});
