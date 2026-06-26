# gong-fetcher

Daily Cloudflare Worker that pulls new Gong calls into Hologram's Supabase. Replaces the manual `python3 backfill_gong.py` runs documented in the parent README.

Last verified working: **2026-05-27**

---

## What this is

A scheduled Cloudflare Worker on Hologram's CF account that:

1. Reads the high-water mark (`max(call_date)`) from `public.gong_calls`
2. Pulls every Gong call since that timestamp via the Gong REST API
3. Pulls transcripts for those calls
4. Upserts into `public.gong_calls` + `public.gong_call_list` on `call_id`

Idempotent: re-running pulls only what's missing. Safe to trigger by hand for catch-up.

---

## Live URL + endpoints

```
https://gong-fetcher.mathias-powell.workers.dev
```

| Endpoint | Method | Purpose |
|---|---|---|
| `/` or `/health` | GET | Health check, returns service metadata |
| `/run` | GET | Manually trigger a sync, returns JSON summary |

`/run` is unauthenticated. The URL is unadvertised; rely on URL secrecy for v1. Add auth before broad rollout.

---

## Schedule

```
Cron: 0 12 * * *
Time: 12:00 UTC daily = 07:00 EST (literal) = 08:00 EDT (summer DST) = 17:30 IST
```

Pinned to 07:00 EST literally (UTC-5). Cloudflare Cron Triggers do not auto-shift for DST, so during US summer DST this fires at 08:00 ET instead of 07:00 ET. Configured in `wrangler.toml` under `[triggers]`.

---

## Architecture

```
Cloudflare Cron Trigger (daily 21:30 UTC)
   │
   ▼
gong-fetcher Worker
   │  Account: mathias.powell@hologram.io (Hologram CF, id fbaa804209ab68a25daccf0076477227)
   │  Source: src/index.ts
   │  Secrets: GONG_BASIC_AUTH, DATABASE_URL
   │
   ├─→ Gong API us-47719.app.gong.io
   │     GET /v2/calls?fromDateTime=<hwm>&toDateTime=<now>
   │     POST /v2/calls/transcript {filter:{callIds:[...]}}
   │
   └─→ Supabase Postgres (project yxcnocxjqvlgtlwbwjpl)
         via Supavisor pooler aws-1-us-east-1.pooler.supabase.com:6543
         as gong_writer role (INSERT, UPDATE, SELECT on the two tables only)
```

The Worker uses postgres.js with `prepare: false` so it works against the Supabase transaction pooler.

---

## Files

| File | Purpose | In git? |
|---|---|---|
| `README.md` | This file | Yes |
| `wrangler.toml` | Worker config, cron trigger, account binding | Yes |
| `package.json` | npm deps (postgres, wrangler, workers-types) | Yes |
| `tsconfig.json` | TypeScript config | Yes |
| `src/index.ts` | Worker source (~300 lines) | Yes |
| `.gitignore` | Ignores node_modules/, .wrangler/, .dev.vars, .env | Yes |
| `.dev.vars` | Local dev secrets for `wrangler dev` | No (gitignored) |
| `node_modules/` | Installed packages | No (gitignored) |

---

## Operations

All wrangler commands need Hologram CF credentials in env. The cfk_ key uses legacy `X-Auth-Email` + `X-Auth-Key` headers, which wrangler reads from `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`.

### Redeploy after editing `src/index.ts`

```bash
cd gong-fetcher

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler deploy
```

### Watch live logs

```bash
cd gong-fetcher

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler tail
```

Each scheduled run logs the window, page counts, transcript counts, and upsert progress.

### Trigger a sync manually

From any machine:

```bash
curl -s https://gong-fetcher.mathias-powell.workers.dev/run | python3 -m json.tool
```

Response:

```json
{
  "ok": true,
  "fetched": 26,
  "with_transcript": 25,
  "upserted": 26,
  "window": "2026-05-22T21:03:43Z -> 2026-05-26T22:41:23Z",
  "hwm_before": "2026-05-22T21:03:43Z",
  "hwm_after": "2026-05-26T20:00:59Z",
  "elapsed_seconds": 7.155
}
```

### List secrets

```bash
cd gong-fetcher

CLOUDFLARE_EMAIL="mathias.powell@hologram.io" \
CLOUDFLARE_API_KEY="<hologram-cf-global-key>" \
CLOUDFLARE_ACCOUNT_ID="fbaa804209ab68a25daccf0076477227" \
npx wrangler secret list
```

