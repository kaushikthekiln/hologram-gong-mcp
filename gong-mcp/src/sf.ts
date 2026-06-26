// Hologram Salesforce client + tool handlers.
// Auth: SOAP Login (username + password + security token).
// Future: swap to JWT Bearer flow when Hologram enables Connected App creation.

interface SfEnv {
  SF_USERNAME: string;
  SF_PASSWORD: string;
  SF_SECURITY_TOKEN: string;
  SF_LOGIN_URL: string;
  OAUTH_KV: KVNamespace;
}

interface SfSession {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number;
}

const SF_API_VERSION = "66.0";
const SESSION_CACHE_KEY = "sf:session";
const SESSION_TTL_SECONDS = 1800; // 30 min cache (sessions actually last 2hr but we refresh early)

// ====== SOAP LOGIN ======

let inFlightLogin: Promise<SfSession> | null = null;

async function performSoapLogin(env: SfEnv): Promise<SfSession> {
  const loginUrl = env.SF_LOGIN_URL || "https://login.salesforce.com";
  const password = `${env.SF_PASSWORD}${env.SF_SECURITY_TOKEN}`;

  const escapedUser = escapeXml(env.SF_USERNAME);
  const escapedPass = escapeXml(password);

  const body = `<?xml version="1.0" encoding="utf-8" ?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
              xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${escapedUser}</n1:username>
      <n1:password>${escapedPass}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;

  const r = await fetch(`${loginUrl}/services/Soap/u/50.0`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      "SOAPAction": "login",
    },
    body,
  });
  const text = await r.text();

  if (!r.ok || text.includes("<faultcode>")) {
    const fault = extractTag(text, "faultstring") || `HTTP ${r.status}`;
    throw new Error(`SF SOAP login failed: ${fault}`);
  }

  const sessionId = extractTag(text, "sessionId");
  const serverUrl = extractTag(text, "serverUrl");
  if (!sessionId || !serverUrl) {
    throw new Error("SF SOAP login response missing sessionId or serverUrl");
  }
  // serverUrl looks like https://teamhologram.my.salesforce.com/services/Soap/u/50.0/00Dxxxxxx
  // we want the host only as instanceUrl
  const instanceUrl = serverUrl.replace(/\/services\/.*$/, "");

  return {
    accessToken: sessionId,
    instanceUrl,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
}

export async function getSfSession(env: SfEnv): Promise<SfSession> {
  // Try cache
  try {
    const cached = await env.OAUTH_KV.get(SESSION_CACHE_KEY, "json") as SfSession | null;
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached;
    }
  } catch (_e) {
    // KV miss is fine, fall through to login
  }

  // Single-flight: if a refresh is already in progress in this isolate, wait for it
  if (inFlightLogin) return inFlightLogin;

  inFlightLogin = (async () => {
    try {
      const session = await performSoapLogin(env);
      try {
        await env.OAUTH_KV.put(SESSION_CACHE_KEY, JSON.stringify(session), {
          expirationTtl: SESSION_TTL_SECONDS,
        });
      } catch (_e) {
        // Caching failure isn't fatal
      }
      return session;
    } finally {
      inFlightLogin = null;
    }
  })();

  return inFlightLogin;
}

async function invalidateSession(env: SfEnv): Promise<void> {
  try {
    await env.OAUTH_KV.delete(SESSION_CACHE_KEY);
  } catch (_e) {
    // ignore
  }
}

// ====== SF REST CALLS ======

async function sfFetch(env: SfEnv, path: string, init?: RequestInit): Promise<Response> {
  let session = await getSfSession(env);
  let r = await fetch(`${session.instanceUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "Authorization": `Bearer ${session.accessToken}`,
      "Accept": "application/json",
    },
  });
  if (r.status === 401) {
    // Session expired or revoked, force re-login once
    await invalidateSession(env);
    session = await getSfSession(env);
    r = await fetch(`${session.instanceUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "Authorization": `Bearer ${session.accessToken}`,
        "Accept": "application/json",
      },
    });
  }
  return r;
}

async function soql(env: SfEnv, query: string): Promise<any> {
  const r = await sfFetch(env, `/services/data/v${SF_API_VERSION}/query?q=${encodeURIComponent(query)}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`SOQL ${r.status}: ${t.substring(0, 500)}`);
  }
  return r.json();
}

