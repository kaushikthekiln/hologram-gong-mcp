# Hologram Gong MCP

The complete source + handover materials for the Hologram Gong + Salesforce MCP system. This is the canonical home for the code, infrastructure config, and operational documentation.

Last verified working end-to-end: **2026-06-26**

---

## What this is, in one paragraph

Hologram has thousands of Gong sales calls (Feb 2024 → today). Those calls (with full transcripts) are mirrored into a Hologram-owned Supabase Postgres database. A small Cloudflare Worker exposes that database — plus Hologram's live Salesforce data — as an MCP (Model Context Protocol) server. Anyone at Hologram can paste a single URL into Claude.ai's "Custom Connectors" dialog, sign in with Google, and start asking natural-language questions like "show me the last 5 pricing calls" or "what's the full Salesforce context on Signify?" A second Cloudflare Worker runs daily to keep the Gong call mirror fresh automatically.

---

## Live URLs

| Thing | URL |
|---|---|
| **MCP custom connector URL** (paste into claude.ai) | `https://hologramgong.mathias-powell.workers.dev/sse` |
| MCP Worker health check | `https://hologramgong.mathias-powell.workers.dev/` |
| Daily auto-sync Worker | `https://gong-fetcher.mathias-powell.workers.dev/` |
| Daily auto-sync manual trigger | `https://gong-fetcher.mathias-powell.workers.dev/run` |

---

## How a Hologram user adds the connector to claude.ai

