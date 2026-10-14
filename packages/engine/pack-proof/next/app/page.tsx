// A server component. `next build` prerenders it, which RUNS these imports (not just resolves them) against the packed build.
import { EngineError } from "@seazn/engine/core";
import { createRegistry } from "@seazn/engine/sport";

export default function Page() {
  const registry = createRegistry();
  return (
    <main>
      <p>{typeof EngineError}</p>
      <p>{typeof registry.register}</p>
    </main>
  );
}
