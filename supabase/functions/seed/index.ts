// The Seed service: the only thing the web app talks to.
//
// For every request it (1) checks who is signed in, (2) lets the database decide
// whether that person belongs to the team (or, for a guest, whether the team was opened), (3) returns the saved answer if there
// is one, and otherwise (4) asks the model once and saves the answer, where the
// first save wins. The browser never sees a key and never touches the database.
//
// Secrets this function needs (Supabase > Edge Functions > Secrets), one of:
//   GEMINI_API_KEY      a Google Gemini key (has a free tier), or
//   ANTHROPIC_API_KEY   an Anthropic key. If both are set, Anthropic is used.
// Optional:
//   SEED_MODEL          the exact model to call (defaults below)
//   SEED_MODEL_LABEL    the short name used in the seed's key. Default "haiku" with an Anthropic key,
//                       the same as the /seed command so both share saved answers, and "gemini"
//                       with a Gemini key, so answers from different model families never mix.

declare const Deno: any;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Row = { seed: string; question: string; model: string; answer: string; sha256: string; drawn_by: string; drawn_at: string };

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
// Tried in order until one answers. Which models a free key may use changes over time.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Problem extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handle(req: Request, env: Env, fetcher: Fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") throw new Problem(405, "use POST");
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

    const url = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
    const service = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? "";
    if (!url || !service) throw new Problem(500, "the service is missing its Supabase settings");

    // 1. Who is this? A real sign-in token has three dot-separated parts, and Supabase's own
    //    sign-in service confirms it, so the email cannot be made up. Anything else (no token,
    //    or the app's public key) is a guest, who may only use teams that were opened on purpose.
    let email: string | undefined;
    if (token.split(".").length === 3 && token !== req.headers.get("apikey")) {
      const who = await fetcher(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
      email = who.ok ? ((await who.json()) as { email?: string }).email?.toLowerCase() : undefined;
      if (!email) throw new Problem(401, "your sign-in has expired, sign in again");
    }

    // 2. Every database call goes through a function that checks access first:
    //    team membership for signed-in people, the team's "open" switch for guests.
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const r = await fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const data = await r.json().catch(() => null);
      if (r.ok) return data;
      const code = (data as { code?: string } | null)?.code;
      const message = (data as { message?: string } | null)?.message;
      if (code === "28000") throw new Problem(403, message ?? "not allowed");
      if (code === "22000") throw new Problem(400, message ?? "bad request");
      throw new Problem(500, "the store could not be reached");
    };

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const guestName = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "guest";
    const me = email ?? `guest: ${guestName}`;
    if (action === "me") {
      return email
        ? reply(200, { email, teams: await rpc("seed_svc_teams", { p_email: email }) })
        : reply(200, { email: null, guest: true, teams: await rpc("seed_open_teams", {}) });
    }

    const team = String(body.team ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(team)) throw new Problem(400, "choose a team");
    if (action === "list") {
      return reply(200, { rows: email ? await rpc("seed_svc_list", { p_team: team, p_email: email, p_limit: 50 }) : await rpc("seed_open_list", { p_team: team, p_limit: 50 }) });
    }
    if (action === "members" || action === "add_member") {
      if (!email) throw new Problem(403, "sign in to see or manage the people in a team");
      if (action === "members") return reply(200, { members: await rpc("seed_svc_members", { p_team: team, p_email: email }) });
      const added = String(body.email ?? "").trim().toLowerCase();
      return reply(200, { members: await rpc("seed_svc_add_member", { p_team: team, p_email: email, p_new_email: added }) });
    }
    if (action !== "ask") throw new Problem(400, "unknown action");

    const seed = String(body.seed ?? "").trim();
    const question = String(body.question ?? "").trim();
    if (!seed || seed.length > 40 || /\s/.test(seed)) throw new Problem(400, "give the seed a short name with no spaces");
    if (!question || question.length > 4000) throw new Problem(400, "type a question of up to 4,000 characters");

    const useGemini = !env.ANTHROPIC_API_KEY && !!env.GEMINI_API_KEY;
    const label = env.SEED_MODEL_LABEL || (useGemini ? "gemini" : "haiku");
    const key = await sha256(`${label}\n${seed}\n${question}`);
    const checked = async (row: Row, status: string) => {
      if ((await sha256(row.answer)) !== row.sha256) throw new Problem(409, "the saved answer does not match its fingerprint, so it is not shown");
      return reply(200, { status, row });
    };

    // 3. Already saved? Return it. The model is not asked.
    const saved = (email
      ? await rpc("seed_svc_get", { p_team: team, p_email: email, p_key: key })
      : await rpc("seed_open_get", { p_team: team, p_key: key, p_who: me })) as Row | null;
    if (saved) return await checked(saved, "replayed");

    // 4. Ask the model once, then save. If a teammate saved first, theirs is kept and returned.
    if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
      throw new Problem(500, "the service has no model key yet: add GEMINI_API_KEY or ANTHROPIC_API_KEY to its secrets");
    }
    let text = "", model = label, lastStatus = 0;
    if (useGemini) {
      // A busy model (503) is common on a free key, so every model is tried, twice over, before giving up.
      const list = env.SEED_MODEL ? [env.SEED_MODEL] : GEMINI_MODELS;
      for (const candidate of [...list, ...list]) {
        const g = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${candidate}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: question }] }] }),
        });
        lastStatus = g.status;
        const out = (await g.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
        text = g.ok ? (out?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim() : "";
        if (text) { model = candidate; break; }
        if (g.status === 400 || g.status === 401) break; // a bad request or bad key fails the same way on every model
      }
    } else {
      const m = await fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.SEED_MODEL || ANTHROPIC_MODEL, max_tokens: 1024, messages: [{ role: "user", content: question }] }),
      });
      lastStatus = m.status;
      const out = (await m.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
      text = m.ok ? (out?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim() : "";
    }
    if (!text) throw new Problem(502, `the model did not answer (status ${lastStatus}), so nothing was saved`);

    const mine = await sha256(text);
    const row = { p_team: team, p_key: key, p_seed: seed, p_question: question, p_model: model, p_answer: text, p_sha256: mine };
    const stored = (email
      ? await rpc("seed_svc_put", { ...row, p_email: email })
      : await rpc("seed_open_put", { ...row, p_who: me })) as Row;
    return await checked(stored, stored.sha256 === mine && stored.drawn_by === me ? "first" : "lost-race");
  } catch (e) {
    if (e instanceof Problem) return reply(e.status, { error: e.message });
    return reply(500, { error: "something went wrong and nothing was saved" });
  }
}

if (typeof Deno !== "undefined") Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch));