async function soqlAll(env: SfEnv, query: string): Promise<any[]> {
  const data = await soql(env, query);
  let records = data.records || [];
  let nextUrl = data.nextRecordsUrl;
  while (nextUrl) {
    const r = await sfFetch(env, nextUrl);
    if (!r.ok) break;
    const more = await r.json() as any;
    records = records.concat(more.records || []);
    nextUrl = more.nextRecordsUrl;
    if (records.length > 500) break; // safety
  }
  return records;
}

// ====== TOOL DEFINITIONS ======

export const SF_TOOLS = [
  {
    name: "get_sf_account",
    description:
      "Look up a company in Hologram's Salesforce by name (exact or fuzzy), website domain, or SF Account ID. Returns the matching Accounts with name, industry, type, billing city/country, employee count, annual revenue, owner, and key dates. Returns up to 5 matches with a match_confidence label so the LLM can pick the right one. Use this when the user asks about a specific company in Salesforce.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact or partial company name (e.g., 'Signify' or 'Signify Holdings')." },
        domain: { type: "string", description: "Company website domain (e.g., 'signify.com')." },
        id: { type: "string", description: "Salesforce Account ID (18-char, starts with 001)." },
      },
    },
  },
  {
    name: "list_sf_opportunities_for_account",
    description:
      "List the Salesforce Opportunities (deals) for one Account. Returns open opportunities plus closed-won/closed-lost within the last N days. Includes stage, amount, close date, probability, owner, type, lead source, and the contact roles (decision maker, influencer, etc.) for each deal. Default window 180 days. Use when the user asks about deals or pipeline for a specific company.",
    inputSchema: {
      type: "object",
      required: ["account_id"],
      properties: {
        account_id: { type: "string", description: "Salesforce Account ID (18-char, starts with 001). Get this from get_sf_account." },
        closed_days: { type: "integer", description: "Look back this many days for closed opportunities. Default 180.", default: 180, minimum: 7, maximum: 730 },
      },
    },
  },
  {
    name: "list_sf_activity_for_account",
    description:
      "List recently logged Salesforce activity (Tasks and Events) for one Account. Tasks include logged emails, calls, notes, follow-ups. Events include scheduled meetings. Default window is last 90 days. Use when the user asks 'what's been happening with X' or 'what touchpoints have we had'.",
    inputSchema: {
      type: "object",
      required: ["account_id"],
      properties: {
        account_id: { type: "string", description: "Salesforce Account ID. Get this from get_sf_account." },
        days: { type: "integer", description: "Look back this many days. Default 90.", default: 90, minimum: 7, maximum: 365 },
      },
    },
  },
  {
    name: "list_sf_contacts_for_account",
    description:
      "List the Contacts at a specific Salesforce Account. Returns each contact's name, title, email, phone, plus their role on any open Opportunities (e.g., Decision Maker, Economic Buyer, Influencer). Use when the user asks 'who do we know at X' or 'who are the decision makers'.",
    inputSchema: {
      type: "object",
      required: ["account_id"],
      properties: {
        account_id: { type: "string", description: "Salesforce Account ID. Get this from get_sf_account." },
      },
    },
  },
  {
    name: "get_call_with_sf_context",
    description:
      "Take a Gong call_id and return: the call's metadata + matching SF Account candidates + the open opportunities, recent activity, and contacts for the matched account(s). Uses the call title to match company name (e.g., 'Signify: Meet with...' → Signify). Returns multiple candidates with match confidence so the LLM can pick the right one. Use when the user asks 'what deal was that Gong call about' or 'show me the SF context for this call'.",
    inputSchema: {
      type: "object",
      required: ["call_id"],
      properties: {
        call_id: { type: "string", description: "The Gong call_id (from list_calls / search_calls)." },
      },
    },
  },
];

