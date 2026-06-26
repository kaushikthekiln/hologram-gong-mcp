# Cloudflare Workers + Remote MCP Server — Handover Brief

Use this when you want to build another Claude.ai-compatible MCP server (i.e. a custom connector that any user can paste a URL into) backed by Cloudflare Workers. This is the playbook from a real working build (Hologram-Gong: ~8,000 sales call transcripts in Supabase, exposed as a 7-tool MCP at `https://hologramgong.mathias-powell.workers.dev/sse`).

---

## TL;DR (what was built and why this pattern works)

- **What:** A remote MCP server hosted on Cloudflare Workers. Anyone at the client (Hologram) pastes one URL into Claude.ai → Settings → Connectors and they can chat with all 8K calls in their database in natural language.
- **Replaces:** A Mac-only Claude Desktop install (the old stdio MCP via `@supabase/mcp-server-supabase`). That required `install.sh`, Homebrew, Node, hardcoded tokens on every employee's laptop.
- **Why Cloudflare Workers:** native MCP-friendly serverless platform, ~10ms cold starts, free tier covers ~100K requests/day, deploy in one command, OAuth library available, talks to Postgres via `nodejs_compat`. Other options (Render, Fly, Vercel, AWS Lambda) all work but are heavier.
- **Why remote MCP at all:** Claude.ai (web/mobile) cannot launch a local subprocess on a user's machine. Stdio MCPs are inherently desktop-only. Streamable HTTP MCPs (the new transport spec, March 2025) are what claude.ai's "Custom Connectors" feature consumes. So a public HTTPS URL = the only way to reach claude.ai.

---

## The architecture pattern (works for any data source, not just Postgres)

```
Claude.ai (web/mobile/desktop)
   │  HTTPS + JSON-RPC 2.0 (MCP Streamable HTTP transport)
   ▼
Cloudflare Worker  <name>.<subdomain>.workers.dev/sse
   │  Reads secrets via env.SECRETNAME (encrypted at rest on Cloudflare)
   ▼
Your data layer
   │  Postgres pooler / external REST API / S3 / KV / Durable Objects / D1 / R2
   │  Whatever your data lives in
   ▼
Returns rows, JSON, blobs back up the chain
```

Key insight: the Worker is **stateless plumbing**. It owns no data, has no AI, exposes a fixed set of "tools" that the LLM (Claude.ai) chooses which to call. You design the tools; the LLM does the thinking.

---

## Account + token setup (one time, ~10 minutes)

### Cloudflare account

1. Use a dedicated Cloudflare account (don't mix personal with client work). The account name will be the email of whoever created it (e.g. "Tech@thekiln.com's Account"), but anyone added as a member can administer.
2. Note the **Account ID** from any dashboard URL (the 32-char hex after `dash.cloudflare.com/`).

### Create an API token (account-scoped, NOT user-scoped)

1. Cloudflare dashboard → Manage Account → Account API tokens → Create Token
2. Use the preset **"Edit Cloudflare Workers"** rather than Custom. It auto-grants:
   - `Account.Workers Scripts: Edit`
   - `Account.Workers Tail: Read`
   - `Account.Account Settings: Read`
   - `Zone.Workers Routes: Edit`
   - `User.User Details: Read`
   - `User.Memberships: Read`
3. Optionally set IP filter and 90-day expiration.
4. Copy the token (starts with `cfat_*` for new account-owned tokens). You see it once.

The new `cfat_*` tokens will FAIL `/user/tokens/verify` because that's a legacy endpoint for the old user-scoped tokens. Test them via account endpoints instead:

```bash
curl -H "Authorization: Bearer cfat_..." \
  https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>
# Should return success: true
```

### One-time subdomain provision

API tokens cannot create the `*.workers.dev` subdomain prefix. You must visit the dashboard once:

1. Open `https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages`
2. Cloudflare auto-assigns a random subdomain like `soft-mountain-985d.workers.dev`
3. (Optional) Click the pencil icon next to it to rename to something cleaner
4. From here on, every Worker deployed on this account lives at `<workername>.<subdomain>.workers.dev`

---

## Project structure (paste this layout)

```
your-mcp/
├── src/
│   └── index.ts          # The Worker (single fetch handler, ~300 lines for a real MCP)
├── wrangler.toml         # Cloudflare deploy config
├── package.json          # deps + wrangler scripts
├── tsconfig.json
├── .gitignore            # IMPORTANT: must exclude .env, .dev.vars, .wrangler/, node_modules/
├── .env                  # CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, your secrets (gitignored)
└── .dev.vars             # secrets for `wrangler dev` (local), gitignored
```

### `package.json`

```json
{
  "name": "your-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  },
  "dependencies": {
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241112.0",
    "typescript": "^5.6.3",
    "wrangler": "^3.86.0"
  }
}
```

Notes:
- `wrangler` v4 requires Node 20+. If you're on Node 18, stick with v3 (still maintained).
- `postgres` (porsager/postgres) is the lightweight Postgres client that works in Workers via `nodejs_compat`. The heavier `pg` (node-postgres) does NOT work in Workers reliably.
- Add `zod` if you want runtime validation of tool inputs (optional; JSON Schema in tool definitions is enough for claude.ai).

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*"]
}
```

### `wrangler.toml`

```toml
name = "your-worker-name"      # becomes <name>.<subdomain>.workers.dev
main = "src/index.ts"
compatibility_date = "2024-11-12"
compatibility_flags = ["nodejs_compat"]   # CRITICAL: needed for Postgres / TCP / Buffer

