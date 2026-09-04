import { proxyToApi } from '@/lib/server/proxy';

/**
 * `/bff/api/v1/**` — the only path from the browser to the application API.
 * See `src/lib/server/proxy.ts` for why it exists and what it refuses.
 */

// SSE and every authenticated read must be produced per-request, never
// prerendered or cached at the edge.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxyToApi(request, path);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
