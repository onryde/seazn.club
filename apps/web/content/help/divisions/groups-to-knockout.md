---
title: Groups to knockout
description: In the app you pick how many go through from each table. Through the API you can combine winners and best runners-up, and set your own bracket order.
order: 4
related: divisions/qualify-from-any-stage, divisions/bracket-view, entrants/withdrawals
---

Most cups send the top of each group into a knockout. In the app this is one choice. The API goes further: it can mix tiers, such as every group winner plus the best runner-up, and it can fix the bracket order.

## In the app

On the **Fixtures** tab, **+ Add stage** has a **Qualify from table** choice, and it offers **Top N**. The **Format** button on **Division rules** also lists suggested formats, such as **Groups + knockout**.

When the groups finish, the knockout stage shows a **Seed proposal** card with **Proposed qualifiers**. Choose **Confirm proposal** to fill the bracket. The card warns that once confirmed, Undo cannot take the draw back. Unless you set your own order, the bracket seeds in the standard way, so the top two seeds meet only in the final.

## Through the API

The knockout stage carries its qualification in a `progression` field. Each entry in `take` is one rule, and the rules run in the order you list them.

```json
{
  "kind": "knockout",
  "progression": {
    "sources": [{
      "stage": "previous",
      "take": [
        { "kind": "topNPerGroup", "n": 1 },
        { "kind": "bestNth", "nth": 2, "count": 1 }
      ]
    }],
    "placement": "rank_order",
    "timing": "setup"
  }
}
```

This takes every group winner, then the single best runner-up.

> **Example**
> Nine entrants play three groups of three. The progression above sends the three group winners and the best runner-up into a four-place knockout. The proposal lists the three winners at seeds 1 to 3 and the best runner-up at seed 4.

If runners-up are level on the table, confirming the proposal is refused until the tie is settled.

### Your own bracket order

By default the bracket seeds in the standard way. To fix the first round yourself, put a `slotOrder` in the knockout stage's `config`. It lists seed numbers, counting from 1, one per first-round slot, with `null` for a bye. Every seed must appear exactly once or the stage is refused.

With four qualifiers, `"slotOrder": [1, 3, 2, 4]` gave the first-round matches seed 1 against seed 3, and seed 2 against seed 4.
