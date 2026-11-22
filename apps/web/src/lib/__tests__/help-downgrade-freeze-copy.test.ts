// B3: the freeze list in help/billing/downgrade.md ("Everything else waits for room: ...") named the schedule, entrants, registrations,
// formats, calling matches on Match Day and starting a stream - and missed the online chess round's own START writes, which the freeze also
// refuses (Match Day O4, owner 2026-11-17: open a round, resend an invite, +5 on a board, +5 to the round) while leaving its FINISH decisions
// (resync, let the game go on, settle) as free as scoring. The ledger of what the freeze guards is the SOURCE (every call of
// `assertCompetitionNotFrozen` under external-play/); this test holds the article to it: every guarded online write has words in the freeze
// list, and the finish decisions are named as the ones that keep working (freeze-guard-sites.test.ts pins that no finish door carries a guard).
// Single-sport reason: the writes are online chess's (an external-play usecase); no other sport has a round to open or a check-in to extend.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helpArticle } from "./_help-copy";

const EXTERNAL_PLAY = join(process.cwd(), "src/server/usecases/external-play");
const CALL = /(?<![\w.])(assertNotFrozen|assertCompetitionNotFrozen)\(/;
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** The usecase files under external-play/ whose source calls a freeze guard (a real call: comments and the import line are not). */
function guardedFiles(): string[] {
  return readdirSync(EXTERNAL_PLAY)
    .filter((n) => /\.ts$/.test(n))
    .filter((n) => CALL.test(code(readFileSync(join(EXTERNAL_PLAY, n), "utf8")).replace(/^import .*$/gm, "")))
    .sort();
}

/** Each guarded file -> the words the freeze list uses for the write it guards (what a reader would look for), typed here from the product. */
const WORDS: Record<string, readonly string[]> = {
  "checkin-extend.ts": ["adding time to a check-in", "+5 min"],
  "invite.ts": ["re-sending a player's invite"],
  "open-round.ts": ["opening a round of online chess"],
};

/** The freeze list: the list item that says what waits for room (the read-only bullets, one line each). */
function freezeList(md: string): string {
  const para = md.split(/\n/).find((p) => p.includes("Everything else waits for room"));
  if (para === undefined) throw new Error("downgrade.md: the freeze list (\"Everything else waits for room\") is gone");
  return para.replace(/\s+/g, " ");
}

describe("billing/downgrade.md: the freeze list names the online chess round's guarded writes (B3)", () => {
  const md = helpArticle("downgrade");

  it("every external-play usecase that carries the freeze guard has words in the list, and the table names exactly them", () => {
    const files = guardedFiles();
    expect(files, "anti-vacuity: the guarded online writes found in the source").toEqual(Object.keys(WORDS).sort());
    const list = freezeList(md);
    let checked = 0;
    for (const file of files) {
      for (const w of WORDS[file]!) {
        expect(list, `${file}: the freeze list says "${w}"`).toContain(w);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: four phrases looked for").toBe(4);
  });

  it("the finish decisions of a held online board are said to keep working beside scoring (the ledger, freeze-guard-sites.test.ts, pins that no finish door carries the guard)", () => {
    const scoring = md.split(/\n/).find((p) => p.replace(/^- /, "").startsWith("**Matches still score.**"));
    expect(scoring, "the 'Matches still score' bullet exists").toBeDefined();
    const said = scoring!.replace(/\s+/g, " ");
    const words = ["resync it from Lichess", "let the game go on", "settle it"];
    for (const w of words) expect(said, `says "${w}"`).toContain(w);
    expect(words.length, "anti-vacuity: three decisions").toBe(3);
  });
});
