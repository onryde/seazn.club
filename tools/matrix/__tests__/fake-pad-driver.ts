// The league fake with the pad path's two answers (W1c Task 7). postStream
// answers every event with `stored`, the row "the pad wrote", and finalize taps
// Finalize on a decided fixture. `storedAs` is the seam: identity is a pad that
// wrote what it was asked; anything else is a pad that wrote something else,
// the case the stored fold exists for. Test-only.
import { foldStream } from "../lib/fold.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import type { FixtureStateOut, PostedEvent } from "../lib/driver/types.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

export class FakePadDriver extends FakeLeagueDriver {
  /** What the "pad" stores for the events it is asked to write. */
  storedAs: (events: readonly StreamEvent[]) => StreamEvent[] = (evs) => [...evs];
  readonly finalized: string[] = [];

  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const rows = this.storedAs(events);
    const posted = await super.postStream(id, rows, prefix);
    return posted.map((p, i) => ({ ...p, stored: rows[i] }));
  }

  /** The console's Finalize: one core.finalize on a decided fixture. */
  finalize(id: string): Promise<FixtureStateOut> {
    this.log("finalize");
    const f = this.fixtures.find((x) => x.id === id);
    if (f === undefined) return Promise.reject(new Error(`fake: no fixture ${id}`));
    if (f.status !== "decided") return Promise.reject(new Error(`fake: fixture ${id} is ${f.status}, not decided`));
    // The fold still reads the fixture's outcome after a finalize (the engine's core event).
    f.events = [...f.events, { type: "core.finalize", payload: {} }];
    f.outcome = foldStream(sportModule(this.sport), this.cfg, f.home_entrant_id!, f.away_entrant_id!, f.events).outcome;
    f.status = "finalized";
    this.finalized.push(id);
    return Promise.resolve({ status: f.status, last_seq: f.events.length, outcome: f.outcome });
  }
}
