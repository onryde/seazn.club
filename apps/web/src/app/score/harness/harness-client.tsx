"use client";

import { useMemo, useState } from "react";
import type { LineupPair } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import { PadRenderer } from "@/components/v2/scorepad/pad-renderer";
import { resolveModuleClient } from "@/components/v2/scorepad/module-client";
import { sessionTransport } from "@/components/v2/scorepad/transport";
import type { PadTransport } from "@/components/v2/scorepad/transport";
import type { AppendCallResult } from "@/components/v2/scorepad/pipeline";
import type { LedgerSlotEvent } from "@/components/v2/scorepad/types";

/**
 * S10/#419 — see `page.tsx` for why this route exists and when it is deleted.
 *
 * Two modes, because the two things needing browser proof want different
 * backing:
 *
 *  - `?fixture=<uuid>` drives the REAL API with the session cookie. This is
 *    the mode the offline/drain/tab-death e2e uses: real HTTP, real ledger,
 *    real 409s.
 *  - no `fixture` ⇒ an in-page ledger stands in for the server. IndexedDB,
 *    the queue, the fold and the whole renderer are still the real ones, so
 *    the pad can be driven (and screenshotted) without seeding a division
 *    first. It is NOT evidence about the server contract and must never be
 *    the mode an acceptance criterion is judged on.
 */

const HARNESS_PERSON_IDS = ["h-1", "h-2", "h-3", "a-1", "a-2", "a-3"] as const;

function harnessLineups(): LineupPair {
  return {
    home: {
      entrantId: "harness-home",
      slots: [
        { personId: "h-1", slot: "starting", orderNo: 1, squadNumber: 1, positionKey: "GK" },
        { personId: "h-2", slot: "starting", orderNo: 2, squadNumber: 7 },
        { personId: "h-3", slot: "bench", orderNo: 3, squadNumber: 12 },
      ],
    },
    away: {
      entrantId: "harness-away",
      slots: [
        { personId: "a-1", slot: "starting", orderNo: 1, squadNumber: 1, positionKey: "GK" },
        { personId: "a-2", slot: "starting", orderNo: 2, squadNumber: 9 },
        { personId: "a-3", slot: "bench", orderNo: 3, squadNumber: 14 },
      ],
    },
  };
}

/** An in-page stand-in for the ledger: assigns `expected_seq + 1` and refuses a
 *  stale seq with the same 409 shape the real route returns, so the queue's
 *  conflict path is exercised rather than bypassed. */
function localTransport(): PadTransport {
  const rows: LedgerSlotEvent[] = [];
  let lastSeq = 0;
  return {
    appendEvent(_fixtureId, body): Promise<AppendCallResult> {
      if (body.expected_seq !== lastSeq) {
        return Promise.resolve({
          kind: "conflict",
          currentSeq: lastSeq,
          message: `expected seq ${body.expected_seq} but ledger is at ${lastSeq}`,
        });
      }
      lastSeq += 1;
      rows.push({
        seq: lastSeq,
        type: body.type,
        payload: body.payload,
        recorded_by: null,
        device_link_id: null,
      });
      return Promise.resolve({
        kind: "ok",
        data: { seq: lastSeq, state_summary: null, outcome: null, status: "in_play" },
      });
    },
    listEventsSince(_fixtureId, sinceSeq) {
      return Promise.resolve(rows.filter((r) => r.seq > sinceSeq));
    },
    getLastSeq() {
      return Promise.resolve(lastSeq);
    },
    fetchState() {
      return Promise.resolve({
        status: "in_play",
        last_seq: lastSeq,
        state: null,
        summary: null,
        outcome: null,
      });
    },
  };
}

export interface HarnessClientProps {
  sportKey: string;
  variant: string | null;
  fixtureId: string | null;
  band: FidelityBand;
  locked: boolean;
}

export function HarnessClient(props: HarnessClientProps) {
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(() => {
    try {
      const mod = resolveModuleClient(props.sportKey, "1.0.0");
      // A bare `{}` is NOT a legal cfg for every module — generic's
      // `resultMode`/`allowDraws` are required with no default — so fall back
      // to the module's own first named preset rather than reporting a config
      // error the pad had nothing to do with. A real caller always arrives
      // with the division's resolved cfg; only this harness has to invent one.
      const candidates = props.variant
        ? [mod.variants[props.variant] ?? {}]
        : [{}, ...Object.values(mod.variants)];
      for (const candidate of candidates) {
        const parsed = mod.configSchema.safeParse({ ...candidate });
        if (parsed.success) return { mod, cfg: parsed.data };
      }
      return { mod, cfg: mod.configSchema.parse({ ...(candidates[0] ?? {}) }) };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [props.sportKey, props.variant]);

  const transport = useMemo(
    () => (props.fixtureId ? sessionTransport() : localTransport()),
    [props.fixtureId],
  );

  /** Grant every entitlement the resolved module's own spec names, so the pad
   *  draws its real controls. `?locked=1` grants none, which is how the
   *  paid-band locked state gets reviewed — that state is as much a product
   *  surface as the unlocked one. */
  const entitlements = useMemo(() => {
    if (resolved === null || props.locked) return {};
    const spec = resolved.mod.padSpec?.(resolved.cfg as never);
    const granted: Record<string, boolean> = {};
    for (const key of Object.values(spec?.fidelityEntitlements ?? {})) {
      if (typeof key === "string") granted[key] = true;
    }
    return granted;
  }, [resolved, props.locked]);

  if (error !== null || resolved === null) {
    return (
      <main className="p-6">
        <p data-testid="harness-error" className="text-sm text-red-700">
          {error ?? "module unavailable"}
        </p>
      </main>
    );
  }

  return (
    <main data-testid="scorepad-harness" data-sport={props.sportKey}>
      <PadRenderer
        module={resolved.mod}
        cfg={resolved.cfg}
        fixtureId={props.fixtureId ?? "harness-fixture"}
        lineups={harnessLineups()}
        identity={{ recordedBy: null, deviceLinkId: null }}
        transport={transport}
        band={props.band}
        entitlements={entitlements}
        queueDbName={`scorepad-harness-${props.sportKey}`}
      />
      <p className="sr-only">{HARNESS_PERSON_IDS.join(" ")}</p>
    </main>
  );
}
