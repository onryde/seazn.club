import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // R4: the firing trigger (controller.cron) picks the rows; the scheduled time picks the slot.
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), controller.cron, env, liveDeps()).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
