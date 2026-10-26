// The A-kind body guard (phase 3 wave 1, T4).
//
// An email addressed to an ACCOUNT (`OUTBOX_KIND_FACTS[kind].to === "account"`) has its recipient decided when it is SENT
// (recipient.ts), and the body is sealed when it is QUEUED. If the sealed body named the address it was queued for, then a player who
// changed address in between would receive a mail that quotes the OLD address (or, worse, mail the old address's owner's details to
// the new one). So the body of an account kind must not carry the recipient's address at all: not in the subject, the html or the text.
//
// What is checked, and how:
//  - WHICH kinds are account kinds is the engine's own declaration (`OUTBOX_KIND_FACTS`), compared with a list typed here from the
//    spec (`chess_invite` is the only one). A new account kind is then a failure that asks for a decision here, not a quiet pass.
//  - The bodies are the REAL producer's: `openRound` renders the invite with the real `externalPlayInviteEmail` (NOT replaced, unlike the
//    sibling suites: their stand-in puts the address in the body on purpose so the transport double can read it) and queues it. Only
//    the transport is replaced, and it answers 503 so every row stays `queued` with its sealed body. A row that had been sent has no
//    body left to open, and a guard over no bodies is the vacuous pass this file exists to avoid.
//  - The bodies are opened with the outbox's own `openBody` and the recipient's address (lower-cased, as the row stores it) must be
//    absent. A positive pair shows the bodies really were opened and are the invite (they carry the match link).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { OUTBOX_KIND_FACTS, OUTBOX_KINDS, type OutboxKind } from "../constants";
import { openBody } from "../seal";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";

vi.mock("@/server/email-outbox/transport", () => ({
  deliver: async () => ({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" }),
}));

import { openRound } from "@/server/usecases/external-play/open-round";

const HAS_DB = !!process.env.DATABASE_URL;

/** Typed from the spec (phase 3, "Recipient"): the kinds whose recipient is an account. */
const SPEC_ACCOUNT_KINDS: readonly OutboxKind[] = ["chess_invite"];

beforeEach(() => stubOutboxEnv());
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("which kinds are addressed to an account (no database)", () => {
  it("the declared account kinds are exactly the spec's list", () => {
    const declared = OUTBOX_KINDS.filter((k) => OUTBOX_KIND_FACTS[k].to === "account");
    expect([...declared].sort()).toEqual([...SPEC_ACCOUNT_KINDS].sort());
    // The sweep below covers every account kind through a real producer; this pins that each has one.
    expect(declared.length, "anti-vacuity: at least one account kind").toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("an account kind's sealed body never names its recipient (real producer, real renderer)", () => {
  // One producer per account kind: the real code path that writes the kind's rows, returning the fixture ids its rows hang off.
  const PRODUCERS: Readonly<Record<string, () => Promise<string[]>>> = {
    chess_invite: async () => {
      const r = await seedOnlineChessRound({ fixtures: 2 });
      const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
      expect(out, "premise: the real open invited the round").toMatchObject({ opened: true });
      return r.boards.map((b) => b.fixtureId);
    },
  };

  it("chess_invite (and every other account kind): the recipient's address is absent from the subject, the html and the text", async () => {
    let kindsChecked = 0;
    let rowsChecked = 0;
    for (const kind of SPEC_ACCOUNT_KINDS) {
      const produce = PRODUCERS[kind];
      expect(produce, `a producer for the account kind ${kind}`).toBeDefined();
      const fixtureIds = await produce!();
      const rows = await sql<{ id: string; recipient: string; recipient_user_id: string | null; subject: string; status: string; body_sealed: Buffer | null }[]>`
        select id, recipient, recipient_user_id, subject, status, body_sealed
          from email_outbox
         where kind = ${kind} and split_part(ref_id, ':', 1) = any(${fixtureIds}::text[])`;
      expect(rows.length, `anti-vacuity: the ${kind} producer wrote rows`).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.status, `premise: ${kind} row still holds its sealed body`).toBe("queued");
        expect(row.body_sealed, `premise: ${kind} row has a body to open`).not.toBeNull();
        expect(row.recipient_user_id, `premise: the row is an account's`).not.toBeNull();
        const body = openBody(row.body_sealed!);
        const address = row.recipient.toLowerCase();
        expect(address, "premise: the address is a real one").toMatch(/@/);
        expect(row.subject.toLowerCase(), `${kind}: subject`).not.toContain(address);
        expect(body.html.toLowerCase(), `${kind}: html`).not.toContain(address);
        expect(body.text.toLowerCase(), `${kind}: text`).not.toContain(address);
        // The positive pair: this is the invite, opened. An empty or unreadable body would pass the three checks above.
        expect(body.text.length, `${kind}: the text really was opened`).toBeGreaterThan(20);
        expect(body.html, `${kind}: the html carries the match link`).toMatch(/href="https?:\/\//);
        rowsChecked += 1;
      }
      kindsChecked += 1;
    }
    expect(kindsChecked, "every account kind was checked").toBe(SPEC_ACCOUNT_KINDS.length);
    expect(rowsChecked, "anti-vacuity: bodies were opened").toBeGreaterThanOrEqual(2);
  });
});
