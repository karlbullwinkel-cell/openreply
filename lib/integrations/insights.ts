import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  createInstagramContext,
  getAllUserMedia,
  getUserInfo,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
  type InstagramMedia,
} from "@/lib/instagram/provider";
import { getFollowerHistory } from "@/lib/reports/follower-history";
import {
  fetchPostInsights,
  isVideoLike,
  type PostInsightResult,
} from "@/lib/reports/post-insights";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";

/**
 * Read-only Instagram insights for the integrations API.
 *
 * Nothing here writes to the database or returns credentials: follower
 * history is read from existing snapshots (no backfill), and the response is an
 * explicit projection of media fields and metric values.
 */

export const INSIGHTS_SCHEMA_VERSION = 1;
/** Default window when no dates are given: the last 30 UTC days. */
export const DEFAULT_RANGE_DAYS = 30;
/** Widest accepted window, inclusive of both ends. */
export const MAX_RANGE_DAYS = 366;
/** Media items paged from Instagram, newest first, before date filtering. */
export const MAX_MEDIA_SCANNED = 200;
/** Posts in the window that get per-post insight requests. */
export const MAX_POSTS_WITH_INSIGHTS = 100;

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type InsightsQuery = {
  since: string;
  until: string;
  instagramAccountId: string | null;
};

export type MetricName = "reach" | "views" | "likes" | "comments" | "saved" | "shares";
export type MissingReason =
  | "not_requested_for_media_type"
  | "insights_permission_denied"
  | "insights_unavailable"
  | "not_returned_by_instagram";

export interface InsightsPost {
  id: string;
  publishedAt: string;
  mediaType: string;
  productType: string | null;
  permalink: string | null;
  insightsStatus: PostInsightResult["status"];
  /** Lifetime totals as of `capturedAt`. Never 0 for missing data: null. */
  metrics: Record<MetricName, number | null>;
  /** Why each null metric is null. Absent when every metric has a value. */
  missing?: Partial<Record<MetricName, MissingReason>>;
}

