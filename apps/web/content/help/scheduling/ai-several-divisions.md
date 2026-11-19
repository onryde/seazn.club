---
title: Scheduling several divisions together
description: Plan divisions that share a venue in one pass, review the proposal division by division, and apply or undo them as one.
order: 5.5
related: scheduling/ai-scheduling, scheduling/ai-credits, scheduling/ai-review, scheduling/board
---

The competition's own schedule board can plan several divisions at once. Divisions that share a venue are fitted around each other in a single pass, so you do not schedule them one at a time and patch up the clashes afterwards. It is available on every plan, Community included. What differs by plan is the monthly credit grant. A run costs the same on every plan. See [what a run costs](/help/scheduling/ai-credits).

![The AI Schedule console on a competition's schedule board, with the list of divisions to schedule together and one instruction box for all of them.](/help/scheduling/ai-several-divisions.webp "The competition-level console: pick two or more divisions, write one instruction, then review the proposal division by division.")

## Plan together

1. Open **Competition**, then **Schedule**, and select **✦ AI Schedule**.
2. Under **Divisions to schedule together**, pick the divisions. The list shows how many matches each one has to place, for example **15 fixtures to place**, and counts your picks as **2 of 2 selected**.
3. Write one instruction for all of them in **What should the AI do?**
4. Select **Check what this means**, then run the plan from the card that opens. The proposal is reviewed one division at a time.
5. Select **Apply to all divisions**, or **Change the brief** to start again.

A division with nothing left to place reads **Nothing to place** and is left out of the run. A frozen division reads **Frozen** and cannot be picked.

You need at least two. The picker says **Pick at least two divisions. To schedule one on its own, open its own schedule page.**

## Courts are matched by court, not by name

The console matches courts by the court itself. Two courts that share a name are still two courts, and a run can put a match on each at the same time. When the divisions you picked do not all use the same courts, the console warns **Court names don’t match**. To clear it, pick the same courts on each division's **Courts** tab. Renaming a court does not clear it, whatever the wording of the warning suggests.

When the divisions use different timezones, the console says so and tells you which zone the board shows. It reads each division's own saved zone, so an older division can trigger it even when the organisation's zone has changed since.

## Apply and undo

Applying writes every division together. If the board cannot be written, the console says how many matches would double-book a court, and nothing is written. If a player would be in two matches at once, apply refuses the clash and names the divisions.

Undo is one action for the whole competition. After an apply, the console says **A restore point was saved for each division — undo in one tap.** Press **Undo** and each division the AI wrote to is rewound in the same request. If any division is left on the AI schedule, the console names them and offers **Try those again**, and each division keeps its own restore point on its own schedule page.

## Limits

- A joint run covers at most 500 matches to place, the same ceiling as a single division. Over that, run the divisions in smaller groups.
- A joint run has its own limit of 3 an hour per competition. A check of your sentence counts toward it, and two divisions planned together spend one joint run between them.

## What a joint run costs

Each division is sized on its own, as it would be alone. The run then gets a batch discount of one credit:

> charged credits = the divisions' credits added up, minus 1, never less than 1.

> **Example**
> Three divisions sized 1, 2 and 3 add up to 6 and are charged 5 credits. The receipt lists each line, the **Batch discount** of −1 and the **Total** before you spend anything.
>
> On screen, a division of 15 matches and a division of 3 matches were each sized at **1 credit**. The receipt read **Batch discount −1** and **Total 1 credit**, with the note **Credits buy a thinking budget — up to 64K tokens for this run.**

The thinking budget is sized from the undiscounted total, so those three divisions get the budget 6 credits buy while paying for 5. The discount lowers the price and never the capability.
