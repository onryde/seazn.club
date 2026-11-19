---
title: AI Schedule
description: Describe your timetable in plain words, check how it was read, and apply the proposal only when you are happy with it.
order: 5
related: scheduling/ai-instructions, scheduling/ai-dates, scheduling/ai-review, scheduling/ai-credits, scheduling/ai-several-divisions
---

**AI Schedule** turns a sentence such as "Finish by 6pm and play at most 4 matches a day" into a proposed timetable. It only proposes. Nothing changes on the board until you apply it, and one tap undoes the apply. It is available on every plan. What it spends is your organisation's AI credits, covered in [what a run costs](/help/scheduling/ai-credits).

![The AI Schedule console for a six-player league, with the four steps along the top, the instruction box, three example sentences and the Before you run checklist.](/help/scheduling/ai-console.webp "The AI Schedule console before a run: the steps along the top, the instruction box, and the Before you run checklist.")

## Open the console

1. Open **Schedule**, then the **Board** tab.
2. Select **✦ AI Schedule**. Its hint reads **Plan, refine or repair the schedule with AI**.

Four steps run along the top: **Brief**, **Schedule**, **Officials** and **Apply**. Officials is optional. See [AI Officials](/help/scheduling/ai-officials).

## Write the brief

Type in **What should the schedule do?** Plain language works best: describe times, courts and rest gaps. You can also:

- Select an example sentence, such as **Give every team at least 30 minutes rest between games.**
- Use **Add a wish**: **Finish by**, **Before / after**, **Keep apart**, **Final last** or **Pin slots**. Each wish writes a line into the instruction, and you can edit the text freely afterwards.

Then choose a run type:

- **Generate** builds a fresh timetable.
- **Refine** adjusts the current proposal. It is switched off until you have one: **Refine needs a proposal first — generate one, then adjust it.**
- **Repair** fixes just the matches that need it. When some do, the board offers **Fix with AI** with a line such as **2 fixtures need repair**.

Before you run, the **Before you run** checklist shows what the planner will work with: **Courts**, **Session windows**, **Blackouts**, **Constraints**, **Movable fixtures**, **Officials** and **Pinned**. A warning links you to where to fix it, for example **No windows set — the AI treats any time as fair game.** with a **Set up** link.

## The path to a timetable

1. [Check what your sentence means](/help/scheduling/ai-instructions). This spends no credit and shows the rules it was read as.
2. Run it, and [review the proposal](/help/scheduling/ai-review).
3. Apply it, or discard it.

The dates a plan covers come from your division's settings or from your sentence. See [the dates a plan covers](/help/scheduling/ai-dates). To plan several divisions in one pass, see [scheduling several divisions together](/help/scheduling/ai-several-divisions).

## What it leaves alone

Pinned matches stay where they are, and a frozen schedule cannot be planned: **This schedule is frozen. Unfreeze it to plan with AI.** See [pinned slots and freezing](/help/scheduling/locks).

## What is sent

The console sends this division's scheduling picture: the matches it may move, the entrants in them, your courts, play hours, blackouts and constraints, and other divisions' bookings on shared courts as blocked time. Requests routed through OpenRouter carry a no-training, zero-data-retention policy. The providers we use are listed on the [sub-processors page](/legal/sub-processors).
