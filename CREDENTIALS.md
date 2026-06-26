# Credentials Inventory

This file lists every credential the Hologram Gong MCP system uses, **where it lives**, and **how to rotate it**. It does NOT contain live values — those are in Cloudflare Worker secrets, the Hologram Cloudflare account dashboard, and the Hologram Supabase project. Anyone with appropriate access can read or rotate them through the rotation procedures below.

Last reviewed: **2026-06-26**

---

## Credential summary table

| Credential | Used by | Stored in | Owner of record | Rotation cadence |
|---|---|---|---|---|
| Gong API key + secret (Basic auth) | `gong-fetcher` Worker | CF Worker secret `GONG_BASIC_AUTH` | Mathias Powell | ~9 years (JWT expires 2035-04-19) |
| Hologram Cloudflare Global API Key | `wrangler` CLI for deploys | Your local shell env / dashboard | Mathias Powell | As needed |
| Hologram Cloudflare account membership | Browser access to CF dashboard | Cloudflare account team | Mathias Powell | As needed |
| Supabase Postgres `gong_mcp_reader` role password | `gong-mcp` Worker | CF Worker secret `DATABASE_URL` | Hologram Supabase project | Quarterly best practice |
| Supabase Postgres `gong_writer` role password | `gong-fetcher` Worker | CF Worker secret `DATABASE_URL` | Hologram Supabase project | Quarterly best practice |
| Supabase Postgres `postgres` superuser password | Admin operations only | Hologram Supabase project settings | Mathias Powell | Rotate ASAP, currently a weak default |
| Supabase Management API token | Admin SQL / DDL operations | Local shell env, NEVER in a Worker | Mathias Powell | When personnel changes |
| Google OAuth Client ID + Secret | `gong-mcp` Worker (OAuth sign-in) | CF Worker secrets `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | The Kiln GCP project | When OAuth client is rotated |
| OAuth `COOKIE_ENCRYPTION_KEY` | `gong-mcp` Worker (session cookies) | CF Worker secret `COOKIE_ENCRYPTION_KEY` | Generated once per deployment | Only if compromised |
| Salesforce SOAP login password | `gong-mcp` Worker | CF Worker secret `SF_PASSWORD` | Mathias's SF account | Whenever Mathias rotates his SF password |
| Salesforce security token | `gong-mcp` Worker | CF Worker secret `SF_SECURITY_TOKEN` | Mathias's SF account | When SF rotates it (after password reset, etc.) |
| Salesforce username + login URL | `gong-mcp` Worker | CF Worker secrets `SF_USERNAME` + `SF_LOGIN_URL` | — | Almost never |

---

## How to view what's deployed without seeing values

```bash
# List secrets on the MCP Worker
cd gong-mcp
CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler secret list

