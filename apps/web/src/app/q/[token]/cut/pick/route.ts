// POST /q/<token>/cut/pick: "Pick who goes through" for a tie at a League + Knockout's cut (quick match plan 5, Task 4,
// D5; spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11). The form posts one `entrant`
// field per side chosen (a radio for one place, checkboxes for more); `decideQuickMatchCut` refuses anything but exactly the
// open places' number of the tied sides (PICK_INVALID), and the first answer wins. Then the knockout's advance
// (`advanceQuickMatch`, D2 caller c) fills it from the answer, best-effort. Anyone holding the home link may answer.
//
// The answers, the order and the refusals are the shared handler's (`../../match-action-post.ts`): a 303 to the bare home,
// to the home with `?e=<code>`, or to the dead screen for an unknown token.
import { advanceQuickMatch, decideQuickMatchCut } from "@/server/usecases/quick-match-advance";
import { quickMatchActionPost } from "../../match-action-post";

/** Every `entrant` field the form posted that is a string. A body that is no form (another content type, a broken body)
 *  names nobody, which the decision refuses as PICK_INVALID: never the handler's JSON 400. */
async function pickedOf(req: Request): Promise<string[]> {
  const form = await req.formData().catch(() => null);
  return (form?.getAll("entrant") ?? []).filter((v): v is string => typeof v === "string");
}

export const POST = quickMatchActionPost(
  "cut pick",
  async (row, req) => decideQuickMatchCut(row, { how: "pick", entrantIds: await pickedOf(req) }),
  { after: advanceQuickMatch },
);
