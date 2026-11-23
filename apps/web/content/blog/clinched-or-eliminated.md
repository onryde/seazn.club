---
title: How does Seazn know a team is through, or out?
description: Seazn works out the fewest and most points each team can still finish on, then says who is through, who is out and who still needs help.
date: 2026-11-23
author: Seazn
topic: round-robin
sports: all
help: formats/league
related: best-third-placed-teams, round-robin-schedule, level-on-points-who-finishes-higher, withdrawal-in-a-league
examples: clinched-or-eliminated
---

When a league has a cut, its table says more than who leads. Next to each team's rank it draws a mark: a tick for Through, a ring for a place that is still open and a dash for Out. A tap on the rank says it in words: Through, Win and in, Needs help or Out. All of this appears before the last round is played, and none of it is a guess. Seazn works out the fewest and the most points each team can still finish on, and compares them with the other teams.

## The example

Here are {{fact:clinched-or-eliminated.teams}} football teams. Each plays {{fact:clinched-or-eliminated.matchesEach}} matches, and the top {{fact:clinched-or-eliminated.cut}} go on to the knockout. The table is read with {{fact:clinched-or-eliminated.leftEach}} round to play, and again once that round is played.

{{example:clinched-or-eliminated}}

## What a team can still reach

A team's fewest points are the points it has now, plus {{fact:clinched-or-eliminated.fewestPerMatch}} for each match it has left, because a loss pays {{fact:clinched-or-eliminated.fewestPerMatch}} in football. Its most are the points it has now, plus {{fact:clinched-or-eliminated.mostPerMatch}} for each match left, because a win pays {{fact:clinched-or-eliminated.mostPerMatch}}. Every team here has {{fact:clinched-or-eliminated.leftEach}} match left, so each team's range runs from its points to its points plus {{fact:clinched-or-eliminated.mostPerMatch}}. The picture draws these ranges. Every sport pays its own points for a win, a draw and a loss, so the ranges are measured in that sport's points, and the rule that reads them is the same.

## Through

{{fact:clinched-or-eliminated.throughTeam}} are through. They have {{fact:clinched-or-eliminated.throughPoints}} points, so they cannot finish on fewer than that. Only {{fact:clinched-or-eliminated.throughRivals}} can still reach {{fact:clinched-or-eliminated.throughPoints}} or more, and {{fact:clinched-or-eliminated.cut}} places go on. With fewer teams able to catch them than there are places, nothing still to be played can push them out. Tapping the rank says: "{{fact:clinched-or-eliminated.throughHeadline}}"

## Win and in

{{fact:clinched-or-eliminated.winAndInTeam}} have {{fact:clinched-or-eliminated.levelTeamPoints}} points. If they lose their last match, they finish on {{fact:clinched-or-eliminated.levelTeamPoints}}, and {{fact:clinched-or-eliminated.levelRivals}} can reach that. That is as many teams as there are places, so a loss does not keep them through. If they win, they reach {{fact:clinched-or-eliminated.winAndInBest}}, and only {{fact:clinched-or-eliminated.winAndInRivalsAfterWin}} can still reach that, which is fewer teams than places. So the rank is labelled "{{fact:clinched-or-eliminated.winAndInLabel}}". A team with more matches left gets the number of wins that is enough, such as "{{fact:clinched-or-eliminated.winManyLabel}}". The same details answer the other question: "{{fact:clinched-or-eliminated.winAndInIfLose}}"

## A team that can only draw level still counts

{{fact:clinched-or-eliminated.levelRival}} can reach {{fact:clinched-or-eliminated.levelRivalBest}} points at most, which is exactly where {{fact:clinched-or-eliminated.levelTeam}} are left if they lose. Seazn counts them as a team that can finish ahead. Two teams on the same points are separated by the table's tie-break rules, and the status does not assume that this goes in the team's favour. If it did, {{fact:clinched-or-eliminated.levelTeam}} would be called through, and the word would have to be taken back if the tie went the other way.

What Seazn does instead is say how such a tie would be settled: "{{fact:clinched-or-eliminated.levelWhatIf}}"

## Out

A team is out when as many teams as there are places are already ahead of the most it can reach. {{fact:clinched-or-eliminated.outFirstTeam}} can reach {{fact:clinched-or-eliminated.outFirstBest}} points at most. {{fact:clinched-or-eliminated.aheadOfOut}} cannot finish on fewer than {{fact:clinched-or-eliminated.aheadOfOutFewest}}, so both are already ahead of that, and that fills the {{fact:clinched-or-eliminated.cut}} places. The teams that are out here are {{fact:clinched-or-eliminated.outTeams}}. Tapping the rank says: "{{fact:clinched-or-eliminated.outHeadline}}"

This test is stricter than the one for going through. A team is out only when its most is below the fewest of the teams ahead. A team whose most is exactly level with a rival's fewest is not out, because on level points the tie-break could still go its way. {{fact:clinched-or-eliminated.needsHelpTeams}} can reach {{fact:clinched-or-eliminated.needsHelpBest}}, and {{fact:clinched-or-eliminated.levelTeam}} cannot finish on fewer than {{fact:clinched-or-eliminated.levelTeamPoints}}, so they are not out.

## Needs help

{{fact:clinched-or-eliminated.needsHelpTeams}} have {{fact:clinched-or-eliminated.needsHelpPoints}} points and can reach {{fact:clinched-or-eliminated.needsHelpBest}}. They are not through, because the teams above them can finish ahead even if those teams lose. They are not out, because fewer than {{fact:clinched-or-eliminated.cut}} teams are ahead of the most they can reach. And a win is not enough on its own, because as many teams as there are places can still reach {{fact:clinched-or-eliminated.needsHelpBest}} or more. Their place depends on other results, and tapping the rank says: "{{fact:clinched-or-eliminated.needsHelpHeadline}}"

## When the round is played

Once the last match is decided, the words stop being a forecast. The first {{fact:clinched-or-eliminated.cut}} places read Qualified and the rest read Out: {{fact:clinched-or-eliminated.qualifiedTeams}} went through. In this example no team that was through went out, and none that was out came back in. {{fact:clinched-or-eliminated.needsHelpTeams}} needed help, and did not get it. Tapping a team that is out says: "{{fact:clinched-or-eliminated.finalOutHeadline}}"

The marks are worked out from the table as it stands, so they move when the table does. A league whose last match has just been scored is not complete until the organiser completes it, and a team added in that time owes matches against everyone, so the table goes back to forecasting: [Can a team join a league after it has started?](/blog/joining-a-league-late) covers where those matches go. A team that withdraws with fewer than half of its matches played has its results removed, and the points of the teams that played it go with them, which can change who is through or out: [What happens to a team's results when it withdraws from a league?](/blog/withdrawal-in-a-league) has the rule.

Before the first match is played there is nothing to read, so the table shows no qualification mark at all: every team is level, with no results yet.

## In every sport

Qualifying words are offered in all {{fact:clinched-or-eliminated.sportCount}} sports. Each sport pays its own points for a win, a draw and a loss, and the rule reads those figures, so a sport that pays more for a win has wider ranges. What never changes is the order of the questions: through first, then out, then how many wins are enough.
