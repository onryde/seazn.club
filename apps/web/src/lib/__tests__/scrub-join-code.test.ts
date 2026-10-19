// A team's JOIN CODE is a capability: whoever holds it can join the entry (review of PR 988, M3).
//
// It is a `generateRefCode()` value that rides the register pages as `?join_code=<code>[&player_id=…]` (the page a captain
// shares, and its preview request) and as `?join=<code>` (the register page's deep link and the Lichess return path), and is
// in the join POST's body. There is no route of its own to scope a rule by, so the rule is by NAME: every `join_code=` /
// `join=` query parameter value becomes `[code]`, plain or URL-encoded at any depth, either hex case; the Sentry query_string
// in its object and pair-list forms loses it by key; the join POST's body goes.
//
// The URLs are built by the app's own builders (`claimHref`, `registerReturnPath`), with codes the real generator made.
// Left visible, with the reason, in scrub-query-credentials.test.ts: the OAuth `code=` / `state=` on the google and lichess
// callbacks.
//
// Sport: not applicable — a join code is a registration credential.
import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { generateRefCode, isValidRefCode } from "@/lib/ref-code";
import { registerReturnPath } from "@/components/public-site/register/register-lichess-card";
import { claimHref } from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/register/status/view-model";
import { JOIN_CODE_PARAMS, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";
import { otelTraceData, serverSpanDetails, transaction } from "./_sdk-span-data";

const ORIGIN = "https://seazn.club";
const ORG = "city-club";
const COMP = "spring-open";
const PLAYER = "5b8a1c52-3a0e-4d0f-9d6e-0d3c1b7a9f10";
const CODES = Array.from({ length: 12 }, () => generateRefCode());
const API_JOIN = `/api/v1/public/orgs/${ORG}/competitions/${COMP}/register/join`;

const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};
const lowerHex = (s: string) => s.replace(/(%(?:25)*)([0-9A-F]{2})/g, (_m, p: string, h: string) => p + h.toLowerCase());
const asEvent = (e: unknown) => e as Event;

describe("premise: the codes are real and the builders are the app's", () => {
  it("twelve distinct codes the real generator made", () => {
    expect(new Set(CODES).size).toBe(12);
    for (const code of CODES) expect(isValidRefCode(code), code).toBe(true);
  });
  it("the two names the scrubber lists are the two the builders write", () => {
    expect([...JOIN_CODE_PARAMS]).toEqual(["join_code", "join"]);
    expect(claimHref(ORG, COMP, CODES[0]!, PLAYER)).toBe(`/shared/${ORG}/${COMP}/register/join?join_code=${encodeURIComponent(CODES[0]!)}&player_id=${PLAYER}`);
    expect(registerReturnPath(ORG, COMP, CODES[0]!)).toBe(`/shared/${ORG}/${COMP}/register?join=${encodeURIComponent(CODES[0]!)}`);
  });
});

