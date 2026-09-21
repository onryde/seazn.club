// Every refusal the ladder challenge form can raise reaches an organiser in
// their own language.
//
// The house rule is that a new or changed user-facing string ships in all
// four locale dictionaries and is never hardcoded English. `issueChallenge`
// (server/usecases/stages.ts) broke it four times over: its refusals were
// composed English prose with no wire code, and `ladder-panel.tsx` rendered
// `err.message` verbatim, so a Dutch organiser met an English sentence for
// every one of the four things they are most likely to get wrong.
//
// This file exists because a dictionary key and a resolver prove NOTHING on
// their own — that is the inert-seam shape. The only proof is folding the
// REAL producer's output through the REAL consumer: each case below drives
// `issueChallenge` until it throws, then hands the thrown code and `extra`
// straight to `ladderErrorMessage`, the same call the panel's catch block
// makes. A fixture on either end would prove the fixture.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { ladderErrorMessage, LADDER_ERROR_CODES } from "@/lib/ladder-error";
import { LOCALES } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, issueChallenge } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const RANGE = 2;

/** A 5-rung ladder with `challengeRange: 2`, seated by a first real challenge
 *  so `config.ladder_order` exists the way a live ladder gets it. Range 2 (not
 *  the default 3) so the out-of-range refusal is reachable across 5 rungs AND
 *  so the copy's number is not the code's own default — a test that asserted
 *  "3" could not tell a resolved payload from a hardcoded one. */
async function ladder(): Promise<{ auth: AuthCtx; stageId: string; order: string[] }> {
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "LadderI18n " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 5 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `L${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "ladder" as never,
    name: "Club ladder",
    config: { challengeRange: RANGE },
  });
  const ids = entrants.map((e) => e.id);
  const seated = await issueChallenge(auth, stage!.id, {
    challenger_id: ids[1]!,
    opponent_id: ids[0]!,
  });
  return { auth, stageId: stage!.id, order: seated.ladder_order };
}

async function refusal(
  auth: AuthCtx,
  stageId: string,
  input: { challenger_id: string; opponent_id: string },
): Promise<HttpError> {
  try {
    await issueChallenge(auth, stageId, input);
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("issueChallenge did not refuse");
}

/** The assertion every case shares: the thrown code is one this resolver
 *  knows, and the copy it produces is real localized text — not the server's
 *  English, not a raw code, not a key. Driven for all four locales so a
 *  single missing translation cannot hide behind English. */
function expectLocalised(err: HttpError): void {
  expect(err.status).toBe(422);
  expect(err.code, "the refusal carries no wire code, so the panel shows English").toBeDefined();
  expect([...LADDER_ERROR_CODES]).toContain(err.code!);
  const rendered = LOCALES.map((l) => ladderErrorMessage(l, err.code!, err.extra, err.message));
  for (const [i, text] of rendered.entries()) {
    expect(text, `${LOCALES[i]} fell back to the server's English`).not.toBe(err.message);
    expect(text.startsWith("ladder.")).toBe(false);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  }
  expect(new Set(rendered).size, "the four locales are not four translations").toBe(LOCALES.length);
}

describe.skipIf(!HAS_DB)("every ladder challenge refusal reaches the organiser localized", () => {
  it("a player who is not on the ladder at all", async () => {
    const { auth, stageId, order } = await ladder();
    const err = await refusal(auth, stageId, {
      challenger_id: order[3]!,
      opponent_id: randomUUID(),
    });
    expect(err.code).toBe("LADDER_ENTRANT_FOREIGN");
    expectLocalised(err);
  });

  it("a player who has withdrawn", async () => {
    const { auth, stageId, order } = await ladder();
    await withdrawEntrantCascade(auth, order[0]!);
    const err = await refusal(auth, stageId, {
      challenger_id: order[1]!,
      opponent_id: order[0]!,
    });
    expect(err.code).toBe("LADDER_ENTRANT_WITHDRAWN");
    expectLocalised(err);
  });

  it("a challenge aimed downward", async () => {
    const { auth, stageId, order } = await ladder();
    const err = await refusal(auth, stageId, {
      challenger_id: order[0]!,
      opponent_id: order[2]!,
    });
    expect(err.code).toBe("LADDER_CHALLENGE_NOT_UPWARD");
    expectLocalised(err);
  });

  it("a challenge beyond the ladder's reach names the reach, in every locale", async () => {
    const { auth, stageId, order } = await ladder();
    const err = await refusal(auth, stageId, {
      challenger_id: order[4]!,
      opponent_id: order[0]!,
    });
    expect(err.code).toBe("LADDER_CHALLENGE_OUT_OF_RANGE");
    // The number must ride in `extra`, not only inside the English sentence:
    // a client cannot parse it back out of prose it does not speak. Pinned
    // against the stage's CONFIGURED range, so a resolver that hardcoded the
    // default 3 would fail here.
    expect(err.extra).toMatchObject({ range: RANGE });
    expectLocalised(err);
    for (const locale of LOCALES) {
      expect(
        ladderErrorMessage(locale, err.code!, err.extra, err.message),
        `${locale} dropped the configured reach`,
      ).toContain(String(RANGE));
    }
  });
});
