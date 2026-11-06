/* Yahoo Fantasy sign-in and league reader, used by worker.js (routes under /api/yahoo/).
   Needs a Patreon login first: the Yahoo tokens are stored against that Patreon ID in D1, encrypted with SESSION_SECRET.
     YAHOO_CLIENT_SECRET  secret  from developer.yahoo.com (never in this repo)
   Read-only (scope fspt-r). Yahoo doesn't allow browser requests, so the page asks this script, which asks Yahoo. */
export const YAHOO_ID = "dj0yJmk9V3VYMGtGNTZYQkNhJmQ9WVdrOVRXNHhjRVpVYnpjbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PTFk";
const AUTH = "https://api.login.yahoo.com/oauth2/request_auth", TOKEN = "https://api.login.yahoo.com/oauth2/get_token", API = "https://fantasysports.yahooapis.com/fantasy/v2/";
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* ---------- token storage ---------- */
async function aesKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("yahoo-tokens:" + env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); return b64(iv) + "." + b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(text)))); }
async function unseal(env, s) { const [iv, ct] = s.split("."); return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct))); }
async function ready(env) { if (!ready.done) { await env.DB.prepare("CREATE TABLE IF NOT EXISTS yahoo (uid TEXT PRIMARY KEY, tok TEXT NOT NULL, updated INTEGER NOT NULL)").run(); ready.done = true; } }
async function getTok(env, uid) { await ready(env); const r = await env.DB.prepare("SELECT tok FROM yahoo WHERE uid = ?").bind(uid).first(); return r ? JSON.parse(await unseal(env, r.tok)) : null; }
async function putTok(env, uid, t) { await ready(env); await env.DB.prepare("INSERT INTO yahoo (uid, tok, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET tok = excluded.tok, updated = excluded.updated").bind(uid, await seal(env, JSON.stringify(t)), Date.now()).run(); }
export async function yahooDisconnect(env, uid) { await ready(env); await env.DB.prepare("DELETE FROM yahoo WHERE uid = ?").bind(uid).run(); }
export async function yahooConnected(env, uid) { try { return !!(await getTok(env, uid)); } catch (e) { return false; } }

