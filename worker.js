/* Patreon login for anglefantasybbprojections.com.
   Everything that is a file in the repo is served as-is by Cloudflare; only /api/patreon/* reaches this script.

   Settings (Cloudflare -> Workers -> anglefantasyprojections -> Settings -> Variables and Secrets):
     PATREON_CLIENT_SECRET  secret   from the Patreon client page (never in this repo)
     SESSION_SECRET         secret   any long random string; signs the 7-day login cookie
     ACCESS_CODE            secret   the site's access code, handed only to approved members
     ALLOWLIST              text     Patreon user IDs that always get in (owner, partners, comps), comma separated
   Who gets in: anyone on ALLOWLIST, or an active patron of this campaign entitled to MIN_CENTS or more ($3 All-Access). */
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
  const body = s ? { ok: true, name: s.n, kind: s.k, code: env.ACCESS_CODE } : { ok: false };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// setup check: says which settings the live site can see (never their values)
function status(env) {
  const body = { PATREON_CLIENT_SECRET: !!env.PATREON_CLIENT_SECRET, SESSION_SECRET: !!env.SESSION_SECRET, ACCESS_CODE: !!env.ACCESS_CODE,
    ALLOWLIST_ids: String(env.ALLOWLIST || "").split(/[\s,]+/).filter(Boolean).length };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/* ---------- helpers ---------- */
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
