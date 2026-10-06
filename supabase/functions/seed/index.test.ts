// Run with:  node --experimental-strip-types --test supabase/functions/seed/index.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { handle } from "./index.ts";

const ENV = { SUPABASE_URL: "https://proj.example", SUPABASE_SERVICE_ROLE_KEY: "SERVICE-KEY", ANTHROPIC_API_KEY: "MODEL-KEY" };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A stand-in for Supabase and the model, with the same rules as supabase/app.sql. */
function world(opts: { modelFails?: boolean; beforePut?: (w: any, a: any) => void } = {}) {
  const w: any = {
    users: { "tok-asha": "asha@example.com", "tok-bob": "bob@example.com", "tok-eve": "eve@example.com" },
    members: { pricing: { "asha@example.com": "admin", "bob@example.com": "member" } },
    rows: new Map<string, any>(), draws: 0, calls: [] as { url: string; headers: Record<string, string>; body: any }[],
  };
  const role = (team: string, email: string) => w.members[team]?.[email];
  const notMember = () => json(403, { code: "28000", message: "you are not a member of this team" });
  w.fetch = async (url: string, init: any = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    w.calls.push({ url, headers, body });
    if (url === "https://proj.example/auth/v1/user") {
      const email = w.users[(headers.authorization ?? "").replace("Bearer ", "")];
      return email ? json(200, { email }) : json(401, { msg: "invalid JWT" });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      if (opts.modelFails) return json(529, { error: { message: "overloaded" } });
      return json(200, { content: [{ type: "text", text: `draw ${++w.draws}` }] });
    }
    const rpc = /^https:\/\/proj\.example\/rest\/v1\/rpc\/(\w+)$/.exec(url)?.[1];
    if (!rpc || headers.apikey !== "SERVICE-KEY") return json(401, { message: "bad key" });
    const a = body;
    if (rpc === "seed_svc_teams") return json(200, Object.entries(w.members).filter(([, m]: any) => m[a.p_email]).map(([team, m]: any) => ({ team, role: m[a.p_email] })));
    if (!role(a.p_team, a.p_email)) return notMember();
    const id = `${a.p_team}/${a.p_key}`;
    if (rpc === "seed_svc_get") return json(200, w.rows.get(id) ?? null);
    if (rpc === "seed_svc_put") {
      opts.beforePut?.(w, a);
      if (!w.rows.has(id)) w.rows.set(id, { seed: a.p_seed, question: a.p_question, model: a.p_model, answer: a.p_answer, sha256: a.p_sha256, drawn_by: a.p_email, drawn_at: "2026-10-06T10:00:00Z" });
      return json(200, w.rows.get(id));
    }
    if (rpc === "seed_svc_list") return json(200, [...w.rows.values()]);
    if (rpc === "seed_svc_members") return json(200, Object.entries(w.members[a.p_team]).map(([email, r]) => ({ email, role: r })));
    if (rpc === "seed_svc_add_member") {
      if (role(a.p_team, a.p_email) !== "admin") return json(403, { code: "28000", message: "only a team admin can add people" });
      w.members[a.p_team][a.p_new_email] = "member";
      return json(200, Object.entries(w.members[a.p_team]).map(([email, r]) => ({ email, role: r })));
    }
    return json(404, { message: "no such function" });
  };
  return w;
}

const call = async (w: any, token: string | null, body: unknown, method = "POST") => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await handle(new Request("https://proj.example/functions/v1/seed", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), ENV, w.fetch);
  return { status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json() };
};
const ASK = { action: "ask", team: "pricing", seed: "42", question: "What is X?" };

test("the first ask draws once and a teammate's ask replays it", async () => {
  const w = world();
  const first = await call(w, "tok-asha", ASK);
  const second = await call(w, "tok-bob", ASK);
  assert.deepEqual([first.status, first.body.status, first.body.row.answer], [200, "first", "draw 1"]);
  assert.deepEqual([second.status, second.body.status, second.body.row.answer, second.body.row.drawn_by], [200, "replayed", "draw 1", "asha@example.com"]);
  assert.equal(w.draws, 1);
});

test("the saved row carries the signed-in email, the fingerprint and the same key the /seed command uses", async () => {
  const w = world();
  await call(w, "tok-asha", ASK);
  const put = w.calls.find((c: any) => c.url.endsWith("/seed_svc_put"))!.body;
  assert.equal(put.p_email, "asha@example.com");
  assert.equal(put.p_sha256, sha("draw 1"));
  assert.equal(put.p_key, sha("haiku\n42\nWhat is X?"));
  assert.equal(put.p_model, "haiku");
});