export interface InsightsResponse {
  schemaVersion: typeof INSIGHTS_SCHEMA_VERSION;
  /** When the values were read. Use it as the snapshot timestamp. */
  capturedAt: string;
  account: { id: string; username: string; provider: "META" | "ZERNIO" };
  range: { since: string; until: string; timezone: "UTC"; appliesTo: "post_published_at" };
  /** Account-level values per day. Not comparable to the lifetime post totals. */
  daily: {
    followers: {
      current: number | null;
      status: "ok" | "unavailable";
    };
    /**
     * Stored daily follower snapshots inside the range, ascending. Days without
     * a snapshot are absent, not zero. `delta` is null for the first day and
     * for days whose previous day is missing.
     */
    followerHistory: Array<{ date: string; followers: number; delta: number | null }>;
  };
  posts: {
    metricType: "lifetime_cumulative";
    asOf: string;
    count: number;
    /** True when the window may contain more posts than were returned. */
    truncated: boolean;
    insightsAvailable: boolean;
    items: InsightsPost[];
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string, name: string): Date {
  if (!ISO_DAY.test(value)) throw new ApiError(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  // Reject impossible dates such as 2026-02-30, which Date silently rolls over.
  if (Number.isNaN(date.getTime()) || isoDay(date) !== value) {
    throw new ApiError(`${name} is not a valid date`);
  }
  return date;
}

/** Validate query parameters. Dates are inclusive UTC calendar days. */
export function parseInsightsQuery(params: URLSearchParams, now = new Date()): InsightsQuery {
  for (const key of params.keys()) {
    if (!["since", "until", "instagramAccountId"].includes(key)) {
      throw new ApiError(`Unknown parameter: ${key}`);
    }
  }
  const untilRaw = params.get("until");
  const sinceRaw = params.get("since");
  const until = untilRaw === null ? parseDay(isoDay(now), "until") : parseDay(untilRaw, "until");
  const since =
    sinceRaw === null
      ? new Date(until.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      : parseDay(sinceRaw, "since");
  if (since > until) throw new ApiError("since must not be after until");
  if ((until.getTime() - since.getTime()) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ApiError(`Range must not exceed ${MAX_RANGE_DAYS} days`);
  }
  const instagramAccountId = params.get("instagramAccountId");
  if (instagramAccountId !== null && !ACCOUNT_ID.test(instagramAccountId)) {
    throw new ApiError("Invalid instagramAccountId");
  }
  return { since: isoDay(since), until: isoDay(until), instagramAccountId };
}

function metricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPost(media: InstagramMedia, insight: PostInsightResult): InsightsPost {
  const ins = insight.data;
  const metrics: Record<MetricName, number | null> = {
    reach: metricValue(ins?.reach),
    views: metricValue(ins?.views),
    // Likes and comments come with the media fields, not from insights. A
    // hidden like count arrives as an absent field, which stays null.
    likes: metricValue(media.like_count),
    comments: metricValue(media.comments_count),
    saved: metricValue(ins?.saved),
    shares: metricValue(ins?.shares),
  };

  const missing: Partial<Record<MetricName, MissingReason>> = {};
  for (const name of Object.keys(metrics) as MetricName[]) {
    if (metrics[name] !== null) continue;
    if (name === "views" && !isVideoLike(media)) missing[name] = "not_requested_for_media_type";
    else if (name === "likes" || name === "comments") missing[name] = "not_returned_by_instagram";
    else if (insight.status === "permission_denied") missing[name] = "insights_permission_denied";
    else if (insight.status === "unavailable") missing[name] = "insights_unavailable";
    else missing[name] = "not_returned_by_instagram";
  }

  return {
    id: media.id,
    publishedAt: media.timestamp,
    mediaType: media.media_type,
    productType: media.media_product_type ?? null,
    permalink: media.permalink ?? null,
    insightsStatus: insight.status,
    metrics,
    ...(Object.keys(missing).length ? { missing } : {}),
  };
}

function instagramFailure(err: unknown): ApiError {
  // Never forward Meta's message: it can name internal paths and IDs.
  if (err instanceof TokenExpiredError) {
    return new ApiError("Instagram token expired or was revoked; reconnect the account", 502);
  }
  if (err instanceof RateLimitError) return new ApiError("Instagram rate limit reached; try again later", 503);
  if (err instanceof PermissionError) return new ApiError("Instagram denied access to this account's media", 502);
  return new ApiError("Instagram data unavailable", 502);
}

export async function getInsights(
  context: ServiceContext,
  query: InsightsQuery,
  now = new Date()
): Promise<InsightsResponse> {
  requireScope(context, "insights:read");

  const account = await getWorkspaceInstagramAccount(context.workspaceId, query.instagramAccountId);
  if (!account) throw new ApiError("Instagram account not found", 404);

  const instagram = await createInstagramContext(account);
  const capturedAt = now.toISOString();
  const sinceMs = Date.parse(`${query.since}T00:00:00.000Z`);
  const untilEndMs = Date.parse(`${query.until}T00:00:00.000Z`) + DAY_MS;

  let media: InstagramMedia[];
  try {
    media = await getAllUserMedia({ context: instagram, max: MAX_MEDIA_SCANNED });
  } catch (err) {
    throw instagramFailure(err);
  }

  const inRange = media.filter((m) => {
    const published = Date.parse(m.timestamp);
    return Number.isFinite(published) && published >= sinceMs && published < untilEndMs;
  });
  // Instagram pages newest first. If the scan hit its cap while the oldest
  // scanned post is still inside or after the window, older posts may be missing.
  const oldestScanned = media.length ? Date.parse(media[media.length - 1].timestamp) : NaN;
  const scanCapped = media.length >= MAX_MEDIA_SCANNED && !(oldestScanned < sinceMs);
  const selected = inRange.slice(0, MAX_POSTS_WITH_INSIGHTS);
  const truncated = scanCapped || inRange.length > selected.length;

  const { results, insightsAvailable, permissionDenied } = await fetchPostInsights(instagram, selected);
  const items = selected.map((m, i) => toPost(m, results[i]));

  let current: number | null = null;
  try {
    current = metricValue((await getUserInfo({ context: instagram })).followers_count);
  } catch {
    current = null;
  }

  const historyDays = Math.ceil((now.getTime() - sinceMs) / DAY_MS) + 1;
  const history = await getFollowerHistory(account.id, Math.max(historyDays, 1));
  const followerHistory = history
    .filter((point) => point.date >= query.since && point.date <= query.until)
    .map((point, i, rows) => {
      // A delta is only meaningful against the immediately preceding day.
      const previous = rows[i - 1];
      const consecutive =
        previous && Date.parse(`${point.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`) === DAY_MS;
      return { date: point.date, followers: point.followers, delta: consecutive ? point.followers - previous.followers : null };
    });

  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    capturedAt,
    account: { id: account.id, username: account.username, provider: account.provider },
    range: { since: query.since, until: query.until, timezone: "UTC", appliesTo: "post_published_at" },
    daily: {
      followers: { current, status: current === null ? "unavailable" : "ok" },
      followerHistory,
    },
    posts: {
      metricType: "lifetime_cumulative",
      asOf: capturedAt,
      count: items.length,
      truncated,
      insightsAvailable: insightsAvailable && !permissionDenied,
      items,
    },
  };
}
