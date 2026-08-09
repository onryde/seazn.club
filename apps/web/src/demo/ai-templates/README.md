# Marketing demo fixtures (#364)

`club-night.json`, `northside-open.json` and `finals-day.json` are **recordings
of real AI architect runs**, not simulations. Each was captured once against a
live model and is rendered by the public page through the product's own pure
functions (trace, diff, price are recomputed at render, never stored).

Shape: `types.ts` (`AiDemoFixture`). Seed builders: `__capture__/seeds.ts`.

## Re-capturing

Only when a template's **dataset** changes — a seed, or the organiser's
instruction, which is compiled into enforced rules and so counts as data.

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:54339/<throwaway> \
DATABASE_SSL=disable \
npm run capture:ai-demo -- -t "captures <slug>"
```

* **Name a throwaway database.** The capture seeds real organisations and
  competitions. Run without an explicit `DATABASE_URL` and the harness
  **refuses** — a bare `npm run capture:ai-demo` would otherwise inherit the
  repo-root `.env.local` and seed the dev database. Override with
  `CAPTURE_DB_OK=1` only if you mean it.
* **One template at a time**, via `-t`. A joint run is minutes of model time and
  real money; re-running a template that already succeeded buys nothing.
* **Never re-run a succeeded capture to get a nicer plan.** The recording is
  whatever the product actually produced.
* Cost, for scale: about $0.12 / $0.25 / $0.64 for club-night / finals-day /
  northside-open on the shipped ladder's first rung.

## The guard

`__capture__/capture.test.ts` also holds an always-on suite that reseeds each
template and asserts the pack it rebuilds matches the committed one, up to
per-seed UUIDs — the issue's "re-runs and reproduces" acceptance. It **fails**
rather than skips when a fixture is missing, and it deletes the organisations it
created so repeated `npm test` runs do not accumulate boards in the shared test
database.
