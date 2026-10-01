import { handleManual } from "./manual";
import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // R4: the firing trigger (controller.cron) picks the rows; the scheduled time picks the slot.
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), controller.cron, env, liveDeps()).then(() => undefined));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleManual(req, env, liveDeps());
  },
} satisfies ExportedHandler<Env>;
