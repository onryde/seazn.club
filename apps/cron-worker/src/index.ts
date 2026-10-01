import { handleManual } from "./manual";
import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // I-2: AWAIT the run. The runtime keeps a scheduled invocation alive for the promise this
    // handler RETURNS (up to the cron wall limit). A fire-and-forget `ctx.waitUntil` may be cut at
    // the shorter waitUntil cap, and would cancel a long billing sweep mid-run.
    // R4: the firing trigger (controller.cron) picks the rows; the scheduled time picks the slot.
    await runDue(new Date(controller.scheduledTime), controller.cron, env, liveDeps());
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleManual(req, env, liveDeps());
  },
} satisfies ExportedHandler<Env>;