// ====== TOOL HANDLERS ======

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const ACCOUNT_FIELDS = [
  "Id", "Name", "Website", "Industry", "Type", "BillingCity", "BillingCountry",
  "Description", "NumberOfEmployees", "Phone",
  "Owner.Name", "CreatedDate", "LastModifiedDate",
].join(", ");

async function toolGetSfAccount(env: SfEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const domain = typeof args.domain === "string" ? args.domain.trim() : "";
  if (!id && !name && !domain) {
    return err("Provide at least one of: id, name, domain");
  }

  const candidates: Array<{ confidence: string; match_method: string; record: any }> = [];

  if (id) {
    const q = `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Id = '${escapeSoql(id)}' LIMIT 1`;
    const data = await soql(env, q);
    for (const r of data.records || []) candidates.push({ confidence: "exact", match_method: "id", record: r });
  }
  if (candidates.length === 0 && name) {
    const exactQ = `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Name = '${escapeSoql(name)}' LIMIT 5`;
    const exact = await soql(env, exactQ);
    for (const r of exact.records || []) candidates.push({ confidence: "exact-name", match_method: "name=", record: r });
    if (candidates.length === 0) {
      const fuzzyQ = `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Name LIKE '%${escapeSoql(name)}%' LIMIT 5`;
      const fuzzy = await soql(env, fuzzyQ);
      for (const r of fuzzy.records || []) candidates.push({ confidence: "fuzzy-name", match_method: "name LIKE", record: r });
    }
  }
  if (candidates.length === 0 && domain) {
    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const q = `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Website LIKE '%${escapeSoql(cleanDomain)}%' LIMIT 5`;
    const data = await soql(env, q);
    for (const r of data.records || []) candidates.push({ confidence: "domain-match", match_method: "Website LIKE", record: r });
  }

  return ok({ match_count: candidates.length, candidates });
}

async function toolListSfOpportunities(env: SfEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = typeof args.account_id === "string" ? args.account_id.trim() : "";
  if (!accountId) return err("account_id is required");
  const closedDays = Math.min(Math.max(Number(args.closed_days ?? 180), 7), 730);

  const oppQ = `
    SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, LeadSource,
           Description, Account.Name, Owner.Name, CreatedDate, LastModifiedDate
    FROM Opportunity
    WHERE AccountId = '${escapeSoql(accountId)}'
      AND (IsClosed = false OR CloseDate >= LAST_N_DAYS:${closedDays})
    ORDER BY CloseDate DESC NULLS LAST
    LIMIT 50
  `.trim();
  const opps = await soqlAll(env, oppQ);

  if (opps.length === 0) {
    return ok({ account_id: accountId, opportunity_count: 0, opportunities: [] });
  }

  const oppIds = opps.map((o: any) => o.Id);
  const ocrQ = `
    SELECT OpportunityId, ContactId, Contact.Name, Contact.Email, Contact.Title, Role, IsPrimary
    FROM OpportunityContactRole
    WHERE OpportunityId IN (${oppIds.map((i: string) => `'${escapeSoql(i)}'`).join(",")})
  `.trim();
  const roles = await soqlAll(env, ocrQ);

  const rolesByOpp: Record<string, any[]> = {};
  for (const r of roles) {
    const key = r.OpportunityId;
    if (!rolesByOpp[key]) rolesByOpp[key] = [];
    rolesByOpp[key].push(r);
  }

  const enriched = opps.map((o: any) => ({ ...o, contact_roles: rolesByOpp[o.Id] ?? [] }));
  return ok({ account_id: accountId, opportunity_count: enriched.length, closed_window_days: closedDays, opportunities: enriched });
}

