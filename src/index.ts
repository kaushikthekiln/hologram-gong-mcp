import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import postgres from "postgres";

interface Env {
  DATABASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<any>;
    completeAuthorization(opts: any): Promise<{ redirectTo: string }>;
    lookupClient(id: string): Promise<any>;
  };
}

interface UserProps {
  email: string;
  name: string;
  hd: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ALLOWED_DOMAINS = new Set(["hologram.io", "thekiln.com"]);

// ===== TOOLS =====

const TOOLS = [
  {
    name: "list_calls",
    description:
      "List Hologram Gong calls, newest first, with optional date range, rep filter, direction filter, and pagination. Default limit is 100, max 500. Use offset for paging through larger date ranges. Returns call_id, title, call_date, duration, primary_user_id, direction, and a 300-char transcript snippet for each call. Data covers Feb 2024 through the most recent sync (currently May 2026).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Inclusive lower bound on call_date (ISO 8601)." },
        until: { type: "string", description: "Exclusive upper bound on call_date (ISO 8601)." },
        rep_user_id: { type: "string", description: "Filter by primary_user_id." },
        direction: { type: "string", description: "Filter by direction (Conference / Inbound / Outbound)." },
        limit: { type: "integer", default: 100, minimum: 1, maximum: 500 },
        offset: { type: "integer", default: 0, minimum: 0 },
      },
    },
  },
  {
    name: "search_calls",
    description:
      "Keyword (ILIKE) substring search across Hologram Gong call titles and transcripts. Returns matching calls newest first with a 400-char snippet of where the match was found. Supports the same date range and pagination as list_calls. Default limit 50, max 500. For conceptual or fuzzy questions, consider multiple searches with different terms or query_database for richer SQL.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2 },
        since: { type: "string" },
        until: { type: "string" },
        rep_user_id: { type: "string" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
        offset: { type: "integer", default: 0, minimum: 0 },
      },
    },
  },
  {
    name: "count_calls",
    description:
      "Count Hologram Gong calls matching optional date range, keyword, rep, and direction filters. Use when the user asks 'how many calls...' to get an accurate number cheaply.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        until: { type: "string" },
        query: { type: "string" },
        rep_user_id: { type: "string" },
        direction: { type: "string" },
      },
    },
  },
  {
    name: "list_top_reps",
    description:
      "List the Gong primary_user_ids hosting the most calls, with their call counts and most recent call. Useful for discovering who the heavy reps are. Note: only IDs in the database, names live in Gong itself.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer", default: 25, minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_transcript",
    description:
      "Fetch the full transcript and metadata for ONE Gong call by call_id. Output includes the entire transcript text which can be thousands of words.",
    inputSchema: {
      type: "object",
      required: ["call_id"],
      properties: { call_id: { type: "string" } },
    },
  },
  {
    name: "query_database",
    description:
      "Run a custom read-only SQL query against the Hologram Gong tables. ONLY SELECT and WITH (CTE) statements are allowed. Only the tables `public.gong_calls` (full call data with transcripts) and `public.gong_call_list` (raw call list metadata) are accessible. Hard cap of 500 rows in the result. Statement timeout 30s.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: { sql: { type: "string" } },
    },
  },
  {
    name: "describe_schema",
    description:
      "Return the column definitions for the two Gong tables (public.gong_calls and public.gong_call_list) so you can write accurate query_database queries.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Sql = ReturnType<typeof postgres>;

function parseLimit(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function parseOffset(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
  const cleaned = sql.replace(/--[^\n]*\n?/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (cleaned.length === 0) return { ok: false, reason: "Empty SQL." };
  const lower = cleaned.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) {
    return { ok: false, reason: "Only SELECT or WITH (CTE) queries are allowed." };
  }
  const banned = [
    /\binsert\b/, /\bupdate\b/, /\bdelete\b/, /\bdrop\b/, /\btruncate\b/, /\balter\b/,
    /\bcreate\b/, /\bgrant\b/, /\brevoke\b/, /\breindex\b/, /\bvacuum\b/, /\bcopy\b/,
    /\b(do|call)\s+\$/, /\bset\s+role\b/, /\breset\s+role\b/, /\bsecurity\s+definer\b/,
    /\bpg_sleep\s*\(/,
  ];
  for (const re of banned) if (re.test(lower)) return { ok: false, reason: `Disallowed pattern: ${re}` };
  return { ok: true };
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  sql: Sql
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (name === "list_calls" || name === "list_recent_calls") {
    const limit = parseLimit(args.limit, 100, 500);
    const offset = parseOffset(args.offset);
    const since = args.since ? String(args.since) : null;
    const until = args.until ? String(args.until) : null;
    const repId = args.rep_user_id ? String(args.rep_user_id) : null;
    const direction = args.direction ? String(args.direction) : null;
    const rows = await sql`
      select call_id, title, call_date, duration, primary_user_id, direction,
             substring(transcript, 1, 300) as snippet
      from public.gong_calls
      where (${since}::timestamptz is null or call_date >= ${since}::timestamptz)
        and (${until}::timestamptz is null or call_date < ${until}::timestamptz)
        and (${repId}::text is null or primary_user_id = ${repId})
        and (${direction}::text is null or direction = ${direction})
      order by call_date desc nulls last
      limit ${limit} offset ${offset}
    `;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "search_calls") {
    const query = String(args.query ?? "").trim();
    if (query.length < 2) {
      return { content: [{ type: "text", text: "Query must be at least 2 characters." }], isError: true };
    }
    const limit = parseLimit(args.limit, 50, 500);
    const offset = parseOffset(args.offset);
    const pattern = `%${query}%`;
    const since = args.since ? String(args.since) : null;
    const until = args.until ? String(args.until) : null;
    const repId = args.rep_user_id ? String(args.rep_user_id) : null;
    const rows = await sql`
      select call_id, title, call_date, duration, primary_user_id, direction,
             substring(transcript, 1, 400) as snippet
      from public.gong_calls
      where (transcript ilike ${pattern} or title ilike ${pattern})
        and (${since}::timestamptz is null or call_date >= ${since}::timestamptz)
        and (${until}::timestamptz is null or call_date < ${until}::timestamptz)
        and (${repId}::text is null or primary_user_id = ${repId})
      order by call_date desc nulls last
      limit ${limit} offset ${offset}
    `;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "count_calls") {
    const since = args.since ? String(args.since) : null;
    const until = args.until ? String(args.until) : null;
    const query = args.query ? String(args.query).trim() : null;
    const repId = args.rep_user_id ? String(args.rep_user_id) : null;
    const direction = args.direction ? String(args.direction) : null;
    const pattern = query ? `%${query}%` : null;
    const [row] = await sql`
      select
        (select count(*) from public.gong_calls
          where (${since}::timestamptz is null or call_date >= ${since}::timestamptz)
            and (${until}::timestamptz is null or call_date < ${until}::timestamptz)
            and (${pattern}::text is null or transcript ilike ${pattern} or title ilike ${pattern})
            and (${repId}::text is null or primary_user_id = ${repId})
            and (${direction}::text is null or direction = ${direction})
        ) as total_calls,
        (select count(*) from public.gong_calls) as overall_calls,
        (select min(call_date)::text from public.gong_calls) as data_starts,
        (select max(call_date)::text from public.gong_calls) as data_ends
    `;
    return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
  }

  if (name === "list_top_reps") {
    const limit = parseLimit(args.limit, 25, 100);
    const since = args.since ? String(args.since) : null;
    const until = args.until ? String(args.until) : null;
    const rows = await sql`
      select primary_user_id,
             count(*) as call_count,
             max(call_date)::text as last_call_at,
             min(call_date)::text as first_call_at
      from public.gong_calls
      where primary_user_id is not null
        and (${since}::timestamptz is null or call_date >= ${since}::timestamptz)
        and (${until}::timestamptz is null or call_date < ${until}::timestamptz)
      group by primary_user_id
      order by call_count desc
      limit ${limit}
    `;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (name === "get_transcript") {
    const call_id = String(args.call_id ?? "").trim();
    if (!call_id) return { content: [{ type: "text", text: "call_id is required." }], isError: true };
    const rows = await sql`
      select call_id, title, call_date, duration, direction, primary_user_id, workspace_id,
             url, meeting_url, scheduled, transcript
      from public.gong_calls
      where call_id = ${call_id}
      limit 1
    `;
    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No call found with call_id=${call_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] };
  }

  if (name === "query_database") {
    const userSql = String(args.sql ?? "").trim();
    if (!userSql) return { content: [{ type: "text", text: "sql is required." }], isError: true };
    const guard = isReadOnlySql(userSql);
    if (!guard.ok) return { content: [{ type: "text", text: `Rejected: ${guard.reason}` }], isError: true };
    try {
      const rows = await sql.unsafe(userSql);
      const arr = Array.isArray(rows) ? rows : [];
      const truncated = arr.length > 500;
      const out = arr.slice(0, 500);
      return { content: [{ type: "text", text: JSON.stringify({ row_count: out.length, truncated, rows: out }, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `SQL error: ${message}` }], isError: true };
    }
  }

  if (name === "describe_schema") {
    const rows = await sql`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name in ('gong_calls', 'gong_call_list')
      order by table_name, ordinal_position
    `;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

async function handleRpc(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const { method, params } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hologram-gong-mcp", version: "0.3.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  if (method === "tools/call") {
    const sql = postgres(env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
    try {
      await sql`set local statement_timeout = '30s'`;
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing 'name'" } };
      const result = await handleToolCall(p.name, p.arguments ?? {}, sql);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: "2.0", id, error: { code: -32603, message: `Tool execution failed: ${message}` } };
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, mcp-session-id",
  "Access-Control-Expose-Headers": "MCP-Session-Id, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

// ===== MCP API HANDLER (called by OAuthProvider after token validation) =====

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const user = (ctx as any).props as UserProps | undefined;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (user) {
      console.log(`[mcp] ${user.email} -> ${request.method} ${url.pathname}`);
    }

    if (request.method !== "POST") {
      return new Response("POST only.", { status: 405, headers: CORS_HEADERS });
    }

    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
        { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } }
      );
    }

    const sessionId = request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const headers = { "content-type": "application/json", "mcp-session-id": sessionId, ...CORS_HEADERS };

    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((m) => handleRpc(m, env)));
      const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
      if (filtered.length === 0) return new Response(null, { status: 202, headers });
      return new Response(JSON.stringify(filtered), { headers });
    }

    const response = await handleRpc(body, env);
    if (response === null) return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify(response), { headers });
  },
};

// ===== DEFAULT HANDLER (OAuth flows + health check) =====

function jwtDecodePayload(jwt: string): Record<string, any> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  // base64url -> base64
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "hologram-gong-mcp",
          version: "0.3.0",
          auth: "google-oauth",
          allowed_domains: Array.from(ALLOWED_DOMAINS),
          mcp_endpoint: `${url.origin}/sse`,
          tools: TOOLS.map((t) => t.name),
        }),
        { headers: { "content-type": "application/json", ...CORS_HEADERS } }
      );
    }

    // OAuth: Claude.ai sends user here to start the flow
    if (url.pathname === "/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      // Encode the parsed authRequest in `state` so we can resume after Google bounces back
      const state = btoa(JSON.stringify(oauthReqInfo));
      const googleAuth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      googleAuth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      googleAuth.searchParams.set("redirect_uri", `${url.origin}/oauth/callback`);
      googleAuth.searchParams.set("response_type", "code");
      googleAuth.searchParams.set("scope", "openid email profile");
      googleAuth.searchParams.set("state", state);
      googleAuth.searchParams.set("prompt", "select_account");
      googleAuth.searchParams.set("access_type", "online");
      return Response.redirect(googleAuth.toString(), 302);
    }

    // OAuth: Google sends user back here after sign-in
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        return new Response(`Google OAuth error: ${errorParam}`, { status: 400 });
      }
      if (!code || !state) {
        return new Response("Missing code or state.", { status: 400 });
      }

      let oauthReqInfo: any;
      try {
        oauthReqInfo = JSON.parse(atob(state));
      } catch {
        return new Response("Invalid state.", { status: 400 });
      }

      // Exchange the code for tokens
      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/oauth/callback`,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        return new Response(`Google token exchange failed: ${text}`, { status: 500 });
      }
      const tokens = (await tokenResp.json()) as { id_token?: string };
      if (!tokens.id_token) {
        return new Response("Google did not return an id_token.", { status: 500 });
      }

      let payload: Record<string, any>;
      try {
        payload = jwtDecodePayload(tokens.id_token);
      } catch (err) {
        return new Response(`Could not decode Google id_token: ${err}`, { status: 500 });
      }
      const userEmail = String(payload.email ?? "");
      const userName = String(payload.name ?? userEmail);
      const userHd = String(payload.hd ?? "");

      if (!ALLOWED_DOMAINS.has(userHd)) {
        const allowedList = Array.from(ALLOWED_DOMAINS).map((d) => "@" + d).join(" or ");
        return new Response(
          `Access denied.\n\nThis MCP is restricted to ${allowedList} Google Workspace accounts.\n\nYou signed in as: ${userEmail}\nDomain claim: ${userHd || "(personal Gmail / no workspace domain)"}\n\nIf you're at Hologram or Kiln, sign in again with your work Google account.`,
          { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      const props: UserProps = { email: userEmail, name: userName, hd: userHd };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: userEmail,
        metadata: { email: userEmail, name: userName, hd: userHd },
        scope: oauthReqInfo.scope ?? ["mcp:read"],
        props,
      });
      return Response.redirect(redirectTo, 302);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

// ===== EXPORT =====

export default new OAuthProvider({
  apiRoute: ["/sse", "/mcp"],
  apiHandler: mcpHandler,
  defaultHandler: defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:read"],
  accessTokenTTL: 3600,
});