Should show `GONG_BASIC_AUTH` and `DATABASE_URL`.

### Rotate the Gong API credentials

If Mathias rotates the Gong key:

1. Update `CREDENTIALS.md` (at the repo root) with the new key + secret reference
2. Generate the new pre-encoded Basic auth header:
   ```bash
   echo -n "<new-access-key>:<new-secret>" | base64
   ```
3. Push to the Worker:
   ```bash
   echo -n "<new-base64-header>" | \
     CLOUDFLARE_EMAIL="..." CLOUDFLARE_API_KEY="..." CLOUDFLARE_ACCOUNT_ID="..." \
     npx wrangler secret put GONG_BASIC_AUTH
   ```

No redeploy needed. Worker picks up the new secret on next invocation.

### Rotate the Postgres writer password

1. Run via Supabase Management API:
   ```sql
   ALTER ROLE gong_writer WITH PASSWORD '<new-32char-random>';
   ```
2. Rebuild the pooler URL with the new password
3. Push to the Worker:
   ```bash
   echo -n "postgres://gong_writer.yxcnocxjqvlgtlwbwjpl:<new-pw>@aws-1-us-east-1.pooler.supabase.com:6543/postgres" | \
     CLOUDFLARE_EMAIL="..." CLOUDFLARE_API_KEY="..." CLOUDFLARE_ACCOUNT_ID="..." \
     npx wrangler secret put DATABASE_URL
   ```

### Local dev (rare)

Create `.dev.vars` (gitignored):

```
GONG_BASIC_AUTH=<base64-header>
DATABASE_URL=postgres://gong_writer.yxcnocxjqvlgtlwbwjpl:<pw>@aws-1-us-east-1.pooler.supabase.com:6543/postgres
```

Then run:

```bash
npx wrangler dev --test-scheduled
```

In a separate terminal, fire the scheduled handler:

```bash
curl http://localhost:8787/__scheduled
```

---

## Failure modes + recovery

| Symptom | Likely cause | Fix |
|---|---|---|
| `/run` returns `{"ok": false, "error": "...gong 401..."}` | Gong API key/secret rotated | See "Rotate the Gong API credentials" above |
| `/run` returns `{"ok": false, "error": "...connect ECONNREFUSED..."}` or `password authentication failed` | gong_writer password rotated or pooler URL stale | See "Rotate the Postgres writer password" above |
| `/run` returns `{"ok": false, "error": "could not read high-water mark..."}` | `public.gong_calls` table is empty | Bootstrap with the Python `backfill_gong.py` first to seed history |
| Daily scheduled run shows 0 calls for several days | Either no calls actually happened, OR Gong API silently changed pagination | Spot-check by running `/run` manually and watching `wrangler tail` |
| Worker exceeds 30s wall-clock on `/run` | Big backfill window (>200 calls) | Run `backfill_gong.py` on KK's machine for catch-up; daily scheduled runs use the same code with a higher CPU budget |
| Hologram team complains "MCP is missing yesterday's call" | Either yesterday's cron failed, or call wasn't synced yet (cron is 21:30 UTC, so US-evening calls land in same day's window) | `curl https://gong-fetcher.mathias-powell.workers.dev/run` to force immediate catch-up |

The daily cron is self-healing: a single missed day is fully recovered by the next successful run (HWM-driven). Multiple consecutive failures still recover cleanly when one run succeeds.

---

## Relationship to other Hologram artifacts

- **gong-mcp** (sibling folder) — the MCP server that queries this Supabase from claude.ai. Uses `gong_mcp_reader` (SELECT-only). This fetcher uses `gong_writer` (INSERT/UPDATE/SELECT). Strict role separation.
- **backfill_gong.py** (parent folder) — original Python script, kept for bootstrap and big backfills. Logic ported 1:1 here. Now reads/writes Hologram Supabase (not Kiln's old).
- **CREDENTIALS.md** (parent folder) — single source of truth for Gong + Supabase credentials. Sync changes there back into Worker secrets.

---

## Contact

Built by KK for Hologram. Hologram-side contact: `kaushik@thekiln.com`. Anything weird, KK is the one to ping.

The Cloudflare account and Supabase project are Hologram-owned (Mathias's identity). If KK steps away, Mathias has full administrative access via the Hologram CF dashboard and Supabase project.
