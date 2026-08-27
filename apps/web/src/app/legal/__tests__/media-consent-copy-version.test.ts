// RS006 review fix (FINDING 2, MEDIUM): registration-submit.ts stamps
// registration_groups.media_consent_version with the SAME LEGAL_VERSION
// constant that privacy-scheduling-note.test.tsx (in this same directory)
// pins to /legal/privacy's own "Last updated" line. But the media-consent
// checkbox's copy (register.consent.media.label / .hint, rendered by
// components/public-site/register/step-consent.tsx) links to no /legal/*
// page and was never covered by that pin — so an organiser-visible edit to
// this copy could drift silently: the checkbox text changes, but
// LEGAL_VERSION, and therefore every future media_consent_version stamp,
// does not move. V377__registration_media_consent.sql states the contract
// for itself: "a stamp names the text that was shown". This test is that
// contract's enforcement for the one LEGAL_VERSION-stamped consent surface
// that isn't a /legal/* page.
//
// This is a content pin, not a date check — the checkbox has no "Last
// updated" line of its own to compare against a computed date the way the
// privacy page does, so this applies the same mechanism (a real assertion
// against the CURRENT copy, sourced from the dictionary, that breaks the
// moment the copy moves) the only way it can for plain component copy.
//
// If this test fails: you changed register.consent.media.label or
// .media.hint. Update the two expected strings below to match, AND bump
// LEGAL_VERSION (apps/web/src/lib/legal.ts) in the SAME change — that is
// what makes the next media_consent_version stamp name the text you just
// shipped instead of the old one. Do not update the pin alone.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";

const en = uiEn as Record<string, string>;

describe("media-consent checkbox copy is pinned (RS006 review fix — extends privacy-scheduling-note.test.tsx's LEGAL_VERSION enforcement)", () => {
  it("matches the copy LEGAL_VERSION was last bumped for", () => {
    expect(en["register.consent.media.label"]).toBe(
      "I'm happy for {org} to use photos or video of me from this event.",
    );
    expect(en["register.consent.media.hint"]).toBe(
      "Optional — this never affects whether you can register.",
    );
  });
});