[observability]
enabled = true                  # exposes logs in Cloudflare dashboard
```

### `.gitignore`

```
node_modules/
.env
.dev.vars
.wrangler/
dist/
*.log
.DS_Store
```

### `.env` (gitignored, used by Wrangler CLI for deploys)

```
CLOUDFLARE_API_TOKEN=cfat_...
CLOUDFLARE_ACCOUNT_ID=...

# Whatever your Worker needs. Examples:
DATABASE_URL=postgres://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/db
```

### `.dev.vars` (gitignored, used by `wrangler dev` for local secrets)

```
DATABASE_URL="postgres://user:pass@..."
OTHER_SECRET="..."
```

Wrangler reads `.dev.vars` automatically when you run `wrangler dev` and injects them as `env.DATABASE_URL` etc., the same way production secrets work.

---

## The Worker code (paste-ready skeleton)

This is a complete, deployable MCP server. Add tools by appending to the `TOOLS` array and the `handleToolCall` function.

```typescript
// src/index.ts

interface Env {
  DATABASE_URL: string;
  // Add other secrets here
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

// ----- TOOLS -----
// Each tool: name, description (this is your prompt engineering surface), inputSchema (JSON Schema).
// Tool descriptions are how the LLM picks which to call. Be specific about WHEN to use each one.

const TOOLS = [
  {
    name: "example_tool",
    description: "Describe in detail what this does, when to use it, and the shape of what comes back. The LLM picks tools based on this text. Mention any data freshness limitations explicitly.",
    inputSchema: {
      type: "object",
      required: ["input_field"],
      properties: {
        input_field: { type: "string", description: "What this is" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 100 },
      },
    },
  },
];

// ----- TOOL HANDLER -----

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  env: Env
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (name === "example_tool") {
    // Do work. For Postgres:
    //   const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
    //   const rows = await sql`select * from foo where bar = ${args.input_field}`;
    //   await sql.end();
    const result = { /* whatever */ };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

// ----- JSON-RPC DISPATCHER -----

async function handleRpc(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const { method, params } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "your-mcp", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  if (method === "tools/call") {
    try {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing 'name'" } };
      }
      const result = await handleToolCall(p.name, p.arguments ?? {}, env);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: "2.0", id, error: { code: -32603, message } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ----- CORS (REQUIRED for claude.ai web) -----

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, mcp-session-id",
  "Access-Control-Expose-Headers": "MCP-Session-Id, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

// ----- FETCH HANDLER (the entry point) -----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "your-mcp",
          mcp_endpoint: `${url.origin}/sse`,
          tools: TOOLS.map((t) => t.name),
        }),
        { headers: { "content-type": "application/json", ...CORS_HEADERS } }
      );
    }

    // MCP endpoint (Streamable HTTP)
    if (url.pathname === "/sse" || url.pathname === "/mcp") {
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

      // Batch support
      if (Array.isArray(body)) {
        const responses = await Promise.all(body.map((m) => handleRpc(m, env)));
        const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
        if (filtered.length === 0) return new Response(null, { status: 202, headers });
        return new Response(JSON.stringify(filtered), { headers });
      }

      const response = await handleRpc(body, env);
      if (response === null) return new Response(null, { status: 202, headers });
      return new Response(JSON.stringify(response), { headers });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};