# List secrets on the fetcher Worker
cd ../gong-fetcher
CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler secret list
```

Wrangler returns only the secret NAMES, never values. That's the right pattern.

---

## Rotation procedures

### Gong API key + secret

1. In Gong UI (as a tenant admin): Settings → Integrations → Public API → rotate the credential pair
2. Take the new access key + secret
3. Generate the new Basic auth header:
   ```bash
   echo -n "<new-access-key>:<new-secret>" | base64
   ```
4. Push the new base64 string as `GONG_BASIC_AUTH` on the fetcher Worker:
   ```bash
   cd gong-fetcher
   echo -n "<new-base64-header>" | \
     CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
     CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
     CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
     npx wrangler secret put GONG_BASIC_AUTH
   ```
5. No redeploy needed. Worker picks up the new secret on next invocation.

### Postgres `gong_mcp_reader` password (read-only role used by the MCP Worker)

1. Generate a strong replacement: `openssl rand -hex 24`
2. Run via Supabase Management API:
   ```sql
   ALTER ROLE gong_mcp_reader WITH PASSWORD '<new-password>';
   ```
3. Rebuild the pooler URL with the new password:
   ```
   postgres://gong_mcp_reader.yxcnocxjqvlgtlwbwjpl:<new-password>@aws-1-us-east-1.pooler.supabase.com:6543/postgres
   ```
4. Push as `DATABASE_URL` on the MCP Worker:
   ```bash
   cd gong-mcp
   echo -n "<new-connection-string>" | \
     CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
     CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
     CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
     npx wrangler secret put DATABASE_URL
   ```

### Postgres `gong_writer` password (write role used by the fetcher Worker)

Same process as `gong_mcp_reader`, but:
- Replace `gong_mcp_reader` with `gong_writer` in the `ALTER ROLE` statement
- Push to the fetcher Worker (`cd gong-fetcher`) instead of the MCP Worker

### Salesforce password

If Mathias rotates his Salesforce password OR Salesforce forces a security token regeneration:

1. Get the new password
2. Get the new security token (Salesforce auto-emails this on password change; if not, generate via SF UI → Settings → Reset My Security Token)
3. Push both to the MCP Worker:
   ```bash
   cd gong-mcp
   echo -n "<new-password>" | \
     CLOUDFLARE_EMAIL="..." CLOUDFLARE_API_KEY="..." CLOUDFLARE_ACCOUNT_ID="..." \
     npx wrangler secret put SF_PASSWORD
   echo -n "<new-security-token>" | \
     CLOUDFLARE_EMAIL="..." CLOUDFLARE_API_KEY="..." CLOUDFLARE_ACCOUNT_ID="..." \
     npx wrangler secret put SF_SECURITY_TOKEN
   ```
4. Force a refresh by hitting the Worker once; the SF session cached in KV will expire and re-login with the new credentials within 30 minutes max.

### Google OAuth client (rare)

If the Google OAuth client is rotated or recreated (e.g., during a GCP project migration):

1. Get the new `client_id` and `client_secret`
2. **Critically**: ensure the new client has these Authorized Redirect URIs:
   - `https://hologramgong.mathias-powell.workers.dev/oauth/callback`
3. Push both secrets to the MCP Worker:
   ```bash
   cd gong-mcp
   echo -n "<new-client-id>" | npx wrangler secret put GOOGLE_CLIENT_ID
   echo -n "<new-client-secret>" | npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
4. Update the OAuth client's `hd` claim restriction to remain `@hologram.io,@thekiln.com` if that's the gating choice

### Hologram Cloudflare Global API Key

If Mathias rotates his Cloudflare key in the dashboard:

1. There's NO Worker-side secret to update (the key is only used by the local wrangler CLI for deploys, never by the running Workers)
2. Update wherever you store it for deploys: your shell env, a password manager, etc.
3. Verify with a no-op `wrangler whoami`

---

## What is NOT in any of the Workers

These NEVER appear as Worker secrets and should never be added:

- Mathias's personal Google account password (OAuth handles auth flow, the Worker never sees the password)
- Hologram employee credentials (the system reads SF/Gong with Mathias's identity, not per-user)
- Any Kiln-side credentials (Kiln's old Supabase, Kiln's old CF tokens) — those were migrated away on 2026-05-26

---

## Emergency: I think a credential leaked

1. **Rotate it immediately** using the procedure above
2. **Verify the Worker still works** by hitting a tool: `curl https://hologramgong.mathias-powell.workers.dev/` should return JSON
3. If the leak was in source code or this repo: check git history with `git log --all -p | grep <suspected-leak>`, then either rewrite history (if recent) or accept the leak and rotate forever
4. Notify the credential owner (Mathias for SF/Gong/CF, the Kiln GCP holder for Google OAuth)

---

## Files that purposely don't contain credentials

| File | What's in it |
|---|---|
| `gong-mcp/.env.example` | Variable names and example shapes, NO values |
| `gong-mcp/.dev.vars.example` | Same, for `wrangler dev` local runs |
| `gong-fetcher/.env.example` | Same, for the fetcher Worker |
| `gong-fetcher/.dev.vars.example` | Same |
| `wrangler.toml` files | Public account ID, KV namespace ID, cron schedule (these are identifiers, not secrets) |

If you fork or clone this repo, copy the `.example` files to their non-example names, populate with real values, and they'll be picked up by `wrangler dev` (`.dev.vars`) and `wrangler deploy` (which reads `.env` via `export $(cat .env | xargs)`).
