---
title: Knockout deciders
description: A knockout always produces a winner — turn on extra time, a shoot-out, or a super over in Match rules.
order: 8
---

A knockout match can't end level: there'd be nobody to advance, and the next round would sit waiting forever. The engine **refuses to finalize a drawn result** in any stage that can't take draws — you'll see "this stage cannot end level — decide it by extra time or a shootout" instead of a silently stuck bracket.

To make a winner reachable, turn the decider on in the stage's **Match rules**: **Extra time** and/or **Penalty shootout** for football, **Super over on a tie** for cricket. All three are marked "Knockout fixtures only" for a reason — group stages in the same division keep drawing normally, since the setting lives on the stage, not the division.

A group stage that also plays a shoot-out can still pay less for a win on kicks than a win in regulation: set both **Points for a shoot-out win** and **Points for a shoot-out loss** in Match rules — leave either blank and a shoot-out win just pays a normal win. See [scoring football](/help/scoring/football) for how a shoot-out plays out on the pad, and [scoring cricket](/help/scoring/cricket) for what a division's still-tied rule does if a super over is also tied.

If a match genuinely can't be finished (abandonment, walkover), use the abandon/forfeit flows — those record an outcome the bracket can advance from.
