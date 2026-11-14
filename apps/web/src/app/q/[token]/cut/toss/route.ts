// POST /q/<token>/cut/toss: "Toss a coin" for a tie at a League + Knockout's cut (quick match plan 5, Task 4, D5; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11). The toss reveals the stored lot
// (`decideQuickMatchCut`, quick-match-advance.ts): a reload or another phone shows the same result, and the first answer
// wins. Then the knockout's advance (`advanceQuickMatch`, D2 caller c) fills it from the answer, best-effort. Anyone holding
// the home link may answer (§5: the guests are the organisers). No body: the form is a bare post.
//
// The answers, the order and the refusals are the shared handler's (`../../match-action-post.ts`): a 303 to the bare home,
// to the home with `?e=<code>`, or to the dead screen for an unknown token.
import { advanceQuickMatch, decideQuickMatchCut } from "@/server/usecases/quick-match-advance";
import { quickMatchActionPost } from "../../match-action-post";

export const POST = quickMatchActionPost("cut toss", (row) => decideQuickMatchCut(row, { how: "toss" }), {
  after: advanceQuickMatch,
});