```

That's a complete working MCP. Add your tools, deploy, paste URL into claude.ai, done.

---

## Why hand-roll JSON-RPC instead of using `@modelcontextprotocol/sdk`

I tried both. The SDK has subtle compatibility issues with the Workers V8 runtime (some Node primitives the SDK assumes aren't present, even with `nodejs_compat`). The MCP protocol itself is just JSON-RPC 2.0 with 4 methods (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`). Implementing it directly is ~50 lines and removes the SDK dependency entirely. Worth it.

If you DO want the SDK, set `compatibility_flags = ["nodejs_compat"]` in wrangler.toml AND use `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`. Test thoroughly with `wrangler dev` before deploying.

---

## MCP protocol cheat sheet

What claude.ai (or any MCP client) sends, in order:

1. **`POST /sse` with `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}`**
   You return: `{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{...}}`
2. **`POST /sse` with `{"method":"notifications/initialized"}`** (no id)
   You return: 202 with empty body
3. **`POST /sse` with `{"method":"tools/list"}`**
   You return: `{"tools":[...]}`
4. **`POST /sse` with `{"method":"tools/call","params":{"name":"foo","arguments":{...}}}`**
   You return: `{"content":[{"type":"text","text":"..."}]}` or with `"isError":true`

Use protocol version `2025-03-26` (Streamable HTTP). The older `2024-11-05` is SSE-based and harder to host on serverless.

Session IDs (`mcp-session-id` header) are required by the spec. Generate one on first request, echo it back. Stateless servers can ignore the contents.

---

## Database access from Workers (the gotchas)

### Postgres

```typescript
import postgres from "postgres";

const sql = postgres(env.DATABASE_URL, {
  max: 1,                    // one connection per isolate
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,            // CRITICAL for transaction-mode poolers
});

await sql`set local statement_timeout = '30s'`;  // safety
const rows = await sql`select * from foo where id = ${id}`;
await sql.end({ timeout: 5 });
```

Rules:
- Always use a **connection pooler** (Supabase Supavisor, AWS RDS Proxy, PgBouncer). Workers spawn fresh isolates per request, opening direct Postgres connections at scale will exhaust `max_connections` instantly.
- For Supabase specifically: pooler URL is `aws-0-<region>.pooler.supabase.com:6543` (transaction mode). User format is `<role>.<project_ref>` (e.g. `gong_mcp_reader.wftvwtgedvxjtwtycktt`).
- `prepare: false` because pgbouncer transaction-mode pooling can't share prepared statements across requests.
- Set `statement_timeout` per connection. Workers have 30s wall-clock max anyway, so anything longer dies regardless.
- Always create a **dedicated read-only role** with `GRANT SELECT` on only the tables the MCP needs. The role's permissions are your real security perimeter; tool design is just a UX layer on top.

### External APIs

Just use `fetch()`. Workers' `fetch` is the standard browser API.

```typescript
const r = await fetch("https://api.example.com/foo", {
  headers: { "Authorization": `Bearer ${env.API_KEY}` },
});
const data = await r.json();
```

### Cloudflare-native data (often the right choice for new builds)

- **D1** (SQLite at the edge): great for moderate-sized read-heavy data
- **KV** (key-value): perfect for caching, session storage
- **R2** (S3-compatible): blob storage, no egress fees
- **Durable Objects**: stateful per-key, useful for sessions or counters
- **Hyperdrive**: connection pooler that fronts your existing Postgres if you don't have one

---

## Secrets management

| Where | How | When |
|---|---|---|
| `.env` (gitignored) | `CLOUDFLARE_API_TOKEN=...` | Used by `wrangler` CLI for deploys |
| `.dev.vars` (gitignored) | `KEY="value"` | Read by `wrangler dev` for local Worker testing |
| Production | `echo "value" \| wrangler secret put KEY` | Encrypted on Cloudflare; injected at runtime as `env.KEY` |

