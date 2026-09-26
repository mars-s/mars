// Vendor-neutral usage statistics types.
// Everything here is aggregated from local sessions; no remote plan, quota or
// entitlement provider takes part in it.
import { z } from "zod";

export type UsageStatsRange = "all" | "7d" | "30d";

export interface UsageStatsRequest {
  range: UsageStatsRange;
  /** Statistics data source. App Usage always reads local session aggregation. */
  dataSource?: "local" | "monitor";
  /** The settings page can pass the currently selected provider so that when more than one is configured it does not implicitly read the first one. */
  preferredProviderId?: string;
  /** A scenario that names a source must match preferredProviderId; falling back to another provider or to local aggregation is not allowed. */
  requirePreferredProvider?: boolean;
  /** Whether host environment variables may override the provider key. Allowed by default, can be turned off for explicit provider scenarios. */
  allowEnvApiKey?: boolean;
  /**
   * Statistics are bucketed in the caller's time zone.
   * The UI passes the browser's current time zone by default; when absent the host falls back to the system time zone.
   */
  timeZone?: string;
}

export interface UsageStatsSnapshot {
  range: UsageStatsRange;
  generatedAt: number;
  timeZone: string;
  estimatedTokenCharDivisor: number;
  summary: UsageStatsSummary;
  /** Day series zero-filled so blank dates read as 0, ready for the trend chart. */
  daily: UsageStatsDaySummary[];
  heatmap: UsageStatsHeatmap;
  models: UsageStatsModelUsage[];
  /**
   * Data source marker: lets the UI tell a monitor feed apart from local session aggregation.
   * App Usage always reads local session aggregation.
   */
  source?: "monitor" | "local";
  /** Provider that served the remote usage feed, shown as a source label in the UI. */
  sourceProvider?: { id: string; name: string } | null;
  /** Tool call dimension (only a provider tool-usage feed can fill it; local aggregation leaves it empty). */
  tools?: UsageStatsToolUsage[];
}

// ── App Usage (real statistics aggregated from the agent database) ──
export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

export const appUsageFavoriteModelSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  share: z.number(),
});

export const appUsageSummarySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  totalSessions: z.number(),
  totalTurns: z.number(),
  toolCallCount: z.number(),
  toolErrorRate: z.number(),
  modelErrorRate: z.number(),
  avgTimeToFirstTokenMs: z.number().nullable(),
  avgTurnDurationMs: z.number().nullable(),
  activeDays: z.number(),
  currentStreakDays: z.number(),
  longestSessionMs: z.number(),
  longestStreakDays: z.number(),
  peakDayTokens: z.number(),
  favoriteModel: appUsageFavoriteModelSchema.nullable(),
});

export const appUsageHeatmapCellSchema = z.object({
  date: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  totalTokens: z.number(),
  turnCount: z.number(),
  toolCallCount: z.number(),
});

export const appUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(appUsageHeatmapCellSchema.nullable()),
});

export const appUsageHeatmapSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxTokens: z.number(),
  weeks: z.array(appUsageHeatmapWeekSchema),
});

export const appUsageDailyModelItemSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
});

export const appUsageDailyModelUsageSchema = z.object({
  date: z.string(),
  models: z.array(appUsageDailyModelItemSchema),
});

export const appUsageModelUsageSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  requestCount: z.number(),
  share: z.number(),
});

export const appUsageToolUsageSchema = z.object({
  toolName: z.string(),
  callCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  avgDurationMs: z.number().nullable(),
});

export const appUsageSnapshotSchema = z.object({
  range: z.enum(APP_USAGE_RANGES),
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.literal("agent-db"),
  summary: appUsageSummarySchema,
  heatmap: appUsageHeatmapSchema,
  dailyModelUsage: z.array(appUsageDailyModelUsageSchema),
  models: z.array(appUsageModelUsageSchema),
  tools: z.array(appUsageToolUsageSchema),
});

export type AppUsageSummary = z.infer<typeof appUsageSummarySchema>;
export type AppUsageHeatmapCell = z.infer<typeof appUsageHeatmapCellSchema>;
export type AppUsageHeatmapWeek = z.infer<typeof appUsageHeatmapWeekSchema>;
export type AppUsageHeatmap = z.infer<typeof appUsageHeatmapSchema>;
export type AppUsageDailyModelItem = z.infer<typeof appUsageDailyModelItemSchema>;
export type AppUsageDailyModelUsage = z.infer<typeof appUsageDailyModelUsageSchema>;
export type AppUsageModelUsage = z.infer<typeof appUsageModelUsageSchema>;
export type AppUsageToolUsage = z.infer<typeof appUsageToolUsageSchema>;
export type AppUsageFavoriteModel = z.infer<typeof appUsageFavoriteModelSchema>;
export type AppUsageSnapshot = z.infer<typeof appUsageSnapshotSchema>;

export interface AppUsageRequest {
  range: AppUsageRange;
  timeZone?: string;
}

export interface UsageStatsToolUsage {
  /** Internal tool code, e.g. bash / read_file / search. */
  toolCode: string;
  /** Human readable name used for display. */
  displayName: string;
  totalCalls: number;
  /** Per-day call counts with the same length as `daily`, so the trend can be drawn directly. */
  dailyCalls: number[];
}

export interface UsageStatsSummary {
  totalSessions: number;
  totalMessages: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  activeDays: number;
  mostActiveDay: UsageStatsDaySummary | null;
  favoriteModel: UsageStatsFavoriteModel | null;
  longestSessionMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
  peakHour: UsageStatsPeakHour | null;
}

export interface UsageStatsPeakHour {
  hour: number;
  totalEstimatedTokens: number;
  messageCount: number;
}

export interface UsageStatsFavoriteModel {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  share: number;
}

export interface UsageStatsDaySummary {
  date: string;
  label: string;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsHeatmap {
  startDate: string | null;
  endDate: string | null;
  maxActivityScore: number;
  weeks: UsageStatsHeatmapWeek[];
  monthLabels: UsageStatsHeatmapMonthLabel[];
}

export interface UsageStatsHeatmapWeek {
  weekIndex: number;
  days: Array<UsageStatsHeatmapCell | null>;
}

export interface UsageStatsHeatmapMonthLabel {
  weekIndex: number;
  date: string;
}

export interface UsageStatsHeatmapCell {
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsModelUsage {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  inputCharacters: number;
  inputEstimatedTokens: number;
  outputCharacters: number;
  outputEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  share: number;
}