describe("the join code in a URL: every builder x every code x every context", () => {
  const builders: [string, (code: string) => string][] = [
    ["claimHref with a player", (c) => claimHref(ORG, COMP, c, PLAYER)],
    ["claimHref, the generic entry link", (c) => claimHref(ORG, COMP, c)],
    ["registerReturnPath (?join=)", (c) => registerReturnPath(ORG, COMP, c)],
    ["the preview request (join_code first, then another parameter)", (c) => `${API_JOIN}?join_code=${encodeURIComponent(c)}&x=1`],
    ["join_code after another parameter", (c) => `/shared/${ORG}/${COMP}/register/join?player_id=${PLAYER}&join_code=${encodeURIComponent(c)}`],
  ];
  const contexts: [string, (path: string) => string][] = [
    ["bare", (p) => p],
    ["origin", (p) => `${ORIGIN}${p}`],
    ["origin + fragment", (p) => `${ORIGIN}${p}#top`],
    ["sentence", (p) => `Failed to fetch RSC payload for ${ORIGIN}${p} (retrying)`],
    ["JSON string", (p) => JSON.stringify({ href: `${ORIGIN}${p}` })],
    ...[1, 2, 3].flatMap((depth): [string, (p: string) => string][] => [
      [`login next= depth ${depth}`, (p) => `${ORIGIN}/login?next=${encode(p, depth)}`],
      [`login next= (with origin) depth ${depth}`, (p) => `${ORIGIN}/login?lang=en&next=${encode(`${ORIGIN}${p}`, depth)}&x=1`],
      [`login next= lower hex depth ${depth}`, (p) => `${ORIGIN}/login?next=${lowerHex(encode(p, depth))}`],
    ]),
  ];

  it("the code is gone, the placeholder is there, every other parameter stays, the result is stable", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [name, build] of builders) {
      for (const code of CODES) {
        for (const [context, wrap] of contexts) {
          const input = wrap(build(code));
          const out = scrubScoreUrl(input);
          const raw = [code, encodeURIComponent(code), encode(code, 2)];
          if (raw.some((r) => out.includes(r))) failures.push(`${name} / ${context}: the code survived: ${out}`);
          else if (!out.includes("[code]")) failures.push(`${name} / ${context}: no placeholder: ${out}`);
          if (name.includes("player") && !out.includes(PLAYER) && !out.includes(encode(PLAYER, 1))) failures.push(`${name} / ${context}: player_id lost: ${out}`);
          if (scrubScoreUrl(out) !== out) failures.push(`${name} / ${context}: not idempotent`);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(builders.length * CODES.length * contexts.length);
    expect(checked).toBeGreaterThanOrEqual(800);
  });

  it("is stateless: the same string twice gives the same answer (a /g regex keeps lastIndex)", () => {
    const input = `${ORIGIN}${claimHref(ORG, COMP, CODES[0]!, PLAYER)}`;
    const first = scrubScoreUrl(input);
    for (let i = 0; i < 4; i++) expect(scrubScoreUrl(input)).toBe(first);
    expect(first).not.toContain(CODES[0]!);
  });

  it("lookalikes are left alone: another name that ends in join, an empty value, a path segment called join_code", () => {
    const code = CODES[0]!;
    for (const url of [
      `${ORIGIN}/x?rejoin=${code}`,
      `${ORIGIN}/x?x-join=${code}`,
      `${ORIGIN}/x?join_codes=${code}`,
      `${ORIGIN}/x?joined=${code}`,
      `${ORIGIN}/x?a=1&join_code=`,
      `${ORIGIN}/x?join=`,
      `${ORIGIN}/shared/${ORG}/join_code/${code}`,
      `${ORIGIN}/login?next=${encodeURIComponent(`/x?rejoin=${code}`)}`,
    ]) {
      expect(scrubScoreUrl(url), url).toBe(url);
    }
  });
});

describe("a Sentry event on the join page and the join API", () => {
  const code = CODES[1]!;
  const page = claimHref(ORG, COMP, code, PLAYER);
  const query = `join_code=${encodeURIComponent(code)}&player_id=${PLAYER}`;
  const gone = (out: unknown) => expect(JSON.stringify(out)).not.toContain(code);

  it("query_string as a string, an object and a list of pairs: the code is gone, player_id stays", () => {
    const forms: [string, Event["request"]][] = [
      ["string", { url: `${ORIGIN}${page}`, query_string: query }],
      ["object", { url: `${ORIGIN}/shared/${ORG}/${COMP}/register/join`, query_string: { join_code: code, player_id: PLAYER } }],
      ["pairs", { url: `${ORIGIN}/shared/${ORG}/${COMP}/register/join`, query_string: [["join_code", code], ["player_id", PLAYER]] }],
      ["object, the deep link", { url: `${ORIGIN}/shared/${ORG}/${COMP}/register`, query_string: { join: code } }],
      ["pairs, the deep link", { url: `${ORIGIN}/shared/${ORG}/${COMP}/register`, query_string: [["join", code]] }],
    ];
    for (const [name, request] of forms) {
      const input = asEvent({ event_id: "j1", request });
      const snapshot = structuredClone(input);
      const out = scrubSentryEvent(input);
      gone(out);
      expect(JSON.stringify(out), name).toContain("[code]");
      if (name.startsWith("string") || name.startsWith("object") || name.startsWith("pairs")) {
        if (!name.includes("deep")) expect(JSON.stringify(out), `${name}: player_id stays`).toContain(PLAYER);
      }
      expect(JSON.stringify(input), `${name}: the input is not mutated`).toBe(JSON.stringify(snapshot));
      expect(JSON.stringify(scrubSentryEvent(out)), `${name}: stable`).toBe(JSON.stringify(out));
    }
  });

  it("an ordinary query_string object keeps its values (the positive pair)", () => {
    const request = { url: `${ORIGIN}/x`, query_string: { page: "2", player_id: PLAYER } };
    expect(scrubSentryEvent(asEvent({ event_id: "j2", request })).request).toEqual(request);
  });

  it("the join POST loses its body, whether the URL or only the transaction names it; the GET preview keeps the rest", () => {
    const body = { join_code: code, player_id: PLAYER, contact: { name: "A", email: "a@example.test" } };
    const byUrl = scrubSentryEvent(asEvent({ event_id: "j3", request: { method: "POST", url: `${ORIGIN}${API_JOIN}`, data: body } }));
    const byName = scrubSentryEvent(asEvent({ event_id: "j4", transaction: "POST /api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join", request: { method: "POST", data: body } }));
    for (const out of [byUrl, byName]) {
      expect(Object.hasOwn(out.request ?? {}, "data")).toBe(false);
      gone(out);
      expect(out.request?.method).toBe("POST");
    }
    // The sibling register POST (no code in its body) keeps its body.
    const sibling = scrubSentryEvent(asEvent({ event_id: "j5", request: { method: "POST", url: `${ORIGIN}/api/v1/public/orgs/${ORG}/competitions/${COMP}/register`, data: { who: "x" } } }));
    expect(sibling.request?.data).toEqual({ who: "x" });
  });

  it("a transaction's span data: http.query and url.query carry the code with a ? and no route beside it", () => {
    const url = `${ORIGIN}${API_JOIN}?join_code=${encodeURIComponent(code)}`;
    const trace = scrubSentryEvent(asEvent(transaction({ name: `GET ${API_JOIN}`, traceData: otelTraceData(url) })));
    const server = scrubSentryEvent(asEvent(transaction({ name: `GET ${API_JOIN}`, traceData: serverSpanDetails(url, API_JOIN).data })));
    expect(JSON.stringify(trace)).not.toContain(code);
    expect(JSON.stringify(server)).not.toContain(code);
    expect(JSON.stringify(trace)).toContain("?join_code=[code]");
    expect(JSON.stringify(server)).toContain("?join_code=[code]");
  });
});
