import "server-only";

export const MS_PER_MIN = 60_000;

export const ms = (v: string | Date): number => new Date(v).getTime();

export const iso = (t: number): string => new Date(t).toISOString();

export const roundToMinute = (t: number): number => Math.ceil(t / MS_PER_MIN) * MS_PER_MIN;