/* ---------- OAuth ---------- */
const basic = env => "Basic " + btoa(YAHOO_ID + ":" + env.YAHOO_CLIENT_SECRET);
export function yahooLoginUrl(redirect, state) {
  const u = new URL(AUTH); u.search = new URLSearchParams({ client_id: YAHOO_ID, redirect_uri: redirect, response_type: "code", scope: "fspt-r", language: "en-us", state }); return u.href;
}
async function tokenCall(env, params) {
  const r = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(env) }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({})); if (!j.access_token) throw new Error("yahoo token: " + JSON.stringify(j).slice(0, 200)); return j;
}
export async function yahooExchange(env, uid, code, redirect) {
  const j = await tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: redirect });
  await putTok(env, uid, { a: j.access_token, r: j.refresh_token, e: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
}
async function access(env, uid) {
  const t = await getTok(env, uid); if (!t) return null;
  if (t.e > Date.now()) return t.a;
  const j = await tokenCall(env, { grant_type: "refresh_token", refresh_token: t.r, redirect_uri: "oob" });
  await putTok(env, uid, { a: j.access_token, r: j.refresh_token || t.r, e: Date.now() + (j.expires_in || 3600) * 1000 - 60000 }); return j.access_token;
}
async function yget(env, uid, path) {
  const tok = await access(env, uid); if (!tok) throw Object.assign(new Error("not connected"), { code: 401 });
  const r = await fetch(API + path + (path.includes("?") ? "&" : "?") + "format=json", { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Yahoo refused the request. Reconnect Yahoo."), { code: 401 });
  if (!r.ok) throw Object.assign(new Error(`Yahoo didn't answer (error ${r.status}).`), { code: 502 });
  return r.json();
}

/* ---------- Yahoo's JSON is arrays of one-key objects and objects keyed "0","1",... with a count: flatten to plain values ---------- */
export const ylist = o => { if (!o || typeof o !== "object") return []; if (Array.isArray(o)) return o; return Object.keys(o).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => o[k]); };
// merge the [{a:1},{b:2},[...]] pieces of one Yahoo node into a single object
export const yflat = a => { const out = {}; (Array.isArray(a) ? a : [a]).forEach(x => { if (Array.isArray(x)) Object.assign(out, yflat(x)); else if (x && typeof x === "object") Object.assign(out, x); }); return out; };
const fc = j => (j && j.fantasy_content) || {};
// the teams of a league response (standings wraps them one level deeper: standings: [{ teams }])
const teamsOf = j => { const n = ylist(fc(j).league)[1] || {}; return ylist(n.teams || (Array.isArray(n.standings) ? (n.standings[0] || {}).teams : (n.standings || {}).teams)); };

/* every NBA league (newest season) the signed-in Yahoo user is in */
export async function yahooLeagues(env, uid) {
  const j = await yget(env, uid, "users;use_login=1/games;game_codes=nba/leagues");
  const user = ylist(fc(j).users)[0], games = ylist(user && user.user && user.user[1] && user.user[1].games), out = [];
  games.forEach(g => { const gm = g.game || [], info = yflat(gm[0]);
    ylist(gm[1] && gm[1].leagues).forEach(l => { const x = yflat(l.league);
      out.push({ key: x.league_key, id: "y" + info.game_id + "l" + x.league_id, name: x.name, season: +info.season || +x.season || 0, teams: +x.num_teams || 0, scoring: x.scoring_type || "" }); }); });
  const top = Math.max(0, ...out.map(l => l.season));
  return out.filter(l => l.season === top);
}

/* one league, flattened to what the page needs */
export async function yahooLeague(env, uid, key) {
  if (!/^\d+\.l\.\d+$/.test(key)) throw Object.assign(new Error("bad league key"), { code: 400 });
  const [sj, tj, rj, stj] = await Promise.all([yget(env, uid, `league/${key}/settings`), yget(env, uid, `league/${key}/teams`), yget(env, uid, `league/${key}/teams/roster`), yget(env, uid, `league/${key}/standings`).catch(() => null)]);
  const L = ylist(fc(sj).league), lg = yflat(L[0]), st = (L[1] && L[1].settings && L[1].settings[0]) || {};
  const cats = ylist(st.stat_categories && st.stat_categories.stats).map(s => s.stat).filter(s => s && !(+s.is_only_display_stat)).map(s => ({ id: +s.stat_id, name: s.name, abbr: s.display_name }));
  const mods = {}; ylist(st.stat_modifiers && st.stat_modifiers.stats).forEach(s => { if (s.stat) mods[s.stat.stat_id] = +s.stat.value; });
  const slots = ylist(st.roster_positions).map(p => p.roster_position).filter(Boolean).map(p => ({ pos: p.position, n: +p.count || 0 }));
  const settings = { key, name: lg.name, season: +lg.season || 0, scoring: lg.scoring_type || "", teams: +lg.num_teams || 0, startWeek: +lg.start_week || 1, endWeek: +lg.end_week || 0,
    week: +lg.current_week || 1, playoffStart: +st.playoff_start_week || 0, playoffTeams: +st.num_playoff_teams || 0, tradeEnd: st.trade_end_date || "", faab: String(st.uses_faab) === "1", cats, mods, slots };
  const teams = {};
  teamsOf(tj).forEach(t => { const f = yflat((t.team || [])[0]), mg = ylist(f.managers).map(m => m.manager || {});
    teams[f.team_id] = { id: String(f.team_id), name: f.name, mine: String(f.is_owned_by_current_login) === "1" || mg.some(m => String(m.is_current_login) === "1"), manager: (mg[0] || {}).nickname || "", roster: [] }; });
  teamsOf(rj).forEach(t => { const tm = t.team || [], f = yflat(tm[0]), r = tm[1] && tm[1].roster, ps = ylist(r && r["0"] && r["0"].players);
    const T = teams[f.team_id] || (teams[f.team_id] = { id: String(f.team_id), name: f.name, mine: false, manager: "", roster: [] });
    T.roster = ps.map(p => { const pl = yflat((p.player || [])[0]), sel = yflat(p.player && p.player[1] && p.player[1].selected_position);
      return { name: (pl.name || {}).full || "", team: pl.editorial_team_abbr || "", pos: pl.display_position || "", slot: sel.position || "BN", inj: pl.status || "" }; }).filter(x => x.name); });
  const standings = teamsOf(stj).map(t => { const tm = t.team || [], f = yflat(tm[0]), s = (tm[2] || {}).team_standings || {}, o = s.outcome_totals || {};
    return { id: String(f.team_id), rank: +s.rank || 0, w: +o.wins || 0, l: +o.losses || 0, t: +o.ties || 0 }; });
  // this week's and the coming weeks' matchups (one Yahoo call per week, capped)
  const last = Math.min(settings.endWeek || settings.week, settings.week + 17), nums = []; for (let w = settings.week; w <= last; w++) nums.push(w);
  const sbs = await Promise.all(nums.map(w => yget(env, uid, `league/${key}/scoreboard;week=${w}`).catch(() => null))), weeks = [];
  sbs.forEach((sb, i) => { if (!sb) return;
    const sc = (ylist(fc(sb).league)[1] || {}).scoreboard, ms = ylist(sc && sc["0"] && sc["0"].matchups), m = []; let start = "", end = "";
    ms.forEach(x => { const mu = x.matchup || {}; start = mu.week_start || start; end = mu.week_end || end;
      const tt = ylist((mu["0"] || mu).teams).map(y => String(yflat((y.team || [])[0]).team_id)); if (tt.length === 2) m.push(tt); });
    weeks.push({ week: nums[i], start, end, matchups: m }); });
  return { settings, teams: Object.values(teams), standings, weeks };
}
