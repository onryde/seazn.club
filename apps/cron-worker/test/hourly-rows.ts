import { JOBS, TRIGGER_CRON, type Due, type Job } from "../src/schedule";

/**
 * The rows that hang off the hourly trigger, grouped by when they are due, read from the schedule table's own declarations
 * (`trigger` and `due.kind`), never typed out. A test that says "the hourly firing runs N rows" derives N here, so adding
 * an every-firing row (sponsor deals T9 was the fourth) moves its expectations instead of reddening six of them by a count.
 *
 * WHICH rows these are is pinned independently: schedule.test.ts types them from the spec (`HOURLY`) and compares them with
 * `dueJobs`, so a row dropped from the table fails there rather than shrinking the expectations here.
 */
const hourlyRows = (kind: Due["kind"]): readonly Job[] => JOBS.filter((j) => j.trigger === TRIGGER_CRON && j.due.kind === kind);

/** Due on EVERY hourly firing (`due: { kind: "every" }`), in table order: what an ordinary hour, e.g. a Tuesday 14:17, runs. */
export const HOURLY_EVERY_ROWS = hourlyRows("every");
/** Due once a day, at their own hour. */
export const HOURLY_DAILY_ROWS = hourlyRows("daily");
/** Due once a week, at their own weekday and hour. */
export const HOURLY_WEEKLY_ROWS = hourlyRows("weekly");
