// Puzzle record shapes shared by every pack under content/puzzles/.
export type MatePuzzle = { fen: string; solution: string; name: string; hint: string };
export type HuntPuzzle = { fen: string; answer: string; story: string };
export type TacticPuzzle = { fen: string; solution: string; story: string };
