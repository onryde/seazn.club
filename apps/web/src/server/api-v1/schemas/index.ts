// /api/v1 request/response contracts (doc 08 §3–§5). Single source of truth:
// route handlers parse requests with these, and openapi.ts derives the served
// spec from them — code and contract cannot drift.
//
// NOT server-only: pure Zod, shared with the OpenAPI generator script.
// Bare `node --experimental-strip-types` loads this folder (scripts/openapi-gen.ts and the
// tools/ suites import `schemas/index.ts`): every relative import carries an explicit `.ts`,
// type-only names come in through `import type`, and nothing uses the `@/` alias.
//
// This barrel is the map and the whole public surface. Open the ONE module you need:
//   common.ts                ids (Uuid, CourtId, VenueId, Slug), status and kind enums, ApiKeyScope, RequiredCourtTags: the leaf every module may import
//   competitions.ts          competitions: create/patch/read, discovery info, public-quota degraded, the date-order check (ENDS_BEFORE_STARTS)
//   divisions.ts             divisions: create/patch/read, age band and cutoff checks, camera policy, patched-division report, eligibility override (RS011)
//   entrants.ts              entrants: create/patch/read, teams and squads, roster sync, withdraw cascade, Swiss and knockout late-entry results
//   persons.ts               persons and profiles: consent, merge, claims, availability, and the /me surface (MyFixtures, MyTeam, CheckinLink)
//   stages.ts                stages: take/progression rules (+ engine twins), stage config, court tags, stage and fixture rules, table-stage rules, standings, templates
//   fixtures.ts              fixtures: patch and stream, Match Day call/rounds/courts/candidates, external-play arbiter, lobby, room and video
//   streaming.ts             streaming (R1): stream sessions, targets and YouTube, phone beat, relay heartbeat, phase and job contracts
//   scoring.ts               Fixture read model, competition desk, lineups, score events (append/import), fixture state, API keys, device links, scorer sheets
//   generation.ts            stage actions: generate, rebuild and unpair results, Swiss reshape and rounds, open round, check-in extension, complete
//   scheduling.ts            scheduling console (doc 12): ScheduleConfig and settings, rule codes, conflicts and their detail, auto-schedule request and metrics
//   schedule-analysis.ts     capacity pre-check (D2), schedule health (D3), auto-schedule result, apply, validate and publish
//   scorer.ts                scorer console (doc 13): AssignedFixture, start-division request and result
//   registration.ts          registration and entry fees: staff side, the public register/join/status flow, Stripe Connect onboarding
//   clubs.ts                 clubs, contacts, standalone teams, logo assignment, bulk import preview and commit, officials CRUD
//   sponsors.ts              sponsor CRM: sponsors, stream settings, report links, packages, sponsor deals
//   officiating.ts           officiating portal and official assignment, schedule undo and versioning (checkpoints, locks, clear)
//   ai-planning.ts           scheduling constraints v2 and AI: ScheduleShift, plan/repair, officials plan, joint multi-division (#350), parse preview (W5), OverrideStandings
//   seeding-discipline.ts    seed proposals (D4a), ladder challenge, discipline and suspensions, official marks, match reports
//   org-admin.ts             org news posts, duplicate review and merge (#404), venues and courts (D5)
//   public.ts                public fixture summary (GET /public/fixtures/{id}) and PublicOrgLive
//   quick-match.ts           quick match: the guest's one create (CreateQuickMatch)
//
// Dependency order is strictly downward (a module imports only from the ones listed above it;
// none imports ./index), which is also the order zod consts must evaluate in. Helpers a sibling
// needs are `export`ed from their module but are NOT re-exported here.