**Never put secrets in `wrangler.toml`** (it gets committed). Bindings declared there are public.

To set a secret:
```bash
echo -n "your-secret-value" | npx wrangler secret put DATABASE_URL
```

To list configured secrets:
```bash
npx wrangler secret list
```

---

## Deploy + test workflow

```bash
# Auth check
export CLOUDFLARE_API_TOKEN=cfat_...
npx wrangler whoami
# Should print account name

# First deploy (creates the Worker on Cloudflare)
npx wrangler deploy
# Output: https://your-worker-name.your-subdomain.workers.dev

# Set production secrets (do this AFTER first deploy)
echo -n "postgres://..." | npx wrangler secret put DATABASE_URL

# Iterate
# (edit src/index.ts)
npx wrangler deploy

# Watch live logs
npx wrangler tail

# Local dev (uses .dev.vars for secrets, hot-reload, port 8787)
npx wrangler dev

# Test the live MCP from CLI
curl https://your-worker-name.your-subdomain.workers.dev/
curl -X POST https://your-worker-name.your-subdomain.workers.dev/sse \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}'

# Or use the official inspector (UI)
npx @modelcontextprotocol/inspector https://your-worker-name.your-subdomain.workers.dev
```

Stable URL: deploys never change the URL. Update code freely without breaking existing connectors.

---

## Adding to claude.ai as a Custom Connector

1. Open https://claude.ai
2. Settings → Connectors → **Add custom connector**
3. Name: anything readable (e.g. "My Data MCP")
4. **Remote MCP server URL**: `https://<worker-name>.<subdomain>.workers.dev/sse`
5. OAuth Client ID / Secret: leave blank unless you have OAuth (see next section)
6. Click **Add**

claude.ai sends an `initialize` + `tools/list` to verify the URL responds correctly. If both succeed, the connector lands under "Web" in your connector list.

In a chat, manually enable the connector (a tools/connectors menu in the composer). Until you enable it for that chat, Claude says "I don't have access to that tool."

---

## Auth (when ready)

### No auth (prototype mode)

URL is the secret. Don't post it in public Slack channels. Cloudflare logs every request, so if the URL leaks you'll see suspicious traffic. Rotate by deploying a new Worker name and updating users.

### OAuth 2.1 with Dynamic Client Registration (production)

Cloudflare ships `@cloudflare/workers-oauth-provider` which handles 90% of the protocol. You only write the identity verification step.

```bash
npm install @cloudflare/workers-oauth-provider
npx wrangler kv namespace create OAUTH_KV
# Add returned id to wrangler.toml as kv_namespaces binding
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Refactor `src/index.ts` to wrap the MCP handler in the OAuth provider. The Google IdP path with `hd` claim verification gates access by Google Workspace domain (e.g. `hd === "yourcompany.com"` allows anyone at that company in, blocks personal Gmail and other domains).

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

const mcpHandler = { /* the fetch handler from above */ };

const googleHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    // /authorize → redirect to Google with hd=yourcompany.com
    // /oauth/callback → exchange code, decode id_token, check hd claim
    if (idToken.hd !== "yourcompany.com") {
      return new Response("Wrong domain", { status: 403 });
    }
    // Issue our own access token, store user in OAUTH_KV
  }
};

export default new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: mcpHandler,
  defaultHandler: googleHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
```

This makes claude.ai's "Add custom connector" flow show a Google sign-in popup. After signing in, claude.ai stores a token and uses it on every subsequent MCP call. Audit logs become useful: each request includes the verified user email.

---

## Tool design principles (the part that determines product quality)

1. **Narrow tools beat raw SQL.** A `search_calls(query, since, until)` tool is more reliable than exposing `execute_sql(sql)` directly. The LLM uses narrow tools as designed; raw SQL leads to hallucinated table names and unbounded queries.

2. **Always include an "escape hatch" tool.** Even with narrow tools, edge-case questions exist. Add a `query_database(sql)` tool that allows SELECT-only against a known set of tables, capped at 500 rows, with a 30s timeout. The Postgres role's permissions are the real safety boundary; the application-side guard is for clearer error messages.

