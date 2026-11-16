import { cricketPadRules } from "@seazn/engine/pad";

/**
 * The over length the chase demo plays to, read from the engine's own declaration so the demo cannot drift from the
 * real pad's over.
 *
 * SERVER ONLY, and in its own file for that reason: the page reads this and hands the number to the island as a prop.
 * Importing the engine from the island's side (cricket-chase.ts, chase-demo.tsx) put ~380 KB of script on a public
 * marketing page for one number; a test in chase-demo.test.tsx walks the island's imports to keep it out.
 */
export const BALLS_PER_OVER: number = cricketPadRules.ballsPerOver({});
