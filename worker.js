/* Patreon login for anglefantasybbprojections.com.
   Everything that is a file in the repo is served as-is by Cloudflare; only paths that aren't files reach this script:
   /api/patreon/* (below) and the tab addresses (/points, /market, ...: TAB_PAGES).

   Settings (Cloudflare -> Workers -> anglefantasyprojections -> Settings -> Variables and Secrets):
     PATREON_CLIENT_SECRET  secret   from the Patreon client page (never in this repo)
     SESSION_SECRET         secret   any long random string; signs the 7-day login cookie
     ACCESS_CODE            secret   the site's access code, handed only to approved members
     ALLOWLIST              text     Patreon user IDs that always get in (owner, partners, comps), comma separated
     BETA_TESTERS           text     Patreon user IDs that get the beta features (My League) automatically on every device, comma separated; ALLOWLIST ids get them too
   Who gets in: anyone on ALLOWLIST, or an active patron of this campaign entitled to MIN_CENTS or more ($3 All-Access).
   Saved settings: the D1 database bound as DB (wrangler.jsonc) keeps one row per member (their Patreon ID) with the
   settings the page syncs (saved leagues, custom scoring, watchlist, Matchup rosters). /api/patreon/session hands them
   back with the login; /api/patreon/prefs (PUT) saves them. */
import { yahooLoginUrl, yahooExchange, yahooLeagues, yahooLeague, yahooConnected, yahooDisconnect } from "./yahoo.js";
const CLIENT_ID = "il8brDLuyB0fmm67C1J1Y_sM59spTpUcsmVSi7GXjA5c0XX8hic9CMEE5NgnKyvZ";
const MIN_CENTS = 300;
/* Login length: the cookie lasts DAYS and is renewed by use (session() below), but never past MAX_DAYS after the Patreon
   login, so someone who stops paying loses access within MAX_DAYS even if they keep visiting. */
const DAYS = 30, MAX_DAYS = 90;
const SESSION = "angle_pt", STATE = "angle_pt_state";

/* Each tab has its own address. They aren't files, so they reach this script: it serves the same page (index.html) with
   that tab's title, description, official (canonical) address and link-preview text, so search engines and shared links
   see the right tab; the page opens that tab itself. A trailing slash (/market/) redirects to /market. */
