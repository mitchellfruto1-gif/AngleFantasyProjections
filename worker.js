/* Patreon login for anglefantasybbprojections.com.
   Everything that is a file in the repo is served as-is by Cloudflare; only /api/patreon/* reaches this script.

   Settings (Cloudflare -> Workers -> anglefantasyprojections -> Settings -> Variables and Secrets):
     PATREON_CLIENT_SECRET  secret   from the Patreon client page (never in this repo)
     SESSION_SECRET         secret   any long random string; signs the 7-day login cookie
     ACCESS_CODE            secret   the site's access code, handed only to approved members
     ALLOWLIST              text     Patreon user IDs that always get in (owner, partners, comps), comma separated
   Who gets in: anyone on ALLOWLIST, or an active patron of this campaign entitled to MIN_CENTS or more ($3 All-Access).
   Saved settings: the D1 database bound as DB (wrangler.jsonc) keeps one row per member (their Patreon ID) with the
   settings the page syncs (saved leagues, custom scoring, watchlist, Matchup rosters). /api/patreon/session hands them
   back with the login; /api/patreon/prefs (PUT) saves them. */
const CLIENT_ID = "il8brDLuyB0fmm67C1J1Y_sM59spTpUcsmVSi7GXjA5c0XX8hic9CMEE5NgnKyvZ";
const MIN_CENTS = 300;
const DAYS = 7;
const SESSION = "angle_pt", STATE = "angle_pt_state";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/patreon/")) return env.ASSETS.fetch(req);
    try {
      switch (url.pathname) {
        case "/api/patreon/login": return login(url);
        case "/api/patreon/callback": return await callback(url, req, env);
        case "/api/patreon/session": return await session(req, env);
        case "/api/patreon/logout": return back(url, "/", [cookie(SESSION, "", 0)]);
        case "/api/patreon/status": return status(env);
        case "/api/patreon/prefs": return await prefs(req, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.log("patreon login error", e && e.stack || e);
      return back(url, "/?patreon=error");
    }
  }
};

// always the real domain, even when the request was forwarded from the old Vercel host or came in on workers.dev
const SITE = "https://anglefantasybbprojections.com";
const redirectUri = () => SITE + "/api/patreon/callback";

function login(url) {
  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  const to = new URL("https://www.patreon.com/oauth2/authorize");
  to.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri(url), scope: "identity", state });
  return back(url, to.href, [cookie(STATE, state, 600, "/api/patreon/")]);
}

async function callback(url, req, env) {
  const q = url.searchParams, jar = cookies(req);
  if (q.get("error")) return back(url, "/?patreon=cancel", [cookie(STATE, "", 0, "/api/patreon/")]);
  if (!q.get("code") || !q.get("state") || q.get("state") !== jar[STATE]) return back(url, "/?patreon=error");

  const tok = await fetch("https://www.patreon.com/api/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code"), client_id: CLIENT_ID, client_secret: env.PATREON_CLIENT_SECRET, redirect_uri: redirectUri(url) })
  }).then(r => r.json());
  if (!tok.access_token) throw new Error("token exchange failed: " + JSON.stringify(tok).slice(0, 200));

  // With only the identity scope, Patreon lists just this campaign's membership (if any)
  const me = await fetch("https://www.patreon.com/api/oauth2/v2/identity?" + new URLSearchParams({
    include: "memberships,memberships.currently_entitled_tiers",
    "fields[user]": "first_name,full_name",
    "fields[member]": "patron_status,currently_entitled_amount_cents",
    "fields[tier]": "title,amount_cents"
  }), { headers: { Authorization: "Bearer " + tok.access_token, "User-Agent": "AngleFantasyProjections" } }).then(r => r.json());
  if (!me.data || !me.data.id) throw new Error("identity failed: " + JSON.stringify(me).slice(0, 200));

  const uid = String(me.data.id), name = (me.data.attributes.first_name || me.data.attributes.full_name || "").slice(0, 40);
  const verdict = decide(uid, me, env);
  const clear = cookie(STATE, "", 0, "/api/patreon/");
  if (!verdict) return back(url, "/?" + new URLSearchParams({ patreon: "nope", pid: uid, pn: name }), [clear, cookie(SESSION, "", 0)]);
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  const token = await sign(env, { u: uid, n: name, k: verdict, e: exp });
  return back(url, "/?patreon=ok", [clear, cookie(SESSION, token, DAYS * 86400)]);
}

function decide(uid, me, env) {
  const allow = String(env.ALLOWLIST || "").split(/[\s,]+/).filter(Boolean);
  if (allow.includes(uid)) return "allow";
  const inc = me.included || [];
  const tiers = new Map(inc.filter(x => x.type === "tier").map(t => [t.id, t.attributes || {}]));
  for (const m of inc.filter(x => x.type === "member")) {
    const a = m.attributes || {};
    if (a.patron_status !== "active_patron") continue;
    const tierCents = ((m.relationships && m.relationships.currently_entitled_tiers && m.relationships.currently_entitled_tiers.data) || [])
      .map(t => (tiers.get(t.id) || {}).amount_cents || 0);
    if (Math.max(a.currently_entitled_amount_cents || 0, ...tierCents) >= MIN_CENTS) return "patron";
  }
  return null;
}

