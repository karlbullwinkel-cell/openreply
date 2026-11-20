# Read-only API and MCP

Workspace owners and admins can create keys at **API & MCP** (`/integrations`).
The UI offers 30, 60 or 90 days (default: 30). The API accepts whole days from
1 to 90. Existing keys are never extended. Copy the token at creation; only its
SHA-256 hash is stored. Revocation takes effect on subsequent authenticated requests.
Use HTTPS and never put a token in a URL, source control, screenshots or prompts.
Keys belong to the workspace, not their creator, and remain valid until expiry,
revocation or workspace deletion. Review keys when team members leave.

Apply migrations and regenerate Prisma before starting the new web version:

```sh
npm run db:migrate
npm run db:generate
```

The additive migration only creates `ServiceKey`; it does not change campaigns,
authentication providers or worker behavior. `REDIS_URL` is required for service
requests. Each key allows 120 requests per fixed 60-second window. Redis failures
reject requests with 503 instead of disabling the limiter.

## MCP clients

Connect to `https://YOUR-DOMAIN/api/mcp` using Streamable HTTP and a custom header:

```text
Authorization: Bearer <service-key>
```

There is no OAuth server, dynamic client registration or token in the URL.
In Claude, use **No authentication** plus this custom request header **only if
your client offers request headers**. Clients requiring OAuth are not supported.
Never switch to public access to work around a client limitation.

Tools (all read-only; scope `campaigns:read`):

- `list_campaigns`: up to 100 compact campaign summaries, newest first.
- `get_campaign` with `{ "id": "..." }`: settings, ordered `trackedLinks`, and
  `trackedDestinationUrl`, `secondaryDestinationUrl`, `secondaryButtonLabel`.
  Missing links are `[]` / `null`. Link order matches the existing DM worker.
- `get_campaign_stats` with `{ "id": "..." }`: aggregate send outcomes and raw
  link requests. These are **not** unique recipients or CRM conversions.

Example safe verification: ask your client to list campaigns, then read one
campaign's destination URLs without changing anything. There are no mutation,
activation, publish, account-token or messaging tools in this contribution.

## REST

Use the same Bearer header:

```text
GET /api/v1/campaigns
GET /api/v1/campaigns?id=<campaign-id>
GET /api/v1/campaigns?id=<campaign-id>&stats=1
```

Responses use `{ "data": ... }`. Lists are capped at 100; pagination is not yet
provided. Detail responses use an explicit safe projection: no provider tokens,
report-share secrets, recipient logs or account relations. A campaign outside
the key's workspace returns 404. Invalid/expired/revoked keys return 401, missing
scope returns 403, rate limits return 429. Results are `Cache-Control: no-store`.

## Instagram insights (`insights:read`)

Create a separate key with **Key access: Instagram insights (read-only)**. A
`campaigns:read` key cannot read insights and an `insights:read` key cannot read
campaigns; both return 403. Insights are REST only; there is no MCP tool.

```text
GET /api/v1/insights
GET /api/v1/insights?since=2026-11-14&until=2026-11-20
GET /api/v1/insights?since=2026-11-14&until=2026-11-20&instagramAccountId=<account-id>
```

- `since` / `until`: inclusive UTC calendar days (`YYYY-MM-DD`). Default: the
  last 30 days ending today. At most 366 days. Unknown parameters return 400.
- The range selects posts by **publish date**. It is not a reporting period for
  the metrics themselves.
- `instagramAccountId`: an OpenReply account ID from the same workspace.
  Omitted, the most recently connected account is used. Foreign IDs return 404.

The response (`{ "data": ... }`) separates two kinds of values:

| Field | Meaning |
| --- | --- |
| `capturedAt` | When the values were read. Use it as the snapshot time. |
| `daily.followers.current` | Follower total right now, or `null` with `status: "unavailable"`. |
| `daily.followerHistory[]` | Stored daily follower snapshots in the range: `date`, `followers`, `delta`. Days without a snapshot are absent; `delta` is `null` when the previous day is missing. |
| `posts.metricType` | Always `lifetime_cumulative`: post metrics are totals since publishing, as of `posts.asOf`. |
| `posts.items[]` | `id`, `publishedAt`, `mediaType`, `productType`, `permalink`, `insightsStatus` and `metrics` (`reach`, `views`, `likes`, `comments`, `saved`, `shares`). |
| `posts.truncated` | `true` when the window may hold more posts than returned. Narrow the range. |

Missing values are `null`, never `0`. Each post lists the reason in `missing`:
`not_requested_for_media_type` (views on photos and albums),
`insights_permission_denied`, `insights_unavailable` or
`not_returned_by_instagram` (for example a hidden like count). `insightsStatus`
is `ok`, `permission_denied` or `unavailable` per post; one failed post never
fails the whole response.

Limits: the newest 200 media items are scanned and at most 100 posts in the
range get insight requests. Each call makes one Instagram request per post, so
call it on a schedule (for example once a week), not in a loop. Errors from
Instagram are returned without Meta's message: 502 for an expired token,
denied access or other failures, 503 for Instagram rate limits.

The endpoint is read-only. It does not write follower snapshots, refresh
tokens, send messages or touch campaigns. Follower history only contains days
that were already snapshotted, by the daily `snapshot-followers` cron or by
opening Overview. Hosts without Vercel crons need their own scheduler for that
cron (see [deploy-dokploy.md](deploy-dokploy.md)) to get one point per day.

### Weekly snapshots

Store each response as-is (or one CSV row per post with `capturedAt`). Weekly
change for a post is the difference between two snapshots of its lifetime
metrics, matched by `id`. Only subtract when both values are numbers; a `null`
on either side means unknown, not zero. Use `daily.followerHistory` for
follower change between two dates instead of subtracting `daily.followers.current`
values taken at different times.

Admin key management uses session authentication at `/api/integrations/keys`:
GET lists metadata (never hashes/tokens), POST creates a key, DELETE with `?id=`
revokes it. A supplied Origin must match `NEXTAUTH_URL` (or the request origin).
JSON request bodies are bounded to 64 KiB including streamed/chunked requests.

## Verification

`npm test` includes mocked authentication/route tests. Set `TEST_DATABASE_URL`
to a disposable local PostgreSQL database to also exercise full migrations,
workspace isolation, deterministic link ordering and fixed key expiration.
The DB suites create and remove their own schemas.

For actual HTTP verification, migrate a **disposable local** database, start
the web app with that `DATABASE_URL`, local `REDIS_URL` and loopback
`NEXTAUTH_URL`, then run:

```sh
TEST_BASE_URL=http://127.0.0.1:3317 \
TEST_DATABASE_URL=postgresql://postgres:local-test@127.0.0.1:54456/postgres \
npx tsx scripts/verify-readonly-integrations.ts
```

The script refuses non-loopback URLs, creates dummy fixtures and keys, and
removes its test user/workspace in `finally`. It must never run against a real
deployment, including one tunneled through localhost. No Meta messages are sent.