// Capture QR v2 (PR-1 T1) — the phone↔web contract's zod twins (docs/contracts/capture-*.json), re-exported, never
// re-typed. Relative + explicit `.ts`, same reason as above; capture-schemas.ts imports zod and nothing else.
export {
  CAPTURE_CODE_RE, CaptureEndReason, CaptureStartedBy, CaptureCause, CapturePhoneState, CaptureNotReady,
  CaptureStartFailed, CaptureWaiting, CaptureCred, CaptureSession, CaptureDescriptor, CaptureBeat, CaptureBeatAnswer,
  CaptureStartBody, CaptureStartOk, CaptureRefusalCode, CaptureRefusal,
  // W27 / W28 (2026-10-06).
  CAPTURE_POOL_RE, CaptureStageRole, CaptureStage, CAPTURE_STAGE_LABEL_MAX, CAPTURE_SCORING_LINK_URL_RE, CaptureScoringLinkOk,
  // capture-record.v1 (spec 2026-10-12, approved).
  CAPTURE_RECORD_MAX_LINES, CAPTURE_RECORD_MAX_BYTES, CAPTURE_RECORD_REF_RE, CaptureRecordLine, CaptureRecordOk,
  CaptureRecordRefusalCode, CaptureRecordRefusal, CaptureRecordSecretS2, CaptureRecordSecretS3, CaptureRecordSecretS4,
  CaptureRecordSecretS5,
} from "../capture-schemas.ts";
export {
  Uuid, CourtId, RequiredCourtTags, VenueId, Slug, Visibility, CompetitionStatus, DivisionStatus, StageKind,
  EntrantKind, EntrantStatus, ApiKeyScope,
} from "./common.ts";
export {
  ENDS_BEFORE_STARTS, CreateCompetition, DiscoveryInfo, PatchCompetition, Competition, PublicQuotaDegraded,
  CreatedCompetition,
} from "./competitions.ts";
export {
  TiebreakerKeyS, DivisionCategory, AGE_MAX_BEFORE_MIN, AGE_CUTOFF_BOTH_OR_NEITHER, AGE_CUTOFF_DAY_INVALID_FOR_MONTH,
  CameraPolicyS, CreateDivision, PatchDivision, Division, RefusedFieldS, KeptPinnedStageS, PatchedDivision,
  EligibilityOverride,
} from "./divisions.ts";
export {
  PersonLane, EntrantMemberInput, NewPersonMemberInput, CreateEntrantMemberInput, CreateEntrant, CreateEntrants,
  CreateTeam, SetTeamSquad, SyncEntrantRoster, PatchEntrant, Entrant, WithdrawCascadeReport, SwissLateEntryResult,
  KnockoutLateEntryResult, LateEntryResult, PatchedEntrant, CreatedEntrant,
} from "./entrants.ts";
export {
  Consent, CreatePerson, PatchPerson, MergePersons, ReverseMerge, PutProfile, Person, CreateClaimInvite, PersonClaim,
  CreatedPersonClaim, PutAvailability, Availability, PatchMyConsent, MyPerson, MyFixture, MyResult, MyTeam,
  MyFixtures, CheckinLink,
} from "./persons.ts";
export {
  TakeRuleSchema,
} from "./stages.ts";
export type {
  TakeRuleSchemaMatchesEngine, TakeRuleSchemaMatchesEngineFields, TiebreakerKeySchemaMatchesEngine,
  TieBreakKeySchemaMatchesEngine, TieBreakNoteSchemaMatchesEngine, TableRulesSourceSchemaMatchesEngine,
  OutcomeKeySchemaMatchesEngine,
} from "./stages.ts";
export {
  ProgressionSchema,
} from "./stages.ts";
export type {
  ProgressionInput,
} from "./stages.ts";
export {
  STAGE_DECIDER_MOVED, StageConfig, CreateStage, CreateStages, StageRoundCourtTags, PutStageCourtTags, StageCourtTags,
  PutStageRules, StageRules, PutFixtureRules, FixtureRulesResult, FixtureCurrentRules, DeviceLinkBootstrap,
  RealtimeTokenOut, AddFixture, Stage, TableRulesSourceS, OutcomeKeyS, StageTableRules, StageWithTableRules,
  FormatChangePreview, TieBreakKeyS, TieBreakNoteS, StandingsRow, StandingsSnapshot, PublicDivisionStandings,
  CreateFromTemplate, FromTemplateResult,
} from "./stages.ts";
export {
  PatchFixture, PutFixtureStream, CallFixtureInput, FixtureCalled, FixtureCallUndone, MatchDayRound,
  FixtureCallPreview, MatchDayFixture, MatchDayCourt, MatchDayView, MatchDayCandidate, ArbiterJoinInput,
  ArbiterJoinOut, ArbiterLeaveOut, ExternalPlayResyncOut, VideoOverrideInput, VideoOverrideOut, ExternalPlayLobbyOut,
  ResolveExternalPlay, ResolveExternalPlayOut, CloseExternalPlayFlags, CloseExternalPlayFlagsOut, RoomAct,
  RoomCameraFault, RoomCameraReport, RoomSeatClaim, RoomCameraAnswer, RoomActOut, FixtureStream,
  JointWinnersResult, JointWinnersUndoResult,
} from "./fixtures.ts";
export {
  StreamMode, StreamSessionState, StreamFailReason, StreamEndReason, StreamTargetKind, CreateStreamSession,
  StreamSessionCreated, StreamHealth, StreamIngest, StreamOutput, StreamRestartAllowance, StreamLostCountdown,
  StreamSessionCurrent, StreamCodeShown, PutStreamSettings, StreamSettings, StreamPhoneBeat, StreamPhone,
  StreamPlatform, CreateStreamTarget, StreamTargetHolder, YoutubePrivacy, YoutubeConnectionView, StreamTarget,
  StreamTargetSaveOutcome, StreamTargetSaved, PatchStreamTarget, StreamTargetRemoved, PickYoutubeChannel,
  YoutubeConnectionSaved, YoutubePendingChannels, YoutubeConnectionSettings, YOUTUBE_REVOKE_OUTCOMES,
  YoutubeDisconnected, RelayAiring, RelayHeartbeat, RelayHeartbeatReply, RelayPhaseReply, RelayPhaseEndpoint,
  RelayJobInput, RelayJobOutput, RelayJobSession,
} from "./streaming.ts";
export {
  SlotLabelRef, Fixture, DeskInPlayFixture, DeskNextFixture, CompetitionDesk, LineupSlotInput, PutLineup,
  AppendEventRequest, EventImportRequest, EventImportReport, ScoreEvent, AppendEventResponse, FixtureState,
  StandingsRowOut, CreateApiKey, ApiKey, CreatedApiKey, CreateDeviceLink, DeviceLink, CreatedDeviceLink,
  ScorerSheetsRequest,
} from "./scoring.ts";
export {
  SwissReshapeResult, SwissRoundsJudgementResult, GenerateResult, GenerateStageInput, RebuildResult, UnpairResult,
  PatchSwissStage, PatchSwissStageResult, PatchKnockoutStage, PatchKnockoutStageResult, PatchStage, AddSwissRoundResult, FinishSwissResult, SwissCutDriftResult, OpenRoundInput,
  OpenRoundSkip, OpenRoundResult, CheckinExtendBoardOut, ExtendRoundCheckinInput, CheckinExtendRoundOut,
  CompleteResult,
} from "./generation.ts";
export {
  CAPACITY_REPORT_KEY, ScheduleConfig, WINDOW_ENDS_BEFORE_STARTS, PutScheduleSettings, ScheduleSettings, RuleCode,
  ScheduleConflict, PatchedFixture, ScheduleAssignment, AutoScheduleRequest, ScheduleMetrics, ScheduleSolverInfo,
} from "./scheduling.ts";
export {
  CapacityReport, CapacityPrecheck, HealthOffender, HealthMetric, ScheduleHealthReport, StageHealthEntry,
  DivisionHealthEntry, CompetitionScheduleHealthReport, AutoScheduleResult, AiApplyMeta, ApplyScheduleRequest,
  AiLastResult, ApplyScheduleResult, ValidateScheduleResult, PublishScheduleRequest, PublishScheduleResult,
  PublishCompetitionScheduleRequest, PublishCompetitionScheduleResult,
} from "./schedule-analysis.ts";
export {
  AssignedFixture, StartDivisionRequest, StartDivisionResult,
} from "./scorer.ts";
export {
  RegistrationStatus, RegistrationSort, RegistrationPaymentMethod, RegistrationApproval, RegistrationFormField,
  PutRegistrationSettings, RegistrationSettings, Registration, RefundRegistration, RegistrationListEntry,
  PromoteRegistration, AssignSoloSignUp, AssignTargets, AssignSoloSignUpResult, UnassignSoloSignUpResult,
  PublicRegistrationDivision, PublicRegistrationInfo, PublicRegisterGroupContact, PublicRegisterGroupPlayer,
  PublicRegisterGroupEntry, PublicRegisterGroupRequest, PublicRegisterGroupEntryResult, PublicRegisterGroupResponse,
  PublicJoinRequest, PublicJoinResponse, PublicJoinPreviewSlot, PublicJoinPreviewResponse, PublicRegistrationStatus,
  PublicRegistrationToken, ConnectStatus, CreateConnectOnboarding, ConnectOnboardingLink,
} from "./registration.ts";
export {
  Club, CreateClub, PatchClub, ClubContact, CreateClubContact, PatchClubContact, CreateTeamStandalone, PatchTeam,
  ClubDetail, LogoAssignment, ImportPreview, ImportCommitRequest, ImportCommitResult, Official, CreateOfficial,
  PatchOfficial,
} from "./clubs.ts";
export {
  SponsorTier, SponsorStatus, SponsorDeal, CreateSponsorDeal, SponsorDealCreated, SponsorDealInvoiceSent, Sponsor,
  CreateSponsor, PatchSponsor, SponsorStreamFrequency, PutSponsorStreamSettings,
  SponsorStreamSettings, CreateSponsorReportLink, CreatedSponsorReportLink, RevokedSponsorReportLink, ReorderSponsors,
  SponsorPackage, CreateSponsorPackage,
} from "./sponsors.ts";
export {
  OfficiatingResponseInput, OfficiatingResponseOut, OfficiatingBlackoutInput, OfficiatingBlackout,
  OfficiatingScoreLink, OfficiatingClaimAccepted, AutoAssignOfficials, OfficialsProposal, ApplyOfficials,
  PatchFixtureOfficials, SourceOfficials, HistoryStep, CreateCheckpoint, RestoreCheckpoint, DivisionLocks,
  ClearSchedule, ClearPoolEntrants,
} from "./officiating.ts";
export {
  ScheduleShift, AiPlanRequest, AiRepairReport, AiPlanResponse, AiOfficialsPlanRequest, AiOfficialsPlanResponse,
  AiCompetitionPlanRequest, AiCompetitionPlanResponse, AiParsePreviewRequest, AiParsePreviewResponse,
  AiCompetitionLastResult, ApplyCompetitionScheduleRequest, ApplyCompetitionScheduleResult,
  RestoreCompetitionScheduleRequest, RestoreCompetitionScheduleResult, OverrideStandings,
} from "./ai-planning.ts";
export {
  SeedProposalComputed, SeedProposal, ConfirmSeedProposal, ConfirmSeedProposalResult, LadderChallenge,
  SuspensionStatus, DisciplineRulesDoc, PutDisciplineRules, DisciplineRulesResponse, CreateSuspension,
  DecideSuspension, Suspension, PutMarkBody, MarkSummary, IncidentKind, ReportIncident, PutReportBody, MatchReport,
  FixtureReport, FixtureSquadMember,
} from "./seeding-discipline.ts";
export {
  PostKind, PostStatus, CreatePost, PatchPost, OrgPost, MergeResult, DuplicateEvidence, DuplicateCandidates, MergeLog,
  CourtHoursRangeS, CourtExceptionS, Court, CourtWithCalendar, Venue, VenueWithCourts, CreateVenue, PatchVenue,
  CreateCourt, PatchCourt, PutCourtCalendar, CourtCalendar,
} from "./org-admin.ts";
export {
  PublicFixtureOutcome, PublicFixtureSummarySchema, PublicFixtureSummary, PublicOrgLive,
} from "./public.ts";
export type {
  PublicOrgLiveT,
} from "./public.ts";
export { CreateQuickMatch } from "./quick-match.ts";
