// D7 (W1-driving plan): the ONE construct that names an owning wave. The
// Q-A guard (scenario-catalogue.test.ts, ruling 28) reads every
// routeTo("<literal>", …) and every deferral class from the AST, and refuses
// a bare wave literal anywhere else — so "no route names a closed wave" is
// checked in one place and a new routing shape cannot hide.
//
// A leaf (no imports): every module that routes work reaches it, the layer
// planner included, without pulling anything else in.

/** The programme's wave ids (_INDEX.md Status; routing.test.ts reads the table). */
export const WAVE_ID = /^W(?:1[a-d]|1-driving|[2-9]|10)$/;

export interface Route { readonly wave: string; readonly why: string }

export class NotAWave extends Error {
  constructor(wave: string) {
    super(`routing: '${wave}' is not a programme wave (${WAVE_ID.source}) — a route must name a wave with a status row`);
    this.name = "NotAWave";
  }
}

export function routeTo(wave: string, why: string): Route {
  if (wave === "") throw new Error("routing: a route needs a wave");
  if (why.trim() === "") throw new Error(`routing: a route to ${wave} needs a why`);
  if (!WAVE_ID.test(wave)) throw new NotAWave(wave);
  return Object.freeze({ wave, why });
}
