import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: { findUnique: vi.fn(), update: vi.fn() },
  accounts: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  snapshots: { findMany: vi.fn(), upsert: vi.fn() },
  transaction: vi.fn(),
  eval: vi.fn(),
  media: vi.fn(),
  insights: vi.fn(),
  userInfo: vi.fn(),
  context: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    serviceKey: state.keys,
    instagramAccount: state.accounts,
    followerSnapshot: state.snapshots,
    $transaction: state.transaction,
  },
}));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));
vi.mock("@/lib/instagram/provider", async () => {
  const errors = await vi.importActual<typeof import("../lib/meta/client")>("../lib/meta/client");
  return {
    MetaApiError: errors.MetaApiError,
    PermissionError: errors.PermissionError,
    RateLimitError: errors.RateLimitError,
    TokenExpiredError: errors.TokenExpiredError,
    createInstagramContext: state.context,
    getAllUserMedia: state.media,
    getMediaInsights: state.insights,
    getUserInfo: state.userInfo,
    getFollowerCountSeries: vi.fn(),
    getZernioFollowerSnapshots: vi.fn(),
  };
});

import { PermissionError, RateLimitError, TokenExpiredError } from "../lib/meta/client";
import { getInsights, parseInsightsQuery, MAX_MEDIA_SCANNED } from "../lib/integrations/insights";
import { GET as insightsRoute } from "../app/api/v1/insights/route";
import { GET as campaignsRoute } from "../app/api/v1/campaigns/route";

const token = `orp_${"b".repeat(43)}`;
const SECRET_TOKEN = "IGAA-secret-access-token";
const key = { id: "key", workspaceId: "workspace", scopes: ["insights:read"], expiresAt: new Date("2099-01-01"), revokedAt: null };
const context = { workspaceId: "workspace", keyId: "key", scopes: ["insights:read"] };
const account = {
  id: "acct", workspaceId: "workspace", username: "creator", provider: "META", metaLogin: "UNIFIED",
  instagramId: "1784", zernioAccountId: null, accessToken: "encrypted-token-value",
};
const NOW = new Date("2026-11-20T12:00:00.000Z");

