// The Start-tournament dialog says the competition moves published -> live —
// and must not say it when the server would leave the competition alone. The
// server's rule lives in ONE SQL `where` literal in `usecases/schedule.ts`;
// this file is the only thing keeping the client mirror honest, so it reads
// that literal rather than restating it. Same shape as
// `open-entry-stages.test.ts`, which does this for the entrants line.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPETITION_STATUS_START_PROMOTES_FROM,
  COMPETITION_STATUS_START_PROMOTES_TO,
  startPromotesCompetition,
} from "@/lib/start-promotes-competition";

describe("the competition statuses starting a division promotes", () => {
  it("matches the `where` clause startDivision actually guards on", () => {
    const source = readFileSync(join(process.cwd(), "src/server/usecases/schedule.ts"), "utf8");
    // The promotion: `update competitions set status = 'live'
    //                 where id = ${division.competition_id} and status = 'published'`.
    const clause = /update competitions set status = '([a-z]+)'\s*where id = \$\{[^}]+\} and status = '([a-z]+)'/.exec(
      source.replace(/\n\s*/g, " "),
    );
    expect(clause, "the competition promotion is no longer in schedule.ts").not.toBeNull();
    // Both ends, because the dialog's sentence names both: a server that
    // promoted to some other status, or from some other one, would make the
    // copy false in a way a presence-only assertion cannot see.
    expect(clause![2], "the status the server promotes FROM").toBe(COMPETITION_STATUS_START_PROMOTES_FROM);
    expect(clause![1], "the status the server promotes TO").toBe(COMPETITION_STATUS_START_PROMOTES_TO);
  });

  it("is true for exactly one of the five competition statuses", () => {
    // Enumerated, not sampled: the `where` is an equality on ONE status, so
    // every other member of the enum must answer false. `draft` is the one
    // that matters most — promoting it would publish a competition nobody
    // published, which is why the server leaves it alone.
    const promoting = ["draft", "published", "live", "completed", "archived"].filter((status) =>
      startPromotesCompetition(status),
    );
    expect(promoting).toEqual(["published"]);
    // An unknown token (a status this client build has never heard of) is not
    // a promotion either — the dialog stays quiet rather than guessing.
    expect(startPromotesCompetition("")).toBe(false);
    expect(startPromotesCompetition("paused")).toBe(false);
  });
});
