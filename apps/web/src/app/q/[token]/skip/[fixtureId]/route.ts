// POST /q/<token>/skip/<fixtureId>: "Not played" on the quick match home (quick match plan 4, Task 3; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6). Marks an unplayed or in-progress league
// match Not played (`skipQuickMatchFixture`, quick-match-skip.ts). Anyone holding the home link may (§3, call 3).
//
// A skip can finish a League + Knockout's league, so the knockout's advance follows it (plan 5 D2, caller b:
// `advanceQuickMatch`, a no-op for any other format), best-effort.
//
// The answers, the order and the refusals are the shared handler's (`../../match-action-post.ts`): a 303 to the bare home,
// to the home with `?e=<code>`, or to the dead screen for an unknown token.
import { advanceQuickMatch } from "@/server/usecases/quick-match-advance";
import { skipQuickMatchFixture } from "@/server/usecases/quick-match-skip";
import { matchActionPost } from "../../match-action-post";

export const POST = matchActionPost("skip", skipQuickMatchFixture, { after: advanceQuickMatch });