async function session(req, env) {
  const s = await verify(env, cookies(req)[SESSION]);
  if (!s) return json({ ok: false });
  const body = { ok: true, uid: s.u, name: s.n, kind: s.k, code: env.ACCESS_CODE };
  // saved settings ride along with the login (null = none saved yet); left out if the database isn't set up or fails,
  // so a storage problem never blocks a login
  if (env.DB) try { body.prefs = await prefsGet(env, s.u); } catch (e) { console.log("prefs read failed", e && e.message); }
  return json(body);
}

/* ---------- saved settings (D1) ---------- */
const PREFS_MAX = 65536;   // bytes per member; leagues, scoring, watchlist and rosters are a few KB
async function dbReady(env) {
  if (!dbReady.done) { await env.DB.prepare("CREATE TABLE IF NOT EXISTS prefs (uid TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)").run(); dbReady.done = true; }
}
async function prefsGet(env, uid) {
  await dbReady(env);
  const r = await env.DB.prepare("SELECT data, updated FROM prefs WHERE uid = ?").bind(uid).first();
  return r ? { data: JSON.parse(r.data), updated: r.updated } : null;
}
async function prefs(req, env) {
  const s = await verify(env, cookies(req)[SESSION]);
  if (!s) return json({ ok: false, error: "not logged in" }, 401);
  if (!env.DB) return json({ ok: false, error: "saved settings aren't set up" }, 503);
  try {
    if (req.method === "GET") return json({ ok: true, prefs: await prefsGet(env, s.u) });
    if (req.method !== "PUT") return json({ ok: false, error: "use GET or PUT" }, 405);
    // JSON only: a cross-site form can't send it, and a cross-site fetch can't without CORS, which this never grants
    if (!/^application\/json/i.test(req.headers.get("Content-Type") || "")) return json({ ok: false, error: "send JSON" }, 415);
    const text = await req.text();
    if (text.length > PREFS_MAX) return json({ ok: false, error: "too big" }, 413);
    let b; try { b = JSON.parse(text); } catch (e) { return json({ ok: false, error: "bad JSON" }, 400); }
    if (!b || !b.data || typeof b.data !== "object" || Array.isArray(b.data) || !Number.isFinite(b.updated)) return json({ ok: false, error: "expected { data, updated }" }, 400);
    const data = {}; for (const k in b.data) if (/^angle-[a-z-]{1,40}$/.test(k) && typeof b.data[k] === "string") data[k] = b.data[k];
    const updated = Math.min(Math.floor(b.updated), Date.now() + 60000);
    await dbReady(env);
    // newest change wins: an older save (a device that was offline) never overwrites a newer one
    await env.DB.prepare("INSERT INTO prefs (uid, data, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated = excluded.updated WHERE excluded.updated >= prefs.updated")
      .bind(s.u, JSON.stringify(data), updated).run();
    return json({ ok: true, saved: updated });
  } catch (e) {
    console.log("prefs error", e && e.stack || e);
    return json({ ok: false, error: "storage error" }, 500);
  }
}

// setup check: says which settings the live site can see (never their values)
function status(env) {
  return json({ PATREON_CLIENT_SECRET: !!env.PATREON_CLIENT_SECRET, SESSION_SECRET: !!env.SESSION_SECRET, ACCESS_CODE: !!env.ACCESS_CODE,
    ALLOWLIST_ids: String(env.ALLOWLIST || "").split(/[\s,]+/).filter(Boolean).length, DB: !!env.DB });
}

/* ---------- helpers ---------- */
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
function back(url, to, setCookies = []) {
  const h = new Headers({ Location: new URL(to, SITE).href, "Cache-Control": "no-store" });
  setCookies.forEach(c => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
}
const cookie = (k, v, maxAge, path = "/") => `${k}=${v}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
function cookies(req) {
  const out = {};
  (req.headers.get("Cookie") || "").split(/;\s*/).forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); });
  return out;
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const hmacKey = env => crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function sign(env, obj) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  const body = b64u(new TextEncoder().encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body)));
  return body + "." + b64u(sig);
}
async function verify(env, token) {
  if (!token || !env.SESSION_SECRET || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
  const [body, sig] = token.split(".");
  try {
    if (!await crypto.subtle.verify("HMAC", await hmacKey(env), unb64u(sig), new TextEncoder().encode(body))) return null;
    const s = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return s.e > Date.now() / 1000 ? s : null;
  } catch (e) { return null; }
}
