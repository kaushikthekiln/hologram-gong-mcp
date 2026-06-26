# gong-mcp

The Cloudflare Worker that exposes Hologram's Gong + Salesforce data as an MCP server. Pasted into Claude.ai as a custom connector, it gives the team 12 tools (7 Gong + 5 Salesforce) for plain-English data queries.

Last verified working: **2026-06-26**

---

## What this is

A Cloudflare Worker that:

1. Implements MCP (Model Context Protocol) Streamable HTTP transport at `/sse`
2. Wraps the OAuth 2.1 flow with Dynamic Client Registration for claude.ai
3. Gates sign-in via Google OAuth, restricted to `@hologram.io` + `@thekiln.com` (using Google's `hd` claim)
4. Queries Hologram's Supabase Postgres (read-only) for Gong call data
5. Queries Hologram's Salesforce production org (read-only) via SOAP-login session caching

---

## Live URL

```
https://hologramgong.mathias-powell.workers.dev
```

Custom connector URL for claude.ai: `https://hologramgong.mathias-powell.workers.dev/sse`

OAuth callback: `https://hologramgong.mathias-powell.workers.dev/oauth/callback` (already registered with the Google OAuth client in The Kiln GCP project)

---

## Architecture

```
Claude.ai (browser)
   │  MCP over Streamable HTTP
   │  OAuth 2.1 + Google IdP (hd-claim gated to @hologram.io + @thekiln.com)
   ▼
This Worker  hologramgong.mathias-powell.workers.dev
   │  CF account: fbaa804209ab68a25daccf0076477227 (Hologram)
   │  KV: OAUTH_KV (session + Salesforce session cache)
   │  Source: src/index.ts (entry, Gong tools) + src/sf.ts (SF tools)
   │
   ├─→ Supabase Postgres pooler  aws-1-us-east-1.pooler.supabase.com:6543
   │     Auth: gong_mcp_reader role (SELECT-only)
   │     Project: yxcnocxjqvlgtlwbwjpl
   │
   └─→ Salesforce REST API v66
         Auth: SOAP login with mathias.powell@hologram.io, session cached 30 min in KV
         Org: production (00D1I0000002wiYUAQ)
```

---

## The 12 tools (handler locations in src/)

| Tool | Source |
|---|---|
| `list_calls` | `src/index.ts` |
| `search_calls` | `src/index.ts` |
| `count_calls` | `src/index.ts` |
| `list_top_reps` | `src/index.ts` |
| `get_transcript` | `src/index.ts` |
| `query_database` | `src/index.ts` |
| `describe_schema` | `src/index.ts` |
| `get_sf_account` | `src/sf.ts` |
| `list_sf_opportunities_for_account` | `src/sf.ts` |
| `list_sf_activity_for_account` | `src/sf.ts` |
| `list_sf_contacts_for_account` | `src/sf.ts` |
| `get_call_with_sf_context` | `src/sf.ts` (title parser) + both sources |

---

## Operations

All wrangler commands need Hologram CF credentials in env. The cfk_ Global API Key uses legacy `X-Auth-Email` + `X-Auth-Key` auth, which wrangler reads from `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`.

### Redeploy after editing `src/index.ts` or `src/sf.ts`

```bash
cd gong-mcp

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler deploy
```

### Watch live request logs

```bash
cd gong-mcp

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler tail
```

Useful when the team reports something broken. Streams every request live.

### Health check

```bash
curl https://hologramgong.mathias-powell.workers.dev/
```

Should return JSON with `status: "ok"`.

### List secrets (names only)

```bash
cd gong-mcp

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler secret list
```

Should show 8 secrets:
- `DATABASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- `SF_USERNAME`
- `SF_PASSWORD`
- `SF_SECURITY_TOKEN`
- `SF_LOGIN_URL`

### Rotating any secret

See `../CREDENTIALS.md` at the repo root for procedures for each individual secret.

### Local dev

Create `.dev.vars` (gitignored) by copying `.dev.vars.example` and filling in real values, then:

```bash
npx wrangler dev
```

Wrangler will serve on `localhost:8787`. OAuth won't work locally (Google won't redirect back to localhost unless you add `http://localhost:8787/oauth/callback` to the OAuth client's authorized redirect URIs).

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| "Failed to add connector" in claude.ai | OAuth client doesn't have the Worker URL registered as a redirect URI | Add `https://hologramgong.mathias-powell.workers.dev/oauth/callback` to the Google OAuth client in The Kiln GCP |
| All Gong tools error | Postgres pooler unreachable, OR gong_mcp_reader password rotated | Verify `DATABASE_URL` secret; rotate per CREDENTIALS.md |
| All SF tools error with "INVALID_LOGIN" | Mathias's SF password or security token changed | Rotate `SF_PASSWORD` + `SF_SECURITY_TOKEN` per CREDENTIALS.md |
| `get_call_with_sf_context` returns 0 candidates for valid calls | Title parser pattern didn't match (e.g., titles without colons) | Either expand the title parser regex in `src/sf.ts`, or add a Lead fallback search |
| Salesforce session keeps re-logging in (high SOAP login count) | KV session cache write failed | Check Worker logs via `wrangler tail`; KV binding may have changed |
