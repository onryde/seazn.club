// Match Day's slice of the PUBLIC dictionary (the `scoreDict` the page hands the island): the keys the court's score and its preview read.
// Pure and client-safe, like `pickDictPrefixes` it wraps.
//
//   matchCentre.        the score line's words (serving, the live level's marks, the status words)
//   forfeit.            the forfeit sentence
//   seaznVideo.         the Seazn player's live chip, its "can't play" sentence and the part picker's tab (Seazn-hosted video, Task 17)
//   overlay.replay      the replay region's name, the one word the Seazn island takes from the overlay group (an exact key: the rest of
//                       `overlay.` is the stream overlay's and stays on the server)
//
// The island is the match page's own (`SeaznVideoIsland`), which reads its labels through `seaznVideoLabels(dict)`; a slice without these
// keys makes `t()` print the KEY NAME where the sentence belongs, in every locale (the Task 15 review's m6).
import type { Dict } from "@/lib/i18n-constants";
import { pickDictPrefixes } from "@/lib/i18n-subset";

export const MATCH_DAY_SCORE_DICT_PREFIXES = ["matchCentre.", "forfeit.", "seaznVideo.", "overlay.replay"] as const;

export const matchDayScoreDict = (pub: Dict): Dict => pickDictPrefixes(pub, MATCH_DAY_SCORE_DICT_PREFIXES);