async function toolListSfActivity(env: SfEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = typeof args.account_id === "string" ? args.account_id.trim() : "";
  if (!accountId) return err("account_id is required");
  const days = Math.min(Math.max(Number(args.days ?? 90), 7), 365);

  const taskQ = `
    SELECT Id, Subject, Status, Priority, ActivityDate, Description,
           Owner.Name, Who.Name, What.Name, CallType, CreatedDate, TaskSubtype
    FROM Task
    WHERE AccountId = '${escapeSoql(accountId)}'
      AND ActivityDate >= LAST_N_DAYS:${days}
    ORDER BY ActivityDate DESC NULLS LAST
    LIMIT 50
  `.trim();
  const eventQ = `
    SELECT Id, Subject, StartDateTime, EndDateTime, Description,
           Owner.Name, Who.Name, Location
    FROM Event
    WHERE AccountId = '${escapeSoql(accountId)}'
      AND StartDateTime >= LAST_N_DAYS:${days}
    ORDER BY StartDateTime DESC
    LIMIT 50
  `.trim();

  const [tasks, events] = await Promise.all([
    soqlAll(env, taskQ).catch((e) => ({ error: String(e) })),
    soqlAll(env, eventQ).catch((e) => ({ error: String(e) })),
  ]);

  return ok({ account_id: accountId, window_days: days, tasks, events });
}

async function toolListSfContacts(env: SfEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = typeof args.account_id === "string" ? args.account_id.trim() : "";
  if (!accountId) return err("account_id is required");

  const contactQ = `
    SELECT Id, Name, FirstName, LastName, Title, Email, Phone, MobilePhone,
           LeadSource, Department, CreatedDate, LastModifiedDate
    FROM Contact
    WHERE AccountId = '${escapeSoql(accountId)}'
    ORDER BY LastModifiedDate DESC
    LIMIT 100
  `.trim();
  const contacts = await soqlAll(env, contactQ);

  if (contacts.length === 0) {
    return ok({ account_id: accountId, contact_count: 0, contacts: [] });
  }

  const contactIds = contacts.map((c: any) => c.Id);
  const ocrQ = `
    SELECT ContactId, OpportunityId, Opportunity.Name, Opportunity.StageName,
           Opportunity.Amount, Opportunity.CloseDate, Role, IsPrimary
    FROM OpportunityContactRole
    WHERE ContactId IN (${contactIds.map((i: string) => `'${escapeSoql(i)}'`).join(",")})
      AND Opportunity.IsClosed = false
  `.trim();
  const roles = await soqlAll(env, ocrQ);

  const rolesByContact: Record<string, any[]> = {};
  for (const r of roles) {
    const key = r.ContactId;
    if (!rolesByContact[key]) rolesByContact[key] = [];
    rolesByContact[key].push(r);
  }

  const enriched = contacts.map((c: any) => ({ ...c, open_opp_roles: rolesByContact[c.Id] ?? [] }));
  return ok({ account_id: accountId, contact_count: enriched.length, contacts: enriched });
}

// Title pattern matchers, ordered most-specific first.
const TITLE_PATTERNS: Array<{ regex: RegExp; name: string }> = [
  { regex: /^\s*([^:]{2,80}?)\s*:/, name: "colon-prefix" },
  { regex: /^\s*([^|]{2,80}?)\s*\|/, name: "pipe-prefix" },
  { regex: /\bwith\s+([A-Z][A-Za-z0-9 &.\-]{1,60}?)(?:\s+from|\s+\-|\s*$)/, name: "with-prefix" },
  { regex: /^\s*([A-Z][A-Za-z0-9 &.\-]{1,60}?)\s+<>\s+/, name: "diamond-prefix" },
  { regex: /^\s*Call with\s+([A-Z][A-Za-z0-9 &.\-]{1,60}?)\s*\-/, name: "call-with" },
];

// Companies that are the SELLER side of the call (not customers).
// Filter these out of candidate extraction so we never falsely match the seller's own
// SF Account when the title contains "Meet with Hologram" or similar.
const BLOCKED_CANDIDATES = new Set([
  "hologram",
  "hologram.io",
  "the kiln",
  "thekiln",
  "thekiln.com",
  "kiln",
]);

