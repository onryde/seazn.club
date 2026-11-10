import "server-only";


export const MS_PER_MIN = 60_000;

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const ms = (iso: string): number => Date.parse(iso);
