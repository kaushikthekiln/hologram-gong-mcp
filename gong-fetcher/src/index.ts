import postgres from "postgres";

interface Env {
  GONG_BASIC_AUTH: string;
  DATABASE_URL: string;
}

interface GongCall {
  id: string;
  title?: string;
  url?: string;
  started?: string;
  scheduled?: string;
  duration?: number;
  direction?: string;
  primaryUserId?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  workspaceId?: string;
  sdrDisposition?: string;
  clientUniqueId?: string;
  purpose?: string;
  isPrivate?: boolean;
  calendarEventId?: string;
  customData?: unknown;
  meetingUrl?: string;
}

interface GongTranscriptEntry {
  callId: string;
  transcript: Array<{
    speakerId?: string;
    sentences?: Array<{ text?: string }>;
  }>;
}

const GONG_BASE = "https://api.gong.io";

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function gongRequest(
  env: Env,
  method: string,
  path: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<any> {
  const url = new URL(`${GONG_BASE}${path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v);
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Basic ${env.GONG_BASIC_AUTH}`,
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const r = await fetch(url.toString(), init);
    if (r.status === 429) {
      const waitSec = parseInt(r.headers.get("Retry-After") || "5", 10);
      console.log(`gong rate-limit, sleeping ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (r.status >= 500 && r.status < 600) {
      console.log(`gong ${r.status}, retrying in 5s`);
      await sleep(5000);
      continue;
    }
    const text = await r.text();
    if (r.status === 404 && text.toLowerCase().includes("no calls found")) {
      return { calls: [], records: {} };
    }
    if (r.status >= 400) {
      throw new Error(`gong ${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }
  throw new Error(`gong ${method} ${path} failed after retries`);
}

async function fetchCallList(env: Env, since: string, until: string): Promise<GongCall[]> {
  const all: GongCall[] = [];
  let cursor: string | undefined;
  let page = 0;
  while (true) {
    const params: Record<string, string> = { fromDateTime: since, toDateTime: until };
    if (cursor) params.cursor = cursor;
    const data = await gongRequest(env, "GET", "/v2/calls", { params });
    const calls = (data.calls || []) as GongCall[];
    all.push(...calls);
    cursor = data?.records?.cursor;
    page += 1;
    console.log(`  page ${page}: ${calls.length} calls (cumulative ${all.length})`);
    if (!cursor) break;
    await sleep(400);
  }
  return all;
}

async function fetchTranscripts(
  env: Env,
  callIds: string[],
): Promise<Map<string, GongTranscriptEntry>> {
  const out = new Map<string, GongTranscriptEntry>();
  const BATCH = 50;
  for (let i = 0; i < callIds.length; i += BATCH) {
    const batch = callIds.slice(i, i + BATCH);
    try {
      const data = await gongRequest(env, "POST", "/v2/calls/transcript", {
        body: { filter: { callIds: batch } },
      });
      for (const entry of (data.callTranscripts || []) as GongTranscriptEntry[]) {
        out.set(entry.callId, entry);
      }
      console.log(`  transcripts ${i + batch.length}/${callIds.length}`);
    } catch (e) {
      console.log(`  transcript batch ${i}-${i + batch.length} failed: ${e}`);
    }
    await sleep(400);
  }
  return out;
}

function formatTranscript(
  entry: GongTranscriptEntry | undefined,
): { text: string; speakers: string[] } {
  if (!entry) return { text: "", speakers: [] };
  const pieces: string[] = [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const u of entry.transcript || []) {
    const sid = u.speakerId || "";
    if (sid && !seen.has(sid)) {
      order.push(sid);
      seen.add(sid);
    }
    for (const s of u.sentences || []) {
      const t = (s.text || "").trim();
      if (t) pieces.push(`Speaker ${sid}: ${t}`);
    }
  }
  return { text: pieces.join("\n\n"), speakers: order };
}

interface Row {
  call_id: string;
  title: string | null;
  transcript: string;
  url: string | null;
  call_date: string | null;
  duration: number | null;
  direction: string | null;
  primary_user_id: string | null;
  system: string | null;
  scope: string | null;
  media: string | null;
  language: string | null;
  workspace_id: string | null;
  sdr_disposition: string | null;
  client_unique_id: string | null;
  purpose: string | null;
  is_private: boolean | null;
  calendar_event_id: string | null;
  custom_data: unknown;
  speaker_ids: string[] | null;
  speaker_count: number;
  scheduled: string | null;
  meeting_url: string | null;
  speaker_1_id: string | null;
  speaker_2_id: string | null;
  speaker_3_id: string | null;
  speaker_4_id: string | null;
  speaker_5_id: string | null;
  speaker_6_id: string | null;
  speaker_7_id: string | null;
  speaker_8_id: string | null;
  speaker_9_id: string | null;
  speaker_10_id: string | null;
}

function buildRow(call: GongCall, t: GongTranscriptEntry | undefined): Row {
  const { text, speakers } = formatTranscript(t);
  const slot = (i: number): string | null => speakers[i] ?? null;
  const started = call.started || call.scheduled || null;
  return {
    call_id: String(call.id || ""),
    title: call.title ?? null,
    transcript: text,
    url: call.url ?? null,
    call_date: started,
    duration: call.duration ?? null,
    direction: call.direction ?? null,
    primary_user_id: call.primaryUserId ?? null,
    system: call.system ?? null,
    scope: call.scope ?? null,
    media: call.media ?? null,
    language: call.language ?? null,
    workspace_id: call.workspaceId ?? null,
    sdr_disposition: call.sdrDisposition ?? null,
    client_unique_id: call.clientUniqueId ?? null,
    purpose: call.purpose ?? null,
    is_private: call.isPrivate ?? null,
    calendar_event_id: call.calendarEventId ?? null,
    custom_data: call.customData ?? null,
    speaker_ids: speakers.length ? speakers : null,
    speaker_count: speakers.length,
    scheduled: call.scheduled ?? null,
    meeting_url: call.meetingUrl ?? null,
    speaker_1_id: slot(0),
    speaker_2_id: slot(1),
    speaker_3_id: slot(2),
    speaker_4_id: slot(3),
    speaker_5_id: slot(4),
    speaker_6_id: slot(5),
    speaker_7_id: slot(6),
    speaker_8_id: slot(7),
    speaker_9_id: slot(8),
    speaker_10_id: slot(9),
  };
}

const CALLS_COLS = [
  "call_id", "title", "transcript", "url", "call_date", "duration", "direction",
  "primary_user_id", "system", "scope", "media", "language", "workspace_id",
  "sdr_disposition", "client_unique_id", "purpose", "is_private", "calendar_event_id",
  "custom_data", "speaker_ids", "speaker_count", "scheduled", "meeting_url",
  "speaker_1_id", "speaker_2_id", "speaker_3_id", "speaker_4_id", "speaker_5_id",
  "speaker_6_id", "speaker_7_id", "speaker_8_id", "speaker_9_id", "speaker_10_id",
] as const;

const CALL_LIST_COLS = [
  "call_id", "title", "transcript", "url", "call_date", "duration", "direction",
  "primary_user_id", "system", "scope", "media", "language", "workspace_id",
  "sdr_disposition", "client_unique_id", "purpose", "is_private", "calendar_event_id",
  "custom_data", "speaker_count", "scheduled", "meeting_url",
  "speaker_1_id", "speaker_2_id", "speaker_3_id", "speaker_4_id", "speaker_5_id",
  "speaker_6_id", "speaker_7_id", "speaker_8_id", "speaker_9_id", "speaker_10_id",
] as const;

async function upsertCalls(sql: postgres.Sql, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [...CALLS_COLS] as string[];
  await sql`
    INSERT INTO public.gong_calls ${sql(rows as unknown as Record<string, unknown>[], ...cols)}
    ON CONFLICT (call_id) DO UPDATE SET
      title = excluded.title,
      transcript = excluded.transcript,
      url = excluded.url,
      call_date = excluded.call_date,
      duration = excluded.duration,
      direction = excluded.direction,
      primary_user_id = excluded.primary_user_id,
      system = excluded.system,
      scope = excluded.scope,
      media = excluded.media,
      language = excluded.language,
      workspace_id = excluded.workspace_id,
      sdr_disposition = excluded.sdr_disposition,
      client_unique_id = excluded.client_unique_id,
      purpose = excluded.purpose,
      is_private = excluded.is_private,
      calendar_event_id = excluded.calendar_event_id,
      custom_data = excluded.custom_data,
      speaker_ids = excluded.speaker_ids,
      speaker_count = excluded.speaker_count,
      scheduled = excluded.scheduled,
      meeting_url = excluded.meeting_url,
      speaker_1_id = excluded.speaker_1_id,
      speaker_2_id = excluded.speaker_2_id,
      speaker_3_id = excluded.speaker_3_id,
      speaker_4_id = excluded.speaker_4_id,
      speaker_5_id = excluded.speaker_5_id,
      speaker_6_id = excluded.speaker_6_id,
      speaker_7_id = excluded.speaker_7_id,
      speaker_8_id = excluded.speaker_8_id,
      speaker_9_id = excluded.speaker_9_id,
      speaker_10_id = excluded.speaker_10_id
  `;
}

async function upsertCallList(sql: postgres.Sql, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = [...CALL_LIST_COLS] as string[];
  await sql`
    INSERT INTO public.gong_call_list ${sql(rows as unknown as Record<string, unknown>[], ...cols)}
    ON CONFLICT (call_id) DO UPDATE SET
      title = excluded.title,
      transcript = excluded.transcript,
      url = excluded.url,
      call_date = excluded.call_date,
      duration = excluded.duration,
      direction = excluded.direction,
      primary_user_id = excluded.primary_user_id,
      system = excluded.system,
      scope = excluded.scope,
      media = excluded.media,
      language = excluded.language,
      workspace_id = excluded.workspace_id,
      sdr_disposition = excluded.sdr_disposition,
      client_unique_id = excluded.client_unique_id,
      purpose = excluded.purpose,
      is_private = excluded.is_private,
      calendar_event_id = excluded.calendar_event_id,
      custom_data = excluded.custom_data,
      speaker_count = excluded.speaker_count,
      scheduled = excluded.scheduled,
      meeting_url = excluded.meeting_url,
      speaker_1_id = excluded.speaker_1_id,
      speaker_2_id = excluded.speaker_2_id,
      speaker_3_id = excluded.speaker_3_id,
      speaker_4_id = excluded.speaker_4_id,
      speaker_5_id = excluded.speaker_5_id,
      speaker_6_id = excluded.speaker_6_id,
      speaker_7_id = excluded.speaker_7_id,
      speaker_8_id = excluded.speaker_8_id,
      speaker_9_id = excluded.speaker_9_id,
      speaker_10_id = excluded.speaker_10_id
  `;
}

interface SyncResult {
  fetched: number;
  with_transcript: number;
  upserted: number;
  window: string;
  hwm_before: string | null;
  hwm_after: string | null;
  elapsed_seconds: number;
}

async function runSync(env: Env): Promise<SyncResult> {
  const t0 = Date.now();
  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    const hwmRows = (await sql`
      SELECT to_char(max(call_date), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS hwm
      FROM public.gong_calls
    `) as Array<{ hwm: string | null }>;
    const hwmBefore = hwmRows[0]?.hwm ?? null;
    if (!hwmBefore) {
      throw new Error("could not read high-water mark from gong_calls (table empty?)");
    }
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const window = `${hwmBefore} -> ${now}`;
    console.log(`window: ${window}`);

    const calls = await fetchCallList(env, hwmBefore, now);
    console.log(`total calls fetched: ${calls.length}`);

    if (calls.length === 0) {
      return {
        fetched: 0,
        with_transcript: 0,
        upserted: 0,
        window,
        hwm_before: hwmBefore,
        hwm_after: hwmBefore,
        elapsed_seconds: (Date.now() - t0) / 1000,
      };
    }

    const callIds = calls.map((c) => String(c.id));
    const transcripts = await fetchTranscripts(env, callIds);
    console.log(`got transcripts for ${transcripts.size}/${callIds.length} calls`);

    const rows = calls.map((c) => buildRow(c, transcripts.get(String(c.id))));
    const withTranscript = rows.filter((r) => r.transcript).length;

    const BATCH = 25;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await upsertCalls(sql, batch);
      await upsertCallList(sql, batch);
      console.log(`  upserted batch ${i + batch.length}/${rows.length}`);
    }

    const hwmAfterRows = (await sql`
      SELECT to_char(max(call_date), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS hwm
      FROM public.gong_calls
    `) as Array<{ hwm: string | null }>;

    return {
      fetched: calls.length,
      with_transcript: withTranscript,
      upserted: rows.length,
      window,
      hwm_before: hwmBefore,
      hwm_after: hwmAfterRows[0]?.hwm ?? null,
      elapsed_seconds: (Date.now() - t0) / 1000,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`gong-fetcher scheduled run @ ${new Date().toISOString()}`);
    try {
      const r = await runSync(env);
      console.log(
        `DONE in ${r.elapsed_seconds.toFixed(1)}s fetched=${r.fetched} ` +
          `with_transcript=${r.with_transcript} upserted=${r.upserted} ` +
          `hwm ${r.hwm_before} -> ${r.hwm_after}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`FAILED: ${msg}`);
      throw err;
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        const r = await runSync(env);
        return Response.json({ ok: true, ...r });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "gong-fetcher",
        owner: "Hologram",
        contact: "kaushik@thekiln.com",
        schedule: "daily 12:00 UTC (07:00 EST / 08:00 EDT)",
        manual_trigger: "/run",
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
