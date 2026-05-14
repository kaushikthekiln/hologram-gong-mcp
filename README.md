# Hologram Gong MCP

Remote MCP server that lets Hologram employees chat with their Gong call transcripts from Claude.ai (web). Hosted on Cloudflare Workers. Gated to `@hologram.io` and `@thekiln.com` Google Workspace accounts via OAuth.

## How end users connect

1. Open https://claude.ai
2. Settings → Connectors → **Add custom connector**
3. **Name**: anything readable (e.g. `Hologram Gong`)
4. **Remote MCP server URL**: `https://hologramgong.soft-mountain-985d.workers.dev/sse`
5. Leave OAuth fields blank
6. Click **Add**
7. Sign in with your `@hologram.io` or `@thekiln.com` Google account when prompted
8. Done. Start chatting in any new Claude.ai conversation.

## Tools exposed

| Tool | Purpose |
|---|---|
| `list_calls` | List calls with date range / rep / direction filters and pagination (max 500) |
| `search_calls` | Keyword (ILIKE) search over title + transcript |
| `count_calls` | Aggregate count for any window + filter |
| `list_top_reps` | Top primary_user_ids by call count |
| `get_transcript` | Full transcript + metadata for one call_id |
| `query_database` | SELECT-only escape hatch (capped at 500 rows, 30s timeout) |
| `describe_schema` | Returns column shape of both Gong tables |

## Architecture

```
Claude.ai (web)
   |  HTTPS + JSON-RPC 2.0 (MCP Streamable HTTP transport)
   v
Cloudflare Worker (this code)
   |  Google OAuth gate (hd claim check for hologram.io / thekiln.com)
   |  Reads env.DATABASE_URL secret
   v
Supabase Postgres pooler (Supavisor, transaction mode)
   |  gong_mcp_reader role (SELECT-only on the 2 gong tables)
   v
Tables: public.gong_calls + public.gong_call_list
```

The Worker is stateless: no data lives in it, no AI runs in it. It's a JSON-RPC dispatcher that turns Claude.ai tool calls into SQL queries against an existing Supabase mirror of Gong call data.

## Local development

```bash
npm install
cp .env.example .env                # fill in real values
cp .dev.vars.example .dev.vars      # fill in DATABASE_URL
npx wrangler dev                    # runs locally on http://localhost:8787
```

## Deploy

```bash
# First-time: install Wrangler globally OR rely on `npx wrangler`
export CLOUDFLARE_API_TOKEN=cfat_...
export CLOUDFLARE_ACCOUNT_ID=...

# Push production secrets (one-time, or whenever they rotate)
echo -n "postgres://..." | npx wrangler secret put DATABASE_URL
echo -n "<google_client_id>" | npx wrangler secret put GOOGLE_CLIENT_ID
echo -n "<google_client_secret>" | npx wrangler secret put GOOGLE_CLIENT_SECRET
echo -n "<random_32_byte_hex>" | npx wrangler secret put COOKIE_ENCRYPTION_KEY

# Deploy code
npx wrangler deploy

# Watch live logs
npx wrangler tail
```

## How the Gong mirror gets refreshed

`backfill_gong.py` is a Python script that pulls calls from Gong's API and upserts them into Supabase. Idempotent (safe to re-run). Detects the latest call_date already in the DB and only fetches newer calls.

```bash
# Dry run (no DB writes, shows what would be fetched)
python3 backfill_gong.py --dry-run

# Real run
python3 backfill_gong.py

# Custom window
python3 backfill_gong.py --since 2026-01-01T00:00:00Z --until 2026-02-01T00:00:00Z
```

Run on a daily cron (e.g., via system cron, n8n, or a Cloudflare scheduled trigger) to keep data fresh.

## OAuth gate

The Worker only allows users whose Google ID token has `hd` (hosted domain) equal to `hologram.io` or `thekiln.com`. Personal Gmail and other domains are rejected with a clear 403 message.

To change the allowed domains, edit `ALLOWED_DOMAINS` in `src/index.ts` and redeploy.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | The Worker (MCP server + OAuth wrapper) |
| `wrangler.toml` | Cloudflare deploy config |
| `package.json` | npm dependencies |
| `tsconfig.json` | TypeScript config |
| `backfill_gong.py` | Gong -> Supabase sync script |
| `HANDOVER_CLOUDFLARE_WORKERS_MCP.md` | Full playbook for the Cloudflare Workers + remote MCP pattern (reusable for other clients/use cases) |
| `.env.example` | Template for required environment variables |
| `.gitignore` | Keeps secrets and build artifacts out of git |

## Required environment variables

See `.env.example`. None of these are committed to the repo. The Worker reads them at runtime via Cloudflare Worker secrets (set via `wrangler secret put`).

## Stack

- **Runtime**: Cloudflare Workers (TypeScript, V8 isolates with `nodejs_compat`)
- **MCP transport**: Streamable HTTP (JSON-RPC 2.0)
- **Auth**: OAuth 2.1 with Dynamic Client Registration via `@cloudflare/workers-oauth-provider`
- **Identity provider**: Google Workspace (hd claim verification)
- **Database**: Supabase Postgres (via Supavisor pooler, read-only role)
- **Postgres client**: `postgres` (porsager/postgres, Workers-compatible)
- **Backfill**: Python 3 + Gong REST API + Supabase Management API

## License

Internal. Built by Kiln for Hologram. Do not redistribute.