test("the model is called with the model key and only the question", async () => {
  const w = world();
  await call(w, "tok-asha", ASK);
  const m = w.calls.find((c: any) => c.url.includes("anthropic"))!;
  assert.equal(m.headers["x-api-key"], "MODEL-KEY");
  assert.deepEqual(m.body.messages, [{ role: "user", content: "What is X?" }]);
});

test("if a teammate saves first, their answer is returned", async () => {
  const w = world({ beforePut: (w, a) => w.rows.set(`${a.p_team}/${a.p_key}`, { seed: "42", question: "What is X?", model: "haiku", answer: "theirs", sha256: sha("theirs"), drawn_by: "bob@example.com", drawn_at: "t" }) });
  const out = await call(w, "tok-asha", ASK);
  assert.deepEqual([out.body.status, out.body.row.answer, out.body.row.drawn_by], ["lost-race", "theirs", "bob@example.com"]);
});

test("no sign-in is refused before anything else happens", async () => {
  const w = world();
  const out = await call(w, null, ASK);
  assert.equal(out.status, 401);
  assert.equal(w.calls.length, 0);
});

test("an invalid sign-in is refused", async () => {
  const w = world();
  assert.equal((await call(w, "tok-nobody", ASK)).status, 401);
  assert.equal(w.draws, 0);
});

test("someone outside the team is refused and the model is not asked", async () => {
  const w = world();
  const out = await call(w, "tok-eve", ASK);
  assert.deepEqual([out.status, out.body.error], [403, "you are not a member of this team"]);
  assert.equal(w.draws, 0);
});

test("a model failure saves nothing", async () => {
  const w = world({ modelFails: true });
  const out = await call(w, "tok-asha", ASK);
  assert.equal(out.status, 502);
  assert.equal(w.rows.size, 0);
});

test("a stored answer that does not match its fingerprint is not returned", async () => {
  const w = world();
  await call(w, "tok-asha", ASK);
  const [id, row] = [...w.rows.entries()][0];
  w.rows.set(id, { ...row, answer: "forged" });
  const out = await call(w, "tok-bob", ASK);
  assert.equal(out.status, 409);
  assert.equal(JSON.stringify(out.body).includes("forged"), false);
});

test("bad input is refused", async () => {
  const w = world();
  for (const bad of [{ ...ASK, seed: "has space" }, { ...ASK, seed: "" }, { ...ASK, question: "  " }, { ...ASK, team: "Bad Team" }, { action: "nope" }]) {
    assert.equal((await call(w, "tok-asha", bad)).status, 400);
  }
  assert.equal(w.draws, 0);
});

test("me lists my teams, list shows saved answers, an admin can add a person and a member cannot", async () => {
  const w = world();
  assert.deepEqual((await call(w, "tok-asha", { action: "me" })).body, { email: "asha@example.com", teams: [{ team: "pricing", role: "admin" }] });
  await call(w, "tok-asha", ASK);
  assert.equal((await call(w, "tok-bob", { action: "list", team: "pricing" })).body.rows.length, 1);
  assert.equal((await call(w, "tok-bob", { action: "add_member", team: "pricing", email: "carol@example.com" })).status, 403);
  const added = await call(w, "tok-asha", { action: "add_member", team: "pricing", email: "Carol@Example.com" });
  assert.equal(added.body.members.some((m: any) => m.email === "carol@example.com"), true);
});

test("browsers are allowed to call it from another site, and no key appears in any reply", async () => {
  const w = world({ modelFails: true });
  const pre = await call(w, null, null, "OPTIONS");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const out = await call(w, "tok-asha", ASK);
  assert.equal(out.headers.get("access-control-allow-origin"), "*");
  assert.equal(/SERVICE-KEY|MODEL-KEY/.test(JSON.stringify(out.body)), false);
});

test("a missing model key is reported clearly and nothing is drawn", async () => {
  const w = world();
  const r = await handle(new Request("https://proj.example/functions/v1/seed", { method: "POST", headers: { Authorization: "Bearer tok-asha" }, body: JSON.stringify(ASK) }), { ...ENV, ANTHROPIC_API_KEY: "" }, w.fetch);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
});
