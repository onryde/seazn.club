// H.264 (ITU-T H.264) Annex A, Table A-1: every level_idc a level can carry, and how capture-record.v1's `codecLevel`
// writes it (Task 50). The rulebook for the level sweep, typed ONCE here and read by the contract test and the domain
// test, never derived from the contract's pattern or the twin: a level the pattern refuses fails the sweep.
//
// level_idc is ten times the level (11 = 1.1, 40 = 4.0); 9 is level 1b (Table A-1, which also lets level_idc 11 mean 1b
// under constraint_set3 on the baseline-family profiles — not a separate value to write). The word drops a ".0".

/** Table A-1's levels as level_idc: 1b, then 1, 1.1, 1.2, 1.3, 2, 2.1, 2.2, 3, 3.1, 3.2, 4, 4.1, 4.2, 5, 5.1, 5.2, 6, 6.1, 6.2.
 *  (No 4.3 or 6.3: Table A-1 has none.) */
export const H264_LEVEL_IDCS = [9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62] as const;

/** How a phone writes a level_idc: 9 → "1b"; otherwise the major, then ".minor" unless the minor is 0. */
export function codecLevelWord(idc: number): string {
  if (idc === 9) return "1b";
  const major = Math.floor(idc / 10), minor = idc % 10;
  return minor === 0 ? String(major) : `${major}.${minor}`;
}

/** The level words, in Table A-1's order (20 of them). */
export const H264_LEVEL_WORDS: readonly string[] = H264_LEVEL_IDCS.map(codecLevelWord);
