import { authenticateService, requireScope } from "@/lib/integrations/auth";
import { getInsights, parseInsightsQuery } from "@/lib/integrations/insights";
import { apiError, checkOrigin } from "@/lib/integrations/http";

// Paged media plus up to 100 per-post insight requests.
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    // Check the scope before validating input or touching Instagram.
    requireScope(context, "insights:read");
    const query = parseInsightsQuery(new URL(request.url).searchParams);
    const data = await getInsights(context, query);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
