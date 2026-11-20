import {
  getMediaInsights,
  PermissionError,
  type InstagramContext,
  type InstagramMedia,
  type InstagramMediaInsights,
} from "@/lib/instagram/provider";

// How many insight requests to run at once.
export const INSIGHTS_CONCURRENCY = 8;

/** Map over items with a bounded number of in-flight async operations. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

export function isVideoLike(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS" || media.media_type === "VIDEO";
}

/**
 * The insight metrics requested for a post. `views` is only requested for
 * video-like media, so a photo or album never has a views value here.
 */
export function insightMetricsFor(media: InstagramMedia): string[] {
  return isVideoLike(media)
    ? ["views", "reach", "saved", "shares", "total_interactions"]
    : ["reach", "saved", "shares", "total_interactions"];
}

export type PostInsightResult =
  | { status: "ok"; data: InstagramMediaInsights }
  | { status: "permission_denied" | "unavailable"; data: null };

/**
 * Fetch per-post insights with bounded concurrency. A failure on one post never
 * fails the batch: it is reported per post so callers can show the metric as
 * missing instead of inventing a value.
 */
export async function fetchPostInsights(
  context: InstagramContext,
  media: InstagramMedia[]
): Promise<{
  results: PostInsightResult[];
  insightsAvailable: boolean;
  permissionDenied: boolean;
}> {
  let insightsAvailable = false;
  let permissionDenied = false;

  const results = await mapWithConcurrency(
    media,
    INSIGHTS_CONCURRENCY,
    async (m): Promise<PostInsightResult> => {
      try {
        const data = await getMediaInsights({
          context,
          mediaId: m.id,
          metrics: insightMetricsFor(m),
        });
        insightsAvailable = true;
        return { status: "ok", data };
      } catch (err) {
        if (err instanceof PermissionError) {
          permissionDenied = true;
          return { status: "permission_denied", data: null };
        }
        return { status: "unavailable", data: null };
      }
    }
  );

  return { results, insightsAvailable, permissionDenied };
}