function extractCompanyCandidates(title: string): Array<{ candidate: string; method: string }> {
  const out: Array<{ candidate: string; method: string }> = [];
  const seen = new Set<string>();
  for (const p of TITLE_PATTERNS) {
    const m = title.match(p.regex);
    if (m && m[1]) {
      const cleaned = m[1].trim().replace(/^(Re|Fwd):\s*/i, "");
      const lower = cleaned.toLowerCase();
      if (!cleaned || seen.has(lower)) continue;
      if (BLOCKED_CANDIDATES.has(lower)) continue; // seller's own company, not a customer
      seen.add(lower);
      out.push({ candidate: cleaned, method: p.name });
    }
  }
  return out;
}

export type PgSqlFn = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

async function toolGetCallWithSfContext(env: SfEnv, args: Record<string, unknown>, pgSql: PgSqlFn): Promise<ToolResult> {
  const callId = typeof args.call_id === "string" ? args.call_id.trim() : "";
  if (!callId) return err("call_id is required");

  const [callRow] = await pgSql`
    select call_id, title, call_date, duration, direction, primary_user_id, workspace_id,
           url, meeting_url, scheduled, substring(transcript, 1, 1500) as transcript_snippet
    from public.gong_calls
    where call_id = ${callId}
    limit 1
  `;
  if (!callRow) return err(`No call found with call_id=${callId}`);

  const title = String(callRow.title ?? "");
  const candidates = extractCompanyCandidates(title);

  const matches: Array<{ candidate_name: string; method: string; sf_accounts: any[] }> = [];
  for (const c of candidates.slice(0, 3)) {
    try {
      const q = `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Name LIKE '%${escapeSoql(c.candidate)}%' LIMIT 3`;
      const data = await soql(env, q);
      matches.push({ candidate_name: c.candidate, method: c.method, sf_accounts: data.records || [] });
    } catch (e) {
      matches.push({ candidate_name: c.candidate, method: c.method, sf_accounts: [] });
    }
  }

  const accountIds = new Set<string>();
  for (const m of matches) for (const a of m.sf_accounts) if (a.Id) accountIds.add(a.Id);

  const accountContext: Record<string, any> = {};
  for (const accountId of Array.from(accountIds).slice(0, 2)) {
    try {
      const [oppsR, actR] = await Promise.all([
        toolListSfOpportunities(env, { account_id: accountId, closed_days: 90 }),
        toolListSfActivity(env, { account_id: accountId, days: 60 }),
      ]);
      accountContext[accountId] = {
        opportunities: oppsR.isError ? { error: oppsR.content[0].text } : JSON.parse(oppsR.content[0].text),
        activity: actR.isError ? { error: actR.content[0].text } : JSON.parse(actR.content[0].text),
      };
    } catch (e) {
      accountContext[accountId] = { error: String(e) };
    }
  }

  return ok({
    call: callRow,
    title_match: {
      raw_title: title,
      candidate_companies: candidates,
      sf_matches: matches,
      total_unique_accounts: accountIds.size,
    },
    sf_context_by_account_id: accountContext,
  });
}

// ====== DISPATCH ======

export async function handleSfToolCall(
  name: string,
  args: Record<string, unknown>,
  env: SfEnv,
  pgSql: PgSqlFn
): Promise<ToolResult> {
  try {
    switch (name) {
      case "get_sf_account": return await toolGetSfAccount(env, args);
      case "list_sf_opportunities_for_account": return await toolListSfOpportunities(env, args);
      case "list_sf_activity_for_account": return await toolListSfActivity(env, args);
      case "list_sf_contacts_for_account": return await toolListSfContacts(env, args);
      case "get_call_with_sf_context": return await toolGetCallWithSfContext(env, args, pgSql);
      default: return err(`Unknown SF tool: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`SF tool error: ${msg}`);
  }
}

// ====== HELPERS ======

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSoql(s: string): string {
  // SOQL string literal escaping: backslash and single-quote
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}>([^<]*)</(?:[a-zA-Z0-9]+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}
