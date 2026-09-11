# Control run — both walls at 30 s

Same commit, same pack, same environment as the two legs beside this
directory; the ONLY change is the solver wall, raised from the 10 s default to
30 s on BOTH sides of the wire:

- web: `PLACEMENT_WALL_SECONDS=30` — feeds `canSolveWithin`, the admission gate
- service: `PLACEMENT_WALL_SECONDS_MAX=30` — the actual solve time, applied by
  `services/placement/main.py:167` as a silent `min()` clamp

Raising only one buys nothing, in either direction: the web side alone widens
the gate while the service holds the solve at 10 s, and the service side alone
lets a board through that the gate has already refused.

This run exists to settle one question — whether the `solver_unavailable`
recorded in both legs was the wall — and it answers no. See the parent
`README.md`, "The open findings", for the reading. Gate green, 0 errors,
oracle verdicts identical to both legs.
