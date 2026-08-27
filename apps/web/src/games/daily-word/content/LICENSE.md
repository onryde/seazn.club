# Word list provenance

## `allowed.ts` (12,747 words) -- Webster's Second International, public domain

`allowed.ts` is sourced from the real dictionary file already present on this
machine at `/usr/share/dict/words` (a symlink to `web2` -- the classic macOS
system word list, derived from **Webster's Second International Dictionary**,
which is in the public domain). No network access was used or needed.

Build recipe (2026-08-27), reproducible from that one file:

1. Every line matching exactly 5 lowercase letters (`^[a-z]{5}$`) -- 8,506
   words. Filtering to all-lowercase relies on this dictionary capitalizing
   proper nouns (verified on a sample: `Paris`, `Texas`, `Aaron` only appear
   capitalized; a very small number of dual-use words such as `china`
   (porcelain) or `japan` (a lacquer finish) also have a legitimate
   lowercase common-noun sense and are correctly included).
2. Every 4-letter dictionary entry (`^[a-z]{4}$`, 4,360 words) with a plain
   `"s"` appended -- regular plurals / third-person-singular verb forms.
   This step exists because step 1 alone is **lemma-based**: the dictionary
   lists `pear`, `rain`, `worm` as headwords but not their plain `-s` forms
   as separate entries, so step 1 alone still rejects "pears", "rains",
   "worms" -- all three were reported from live play before this rebuild.
3. Unioned with every word in `answers.ts` (below), so `allowed.ts` is
   always a strict superset of it — a handful of `answers.ts` words (modern
   or sport-derived: `INBOX`, `DECOR`, `DISCO`, `RUGBY`, `PROUD`) predate or
   postdate this dictionary's coverage and wouldn't appear from steps 1–2
   alone.

This is a **generous "valid guess" list by design** (same posture as real
Wordle-likes' allowed-guess lists) -- it still contains obscure, archaic, or
dialectal Websterisms nobody would ever expect as a daily *answer*. That is
fine for `isValidGuess` (accepting an unusual real word is harmless) and is
exactly why `answers.ts` is curated separately, below.

Regenerating: re-run the two `grep`-equivalent filters above against
`/usr/share/dict/words`, generate the 4-letter+s plurals, union with
`answers.ts`, de-duplicate, and re-sort. `content/__tests__/words.test.ts`
enforces the superset relationship and a minimum size so a future edit can't
silently shrink this back down.

## `answers.ts` (677 words) -- hand-curated, for daily-puzzle quality

`answers.ts` stays a **separate, smaller, hand-picked** list -- simple,
everyday, unambiguous, family-friendly 5-letter words, the kind a casual
player should recognise immediately once solved. It is deliberately **not**
generated from the dictionary above: that pool includes plenty of archaic
and obscure entries (Websterisms like `aalii`) that would make a poor daily
answer even though they're perfectly fine as an accepted *guess*. No proper
nouns, no offensive terms.

If `answers.ts` ever needs to grow, curate additions by hand (or by
filtering `allowed.ts` down with a real commonness/frequency source) rather
than promoting dictionary entries wholesale -- the whole point of keeping it
separate from `allowed.ts` is to keep that curation bar.