3. **Tool descriptions are your only prompt engineering surface.** Be explicit about WHEN to use each tool, WHAT it returns, and any LIMITATIONS. The LLM reads these descriptions every conversation and decides routing based on them. Bad: "Searches calls." Good: "Keyword (ILIKE) substring search across call transcripts. Returns matching calls newest first. For conceptual questions like 'pricing objections', keyword may miss matches; consider multiple terms or query_database for richer SQL."

4. **Add a `count_*` tool for any list/search tool.** Without it, the LLM tries to fetch all rows and tally them, fails on large windows, and returns wrong numbers. A dedicated count tool returns one number cheaply.

5. **Add a `describe_schema` tool for `query_database`.** Lets the LLM read column shapes before generating SQL, which dramatically reduces "column does not exist" errors.

6. **Return structured JSON inside the text content block.** MCP wants `{content: [{type: "text", text: "..."}]}`. The text should be `JSON.stringify(result, null, 2)`. The LLM parses it natively. Don't pre-format as prose; let Claude handle that.

7. **Pagination + filters > tiny limits.** My v1 had `limit: max=50` and got complained at by Claude when users wanted 6 months of data. v2 raised to `max=500` plus `since/until/offset` and the difference was night and day. When in doubt, give the LLM more headroom.

8. **`isError: true` for graceful tool failures.** Use it instead of throwing exceptions when the user's input is invalid. The LLM can recover and explain to the user, vs. a tool error which Claude treats as a system failure.

---

## Performance + cost characteristics

| Metric | Value |
|---|---|
| Cold start | ~10-15ms |
| Warm request | <1ms code execution + database round-trip |
| Free tier | 100,000 requests/day per account |
| Paid tier | $5/mo for 10M requests, plus $0.30/M after |
| Worker max execution time | 30 seconds wall clock |
| Worker max memory | 128 MB (Standard) or 256 MB (Standard Plus) |
| Bundle size limit | 3 MB minified (Free) or 10 MB (Paid) |
| Geographic deployment | ~300 edge cities, automatic |

For a real-world MCP serving ~80 internal users at ~20 queries/day each, you'll use ~1,600 requests/day, well inside the free tier. Embeddings/AI calls outside the Worker (e.g., to OpenAI for semantic search) are a separate cost.

---

## Common gotchas + solutions

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid API Token` on `/user/tokens/verify` | New `cfat_*` tokens don't work on legacy endpoint | Test against `/accounts/<id>` instead |
| `nodejs_compat` flag missing → `process is not defined` | Forgot the flag in wrangler.toml | Add `compatibility_flags = ["nodejs_compat"]` |
| `pg` library doesn't connect | `pg` (node-postgres) doesn't work in Workers | Use `postgres` (porsager/postgres) instead |
| Connector "Add" fails in claude.ai | URL not reachable or returns wrong shape | `curl POST` the `/sse` endpoint and verify response is valid JSON-RPC |
| CORS errors in browser console | Missing CORS headers | Include `Access-Control-Allow-*` headers, especially `MCP-Session-Id` |
| Worker subdomain prefix won't provision | Account never visited Workers dashboard | Visit `/<account>/workers-and-pages` once manually |
| Tools work but Claude says "no access" | Connector not enabled for that chat | Toggle it on per-conversation in Claude.ai composer |
| Postgres `prepared statement does not exist` errors | Pooler in transaction mode can't share prepared statements | Set `prepare: false` in postgres client config |
| Wrangler complains about Node version | wrangler v4 requires Node 20+ | Use `wrangler@^3` until you upgrade Node |
| Stdout buffering hides progress | Python piped to tee buffers in 4KB chunks | Use `python3 -u` for unbuffered output |

---

## Reusable extension patterns (for your other use cases)

### Pattern 1: REST API → MCP

Replace the Postgres client with `fetch()`. Tool implementations call the upstream API:

```typescript
async function handleToolCall(name: string, args: any, env: Env) {
  if (name === "search_widgets") {
    const r = await fetch(`https://api.example.com/widgets?q=${encodeURIComponent(args.query)}`, {
      headers: { Authorization: `Bearer ${env.UPSTREAM_API_KEY}` },
    });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
}
```

### Pattern 2: Multiple data sources in one MCP

Mix Postgres + REST + KV in the same Worker. Each tool picks its source. Useful when the LLM needs to join data across systems.

### Pattern 3: Caching

Use Cloudflare KV or Cache API for expensive upstream calls:

```typescript
const cached = await caches.default.match(cacheKey);
if (cached) return cached;
const fresh = await fetch(...);
const response = new Response(fresh.body, fresh);
response.headers.set("Cache-Control", "public, max-age=300");
await caches.default.put(cacheKey, response.clone());
return response;
```

### Pattern 4: Multi-tenant MCP

Same Worker URL, tenant ID derived from OAuth token's email/domain. Tools filter data by tenant. Lets one Worker serve many clients without redeploying per tenant.

### Pattern 5: AI inside the MCP (semantic search etc.)

If you need AI on the server side (e.g., generate embeddings before querying pgvector), the Worker can call OpenAI / Anthropic / Voyage from `fetch()`. Keep these calls fast (<5s) since the whole Worker request budget is 30s.

```typescript
const embedding = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
  body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
}).then(r => r.json());