const reel = { id: "m1", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-11-18T09:00:00+0000", permalink: "https://instagram.test/p/m1", like_count: 40, comments_count: 3 };
const photo = { id: "m2", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-11-14T00:00:00+0000", permalink: "https://instagram.test/p/m2", comments_count: 0 };
const old = { id: "m3", media_type: "IMAGE", timestamp: "2026-11-01T10:00:00+0000", like_count: 9, comments_count: 1 };

const call = (query = "", headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
  insightsRoute(new Request(`https://example.test/api/v1/insights${query}`, { headers }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  state.keys.findUnique.mockResolvedValue(key);
  state.keys.update.mockResolvedValue(key);
  state.eval.mockReset().mockResolvedValue(1);
  state.accounts.findFirst.mockResolvedValue(account);
  state.context.mockResolvedValue({ provider: "META", accessToken: SECRET_TOKEN, instagramId: "1784", unifiedLogin: true });
  state.media.mockResolvedValue([reel, photo, old]);
  state.insights.mockImplementation(async ({ mediaId }: { mediaId: string }) =>
    mediaId === "m1" ? { views: 1200, reach: 800, saved: 12, shares: 5, total_interactions: 60 } : { reach: 150, saved: 0, shares: 1 });
  state.userInfo.mockResolvedValue({ id: "1784", username: "creator", followers_count: 512 });
  state.snapshots.findMany.mockResolvedValue([
    { date: new Date("2026-11-13T00:00:00Z"), followersCount: 490 },
    { date: new Date("2026-11-15T00:00:00Z"), followersCount: 500 },
    { date: new Date("2026-11-16T00:00:00Z"), followersCount: 505 },
  ]);
});

describe("authorization", () => {
  it("requires a Bearer service key", async () => {
    const response = await call("", {});
    expect(response.status).toBe(401);
    expect(state.media).not.toHaveBeenCalled();
  });

  it("rejects revoked or expired keys", async () => {
    state.keys.findUnique.mockResolvedValue({ ...key, revokedAt: new Date() });
    expect((await call()).status).toBe(401);
    state.keys.findUnique.mockResolvedValue({ ...key, expiresAt: new Date(0) });
    expect((await call()).status).toBe(401);
    expect(state.media).not.toHaveBeenCalled();
  });

  it("refuses a campaigns-only key before reading anything", async () => {
    state.keys.findUnique.mockResolvedValue({ ...key, scopes: ["campaigns:read"] });
    const response = await call();
    expect(response.status).toBe(403);
    expect(state.accounts.findFirst).not.toHaveBeenCalled();
    expect(state.media).not.toHaveBeenCalled();
  });

  it("does not let an insights key read campaigns", async () => {
    const response = await campaignsRoute(new Request("https://example.test/api/v1/campaigns", { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(403);
  });

  it("rejects foreign browser origins", async () => {
    expect((await call("", { authorization: `Bearer ${token}`, origin: "https://evil.test" })).status).toBe(403);
  });

  it("scopes the account lookup to the key's workspace", async () => {
    state.accounts.findFirst.mockResolvedValue(null);
    const response = await call("?instagramAccountId=foreign");
    expect(response.status).toBe(404);
    expect(state.accounts.findFirst.mock.calls[0][0].where).toEqual({ id: "foreign", workspaceId: "workspace" });
  });
});

describe("date filtering", () => {
  it("defaults to the last 30 UTC days ending today", () => {
    expect(parseInsightsQuery(new URLSearchParams(), NOW)).toEqual({ since: "2026-10-22", until: "2026-11-20", instagramAccountId: null });
  });

  it.each([
    ["since=2026-11-31", "since is not a valid date"],
    ["since=20261101", "since must be YYYY-MM-DD"],
    ["until=2026-13-01", "until is not a valid date"],
    ["since=2026-11-10&until=2026-11-01", "since must not be after until"],
    ["since=2024-01-01&until=2026-11-01", "Range must not exceed 366 days"],
    ["limit=5", "Unknown parameter: limit"],
    ["instagramAccountId=a%20b", "Invalid instagramAccountId"],
  ])("rejects %s", async (query, message) => {
    const response = await call(`?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(message);
    expect(state.media).not.toHaveBeenCalled();
  });

  it("includes both boundary days and excludes posts outside the window", async () => {
    const data = await getInsights(context, { since: "2026-11-14", until: "2026-11-18", instagramAccountId: null }, NOW);
    expect(data.posts.items.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(data.range).toEqual({ since: "2026-11-14", until: "2026-11-18", timezone: "UTC", appliesTo: "post_published_at" });
    // Insights are requested only for posts inside the window.
    expect(state.insights.mock.calls.map(([arg]) => arg.mediaId).sort()).toEqual(["m1", "m2"]);
  });

  it("keeps follower history inside the range and nulls non-consecutive deltas", async () => {
    const data = await getInsights(context, { since: "2026-11-14", until: "2026-11-18", instagramAccountId: null }, NOW);
    expect(data.daily.followerHistory).toEqual([
      { date: "2026-11-15", followers: 500, delta: null },
      { date: "2026-11-16", followers: 505, delta: 5 },
    ]);
  });

  it("flags truncation when the scan cap is reached inside the window", async () => {
    const many = Array.from({ length: MAX_MEDIA_SCANNED }, (_, i) => ({ ...photo, id: `p${i}`, timestamp: "2026-11-15T00:00:00+0000" }));
    state.media.mockResolvedValue(many);
    state.insights.mockResolvedValue({ reach: 1, saved: 0, shares: 0 });
    const data = await getInsights(context, { since: "2026-11-01", until: "2026-11-20", instagramAccountId: null }, NOW);
    expect(data.posts.truncated).toBe(true);
    expect(data.posts.count).toBe(100);
  });
});

describe("data accuracy", () => {
  it("returns the requested fields with lifetime metrics separated from daily values", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const response = await call("?since=2026-11-14&until=2026-11-18");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await response.json();
    expect(data.schemaVersion).toBe(1);
    expect(data.capturedAt).toBe(NOW.toISOString());
    expect(data.posts.metricType).toBe("lifetime_cumulative");
    expect(data.posts.asOf).toBe(data.capturedAt);
    expect(data.daily.followers).toEqual({ current: 512, status: "ok" });
    expect(data.posts.items[0]).toEqual({
      id: "m1", publishedAt: "2026-11-18T09:00:00+0000", mediaType: "VIDEO", productType: "REELS",
      permalink: "https://instagram.test/p/m1", insightsStatus: "ok",
      metrics: { reach: 800, views: 1200, likes: 40, comments: 3, saved: 12, shares: 5 },
    });
  });

  it("keeps missing values null with a reason and keeps real zeros", async () => {
    const data = await getInsights(context, { since: "2026-11-14", until: "2026-11-18", instagramAccountId: null }, NOW);
    const p = data.posts.items.find((item) => item.id === "m2")!;
    expect(p.metrics).toEqual({ reach: 150, views: null, likes: null, comments: 0, saved: 0, shares: 1 });
    expect(p.missing).toEqual({ views: "not_requested_for_media_type", likes: "not_returned_by_instagram" });
  });

  it("reports per-post insight failures without failing the batch", async () => {
    state.insights.mockImplementation(async ({ mediaId }: { mediaId: string }) => {
      if (mediaId === "m1") throw new PermissionError("denied");
      throw new Error("network");
    });
    const data = await getInsights(context, { since: "2026-11-14", until: "2026-11-18", instagramAccountId: null }, NOW);
    const [a, b] = data.posts.items;
    expect(a.insightsStatus).toBe("permission_denied");
    expect(a.metrics).toMatchObject({ reach: null, views: null, saved: null, shares: null, likes: 40 });
    expect(a.missing).toMatchObject({ reach: "insights_permission_denied", views: "insights_permission_denied" });
    expect(b.insightsStatus).toBe("unavailable");
    expect(b.missing).toMatchObject({ reach: "insights_unavailable" });
    expect(data.posts.insightsAvailable).toBe(false);
  });

  it("reports an unknown follower count as unavailable, not zero", async () => {
    state.userInfo.mockRejectedValue(new Error("boom"));
    const data = await getInsights(context, { since: "2026-11-14", until: "2026-11-18", instagramAccountId: null }, NOW);
    expect(data.daily.followers).toEqual({ current: null, status: "unavailable" });
  });

  it("never returns credentials and never writes to the database", async () => {
    const response = await call("?since=2026-11-14&until=2026-11-18");
    const text = await response.text();
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain("encrypted-token-value");
    expect(text).not.toContain("accessToken");
    expect(state.snapshots.upsert).not.toHaveBeenCalled();
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.accounts.update).not.toHaveBeenCalled();
    expect(state.accounts.updateMany).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  it.each([
    [new TokenExpiredError("Error validating access token IGAA-secret"), 502, "Instagram token expired or was revoked; reconnect the account"],
    [new RateLimitError("too many calls"), 503, "Instagram rate limit reached; try again later"],
    [new PermissionError("(#10) internal path /1784/media"), 502, "Instagram denied access to this account's media"],
    [new Error("socket hang up"), 502, "Instagram data unavailable"],
  ])("maps media failures to safe messages", async (error, status, message) => {
    state.media.mockRejectedValue(error);
    const response = await call();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toBe(message);
    expect(JSON.stringify(body)).not.toContain("IGAA");
    expect(JSON.stringify(body)).not.toContain("1784");
  });

  it("returns a generic 500 when the stored credential cannot be used", async () => {
    state.context.mockRejectedValue(new Error(`decrypt failed for ${SECRET_TOKEN}`));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal error" });
  });

  it("fails closed when the rate limiter is unavailable", async () => {
    state.eval.mockRejectedValueOnce(new Error("redis down"));
    expect((await call()).status).toBe(503);
    expect(state.media).not.toHaveBeenCalled();
  });
});
