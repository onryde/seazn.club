// Seazn-hosted Task 25b: the client-report registry (kinds.ts) and what EVERY registered kind owes, swept over the registry itself so a
// new kind is held to it the day it is added:
//   - its name is its schema's `kind` literal, names are unique, and the route's union has exactly one option per kind;
//   - its body is CLOSED (no additional properties, an unknown key a refusal) — swept per kind, by injecting a key;
//   - every string it can carry is an enum, a literal, a uuid or a code (lib/client-reports.ts's pattern, the secret-word refusal on
//     top): read from the PUBLISHED JSON schema, so a free `z.string()` slipped into a kind fails here before it can carry an address;
//   - its facts are read through its own schema (a body of another shape throws), and a name with no entry is refused by name;
//   - its Sentry budget (fix round 1, review I1) is the registry default unless it names its own, and a budget is whole and positive.
// Sport: not applicable. A client's failure report is sport-agnostic.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLIENT_REPORT_CODE, isClientReportCode } from "@/lib/client-reports";
import { CLIENT_REPORT_SENTRY_BUDGET, defineClientReportKind, ReportCode } from "../define";
import { CLIENT_REPORT_KINDS, ClientReport, clientReportKind, UnknownClientReportKind } from "../kinds";
import { VideoClientReport } from "../video";

/** One valid report per kind, the sweep's seeds. A kind added without a seed here fails the count below. */
const SEEDS: Record<string, unknown> = {
  video: {
    kind: "video", fixtureId: "8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d", stage: "player", source: "live", partNo: null, player: "hls",
    reason: "hls", hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null,
  },
};

type Json = { [k: string]: unknown };
/** Every sub-schema of a JSON schema that admits a string. */
function stringSchemas(node: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) {
    for (const n of node) stringSchemas(n, out);
  } else if (typeof node === "object" && node !== null) {
    const o = node as Json;
    const t = o.type;
    if (t === "string" || (Array.isArray(t) && t.includes("string"))) out.push(o);
    for (const v of Object.values(o)) stringSchemas(v, out);
  }
  return out;
}

describe("the client-report registry", () => {
  it("every kind's name is its schema's literal, names are unique, and the route's union has one option per kind; every kind has a seed", () => {
    const names = CLIENT_REPORT_KINDS.map((k) => k.kind);
    expect(names.length, "at least one kind").toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    let checked = 0;
    for (const k of CLIENT_REPORT_KINDS) {
      expect(k.kind).toBe(k.schema.shape.kind.value);
      expect(k.kind in SEEDS, `a seed for ${k.kind}`).toBe(true);
      expect(clientReportKind(k.kind)).toBe(k);
      checked++;
    }
    expect(checked).toBe(names.length);
    expect(ClientReport.options).toHaveLength(names.length);
  });

  it("every kind is closed: its seed parses, and the seed with one key more is refused (by the kind and by the route's union)", () => {
    let checked = 0;
    for (const k of CLIENT_REPORT_KINDS) {
      const seed = SEEDS[k.kind] as Json;
      expect(ClientReport.parse(seed)).toEqual(seed);
      expect(k.schema.safeParse({ ...seed, note: "x" }).success, `${k.kind} with an unknown key`).toBe(false);
      expect(ClientReport.safeParse({ ...seed, note: "x" }).success).toBe(false);
      expect((z.toJSONSchema(k.schema) as Json).additionalProperties).toBe(false);
      checked++;
    }
    expect(checked).toBe(CLIENT_REPORT_KINDS.length);
  });

  it("every string a kind can carry is an enum, a literal, a uuid or a code — read from its published JSON schema", () => {
    let checked = 0;
    for (const k of CLIENT_REPORT_KINDS) {
      const strings = stringSchemas(z.toJSONSchema(k.schema));
      expect(strings.length, `${k.kind} carries strings`).toBeGreaterThan(0);
      for (const s of strings) {
        const closed = Array.isArray(s.enum) || "const" in s || s.format === "uuid" || s.pattern === CLIENT_REPORT_CODE.source;
        expect(closed, `${k.kind}: a free string ${JSON.stringify(s)}`).toBe(true);
        checked++;
      }
    }
    // The video kind alone: kind, fixtureId, stage, source, player, reason, hlsType, hlsDetails.
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("a code is a bare word that names no credential, in either case; the client's own check is the same rule", () => {
    const refused = ["token", "accessToken", "TOKEN", "linkExpires", "EXPIRES", "https://x", "a/b", "a?b", "a b", "", "9lives", "x".repeat(65)];
    const taken = ["networkError", "manifestLoadError", "bufferStalledError", "mediaError", "x".repeat(64)];
    let checked = 0;
    for (const v of refused) {
      expect([v, ReportCode.safeParse(v).success, isClientReportCode(v)]).toEqual([v, false, false]);
      checked++;
    }
    for (const v of taken) {
      expect([v, ReportCode.safeParse(v).success, isClientReportCode(v)]).toEqual([v, true, true]);
      checked++;
    }
    expect(checked).toBe(refused.length + taken.length);
  });

  it("every kind's Sentry budget: the registry default unless it names its own (an override is kept); a budget is whole and positive", () => {
    let checked = 0;
    for (const k of CLIENT_REPORT_KINDS) {
      expect(Number.isInteger(k.sentryBudget.max) && k.sentryBudget.max >= 1 && Number.isInteger(k.sentryBudget.windowSeconds) && k.sentryBudget.windowSeconds >= 1, k.kind).toBe(true);
      checked++;
    }
    expect(checked).toBe(CLIENT_REPORT_KINDS.length);
    expect(clientReportKind("video").sentryBudget, "video names none: the default itself").toBe(CLIENT_REPORT_SENTRY_BUDGET);
    const schema = z.strictObject({ kind: z.literal("probe") });
    const facts = () => ({ rateSubject: "s", dedupeSubject: "s", subjectExists: async () => true, message: "m", tags: {}, fields: {} });
    const own = { max: 5, windowSeconds: 30 };
    expect(defineClientReportKind(schema, facts, { sentryBudget: own }).sentryBudget).toBe(own);
    expect(defineClientReportKind(schema, facts).sentryBudget).toBe(CLIENT_REPORT_SENTRY_BUDGET);
    const refused = [{ max: 0, windowSeconds: 60 }, { max: 1.5, windowSeconds: 60 }, { max: 5, windowSeconds: 0 }, { max: 5, windowSeconds: -1 }, { max: Number.NaN, windowSeconds: 60 }];
    for (const b of refused) expect(() => defineClientReportKind(schema, facts, { sentryBudget: b }), JSON.stringify(b)).toThrow(RangeError);
  });

  it("a kind reads its facts through its own schema: a body of another shape throws; a name with no entry is refused by name", () => {
    const video = clientReportKind("video");
    expect(() => video.facts({ kind: "video" })).toThrow();
    expect(() => video.facts({ ...(SEEDS.video as Json), hlsType: "https://x" })).toThrow();
    expect(video.facts(VideoClientReport.parse(SEEDS.video)).rateSubject).toBe((SEEDS.video as Json).fixtureId);
    expect(() => clientReportKind("chess")).toThrow(UnknownClientReportKind);
    expect(() => clientReportKind("")).toThrow(UnknownClientReportKind);
  });
});