1. Open https://claude.ai → Settings → **Connectors** → **Add custom connector**
2. Name: `Hologram Gong + SF` (or whatever's readable)
3. Remote MCP server URL: `https://hologramgong.mathias-powell.workers.dev/sse`
4. Leave OAuth fields blank → click **Add**
5. Open a new chat → enable the connector from the tools menu
6. When prompted, sign in with Google using your `@hologram.io` account
7. Verify you see **12 tools** (7 Gong + 5 Salesforce). If fewer, disconnect and re-add.

---

## Repository layout

```
hologram-gong-mcp/
├── README.md                  ← this file
├── HANDOVER.md                ← architecture, deploy guide, migration history
├── CREDENTIALS.md             ← inventory of every secret + how to rotate
├── backfill_gong.py           ← Python script for one-shot or big-window backfills
├── gong-mcp/                  ← the MCP Worker (12 tools)
│   ├── README.md
│   ├── src/index.ts           ← Cloudflare Worker entry, 7 Gong tools + OAuth
│   ├── src/sf.ts              ← 5 Salesforce tools (SOAP login + REST API v66)
│   ├── wrangler.toml
│   ├── package.json
│   └── ...
├── gong-fetcher/              ← the daily auto-sync Worker
│   ├── README.md
│   ├── src/index.ts           ← scheduled handler, fires daily at 07:00 EST
│   ├── wrangler.toml
│   ├── package.json
│   └── ...
└── sf-connected-app/          ← Salesforce Connected App metadata (for future JWT migration)
    ├── sfdx-project.json
    └── force-app/main/default/externalClientApplications/HologramGongMCP.externalClientApplication-meta.xml
```

---

## Architecture (one diagram)

```
Claude.ai (browser)
   │  HTTPS + JSON-RPC 2.0 (MCP Streamable HTTP)
   │  OAuth 2.1 with Google IdP, gated to @hologram.io + @thekiln.com via hd claim
   ▼
gong-mcp Worker  hologramgong.mathias-powell.workers.dev
   │  CF account: Mathias.powell@hologram.io (id fbaa804209ab68a25daccf0076477227)
   │  Source: gong-mcp/src/
   │  KV: OAUTH_KV (token cache)
   │  Secrets: DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, SF_*, COOKIE_ENCRYPTION_KEY
   │
   ├─→ Supabase Postgres pooler (read-only)
   │     aws-1-us-east-1.pooler.supabase.com:6543
   │     Auth: gong_mcp_reader role (SELECT on gong tables only)
   │     Project: yxcnocxjqvlgtlwbwjpl ("Gong + Supabase MCP", Hologram-owned)
   │     Tables: public.gong_calls + public.gong_call_list
   │
   └─→ Salesforce REST API v66 (live, read-only)
         Auth: SOAP login as mathias.powell@hologram.io, session cached in KV
         Org: production (id 00D1I0000002wiYUAQ)

   ┌────────────────────────────────────────────┐
   │ DAILY 07:00 EST (12:00 UTC) cron trigger   │
   └────────────────────────────────────────────┘
       │
       ▼
gong-fetcher Worker  gong-fetcher.mathias-powell.workers.dev
   │  Same CF account
   │  Source: gong-fetcher/src/
   │  Secrets: GONG_BASIC_AUTH, DATABASE_URL (writer role)
   │
   ├─→ Gong API us-47719.app.gong.io
   │     GET /v2/calls + POST /v2/calls/transcript
   │
   └─→ Supabase Postgres (write)
         Auth: gong_writer role (INSERT/UPDATE/SELECT on gong tables only)
         Upserts into public.gong_calls + public.gong_call_list on call_id
```

---

## The 12 tools

| # | Tool | What it does |
|---|---|---|
| 1 | `list_calls` | List Gong calls with date range / rep / direction filters and pagination (max 500 per call) |
| 2 | `search_calls` | Keyword (ILIKE) search over title + transcript with date range + pagination |
| 3 | `count_calls` | Aggregate counts for any window + filter |
| 4 | `list_top_reps` | Top primary_user_ids by call count |
| 5 | `get_transcript` | Full transcript + metadata for one call_id |
| 6 | `query_database` | SELECT-only escape hatch (capped at 500 rows, 30s statement timeout) |
| 7 | `describe_schema` | Returns column shape of both gong tables |
| 8 | `get_sf_account` | Lookup Salesforce Account by name / domain / id, returns candidates with match_confidence |
| 9 | `list_sf_opportunities_for_account` | Open + recent closed deals for an SF Account, joined with OpportunityContactRole |
| 10 | `list_sf_activity_for_account` | Tasks + Events in parallel, 90-day default window |
| 11 | `list_sf_contacts_for_account` | Contacts at an Account + their open-deal roles |
| 12 | `get_call_with_sf_context` | Cross-system join: Gong call_id → title-parsed company → SF Account + opps + activity |

---

## Data freshness

- **Gong calls**: synced **daily at 07:00 EST** (12:00 UTC) via the gong-fetcher Worker. Calls land in the database within ~24 hours of happening, typically faster.
- **Salesforce**: read **live** on every tool call (no caching beyond the 30-min auth session in KV). Always current.

If you need to force a fresh sync (e.g., before a meeting where today's morning calls matter):

```bash
curl -s https://gong-fetcher.mathias-powell.workers.dev/run | python3 -m json.tool
```

That triggers an immediate sync and returns a JSON summary of what was pulled.

---

## Deploying changes

Each Worker is independently deployable. See per-folder READMEs:

- `gong-mcp/README.md` — deploy the MCP Worker (after editing tools or auth logic)
- `gong-fetcher/README.md` — deploy the auto-sync Worker (after editing cron schedule or sync logic)

Both Workers live on Hologram's own Cloudflare account (`fbaa804209ab68a25daccf0076477227`). Whoever owns this post-handover needs:

1. Access to Mathias's Cloudflare account (or be added as a member)
2. The wrangler CLI installed: `npm install -g wrangler` (or use `npx wrangler` from each folder)
3. The Hologram Cloudflare Global API Key (see `CREDENTIALS.md`)

---

## Operational responsibilities post-handover

| Responsibility | Owner | Cadence |
|---|---|---|
| Watch daily cron health (check newest call date is <48h old) | Hologram ops or designated maintainer | Weekly spot check |
| Rotate Mathias's Gong API key when it expires | Hologram | JWT expiry: 2035-04-19 (~9 years from now) |
| Rotate Salesforce password / security token if Mathias's account changes | Hologram | As needed |
| Rotate Postgres role passwords | Hologram | Quarterly best practice |
| Re-add the Google OAuth redirect URI if the Worker URL ever changes | Whoever holds Kiln GCP access | One-time, on URL change |
| Re-deploy after editing source code | Hologram or successor | As needed |

---

## Known limitations

| Limitation | Why | Path to fix |
|---|---|---|
| **Salesforce auth uses SOAP login + Mathias's password** | Hologram has Connected App creation DISABLED at the org level (SF Support ticket needed to enable) | Once Hologram IT enables Connected App creation, deploy the metadata in `sf-connected-app/` and migrate `src/sf.ts` to JWT Bearer auth (~20 line swap) |
| **No semantic search over transcripts** | Not built yet | Add pgvector + embeddings to the Supabase tables; ~1-2 day build |
| **OpportunityContactRole is mostly empty** | Hologram reps don't populate it | Process change, not a code issue |
| **`get_call_with_sf_context` title parser misses titles without colons** | Hologram's title format is mostly "Company: Meet with X" | Add a Lead fallback when Account search misses |

---

## Handover materials

- **`HANDOVER.md`** — the full architecture deep-dive, migration history (Kiln CF → Hologram CF on 5/26/26), every secret + how it flows, every operational runbook. Read this if you're inheriting ownership.
- **`CREDENTIALS.md`** — inventory of every credential the system uses, where it's stored, and exactly how to rotate it. No live values in this file (those live in Worker secrets, the Hologram Cloudflare account, and the Hologram Supabase project).
- **Per-Worker READMEs** — deploy, tail logs, rotate secrets, local dev.

---

## Contact

Built by KK at The Kiln for the Hologram engagement. Post-handover, the canonical contact is `kaushik@thekiln.com`. For Hologram-internal escalations, ping Mathias Powell (`mathias.powell@hologram.io`) who owns the Cloudflare + Supabase accounts that host the system.
