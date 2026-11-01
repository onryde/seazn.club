// R4 sponsors on stream, S13 (S10 review m5, routed here): the dispute evidence pack's click line must say what it counts.
// `sponsors.click_count` is bumped by EVERY sponsor link tap S10 records - a board/sponsor-page link (`site`, `match`) AND an
// on-stream short code (`stream`) - so "Logo clicks recorded" understated what the number is (it is not only logo taps) in a
// document the club hands a card network. The ruling taken (controller addendum 2026-11-01, option A): RELABEL it truthfully and
// keep reading `click_count`, which also carries the clicks recorded before S10's click rows existed (an all-time delivery
// proof); the Overview's period count is a different number (server/sponsors/report.ts, count of `sponsor_clicks`).
//
// Driven through the REAL click writer (recordClick), so the value under the label is what production writes, not a seeded
// counter. Killer: revert the label -> "the evidence pack labels..." fails on both assertions.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recordClick } from "@/server/sponsors/clicks";
import { buildSponsorDisputeEvidence, SPONSOR_EVIDENCE_CLICKS_LABEL } from "../sponsors";
import { seedSponsorOrder } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe("the label itself (no DB)", () => {
  it("names sponsor LINK clicks from boards and on-stream codes, never logo taps, visitors or people", () => {
    expect(SPONSOR_EVIDENCE_CLICKS_LABEL).toBe("Sponsor link clicks recorded (boards and on-stream codes)");
    expect(SPONSOR_EVIDENCE_CLICKS_LABEL).not.toMatch(/logo|visitor|people|unique/i);
  });
});

describe.skipIf(!HAS_DB)("S13 m5: the dispute evidence pack's click line", () => {
  it("the evidence pack labels the count as sponsor link clicks (boards and on-stream codes) and shows what the real writer recorded", async () => {
    const o = await seedSponsorOrder({ status: "paid" });
    expect(o.sponsorId, "premise: a paid order activated a placement").not.toBeNull();
    await sql`update sponsor_orders set disputed_at = now(), dispute_id = ${`dp_m5_${randomUUID().slice(0, 8)}`} where id = ${o.orderId}`;
    const auth: AuthCtx = { orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null };

    // One board/page tap and one on-stream code tap, through S10's writer.
    await recordClick(o.sponsorId!, { fixtureId: null, source: "site" });
    await recordClick(o.sponsorId!, { fixtureId: null, source: "stream" });
    const [counted] = await sql<{ n: number; rows: number }[]>`
      select (select click_count from sponsors where id = ${o.sponsorId}) as n,
             (select count(*)::int from sponsor_clicks where sponsor_id = ${o.sponsorId}) as rows`;
    expect(counted, "premise: both taps bumped the counter and wrote a row").toEqual({ n: 2, rows: 2 });

    const pack = await buildSponsorDisputeEvidence(auth, o.orderId, "https://ev.test");
    // evRow writes `<label></td><td …>value</td>`: the value cell right after the label is the counter.
    expect(pack.html).toMatch(/>Sponsor link clicks recorded \(boards and on-stream codes\)<\/td><td[^>]*>2<\/td>/);
    expect(pack.html).not.toContain("Logo clicks recorded");
  });
});