const rows = await sql`
  select id, content, 1 - (embedding <=> ${embedding.data[0].embedding}::vector) as similarity
  from documents
  order by embedding <=> ${embedding.data[0].embedding}::vector
  limit 10
`;
```

---

## What I'd do differently next time

1. **Set up daily cron from day 1.** I shipped without a refresh job. Within months the data went stale and users hit a wall. A simple Cloudflare scheduled trigger (`crons = ["0 2 * * *"]` in wrangler.toml) would prevent this entirely.

2. **Add OAuth before sharing the URL with anyone outside immediate trust circle.** "URL is the secret" works for solo-dev prototypes but quickly becomes ambiguous with multiple stakeholders. The OAuth lift is small with Cloudflare's library.

3. **Custom domain from the start.** `<random>.workers.dev` URLs are technically fine but feel temporary. Pointing `mcp.client.com` to the Worker takes 5 min and looks 10x more professional.

4. **Tool descriptions written for the LLM, not for a human reader.** I rewrote my descriptions twice after watching Claude pick wrong tools. The wording matters more than I expected.

5. **Output format: always JSON, never prose.** Don't try to make tool output "pretty for the user." The LLM will format it. Just give it structured JSON.

---

## Live reference (the Hologram-Gong build)

| Component | Value / Path |
|---|---|
| MCP URL | `https://hologramgong.mathias-powell.workers.dev/sse` |
| Cloudflare account | Tech@thekiln.com (id `df3100885198fe59a4bf09a03017a811`) |
| Worker code | `kkbuilds/current-clients/hologram/gong-mcp/src/index.ts` |
| Wrangler config | `kkbuilds/current-clients/hologram/gong-mcp/wrangler.toml` |
| Backfill script (Gong → Supabase) | `kkbuilds/current-clients/hologram/backfill_gong.py` |
| Full README | `kkbuilds/current-clients/hologram/README.md` |
| Credentials reference | `kkbuilds/current-clients/hologram/CREDENTIALS.md` |
| Underlying data | Supabase project `wftvwtgedvxjtwtycktt`, tables `public.gong_calls` + `public.gong_call_list` (~8K rows each, full transcripts) |
| Postgres role used by Worker | `gong_mcp_reader` (SELECT only on those 2 tables) |
| Tools exposed | `list_calls`, `search_calls`, `count_calls`, `list_top_reps`, `get_transcript`, `query_database`, `describe_schema` |

When in doubt about any of this, read the actual `src/index.ts` in that folder. It's the canonical, working reference.

---

## Want to ship one of these for a new use case?

Tell me:
1. **Data source**: where does the data live? (Postgres? REST API? S3? GraphQL?)
2. **Read-only or read-write?** (read-only is much easier and safer)
3. **Audience**: who paste the URL into claude.ai? (one company → OAuth gate by domain. Public → URL-as-secret or full OAuth)
4. **Top 3-5 questions users will want to ask?** (these become the tools)
5. **Daily/hourly data freshness needed?** (informs whether you need a cron)

With those answers I can scaffold the whole project in under an hour, deploy it, and hand back the URL. The pattern is repeatable.
