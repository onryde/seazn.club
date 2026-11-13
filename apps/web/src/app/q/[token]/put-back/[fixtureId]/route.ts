// POST /q/<token>/put-back/<fixtureId>: "Put back" on the quick match home (quick match plan 4, Task 3; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6). Puts a Not played match back exactly as
// it was before the skip (`putBackQuickMatchFixture`, quick-match-skip.ts), until the league finishes. Anyone holding the
// home link may (§3, call 3).
//
// The answers, the order and the refusals are the shared handler's (`../../match-action-post.ts`): a 303 to the bare home,
// to the home with `?e=<code>`, or to the dead screen for an unknown token.
import { putBackQuickMatchFixture } from "@/server/usecases/quick-match-skip";
import { matchActionPost } from "../../match-action-post";

export const POST = matchActionPost("put back", putBackQuickMatchFixture);
