// server/client-reports/define.ts — what ONE kind of client report is (Task 25b). Pure zod: no database, no network, nothing
// server-only, and no app alias: the bare OpenAPI generator loads every kind through kinds.ts, and the scripts program
// (tsconfig.scripts.json, nodenext) type-checks them on that path, so even a type-only import of the database module is out.
//
// A kind is its closed body schema and the facts the shared pipeline (receive.ts) reads off one report of it: the subject a client's
// reports are limited per (with its IP), the key one Sentry event per window stands for, whether the subject exists, and the message,
// tags and fields the log line and the Sentry event carry, and (optionally) its own Sentry budget. Adding a kind is one file that calls
// `defineClientReportKind`, plus its entry in kinds.ts.
import { z } from "zod";
import { CLIENT_REPORT_CODE, CLIENT_REPORT_SECRET_WORD } from "../../lib/client-reports.ts";

/** The database a kind checks its subject in: ONE tagged-template read, its values plain scalars. Typed by shape, not by importing
 *  the client (see the header): the caller, receive.ts, hands over the privileged `sql` tag, which this shape accepts. */
export type ReportDb = <T extends readonly object[]>(
  template: TemplateStringsArray,
  ...values: readonly (string | number | boolean | null)[]
) => PromiseLike<T>;

/** A report's code field: a bare word that names no credential (lib/client-reports.ts). Every free string of a kind is one. */
export const ReportCode = z
  .string()
  .regex(CLIENT_REPORT_CODE)
  .refine((v) => !CLIENT_REPORT_SECRET_WORD.test(v), { message: "a code never names a credential" });

/** What the pipeline reads off one valid report. Codes only: nothing here is an address, a query or an error's text. */
export interface ReportFacts {
  /** The limit's subject: a client's reports are limited per kind, subject and IP (CLIENT_REPORT_LIMIT), and dropped past it. */
  rateSubject: string;
  /** One Sentry event per kind and this key per window (CLIENT_REPORT_SENTRY_WINDOW_SECONDS); later ones are a server-log line only and spend no Sentry budget. */
  dedupeSubject: string;
  /** Whether the report is about something that exists and is this kind's to report on. False: dropped, nothing logged. */
  subjectExists: (db: ReportDb) => Promise<boolean>;
  /** The log line's and the Sentry event's message. */
  message: string;
  /** The Sentry event's tags. */
  tags: Record<string, string>;
  /** The log line's fields and the Sentry event's extras. */
  fields: Record<string, string | number | null>;
}

/** A kind's Sentry budget: at most `max` of its reports reach Sentry per `windowSeconds`, across every client and subject. Only a
 *  report that is the FIRST of its dedupe key in the window spends it (one Sentry Log and one event); a repeat spends nothing. Past
 *  it a report is a server-log line only. It bounds what any number of IPs naming any number of subjects can spend of the org's
 *  Sentry quota. */
export interface SentryBudget {
  max: number;
  windowSeconds: number;
}

/** The budget a kind gets unless it names its own: 60 first reports an HOUR (review N1: at most 1,440 Sentry events and as many Logs a
 *  day per kind; first reports only, so a long window costs no real report anything). */
export const CLIENT_REPORT_SENTRY_BUDGET: SentryBudget = { max: 60, windowSeconds: 3600 };

/** The body schema a kind is: a closed object whose `kind` is its literal name. */
export type KindSchema = z.ZodObject<{ kind: z.ZodLiteral<string> } & z.ZodRawShape, z.core.$strict>;

export interface ClientReportKind<S extends KindSchema = KindSchema> {
  readonly kind: string;
  readonly schema: S;
  /** CLIENT_REPORT_SENTRY_BUDGET unless the kind named its own. */
  readonly sentryBudget: SentryBudget;
  /** The facts of a report of this kind. Parses with the kind's own schema first, so a body of another kind can never be read as this
   *  one's (it throws). */
  facts: (report: unknown) => ReportFacts;
}

export function defineClientReportKind<S extends KindSchema>(
  schema: S,
  facts: (report: z.output<S>) => ReportFacts,
  options: { sentryBudget?: SentryBudget } = {},
): ClientReportKind<S> {
  const sentryBudget = options.sentryBudget ?? CLIENT_REPORT_SENTRY_BUDGET;
  if (!(Number.isInteger(sentryBudget.max) && sentryBudget.max >= 1 && Number.isInteger(sentryBudget.windowSeconds) && sentryBudget.windowSeconds >= 1)) {
    throw new RangeError(`client reports: a Sentry budget is whole and positive (${JSON.stringify(sentryBudget)})`);
  }
  return { kind: schema.shape.kind.value as string, schema, sentryBudget, facts: (report) => facts(schema.parse(report)) };
}
