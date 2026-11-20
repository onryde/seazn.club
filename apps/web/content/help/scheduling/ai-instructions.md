---
title: Writing an instruction AI Schedule can check
description: Which parts of a sentence become rules the checker looks for, and how to see how yours was read before any credit is spent.
order: 5.1
related: scheduling/ai-scheduling, scheduling/ai-dates, scheduling/ai-review, scheduling/ai-credits
---

Before a timetable is built, your sentence is read once and turned into rules. The checker then looks for each rule in the proposal. You can see exactly how your sentence was read before any credit is spent.

![The card that opens after Check what this means. It lists the rules the sentence was read as, with a Run with these rules button and a Back to the brief button underneath.](/help/scheduling/ai-check-card.webp "The check card for the sentence Finish by 6pm and play at most 4 matches a day. Give every player 30 minutes rest. It lists three rules and offers Run with these rules.")

## What a sentence can become

These kinds of sentence become rules. Each example below shows how that sentence was read:

- **A limit on matches a day.** "Two matches a day at most." reads as **at most 2 matches a day**, a cap on the whole run's daily total, not on each player. "Nobody plays more than two matches a day." reads as **at most 2 matches a day — for every player**. "Matches at most 3 per day for every team" reads as **at most 3 matches a day — for every team or pair**.
- **A minimum rest.** "At least 40 minutes between matches." reads as **at least 40 min rest between a player's matches, and before a match they feed into**.
- **A day for the final.** "Finals on Saturday." reads as **the final on Saturday**.
- **Earliest and latest starts.** "Nothing after 7pm." reads as **nothing after 19:00**. "Nothing before 10am." reads as **nothing before 10:00**.
- **A range of dates.** "From tomorrow till Friday." See [the dates a plan covers](/help/scheduling/ai-dates).
- **A daily pause.** "Lunch break from 12:00 to 13:00 every day." appeared under **Assumed**, as no play between those times on every day of the run.

Words like "tomorrow" and "Friday" are turned into dates for you, against the real calendar in your organisation's timezone.

## What it will not turn into a rule

Some sentences land under **Couldn't use**, quoted exactly as you typed them. They become no rule at all. These did:

- **A limit on one stretch of play**: "Nobody plays more than 2 matches in a row."
- **A court closed on a day**: "Keep Court 2 free on Saturday."
- **A time for one named player**: "Amber can't play before 11am."
- **A date written as a day and month**: "The final on 12 December." and "Run everything from 7 December until 9 December."

Reading is not exact, so check the card each time. A preference such as "Keep the mornings relaxed." appears under **Passed on, never checked**. The AI sees those words, but nothing afterwards checks that it listened.

## Check what this means

Select **Check what this means** under the instruction box. A card opens with up to five parts:

- **Read as**: the rules the checker looks for in the proposal. A break is flagged for you to review. See [reviewing a proposal](/help/scheduling/ai-review).
- **Passed on, never checked**: wishes handed to the AI word for word.
- **Couldn't use**: your own words, left as you wrote them.
- **Assumed**: the readings that had to be chosen. For example, "Friday" is read as any Friday in the run.
- **Window**: the dates your sentence claimed.

Then choose **Run with these rules**, which shows the credits it will charge, or **Back to the brief**, which spends nothing.

The card's hint says a plan that breaks a rule is rejected. A plan that breaks a day limit is still offered, with the break flagged under **To review**. Treat the rules as checks you read, and read the list before you apply. See [reviewing a proposal](/help/scheduling/ai-review).

If nothing in your sentence can be enforced, the card says so: **Nothing in this instruction can be enforced. The architect still reads your words, but no rule will be checked.** If a sentence cannot be read at all, you can choose **Send it as written** or **Edit the brief**.

Each check counts toward the burst limit in [what a run costs](/help/scheduling/ai-credits).

> **Example**
> You type: "Nobody plays more than two matches a day. Amber can't play before 11am. Keep the mornings relaxed." The card shows **at most 2 matches a day — for every player** under **Read as**. **Keep the mornings relaxed.** sits under **Passed on, never checked**. **Amber can't play before 11am.** sits under **Couldn't use**.