const TAB_PAGES = {
  "/points": { title: "Points League Rankings 2026-27 · Angle Fantasy Basketball", desc: "Fantasy basketball points-league rankings for 2026-27 with Yahoo, ESPN or your own scoring, updated every week from real games." },
  "/market": { title: "Angle Market: Fantasy Basketball Player Prices · Angle Fantasy Basketball", desc: "Every NBA player priced like a stock by his fantasy value per game. Find buy-low and sell-high targets and keep a watchlist." },
  "/matchup": { title: "Fantasy Basketball Matchup Projector · Angle Fantasy Basketball", desc: "Project a head-to-head fantasy basketball week: both rosters, every category or fantasy points, from that week's games and injuries." },
  "/box-scores": { title: "Live Fantasy Basketball Box Scores · Angle Fantasy Basketball", desc: "Live NBA box scores with fantasy points for every player, updated every 30 seconds, plus play-by-play and past nights." },
  "/schedule": { title: "NBA Schedule for Fantasy Basketball 2026-27 · Angle Fantasy Basketball", desc: "Every NBA team's schedule by fantasy week: games in your fantasy playoffs, low-volume nights for streaming, and back-to-backs." },
  "/my-league": { title: "My League (beta) · Angle Fantasy Basketball", desc: "Your Fantrax, Sleeper, ESPN or Yahoo league with Angle's projections: standings, matchups, trades and team values.", noindex: true }
};
async function tabPage(req, env, url) {
  const t = TAB_PAGES[url.pathname], home = await env.ASSETS.fetch(new Request(new URL("/", url), req));
  if (!home.ok) return home;
  const href = SITE + url.pathname, attr = (name, value) => ({ element: el => el.setAttribute(name, value) });
  const page = new HTMLRewriter()
    .on("title", { element: el => el.setInnerContent(t.title) })
    .on('meta[name="description"]', attr("content", t.desc))
    .on('link[rel="canonical"]', attr("href", href))
    .on('meta[property="og:url"]', attr("content", href))
    .on('meta[property="og:title"]', attr("content", t.title))
    .on('meta[name="twitter:title"]', attr("content", t.title))
    .on('meta[property="og:description"]', attr("content", t.desc))
    .on('meta[name="twitter:description"]', attr("content", t.desc))
    .on("head", { element: el => { if (t.noindex) el.append('<meta name="robots" content="noindex">', { html: true }); } })
    .transform(home);
  const headers = new Headers(page.headers); headers.set("content-type", "text/html; charset=utf-8");
  return new Response(page.body, { status: 200, headers });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      const bare = url.pathname.replace(/\/+$/, "");
      if (bare !== url.pathname && TAB_PAGES[bare]) return Response.redirect(SITE + bare + url.search, 301);
      if (TAB_PAGES[url.pathname]) return await tabPage(req, env, url);
    }
    if (url.pathname.startsWith("/api/yahoo/")) return await yahooRoute(url, req, env);
    if (url.pathname.startsWith("/api/espn/")) return await espnRoute(url, req, env);
    if (!url.pathname.startsWith("/api/patreon/")) return env.ASSETS.fetch(req);
    try {
      switch (url.pathname) {
        case "/api/patreon/login": return login(url);
        case "/api/patreon/callback": return await callback(url, req, env);
        case "/api/patreon/session": return await session(req, env);
        case "/api/patreon/link/start": return await linkStart(env);
        case "/api/patreon/link/poll": return await linkPoll(url, env);
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
  const link = /^[0-9a-f]{32}$/.test(url.searchParams.get("link") || "") ? url.searchParams.get("link") : "";   // set when the app (home-screen icon) started this login
  return back(url, to.href, [cookie(STATE, state, 600, "/api/patreon/"), ...(link ? [cookie(LINK, link, 600, "/api/patreon/")] : [])]);
}

/* A home-screen app (iPhone "Add to Home Screen") keeps its own cookies, separate from Safari, and a login that happens in
   Safari never reaches it. So the app asks for a one-time link code (linkStart), opens the normal login with ?link=CODE in
   Safari, and polls (linkPoll). When that login finishes, the callback files the new session under the code, and the
   next poll hands it to the app, which sets it as its own cookie. The code is random, expires in 15 minutes and works once. */
const LINK = "angle_pt_link", LINK_MIN = 15;
async function linkReady(env) {
  if (!linkReady.done) { await env.DB.prepare("CREATE TABLE IF NOT EXISTS plink (code TEXT PRIMARY KEY, token TEXT, exp INTEGER NOT NULL)").run(); linkReady.done = true; }
  await env.DB.prepare("DELETE FROM plink WHERE exp < ?").bind(Date.now()).run();
}
async function linkStart(env) {
  if (!env.DB) return json({ ok: false, error: "not set up" }, 503);
  await linkReady(env);
  const code = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("INSERT INTO plink (code, token, exp) VALUES (?, NULL, ?)").bind(code, Date.now() + LINK_MIN * 60000).run();
  return json({ ok: true, code, minutes: LINK_MIN });
}
async function linkPoll(url, env) {
  const code = url.searchParams.get("code") || "";
  if (!env.DB || !/^[0-9a-f]{32}$/.test(code)) return json({ ok: false, gone: true });
  await linkReady(env);
  const row = await env.DB.prepare("SELECT token FROM plink WHERE code = ?").bind(code).first();
  if (!row) return json({ ok: false, gone: true });
  if (!row.token) return json({ ok: true, pending: true });
  await env.DB.prepare("DELETE FROM plink WHERE code = ?").bind(code).run();
  const res = json({ ok: true, done: true });
  res.headers.append("Set-Cookie", cookie(SESSION, row.token, DAYS * 86400));
  return res;
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
  const now = Math.floor(Date.now() / 1000), exp = now + DAYS * 86400;
  const token = await sign(env, { u: uid, n: name, k: verdict, i: now, e: exp });
  // started from the home-screen app: file the session under its link code (the app picks it up), and tell this browser to go back
  const lk = jar[LINK];
  if (/^[0-9a-f]{32}$/.test(lk || "") && env.DB) {
    await linkReady(env);
    const r = await env.DB.prepare("UPDATE plink SET token = ? WHERE code = ? AND token IS NULL").bind(token, lk).run();
    if (r.meta && r.meta.changes) return back(url, "/?patreon=linked", [clear, cookie(LINK, "", 0, "/api/patreon/"), cookie(SESSION, token, DAYS * 86400)]);
  }
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
  const body = { ok: true, uid: s.u, name: s.n, kind: s.k, code: env.ACCESS_CODE, beta: betaFor(env, s.u) };
  // saved settings ride along with the login (null = none saved yet); left out if the database isn't set up or fails,
  // so a storage problem never blocks a login
  if (env.DB) try { body.prefs = await prefsGet(env, s.u); } catch (e) { console.log("prefs read failed", e && e.message); }
  const res = json(body);
  // sliding login: once half of the window is used, renew it (to DAYS from now, but never past MAX_DAYS after the Patreon login)
  const now = Math.floor(Date.now() / 1000), issued = s.i || s.e - 7 * 86400, cap = issued + MAX_DAYS * 86400, e = Math.min(now + DAYS * 86400, cap);
  if (s.e - now < DAYS * 43200 && e > s.e + 3600) res.headers.append("Set-Cookie", cookie(SESSION, await sign(env, { u: s.u, n: s.n, k: s.k, i: issued, e }), e - now));
  return res;
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

/* ---------- Yahoo Fantasy (yahoo.js): members connect their Yahoo account; the page reads their leagues through here ---------- */
const YSTATE = "angle_yh_state", yRedirect = () => SITE + "/api/yahoo/callback";
async function yahooRoute(url, req, env) {
  const s = await verify(env, cookies(req)[SESSION]);
  if (!s) return url.pathname === "/api/yahoo/login" ? back(url, "/my-league?beta=league,yahoo&yahoo=login") : json({ ok: false, error: "Log in with Patreon first." }, 401);
  if (!env.DB || !env.YAHOO_CLIENT_SECRET) return url.pathname === "/api/yahoo/login" ? back(url, "/my-league?beta=league,yahoo&yahoo=error") : json({ ok: false, error: "Yahoo isn't set up yet." }, 503);
  const clear = cookie(YSTATE, "", 0, "/api/yahoo/");
  try {
    switch (url.pathname) {
      case "/api/yahoo/login": { const state = hex(crypto.getRandomValues(new Uint8Array(16))); return back(url, yahooLoginUrl(yRedirect(), state), [cookie(YSTATE, state, 600, "/api/yahoo/")]); }
      case "/api/yahoo/callback": {
        const q = url.searchParams;
        if (q.get("error")) return back(url, "/my-league?beta=league,yahoo&yahoo=cancel", [clear]);
        if (!q.get("code") || !q.get("state") || q.get("state") !== cookies(req)[YSTATE]) return back(url, "/my-league?beta=league,yahoo&yahoo=error", [clear]);
        await yahooExchange(env, s.u, q.get("code"), yRedirect()); return back(url, "/my-league?beta=league,yahoo&yahoo=ok", [clear]);
      }
      case "/api/yahoo/status": return json({ ok: true, connected: await yahooConnected(env, s.u) });
      case "/api/yahoo/leagues": return json({ ok: true, leagues: await yahooLeagues(env, s.u) });
      case "/api/yahoo/league": return json({ ok: true, league: await yahooLeague(env, s.u, url.searchParams.get("key") || "") });
      case "/api/yahoo/disconnect":
        if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);
        await yahooDisconnect(env, s.u); return json({ ok: true });
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    console.log("yahoo error", e && e.stack || e);
    if (url.pathname === "/api/yahoo/callback") return back(url, "/my-league?beta=league,yahoo&yahoo=error", [clear]);
    return json({ ok: false, error: e.code === 401 ? "Yahoo needs to be connected again." : (e.message || "Yahoo error"), reconnect: e.code === 401 }, e.code || 500);
  }
}

/* ---------- ESPN private leagues ----------
   Public ESPN leagues never come here: the page reads them from ESPN directly. For a private league the page sends the
   member's own ESPN login cookies (espn_s2 and SWID, which they pasted and which stay in their browser) with the league
   number; this passes them to ESPN for that one read-only request and returns ESPN's answer. Nothing is stored or
   logged. Logged-in Patreon members only, so this isn't an open relay. */
const ESPN_LG = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/";
const ESPN_VIEWS = "view=mTeam&view=mRoster&view=mSettings&view=mMatchupScore&view=mStatus";
async function espnRoute(url, req, env) {
  if (url.pathname !== "/api/espn/league") return json({ ok: false, error: "not found" }, 404);
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);
  if (!await verify(env, cookies(req)[SESSION])) return json({ ok: false, error: "Log in with Patreon first." }, 401);
  let b = null; try { b = await req.json(); } catch (e) {}
  const id = String((b && b.id) || ""), season = String((b && b.season) || ""), s2 = String((b && b.s2) || "").trim();
  const sw = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i.exec(String((b && b.swid) || "").trim());
  if (!/^\d{3,11}$/.test(id) || !/^20\d\d$/.test(season)) return json({ ok: false, error: "That isn't an ESPN league ID." }, 400);
  if (!/^[A-Za-z0-9%+/=_.-]{40,2000}$/.test(s2) || !sw) return json({ ok: false, error: "Your saved ESPN login doesn't look right. Forget it on My Leagues and paste espn_s2 and SWID again." }, 400);
  let r;
  try { r = await fetch(`${ESPN_LG}${season}/segments/0/leagues/${id}?${ESPN_VIEWS}`, { headers: { Cookie: `espn_s2=${s2}; SWID={${sw[1].toUpperCase()}}`, Accept: "application/json" } }); }
  catch (e) { return json({ ok: false, error: "Couldn't reach ESPN. Try again in a minute." }, 502); }
  if (r.status === 401 || r.status === 403) return json({ ok: false, error: "ESPN didn't accept your saved login for this league. Make sure your ESPN account is in the league, then forget the login on My Leagues and paste espn_s2 and SWID again (they change when you log out of ESPN)." }, 401);
  if (r.status === 404) return json({ ok: false, error: "ESPN couldn't find that league this season. Check the number in your league's address (leagueId=…)." }, 404);
  if (!r.ok) return json({ ok: false, error: `ESPN didn't answer (error ${r.status}). Try again in a minute.` }, 502);
  return new Response(r.body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// setup check: says which settings the live site can see (never their values)
function status(env) {
  return json({ PATREON_CLIENT_SECRET: !!env.PATREON_CLIENT_SECRET, SESSION_SECRET: !!env.SESSION_SECRET, ACCESS_CODE: !!env.ACCESS_CODE, YAHOO_CLIENT_SECRET: !!env.YAHOO_CLIENT_SECRET,
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

// beta features switched on for a member's account (so the home-screen app has them without ?beta= in the address)
function betaFor(env, uid) {
  const ids = String(env.BETA_TESTERS || "").split(/[\s,]+/).concat(String(env.ALLOWLIST || "").split(/[\s,]+/)).filter(Boolean);
  return ids.includes(String(uid)) ? ["league"] : [];
}
