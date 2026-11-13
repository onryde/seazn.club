// The ONE builder of a team's join link (polish wave P6): the captain's status page, the confirmation mail, the organiser's panel
// and the public "Have a join code?" field all write the same URL, so they can never spell it two ways.
//
// Sport: not applicable (a join link is a registration credential).
import { describe, expect, it } from "vitest";
import { generateRefCode, isValidRefCode } from "@/lib/ref-code";
import { joinLinkFromTyped, joinLinkPath } from "@/lib/join-link";
import { claimHref } from "@/app/(public)/live/[orgSlug]/[competitionSlug]/register/status/view-model";
import { scrubScoreUrl } from "@/lib/scrub-score-url";

const ORG = "city-club";
const COMP = "spring-open";
const PLAYER = "5b8a1c52-3a0e-4d0f-9d6e-0d3c1b7a9f10";
const CODES = Array.from({ length: 10 }, () => generateRefCode());

describe("joinLinkPath", () => {
  it("premise: the codes are real, distinct, and carry the characters a URL must encode (the dashes are safe, the rest are tested below)", () => {
    expect(new Set(CODES).size).toBe(10);
    for (const code of CODES) expect(isValidRefCode(code), code).toBe(true);
  });

  it("names the join page, the code, and (when given) the slot", () => {
    expect(joinLinkPath(ORG, COMP, "SZ-ABCD-EF23")).toBe(`/live/${ORG}/${COMP}/register/join?join_code=SZ-ABCD-EF23`);
    expect(joinLinkPath(ORG, COMP, "SZ-ABCD-EF23", PLAYER)).toBe(`/live/${ORG}/${COMP}/register/join?join_code=SZ-ABCD-EF23&player_id=${PLAYER}`);
  });

  it("encodes a code that is not URL-safe, so it can never end the query early or add a parameter", () => {
    const url = joinLinkPath(ORG, COMP, "a&player_id=x b#c");
    expect(url).toBe(`/live/${ORG}/${COMP}/register/join?join_code=a%26player_id%3Dx%20b%23c`);
    expect(new URL(url, "https://x.test").searchParams.get("join_code")).toBe("a&player_id=x b#c");
    expect(new URL(url, "https://x.test").searchParams.has("player_id")).toBe(false);
  });

  it("is the status page's own claimHref for every real code, with and without a slot (one spelling, three producers)", () => {
    let checked = 0;
    for (const code of CODES) {
      expect(joinLinkPath(ORG, COMP, code)).toBe(claimHref(ORG, COMP, code));
      expect(joinLinkPath(ORG, COMP, code, PLAYER)).toBe(claimHref(ORG, COMP, code, PLAYER));
      checked += 2;
    }
    expect(checked).toBe(CODES.length * 2);
  });

  it("is a URL the telemetry scrubber recognises: the code is gone from it, the slot stays", () => {
    let checked = 0;
    for (const code of CODES) {
      const out = scrubScoreUrl(`https://seazn.club${joinLinkPath(ORG, COMP, code, PLAYER)}`);
      expect(out).not.toContain(code);
      expect(out).toContain("[code]");
      expect(out).toContain(PLAYER);
      checked++;
    }
    expect(checked).toBe(CODES.length);
  });
});

describe("joinLinkFromTyped (what the public field navigates to)", () => {
  it("a blank or whitespace-only entry goes nowhere", () => {
    for (const blank of ["", " ", "   \t "]) expect(joinLinkFromTyped(ORG, COMP, blank), JSON.stringify(blank)).toBeNull();
  });

  it("a code typed any way a person might (lower case, no dashes, spaces, no SZ prefix) reaches the canonical code", () => {
    const code = CODES[0]!; // SZ-XXXX-XXXX
    const [, a, b] = code.split("-");
    const spellings = [code, code.toLowerCase(), code.replaceAll("-", ""), ` ${code} `, `${a}${b}`, `${a} ${b}`.toLowerCase(), `sz ${a} ${b}`];
    let checked = 0;
    for (const typed of spellings) {
      expect(joinLinkFromTyped(ORG, COMP, typed), typed).toBe(joinLinkPath(ORG, COMP, code));
      checked++;
    }
    expect(checked).toBe(spellings.length);
  });

  it("something that is not a code is still sent to the join page as typed (upper-cased, trimmed): the page answers it with its one invalid state", () => {
    expect(joinLinkFromTyped(ORG, COMP, "  nonsense words ")).toBe(joinLinkPath(ORG, COMP, "NONSENSE WORDS"));
  });
});
