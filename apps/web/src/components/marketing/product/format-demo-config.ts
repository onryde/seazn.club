import type { FunnelRankInput } from "@/lib/format-recommend";

/**
 * The Format page's fixed facts, in one place so its tests can check each against the product's own source of truth
 * (format-page.test.tsx: the plan claims against FORMAT_FAMILIES' `pro` flags, the opening day against `rankFormats`).
 */

/** The day the demo opens on: a Saturday morning's worth of pitches for eight teams. */
export const FORMAT_DEMO_START: FunnelRankInput = { entrants: 8, courts: 2, hours: 4, matchMinutes: 30 };

export const FORMAT_DEMO_LIMITS = { entrants: [3, 32], courts: [1, 8], hours: [1, 12] } as const;
export const FORMAT_DEMO_MINUTES = [20, 30, 45, 60, 90] as const;

/** Format-gallery slugs the page says are on every plan, and the one it names as Pro. Both follow the server gate
 *  (usecases/format-gates.ts: only the americano and ladder stage kinds need `formats.advanced`; double elimination and
 *  the page playoff are on every plan since V393) - format-page.test.tsx derives the expected sets from that gate. */
export const FREE_FORMATS = ["league", "groups-knockout", "knockout", "swiss", "double_elim"] as const;
export const PRO_FORMAT = "americano";
