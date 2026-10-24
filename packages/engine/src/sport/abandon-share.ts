// Owner P-5 (2026-10-13), verbatim: sharing the points on an abandoned match is a drawn result, so a cfg that takes no
// draw cannot offer it. The refusal a save gets (CONFIG_INVALID, on the `abandonPolicy` field), for generic and carrom.
export const SHARE_NEEDS_DRAWS = "Sharing the points needs draws to be allowed.";
// Carrom's refusal of the same rule (fix round 1, ruling): it takes a draw only under the tieBoard "draw" house rule, so
// the sentence names the setting the organiser has to change.
export const SHARE_NEEDS_DRAWN_GAME = "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.";
