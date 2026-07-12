function gtMain() {

  // Defensive: if our widget somehow already exists (double injection),
  // don't build a second one.
  if (document.getElementById("goal-tracker")) return;

  // ── Language universes ("profiles") ────────────────────────────
  // Each universe (typegg.io, de.typegg.io, fr.typegg.io, …) is a separate
  // origin, but we ALSO namespace all of OUR own state (localStorage keys,
  // the IndexedDB database, the cross-tab channel + leader lock) by universe,
  // so every universe is a fully isolated profile: its own goals, rival
  // stores, navigation and PP world. English keeps the bare keys (prefix ""),
  // so existing data needs no migration; other universes get a "<code>:"
  // prefix. Add a language later by adding one line to UNIVERSE_BY_SUBDOMAIN.
  const UNIVERSE_BY_SUBDOMAIN = {
    fr: "French", it: "Italian", ru: "Russian",
    es: "Spanish", vi: "Vietnamese", de: "German",
  };
  const GT_SUBDOMAIN = (() => {
    const first = (location.hostname || "").toLowerCase().split(".")[0];
    return Object.prototype.hasOwnProperty.call(UNIVERSE_BY_SUBDOMAIN, first) ? first : "";
  })();
  // API "language" value for PP-derived stats; "English" is the default world.
  const GT_LANGUAGE = GT_SUBDOMAIN ? UNIVERSE_BY_SUBDOMAIN[GT_SUBDOMAIN] : "English";
  // Storage namespace; "" for English so existing keys keep working untouched.
  const GT_NS = GT_SUBDOMAIN ? GT_SUBDOMAIN + ":" : "";

  // Append the universe to a PP-derived endpoint (/users, /leaders?sort=totalPp).
  // No-op for English. Only totalPp / globalRank / bestPp / bestWpm are
  // language-scoped by the API; EXP / races / quotes / nWpm stay global, so
  // this is only ever applied on PP paths.
  function withLang(url) {
    if (!GT_LANGUAGE || GT_LANGUAGE === "English") return url;
    return url + (url.includes("?") ? "&" : "?") + "language=" + encodeURIComponent(GT_LANGUAGE);
  }

  // localStorage proxy: transparently namespaces OUR keys (those starting with
  // "gt") by universe while leaving the site's own keys (e.g. pocketbase_auth)
  // untouched. With GT_NS === "" this is a pure pass-through, so English is
  // byte-for-byte unchanged. Shadowing the global here scopes every existing
  // localStorage.* call in this closure with zero call-site changes. key()
  // returns LOGICAL (de-prefixed) keys so enumeration + storage events still
  // match our logical key constants.
  const GT_RAW_LS = window.localStorage;
  const gtIsOurKey = (k) => typeof k === "string" && k.startsWith("gt");
  const gtPhysKey  = (k) => (GT_NS && gtIsOurKey(k)) ? GT_NS + k : k;
  const logiKey    = (k) => (GT_NS && typeof k === "string" && k.startsWith(GT_NS + "gt")) ? k.slice(GT_NS.length) : k;
  const localStorage = {
    getItem:    (k)    => GT_RAW_LS.getItem(gtPhysKey(k)),
    setItem:    (k, v) => GT_RAW_LS.setItem(gtPhysKey(k), v),
    removeItem: (k)    => GT_RAW_LS.removeItem(gtPhysKey(k)),
    key:        (i)    => logiKey(GT_RAW_LS.key(i)),
    clear:      ()     => GT_RAW_LS.clear(),
    get length() { return GT_RAW_LS.length; },
  };

  // ── Cached stats (for target-mode hint in modal) ───────────────
  let currentStats = { exp: null, pp: null, races: null, quotes: null, quotesUnranked: null, playtime: null, rank: null, expRank: JSON.parse(localStorage.getItem("gt-exp-rank"))?.rank ?? null };

  // ── Gain delta tracking (for +X pop-up indicators) ─────────────
  // Stores the last known gain value per goal ID so renderAllGoals()
  // can compute the delta and trigger a visual indicator on increase.
  const prevGainMap = {};

  // For rolling-average goals, the same delta-detection job is split
  // across two values:
  //   prevAvgMap  — last known current avg, for the +/- delta pill that
  //                 flashes after every race (current can move both ways).
  //   prevBestMap — last known bestAvg, for the "↑ new best" tag that
  //                 flashes only when bestAvg increases.
  // Same lifecycle as prevGainMap (cleared on goal removal and on
  // applyUserData stale-data wipes).
  const prevAvgMap  = {};
  const prevBestMap = {};

  // For rival goals: last settled "your value" on the current quote, per goal
  // ID, so a quote-finish that raises it pops a +X gain pill (same lifecycle
  // as the maps above). Keyed with the quoteId so a quote change re-baselines
  // instead of flashing a phantom delta. Shape: { quoteId, value }.
  const prevRivalYouMap = {};

  // ── Drag in progress? ──────────────────────────────────────────
  // Set to true during goal drag so cross-tab sync listeners don't
  // yank DOM out from under an active drag. Reset on drop.
  let dragInProgress = false;

  // ── Polling intervals (centralised so they're easy to tune) ────
  const POLL_STATS_MS       = 20_000;   // was 5_000 — user stats (loadStats)
  const POLL_SLOW_MS        = 300_000;  // was 60_000 — rank/player/quotes/exp-rank background updates

  // ── inFlight: prevents overlapping executions of an async fn ──
  // If the previous call hasn't resolved, skip this tick.
  function inFlight(fn) {
    let running = false;
    return async (...args) => {
      if (running) return;
      running = true;
      try { return await fn(...args); }
      finally { running = false; }
    };
  }

  // ── Debug logging ──────────────────────────────────────────────
  // Structured, human-readable console logs for the race lifecycle and
  // goal recalculations. Each log is ONE line plus ONE detail object that
  // DevTools shows collapsed by default — expand it to see the exact
  // values a recalculation used (before → after).
  // On by default. Toggle from the page console (takes effect immediately,
  // no reload needed — the flag is re-read on every log call):
  //   localStorage.gtDebugLogs = "0"   // off
  //   localStorage.gtDebugLogs = "1"   // on
  function gtLogEnabled() {
    try { return localStorage.getItem("gtDebugLogs") !== "0"; } catch { return true; }
  }
  function gtLog(event, summary, detail) {
    if (!gtLogEnabled()) return;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const ss = String(t.getSeconds()).padStart(2, "0");
    const ms = String(t.getMilliseconds()).padStart(3, "0");
    const head = `[GT ${hh}:${mm}:${ss}.${ms}] ${event}${summary ? " — " + summary : ""}`;
    if (detail === undefined) console.log(head);
    else console.log(head, detail);
  }
  // Short human tag for a goal in log lines, e.g. "races/wpm#4f2a".
  function gtGoalTag(gd, type) {
    if (!gd) return "(?)";
    const bits = [type || "goal"];
    if (gd.mode && gd.mode !== bits[0]) bits.push(gd.mode);
    if (gd.improvementTrack) bits.push(gd.improvementTrack);
    const metric = gd.metric || gd.improvementMetric;
    if (metric) bits.push(metric);
    return `${bits.join("/")}#${String(gd.id ?? "?").slice(-4)}`;
  }
  // Diff two flat stat objects → { field: { from, to, gain } } for changed
  // fields (gain = to − from, only when both sides are numbers).
  function gtStatsDiff(prev, next, fields) {
    const d = {};
    for (const f of fields) {
      if (prev?.[f] !== next?.[f]) {
        const from = prev?.[f], to = next?.[f];
        const entry = { from, to };
        if (typeof from === "number" && typeof to === "number" && isFinite(from) && isFinite(to)) {
          entry.gain = Math.round((to - from) * 100) / 100;
        }
        d[f] = entry;
      }
    }
    return d;
  }
  // Human-readable mean: "(93.2 + 95.1 + 97.4) / 3 = 95.23" — value-by-value
  // for short windows, summarized for long ones (rolling-avg goals go to 250).
  function gtAvgCalc(values, avg) {
    if (!Array.isArray(values) || values.length === 0) return undefined;
    const r = (x) => Math.round(x * 100) / 100;
    if (values.length > 12) return `average of ${values.length} values = ${r(avg)}`;
    return `(${values.map(r).join(" + ")}) / ${values.length} = ${r(avg)}`;
  }

  // ── Cross-tab coordination ───────────────────────────────────
  // Goal: with 4 TypeGG tabs open, only ONE fetches from the API.
  // The "leader" tab runs the intervals; follower tabs receive data
  // via BroadcastChannel and just update their UI.
  const CHANNEL_NAME     = GT_NS + 'gt-sync';
  const LEADER_LOCK_NAME = GT_NS + 'gt-leader';
  const STATS_CACHE_KEY  = 'gt-stats-cache';
  const STATS_CACHE_TTL  = 5 * 60 * 1000; // 5 min — beyond this, treat cache as stale

  const channel = ('BroadcastChannel' in window) ? new BroadcastChannel(CHANNEL_NAME) : null;
  let isLeader = false;

  // ── Cross-tab visibility ────────────────────────────────────
  // If only the leader tab is hidden but a follower tab is visible,
  // we still want to fetch (the user is actively looking at a follower).
  // Each tab pings "I'm visible" on the channel; leader tracks the most
  // recent ping and keeps fetching while any tab is visible.
  let lastAnyVisibleTime = !document.hidden ? Date.now() : 0;
  function anyTabVisibleRecently() {
    return !document.hidden || (Date.now() - lastAnyVisibleTime < 15_000);
  }
  function runIfAnyTabVisible(fn) {
    // Also pauses while the shared API backoff is active OR while logged out:
    // during a throttle these background polls would only fail (logging a
    // caught error each time) and prolong the throttle; logged out they'd 401.
    // They resume automatically once the backoff passes / the user logs in.
    // (gtApiFetch already prevents the request itself; this avoids running the
    // poll — and its error logging — at all. Every leader background poller is
    // wrapped in this, so it's the single gate for them.)
    return () => { if (anyTabVisibleRecently() && !apiThrottled() && isLoggedIn()) fn(); };
  }
  function broadcastVisibilityPing() {
    if (!document.hidden) channel?.postMessage({ type: 'visible-ping' });
  }
  document.addEventListener('visibilitychange', broadcastVisibilityPing);
  setInterval(broadcastVisibilityPing, 10_000);
  broadcastVisibilityPing(); // initial announcement

  // ── Auth (reads TypeGG's own localStorage entry) ───────────────
  function getAuth() {
    try {
      const raw = localStorage.getItem("pocketbase_auth");
      if (!raw) return { token: null, username: null };
      const parsed = JSON.parse(raw);
      return {
        token:    parsed?.token             ?? null,
        username: parsed?.record?.username  ?? null,
      };
    } catch { return { token: null, username: null }; }
  }

  function authHeaders() {
    const { token } = getAuth();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // Logged in iff TypeGG's pocketbase_auth holds a token. The single source of
  // truth for the logged-out gate (panel + fetch short-circuit). Read fresh.
  function isLoggedIn() { return getAuth().token != null; }

  // ══════════════════════════════════════════════════════════════
  // Shared API throttle gate — wraps EVERY call to the TypeGG API.
  // ══════════════════════════════════════════════════════════════
  // TypeGG rate-limits per IP. When the limit is tripped, requests come back
  // rejected with no CORS header — the browser reports this as "Failed to
  // fetch" / a CORS error. Hammering harder (the old behaviour: every poll on
  // its own timer retrying with no backoff) keeps the IP throttled, which is
  // why everything — including unrelated TypeGG tools — stays slow.
  //
  // Every API fetch now goes through gtApiFetch, which:
  //   • Skips the request entirely while we're in a backoff window (throws a
  //     synthetic error so the caller's existing catch path handles it — no
  //     network request is made, so we stop feeding the throttle).
  //   • Tells a genuine rate-limit (HTTP 429, or 503 + Retry-After) apart from
  //     a merely slow / timed-out / 5xx request. A real 429 escalates the
  //     aggressive HARD pause (30s → … → 15 min) that stops EVERYTHING incl.
  //     the urgent post-race lane; a slow/timeout/5xx takes a gentle, capped
  //     SOFT pause (10s → … → 2 min) that only holds the heavy BULK syncs, so
  //     one slow history page can't starve the small urgent fetches.
  //   • Aborts a hung request via AbortController (urgent ~10s, bulk ~30s) so a
  //     stuck fetch fails fast instead of hanging ~55s and tripping the gate.
  //   • On any genuine response (2xx, or a 404 "not found"), resets it and
  //     fires a one-shot catch-up so stale cards self-heal.
  // This single coordinated gate is the thing that lets a throttle clear.
  const API_BACKOFF_BASE_MS = 30_000;        // hard (429) backoff base
  const API_BACKOFF_MAX_MS  = 15 * 60_000;   // hard backoff cap
  const API_SOFT_BASE_MS    = 10_000;        // soft (slow/timeout/5xx) backoff base
  const API_SOFT_MAX_MS     = 2 * 60_000;    // soft backoff cap — bulk flakiness stays well short of the 15 min hard cap
  const API_TIMEOUT_URGENT_MS = 10_000;      // small post-race fetches fail fast
  const API_TIMEOUT_BULK_MS   = 30_000;      // paged history/catalog get a generous cap
  let apiBackoffUntil = 0; // BULK gate window — any failure (soft or hard) extends it
  let apiHardUntil    = 0; // URGENT gate window — only a real 429 / 503+Retry-After extends it
  let apiSoftFails    = 0;
  let apiHardFails    = 0;
  let apiCatchUpTimer = null;
  // Bulk traffic pauses on ANY backoff; the urgent post-race lane pauses only
  // on a genuine 429 ("hard") window — that's what stops a bulk timeout from
  // blocking the small fetch that refreshes the rival / target cards.
  function apiThrottled()     { return Date.now() < apiBackoffUntil; }
  function apiHardThrottled() { return Date.now() < apiHardUntil; }
  function apiBackoffRemainingMs() { return Math.max(0, apiBackoffUntil - Date.now()); }
  // Parse a Retry-After header (delta-seconds or HTTP-date) → ms, else 0.
  function retryAfterMs(r) {
    const h = r.headers.get("retry-after");
    if (!h) return 0;
    const s = Number(h);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
  }
  function apiNoteFailure(hard = true, explicitMs = 0) {
    if (hard) {
      apiHardFails = Math.min(apiHardFails + 1, 12);
      const base = explicitMs > 0 ? explicitMs : API_BACKOFF_BASE_MS * 2 ** (apiHardFails - 1);
      const wait = Math.min(API_BACKOFF_MAX_MS, base);
      const until = Date.now() + wait;
      // Hard extends BOTH windows (bulk + urgent): a real rate-limit means back
      // off completely. Only ever extend (concurrent failures don't shrink it).
      apiHardUntil    = Math.max(apiHardUntil, until);
      apiBackoffUntil = Math.max(apiBackoffUntil, until);
      console.warn(`[Goal Tracker] API rate-limited — pausing all requests ~${Math.round(wait / 1000)}s (hard #${apiHardFails})`);
    } else {
      apiSoftFails = Math.min(apiSoftFails + 1, 8);
      const wait = Math.min(API_SOFT_MAX_MS, API_SOFT_BASE_MS * 2 ** (apiSoftFails - 1));
      // Soft extends ONLY the bulk window — urgent fetches stay allowed.
      apiBackoffUntil = Math.max(apiBackoffUntil, Date.now() + wait);
      console.warn(`[Goal Tracker] API slow/unreachable — pausing bulk syncs ~${Math.round(wait / 1000)}s (soft #${apiSoftFails}); urgent fetches still allowed`);
    }
    armBackoffCatchUpTimer();
  }
  function apiNoteSuccess() {
    if (apiSoftFails || apiHardFails || apiBackoffUntil || apiHardUntil) {
      apiSoftFails = 0; apiHardFails = 0;
      apiBackoffUntil = 0; apiHardUntil = 0;
      if (apiCatchUpTimer) { clearTimeout(apiCatchUpTimer); apiCatchUpTimer = null; }
      scheduleBackoffCatchUp(); // window cleared early by a success → heal now
    }
  }
  // When a backoff window is armed, schedule a single check for the moment it
  // lapses (re-arming if a later failure pushed it out). On clear, run the
  // catch-up so a card that went stale during the pause refreshes itself
  // instead of waiting for the next race / a slow periodic poll.
  function armBackoffCatchUpTimer() {
    if (apiCatchUpTimer) clearTimeout(apiCatchUpTimer);
    const wait = Math.max(apiBackoffUntil, apiHardUntil) - Date.now();
    if (wait <= 0) { apiCatchUpTimer = null; return; }
    apiCatchUpTimer = setTimeout(() => {
      apiCatchUpTimer = null;
      if (apiThrottled() || apiHardThrottled()) { armBackoffCatchUpTimer(); return; }
      scheduleBackoffCatchUp();
    }, wait + 250);
  }
  // Coalesce catch-up triggers into one deferred run (a success fires this from
  // inside gtApiFetch, so defer past the current fetch's resolution).
  let catchUpPending = false;
  function scheduleBackoffCatchUp() {
    if (catchUpPending) return;
    catchUpPending = true;
    setTimeout(() => { catchUpPending = false; try { runBackoffCatchUp(); } catch {} }, 0);
  }
  // Marker so callers can tell "we deliberately skipped" from a real failure.
  const API_THROTTLED_ERR  = "gt-api-throttled";
  const API_LOGGED_OUT_ERR = "gt-api-logged-out";
  const API_TIMEOUT_ERR    = "gt-api-timeout";
  // gt.lane: "urgent" (short timeout, ignores a soft/bulk pause, respects only
  // a real 429) | "bulk" (default — generous timeout, respects any pause).
  async function gtApiFetch(url, opts, gt = {}) {
    if (!isLoggedIn()) {
      // Logged out: make NO request (every TypeGG endpoint would 401, and the
      // logged-out gate already short-circuits the pollers — this is the final
      // backstop). Throw the same shape as the throttle skip so existing catch
      // paths handle it; do NOT escalate the backoff (not a rate-limit signal).
      const e = new Error(API_LOGGED_OUT_ERR);
      e.gtLoggedOut = true;
      throw e;
    }
    const urgent = gt.lane === "urgent";
    // Bulk respects ANY backoff window; urgent respects only the hard (429) one.
    if (urgent ? apiHardThrottled() : apiThrottled()) {
      const e = new Error(API_THROTTLED_ERR);
      e.gtThrottled = true;
      throw e;
    }
    const timeoutMs = gt.timeoutMs || (urgent ? API_TIMEOUT_URGENT_MS : API_TIMEOUT_BULK_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      // Our timeout abort, or a network/CORS error: a SLOW/unreachable signal,
      // NOT a rate-limit → soft backoff (bulk-only). The real HTTP status (if
      // any) is invisible to JS here; treat it gently rather than as a 429.
      apiNoteFailure(false);
      if (ctrl.signal.aborted) { const te = new Error(API_TIMEOUT_ERR); te.gtTimeout = true; throw te; }
      throw e;
    }
    clearTimeout(timer);
    if (r.ok || r.status === 404) { apiNoteSuccess(); return r; }
    // Classify the HTTP error. 429 (and 503 + Retry-After) = genuine throttle →
    // HARD pause (stops everything). 500/502/504/other = transient server/slow
    // → SOFT pause (bulk only, urgent keeps flowing).
    const hard = r.status === 429 || (r.status === 503 && !!r.headers.get("retry-after"));
    apiNoteFailure(hard, hard ? retryAfterMs(r) : 0);
    return r;
  }

  function userEndpoint() {
    const { username } = getAuth();
    return withLang(`https://api.typegg.io/v1/users/${username ?? "fruit"}`);
  }

  // ── ID generation ──────────────────────────────────────────────
  function generateGoalId(type) {
    return `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // ── Main widget ────────────────────────────────────────────────
  // The main widget always exists. It holds the action buttons
  // (+ Set, settings gear) and — by default — any goals that haven't
  // been dragged out into detached widgets.
  const container = document.createElement("div");
  container.id = "goal-tracker";
  container.classList.add("gt-widget", "gt-widget-main");
  container.dataset.groupId = "main";

  container.innerHTML = `
    <div class="gt-header">
      <span>Goals</span>
      <div class="gt-header-actions">
        <button id="gt-settings-btn" class="gt-icon-btn" title="Settings" aria-label="Settings">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button id="set-goal-btn" class="gt-set-btn">+ Set</button>
      </div>
    </div>
    <div class="gt-content">
      <!-- Goal sections will be dynamically added here -->
    </div>
  `;

  document.body.appendChild(container);

  // ── Groups data model ─────────────────────────────────────────
  // Each "group" is a widget that contains an ordered list of goals.
  // There's always a MAIN group (id "main"), which corresponds to the
  // #goal-tracker widget holding the action buttons. Users can drag
  // individual goals out to create "detached" groups (one-off widgets
  // positioned anywhere on-screen), stack goals by dropping them onto
  // existing widgets, or reorder goals within a widget by dragging.
  //
  // Shape: { [groupId]: { position: {xRatio,yRatio}|null, size: {width}|null, goalIds: [...] } }
  //   - position: fractions of the free space (0=left/top edge … 1=right/bottom edge), so a
  //     widget keeps its place relative to the window on resize/zoom. null for main = CSS
  //     default (top-right). Detached widgets always have a position. Legacy {left,top}px migrates.
  //   - size: null = auto / CSS default. Only main is resizable today.
  //   - goalIds: order is authoritative — determines DOM order within the widget.
  const GROUPS_KEY     = "gt-groups";
  const MAIN_GROUP_ID  = "main";
  const LEGACY_POS_KEY  = "gt-position";
  const LEGACY_SIZE_KEY = "gt-size";

  function generateGroupId() {
    return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function loadGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem(GROUPS_KEY) || "null");
      if (saved && typeof saved === "object" && saved[MAIN_GROUP_ID]) return saved;
    } catch {}
    return null; // caller will migrate
  }

  // Build the initial groups object from legacy storage + existing goals.
  // Called once when no gt-groups key exists yet.
  function synthesizeGroupsFromLegacy() {
    const position = JSON.parse(localStorage.getItem(LEGACY_POS_KEY)  || "null");
    const size     = JSON.parse(localStorage.getItem(LEGACY_SIZE_KEY) || "null");
    // Order matches the historical type-sorted order so pre-existing users
    // don't see a jarring reshuffle on upgrade.
    const typeOrder = ['exp', 'pp', 'races', 'improvement', 'quotes', 'playtime', 'chars'];
    const goalIds = [];
    for (const type of typeOrder) {
      try {
        const goals = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEYS[type]) || "[]");
        for (const g of goals) if (g && g.id) goalIds.push(g.id);
      } catch {}
    }
    return {
      [MAIN_GROUP_ID]: { position, size, goalIds },
    };
  }

  // Populated below (after GOAL_CONFIG is defined) — we need the storage
  // keys for goal types during legacy migration. Fallback to fixed names.
  const GOAL_STORAGE_KEYS = {
    exp:      "gt-goals-exp",
    pp:       "gt-goals-pp",
    races:    "gt-goals-races",
    quotes:   "gt-goals-quotes",
    playtime: "gt-goals-playtime",
    chars:    "gt-goals-chars",
    rival:    "gt-goals-rival",
  };

  let groupData = loadGroups() || synthesizeGroupsFromLegacy();

  function saveGroups(broadcast = true) {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groupData));
    if (broadcast) channel?.postMessage({ type: "groups-changed" });
  }

  // Ensure the main group always exists, even if storage was corrupted
  // or somehow dropped the key.
  function ensureMainGroup() {
    if (!groupData[MAIN_GROUP_ID]) {
      groupData[MAIN_GROUP_ID] = { position: null, size: null, goalIds: [] };
    }
  }
  ensureMainGroup();

  // Lookup: which group currently holds this goalId?
  function findGroupIdOfGoal(goalId) {
    for (const [gid, group] of Object.entries(groupData)) {
      if (group.goalIds.includes(goalId)) return gid;
    }
    return null;
  }

  // Resolve the widget DOM element for a given group id
  function widgetElForGroup(groupId) {
    if (groupId === MAIN_GROUP_ID) return container;
    return document.querySelector(`.gt-widget-detached[data-group-id="${groupId}"]`);
  }

  // Resolve the content area (where goal sections live) for a given group id
  function contentElForGroup(groupId) {
    const w = widgetElForGroup(groupId);
    return w ? w.querySelector(".gt-content") : null;
  }

  // Does any goal currently in this group have mode === "average"?
  // Used to gate the .gt-widget-has-avg class — see updateWidgetAvgClass
  // below. Defined here (alongside the other group/widget lookups) rather
  // than inline at the call site so the predicate is reusable. The
  // double loop is fine: groups are small (a handful of goals each) and
  // goalData is split across types so we have to scan all type buckets
  // to find the goal record matching an id.
  function groupHasAvgGoal(groupId) {
    // Defensive: this can run during the initial renderGroupWidgets()
    // pass at module load (createDetachedWidget calls updateWidgetAvgClass
    // for each new widget), which happens BEFORE the `let goalData`
    // declaration further down in the file is executed. Reading goalData
    // before its declaration line is hit triggers a TDZ ReferenceError;
    // catch it and return false. That's correct behaviour for this
    // moment anyway: there are no goal sections in the widget yet, so
    // no avg-class bump is needed. Once goalData is initialized and
    // the first renderAllGoals pass runs, updateAllWidgetAvgClasses
    // sets the class correctly.
    let goals;
    try { goals = goalData; } catch { return false; }
    const group = groupData[groupId];
    if (!group) return false;
    for (const goalId of group.goalIds) {
      for (const type of Object.keys(goals)) {
        const gd = goals[type].find(g => g.id === goalId);
        if (gd && goalIsAverage(gd)) return true;
      }
    }
    return false;
  }

  // Toggle .gt-widget-has-avg on a widget based on whether its group
  // currently holds an average goal. The class bumps the widget's
  // min-width (see styles.css) to reserve room for the new-best gain
  // pill on the avg-best-row, which would otherwise overlap the ✓
  // achievement badge at the default 180px min-width. Widgets that
  // never host avg goals keep the original 180px so users without
  // average goals don't see their widgets get wider for no reason.
  function updateWidgetAvgClass(groupId) {
    const w = widgetElForGroup(groupId);
    if (!w) return;
    const has = groupHasAvgGoal(groupId);
    if (w.classList.contains("gt-widget-has-avg") === has) return; // no change → skip
    w.classList.toggle("gt-widget-has-avg", has);
    // Toggling the class changes the widget's min-width (180 ↔ 220px), so its
    // rendered width just jumped (avg added) or dropped (avg removed).
    // Re-project the stored position ratio onto the new width so the widget
    // grows in whichever direction keeps it on-screen: one anchored toward
    // the right edge grows LEFT (instead of overflowing the viewport and
    // getting clipped), while a left-anchored one still grows right by
    // default — mirroring how the edit popover flips sides when space is
    // tight. When the avg goal is later dragged away and the widget shrinks
    // back, the same re-projection returns it to its original spot. Skipped
    // mid-drag: the drag owns the widget's left/top and re-projecting would
    // snap it away. (The main widget has no stored position — it keeps its
    // right:16px CSS anchor and already grows leftward — so the projection
    // is a no-op there.)
    //
    // Re-project POSITION ONLY — never re-apply the stored width here. The
    // width change is driven purely by the min-width gate (CSS); calling
    // applyWidgetTransform would re-apply group.size.width, which the resize
    // observer may have just recorded as the bumped 220px while the avg goal
    // was present — freezing the widget wide so it wouldn't shrink back to
    // the user's chosen width once the avg goal leaves. Leaving style.width
    // untouched lets the min-width floor drop and the width revert on its own.
    if (!w.classList.contains("gt-widget-dragging")) {
      const group = groupData[groupId];
      if (group) applyWidgetPositionRatio(w, normalizeGroupPositionRatio(group, w));
    }
  }

  // Refresh the .gt-widget-has-avg class on every existing widget.
  // Called from renderAllGoals so any change that triggers a render
  // (goal added / removed / moved between groups, settings changed,
  // period rolled over, etc.) also updates the min-width gating
  // without needing to thread a call through each individual
  // mutation site.
  function updateAllWidgetAvgClasses() {
    for (const gid of Object.keys(groupData)) {
      updateWidgetAvgClass(gid);
    }
  }

  // ── Create goal section HTML ───────────────────────────────────
  // parentContent: the .gt-content element of whichever widget owns this goal.
  // Callers look it up via contentElForGroup(findGroupIdOfGoal(goalId)) — or
  // pass explicitly when creating a goal into a known group.
  // Feather "repeat" glyph — the per-goal display-view toggle (swap between
  // "X / Y" and "Z to go"). Deliberately NOT a cog: the rival card already uses
  // a cog for "manage rivals", so a swap glyph keeps the two affordances
  // distinct and reads as "switch how this number is shown".
  const VIEW_TOGGLE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';

  function createGoalSection(goalId, type, cfg, parentContent) {
    const section = document.createElement("div");
    section.id = `${goalId}-goal-section`;
    section.className = "gt-goal-section";
    section.dataset.goalId = goalId;
    section.dataset.goalType = type;

    if (type === "rival") {
      // ── Rival card ──────────────────────────────────────────
      // Matches the standard goal sizing: header (label + metric badge + ✕),
      // a 12px value row showing "<you> / <rival>" for the CURRENT quote
      // (your number greens when you've beaten them; their number stays grey,
      // like a target), an inline +X gain pill when your number improves, a
      // wins sub-line, and the full-width "⚔ Next vs <name>" button.
      // Status states (loading / "hasn't raced") render in the message span.
      section.innerHTML = `
        <div class="gt-gain-header">
          <div class="gt-goal-label-group">
            <span id="${goalId}-label">Rival</span>
            <span id="${goalId}-metric-badge" class="gt-rival-metric-badge"></span>
          </div>
          <div class="gt-goal-actions">
            <button id="${goalId}-rival-gear" class="gt-icon-btn gt-rival-gear-btn" title="Manage rivals" aria-label="Manage rivals" style="display:none;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
            <button id="${goalId}-view-toggle" class="gt-icon-btn gt-view-toggle-btn" title="Display: X / Y or Z to go" aria-label="Display options">${VIEW_TOGGLE_SVG}</button>
            <button id="${goalId}-remove-btn" class="gt-remove-btn" title="Remove goal">✕</button>
          </div>
        </div>
        <div id="${goalId}-rival-pool" class="gt-req-line" style="display:none;"></div>
        <div id="${goalId}-rival-band" class="gt-req-line gt-req-line-quote" style="display:none;"></div>
        <div class="gt-rival-value-row">
          <span id="${goalId}-rival-value-wrap" class="gt-rival-value-wrap">
            <span id="${goalId}-rival-you" class="gt-rival-you"></span><span id="${goalId}-rival-them" class="gt-rival-them"></span>
          </span>
          <span id="${goalId}-rival-msg" class="gt-rival-msg" style="display:none;"></span>
        </div>
        <div id="${goalId}-rival-wins" class="gt-rival-wins">Wins: …</div>
        <div id="${goalId}-rival-sync" class="gt-sync-line" style="display:none;"></div>
        <button id="${goalId}-rival-next" class="gt-rival-next-btn" disabled>⚔ Next</button>
      `;
      (parentContent || container.querySelector(".gt-content")).appendChild(section);

      document.getElementById(`${goalId}-remove-btn`).addEventListener("click", async () => {
        const gd = (goalData.rival || []).find(g => g.id === goalId);
        const labelText = gd ? `Rival · ${goalRivalNames(gd).join(", ") || "rival"} (${rivalMetric(goalRivalCfg(gd)).toUpperCase()})` : "Rival goal";
        if (await confirmDeleteGoal(labelText)) removeGoal("rival", goalId);
      });

      // Gear → the "manage rivals" modal (only shown for multi-rival goals).
      const rivalGearBtn = document.getElementById(`${goalId}-rival-gear`);
      if (rivalGearBtn) rivalGearBtn.addEventListener("click", () => openRivalsModal(goalId));

      // Display-view toggle (Wins: X / Y ↔ Z to go).
      const rivalViewToggle = document.getElementById(`${goalId}-view-toggle`);
      if (rivalViewToggle) {
        rivalViewToggle.addEventListener("mousedown", (e) => e.stopPropagation());
        rivalViewToggle.addEventListener("click", (e) => { e.stopPropagation(); openGoalEditPopover("rival", goalId, rivalViewToggle); });
      }

      // Clicking the challenge button jumps to a random quote where the rival
      // currently beats you. Handler reads live state at click time.
      document.getElementById(`${goalId}-rival-next`).addEventListener("click", () => {
        onRivalNextClicked(goalId);
      });

      wireGoalDrag(section, goalId);
      return section;
    }

    // ── Improvement-Target card ─────────────────────────────────
    // Same shape as the rival card (no progress bar): a value row showing
    // "<your current-quote value> / <target>" (your number greens once you hit
    // the target), a count sub-line ("quotes ≥ N METRIC: X / Y"), and the
    // full-width "Next quote" button.
    const tGoal = (goalData[type] || []).find(g => g.id === goalId);
    if (type === "improvement" && tGoal && goalIsImprovementTarget(tGoal)) {
      section.innerHTML = `
        <div class="gt-gain-header">
          <div class="gt-goal-label-group">
            <span id="${goalId}-label">Target</span>
          </div>
          <div class="gt-goal-actions">
            <button id="${goalId}-view-toggle" class="gt-icon-btn gt-view-toggle-btn" title="Display: X / Y or Z to go" aria-label="Display options">${VIEW_TOGGLE_SVG}</button>
            <button id="${goalId}-remove-btn" class="gt-remove-btn" title="Remove goal">\u2715</button>
          </div>
        </div>
        <div id="${goalId}-target-pool" class="gt-req-line" style="display:none;"></div>
        <div id="${goalId}-target-band" class="gt-req-line gt-req-line-quote" style="display:none;"></div>
        <div class="gt-rival-value-row">
          <span id="${goalId}-target-value-wrap" class="gt-rival-value-wrap">
            <span id="${goalId}-target-you" class="gt-rival-you"></span><span id="${goalId}-target-them" class="gt-rival-them"></span>
          </span>
          <span id="${goalId}-target-msg" class="gt-rival-msg" style="display:none;"></span>
        </div>
        <div id="${goalId}-target-count" class="gt-rival-wins">quotes \u2026</div>
        <div id="${goalId}-target-sync" class="gt-sync-line" style="display:none;"></div>
        <button id="${goalId}-target-next" class="gt-rival-next-btn" disabled>\u23ed Next quote</button>
      `;
      (parentContent || container.querySelector(".gt-content")).appendChild(section);

      document.getElementById(`${goalId}-remove-btn`).addEventListener("click", async () => {
        const gd = (goalData.improvement || []).find(g => g.id === goalId);
        const metricLbl = gd && gd.metric === "pp" ? "PP" : "WPM";
        const labelText = gd ? `Target \u00b7 ${metricLbl} \u2265 ${gd.target}` : "Target goal";
        if (await confirmDeleteGoal(labelText)) removeGoal("improvement", goalId);
      });
      document.getElementById(`${goalId}-target-next`).addEventListener("click", () => {
        onTargetNextClicked(goalId);
      });

      // Display-view toggle (count sub-line X / Y ↔ Z to go).
      const targetViewToggle = document.getElementById(`${goalId}-view-toggle`);
      if (targetViewToggle) {
        targetViewToggle.addEventListener("mousedown", (e) => e.stopPropagation());
        targetViewToggle.addEventListener("click", (e) => { e.stopPropagation(); openGoalEditPopover("improvement", goalId, targetViewToggle); });
      }

      wireGoalDrag(section, goalId);
      return section;
    }

    // Per-goal display-view toggle (X / Y ↔ Z to go) lives in the header.
    // Gated to goals with at least one monotonic "remaining" line — everything
    // except pure average goals (which fluctuate, so a remainder is meaningless).
    const curGoal = (goalData[type] || []).find(g => g.id === goalId);
    const showCountToggle = goalHasToggleableLine(type, curGoal);
    const showEditBtn = goalIsEditable(type, curGoal);

    section.innerHTML = `
      <div class="gt-gain-header">
        <div class="gt-goal-label-group">
          <span id="${goalId}-label">${cfg.label}</span>
          <span id="${goalId}-rec-badge" class="gt-rec-badge" style="display:none;"></span>
        </div>
        <div class="gt-goal-actions">
          <span id="${goalId}-streak" class="gt-streak" style="display:none;"></span>
          <button id="${goalId}-view-toggle" class="gt-icon-btn gt-view-toggle-btn" title="Edit goal" aria-label="Edit goal"${showEditBtn ? "" : ' style="display:none;"'}>${VIEW_TOGGLE_SVG}</button>
          <button id="${goalId}-remove-btn" class="gt-remove-btn" title="Remove goal">✕</button>
        </div>
      </div>
      <div id="${goalId}-req-line" class="gt-req-line" style="display:none;"></div>
      <div id="${goalId}-req-line-2" class="gt-req-line gt-req-line-quote" style="display:none;"></div>
      <div class="gt-gain-row">
        <span class="gt-gain-text-wrap">
          <span id="${goalId}-gain-text">0 / 0</span>
        </span>
        <span id="${goalId}-done-badge" class="gt-done-badge" style="display:none;">✓</span>
      </div>
      <div class="gt-progress-bar">
        <div id="${goalId}-progress-fill" class="gt-progress-fill"></div>
      </div>
      <!-- Average-mode rows (rolling-avg goals). Hidden by default; shown
           in place of gt-gain-row + progress-bar when goalIsAverage(gd).
           Three rows total:
             1. Best line: "best 142 / 150" with the ✓ pill at the far
                right of the row when achieved (matches how done-badge
                sits at the right edge of gt-gain-row for other goals).
             2. Live line: "current 138.2 [+0.4]" — live rolling-avg
                value with an inline +/- pill anchored right after the
                number that changed.
             3. Bottom line: "threshold: 140 ........ 18 / 25 races".
                Threshold left-anchored, race counter right-anchored.
                Combines what used to be two separate rows so the card
                stays compact. -->
      <div id="${goalId}-avg-best-row" class="gt-avg-best-row" style="display:none;">
        <span class="gt-avg-best-group">
          <span class="gt-avg-label">best</span>
          <span id="${goalId}-avg-best-val" class="gt-avg-best-val">——</span>
          <span id="${goalId}-avg-best-target" class="gt-avg-target"></span>
        </span>
        <span id="${goalId}-avg-done" class="gt-avg-done" style="display:none;">✓</span>
      </div>
      <div id="${goalId}-avg-live-row" class="gt-avg-live-row" style="display:none;">
        <span class="gt-avg-current-wrap">
          <span class="gt-avg-label">current</span>
          <span id="${goalId}-avg-current" class="gt-avg-current">—</span>
        </span>
      </div>
      <div id="${goalId}-avg-bottom-row" class="gt-avg-bottom-row" style="display:none;">
        <span class="gt-avg-thresh-wrap">
          <span class="gt-avg-label">threshold:</span>
          <span id="${goalId}-avg-threshold" class="gt-avg-threshold">—</span>
        </span>
        <span id="${goalId}-avg-progress" class="gt-avg-progress">0 / 0</span>
      </div>
      <div id="${goalId}-countdown" class="gt-countdown" style="display:none;"></div>
    `;

    (parentContent || container.querySelector(".gt-content")).appendChild(section);

    // Attach remove handler
    document.getElementById(`${goalId}-remove-btn`).addEventListener("click", async () => {
      const labelEl = document.getElementById(`${goalId}-label`);
      const labelText = labelEl ? labelEl.textContent : cfg.label;
      if (await confirmDeleteGoal(labelText)) {
        removeGoal(type, goalId);
      }
    });

    // Wire the per-goal edit button (present when goalIsEditable gated it in).
    const viewToggleBtn = document.getElementById(`${goalId}-view-toggle`);
    if (viewToggleBtn) {
      viewToggleBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      viewToggleBtn.addEventListener("click", (e) => { e.stopPropagation(); openGoalEditPopover(type, goalId, viewToggleBtn); });
    }

    // Wire goal-level drag
    wireGoalDrag(section, goalId);

    return section;
  }

  // (The old per-goal count-view popover was removed in v10.31: every header
  // button now opens the unified openGoalEditPopover, which folds the
  // progress/remaining display toggle in alongside the other tunables.)

  // ── Per-goal editability predicates ──────────────
  // A cumulative/avg goal's "amount" (gd.target) is directly editable only when
  // it's a plain user-set number: not a rolling-average / improvement goal (mode
  // set), not a rank / player goal (target derived from a lookup), and not a
  // max-quotes / max-chars / absolute-quote-chars goal (target is fetched).
  function goalAmountEditable(g) {
    return !!g
      && (g.mode == null || g.mode === "improvement")
      && g.targetRank == null
      && g.targetUsername == null
      && !g.maxQuotes
      && !g.maxChars
      && g.quoteCharsAbsoluteTarget == null
      && typeof g.target === "number";
  }
  // Does the header edit button have anything to offer for this goal? True when
  // any of amount / recurrence / display can be changed in place.
  // Mirror the creation modal's recurrence gating: recurrence shows for
  // gain / average / improvement goals and is hidden for target / rank / player
  // (and rival). New goals carry an explicit supportsRecurrence flag; older
  // goals fall back to detecting the no-recurrence modes by their marker fields.
  function goalSupportsRecurrence(g) {
    if (!g) return false;
    if (typeof g.supportsRecurrence === "boolean") return g.supportsRecurrence;
    if (g.mode === "target") return false;                       // improvement-Target
    if (g.targetRank != null || g.nextRank) return false;        // rank
    if (g.targetUsername != null) return false;                  // player
    if (g.maxQuotes || g.maxChars) return false;                 // max (target mode)
    if (g.quoteCharsAbsoluteTarget != null) return false;        // quote-chars absolute
    return typeof g.recurrence === "string";
  }
  function goalIsEditable(type, g) {
    if (!g) return false;
    return goalAmountEditable(g)
      || goalSupportsRecurrence(g)
      || goalHasToggleableLine(type, g)
      || goalIsAverage(g);
  }

  // ── Per-goal edit popover ─────────────────────
  // Generalizes the count-view popover: one header button opens a small anchored
  // editor for the goal's in-place-tunable settings — amount, recurrence, and
  // display (X / Y vs Z to go). Identity settings (type, mode, filters,
  // requirements, rival / player target) are deliberately NOT here: changing
  // those would redefine the goal, so they stay creation-only. Changing the
  // recurrence resets the streak / completions (a daily streak isn't a weekly
  // one), with an inline confirm when there's progress to lose.
  let goalEditPopoverEl = null;
  function closeGoalEditPopover() {
    if (goalEditPopoverEl) {
      goalEditPopoverEl.remove();
      goalEditPopoverEl = null;
    }
    document.removeEventListener("mousedown", onGoalEditDocDown, true);
    document.removeEventListener("keydown", onGoalEditKey, true);
    window.removeEventListener("scroll", onGoalEditScroll, true);
    window.removeEventListener("resize", closeGoalEditPopover, true);
  }
  function onGoalEditDocDown(e) {
    if (!goalEditPopoverEl) return;
    if (goalEditPopoverEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".gt-view-toggle-btn")) return;
    closeGoalEditPopover();
  }
  function onGoalEditKey(e) {
    if (e.key === "Escape") closeGoalEditPopover();
  }
  // Close on a genuine PAGE scroll only. The capture-phase listener also sees
  // scrolls from inner containers and from TypeGG's own scrolling elements; a
  // background re-render (stat poll, rival/target quote change, countdown) can
  // clamp a card container's scrollTop and fire a spurious scroll that must NOT
  // dismiss an open editor. Only a scroll whose target is the document / root is
  // the user scrolling the page itself.
  function onGoalEditScroll(e) {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.scrollingElement) {
      closeGoalEditPopover();
    }
  }
  function openGoalEditPopover(type, goalId, anchorBtn) {
    const sameOpen = goalEditPopoverEl && goalEditPopoverEl.dataset.goalId === goalId;
    closeGoalEditPopover();
    if (sameOpen) return;

    const gd = (goalData[type] || []).find(g => g.id === goalId);
    if (!gd) return;

    const canAmount = goalAmountEditable(gd);
    const canRec    = goalSupportsRecurrence(gd);
    const canView   = goalHasToggleableLine(type, gd);
    const isImpTarget = (type === "improvement" && gd.mode === "target");
    const isRival = (type === "rival");
    const canAvg  = goalIsAverage(gd);
    if (!canAmount && !canRec && !canView && !isImpTarget && !isRival && !canAvg) return;

    let draftView = goalCountView(gd);

    // Improvement-Target editor (threshold + catalog filters). All per-goal
    // already; editing them re-derives standings over the cached catalog
    // (targetFilterSig picks up the change), so no re-fetch / migration needed.
    const impMetricLbl = (gd.metric === "pp") ? "PP" : "WPM";
    const impCurStatus = ["all", "ranked", "unranked"].includes(gd.status) ? gd.status : "all";
    const impCurPlayed = (gd.played === "played") ? "played" : "all";
    const impStatusBtns = [["all", "All"], ["ranked", "Ranked"], ["unranked", "Unranked"]]
      .map(([v, l]) => `<button class="gt-mode-btn${v === impCurStatus ? " active" : ""}" data-imp-status="${v}">${l}</button>`).join("");
    const impPlayedBtns = [["all", "All"], ["played", "Played"]]
      .map(([v, l]) => `<button class="gt-mode-btn${v === impCurPlayed ? " active" : ""}" data-imp-played="${v}">${l}</button>`).join("");
    const impDiffRangeId = `gt-edit-diff-range-${goalId}`, impDiffReadoutId = `gt-edit-diff-readout-${goalId}`, impDiffTicksId = `gt-edit-diff-ticks-${goalId}`;
    const impLenRangeId  = `gt-edit-len-range-${goalId}`,  impLenReadoutId  = `gt-edit-len-readout-${goalId}`,  impLenTicksId  = `gt-edit-len-ticks-${goalId}`;
    const impSlider = (rangeId, readoutId, ticksId, label, loAria, hiAria) => `
      <div class="gt-edit-label">${label}<span class="gt-range-readout" id="${readoutId}"></span></div>
      <div class="gt-range-row" id="${ticksId}">
        <span class="gt-range-end gt-range-end-lo"></span>
        <div class="gt-range" id="${rangeId}">
          <div class="gt-range-track"><div class="gt-range-fill"></div></div>
          <input class="gt-range-input gt-range-lo" type="range" aria-label="${loAria}" />
          <input class="gt-range-input gt-range-hi" type="range" aria-label="${hiAria}" />
        </div>
        <span class="gt-range-end gt-range-end-hi"></span>
      </div>`;
    const impTargetHtml = isImpTarget ? `
      <div class="gt-edit-label">Target ${impMetricLbl}</div>
      <input type="number" class="gt-custom-input gt-edit-amount gt-edit-threshold" value="${gd.target}" min="1" step="1">
      <div class="gt-edit-label">Status</div>
      <div class="gt-edit-rec-group">${impStatusBtns}</div>
      <div class="gt-edit-label">Quotes</div>
      <div class="gt-edit-rec-group">${impPlayedBtns}</div>
      ${impSlider(impDiffRangeId, impDiffReadoutId, impDiffTicksId, "Difficulty filter", "Minimum difficulty", "Maximum difficulty")}
      ${impSlider(impLenRangeId, impLenReadoutId, impLenTicksId, "Quote length filter", "Minimum length", "Maximum length")}
    ` : "";

    // ── Rival editor (per-goal filters: metric / scope / shared / ranges) ──
    // Mirrors the improvement-target editor: each control auto-applies, then
    // re-derives the standings over the cached per-rival stores (no re-fetch).
    const rvCfg = isRival ? goalRivalCfg(gd) : null;
    const rvMetricCur = isRival ? rivalMetric(rvCfg) : "wpm";
    const rvScopeCur  = isRival ? rivalScope(rvCfg)  : "all";
    const rvBothCur   = !!(rvCfg && rvCfg.requireBoth);
    const rvMetricBtns = [["wpm", "WPM"], ["pp", "PP"]]
      .map(([v, l]) => `<button class="gt-mode-btn${v === rvMetricCur ? " active" : ""}" data-rv-metric="${v}">${l}</button>`).join("");
    const rvScopeBtns = [["all", "All"], ["ranked", "Ranked"], ["unranked", "Unranked"]]
      .map(([v, l]) => `<button class="gt-mode-btn${v === rvScopeCur ? " active" : ""}" data-rv-scope="${v}">${l}</button>`).join("");
    const rvBothBtns = [["false", "All quotes"], ["true", "Shared only"]]
      .map(([v, l]) => `<button class="gt-mode-btn${(v === "true") === rvBothCur ? " active" : ""}" data-rv-both="${v}">${l}</button>`).join("");
    const rvDiffRangeId = `gt-edit-rdiff-range-${goalId}`, rvDiffReadoutId = `gt-edit-rdiff-readout-${goalId}`, rvDiffTicksId = `gt-edit-rdiff-ticks-${goalId}`;
    const rvLenRangeId  = `gt-edit-rlen-range-${goalId}`,  rvLenReadoutId  = `gt-edit-rlen-readout-${goalId}`,  rvLenTicksId  = `gt-edit-rlen-ticks-${goalId}`;
    const rvBandRangeId = `gt-edit-rband-range-${goalId}`, rvBandReadoutId = `gt-edit-rband-readout-${goalId}`, rvBandTicksId = `gt-edit-rband-ticks-${goalId}`;
    const rivalEditHtml = isRival ? `
      <div class="gt-edit-label">Metric</div>
      <div class="gt-edit-rec-group">${rvMetricBtns}</div>
      <div class="gt-edit-label">Scope</div>
      <div class="gt-edit-rec-group">${rvScopeBtns}</div>
      <div class="gt-edit-label">Compare on</div>
      <div class="gt-edit-rec-group">${rvBothBtns}</div>
      ${impSlider(rvDiffRangeId, rvDiffReadoutId, rvDiffTicksId, "Difficulty filter", "Minimum difficulty", "Maximum difficulty")}
      ${impSlider(rvLenRangeId, rvLenReadoutId, rvLenTicksId, "Quote length filter", "Minimum length", "Maximum length")}
      <div class="gt-edit-label"><span class="gt-edit-rband-label">Rival ${rvMetricCur.toUpperCase()} filter</span><span class="gt-range-readout" id="${rvBandReadoutId}"></span></div>
      <div class="gt-range-row" id="${rvBandTicksId}">
        <span class="gt-range-end gt-range-end-lo"></span>
        <div class="gt-range" id="${rvBandRangeId}">
          <div class="gt-range-track"><div class="gt-range-fill"></div></div>
          <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum rival value" />
          <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum rival value" />
        </div>
        <span class="gt-range-end gt-range-end-hi"></span>
      </div>
    ` : "";

    // ── Average editor (rolling-avg race goals: target + window) ──
    // Both controls apply in place. Target re-checks the sticky
    // completion flag; window resizes the rolling buffer (hiding the
    // best while it refills under-full) and then re-checks completion.
    // Neither re-fetches — they operate on the stored window.
    const avgMetricLbl  = canAvg ? metricLabel(gd.metric) : "";
    const avgTargetStep = (gd.metric === "accuracy") ? "0.1" : "1";
    const avgTargetMax  = (gd.metric === "accuracy") ? ` max="100"` : "";
    const avgEditHtml = canAvg ? `
      <div class="gt-edit-label">Target ${avgMetricLbl}${gd.metric === "accuracy" ? " (%)" : ""}</div>
      <input type="number" class="gt-custom-input gt-edit-avg-target" value="${gd.targetAvg}" min="1"${avgTargetMax} step="${avgTargetStep}">
      <div class="gt-edit-label">Rolling window (races)</div>
      <input type="number" class="gt-custom-input gt-edit-avg-window" value="${gd.windowSize}" min="1" step="1">
    ` : "";

    const recOrder = ["none", "daily", "weekly", "monthly"];
    const recLabel = (r) => (r === "none") ? "None" : (REC_LABELS[r] || r);
    const curRec = canRec ? (gd.recurrence || "none") : "none";
    const recBtnsHtml = canRec ? recOrder.map(r =>
      `<button class="gt-mode-btn${r === curRec ? " active" : ""}" data-rec-opt="${r}">${recLabel(r)}</button>`
    ).join("") : "";
    const recResettable = canRec && ((gd.streak > 0) || (gd.totalCompletions > 0));

    const pop = document.createElement("div");
    pop.className = "gt-view-popover gt-edit-popover" + ((isImpTarget || isRival) ? " gt-edit-popover-wide" : "");
    pop.dataset.goalId = goalId;
    pop.innerHTML = `
      <div class="gt-view-popover-title">Edit goal<span class="gt-settings-saved-indicator gt-edit-saved">Settings saved</span><button class="gt-edit-close" type="button" title="Close" aria-label="Close">×</button></div>
      ${impTargetHtml}
      ${rivalEditHtml}
      ${avgEditHtml}
      ${canAmount ? `<div class="gt-edit-label">Amount</div><input type="number" class="gt-custom-input gt-edit-amount" value="${gd.target}" min="1" step="1">` : ""}
      ${canRec ? `<div class="gt-edit-label">Recurrence</div><div class="gt-edit-rec-group">${recBtnsHtml}</div>${recResettable ? `<div class="gt-edit-note">Changing this resets the streak & completions.</div>` : ""}` : ""}
      ${canView ? `<div class="gt-edit-label">Display Format</div><div class="gt-edit-view-group"><button class="gt-mode-btn gt-edit-view-btn${draftView === "progress" ? " active" : ""}" data-view="progress">Progress</button><button class="gt-mode-btn gt-edit-view-btn${draftView === "remaining" ? " active" : ""}" data-view="remaining">Remaining</button></div>` : ""}
    `;

    const amountInput = pop.querySelector(".gt-edit-amount");
    const savedEl     = pop.querySelector(".gt-edit-saved");
    let savedTimer = null;
    function flashSaved() {
      if (!savedEl) return;
      savedEl.classList.add("visible");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => savedEl.classList.remove("visible"), 1500);
    }
    pop.querySelector(".gt-edit-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeGoalEditPopover();
    });

    // Amount: apply in place — debounced while typing, immediate on blur / Enter.
    // The popover lives on document.body (position:fixed), so re-rendering the
    // cards behind it neither closes it nor steals input focus.
    let amountTimer = null;
    function applyAmount() {
      if (!canAmount || !amountInput) return;
      const v = parseInt(amountInput.value, 10);
      if (!Number.isFinite(v) || v <= 0 || v === gd.target) return;
      gd.target = v;
      saveGoals(type);
      renderAllGoals();
      flashSaved();
    }
    if (amountInput) {
      amountInput.addEventListener("input", () => {
        clearTimeout(amountTimer);
        amountTimer = setTimeout(applyAmount, 400);
      });
      amountInput.addEventListener("change", () => { clearTimeout(amountTimer); applyAmount(); });
      amountInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(amountTimer); applyAmount(); }
      });
    }

    // Recurrence: apply immediately on pick. A type change resets the streak /
    // completions (a daily streak isn't a weekly one); the note forewarns when
    // there's progress to lose, then is removed once the reset has happened.
    pop.querySelectorAll("[data-rec-opt]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = btn.dataset.recOpt;
        if (val === (gd.recurrence || "none")) return;
        pop.querySelectorAll("[data-rec-opt]").forEach(b => b.classList.toggle("active", b === btn));
        gd.recurrence  = val;
        gd.periodStart = (val === "none") ? null : getCurrentPeriodStart(val);
        gd.streak = 0;
        gd.totalCompletions = 0;
        gd.completedThisPeriod = false;
        const note = pop.querySelector(".gt-edit-note");
        if (note) note.remove();
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      });
    });

    // Display: apply immediately on pick.
    pop.querySelectorAll(".gt-edit-view-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        draftView = btn.dataset.view;
        pop.querySelectorAll(".gt-edit-view-btn").forEach(b => b.classList.toggle("active", b === btn));
        gd.countView = (draftView === "remaining") ? "remaining" : "progress";
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      });
    });

    // Average controls: target (re-checks completion) and rolling window
    // (resizes the buffer, hides best while under-full, re-checks completion).
    if (canAvg) {
      const avgTargetInput = pop.querySelector(".gt-edit-avg-target");
      const avgWindowInput = pop.querySelector(".gt-edit-avg-window");
      let avgTargetTimer = null, avgWindowTimer = null;
      const applyAvgTarget = () => {
        if (!avgTargetInput) return;
        const v = parseFloat(avgTargetInput.value);
        if (!Number.isFinite(v) || v <= 0) return;
        if (gd.metric === "accuracy" && v > 100) return;
        if (v === gd.targetAvg) return;
        gd.targetAvg = v;
        reconcileAvgCompletion(gd);
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      };
      const applyAvgWindow = () => {
        if (!avgWindowInput) return;
        const w = parseInt(avgWindowInput.value, 10);
        if (!Number.isFinite(w) || w <= 0 || w === gd.windowSize) return;
        resizeAvgWindow(gd, w);
        reconcileAvgCompletion(gd);
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      };
      if (avgTargetInput) {
        avgTargetInput.addEventListener("input",  () => { clearTimeout(avgTargetTimer); avgTargetTimer = setTimeout(applyAvgTarget, 400); });
        avgTargetInput.addEventListener("change", () => { clearTimeout(avgTargetTimer); applyAvgTarget(); });
        avgTargetInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(avgTargetTimer); applyAvgTarget(); } });
      }
      if (avgWindowInput) {
        avgWindowInput.addEventListener("input",  () => { clearTimeout(avgWindowTimer); avgWindowTimer = setTimeout(applyAvgWindow, 400); });
        avgWindowInput.addEventListener("change", () => { clearTimeout(avgWindowTimer); applyAvgWindow(); });
        avgWindowInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(avgWindowTimer); applyAvgWindow(); } });
      }
    }

    // Improvement-Target controls: threshold (number), status / played (toggles),
    // and difficulty / length ranges (min-max; blank = open end). Each applies in
    // place and re-derives the standings over the cached catalog.
    if (isImpTarget) {
      const thr = pop.querySelector(".gt-edit-threshold");
      let thrTimer = null;
      const applyThreshold = () => {
        if (!thr) return;
        const v = parseInt(thr.value, 10);
        if (!Number.isFinite(v) || v <= 0 || v === gd.target) return;
        gd.target = v;
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      };
      if (thr) {
        thr.addEventListener("input", () => { clearTimeout(thrTimer); thrTimer = setTimeout(applyThreshold, 400); });
        thr.addEventListener("change", () => { clearTimeout(thrTimer); applyThreshold(); });
        thr.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(thrTimer); applyThreshold(); } });
      }
      let impTimer = null;
      const scheduleImpApply = () => {
        clearTimeout(impTimer);
        impTimer = setTimeout(() => { saveGoals(type); renderAllGoals(); flashSaved(); }, 250);
      };
      // Build / rebuild the difficulty + length sliders from the live catalog
      // axis for this goal's status/played, reusing the creation-modal slider
      // component (setupTargetRange). The set() callback writes the gd handles
      // and schedules a debounced re-derive (sliders fire continuously on drag).
      const buildImpSliders = () => {
        const axis = catalogAxis(gd.status || "all", gd.played || "all");
        const clampD = (v) => Math.max(axis.diffMin, Math.min(axis.diffMax, v));
        const clampL = (v) => Math.max(axis.lenMin,  Math.min(axis.lenMax,  v));
        const dLo = gd.diffMin == null ? axis.diffMin : clampD(gd.diffMin);
        const dHi = gd.diffMax == null ? axis.diffMax : clampD(gd.diffMax);
        const lLo = gd.lenMin  == null ? axis.lenMin  : clampL(gd.lenMin);
        const lHi = gd.lenMax  == null ? axis.lenMax  : clampL(gd.lenMax);
        setupTargetRange(impDiffRangeId, impDiffReadoutId, impDiffTicksId, {
          min: axis.diffMin, max: axis.diffMax, step: 0.1, decimals: true,
          ticks: [String(axis.diffMin), `${axis.diffMax}+`], lo: dLo, hi: dHi,
          set: (lo, hi) => { gd.diffMin = lo; gd.diffMax = hi; scheduleImpApply(); },
        });
        setupTargetRange(impLenRangeId, impLenReadoutId, impLenTicksId, {
          min: axis.lenMin, max: axis.lenMax, step: 1, decimals: false,
          ticks: [String(axis.lenMin), `${axis.lenMax}+`], lo: lLo, hi: lHi,
          set: (lo, hi) => { gd.lenMin = lo; gd.lenMax = hi; scheduleImpApply(); },
        });
      };
      // Status / Played change the catalog axis, so reset the handles to full
      // range and rebuild the sliders (mirrors the creation modal).
      const onImpPoolChange = () => {
        gd.diffMin = gd.diffMax = gd.lenMin = gd.lenMax = null;
        buildImpSliders();
        saveGoals(type);
        renderAllGoals();
        flashSaved();
      };
      pop.querySelectorAll("[data-imp-status]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.impStatus;
          if (val === (gd.status || "all")) return;
          pop.querySelectorAll("[data-imp-status]").forEach(b => b.classList.toggle("active", b === btn));
          gd.status = val;
          onImpPoolChange();
        });
      });
      pop.querySelectorAll("[data-imp-played]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.impPlayed;
          if (val === (gd.played || "all")) return;
          pop.querySelectorAll("[data-imp-played]").forEach(b => b.classList.toggle("active", b === btn));
          gd.played = val;
          onImpPoolChange();
        });
      });
      // Initial build, deferred so the popover is attached (sliders bind by id).
      requestAnimationFrame(buildImpSliders);
    }

    // Rival controls: metric / scope / compare-on toggles + difficulty / length
    // / rival-value sliders. Each writes through to gd.rivalSettings and re-tally
    // (saveGoals + renderAllGoals) — never a re-fetch, since the per-rival stores
    // already hold every quote (status=any) with both metrics + d/l/r meta.
    if (isRival) {
      const rs = gd.rivalSettings || (gd.rivalSettings = defaultRivalGoalSettings());
      let rvTimer = null;
      const scheduleRvApply = () => {
        clearTimeout(rvTimer);
        rvTimer = setTimeout(() => { saveGoals("rival"); renderAllGoals(); flashSaved(); }, 250);
      };
      const applyRvNow = () => { saveGoals("rival"); renderAllGoals(); flashSaved(); };
      // (Re)build all three sliders from the live per-goal axes, resolving the
      // stored handles against them (null = open end). Rebuilt on a metric /
      // scope / compare-on change because those move the axis bounds (and metric
      // switches which band handles apply); the stored handles are preserved and
      // simply clamped, mirroring the old global panel.
      const buildRivalSliders = () => {
        const fAxis = rivalFilterAxis(rs, gd);
        const mAxis = rivalMetricAxis(rs, gd);
        const mk = rivalMetricKeys(rs);
        const clampD = (v) => Math.max(fAxis.diffMin, Math.min(fAxis.diffMax, v));
        const clampL = (v) => Math.max(fAxis.lenMin,  Math.min(fAxis.lenMax,  v));
        const clampR = (v) => Math.max(mAxis.rivalMin, Math.min(mAxis.rivalMax, v));
        const dLo = rs.diffMin == null ? fAxis.diffMin : clampD(rs.diffMin);
        const dHi = rs.diffMax == null ? fAxis.diffMax : clampD(rs.diffMax);
        const lLo = rs.lenMin  == null ? fAxis.lenMin  : clampL(rs.lenMin);
        const lHi = rs.lenMax  == null ? fAxis.lenMax  : clampL(rs.lenMax);
        const rLo = rs[mk.rMin] == null ? mAxis.rivalMin : clampR(rs[mk.rMin]);
        const rHi = rs[mk.rMax] == null ? mAxis.rivalMax : clampR(rs[mk.rMax]);
        setupTargetRange(rvDiffRangeId, rvDiffReadoutId, rvDiffTicksId, {
          min: fAxis.diffMin, max: fAxis.diffMax, step: 0.1, decimals: true,
          ticks: [String(fAxis.diffMin), `${fAxis.diffMax}+`], lo: dLo, hi: dHi,
          set: (lo, hi) => { rs.diffMin = lo; rs.diffMax = hi; scheduleRvApply(); },
        });
        setupTargetRange(rvLenRangeId, rvLenReadoutId, rvLenTicksId, {
          min: fAxis.lenMin, max: fAxis.lenMax, step: 1, decimals: false,
          ticks: [String(fAxis.lenMin), `${fAxis.lenMax}+`], lo: lLo, hi: lHi,
          set: (lo, hi) => { rs.lenMin = lo; rs.lenMax = hi; scheduleRvApply(); },
        });
        setupTargetRange(rvBandRangeId, rvBandReadoutId, rvBandTicksId, {
          min: mAxis.rivalMin, max: mAxis.rivalMax, step: 1, decimals: false,
          ticks: [String(mAxis.rivalMin), `${mAxis.rivalMax}+`], lo: rLo, hi: rHi,
          set: (lo, hi) => { const k = rivalMetricKeys(rs); rs[k.rMin] = lo; rs[k.rMax] = hi; scheduleRvApply(); },
        });
      };
      pop.querySelectorAll("[data-rv-metric]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.rvMetric === "pp" ? "pp" : "wpm";
          if (val === rivalMetric(rs)) return;
          pop.querySelectorAll("[data-rv-metric]").forEach(b => b.classList.toggle("active", b === btn));
          rs.metric = val;
          const lbl = pop.querySelector(".gt-edit-rband-label");
          if (lbl) lbl.textContent = `Rival ${val.toUpperCase()} filter`;
          buildRivalSliders(); // band axis + which handles apply both depend on metric
          applyRvNow();
        });
      });
      pop.querySelectorAll("[data-rv-scope]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.rvScope;
          if (val === rivalScope(rs)) return;
          pop.querySelectorAll("[data-rv-scope]").forEach(b => b.classList.toggle("active", b === btn));
          rs.scope = val;
          buildRivalSliders(); // scope shifts every axis bound
          applyRvNow();
        });
      });
      pop.querySelectorAll("[data-rv-both]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const val = btn.dataset.rvBoth === "true";
          if (val === !!rs.requireBoth) return;
          pop.querySelectorAll("[data-rv-both]").forEach(b => b.classList.toggle("active", b === btn));
          rs.requireBoth = val;
          buildRivalSliders(); // shared-only narrows the data pool -> axis
          applyRvNow();
        });
      });
      // Initial build, deferred so the popover is attached (sliders bind by id).
      requestAnimationFrame(buildRivalSliders);
    }

    document.body.appendChild(pop);
    goalEditPopoverEl = pop;

    // Anchor (fixed) beside the card, mirroring the count-view popover.
    const btnRect = anchorBtn.getBoundingClientRect();
    const cardEl = anchorBtn.closest(".gt-goal-section");
    const cardRect = cardEl ? cardEl.getBoundingClientRect() : btnRect;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const gap = 8;
    let left;
    if (cardRect.right + gap + pw <= window.innerWidth - 8) {
      left = cardRect.right + gap;
    } else if (cardRect.left - gap - pw >= 8) {
      left = cardRect.left - gap - pw;
    } else {
      left = (cardRect.left > window.innerWidth - cardRect.right)
        ? Math.max(8, cardRect.left - gap - pw)
        : Math.min(window.innerWidth - 8 - pw, cardRect.right + gap);
    }
    let top = btnRect.top;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - 8 - ph;
    if (top < 8) top = 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;

    document.addEventListener("mousedown", onGoalEditDocDown, true);
    document.addEventListener("keydown", onGoalEditKey, true);
    window.addEventListener("scroll", onGoalEditScroll, true);
    window.addEventListener("resize", closeGoalEditPopover, true);

    if (amountInput) { amountInput.focus(); amountInput.select(); }
  }

  // ── Z-ordering for widgets ─────────────────────────────────────
  // All widgets share z-index 9998 (via CSS). To raise a widget above
  // others, we move it to end-of-body so it paints last among siblings.
  // This avoids fighting z-index against the modal overlay (z 9999).
  function bringWidgetToFront(widgetEl) {
    if (widgetEl.parentNode === document.body) document.body.appendChild(widgetEl);
  }

  // ── Detached widget factory ───────────────────────────────────
  function createDetachedWidget(groupId, position) {
    const w = document.createElement("div");
    w.className = "gt-widget gt-widget-detached";
    w.dataset.groupId = groupId;
    w.innerHTML = `<div class="gt-content"></div>`;
    // Position is applied by applyWidgetTransform() below (ratio-projected +
    // clamped on-screen); `position` is kept on the group and read from there.
    document.body.appendChild(w);
    wireWidgetDrag(w, groupId);
    bringWidgetToFront(w);
    // Restore persisted size (no-op if width was never customized) and
    // start tracking future resizes so the new width survives reload.
    applyWidgetTransform(w, groupId);
    observeWidgetResize(w, groupId);
    // Apply the .gt-widget-has-avg class right away if this group
    // already holds an avg goal — otherwise the widget would render
    // at the default 180px min-width and only snap up to 220px on the
    // next renderAllGoals tick. That gap was visible to users when
    // dragging a goal out into a new widget: they could resize below
    // the proper min-width briefly before it auto-corrected.
    updateWidgetAvgClass(groupId);
    return w;
  }

  // ── Viewport-relative widget positioning ──────────────
  // Widget positions persist as FRACTIONS of the free space (xRatio/yRatio in
  // [0,1]) rather than absolute pixels, so a widget keeps its spot relative to
  // the window when you resize OR zoom the page — both change the layout
  // viewport's size in CSS px. xRatio 1 = pinned to the right edge, 0.5 = centred,
  // 0 = left edge (same for y); projecting that onto the current viewport keeps
  // top-right in the top-right, centre centred, and everything on-screen. The main
  // widget with NO stored position keeps the CSS top-right anchor (already tracks
  // the corner). Legacy { left:"123px", top:"45px" } positions migrate on first use.
  function gtViewport() {
    const de = document.documentElement;
    return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight };
  }
  function gtClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  // A widget's CURRENT on-screen rect → { xRatio, yRatio }.
  //   xRatio: position within the free horizontal space (viewport − widget), so
  //           0 = left edge, 1 = right edge — this pins the L/R corner on zoom.
  //   yRatio: top as a fraction of the VIEWPORT height (top / vh), NOT the free
  //           space. This is height-INDEPENDENT on purpose: re-projecting it
  //           after the widget grows/shrinks (a goal added/removed) gives the
  //           same top, so the top border never creeps as goals change. The top
  //           is clamped on apply so a tall widget still can't run off-screen.
  function widgetPositionRatio(widgetEl) {
    const { w: vw, h: vh } = gtViewport();
    const r = widgetEl.getBoundingClientRect();
    const availX = Math.max(1, vw - r.width);
    return { xRatio: gtClamp(r.left / availX, 0, 1), yRatio: gtClamp(r.top / vh, 0, 1) };
  }
  // Normalize a stored position to { xRatio, yRatio }, migrating the legacy pixel
  // format in place (read relative to the current viewport; exact again after the
  // next drag). null when there's nothing usable (e.g. the main default).
  function normalizeGroupPositionRatio(group, widgetEl) {
    const p = group?.position;
    if (!p) return null;
    if (typeof p.xRatio === "number" && typeof p.yRatio === "number") return p;
    const left = parseFloat(p.left), top = parseFloat(p.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const { w: vw, h: vh } = gtViewport();
    const availX = Math.max(1, vw - widgetEl.offsetWidth);
    const ratio = { xRatio: gtClamp(left / availX, 0, 1), yRatio: gtClamp(top / vh, 0, 1) };
    group.position = ratio; // migrate in place
    saveGroups();
    return ratio;
  }
  // Project a stored ratio onto the current viewport → clamped pixel left/top.
  // x: free-space (corner-pinned). y: top = yRatio*vh, then clamped so the widget
  // stays fully on-screen — height only enters here, as a clamp, never as drift.
  function applyWidgetPositionRatio(widgetEl, ratio) {
    if (!ratio) return;
    const { w: vw, h: vh } = gtViewport();
    const availX = Math.max(0, vw - widgetEl.offsetWidth);
    const maxTop = Math.max(0, vh - widgetEl.offsetHeight);
    widgetEl.style.right = "auto";
    widgetEl.style.left  = Math.round(gtClamp(ratio.xRatio * availX, 0, availX)) + "px";
    widgetEl.style.top   = Math.round(gtClamp(ratio.yRatio * vh, 0, maxTop)) + "px";
  }

  // ── Apply position / size from groupData to a widget ──────────
  function applyWidgetTransform(widgetEl, groupId) {
    const group = groupData[groupId];
    if (!group) return;
    // Width first so offsetWidth is correct when we project the position ratio.
    if (group.size?.width) widgetEl.style.width = group.size.width;
    applyWidgetPositionRatio(widgetEl, normalizeGroupPositionRatio(group, widgetEl));
  }

  // ── Restore main widget position / width from stored group ────
  applyWidgetTransform(container, MAIN_GROUP_ID);

  // ── Widget drag (any widget — main or detached) ───────────────
  // Main widget: drag starts from the header bar.
  // Detached widget: no header; drag starts from any non-goal edge of
  //   the widget itself (the padding around the content).
  //
  // State is hoisted to module scope (rather than captured in wireWidgetDrag's
  // closure) so the goal-drag code can programmatically start a widget-drag:
  // when a goal is the sole occupant of a detached widget, grabbing the goal
  // should drag the whole widget, not initiate a goal-float.
  let wDrag = null; // null or { widgetEl, groupId, offX, offY }

  function startWidgetDrag(widgetEl, groupId, e) {
    wDrag = { widgetEl, groupId, offX: 0, offY: 0 };
    bringWidgetToFront(widgetEl);

    const r = widgetEl.getBoundingClientRect();
    // Pin absolute position (main widget might still be using right:16px)
    widgetEl.style.right = "auto";
    widgetEl.style.left  = r.left + "px";
    widgetEl.style.top   = r.top  + "px";
    wDrag.offX = e.clientX - r.left;
    wDrag.offY = e.clientY - r.top;
    document.body.style.userSelect = "none";
  }

  function wireWidgetDrag(widgetEl, groupId) {
    const isMain = groupId === MAIN_GROUP_ID;
    const grabEl = isMain ? widgetEl.querySelector(".gt-header") : widgetEl;

    grabEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      // For detached widgets, only start drag when the press lands on the
      // widget's own padding — not inside a goal section. Without this
      // guard, every mousedown on a goal would also initiate widget drag.
      if (!isMain && e.target.closest(".gt-goal-section")) return;

      // Skip if user clicked the native CSS resize handle in the bottom-right
      // corner. The handle is roughly the bottom-right ~14×14 px area; without
      // this guard, grabbing it would resize AND start a drag at the same time.
      // Main widget doesn't need this — its drag handle is .gt-header, which
      // is far from the resize corner.
      if (!isMain) {
        const rect = widgetEl.getBoundingClientRect();
        const RESIZE_CORNER = 16;
        if (e.clientX >= rect.right  - RESIZE_CORNER &&
            e.clientY >= rect.bottom - RESIZE_CORNER) return;
      }

      e.preventDefault();
      startWidgetDrag(widgetEl, groupId, e);
    });
  }

  // Global widget-drag movement + release handlers (single listeners,
  // not duplicated per widget — startWidgetDrag just sets wDrag).
  document.addEventListener("mousemove", (e) => {
    if (!wDrag) return;
    const { widgetEl, offX, offY } = wDrag;
    const left = Math.max(0, Math.min(e.clientX - offX, window.innerWidth  - widgetEl.offsetWidth));
    const top  = Math.max(0, Math.min(e.clientY - offY, window.innerHeight - 40));
    widgetEl.style.left = left + "px";
    widgetEl.style.top  = top  + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!wDrag) return;
    const { widgetEl, groupId } = wDrag;
    document.body.style.userSelect = "";
    // Persist position on the group (if the widget / group still exists)
    if (groupData[groupId]) {
      groupData[groupId].position = widgetPositionRatio(widgetEl);
      widgetEl.dataset.gtPlaced = "1";
      saveGroups();
    }
    wDrag = null;
  });

  wireWidgetDrag(container, MAIN_GROUP_ID);

  // ── Keep widgets viewport-relative on resize / zoom ───────
  // window 'resize' fires for window resizes AND page (Ctrl +/-) zoom — both change
  // documentElement.clientWidth in CSS px. Re-project every widget's stored ratio
  // onto the new viewport so positions track the window and stay on-screen. Skipped
  // mid-drag so it can't fight an active grab; rAF-throttled against resize bursts.
  let gtRepositionRaf = 0;
  function repositionAllWidgets() {
    if (wDrag || dragInProgress) return;
    for (const widgetEl of document.querySelectorAll(".gt-widget")) {
      const group = groupData[widgetEl.dataset.groupId];
      if (!group) continue;
      applyWidgetPositionRatio(widgetEl, normalizeGroupPositionRatio(group, widgetEl));
    }
  }
  function scheduleReposition() {
    if (gtRepositionRaf) return;
    gtRepositionRaf = requestAnimationFrame(() => { gtRepositionRaf = 0; repositionAllWidgets(); });
  }
  window.addEventListener("resize", scheduleReposition);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleReposition);

  // ── Resize persistence ────────────────────────────────────────
  // Watches a widget for size changes and persists the new width to
  // its group's storage. Debounced so dragging the resize handle
  // doesn't spam saveGroups(). One observer per widget; when the
  // widget is removed from the DOM the observer becomes inert.
  function observeWidgetResize(widgetEl, groupId) {
    let t, lastH = 0;
    new ResizeObserver(() => {
      // The stored position is height-relative (a fraction of the free space =
      // viewport − widget), so the widget's own height interacts with it. Two
      // distinct height changes, handled oppositely:
      //   1. FIRST placement — a restored widget (created empty, then its goal
      //      renders in) or a just-dropped one reaching full height. RE-APPLY the
      //      stored ratio at full height so it LANDS in the right spot. Only case
      //      that should move the widget.
      //   2. LATER height change — a goal added/removed or content growth. Keep
      //      the top-left FIXED (the widget grows/shrinks downward, as the user
      //      expects) and only RE-DERIVE the stored ratio so a future zoom stays
      //      correct. Never move the widget here.
      // "Placed" is tracked on the ELEMENT, not a closure flag, and set on the
      // first populated layout regardless of whether a position exists yet — so a
      // drag (which sets the position AFTER this observer's initial fires, as the
      // main widget does) still counts as placed and won't re-apply on the next
      // goal add. (Zoom doesn't fire this — CSS-px height is zoom-invariant — so
      //  the window 'resize' listener owns zoom; this owns content changes.)
      const h = widgetEl.offsetHeight;
      if (h !== lastH) {
        lastH = h;
        const populated = !!widgetEl.querySelector(".gt-goal-section");
        if (populated && !wDrag && !dragInProgress) {
          const firstPlace = widgetEl.dataset.gtPlaced !== "1";
          widgetEl.dataset.gtPlaced = "1";
          const group = groupData[groupId];
          if (group && group.position) {
            if (firstPlace) {
              applyWidgetPositionRatio(widgetEl, normalizeGroupPositionRatio(group, widgetEl));
            } else {
              group.position = widgetPositionRatio(widgetEl); // keep top, refresh ratio
            }
          }
        }
      }
      clearTimeout(t);
      t = setTimeout(() => {
        if (!groupData[groupId]) return;
        groupData[groupId].size = { width: widgetEl.offsetWidth + "px" };
        saveGroups(); // persists width + any position ratio refreshed above
      }, 300);
    }).observe(widgetEl);
  }

  observeWidgetResize(container, MAIN_GROUP_ID);

  // ══════════════════════════════════════════════════════════════
  // Goal-level drag (individual goals)
  // ══════════════════════════════════════════════════════════════
  // Gesture:
  //   1. Mousedown on a goal section body (not on its ✕ button).
  //   2. Once the pointer has moved past DRAG_THRESHOLD_PX, a "float"
  //      mode activates: the section goes position:fixed, pointer-events
  //      are disabled on it (so elementFromPoint sees widgets underneath),
  //      and the original slot is replaced with a placeholder so the
  //      source widget doesn't visually collapse.
  //   3. During drag, the widget under the cursor is highlighted
  //      (.gt-drop-target). Within that widget, a thin indicator line
  //      shows the insertion index.
  //   4. On release, the goal is inserted at the computed index. If the
  //      drop is over empty space, a new detached widget is created at
  //      the release point containing just this goal.

  const DRAG_THRESHOLD_PX = 4;

  // Global drag state. Only one goal can be dragged at a time.
  // Shape: { goalId, section, placeholder, floatingEl, startX, startY,
  //          offX, offY, width, active, targetGroupId, targetIndex,
  //          sourceGroupId, sourceIndex, soloMode }
  let gDrag = null;

  function wireGoalDrag(sectionEl, goalId) {
    sectionEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      if (gDrag) return; // already dragging something

      const r = sectionEl.getBoundingClientRect();
      gDrag = {
        goalId,
        section: sectionEl,
        placeholder: null,
        floatingEl: null,
        startX: e.clientX,
        startY: e.clientY,
        offX: e.clientX - r.left,
        offY: e.clientY - r.top,
        width: r.width,
        active: false,
        targetGroupId: null,
        targetIndex:   null,
      };
    });
  }

  function activateGoalDrag() {
    const d = gDrag;
    const { section } = d;

    dragInProgress = true;

    // Capture source position BEFORE we mutate the DOM.
    d.sourceGroupId = findGroupIdOfGoal(d.goalId);
    const srcGroup  = d.sourceGroupId ? groupData[d.sourceGroupId] : null;
    d.sourceIndex   = srcGroup ? srcGroup.goalIds.indexOf(d.goalId) : -1;

    // ── Solo-widget mode ────────────────────────────────────────
    // If the user grabbed the ONLY goal inside a detached widget, we
    // drag the whole widget as a unit instead of extracting the goal.
    // Rationale: a detached widget with a single goal IS that goal —
    // pulling the goal out just to create a new one-goal widget
    // somewhere else is a needless split/reform. Main widget is
    // excluded (it has a header + buttons and must persist; grabbing
    // its last goal should still let you pull it into a detached widget).
    d.soloMode = d.sourceGroupId && d.sourceGroupId !== MAIN_GROUP_ID
                 && srcGroup && srcGroup.goalIds.length === 1;

    if (d.soloMode) {
      const widgetEl = widgetElForGroup(d.sourceGroupId);
      const wrect = widgetEl.getBoundingClientRect();
      // Recompute offset relative to the widget (mousedown captured it
      // relative to the goal section).
      d.offX = d.startX - wrect.left;
      d.offY = d.startY - wrect.top;
      d.floatingEl = widgetEl;

      // Prepare a placeholder for drop-target feedback. Unlike normal
      // mode, we don't insert it anywhere yet — the solo widget keeps
      // its goal inside itself while floating. The placeholder gets
      // inserted into whichever target widget the user hovers over
      // (see the solo branch in mousemove), giving the same "card
      // slides to make room for a dashed gap" feedback as normal mode.
      const placeholder = document.createElement("div");
      placeholder.className = "gt-goal-placeholder";
      placeholder.style.height = d.section.offsetHeight + "px";
      d.placeholder = placeholder;

      widgetEl.classList.add("gt-widget-dragging");
      widgetEl.style.pointerEvents = "none"; // so elementFromPoint sees through it
      bringWidgetToFront(widgetEl);

      d.active = true;
      document.body.style.userSelect = "none";
      document.body.classList.add("gt-dragging");
      return;
    }

    // ── Normal goal drag ────────────────────────────────────────
    // Insert placeholder where the section sat. The placeholder IS
    // the "gap" shown to the user — dashed outline, same size as the
    // goal. It moves around as the user hovers different drop slots,
    // and surrounding goals animate to accommodate it (see setPlaceholderAt).
    const placeholder = document.createElement("div");
    placeholder.className = "gt-goal-placeholder";
    placeholder.style.height = section.offsetHeight + "px";
    section.parentNode.insertBefore(placeholder, section);
    d.placeholder = placeholder;

    // Float the section
    section.classList.add("gt-goal-dragging");
    section.style.width = d.width + "px";
    section.style.position = "fixed";
    // Append to body so it can position anywhere without clipping
    document.body.appendChild(section);

    d.active = true;
    document.body.style.userSelect = "none";
    document.body.classList.add("gt-dragging");
  }

  // ── FLIP animation helper ─────────────────────────────────────
  // "First-Last-Invert-Play": the standard technique for animating
  // layout-level DOM changes.
  //   1. FIRST: caller captures bounding rects of anything that may
  //      move, BEFORE mutating the DOM.
  //   2. LAST: caller mutates the DOM (reorders / removes / adds).
  //   3. INVERT + PLAY (below): for each captured element, compute the
  //      delta between its old and new positions, apply a transform
  //      that puts it back at the old position, then transition to
  //      identity. The browser animates it into its final slot.
  //
  // We animate both goal sections AND placeholders so the dashed gap
  // appears to slide when it moves between slots, rather than teleporting.
  const FLIP_DURATION_MS = 180;
  const FLIP_EASING = "cubic-bezier(0.2, 0.8, 0.3, 1)";

  function captureFlipRects(containers) {
    const rects = new Map();
    for (const container of containers) {
      if (!container) continue;
      container.querySelectorAll(".gt-goal-section, .gt-goal-placeholder")
        .forEach(el => { if (!rects.has(el)) rects.set(el, el.getBoundingClientRect()); });
    }
    return rects;
  }

  function playFlip(firstRects, duration = FLIP_DURATION_MS) {
    for (const [el, first] of firstRects) {
      // Skip the floating goal — it's position:fixed at the cursor, so
      // "movement" in flow terms is meaningless for it.
      if (el.classList.contains("gt-goal-dragging")) continue;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top  - last.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = "none";
      el.style.transform  = `translate(${dx}px, ${dy}px)`;
      // Force a reflow so the transform is committed BEFORE the
      // next step re-enables transitions. Without this, both changes
      // batch and no animation plays.
      void el.offsetHeight;
      el.style.transition = `transform ${duration}ms ${FLIP_EASING}`;
      el.style.transform  = "";
      // Clear transition after it completes so later layout changes
      // don't unintentionally animate.
      setTimeout(() => {
        if (el.style.transform === "") el.style.transition = "";
      }, duration + 30);
    }
  }

  // ── Placeholder placement ─────────────────────────────────────
  // Move the drag placeholder to (contentEl, index). Null contentEl
  // detaches the placeholder entirely (hovering over empty space).
  // Surrounding goal cards slide smoothly via FLIP.
  //
  // index is in the "pruned" frame — i.e. position among non-placeholder
  // children. This matches computeInsertionIndex's output.
  function setPlaceholderAt(contentEl, index) {
    const d = gDrag;
    if (!d?.placeholder) return;
    const placeholder = d.placeholder;
    const oldParent = placeholder.parentNode;

    // Early-out: placeholder is already exactly where we want it.
    if (contentEl && oldParent === contentEl) {
      const kids = Array.from(contentEl.children);
      const phDomIdx = kids.indexOf(placeholder);
      const prunedIdxOfPh = kids.slice(0, phDomIdx)
        .filter(c => !c.classList.contains("gt-goal-placeholder")).length;
      if (prunedIdxOfPh === index) return;
    }
    if (!contentEl && !oldParent) return; // nothing to do

    // FIRST: capture rects of everything in both containers
    const firstRects = captureFlipRects([oldParent, contentEl]);

    // LAST: mutate the DOM
    if (oldParent) oldParent.removeChild(placeholder);
    if (contentEl) {
      const nonPh = Array.from(contentEl.children)
        .filter(c => !c.classList.contains("gt-goal-placeholder"));
      if (index >= nonPh.length) contentEl.appendChild(placeholder);
      else                       contentEl.insertBefore(placeholder, nonPh[index]);
    }

    // PLAY
    playFlip(firstRects);
  }

  // Given a pointer Y and a widget's content element, return the index
  // where the dragged goal should be inserted. Excludes placeholders —
  // the returned index is in the pruned frame, same as setPlaceholderAt.
  function computeInsertionIndex(contentEl, clientY) {
    const children = Array.from(contentEl.children).filter(c =>
      !c.classList.contains("gt-goal-placeholder")
    );
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return children.length;
  }

  // Find the widget under a given screen point. Returns { widgetEl, groupId } or null.
  function findWidgetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const widgetEl = el.closest(".gt-widget");
    if (!widgetEl) return null;
    const gid = widgetEl.dataset.groupId;
    return gid ? { widgetEl, groupId: gid } : null;
  }

  document.addEventListener("mousemove", (e) => {
    const d = gDrag;
    if (!d) return;

    // Threshold gate
    if (!d.active) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      activateGoalDrag();
    }

    // ── Solo mode: move the whole widget with the cursor ────────
    if (d.soloMode) {
      d.floatingEl.style.right = "auto";
      d.floatingEl.style.left  = (e.clientX - d.offX) + "px";
      d.floatingEl.style.top   = (e.clientY - d.offY) + "px";

      // Target detection: is the cursor over a DIFFERENT widget?
      // (pointer-events: none on the floating widget means it won't
      // shadow itself in elementFromPoint.)
      const hit = findWidgetAt(e.clientX, e.clientY);
      document.querySelectorAll(".gt-drop-target").forEach(el => el.classList.remove("gt-drop-target"));
      if (hit && hit.groupId !== d.sourceGroupId) {
        hit.widgetEl.classList.add("gt-drop-target");
        const contentEl = hit.widgetEl.querySelector(".gt-content");
        const idx = computeInsertionIndex(contentEl, e.clientY);
        d.targetGroupId = hit.groupId;
        d.targetIndex   = idx;
        // Insert the placeholder into the target's slot. On first
        // insertion, the target's cards FLIP-slide to make room; on
        // subsequent moves within the target, the placeholder itself
        // FLIP-slides to the new slot.
        setPlaceholderAt(contentEl, idx);
      } else {
        d.targetGroupId = null;
        d.targetIndex   = null;
        // Moved off any target (or over the source itself): detach the
        // placeholder so the previously-hovered widget's cards close
        // their gap again.
        setPlaceholderAt(null, null);
      }
      return;
    }

    // ── Normal goal drag ────────────────────────────────────────
    // Position the floating section at the cursor
    d.section.style.left = (e.clientX - d.offX) + "px";
    d.section.style.top  = (e.clientY - d.offY) + "px";

    const hit = findWidgetAt(e.clientX, e.clientY);
    document.querySelectorAll(".gt-drop-target").forEach(el => el.classList.remove("gt-drop-target"));

    if (hit) {
      hit.widgetEl.classList.add("gt-drop-target");
      const contentEl = hit.widgetEl.querySelector(".gt-content");
      const idx = computeInsertionIndex(contentEl, e.clientY);
      d.targetGroupId = hit.groupId;
      d.targetIndex   = idx;
      // Gap-shift: move the placeholder to this slot. Surrounding
      // goal cards animate out of the way via FLIP.
      setPlaceholderAt(contentEl, idx);
    } else {
      d.targetGroupId = null;
      d.targetIndex   = null;
      // Hovering over empty space: detach the placeholder; source
      // widget's remaining cards slide up to close the gap.
      setPlaceholderAt(null, null);
    }
  });

  document.addEventListener("mouseup", (e) => {
    const d = gDrag;
    if (!d) return;
    if (!d.active) { gDrag = null; return; } // click without drag

    document.body.style.userSelect = "";
    document.querySelectorAll(".gt-drop-target").forEach(el => el.classList.remove("gt-drop-target"));

    try {
      // ── Solo-widget mode drop ──────────────────────────────────
      // The whole widget was floating, not the goal. Two outcomes:
      //   • Cursor over a different widget → merge (transfer goal,
      //     destroy the floating widget). Goal section snap-animates
      //     from its position inside the floating widget to the final
      //     slot in the target.
      //   • Cursor over empty space or nothing → just save new position.
      if (d.soloMode) {
        const widgetEl = d.floatingEl;
        widgetEl.classList.remove("gt-widget-dragging");
        widgetEl.style.pointerEvents = "";

        if (d.targetGroupId && d.targetGroupId !== d.sourceGroupId) {
          // MERGE
          const goalId = d.goalId;
          const section = d.section;
          const targetContent = contentElForGroup(d.targetGroupId);
          const tgt = groupData[d.targetGroupId];
          const insertAt = Math.max(0, Math.min(d.targetIndex ?? tgt.goalIds.length, tgt.goalIds.length));

          // FIRST: capture rects while the placeholder is still in the
          // target. This ensures target siblings are captured in their
          // "gap-made" positions — after we replace the placeholder
          // with the section (same slot), siblings won't visibly move.
          // Without this ordering, we'd capture siblings in a collapsed
          // state and then fake an animation sliding them down to make
          // room, which looks jumpy.
          const firstRects = captureFlipRects([targetContent]);
          // The placeholder itself is about to be removed — FLIPing a
          // removed element just wastes work.
          if (d.placeholder) firstRects.delete(d.placeholder);
          firstRects.set(section, section.getBoundingClientRect());

          // Commit data
          tgt.goalIds.splice(insertAt, 0, goalId);
          delete groupData[d.sourceGroupId];
          saveGroups();

          // Commit DOM: remove placeholder from target, move section
          // into its slot, destroy the source (floating) widget.
          if (d.placeholder?.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
          const nonPh = Array.from(targetContent.children)
            .filter(c => !c.classList.contains("gt-goal-placeholder"));
          if (insertAt >= nonPh.length) targetContent.appendChild(section);
          else                          targetContent.insertBefore(section, nonPh[insertAt]);
          widgetEl.remove();

          // Snap! Target's surrounding cards slide, and the merged
          // card slides from its (floating-widget-interior) position
          // to its final slot — all via the same FLIP call.
          playFlip(firstRects, 200);
        } else {
          // JUST MOVE: persist new position, widget stays put at cursor
          if (groupData[d.sourceGroupId]) {
            groupData[d.sourceGroupId].position = widgetPositionRatio(widgetEl);
            saveGroups();
          }
        }
        return;
      }

      // ── Normal goal drag drop ──────────────────────────────────
      const sourceGroupId = d.sourceGroupId;
      let targetGroupId = d.targetGroupId;
      let targetIndex   = d.targetIndex;
      let destroyedSource = false;
      let createdNewWidget = false;

      if (!targetGroupId) {
        // Empty space → new detached widget at drop point
        targetGroupId = generateGroupId();
        groupData[targetGroupId] = {
          position: { left: (e.clientX - d.offX) + "px", top: (e.clientY - d.offY) + "px" },
          size: null,
          goalIds: [],
        };
        targetIndex = 0;
        createdNewWidget = true;
      }

      // Commit groupData. Order: remove-from-source → insert-into-target
      // → conditionally destroy source. See earlier commit message for why
      // this order matters (same-group single-goal drops would previously
      // delete the target mid-operation).
      if (sourceGroupId && groupData[sourceGroupId]) {
        const src = groupData[sourceGroupId];
        const idx = src.goalIds.indexOf(d.goalId);
        if (idx !== -1) src.goalIds.splice(idx, 1);
      }

      const tgt = groupData[targetGroupId];
      const insertAt = Math.max(0, Math.min(targetIndex ?? tgt.goalIds.length, tgt.goalIds.length));
      tgt.goalIds.splice(insertAt, 0, d.goalId);

      if (sourceGroupId && sourceGroupId !== targetGroupId
          && sourceGroupId !== MAIN_GROUP_ID
          && groupData[sourceGroupId]?.goalIds.length === 0) {
        delete groupData[sourceGroupId];
        destroyedSource = true;
      }

      saveGroups();

      // ── Snap animation ─────────────────────────────────────────
      // FIRST: where is the floating section right now, on screen?
      const section = d.section;
      const firstSectionRect = section.getBoundingClientRect();

      // Also capture any siblings that will shift. During drag we kept
      // the placeholder at the target slot, so siblings are already in
      // their final-ish positions — but the placeholder→section swap
      // can still cause a pixel of adjustment, so we FLIP them too.
      const targetContent = contentElForGroup(targetGroupId) ||
        createDetachedWidget(targetGroupId, groupData[targetGroupId].position).querySelector(".gt-content");
      const firstRects = captureFlipRects([targetContent]);

      // LAST: remove placeholder, reset floating styles on section,
      // drop it into its final slot.
      if (d.placeholder?.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);

      section.classList.remove("gt-goal-dragging");
      section.style.position = "";
      section.style.left = "";
      section.style.top  = "";
      section.style.width = "";
      section.style.transition = "none";
      section.style.transform  = "";

      const finalSiblings = Array.from(targetContent.children)
        .filter(c => !c.classList.contains("gt-goal-placeholder") && c !== section);
      if (insertAt >= finalSiblings.length) targetContent.appendChild(section);
      else                                  targetContent.insertBefore(section, finalSiblings[insertAt]);

      // A brand-new detached widget was positioned by createDetachedWidget while
      // still EMPTY (the goal moves in only just above), so its migrated ratio was
      // derived against a ~0 height and would drift up on the next zoom (worse the
      // lower it sits). Now that the goal is in and the widget is at its real
      // height, re-derive the ratio from the actual rect so it's correct.
      if (createdNewWidget && groupData[targetGroupId]) {
        const newWidget = targetContent.closest(".gt-widget");
        if (newWidget) {
          groupData[targetGroupId].position = widgetPositionRatio(newWidget);
          saveGroups();
        }
      }

      // Destroy source widget DOM if its group was deleted
      if (destroyedSource) {
        const srcWidget = document.querySelector(`.gt-widget-detached[data-group-id="${sourceGroupId}"]`);
        if (srcWidget) srcWidget.remove();
      }

      // PLAY: snap the section from cursor position to its final slot.
      // Manually because playFlip's "skip gt-goal-dragging" guard doesn't
      // apply here (we just removed that class) — but we need the section
      // to FLIP from its fixed-position screen rect, not from flow.
      {
        const last = section.getBoundingClientRect();
        const dx = firstSectionRect.left - last.left;
        const dy = firstSectionRect.top  - last.top;
        if (dx !== 0 || dy !== 0) {
          section.style.transition = "none";
          section.style.transform  = `translate(${dx}px, ${dy}px)`;
          void section.offsetHeight;
          section.style.transition = `transform 200ms ${FLIP_EASING}`;
          section.style.transform  = "";
          setTimeout(() => {
            if (section.style.transform === "") section.style.transition = "";
          }, 230);
        }
      }
      // Siblings: FLIP them from their captured rects
      playFlip(firstRects, 180);

    } catch (err) {
      // Defensive: keep drag state from latching if anything above throws.
      console.error("[Goal Tracker] drop handler failed:", err);
    } finally {
      gDrag = null;
      dragInProgress = false;
      document.body.classList.remove("gt-dragging");
      // A drag commit can change which widgets host avg goals — moving
      // an avg goal into a previously-non-avg widget needs to bump that
      // widget's min-width, and emptying the source widget of its only
      // avg goal needs to drop the bumped min-width back. The drag
      // handler doesn't otherwise call renderAllGoals (the snap
      // animation moves DOM directly), so the .gt-widget-has-avg class
      // would only refresh on the next stats poll without this — a
      // visible delay where the user can briefly resize a fresh
      // avg-only widget below its proper min-width.
      updateAllWidgetAvgClasses();
    }
  });

  // ── Render widgets from groupData ─────────────────────────────
  // Creates/destroys detached widget DOM to match groupData. Does NOT
  // move goal sections around; that's driven by drag commits and goal
  // lifecycle events (create/remove). Safe to call any time; idempotent.
  function renderGroupWidgets() {
    if (!isLoggedIn()) { applyLoginGate(); return; } // logged out → panel only, no detached widgets
    // Make sure every detached group has a widget
    for (const gid of Object.keys(groupData)) {
      if (gid === MAIN_GROUP_ID) {
        applyWidgetTransform(container, MAIN_GROUP_ID);
        continue;
      }
      let w = widgetElForGroup(gid);
      if (!w) w = createDetachedWidget(gid, groupData[gid].position);
      else applyWidgetTransform(w, gid);
    }
    // Remove any widget DOM whose group no longer exists
    document.querySelectorAll(".gt-widget-detached").forEach(w => {
      if (!groupData[w.dataset.groupId]) w.remove();
    });
  }

  renderGroupWidgets();

  // ── Modal ──────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.id = "gt-overlay";
  overlay.innerHTML = `
    <div id="gt-modal">
      <div class="gt-modal-header">
        <span class="gt-modal-title">Set a Goal</span>
        <button id="close-modal-btn" class="gt-close-btn">✕</button>
      </div>
      <div class="gt-section-label">Type</div>
      <div class="gt-type-selector">
        <button class="gt-type-btn active" data-type="exp">EXP</button>
        <button class="gt-type-btn"        data-type="pp">PP</button>
        <button class="gt-type-btn"        data-type="races">Races</button>
        <button class="gt-type-btn"        data-type="quotes">Quotes</button>
        <button class="gt-type-btn"        data-type="playtime">Time</button>
        <button class="gt-type-btn"        data-type="chars">Chars</button>
        <button class="gt-type-btn"        data-type="improvement">Improve</button>
        <button class="gt-type-btn"        data-type="rival">Rival</button>
      </div>
      <div id="gt-filter-row" style="display:none;">
        <div class="gt-section-label">Filter</div>
        <div class="gt-filter-selector">
          <button class="gt-filter-btn active" data-filter="all">All</button>
          <button class="gt-filter-btn"        data-filter="solo">Solo</button>
          <button class="gt-filter-btn"        data-filter="quickplay">Quickplay</button>
        </div>
      </div>
      <!-- Chars-kind toggle (chars type only): "Chars" = repeatable cumulative
           characters (every race counts, same quote or not); "Quote Chars" =
           characters from DISTINCT new quotes only (the metric Max chars uses).
           Shown/hidden by the type handler; governs gain, custom target, and
           whether the Max-chars buttons appear. -->
      <div id="gt-chars-kind-row" style="display:none;">
        <div class="gt-section-label">Chars type</div>
        <div class="gt-mode-selector">
          <button class="gt-mode-btn active" data-chars-kind="regular">Chars</button>
          <button class="gt-mode-btn"        data-chars-kind="quote">Quote Chars</button>
        </div>
      </div>
      <div id="gt-mode-row">
        <div class="gt-section-label">Mode</div>
        <div class="gt-mode-selector">
          <button class="gt-mode-btn active" data-mode="gain">Gain</button>
          <button class="gt-mode-btn"        data-mode="target">Target</button>
          <button class="gt-mode-btn"        data-mode="rank" id="gt-rank-btn" style="display:none;">Rank</button>
          <button class="gt-mode-btn"        data-mode="player" id="gt-player-btn" style="display:none;">Player</button>
          <button class="gt-mode-btn"        data-mode="average" id="gt-avg-btn" style="display:none;">Average</button>
          <button class="gt-mode-btn"        data-mode="improvement" id="gt-improvement-btn" style="display:none;">Improvement</button>
          </div>
      </div>
      <!-- Average-mode controls (races + average only). The target-average
           row uses chip-style inputs (mirroring the requirements row in
           gain mode) where each chip = one metric. Mutually exclusive:
           typing in WPM clears ACC and PP, etc. The ✨ button on the
           right toggles unique-quote mode for the rolling window. -->
      <div id="gt-avg-target-row" style="display:none;">
        <div class="gt-section-label">Target average</div>
        <div class="gt-req-selector gt-avg-selector">
          <div class="gt-req-group">
            <label class="gt-req-chip" data-avg="wpm">
              <span class="gt-req-label">Wpm</span>
              <input class="gt-avg-input" type="number" min="1" step="0.1" placeholder="—" data-avg="wpm" />
            </label>
            <label class="gt-req-chip" data-avg="accuracy">
              <span class="gt-req-label">Acc</span>
              <input class="gt-avg-input" type="number" min="0" max="100" step="0.01" placeholder="—" data-avg="accuracy" />
            </label>
            <label class="gt-req-chip" data-avg="pp">
              <span class="gt-req-label">Pp</span>
              <input class="gt-avg-input" type="number" min="1" step="0.1" placeholder="—" data-avg="pp" />
            </label>
          </div>
          <button id="gt-avg-unique-btn" class="gt-req-strict-btn gt-avg-unique-btn" type="button" title="Unique-quote mode — each race in the rolling window must be on a different quote">✨</button>
        </div>
      </div>
      <!-- Improvement sub-mode (Gain | Target). Bespoke toggle shown only for
           the improvement type; independent of the cumulative Mode row (which
           stays hidden via supportsTarget:false). -->
      <div id="gt-improvement-mode-row" style="display:none;">
        <div class="gt-section-label">Mode</div>
        <div class="gt-mode-selector gt-improvement-mode-group">
          <button class="gt-mode-btn active" data-imp-mode="gain"   type="button">Gain</button>
          <button class="gt-mode-btn"        data-imp-mode="target" type="button">Target</button>
        </div>
      </div>
      <!-- Improvement-mode controls (races + improvement only). A small
           WPM/PP metric selector chooses which stat's per-quote gain is
           accumulated, plus a right-aligned toggle (∞). Off by default:
           only quotes you've typed at least once count (improvement needs a
           prior best). When active, the first race on a quote counts too. -->
      <div id="gt-improvement-metric-row" style="display:none;">
        <div class="gt-section-label">Metric</div>
        <div class="gt-req-selector">
          <div class="gt-req-group gt-improvement-metric-group">
            <button class="gt-mode-btn active" data-imp-metric="wpm" type="button">WPM</button>
            <button class="gt-mode-btn"        data-imp-metric="pp"  type="button">PP</button>
          </div>
          <button id="gt-improvement-firsttime-btn" class="gt-req-strict-btn" type="button" title="Count first-ever attempts — also count the first time you type a quote (no prior best needed). Off by default: only quotes you've typed before count, since improvement needs a previous best to measure against.">🌱</button>
        </div>
      </div>
      <!-- Track: what to measure improvement against — your Best on each quote
           (default; ratchets your PB) or your rolling Average on each quote
           (improve your typical performance; see the Window row). -->
      <div id="gt-improvement-track-row" style="display:none;">
        <div class="gt-section-label">Track</div>
        <div class="gt-req-selector">
          <div class="gt-req-group gt-improvement-track-group">
            <button class="gt-mode-btn active" data-imp-track="best"    type="button">Best</button>
            <button class="gt-mode-btn"        data-imp-track="average" type="button">Average</button>
          </div>
        </div>
      </div>
      <!-- Rolling window (only shown when Track = Average). This single number
           is the rolling-average window, the warm-up length, AND the number
           of races the baseline is averaged over. A quote becomes eligible
           once it has this many races (history counts); its rolling average
           at that point locks in as the baseline, and gain is how far the
           rolling average later climbs above it (peak, never negative). -->
      <div id="gt-improvement-window-row" style="display:none;">
        <div class="gt-section-label">Rolling window (races)</div>
        <div class="gt-req-selector">
          <input id="gt-improvement-avgwindow-input" class="gt-improvement-avgwindow-input" type="number" min="2" placeholder="e.g. 5" />
        </div>
      </div>
      <!-- Improvement-Target controls (improvement type, Target sub-mode).
           Status + played filter the catalog set; the difficulty/length dual
           sliders narrow it further; Next pick orders the "Next quote" button.
           Solo/quickplay, track/window and recurrence are gain-only — hidden
           here. -->
      <div id="gt-target-status-row" style="display:none;">
        <div class="gt-section-label">Status</div>
        <div class="gt-mode-selector gt-target-status-group">
          <button class="gt-mode-btn"        data-target-status="all"      type="button">All</button>
          <button class="gt-mode-btn active" data-target-status="ranked"   type="button">Ranked</button>
          <button class="gt-mode-btn"        data-target-status="unranked" type="button">Unranked</button>
        </div>
      </div>
      <div id="gt-target-played-row" style="display:none;">
        <div class="gt-section-label">Quotes</div>
        <div class="gt-mode-selector gt-target-played-group">
          <button class="gt-mode-btn"        data-target-played="all"    type="button">All</button>
          <button class="gt-mode-btn active" data-target-played="played" type="button">Played only</button>
        </div>
      </div>
      <div id="gt-target-diff-row" style="display:none;">
        <div class="gt-section-label">Difficulty filter<span class="gt-range-readout" id="gt-target-diff-readout"></span><span class="gt-mode-hint" id="gt-target-sync-hint" style="display:none;"></span></div>
        <div class="gt-range-row" id="gt-target-diff-ticks">
          <span class="gt-range-end gt-range-end-lo"></span>
          <div class="gt-range" id="gt-target-diff-range">
            <div class="gt-range-track"><div class="gt-range-fill"></div></div>
            <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum difficulty" />
            <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum difficulty" />
          </div>
          <span class="gt-range-end gt-range-end-hi"></span>
        </div>
      </div>
      <div id="gt-target-len-row" style="display:none;">
        <div class="gt-section-label">Quote length filter<span class="gt-range-readout" id="gt-target-len-readout"></span></div>
        <div class="gt-range-row" id="gt-target-len-ticks">
          <span class="gt-range-end gt-range-end-lo"></span>
          <div class="gt-range" id="gt-target-len-range">
            <div class="gt-range-track"><div class="gt-range-fill"></div></div>
            <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum length" />
            <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum length" />
          </div>
          <span class="gt-range-end gt-range-end-hi"></span>
        </div>
      </div>
      <!-- The "Next quote" ordering (random / closest / biggest gap) is a global
           preference now — see Settings → Improve — so it's not duplicated here. -->
      <!-- Rival-mode controls (type=rival only). The rival username is entered
           in the standard Amount-row input (reused as a text field, like Player
           mode). Metric (WPM/PP) and quote scope (all/ranked/unranked) are
           global preferences in Settings -> Rival, so they are not duplicated
           here. This row hosts only the Single-vs-Multiple toggle; in multiple
           mode the "+ Add" button sits beside the username input and the chosen
           rivals render in the "Current Rivals" row below it. No recurrence/target. -->
      <div id="gt-rival-metric-row" style="display:none;">
        <div class="gt-section-label">Rivals</div>
        <div class="gt-mode-selector" id="gt-rival-multimode-selector">
          <button class="gt-mode-btn active" type="button" data-rival-multimode="single">Single rival</button>
          <button class="gt-mode-btn"        type="button" data-rival-multimode="multi">Multiple rivals</button>
        </div>
      </div>
      <div id="gt-req-row" style="display:none;">
        <div class="gt-section-label">Requirements</div>
        <div class="gt-req-selector">
          <div class="gt-req-group">
            <label class="gt-req-chip" data-req="wpm">
              <span class="gt-req-label">WPM</span>
              <input class="gt-req-input" type="number" min="1" placeholder="—" data-req="wpm" />
            </label>
            <label class="gt-req-chip" data-req="accuracy">
              <span class="gt-req-label">Acc</span>
              <input class="gt-req-input" type="number" min="1" max="100" step="0.1" placeholder="—" data-req="accuracy" />
              <span class="gt-req-suffix">%</span>
            </label>
            <label class="gt-req-chip" data-req="pp">
              <span class="gt-req-label">PP</span>
              <input class="gt-req-input" type="number" min="1" step="0.1" placeholder="—" data-req="pp" />
            </label>
          </div>
          <button id="gt-req-strict-btn" class="gt-req-strict-btn" type="button" title="Strict mode — every race must meet requirements; goal resets to 0 on a miss">⚡</button>
        </div>
        <!-- Second row: quote-property requirements (length + difficulty).
             These are about the text itself, not the user's performance,
             so they live on their own row. Strict button stays anchored
             to the skill row above; the unique-quote toggle (✨) lives
             here on the right — it applies to the whole goal regardless. -->
        <div class="gt-req-selector gt-req-selector-bottom">
          <div class="gt-req-group">
            <label class="gt-req-chip" data-req="length">
              <span class="gt-req-label">Length</span>
              <input class="gt-req-input" type="number" min="1" placeholder="—" data-req="length" />
            </label>
            <label class="gt-req-chip" data-req="difficulty">
              <span class="gt-req-label">Difficulty</span>
              <input class="gt-req-input" type="number" min="0" step="0.1" placeholder="—" data-req="difficulty" />
            </label>
          </div>
          <button id="gt-req-unique-btn" class="gt-req-strict-btn gt-req-unique-btn" type="button" title="Unique-quote mode — each qualifying race must be on a different quote (the same quoteId never counts twice within a period)">✨</button>
        </div>
      </div>
      <div id="gt-rec-row">
        <div class="gt-section-label">Recurrence</div>
        <div class="gt-rec-selector">
          <button class="gt-rec-btn active" data-rec="none">None</button>
          <button class="gt-rec-btn"        data-rec="daily">Daily</button>
          <button class="gt-rec-btn"        data-rec="weekly">Weekly</button>
          <button class="gt-rec-btn"        data-rec="monthly">Monthly</button>
        </div>
      </div>
      <!-- Main amount section. Hidden in avg mode (replaced by the
           target-average chip row above). Wrapped in gt-amount-row so we
           can show/hide as a unit including the section label. -->
      <div id="gt-amount-row">
        <div class="gt-section-label" id="gt-amount-label">Amount</div>
        <div class="gt-target-row" id="gt-amount-target-row">
          <!-- Rival chips render here (multiple-rivals mode), turning this row
               into a tag field — see renderRivalList + the .gt-tagfield class. -->
          <span id="gt-rival-inline-tags" class="gt-rival-inline-tags"></span>
          <div id="gt-max-quotes-row" style="display:none;">
            <button id="gt-max-all-btn"      class="gt-mode-btn">⚡ Max all</button>
            <button id="gt-max-ranked-btn"   class="gt-mode-btn">⚡ Max ranked</button>
            <button id="gt-max-unranked-btn" class="gt-mode-btn">⚡ Max unranked</button>
          </div>
          <div id="gt-max-chars-row" style="display:none;">
            <button id="gt-max-chars-all-btn"      class="gt-mode-btn">⚡ Max all</button>
            <button id="gt-max-chars-ranked-btn"   class="gt-mode-btn">⚡ Max ranked</button>
            <button id="gt-max-chars-unranked-btn" class="gt-mode-btn">⚡ Max unranked</button>
          </div>
          <div id="gt-next-rank-row" style="display:none; margin-bottom: 6px;">
            <button id="gt-next-rank-btn" class="gt-mode-btn" style="width:100%;">⚡ Next Rank</button>
          </div>
          <div id="gt-presets" class="gt-presets"></div>
          <input id="gt-custom-input" class="gt-custom-input" type="number" min="1" placeholder="Custom" />
          <button id="gt-rival-add-btn" class="gt-rival-add-inline-btn" type="button" style="display:none;" disabled>+ Add</button>
        </div>
      </div>
      <div id="gt-mode-hint" class="gt-mode-hint" style="display:none;"></div>
      <!-- Rival comparison config (type=rival only). Mirrors the per-goal "Edit
           goal" popover so a rival goal can be tuned at creation: metric, quote
           scope, shared-only, and difficulty / length / rival-value ranges. The
           chosen values seed the new goal's gd.rivalSettings; the same controls
           are editable afterwards from the card's Edit button. -->
      <div id="gt-rival-config-row" style="display:none;">
        <div class="gt-section-label">Metric</div>
        <div class="gt-mode-selector" id="gt-rival-cfg-metric">
          <button class="gt-mode-btn active" type="button" data-rvc-metric="wpm">WPM</button>
          <button class="gt-mode-btn"        type="button" data-rvc-metric="pp">PP</button>
        </div>
        <div class="gt-section-label" style="margin-top:16px;">Scope</div>
        <div class="gt-mode-selector" id="gt-rival-cfg-scope">
          <button class="gt-mode-btn"        type="button" data-rvc-scope="all">All</button>
          <button class="gt-mode-btn active" type="button" data-rvc-scope="ranked">Ranked</button>
          <button class="gt-mode-btn"        type="button" data-rvc-scope="unranked">Unranked</button>
        </div>
        <div class="gt-section-label" style="margin-top:16px;">Compare on</div>
        <div class="gt-mode-selector" id="gt-rival-cfg-both">
          <button class="gt-mode-btn"        type="button" data-rvc-both="false">All quotes</button>
          <button class="gt-mode-btn active" type="button" data-rvc-both="true">Shared only</button>
        </div>
        <div class="gt-section-label" style="margin-top:16px;">Difficulty filter<span class="gt-range-readout" id="gt-rival-cfg-diff-readout"></span></div>
        <div class="gt-range-row" id="gt-rival-cfg-diff-ticks">
          <span class="gt-range-end gt-range-end-lo"></span>
          <div class="gt-range" id="gt-rival-cfg-diff-range">
            <div class="gt-range-track"><div class="gt-range-fill"></div></div>
            <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum difficulty" />
            <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum difficulty" />
          </div>
          <span class="gt-range-end gt-range-end-hi"></span>
        </div>
        <div class="gt-section-label" style="margin-top:14px;">Quote length filter<span class="gt-range-readout" id="gt-rival-cfg-len-readout"></span></div>
        <div class="gt-range-row" id="gt-rival-cfg-len-ticks">
          <span class="gt-range-end gt-range-end-lo"></span>
          <div class="gt-range" id="gt-rival-cfg-len-range">
            <div class="gt-range-track"><div class="gt-range-fill"></div></div>
            <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum length" />
            <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum length" />
          </div>
          <span class="gt-range-end gt-range-end-hi"></span>
        </div>
        <div class="gt-section-label" style="margin-top:14px;"><span id="gt-rival-cfg-band-label">Rival WPM filter</span><span class="gt-range-readout" id="gt-rival-cfg-band-readout"></span></div>
        <div class="gt-range-row" id="gt-rival-cfg-band-ticks">
          <span class="gt-range-end gt-range-end-lo"></span>
          <div class="gt-range" id="gt-rival-cfg-band-range">
            <div class="gt-range-track"><div class="gt-range-fill"></div></div>
            <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum rival value" />
            <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum rival value" />
          </div>
          <span class="gt-range-end gt-range-end-hi"></span>
        </div>
      </div>
      <!-- Window size row: only visible in average mode, sits right above
           the confirm button. Uses the same presets-+-custom layout as
           the main Amount row so it visually matches the rest of the
           modal. The presets cover common rolling-avg window sizes; the
           custom input handles anything else. -->
      <div id="gt-avg-window-row" style="display:none;">
        <div class="gt-section-label">Window size (races)</div>
        <div class="gt-target-row">
          <div id="gt-avg-window-presets" class="gt-presets"></div>
          <input id="gt-avg-window-input" class="gt-custom-input" type="number" min="1" placeholder="Custom" />
        </div>
      </div>
      <button id="confirm-goal-btn" class="gt-confirm-btn" disabled>Set Goal</button>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Settings modal ────────────────────────────────────────────
  // A general-purpose modal for settings that apply globally to all
  // goals or the extension as a whole. The left sidebar lists groups
  // (built at open time from SETTINGS_TABS); the right content pane
  // renders the active group's controls.
  const settingsOverlay = document.createElement("div");
  settingsOverlay.id = "gt-settings-overlay";
  settingsOverlay.innerHTML = `
    <div id="gt-settings-modal">
      <div class="gt-modal-header">
        <div class="gt-modal-title-row">
          <span class="gt-modal-title">Settings</span>
          <span id="gt-settings-saved-indicator" class="gt-settings-saved-indicator">Settings saved</span>
        </div>
        <button id="gt-settings-close" class="gt-close-btn">✕</button>
      </div>
      <div class="gt-settings-body">
        <nav class="gt-settings-sidebar" id="gt-settings-sidebar"></nav>
        <div class="gt-settings-content" id="gt-settings-content"></div>
      </div>
    </div>
  `;
  document.body.appendChild(settingsOverlay);

  // ── Weekday / ordinal helpers ─────────────────────────────────
  // Wheel order is Monday-first (Swiss/ISO convention), but values stay
  // aligned with JS's getDay() (0=Sun..6=Sat) so the period math is simple.
  const WEEKDAY_ITEMS = [
    { label: "Monday",    value: 1 },
    { label: "Tuesday",   value: 2 },
    { label: "Wednesday", value: 3 },
    { label: "Thursday",  value: 4 },
    { label: "Friday",    value: 5 },
    { label: "Saturday",  value: 6 },
    { label: "Sunday",    value: 0 },
  ];
  const WEEKDAY_NAMES = { 0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday" };

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // ── Wheel picker factory ──────────────────────────────────────
  // items: [{ label, value }, ...]. Returns { getValue, setValue, onChange, destroy }.
  const WHEEL_ITEM_HEIGHT = 32;
  function createWheel(wheelEl, items, initialValue, onChange) {
    wheelEl.innerHTML = "";
    const list = document.createElement("div");
    list.className = "gt-wheel-list";
    items.forEach(({ label, value }) => {
      const item = document.createElement("div");
      item.className = "gt-wheel-item";
      item.dataset.value = String(value);
      item.textContent = label;
      list.appendChild(item);
    });
    wheelEl.appendChild(list);

    function indexOfValue(v) {
      const i = items.findIndex(x => x.value === v);
      return i === -1 ? 0 : i;
    }
    function currentIndex() {
      return Math.max(0, Math.min(items.length - 1, Math.round(wheelEl.scrollTop / WHEEL_ITEM_HEIGHT)));
    }
    function paint() {
      const idx = currentIndex();
      const children = list.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle("selected", i === idx);
      }
      return items[idx].value;
    }

    let settleTimer = null;
    wheelEl.addEventListener("scroll", () => {
      paint();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const v = paint();
        if (onChange) onChange(v);
      }, 130);
    });

    Array.from(list.children).forEach((item, i) => {
      item.addEventListener("click", () => {
        wheelEl.scrollTo({ top: i * WHEEL_ITEM_HEIGHT, behavior: "smooth" });
      });
    });

    // Initial position — set without smooth-scroll so the wheel shows the saved value on open.
    wheelEl.scrollTop = indexOfValue(initialValue) * WHEEL_ITEM_HEIGHT;
    paint();

    return {
      getValue: () => items[currentIndex()].value,
      setValue: (v) => { wheelEl.scrollTop = indexOfValue(v) * WHEEL_ITEM_HEIGHT; paint(); },
    };
  }

  // ── Recurrence body builders ──────────────────────────────────
  // Each builder takes the settings slice to render, so they can be
  // fed either the committed state or an in-progress draft.
  function buildDailyBody(s) {
    const { hour, minute } = s;
    return `
      <p class="gt-rec-reset-text">Your daily goals reset at…</p>
      <div class="gt-time-picker">
        <input id="gt-rs-hour" class="gt-time-input" type="number" min="0" max="23" value="${pad2(hour)}" />
        <span class="gt-time-colon">:</span>
        <input id="gt-rs-min"  class="gt-time-input" type="number" min="0" max="59" value="${pad2(minute)}" />
      </div>
    `;
  }

  function buildWeeklyBody(s) {
    const { weekday, hour, minute } = s;
    return `
      <p class="gt-rec-reset-text" id="gt-rs-summary">Your weekly goals reset every <b>${WEEKDAY_NAMES[weekday]}</b> at…</p>
      <div class="gt-wheel-layout">
        <div class="gt-wheel-col">
          <div class="gt-wheel-label">Weekday</div>
          <div class="gt-wheel-wrap">
            <div class="gt-wheel-indicator"></div>
            <div class="gt-wheel" id="gt-rs-wheel"></div>
          </div>
        </div>
        <div class="gt-wheel-right">
          <div class="gt-wheel-label" aria-hidden="true" style="visibility: hidden;">&nbsp;</div>
          <div class="gt-wheel-right-aligned">
            <div class="gt-time-picker">
              <input id="gt-rs-hour" class="gt-time-input" type="number" min="0" max="23" value="${pad2(hour)}" />
              <span class="gt-time-colon">:</span>
              <input id="gt-rs-min"  class="gt-time-input" type="number" min="0" max="59" value="${pad2(minute)}" />
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function buildMonthlyBody(s) {
    const { day, hour, minute } = s;
    return `
      <p class="gt-rec-reset-text" id="gt-rs-summary">Your monthly goals reset on the <b>${ordinal(day)}</b> at…</p>
      <div class="gt-wheel-layout">
        <div class="gt-wheel-col">
          <div class="gt-wheel-label">Day of month</div>
          <div class="gt-wheel-wrap">
            <div class="gt-wheel-indicator"></div>
            <div class="gt-wheel" id="gt-rs-wheel"></div>
          </div>
        </div>
        <div class="gt-wheel-right">
          <div class="gt-wheel-label" aria-hidden="true" style="visibility: hidden;">&nbsp;</div>
          <div class="gt-wheel-right-aligned">
            <div class="gt-time-picker">
              <input id="gt-rs-hour" class="gt-time-input" type="number" min="0" max="23" value="${pad2(hour)}" />
              <span class="gt-time-colon">:</span>
              <input id="gt-rs-min"  class="gt-time-input" type="number" min="0" max="59" value="${pad2(minute)}" />
            </div>
          </div>
        </div>
      </div>
      <div class="gt-monthly-note" id="gt-rs-month-note" style="display:none;"></div>
    `;
  }

  // ── Shared helpers (used by multiple tabs' renderers) ────────
  function updateMonthlyNote(day) {
    const note = document.getElementById("gt-rs-month-note");
    if (!note) return;
    if (day <= 28) { note.style.display = "none"; return; }
    note.textContent = `On months with fewer than ${day} days, the goal resets on the last day of the month instead.`;
    note.style.display = "block";
  }

  function wireTimeInput(id, max) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("blur", () => {
      el.value = pad2(clampInt(el.value, 0, max, 0));
    });
    el.addEventListener("focus", () => el.select());
  }

  // ══════════════════════════════════════════════════════════════
  // Global settings modal
  // ══════════════════════════════════════════════════════════════
  // Opened via the gear button in the widget header. Houses a
  // sidebar-navigated set of settings groups (tabs). Extensible:
  // add an entry to SETTINGS_TABS with { id, label, render, commit }
  // to introduce a new settings group.

  let activeSettingsTabId = (() => { try { return localStorage.getItem("gt-settings-tab"); } catch { return null; } })();    // restored across reloads; validated in openSettingsModal
  let activeRecSubTab     = "daily"; // sub-selection within the Recurrence tab
  let activeWheel         = null;    // current wheel picker (if the visible sub-tab has one)
  let settingsDraft       = null;    // working copy of settings while the modal is open; auto-committed on each change

  // ── Recurrence tab ────────────────────────────────────────────
  function renderRecurrenceTab(contentEl, draft) {
    contentEl.innerHTML = `
      <div class="gt-section-label">Reset time</div>
      <div class="gt-rec-selector">
        <button class="gt-rec-btn ${activeRecSubTab === "daily"   ? "active" : ""}" data-sub="daily">Daily</button>
        <button class="gt-rec-btn ${activeRecSubTab === "weekly"  ? "active" : ""}" data-sub="weekly">Weekly</button>
        <button class="gt-rec-btn ${activeRecSubTab === "monthly" ? "active" : ""}" data-sub="monthly">Monthly</button>
      </div>
      <div id="gt-settings-rec-body"></div>
    `;

    contentEl.querySelectorAll(".gt-rec-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.sub === activeRecSubTab) return;
        persistActiveFormToDraft(); // capture current sub-tab's edits before swapping
        activeRecSubTab = btn.dataset.sub;
        contentEl.querySelectorAll(".gt-rec-btn").forEach(b => b.classList.toggle("active", b === btn));
        renderRecSubBody(draft);
      });
    });

    renderRecSubBody(draft);
  }

  function renderRecSubBody(draft) {
    const body = document.getElementById("gt-settings-rec-body");
    if (!body) return;

    if (activeRecSubTab === "daily") {
      body.innerHTML = buildDailyBody(draft.recSettings.daily);
      activeWheel = null;
    } else if (activeRecSubTab === "weekly") {
      body.innerHTML = buildWeeklyBody(draft.recSettings.weekly);
    } else {
      body.innerHTML = buildMonthlyBody(draft.recSettings.monthly);
    }

    wireTimeInput("gt-rs-hour", 23);
    wireTimeInput("gt-rs-min", 59);

    // Auto-save when a time input loses focus. Registered AFTER wireTimeInput
    // so the clamp handler runs first; persistActiveFormToDraft then reads
    // the post-clamp value via clampInt.
    ["gt-rs-hour", "gt-rs-min"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("blur", applySettingsDraft);
    });

    // Wheel init deferred one frame so offsetHeight is correct.
    requestAnimationFrame(() => {
      if (activeRecSubTab === "weekly") {
        const wheelEl = document.getElementById("gt-rs-wheel");
        const summary = document.getElementById("gt-rs-summary");
        activeWheel = createWheel(wheelEl, WEEKDAY_ITEMS, draft.recSettings.weekly.weekday, (v) => {
          draft.recSettings.weekly.weekday = v; // live-update draft so sub-tab swaps preserve it
          if (summary) summary.innerHTML = `Your weekly goals reset every <b>${WEEKDAY_NAMES[v]}</b> at…`;
          applySettingsDraft();
        });
      } else if (activeRecSubTab === "monthly") {
        const wheelEl = document.getElementById("gt-rs-wheel");
        const summary = document.getElementById("gt-rs-summary");
        const dayItems = Array.from({ length: 31 }, (_, i) => ({ label: String(i + 1), value: i + 1 }));
        activeWheel = createWheel(wheelEl, dayItems, draft.recSettings.monthly.day, (v) => {
          draft.recSettings.monthly.day = v; // live-update draft
          if (summary) summary.innerHTML = `Your monthly goals reset on the <b>${ordinal(v)}</b> at…`;
          updateMonthlyNote(v);
          applySettingsDraft();
        });
        updateMonthlyNote(draft.recSettings.monthly.day);
      }
    });
  }

  function commitRecurrenceTab(draft) {
    // Skip work (and the cross-tab broadcast) if nothing actually changed.
    const nextSerialized = JSON.stringify(draft.recSettings);
    if (nextSerialized === JSON.stringify(recSettings)) return;

    recSettings = JSON.parse(nextSerialized);
    saveRecSettings();
    migrateRecurringGoalPeriodStarts(); // preserve in-period progress
    renderAllGoals();                   // countdown text depends on the new reset times
  }

  // ── Display tab ───────────────────────────────────────────────
  const STREAK_MODE_OPTIONS = [
    { value: "streak", label: "🔥 Streak", hint: "Shows a flame and the number of recurring periods you've completed in a row." },
    { value: "total",  label: "Total",     hint: "Shows the total number of recurring periods you've completed since creating the goal." },
    { value: "off",    label: "Off",       hint: "Hides the indicator entirely." },
  ];

  function renderDisplayTab(contentEl, draft) {
    const current = draft.displaySettings.streakMode;
    contentEl.innerHTML = `
      <div class="gt-section-label">Streak indicator</div>
      <div class="gt-mode-selector" id="gt-display-streak-selector">
        ${STREAK_MODE_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === current ? " active" : ""}" data-streak-mode="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-display-streak-hint" style="display:block;">${
        STREAK_MODE_OPTIONS.find(o => o.value === current)?.hint ?? ""
      }</div>
    `;

    const hintEl = contentEl.querySelector("#gt-display-streak-hint");
    contentEl.querySelectorAll("[data-streak-mode]").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.streakMode;
        draft.displaySettings.streakMode = mode;
        contentEl.querySelectorAll("[data-streak-mode]").forEach(b => b.classList.toggle("active", b === btn));
        if (hintEl) hintEl.textContent = STREAK_MODE_OPTIONS.find(o => o.value === mode)?.hint ?? "";
        applySettingsDraft();
      });
    });
  }

  function commitDisplayTab(draft) {
    if (draft.displaySettings.streakMode === displaySettings.streakMode) return; // no change
    displaySettings = { ...draft.displaySettings };
    saveDisplaySettings();
    renderAllGoals();
  }

  // ── Improve tab ───────────────────────────────────────────────
  // Settings that apply globally to every improvement-Target goal. Currently:
  // the order the "→ Next quote" button steps through the not-yet-hit pool.
  const IMPROVE_NEXT_SORT_OPTIONS = [
    { value: "random",  label: "Random",      hint: "Jumps to a random quote you haven't hit the target on yet." },
    { value: "closest", label: "Closest",     hint: "Picks the quote you're closest to hitting — smallest gap first." },
    { value: "biggest", label: "Biggest gap", hint: "Picks the quote you're furthest from hitting — largest gap first." },
  ];

  function renderImproveTab(contentEl, draft) {
    const cur = IMPROVE_NEXT_SORT_VALUES.includes(draft.improveSettings.nextSort)
      ? draft.improveSettings.nextSort : "random";
    contentEl.innerHTML = `
      <div class="gt-section-label">\u201c\u2192 Next quote\u201d button picks</div>
      <div class="gt-mode-selector" id="gt-improve-nextsort-selector">
        ${IMPROVE_NEXT_SORT_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === cur ? " active" : ""}" data-improve-nextsort="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-improve-nextsort-hint" style="display:block;">${
        IMPROVE_NEXT_SORT_OPTIONS.find(o => o.value === cur)?.hint ?? ""
      }</div>
    `;
    const hintEl = contentEl.querySelector("#gt-improve-nextsort-hint");
    contentEl.querySelectorAll("[data-improve-nextsort]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.improveNextsort;
        draft.improveSettings.nextSort = val;
        contentEl.querySelectorAll("[data-improve-nextsort]").forEach(b => b.classList.toggle("active", b === btn));
        if (hintEl) hintEl.textContent = IMPROVE_NEXT_SORT_OPTIONS.find(o => o.value === val)?.hint ?? "";
        applySettingsDraft();
      });
    });
  }

  function commitImproveTab(draft) {
    if (draft.improveSettings.nextSort === improveSettings.nextSort) return; // no change
    improveSettings = { ...draft.improveSettings };
    saveImproveSettings();
    // nextSort is read live at click time (onTargetNextClicked), so no
    // re-render is needed. The served cursor self-heals on the next click:
    // a sort mismatch starts a fresh map (same as the rival Next-vs sort).
  }

  // ── Rival tab ─────────────────────────────────────────────────
  // Settings that apply globally to every rival goal: which quotes are tracked
  // (all / ranked / unranked) and where the "⚔ Next vs …" button navigates.
  const RIVAL_NEXT_LINK_OPTIONS = [
    { value: false, label: "Solo",     hint: "Opens the text as a standard solo race." },
    { value: true,  label: "Vs Rival", hint: "Opens a head-to-head race against the rival's ghost." },
  ];
  const RIVAL_NEXT_SORT_OPTIONS = [
    { value: "random",  label: "Random",   hint: "Picks a random quote where the rival beats you." },
    { value: "closest", label: "Closest",  hint: "Smallest gap first — the quote you're nearest to beating." },
    { value: "biggest", label: "Biggest",  hint: "Largest gap first — where you're furthest behind." },
  ];

  // The global Rival tab now holds ONLY the two navigation prefs. The comparison
  // FILTERS (metric / scope / shared / difficulty / length / value bands) moved
  // to each rival goal's "Edit goal" popover (they're per-goal: changing one is
  // a local re-tally, never a re-fetch). nextSort + nextUsesVsLink stay global
  // because they're read live at click time in onRivalNextClicked.
  function renderRivalTab(contentEl, draft) {
    const curSort = RIVAL_NEXT_SORT_VALUES.includes(draft.rivalSettings.nextSort) ? draft.rivalSettings.nextSort : "random";
    const current = draft.rivalSettings.nextUsesVsLink;
    contentEl.innerHTML = `
      <div class="gt-mode-hint" style="display:block; margin-top:0; margin-bottom:14px;">Comparison filters (metric, scope, shared-only, difficulty, length, value) are set per goal — open a rival goal's Edit button to change them.</div>
      <div class="gt-section-label">“⚔ Next vs …” button picks</div>
      <div class="gt-mode-selector" id="gt-rival-nextsort-selector">
        ${RIVAL_NEXT_SORT_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === curSort ? " active" : ""}" data-next-sort="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-nextsort-hint" style="display:block;">${
        RIVAL_NEXT_SORT_OPTIONS.find(o => o.value === curSort)?.hint ?? ""
      }</div>
      <div class="gt-section-label" style="margin-top:16px;">“⚔ Next vs …” button opens</div>
      <div class="gt-mode-selector" id="gt-rival-nextlink-selector">
        ${RIVAL_NEXT_LINK_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === current ? " active" : ""}" data-next-vs="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-nextlink-hint" style="display:block;">${
        RIVAL_NEXT_LINK_OPTIONS.find(o => o.value === current)?.hint ?? ""
      }</div>
    `;

    const sortHintEl = contentEl.querySelector("#gt-rival-nextsort-hint");
    contentEl.querySelectorAll("[data-next-sort]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.nextSort;
        draft.rivalSettings.nextSort = val;
        contentEl.querySelectorAll("[data-next-sort]").forEach(b => b.classList.toggle("active", b === btn));
        if (sortHintEl) sortHintEl.textContent = RIVAL_NEXT_SORT_OPTIONS.find(o => o.value === val)?.hint ?? "";
        applySettingsDraft();
      });
    });

    const hintEl = contentEl.querySelector("#gt-rival-nextlink-hint");
    contentEl.querySelectorAll("[data-next-vs]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.nextVs === "true";
        draft.rivalSettings.nextUsesVsLink = val;
        contentEl.querySelectorAll("[data-next-vs]").forEach(b => b.classList.toggle("active", b === btn));
        if (hintEl) hintEl.textContent = RIVAL_NEXT_LINK_OPTIONS.find(o => o.value === val)?.hint ?? "";
        applySettingsDraft();
      });
    });
  }

  function commitRivalTab(draft) {
    // Only the two navigation prefs live here now; the per-goal filters commit
    // straight from the edit popover. Both prefs are read live at click time
    // (onRivalNextClicked), so a change needs persisting but no re-render.
    const linkChanged = draft.rivalSettings.nextUsesVsLink !== rivalSettings.nextUsesVsLink;
    const sortChanged = draft.rivalSettings.nextSort     !== rivalSettings.nextSort;
    if (!linkChanged && !sortChanged) return; // no change
    rivalSettings = { ...rivalSettings, nextUsesVsLink: draft.rivalSettings.nextUsesVsLink, nextSort: draft.rivalSettings.nextSort };
    saveRivalSettings();
  }

  // ── Backup tab (import / export) ──────────────────────────────
  // Lets the user save their goals + widget layout + settings to a
  // JSON file, and later restore it — e.g. when moving to a new
  // browser or PC. Export/import act outside the modal's draft flow:
  // clicking Export downloads immediately, clicking Import and
  // confirming replaces state immediately. Both actions bypass the
  // settings auto-save flow (commitBackupTab is a no-op).
  //
  // Schema is versioned so future shape changes can be migrated.
  const BACKUP_SCHEMA_VERSION = 1;

  function buildExportPayload() {
    return {
      version: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      // Deep-clone so later mutations don't affect the exported snapshot.
      goals:           JSON.parse(JSON.stringify(goalData)),
      groups:          JSON.parse(JSON.stringify(groupData)),
      recSettings:     JSON.parse(JSON.stringify(recSettings)),
      displaySettings: { ...displaySettings },
      rivalSettings:   { ...rivalSettings },
      improveSettings: { ...improveSettings },
    };
  }

  // Structural validation of an import payload. Throws a user-friendly
  // error if the shape is wrong. Doesn't validate every field exhaustively
  // (the loaders downstream have their own fallbacks for missing keys);
  // just catches "this is obviously not our file" cases.
  function validateImportPayload(data) {
    if (!data || typeof data !== "object")
      throw new Error("File is not a valid backup.");
    if (data.version !== BACKUP_SCHEMA_VERSION)
      throw new Error(`Unsupported backup version ${data.version}. Expected ${BACKUP_SCHEMA_VERSION}.`);
    if (!data.goals || typeof data.goals !== "object")
      throw new Error("Backup is missing goals data.");
    if (!data.groups || typeof data.groups !== "object")
      throw new Error("Backup is missing widget layout data.");
    if (!data.groups[MAIN_GROUP_ID])
      throw new Error("Backup is missing the main widget.");
    // Per-type: if present, must be array
    for (const type of Object.keys(GOAL_CONFIG)) {
      if (data.goals[type] !== undefined && !Array.isArray(data.goals[type])) {
        throw new Error(`Backup field goals.${type} is malformed.`);
      }
    }
  }

  // Apply an already-validated payload to localStorage, then reload
  // all in-memory state from storage and rebuild the DOM. We reload
  // from storage (rather than using the payload directly) so the
  // in-memory shape goes through the same normalization path as a
  // fresh page load — no risk of divergence.
  function applyImportedState(payload) {
    // Write all localStorage keys. Writing these BEFORE in-memory
    // reload ensures cross-tab storage events fire for other tabs,
    // which hit the existing per-key handlers and rebuild there.
    for (const [type, cfg] of Object.entries(GOAL_CONFIG)) {
      const list = Array.isArray(payload.goals[type]) ? payload.goals[type] : [];
      localStorage.setItem(cfg.storageKey, JSON.stringify(list));
    }
    localStorage.setItem(GROUPS_KEY, JSON.stringify(payload.groups));
    if (payload.recSettings)     localStorage.setItem(REC_SETTINGS_KEY,     JSON.stringify(payload.recSettings));
    if (payload.displaySettings) localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(payload.displaySettings));
    if (payload.rivalSettings)   localStorage.setItem(RIVAL_SETTINGS_KEY,   JSON.stringify(payload.rivalSettings));
    if (payload.improveSettings) localStorage.setItem(IMPROVE_SETTINGS_KEY, JSON.stringify(payload.improveSettings));

    // Reload in-memory state from storage
    for (const [type, cfg] of Object.entries(GOAL_CONFIG)) {
      try { goalData[type] = JSON.parse(localStorage.getItem(cfg.storageKey) || "[]"); }
      catch { goalData[type] = []; }
    }
    migrateImprovementToOwnType(); // imported backups may carry legacy races-improvement goals
    groupData       = loadGroups() || { [MAIN_GROUP_ID]: { position: null, size: null, goalIds: [] } };
    ensureMainGroup();
    recSettings     = loadRecSettings();
    displaySettings = loadDisplaySettings();
    rivalSettings   = loadRivalSettings();
    improveSettings = loadImproveSettings();
    migrateRivalGoalSettings(); // seed per-goal rival filters for pre-v10.31 imported backups

    // Clear ephemeral state. prevGainMap would otherwise trigger
    // fake "+N gained!" pop-ups on the next render if any of the
    // imported goals have baselines that happen to match prior IDs.
    for (const k of Object.keys(prevGainMap)) delete prevGainMap[k];
    for (const k of Object.keys(prevAvgMap))  delete prevAvgMap[k];
    for (const k of Object.keys(prevBestMap)) delete prevBestMap[k];

    // Clear DOM: all goal sections and all detached widgets.
    // Main widget stays (it holds the settings/set buttons), but
    // its inline positioning styles are cleared and re-applied so
    // the imported layout takes effect.
    document.querySelectorAll(".gt-goal-section").forEach(el => el.remove());
    document.querySelectorAll(".gt-widget-detached").forEach(el => el.remove());
    container.style.left = "";
    container.style.top = "";
    container.style.right = "";
    container.style.width = "";
    applyWidgetTransform(container, MAIN_GROUP_ID);

    // Rebuild
    renderGroupWidgets();
    renderAllGoals();
    // An imported scope may newly require the unranked stream; the leader
    // reconciles now rather than waiting for the next poll tick.
    if (isLeader) ensureRivalSync();
  }

  // Export by writing to the system clipboard. writeText() requires a
  // user gesture in most browsers (button click satisfies this) and
  // HTTPS, which TypeGG provides. A small minority of environments
  // block clipboard API even with those satisfied (very locked-down
  // Chrome profiles, some extension contexts), so callers pass a
  // fallback handler that displays the JSON for manual selection.
  async function copyExportToClipboard(fallback) {
    const json = JSON.stringify(buildExportPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      return { ok: true };
    } catch (err) {
      // writeText rejects with a permission/security error in restrictive
      // contexts — hand the raw JSON to the caller's fallback so the user
      // isn't stuck.
      fallback?.(json);
      return { ok: false, err };
    }
  }

  // Parse + validate + confirm + apply pasted backup text. Each step
  // that can fail reports through setBackupStatus so the user sees
  // exactly why the import didn't take (rather than a silent failure).
  async function handleImportText(text, setBackupStatus) {
    try {
      const trimmed = text.trim();
      if (!trimmed) throw new Error("Paste your backup into the text area first.");

      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch { throw new Error("Pasted text isn't valid JSON."); }

      validateImportPayload(parsed);

      const summary = summarizeImport(parsed);
      const ok = await showConfirmModal({
        title: "Import backup?",
        message: "This will replace your current setup with:",
        detail: summary,
        warning: "Your current goals and layout will be lost unless you copied them first.",
        confirmLabel: "Import",
        danger: true,
      });
      if (!ok) { setBackupStatus("Import cancelled."); return; }

      applyImportedState(parsed);
      setBackupStatus("Import successful.", "ok");
      // Close the settings modal — the old tab/widget state the user
      // was looking at is gone; dropping back to the fresh widget
      // layout makes the change visible immediately.
      closeSettingsModal();
    } catch (err) {
      setBackupStatus(`Import failed: ${err.message}`, "err");
    }
  }

  // Human-readable summary of what an import payload contains, for the
  // confirmation dialog. Counting goals per type rather than listing
  // them individually keeps the message short.
  function summarizeImport(payload) {
    const lines = [];
    let totalGoals = 0;
    for (const type of Object.keys(GOAL_CONFIG)) {
      const n = Array.isArray(payload.goals[type]) ? payload.goals[type].length : 0;
      totalGoals += n;
    }
    lines.push(`• ${totalGoals} goal${totalGoals === 1 ? "" : "s"}`);
    const widgetCount = Object.keys(payload.groups).length;
    lines.push(`• ${widgetCount} widget${widgetCount === 1 ? "" : "s"}`);
    if (payload.exportedAt) {
      try {
        const d = new Date(payload.exportedAt);
        if (!isNaN(d)) lines.push(`• exported ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`);
      } catch {}
    }
    return lines.join("\n");
  }

  function renderBackupTab(contentEl /*, draft */) {
    contentEl.innerHTML = `
      <div class="gt-section-label">Backup</div>
      <p class="gt-backup-text">Copy your goals, widget layout, and settings to the clipboard. You can paste it into an email, note, or message to transfer it to another browser or PC.</p>

      <div class="gt-backup-row">
        <button id="gt-backup-export" class="gt-settings-action-btn primary">Copy backup to clipboard</button>
      </div>

      <textarea id="gt-backup-export-fallback" class="gt-backup-textarea" readonly style="display:none;" aria-label="Backup data — select and copy manually"></textarea>

      <div class="gt-section-label" style="margin-top: 18px;">Restore</div>
      <p class="gt-backup-text">Paste a backup below to replace all current goals, layout, and settings.</p>

      <textarea id="gt-backup-import-text" class="gt-backup-textarea" placeholder="Paste backup here…" aria-label="Paste backup here"></textarea>

      <div class="gt-backup-row">
        <button id="gt-backup-import" class="gt-settings-action-btn secondary">Import pasted backup</button>
      </div>

      <div id="gt-backup-status" class="gt-backup-status" style="display:none;"></div>
    `;

    const statusEl        = contentEl.querySelector("#gt-backup-status");
    const exportFallback  = contentEl.querySelector("#gt-backup-export-fallback");
    const importTextEl    = contentEl.querySelector("#gt-backup-import-text");

    function setBackupStatus(msg, kind = "info") {
      statusEl.textContent = msg;
      statusEl.className = `gt-backup-status gt-backup-status-${kind}`;
      statusEl.style.display = msg ? "block" : "none";
    }

    contentEl.querySelector("#gt-backup-export").addEventListener("click", async () => {
      // Hide fallback textarea from a previous attempt if present
      exportFallback.style.display = "none";
      exportFallback.value = "";

      const result = await copyExportToClipboard((json) => {
        // Fallback path: clipboard API was blocked. Reveal the JSON in
        // a textarea and auto-select it so the user can Ctrl+C manually.
        exportFallback.value = json;
        exportFallback.style.display = "block";
        exportFallback.focus();
        exportFallback.select();
      });
      if (result.ok) {
        setBackupStatus("Copied to clipboard.", "ok");
      } else {
        setBackupStatus("Couldn't auto-copy. Select the text below and copy it manually.", "info");
      }
    });

    contentEl.querySelector("#gt-backup-import").addEventListener("click", () => {
      handleImportText(importTextEl.value, setBackupStatus);
    });
  }

  // Backup tab has no draft/commit semantics — actions happen immediately
  // on click. The commit hook exists purely to satisfy the SETTINGS_TABS
  // contract.
  function commitBackupTab(_draft) { /* no-op */ }

  // ── Settings tab registry ─────────────────────────────────────
  // To add a new settings group, append an entry here. Each tab:
  //   - render(contentEl, draft): populates contentEl with the tab UI.
  //     Must read from & live-update `draft` so edits survive tab swaps.
  //   - commit(draft): applies any changes in `draft` to the underlying state.
  // `openSettingsModal()` will also need to seed a slice of `draft` for
  // the new tab (see settingsDraft initialization below).
  const SETTINGS_TABS = [
    { id: "recurrence", label: "Recurrence", render: renderRecurrenceTab, commit: commitRecurrenceTab },
    { id: "display",    label: "Display",    render: renderDisplayTab,    commit: commitDisplayTab    },
    { id: "rival",      label: "Rival",      render: renderRivalTab,      commit: commitRivalTab      },
    { id: "improve",    label: "Improve",    render: renderImproveTab,    commit: commitImproveTab    },
    { id: "backup",     label: "Backup",     render: renderBackupTab,     commit: commitBackupTab     },
  ];

  // ── Capture currently-visible form values into the draft ─────
  // Number inputs only update `draft` on blur (via the wheel/callback
  // path or manual persist). Called before any action that would
  // replace the DOM (tab/sub-tab switch) or auto-commit, so
  // unblurred input values aren't lost.
  function persistActiveFormToDraft() {
    if (!settingsDraft) return;
    if (activeSettingsTabId !== "recurrence") return;

    const hourEl = document.getElementById("gt-rs-hour");
    const minEl  = document.getElementById("gt-rs-min");
    if (!hourEl || !minEl) return;

    const h = clampInt(hourEl.value, 0, 23, 0);
    const m = clampInt(minEl.value,  0, 59, 0);

    if (activeRecSubTab === "daily") {
      settingsDraft.recSettings.daily = { hour: h, minute: m };
    } else if (activeRecSubTab === "weekly") {
      const weekday = activeWheel ? activeWheel.getValue() : settingsDraft.recSettings.weekly.weekday;
      settingsDraft.recSettings.weekly = { weekday, hour: h, minute: m };
    } else if (activeRecSubTab === "monthly") {
      const day = activeWheel ? activeWheel.getValue() : settingsDraft.recSettings.monthly.day;
      settingsDraft.recSettings.monthly = { day, hour: h, minute: m };
    }
  }

  // ── Modal lifecycle ───────────────────────────────────────────
  // Keep the host page from scrolling while the settings overlay is open.
  // TypeGG hijacks the wheel (one notch = a full-viewport jump via its own JS
  // handler), so an `overflow:hidden` lock can't stop it. We capture the wheel
  // on `window` BEFORE the page's handler, stop it from propagating (kills the
  // viewport jump), and drive the right scroll container manually so it moves
  // both ways: the `.gt-wheel` picker when the pointer is over it (its own
  // `scroll` listener still fires on a programmatic scrollTop), otherwise the
  // settings content; over chrome/backdrop the wheel is just swallowed.
  let pageScrollLock = null;
  function onSettingsWheel(e) {
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    e.preventDefault();
    const t = e.target;
    const pick = (t && t.closest) ? t.closest(".gt-wheel") : null;
    const scroller = document.getElementById("gt-settings-content");
    const el = pick || ((scroller && scroller.contains(t)) ? scroller : null);
    if (!el) return; // over modal chrome or the backdrop → swallow, no scroll
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;                 // lines → px
    else if (e.deltaMode === 2) dy *= el.clientHeight; // pages → px
    el.scrollTop += dy;
  }
  function lockPageScroll() {
    if (pageScrollLock) return;
    const html = document.documentElement;
    const sbw = window.innerWidth - html.clientWidth; // scrollbar width (0 if none)
    pageScrollLock = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
    html.style.overflow = "hidden";
    if (sbw > 0) html.style.paddingRight = `${sbw}px`;
    // Capture + passive:false so we run ahead of TypeGG and may preventDefault.
    window.addEventListener("wheel", onSettingsWheel, { capture: true, passive: false });
  }
  function unlockPageScroll() {
    if (!pageScrollLock) return;
    const html = document.documentElement;
    html.style.overflow = pageScrollLock.overflow;
    html.style.paddingRight = pageScrollLock.paddingRight;
    pageScrollLock = null;
    window.removeEventListener("wheel", onSettingsWheel, { capture: true });
  }

  function openSettingsModal() {
    settingsDraft = {
      recSettings:     JSON.parse(JSON.stringify(recSettings)),
      displaySettings: { ...displaySettings },
      rivalSettings:   { ...rivalSettings },
      improveSettings: { ...improveSettings },
      // future tabs seed their own draft slice here
    };
    if (!activeSettingsTabId || !SETTINGS_TABS.some(t => t.id === activeSettingsTabId)) activeSettingsTabId = SETTINGS_TABS[0].id;
    activeRecSubTab = "daily";
    activeWheel = null;

    buildSettingsSidebar();
    renderActiveSettingsTab();
    settingsOverlay.classList.add("open");
    lockPageScroll();
  }

  function closeSettingsModal() {
    // Safety net: commit any unblurred input edits before discarding the draft.
    // Normally each control auto-commits on change; this catches the edge case
    // where the modal is closed (X / overlay click) while an input is still focused.
    commitAllTabs();
    settingsOverlay.classList.remove("open");
    unlockPageScroll();
    settingsDraft = null;
    activeWheel = null;
  }

  // ── Auto-save infrastructure ──────────────────────────────────
  // Runs every tab's commit() against the current draft. Returns true
  // if the underlying state actually changed. Each tab's commit is
  // already a no-op when its slice is unchanged, but we snapshot
  // before/after as well so we know whether to flash the indicator —
  // this avoids spurious "Settings saved" flashes from things like
  // the wheel firing onChange with its initial value on sub-tab open.
  function commitAllTabs() {
    if (!settingsDraft) return false;
    persistActiveFormToDraft(); // capture any unblurred input edits
    const before = JSON.stringify({ recSettings, displaySettings, rivalSettings, improveSettings });
    for (const tab of SETTINGS_TABS) tab.commit(settingsDraft);
    const after = JSON.stringify({ recSettings, displaySettings, rivalSettings, improveSettings });
    return before !== after;
  }

  // Called by every auto-save trigger (mode click, wheel onChange, input blur).
  // Commits the draft and surfaces the indicator iff something actually changed.
  function applySettingsDraft() {
    if (commitAllTabs()) showSettingsSavedIndicator();
  }

  let savedIndicatorTimer = null;
  function showSettingsSavedIndicator() {
    const el = document.getElementById("gt-settings-saved-indicator");
    if (!el) return;
    el.classList.add("visible");
    clearTimeout(savedIndicatorTimer);
    savedIndicatorTimer = setTimeout(() => el.classList.remove("visible"), 1500);
  }

  function buildSettingsSidebar() {
    const sidebar = document.getElementById("gt-settings-sidebar");
    sidebar.innerHTML = SETTINGS_TABS.map(t =>
      `<button class="gt-settings-tab-btn${t.id === activeSettingsTabId ? " active" : ""}" data-tab-id="${t.id}">${t.label}</button>`
    ).join("");

    sidebar.querySelectorAll(".gt-settings-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.tabId === activeSettingsTabId) return;
        persistActiveFormToDraft(); // capture edits before leaving the current tab
        activeSettingsTabId = btn.dataset.tabId;
        try { localStorage.setItem("gt-settings-tab", activeSettingsTabId); } catch {}
        sidebar.querySelectorAll(".gt-settings-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
        renderActiveSettingsTab();
      });
    });
  }

  function renderActiveSettingsTab() {
    const contentEl = document.getElementById("gt-settings-content");
    const tab = SETTINGS_TABS.find(t => t.id === activeSettingsTabId);
    activeWheel = null; // render() will re-assign if the new tab has a wheel
    if (tab) tab.render(contentEl, settingsDraft);
  }

  // ── Wire settings modal controls ──────────────────────────────
  document.getElementById("gt-settings-btn")   .addEventListener("click", openSettingsModal);
  document.getElementById("gt-settings-close") .addEventListener("click", closeSettingsModal);
  settingsOverlay.addEventListener("click", e => { if (e.target === settingsOverlay) closeSettingsModal(); });

  // ── Recurrence reset-time settings ─────────────────────────────
  // Stored as { daily: {hour, minute}, weekly: {weekday, hour, minute},
  //             monthly: {day, hour, minute} }.
  // weekday uses JS's getDay() convention: 0=Sunday, 1=Monday, ..., 6=Saturday.
  // Defaults match the original behavior (Mon 00:00 for weekly, 1st 00:00 for monthly).
  const REC_SETTINGS_KEY = "gt-rec-settings";
  const DEFAULT_REC_SETTINGS = {
    daily:   { hour: 0, minute: 0 },
    weekly:  { weekday: 1, hour: 0, minute: 0 }, // Monday
    monthly: { day: 1, hour: 0, minute: 0 },
  };

  function loadRecSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(REC_SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return JSON.parse(JSON.stringify(DEFAULT_REC_SETTINGS));
      return {
        daily:   { ...DEFAULT_REC_SETTINGS.daily,   ...(saved.daily   || {}) },
        weekly:  { ...DEFAULT_REC_SETTINGS.weekly,  ...(saved.weekly  || {}) },
        monthly: { ...DEFAULT_REC_SETTINGS.monthly, ...(saved.monthly || {}) },
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_REC_SETTINGS));
    }
  }

  let recSettings = loadRecSettings();

  function saveRecSettings() {
    localStorage.setItem(REC_SETTINGS_KEY, JSON.stringify(recSettings));
    channel?.postMessage({ type: "rec-settings-changed" });
  }

  // ── Display settings ──────────────────────────────────────────
  // Controls the small orange indicator on recurring goals:
  //   "streak" — flame emoji + consecutive-completions count (current default)
  //   "total"  — just the total-completions count, no decoration
  //   "off"    — hide the indicator entirely
  const DISPLAY_SETTINGS_KEY = "gt-display-settings";
  const DEFAULT_DISPLAY_SETTINGS = { streakMode: "streak" };
  const STREAK_MODES = new Set(["streak", "total", "off"]);

  function loadDisplaySettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return { ...DEFAULT_DISPLAY_SETTINGS };
      return {
        streakMode: STREAK_MODES.has(saved.streakMode) ? saved.streakMode : DEFAULT_DISPLAY_SETTINGS.streakMode,
      };
    } catch {
      return { ...DEFAULT_DISPLAY_SETTINGS };
    }
  }

  let displaySettings = loadDisplaySettings();

  function saveDisplaySettings() {
    localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(displaySettings));
    channel?.postMessage({ type: "display-settings-changed" });
  }

  // ── Improve settings (global, apply to all improvement-Target goals) ──
  // nextSort: order the Target card's "→ Next quote" button steps through the
  // not-yet-hit pool — "random", "closest" (smallest gap first), or "biggest"
  // (largest gap first). Global so it can be changed for all Target goals after
  // creation (mirrors the rival Next-vs sort living in Rival settings).
  const IMPROVE_SETTINGS_KEY = "gt-improve-settings";
  const DEFAULT_IMPROVE_SETTINGS = { nextSort: "random" };
  const IMPROVE_NEXT_SORT_VALUES = ["random", "closest", "biggest"];

  function loadImproveSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(IMPROVE_SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return { ...DEFAULT_IMPROVE_SETTINGS };
      return {
        nextSort: IMPROVE_NEXT_SORT_VALUES.includes(saved.nextSort) ? saved.nextSort : DEFAULT_IMPROVE_SETTINGS.nextSort,
      };
    } catch {
      return { ...DEFAULT_IMPROVE_SETTINGS };
    }
  }

  let improveSettings = loadImproveSettings();

  function saveImproveSettings() {
    localStorage.setItem(IMPROVE_SETTINGS_KEY, JSON.stringify(improveSettings));
    channel?.postMessage({ type: "improve-settings-changed" });
  }

  // Live read of the global Target Next-quote ordering.
  function improveNextSort() {
    return IMPROVE_NEXT_SORT_VALUES.includes(improveSettings.nextSort) ? improveSettings.nextSort : "random";
  }

  // ── Rival settings (global, apply to all rival goals) ─────────
  const RIVAL_SETTINGS_KEY = "gt-rival-settings";
  // nextUsesVsLink: when true, the "⚔ Next vs …" button navigates to
  // typegg.io/solo/<quote>/vs/<rival> instead of typegg.io/solo/<quote>.
  // scope: which of the rival's quotes count toward every rival goal —
  // "all" (ranked + unranked), "ranked", or "unranked".
  // nextSort: order the "⚔ Next vs …" button steps through the pool —
  // "random", "closest" (smallest gap first), or "biggest" (largest first).
  // requireBoth: when true, the wins total only counts quotes you've *both*
  // raced (a head-to-head on shared quotes); when false it counts every quote
  // the rival has typed (quotes you haven't raced count as a loss).
  const RIVAL_SCOPE_VALUES = ["all", "ranked", "unranked"];
  const RIVAL_METRIC_VALUES = ["wpm", "pp"];
  const RIVAL_NEXT_SORT_VALUES = ["random", "closest", "biggest"];
  // Difficulty/length range filter for rival goals. The slider axis is
  // DATA-DRIVEN: its bounds come from the difficulty/length of the rival's
  // stored quotes (difficulty floored to an integer, length floored to the
  // nearest 1000), and the max reads "N+" = no upper bound. These constants are
  // only the FALLBACK axis used before any rival quote meta is known. A stored
  // handle is null when it sits at an axis end (= open), so the default is "no
  // filter" and a "+" max stays uncapped as the axis grows.
  const RIVAL_DIFF_MIN = 0, RIVAL_DIFF_MAX = 8;        // fallback difficulty axis
  const RIVAL_LEN_MIN  = 0, RIVAL_LEN_MAX  = 10000;    // fallback length axis
  const RIVAL_LEN_AXIS_ROUND = 1000;                  // length axis floored to this
  const DEFAULT_RIVAL_SETTINGS = {
    nextUsesVsLink: false, scope: "all", metric: "wpm", nextSort: "random", requireBoth: false,
    diffMin: null, diffMax: null, lenMin: null, lenMax: null, fv: 1,
    // Metric-value filter, kept per-metric so switching WPM<->PP preserves each.
    // null = handle at an axis end (open). self* gates YOUR value, rival* the rival's.
    mfWpmSelfMin: null, mfWpmSelfMax: null, mfWpmRivalMin: null, mfWpmRivalMax: null,
    mfPpSelfMin: null, mfPpSelfMax: null, mfPpRivalMin: null, mfPpRivalMax: null,
  };

  function loadRivalSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(RIVAL_SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return { ...DEFAULT_RIVAL_SETTINGS };
      const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
      let diffMin, diffMax, lenMin, lenMax;
      if (saved.fv === 1) {
        // New axis-relative model: a handle is null when it sits at an axis end.
        diffMin = num(saved.diffMin); diffMax = num(saved.diffMax);
        lenMin  = num(saved.lenMin);  lenMax  = num(saved.lenMax);
      } else {
        // Migrate the old fixed-axis model (0..8 / 0..10000): the old "open"
        // ends become null; any interior value the user set is kept.
        const openOr = (v, end) => { const n = num(v); return (n == null || n === end) ? null : n; };
        diffMin = openOr(saved.diffMin, 0);  diffMax = openOr(saved.diffMax, 8);
        lenMin  = openOr(saved.lenMin, 0);   lenMax  = openOr(saved.lenMax, 10000);
      }
      if (diffMin != null && diffMax != null && diffMin > diffMax) { diffMin = null; diffMax = null; }
      if (lenMin  != null && lenMax  != null && lenMin  > lenMax)  { lenMin  = null; lenMax  = null; }
      // Metric-value filter handles (per metric). null = open end; an inverted
      // pair collapses to open (defensive against corrupted storage).
      const fixPair = (lo, hi) => (lo != null && hi != null && lo > hi) ? [null, null] : [lo, hi];
      // The self metric-value filter was removed (self-defeating: improving toward
      // the rival pushed you out of your own window). Force any previously saved
      // self handles to null so a stored filter can't keep applying invisibly.
      const mfWpmSelfMin = null, mfWpmSelfMax = null, mfPpSelfMin = null, mfPpSelfMax = null;
      let [mfWpmRivalMin, mfWpmRivalMax] = fixPair(num(saved.mfWpmRivalMin), num(saved.mfWpmRivalMax));
      let [mfPpRivalMin,  mfPpRivalMax]  = fixPair(num(saved.mfPpRivalMin),  num(saved.mfPpRivalMax));
      return {
        nextUsesVsLink: typeof saved.nextUsesVsLink === "boolean"
          ? saved.nextUsesVsLink
          : DEFAULT_RIVAL_SETTINGS.nextUsesVsLink,
        scope: RIVAL_SCOPE_VALUES.includes(saved.scope)
          ? saved.scope
          : DEFAULT_RIVAL_SETTINGS.scope,
        metric: RIVAL_METRIC_VALUES.includes(saved.metric)
          ? saved.metric
          : DEFAULT_RIVAL_SETTINGS.metric,
        nextSort: RIVAL_NEXT_SORT_VALUES.includes(saved.nextSort)
          ? saved.nextSort
          : DEFAULT_RIVAL_SETTINGS.nextSort,
        requireBoth: typeof saved.requireBoth === "boolean"
          ? saved.requireBoth
          : DEFAULT_RIVAL_SETTINGS.requireBoth,
        diffMin, diffMax, lenMin, lenMax,
        mfWpmSelfMin, mfWpmSelfMax, mfWpmRivalMin, mfWpmRivalMax,
        mfPpSelfMin, mfPpSelfMax, mfPpRivalMin, mfPpRivalMax,
        fv: 1,
      };
    } catch {
      return { ...DEFAULT_RIVAL_SETTINGS };
    }
  }

  let rivalSettings = loadRivalSettings();

  function saveRivalSettings() {
    localStorage.setItem(RIVAL_SETTINGS_KEY, JSON.stringify(rivalSettings));
    channel?.postMessage({ type: "rival-settings-changed" });
  }

  // ── Per-goal rival filter settings ───────────────────────────
  // The comparison filters (scope / metric / require-both / difficulty / length
  // / metric-value bands) are PER-GOAL: changing one is always a local re-tally
  // over the cached per-rival store (memoized by rivalFilterSig), never a
  // re-fetch — so the meaning of accumulated wins is preserved by re-deriving.
  // They live on `gd.rivalSettings`. The legacy global `rivalSettings` keeps
  // only the two navigation prefs (nextSort, nextUsesVsLink) in its Settings UI;
  // its filter fields survive solely as the seed template for NEW goals and the
  // one-time migration below. The bulk fetch stays keyed to the rival USERNAME
  // (identity), untouched by any filter edit.
  const RIVAL_GOAL_SETTINGS_V = 1;
  // The filter slice of a settings object (everything except the nav prefs),
  // sanitised. Pulled from the global object as the template for a new goal.
  function rivalFilterFields(src) {
    const g = src || {};
    const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    return {
      scope:       RIVAL_SCOPE_VALUES.includes(g.scope)   ? g.scope   : "all",
      metric:      RIVAL_METRIC_VALUES.includes(g.metric) ? g.metric  : "wpm",
      requireBoth: !!g.requireBoth,
      diffMin: num(g.diffMin), diffMax: num(g.diffMax),
      lenMin:  num(g.lenMin),  lenMax:  num(g.lenMax),
      // Metric-value bands, per metric. The self-side bands were removed (a
      // self-defeating filter), so only the rival-side handles are kept.
      mfWpmSelfMin: null, mfWpmSelfMax: null,
      mfWpmRivalMin: num(g.mfWpmRivalMin), mfWpmRivalMax: num(g.mfWpmRivalMax),
      mfPpSelfMin: null, mfPpSelfMax: null,
      mfPpRivalMin: num(g.mfPpRivalMin), mfPpRivalMax: num(g.mfPpRivalMax),
    };
  }
  // The settings object a NEW rival goal starts from: no range filter (every
  // difficulty / length / value range full / open) and metric "wpm", but with
  // opinionated comparison defaults — scope "ranked" and shared-only ON — since
  // those match how most rival goals are actually used. Deliberately NOT seeded
  // from the global object: that holds a user's old pre-per-goal filter (e.g. a
  // stale WPM band), which would otherwise re-appear on every new goal. Each goal
  // is configured from scratch in the creation modal (and editable afterwards).
  function defaultRivalGoalSettings() {
    return { ...rivalFilterFields(DEFAULT_RIVAL_SETTINGS), scope: "ranked", requireBoth: true, settingsV: RIVAL_GOAL_SETTINGS_V };
  }
  // The live per-goal filter object — the source of truth for every standings
  // computation. Falls back to a fresh default if a goal somehow lacks one
  // (shouldn't happen post-migration, but keeps every read path total).
  function goalRivalCfg(gd) {
    return (gd && gd.rivalSettings) ? gd.rivalSettings : defaultRivalGoalSettings();
  }
  // One-time seed for EXISTING goals: copy the OLD global filter config onto each
  // rival goal that predates per-goal settings, so a user's previous global
  // filter is preserved on the goals they already had. Guarded by a per-goal
  // settingsV stamp so it can't double-apply, and any fields already on the goal
  // win. New goals don't go through here — they start from the clean default.
  function migrateRivalGoalSettings() {
    const seed = { ...rivalFilterFields(rivalSettings), settingsV: RIVAL_GOAL_SETTINGS_V };
    let changed = false;
    for (const gd of (goalData.rival || [])) {
      if (gd && gd.rivalSettings && gd.rivalSettings.settingsV === RIVAL_GOAL_SETTINGS_V) continue;
      gd.rivalSettings = { ...seed, ...(gd.rivalSettings || {}), settingsV: RIVAL_GOAL_SETTINGS_V };
      changed = true;
    }
    if (changed) saveGoals("rival");
  }

  // ── Migrate recurring goals when reset settings change ──────
  // Without this, renderAllGoals()'s period-rollover check would see
  // stored `periodStart` as stale vs the new settings and wipe the
  // baseline — destroying the user's in-period progress. Re-aligning
  // periodStart (without touching the baseline) preserves progress:
  // progress = currentStat - baseline, so keeping the baseline keeps
  // the gain intact across a schedule change.
  function migrateRecurringGoalPeriodStarts() {
    for (const type of Object.keys(GOAL_CONFIG)) {
      const goals = goalData[type];
      if (!goals || goals.length === 0) continue;
      let changed = false;
      for (let i = 0; i < goals.length; i++) {
        const gd = goals[i];
        if (!gd.recurrence || gd.recurrence === "none") continue;
        const newStart = getCurrentPeriodStart(gd.recurrence);
        if (newStart !== gd.periodStart) {
          goals[i] = { ...gd, periodStart: newStart };
          changed = true;
        }
      }
      if (changed) {
        // Write directly instead of using saveGoals() — other tabs run
        // their own migration on the rec-settings-changed signal, so
        // broadcasting here would just cause a redundant cascade.
        localStorage.setItem(GOAL_CONFIG[type].storageKey, JSON.stringify(goalData[type]));
      }
    }
  }

  function daysInMonth(year, month /* 0-indexed */) {
    return new Date(year, month + 1, 0).getDate();
  }

  // ── Time helpers ───────────────────────────────────────────────
  function getCurrentPeriodStart(rec) {
    const now = new Date();

    if (rec === "daily") {
      const { hour, minute } = recSettings.daily;
      const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
      // If today's reset hasn't happened yet, the period started yesterday.
      if (reset.getTime() > now.getTime()) reset.setDate(reset.getDate() - 1);
      return reset.getTime();
    }

    if (rec === "weekly") {
      const { weekday, hour, minute } = recSettings.weekly;
      const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
      // Walk back to the configured weekday.
      let diff = reset.getDay() - weekday;
      if (diff < 0) diff += 7;
      reset.setDate(reset.getDate() - diff);
      // If that moment is still in the future (e.g. today is the reset day but reset time hasn't hit yet), go back a week.
      if (reset.getTime() > now.getTime()) reset.setDate(reset.getDate() - 7);
      return reset.getTime();
    }

    if (rec === "monthly") {
      const { day, hour, minute } = recSettings.monthly;
      let year = now.getFullYear();
      let month = now.getMonth();
      let useDay = Math.min(day, daysInMonth(year, month));
      let reset = new Date(year, month, useDay, hour, minute, 0, 0);
      if (reset.getTime() > now.getTime()) {
        // Current month's reset is in the future — period started last month.
        month -= 1;
        if (month < 0) { month = 11; year -= 1; }
        useDay = Math.min(day, daysInMonth(year, month));
        reset = new Date(year, month, useDay, hour, minute, 0, 0);
      }
      return reset.getTime();
    }

    return null;
  }

  function getNextResetTime(rec) {
    const startMs = getCurrentPeriodStart(rec);
    if (startMs == null) return null;
    const start = new Date(startMs);

    if (rec === "daily") {
      start.setDate(start.getDate() + 1);
      return start.getTime();
    }
    if (rec === "weekly") {
      start.setDate(start.getDate() + 7);
      return start.getTime();
    }
    if (rec === "monthly") {
      const { day, hour, minute } = recSettings.monthly;
      let year = start.getFullYear();
      let month = start.getMonth() + 1;
      if (month > 11) { month = 0; year += 1; }
      const useDay = Math.min(day, daysInMonth(year, month));
      return new Date(year, month, useDay, hour, minute, 0, 0).getTime();
    }
    return null;
  }
  function formatCountdown(ms) {
    // Round remaining time UP to whole minutes so the displayed
    // countdown lines up with the wall-clock minute the user reads
    // off their screen. Reset times are stored at minute precision
    // (see getCurrentPeriodStart sets seconds = 0), so e.g. at
    // 10:32:50 with a reset at 10:33:00 the diff is 10s — the user
    // thinks "1 minute" because their clock says 10:32, and ceil
    // yields 1m. The old floor produced "0m" here. Clamp to 1 to
    // avoid a transient "0m" frame at the exact reset boundary or
    // from tiny negative drift between render and period rollover.
    const totalMin = Math.max(1, Math.ceil(ms / 60000));
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) {
      // Daily just-reset boundary: exactly 24h remaining → d=1, h=0,
      // m=0. Display "24h" rather than "1d 0h" — matches the user's
      // intuition that "the clock just hit the reset minute, so the
      // next reset is 24 hours away". The same edge fires once per
      // period for weekly/monthly (the moment that's exactly 24h
      // before the next reset), and "24h" reads naturally there too.
      if (d === 1 && h === 0 && m === 0) return "resets in 24h";
      return `resets in ${d}d ${h}h`;
    }
    if (h > 0) return m > 0 ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
    return `resets in ${m}m`;
  }

  // ── Playtime formatter (ms → human) ───────────────────────────
  function formatPlaytime(ms) {
    if (ms <= 0) return "0m";
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    const totalMin = Math.floor(ms / 60000);
    const totalHr  = Math.floor(totalMin / 60);
    const totalDay = Math.floor(totalHr  / 24);
    const totalWk  = Math.floor(totalDay / 7);
    const min = totalMin % 60, hr = totalHr % 24, day = totalDay % 7;
    if (totalWk  > 0) return `${totalWk}w ${day}d ${hr}h`;
    if (totalDay > 0) return min > 0 ? `${totalDay}d ${hr}h ${min}m` : `${totalDay}d ${hr}h`;
    if (totalHr  > 0) return min > 0 ? `${totalHr}h ${min}m` : `${totalHr}h`;
    return `${totalMin}m`;
  }

  const REC_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

  // ── Rank → PP lookup ───────────────────────────────────────────
  async function getPpByRank(targetRank) {
    const perPage = 20;
    const page    = Math.ceil(targetRank / perPage);
    const url     = withLang(`https://api.typegg.io/v1/leaders?sort=totalPp&page=${page}&perPage=${perPage}`);
    const response = await gtApiFetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("Leaderboard fetch failed");
    const data = await response.json();
    const targetUser = data.users?.find(u => u.stats?.ranking === targetRank);
    if (!targetUser) throw new Error(`Rank #${targetRank} not found on page ${page}`);
    return targetUser.stats.totalPp;
  }

  // ── Username → PP lookup ─────────────────────────────────────────
  async function getPpByUsername(username) {
    const url = withLang(`https://api.typegg.io/v1/users/${encodeURIComponent(username)}`);
    
    const response = await gtApiFetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("User fetch failed");
    
    const data = await response.json();
    
    if (!data.stats?.totalPp) {
      throw new Error(`PP not found for user "${username}"`);
    }

    return data.stats.totalPp;
  }

  async function getExpByRank(targetRank) {
    const perPage = 20;
    const page    = Math.ceil(targetRank / perPage);
    
    // Use sort=level to access the Experience/Level leaderboard
    const url     = `https://api.typegg.io/v1/leaders?sort=level&page=${page}&perPage=${perPage}`;
    
    const response = await gtApiFetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("Leaderboard fetch failed");
    
    const data = await response.json();
    
    // Find the user whose ranking in the stats block matches your target
    const targetUser = data.users?.find(u => u.stats?.ranking === targetRank);
    
    if (!targetUser) throw new Error(`Rank #${targetRank} not found on page ${page}`);
    
    // Return the raw experience value
    return targetUser.stats.experience;
}

async function getExpByUsername(username) {
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}`;
    
    const response = await gtApiFetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("User fetch failed");
    
    const data = await response.json();
    
    // Check if the experience property exists (using !== undefined in case EXP is exactly 0)
    if (data.stats?.experience === undefined) {
      throw new Error(`EXP not found for user "${username}"`);
    }

    return data.stats.experience;
}

async function getExpRankByUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new Error('Username is required');
  }

  const target = username.toLowerCase();
  const perPage = 100;                    // actual enforced maximum

  // Search a single page for the target user. Returns rank or null.
  async function searchPage(page) {
    const url = new URL('https://api.typegg.io/v1/leaders');
    url.searchParams.set('sort', 'level');
    url.searchParams.set('perPage', perPage.toString());
    url.searchParams.set('page', page.toString());

    const response = await gtApiFetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`TypeGG API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const user = data.users?.find(u => u.username.toLowerCase() === target);
    return {
      rank: user?.stats?.ranking ?? null,
      totalPages: data.totalPages || 1,
    };
  }

  try {
    // ── Fast path: try the page where we last found the user ─────
    // Rank drifts slowly, so the cached page is usually still correct.
    // This replaces the 10-page scan with 1 request in the common case.
    const cached = JSON.parse(localStorage.getItem("gt-exp-rank-page") || "null");
    if (cached?.page) {
      const { rank } = await searchPage(cached.page);
      if (rank != null) {
        console.log(`Found ${username} at rank ${rank} (cached page ${cached.page})`);
        return rank;
      }
    }

    // ── Slow path: full scan, saving the page for next time ──────
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      // Skip the page we already tried in the fast path
      if (cached?.page === page) { page++; continue; }
      const result = await searchPage(page);
      if (page === 1) totalPages = result.totalPages;
      if (result.rank != null) {
        console.log(`Found ${username} at rank ${result.rank} (page ${page})`);
        localStorage.setItem("gt-exp-rank-page", JSON.stringify({ page }));
        return result.rank;
      }
      page++;
    }

    // User not in the top 1000 — clear any stale cached page
    console.log("user not found in top 1000");
    localStorage.removeItem("gt-exp-rank-page");
    return null;
  } catch (error) {
    console.error('Failed to fetch Level rank:', error);
    throw error;
  }
}

// ── EXP Rank tracking wrapper ────────────────────────────────────
  async function updateExpRankTracking() {
    try {
      const { username } = getAuth();
      if (!username) return; // Wait until the user is actually logged in

      // ── Gate: only scrape the leaderboard if we actually need it ─
      // Previously this ran unconditionally every 60s, hammering the
      // leaderboard endpoint even for users with zero EXP rank goals.
      const hasExpRankGoals = goalData?.exp?.some(g => g.targetRank || g.nextRank);
      const modalOpenForExpRank = overlay.classList.contains("open")
        && selectedType === "exp"
        && selectedMode === "rank";
      if (!hasExpRankGoals && !modalOpenForExpRank) return;

      const rank = await getExpRankByUsername(username);
      
      if (rank !== null) {
        // Cache it in memory alongside your other stats
        currentStats.expRank = rank;

        if (overlay.classList.contains("open")) renderPresets();
        
        // Save to local storage following your existing JSON structure
        const storageKey = `gt-exp-rank`;
        const trackingData = {
          rank: rank,
          updatedAt: Date.now() // Saving as timestamp to match your other date logic
        };
        
        localStorage.setItem(storageKey, JSON.stringify(trackingData));
      }
    } catch (err) {
      console.error("EXP Rank tracking failed:", err);
    }
  }

  // ── Total ranked quotes lookup ────────────────────────────────────
  async function getTypeGGTotalQuotes() {
    try {
      const res = await gtApiFetch('https://api.typegg.io/v1/quotes?perPage=1&status=ranked', {
        headers: { Accept: 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      return data.totalCount;
    } catch (e) {
      console.error('Error fetching total quotes:', e.message);
      return null;
    }
  }

  // ── Total unranked quotes lookup ──────────────────────────────────
  async function getTypeGGTotalUnrankedQuotes() {
    try {
      const res = await gtApiFetch('https://api.typegg.io/v1/quotes?perPage=1&status=unranked', {
        headers: { Accept: 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      return data.totalCount;
    } catch (e) {
      console.error('Error fetching total unranked quotes:', e.message);
      return null;
    }
  }

  // ── Per-status count of quotes a user has typed ───────────────────
  // status: "ranked" | "unranked". Returns the totalCount of the
  // user's distinct quotes typed in that ranking bucket. The ranked
  // count is also surfaced as the `quotesTyped` stat on the user
  // object — but there's no equivalent stat for unranked, so this
  // dedicated endpoint is the only source for it.
  async function getUserQuotesTyped(status) {
    const { username } = getAuth();
    const name = username ?? "fruit";
    const res = await gtApiFetch(
      `https://api.typegg.io/v1/users/${encodeURIComponent(name)}/quotes?status=${status}&perPage=1`,
      { headers: { Accept: 'application/json', ...authHeaders() } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.totalCount;
  }

  // ── Does any current quotes goal need the unranked-typed count? ───
  // Used to gate the extra per-poll fetch: only ranked goals exist for
  // most users, and ranked is fully covered by the `quotesTyped` stat,
  // so we skip the unranked endpoint entirely unless an unranked/all
  // goal is actually present.
  function quotesNeedUnrankedData() {
    const goals = goalData?.quotes || [];
    return goals.some(g => g.maxQuotes && (g.maxQuotesKind === 'unranked' || g.maxQuotesKind === 'all'));
  }

  // Map a goal's stored kind to a canonical value (legacy goals saved
  // before kinds existed carry maxQuotes:true with no kind → "ranked").
  function maxQuotesKindOf(gd) {
    return gd?.maxQuotesKind ?? 'ranked';
  }

  // ── Goal config ────────────────────────────────────────────────
  const GOAL_CONFIG = {
    exp: {
      presets: [500, 1000, 5000, 10000, 50000, 100000],
      baselineKey: "baselineExp", statKey: "experience", storageKey: "gt-goals-exp",
      label: "EXP", supportsTarget: true, decimals: 0,
    },
    pp: {
      presets: [10, 25, 50, 100, 250, 500],
      baselineKey: "baselinePp", statKey: "totalPp", storageKey: "gt-goals-pp",
      label: "PP", supportsTarget: true, decimals: 0,
    },
    races: {
      presets: [10, 25, 50, 100, 250, 500],
      baselineKey: "baselineRaces", statKey: "races", storageKey: "gt-goals-races",
      label: "Races", supportsTarget: true, decimals: 0,
    },
    quotes: {
      presets: [10, 25, 50, 100, 250, 500],
      baselineKey: "baselineQuotes", statKey: "quotesTyped", storageKey: "gt-goals-quotes",
      label: "Quotes", supportsTarget: true, decimals: 0,
    },
    playtime: {
      // presets in ms: 30m, 1h, 2h, 3h, 5h, 10h
      presets: [1800000, 3600000, 7200000, 10800000, 18000000, 36000000],
      baselineKey: "baselinePlaytime", statKey: "playTime", storageKey: "gt-goals-playtime",
      label: "Playtime", supportsTarget: false, decimals: 0,
      isTime: true, customMultiplier: 60000,
    },
    chars: {
    presets: [1000, 5000, 10000, 25000, 50000, 100000],
    baselineKey: "baselineChars",
    statKey: "completionCharactersTyped",
    storageKey: "gt-goals-chars",
    label: "Chars",
    supportsTarget: true,
    decimals: 0,
  },
  // Improvement is a per-quote goal type (its own type now; was a races mode).
  // Like rival it bypasses the cumulative Mode/Amount machinery — supportsTarget
  // is false so the Mode row stays hidden — and is driven by its own controls,
  // render, seed and evaluator paths. baselineKey is present but unused.
  improvement: {
    presets: [], storageKey: "gt-goals-improvement",
    baselineKey: "baselineImprovement",
    label: "Improvement", supportsTarget: false, decimals: 0,
  },
  // Rival is a comparison goal, not a cumulative one — it has no baseline,
  // stat key, presets, target or recurrence. Only storageKey + label are
  // consulted by the generic plumbing (saveGoals, the goals-changed /
  // storage listeners, removeGoal). Everything else about a rival goal is
  // handled by its dedicated render + sync paths further down. supportsTarget
  // is false so the modal hides the Mode/Amount/Recurrence machinery.
  rival: {
    presets: [], storageKey: "gt-goals-rival",
    label: "Rival", supportsTarget: false, decimals: 0,
  },
  };

  // ── Modal state ────────────────────────────────────────────────
  const presetsEl   = document.getElementById("gt-presets");
  const confirmBtn  = document.getElementById("confirm-goal-btn");
  const customInput = document.getElementById("gt-custom-input");
  const typeBtns    = document.querySelectorAll(".gt-type-btn");
  const recBtns     = document.querySelectorAll(".gt-rec-btn");
  // Only true mode buttons (those carrying data-mode). The rival "Track"
  // (scope) group reuses the .gt-mode-selector styling, so a bare
  // ".gt-mode-selector .gt-mode-btn" query would also grab the scope buttons and
  // wire the mode-button handler onto them — clicking a scope button would then
  // set selectedMode to undefined and fall into the "show recurrence row"
  // branch, surfacing recurrence on a rival goal (which has none). Filtering by
  // data-mode keeps this to gain/target/rank/player/average/improvement.
  const modeBtns    = [...document.querySelectorAll(".gt-mode-selector .gt-mode-btn")].filter(b => b.dataset.mode);
  const filterBtns  = document.querySelectorAll(".gt-filter-btn");
  const modeRow     = document.getElementById("gt-mode-row");
  const recRow      = document.getElementById("gt-rec-row");
  const filterRow   = document.getElementById("gt-filter-row");
  const reqRow      = document.getElementById("gt-req-row");
  const reqInputs   = document.querySelectorAll(".gt-req-input");
  const reqStrictBtn = document.getElementById("gt-req-strict-btn");
  const reqUniqueBtn = document.getElementById("gt-req-unique-btn");
  const modeHint    = document.getElementById("gt-mode-hint");
  const amountLabel = document.getElementById("gt-amount-label");
  const amountRow   = document.getElementById("gt-amount-row");

  // Average-mode (rolling-average) controls
  const avgBtn          = document.getElementById("gt-avg-btn");
  const improvementBtn  = document.getElementById("gt-improvement-btn");
  const avgTargetRow    = document.getElementById("gt-avg-target-row");
  const avgInputs       = document.querySelectorAll(".gt-avg-input");
  const avgUniqueBtn    = document.getElementById("gt-avg-unique-btn");
  const avgWindowRow     = document.getElementById("gt-avg-window-row");
  const avgWindowPresets = document.getElementById("gt-avg-window-presets");
  const avgWindowInput   = document.getElementById("gt-avg-window-input");

  // Improvement-mode controls
  const improvementMetricRow  = document.getElementById("gt-improvement-metric-row");
  const improvementMetricBtns = document.querySelectorAll(".gt-improvement-metric-group .gt-mode-btn");
  const improvementFirstTimeBtn = document.getElementById("gt-improvement-firsttime-btn");
  const improvementTrackRow     = document.getElementById("gt-improvement-track-row");
  const improvementTrackBtns    = document.querySelectorAll(".gt-improvement-track-group .gt-mode-btn");
  const improvementWindowRow    = document.getElementById("gt-improvement-window-row");
  const improvementAvgWindowInput = document.getElementById("gt-improvement-avgwindow-input");

  // Improvement-Target controls (improvement type, Target sub-mode).
  const improvementModeRow  = document.getElementById("gt-improvement-mode-row");
  const improvementModeBtns = document.querySelectorAll(".gt-improvement-mode-group .gt-mode-btn");
  const targetStatusRow     = document.getElementById("gt-target-status-row");
  const targetStatusBtns    = document.querySelectorAll(".gt-target-status-group .gt-mode-btn");
  const targetPlayedRow     = document.getElementById("gt-target-played-row");
  const targetPlayedBtns    = document.querySelectorAll(".gt-target-played-group .gt-mode-btn");
  const targetDiffRow       = document.getElementById("gt-target-diff-row");
  const targetLenRow        = document.getElementById("gt-target-len-row");
  const targetSyncHintEl    = document.getElementById("gt-target-sync-hint");

  // Presets for the rolling-window size. Common values for typing-test
  // analytics — small enough that brand-new accounts can hit them, large
  // enough that the avg actually means something. Custom input handles
  // anything outside this set.
  const AVG_WINDOW_PRESETS = [10, 25, 50, 100, 250];

  // Preset target values (cumulative gain) for improvement goals, per
  // metric — PP accrues in much larger numbers than WPM, so the two sets
  // differ. The custom input handles anything outside these.
  const IMPROVEMENT_PRESETS = {
    wpm: [50, 100, 250, 500, 1000],
    pp:  [500, 1000, 2500, 5000, 10000],
  };

  // Improvement-Target threshold presets, per metric. The target is a flat
  // per-quote value (not cumulative), so WPM is typical-speed magnitudes and PP
  // is per-race PP magnitudes. The custom input handles anything outside these.
  // (PP-per-race magnitudes are a guess — tune against live values.)
  const TARGET_PRESETS = {
    wpm: [60, 80, 100, 120, 150],
    pp:  [400, 500, 600, 700, 800],
  };

  let selectedType  = "exp";
  let selectedRec   = "none";
  let selectedMode  = "gain";
  let selectedFilter = "all"; // for races: "all" or "quickplay"
  let selectedValue = null; // always raw units (ms for playtime)
  // Requirements state — only meaningful when type=races + mode=gain.
  // null on each axis = that axis isn't required. strict = goal resets to 0 on a miss.
  // uniqueOnly = a qualifying race only counts if its quoteId hasn't been
  // qualified on yet this period (duplicate-quote no-op; doesn't trigger strict reset).
  let selectedReq    = { wpm: null, accuracy: null, pp: null, length: null, difficulty: null };
  let selectedStrict = false;
  let selectedUnique = false;

  // Rolling-average state. Only consulted in mode=average.
  // selectedMetric ∈ {"wpm","accuracy","pp"} — which race field gets
  // averaged. Driven by typing in one of the chip inputs (mutually
  // exclusive: typing in WPM clears ACC/PP). Null = no metric picked yet.
  // selectedWindow — how many races make up the rolling window. Validated >0.
  let selectedMetric = null;
  let selectedWindow = null;

  // Improvement-mode state. Only consulted in mode=improvement.
  // selectedImprovementMetric ∈ {"wpm","pp"} — which race field's per-quote
  // gain is accumulated (defaults to wpm). selectedCountFirstTime: when true,
  // the FIRST time you type a quote also counts (baseline 0); when false
  // (the default) only quotes you've already typed at least once count, since
  // "improvement" needs a previous best to measure against.
  let selectedImprovementMetric = "wpm";
  let selectedCountFirstTime    = false;
  // Track row: compare each race against your per-quote "best" (default,
  // ratchets your PB) or your rolling "average". The average track is always
  // rolling over improvementAvgWindow races — that one number is the window,
  // the warm-up length, and the baseline sample size.
  let selectedImprovementTrack     = "best";     // "best" | "average"
  let selectedImprovementAvgWindow = 5;          // rolling window / warm-up

  // Improvement sub-mode (bespoke Gain/Target toggle) + Target-goal draft.
  // selectedImprovementMode is "gain" (the existing accumulator) or "target"
  // (the catalog threshold goal). Target handles are null = full range.
  let selectedImprovementMode = "gain";
  let selectedTargetStatus    = "ranked";       // "all" | "ranked" | "unranked"
  let selectedTargetPlayed    = "played";       // "all" | "played"
  let selectedTargetDiffMin = null, selectedTargetDiffMax = null;
  let selectedTargetLenMin  = null, selectedTargetLenMax  = null;

  // rank mode state
  let rankFetchedPp     = null; // PP fetched for the entered rank
  let rankFetchedExp    = null; // EXP fetched for the entered rank
  let rankFetchedRank   = null; // the rank number we fetched for
  let rankDebounce      = null;
  let nextRankMode      = false; // "next rank" toggle

  const nextRankRow        = document.getElementById("gt-next-rank-row");
  const nextRankToggleBtn  = document.getElementById("gt-next-rank-btn");

  const maxQuotesRow       = document.getElementById("gt-max-quotes-row");
  const maxCharsRow        = document.getElementById("gt-max-chars-row");
  const maxAllBtn          = document.getElementById("gt-max-all-btn");
  const maxRankedBtn       = document.getElementById("gt-max-ranked-btn");
  const maxUnrankedBtn     = document.getElementById("gt-max-unranked-btn");
  const maxQuotesBtns = { all: maxAllBtn, ranked: maxRankedBtn, unranked: maxUnrankedBtn };
  const maxCharsAllBtn      = document.getElementById("gt-max-chars-all-btn");
  const maxCharsRankedBtn   = document.getElementById("gt-max-chars-ranked-btn");
  const maxCharsUnrankedBtn = document.getElementById("gt-max-chars-unranked-btn");
  const maxCharsBtns = { all: maxCharsAllBtn, ranked: maxCharsRankedBtn, unranked: maxCharsUnrankedBtn };
  const charsKindRow  = document.getElementById("gt-chars-kind-row");
  const charsKindBtns = document.querySelectorAll("[data-chars-kind]");

  // Rival-mode controls (type=rival).
  const rivalMetricRow  = document.getElementById("gt-rival-metric-row");
  const rivalMultiModeBtns = document.querySelectorAll("[data-rival-multimode]");
  const rivalAddBtn      = document.getElementById("gt-rival-add-btn");
  const rivalListEl      = document.getElementById("gt-rival-inline-tags"); // chips live inside the entry field now
  const amountTargetRow  = document.getElementById("gt-amount-target-row");  // becomes the rival tag field
  // Rival comparison config (creation modal). These mirror the per-goal edit
  // popover; their values live in rivalDraftSettings until the goal is created,
  // at which point they seed gd.rivalSettings. No save/re-tally here — creation
  // commits on Confirm.
  const rivalConfigRow   = document.getElementById("gt-rival-config-row");
  const rivalCfgMetricBtns = rivalConfigRow ? rivalConfigRow.querySelectorAll("[data-rvc-metric]") : [];
  const rivalCfgScopeBtns  = rivalConfigRow ? rivalConfigRow.querySelectorAll("[data-rvc-scope]")  : [];
  const rivalCfgBothBtns   = rivalConfigRow ? rivalConfigRow.querySelectorAll("[data-rvc-both]")   : [];
  let rivalDraftSettings = defaultRivalGoalSettings();
  // A throwaway goal-shaped object so the data-driven axes scope to the rival(s)
  // currently chosen in the modal. Their stores are usually empty at creation
  // (the bulk fetch starts after Confirm), so the sliders show the fallback axis
  // until a rival you already track elsewhere is chosen — exactly like the edit
  // popover once synced.
  function rivalCreateSyntheticGd() {
    return rivalMultiMode
      ? { id: "__rival_create__", mode: "multi", rivals: selectedRivalList.slice() }
      : { id: "__rival_create__", rival: rivalFetchedName || null };
  }
  function reflectRivalCfgButtons() {
    const m = rivalMetric(rivalDraftSettings), sc = rivalScope(rivalDraftSettings), rb = !!rivalDraftSettings.requireBoth;
    rivalCfgMetricBtns.forEach(b => b.classList.toggle("active", b.dataset.rvcMetric === m));
    rivalCfgScopeBtns.forEach(b => b.classList.toggle("active", b.dataset.rvcScope === sc));
    rivalCfgBothBtns.forEach(b => b.classList.toggle("active", (b.dataset.rvcBoth === "true") === rb));
    const lbl = document.getElementById("gt-rival-cfg-band-label");
    if (lbl) lbl.textContent = `Rival ${m.toUpperCase()} filter`;
  }
  function buildRivalCreateSliders() {
    if (!rivalConfigRow) return;
    const sgd = rivalCreateSyntheticGd();
    const fAxis = rivalFilterAxis(rivalDraftSettings, sgd);
    const mAxis = rivalMetricAxis(rivalDraftSettings, sgd);
    const mk = rivalMetricKeys(rivalDraftSettings);
    const clampD = (v) => Math.max(fAxis.diffMin, Math.min(fAxis.diffMax, v));
    const clampL = (v) => Math.max(fAxis.lenMin,  Math.min(fAxis.lenMax,  v));
    const clampR = (v) => Math.max(mAxis.rivalMin, Math.min(mAxis.rivalMax, v));
    const dLo = rivalDraftSettings.diffMin == null ? fAxis.diffMin : clampD(rivalDraftSettings.diffMin);
    const dHi = rivalDraftSettings.diffMax == null ? fAxis.diffMax : clampD(rivalDraftSettings.diffMax);
    const lLo = rivalDraftSettings.lenMin  == null ? fAxis.lenMin  : clampL(rivalDraftSettings.lenMin);
    const lHi = rivalDraftSettings.lenMax  == null ? fAxis.lenMax  : clampL(rivalDraftSettings.lenMax);
    const rLo = rivalDraftSettings[mk.rMin] == null ? mAxis.rivalMin : clampR(rivalDraftSettings[mk.rMin]);
    const rHi = rivalDraftSettings[mk.rMax] == null ? mAxis.rivalMax : clampR(rivalDraftSettings[mk.rMax]);
    setupTargetRange("gt-rival-cfg-diff-range", "gt-rival-cfg-diff-readout", "gt-rival-cfg-diff-ticks", {
      min: fAxis.diffMin, max: fAxis.diffMax, step: 0.1, decimals: true,
      ticks: [String(fAxis.diffMin), `${fAxis.diffMax}+`], lo: dLo, hi: dHi,
      set: (lo, hi) => { rivalDraftSettings.diffMin = lo; rivalDraftSettings.diffMax = hi; },
    });
    setupTargetRange("gt-rival-cfg-len-range", "gt-rival-cfg-len-readout", "gt-rival-cfg-len-ticks", {
      min: fAxis.lenMin, max: fAxis.lenMax, step: 1, decimals: false,
      ticks: [String(fAxis.lenMin), `${fAxis.lenMax}+`], lo: lLo, hi: lHi,
      set: (lo, hi) => { rivalDraftSettings.lenMin = lo; rivalDraftSettings.lenMax = hi; },
    });
    setupTargetRange("gt-rival-cfg-band-range", "gt-rival-cfg-band-readout", "gt-rival-cfg-band-ticks", {
      min: mAxis.rivalMin, max: mAxis.rivalMax, step: 1, decimals: false,
      ticks: [String(mAxis.rivalMin), `${mAxis.rivalMax}+`], lo: rLo, hi: rHi,
      set: (lo, hi) => { const k = rivalMetricKeys(rivalDraftSettings); rivalDraftSettings[k.rMin] = lo; rivalDraftSettings[k.rMax] = hi; },
    });
  }
  // Refresh the sliders if the rival config is currently visible (selection or
  // toggle change). Deferred a frame so any just-injected DOM is laid out.
  function refreshRivalCreateSliders() {
    if (rivalConfigRow && rivalConfigRow.style.display !== "none") requestAnimationFrame(buildRivalCreateSliders);
  }
  rivalCfgMetricBtns.forEach(btn => btn.addEventListener("click", () => {
    const val = btn.dataset.rvcMetric === "pp" ? "pp" : "wpm";
    if (val === rivalMetric(rivalDraftSettings)) return;
    rivalDraftSettings.metric = val;
    reflectRivalCfgButtons();
    buildRivalCreateSliders(); // band axis + which handles apply depend on metric
  }));
  rivalCfgScopeBtns.forEach(btn => btn.addEventListener("click", () => {
    const val = btn.dataset.rvcScope;
    if (val === rivalScope(rivalDraftSettings)) return;
    rivalDraftSettings.scope = val;
    reflectRivalCfgButtons();
    buildRivalCreateSliders(); // scope shifts every axis bound
  }));
  rivalCfgBothBtns.forEach(btn => btn.addEventListener("click", () => {
    const val = btn.dataset.rvcBoth === "true";
    if (val === !!rivalDraftSettings.requireBoth) return;
    rivalDraftSettings.requireBoth = val;
    reflectRivalCfgButtons();
    buildRivalCreateSliders(); // shared-only narrows the data pool -> axis
  }));
  // Render the chosen-rivals list as removable chips (multiple mode). Owns the
  // visibility of the whole "Current Rivals" row: shown only in multiple mode
  // once at least one rival has been added.
  // Render the chosen rivals as removable chips INSIDE the entry field (the
  // amount row, styled as a tag field for rival). Only multiple-rivals mode
  // shows chips; single mode keeps just the text input. The "Current Rivals"
  // section was merged into this field (modern "To:"-style tag input).
  function renderRivalList() {
    if (!rivalListEl) return;
    rivalListEl.innerHTML = "";
    refreshRivalCreateSliders(); // chosen-rival set changed -> axes may shift
    if (!(rivalMultiMode && selectedRivalList.length > 0)) return;
    for (const name of selectedRivalList) {
      const chip = document.createElement("span");
      chip.className = "gt-rival-list-chip";
      const label = document.createElement("span");
      label.textContent = name;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "gt-rival-list-x";
      x.textContent = "\u2715";
      x.title = `Remove ${name}`;
      x.addEventListener("click", () => {
        selectedRivalList = selectedRivalList.filter(n => n !== name);
        renderRivalList();
        validateConfirm();
      });
      chip.appendChild(label);
      chip.appendChild(x);
      rivalListEl.appendChild(chip);
    }
  }
  // rivalFetchedName: the validated rival username (null until a valid user is
  // confirmed via the username input). rivalDebounce: input debounce timer.
  // (Metric / scope / shared / ranges now live in rivalDraftSettings, set via
  // the per-goal config controls in the creation modal — see #gt-rival-config-row.)
  let rivalFetchedName    = null;
  let rivalDebounce       = null;
  // Multiple-rivals mode (rival goal type). rivalMultiMode toggles single vs
  // multiple; selectedRivalList holds the resolved rival names chosen so far;
  // rivalPendingName is a validated-but-not-yet-added name awaiting the Add btn.
  let rivalMultiMode      = false;
  let selectedRivalList   = [];
  let rivalPendingName    = null;

  let playerFetchedValue = null;
  let playerFetchedName = null;
  let playerDebounce = null;

  // max quotes mode state
  let maxQuotesMode = false; // "max" toggle for quotes (any kind active)
  let maxQuotesKind = null;  // "ranked" | "unranked" | "all" when active
  let maxQuotesFetched = null; // total quotes count for the selected kind
  let maxQuotesBaseline = null; // user's currently-typed count for the selected kind (becomes the goal baseline)
  let maxCharsMode = false; // "max" toggle for chars (distinct-quote chars; any kind active)
  let maxCharsKind = null;  // "ranked" | "unranked" | "all" when active
  // Chars-kind toggle (chars type): "regular" = repeatable cumulative chars
  // (default), "quote" = distinct-new-quote chars. Governs the goal's metric and
  // whether the Max-chars buttons show.
  let selectedCharsKind = "regular";

  function formatPreset(n) {
    if (n >= 1000) return (n/1000)%1===0 ? `${n/1000}k` : `${(n/1000).toFixed(1)}k`;
    return String(n);
  }

  // ── Requirements helpers ───────────────────────────────────────
  // Race goals (gain mode) can attach a `requirements` object that gates
  // which races count: only races meeting EVERY active threshold qualify.
  // Active = non-null. Missing axes mean "no requirement on this axis".
  //
  // There are two CATEGORIES of requirement:
  //   - SKILL axes (wpm, accuracy, pp): properties of how the user raced.
  //     Available directly on the race object from /users/{name}/races.
  //   - QUOTE axes (length, difficulty): properties of the quote itself.
  //     Need a SECOND fetch to /quotes/{quoteId} to evaluate.
  //
  // The split matters because quote fetches are extra HTTP calls per race
  // that we only want to make if at least one active goal actually has
  // a length or difficulty threshold set.
  const REQ_SKILL_AXES = ["wpm", "accuracy", "pp"];
  const REQ_QUOTE_AXES = ["length", "difficulty"];
  const REQ_ALL_AXES = [...REQ_SKILL_AXES, ...REQ_QUOTE_AXES];

  function hasAnyReq(req) {
    if (!req) return false;
    return REQ_ALL_AXES.some(axis => req[axis] != null);
  }

  // Does this goal use the requirement-evaluator path (qualifyingProgress)
  // instead of the simple lifetime-delta path? True iff it has any threshold
  // requirements OR has uniqueOnly enabled. Standalone uniqueOnly is a valid
  // configuration — "complete N races on N different quotes" — and needs the
  // same evaluator plumbing as threshold goals (qualifyingProgress, lastEvalRaces,
  // race-list fetches), just without any per-axis bar to clear.
  function goalIsGated(g) {
    if (!g) return false;
    return hasAnyReq(g.requirements) || !!g.uniqueOnly;
  }

  // ── Rolling-average helpers ─────────────────────────────────────
  // A rolling-average goal is fundamentally different from gain/target/req
  // goals: it doesn't accumulate. Instead it maintains a sliding window of
  // the last N race values for one metric (WPM, ACC, or PP) and tracks
  // peak rolling-window mean ("best") vs target.
  //
  // Storage shape (in addition to the common goal fields):
  //   mode: "average"             ← marker so render/eval can branch
  //   metric: "wpm"|"accuracy"|"pp"
  //   targetAvg: number           ← user's target avg
  //   windowSize: number          ← how many races in the rolling window
  //   windowRaces: number[]       ← stored metric values, max length=windowSize
  //   bestAvg: number | null      ← peak full-window avg this period; null while filling
  //   lastEvalRaces: number       ← lifetime-races snapshot, like for req goals
  //
  // completedThisPeriod is reused as the sticky achievement flag — same
  // semantics as recurring gain goals (true once target was hit, resets at
  // period rollover, drives streak +1).
  function goalIsAverage(g) {
    return !!g && g.mode === "average";
  }

  // ── Improvement-mode helper ─────────────────────────────────────
  // An improvement goal (mode="improvement") tracks cumulative WPM gain
  // measured per-quote against the user's best on that quote BEFORE the
  // race (the "S1" semantic). State (in addition to common goal fields):
  //   mode: "improvement"
  //   target: number             ← target cumulative WPM gain
  //   quoteBests: { [quoteId]: bestWpm }
  //                              ← per-quote baseline, seeded at quote-start
  //                                (capturing the pre-race PB) and then
  //                                ratcheted up by the evaluator on each PB.
  //   accumulatedGain: number    ← sum of positive (wpm − prevBest) deltas
  //   lastEvalRaces: number      ← lifetime-races snapshot, like avg/gated.
  // completedThisPeriod is reused as the sticky achievement flag, same as
  // gain/avg goals (drives streak +1 and resets at period rollover).
  function goalIsImprovement(g) {
    return !!g && g.mode === "improvement";
  }

  // Drop 2: the improvement type's second sub-mode. A goal living in
  // goalData.improvement with mode === "target" is a TARGET goal ("hit a flat
  // metric threshold on every quote in a filtered catalog set"). Kept distinct
  // from goalIsImprovement (the "Gain" behaviour, mode === "improvement") so the
  // existing gain evaluator/seeds ignore target goals and vice-versa.
  function goalIsImprovementTarget(g) {
    return !!g && g.mode === "target";
  }

  // ── Per-goal count-view ─────────────────────────────────────────
  // A purely cosmetic per-goal preference: show a count line as "X / Y"
  // (progress, default) or "Z to go" (remaining, Z = Y − X). Stored as a
  // string so it stays extensible; any unknown/absent value reads as
  // "progress". Round-trips through saveGoals' JSON.stringify untouched.
  function goalCountView(g) {
    return (g && g.countView === "remaining") ? "remaining" : "progress";
  }
  // Whether a goal has at least one monotonic count line that "Z to go" can
  // sensibly describe — i.e. anything that builds toward a fixed target. Only
  // pure average goals are excluded (a rolling average fluctuates, so there's
  // no meaningful "remaining"). Drives the header toggle's visibility. The
  // per-LINE decision (a single-value comparison row never flips) lives inside
  // the Target / rival renderers, not here.
  function goalHasToggleableLine(type, g) {
    return !goalIsAverage(g);
  }
  // Whether any improvement-Target goal exists. Gates ALL catalog work: we never
  // fetch the ~14k-quote catalog (nor mark self "wanted" for it) unless one does.
  function haveImprovementTargetGoals() {
    return (goalData.improvement || []).some(goalIsImprovementTarget);
  }
  // Max-chars goals read the self store (Σ length of raced quotes), so they need
  // the same finish-time self-store sync as rival / improvement-target goals --
  // otherwise their gain pill lags the stat-driven Max-quotes pill by a fetch.
  function haveMaxCharsGoals() {
    return (goalData.chars || []).some(g => g && g.maxChars);
  }

  // Does this goal need the racesEndpoint (for window math or req eval)?
  // Gated, average AND improvement goals all consume new races; everything
  // else is pure stat-delta and doesn't need the per-race list.
  function goalNeedsRaceList(g) {
    return goalIsGated(g) || goalIsAverage(g) || goalIsImprovement(g);
  }

  // Pull the right metric value out of a race object. Accuracy is stored
  // as 0–1 in the API but presented to the user as 0–100, so we normalize
  // here once. Same convention as meetsSkillRequirements above.
  // Returns NaN for malformed races; callers should skip those.
  function getRaceMetricValue(race, metric) {
    if (!race) return NaN;
    if (metric === "accuracy") return (Number(race.accuracy) || 0) * 100;
    if (metric === "wpm")      return Number(race.wpm) || 0;
    if (metric === "pp")       return Number(race.pp) || 0;
    return NaN;
  }

  // Mean of an array of numbers. Returns null for empty arrays so callers
  // can branch on "no data yet" without sentinel checks.
  function arrayMean(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let sum = 0;
    for (const v of arr) sum += v;
    return sum / arr.length;
  }

  // Display label for a metric in the goal title ("WPM", "ACC", "PP").
  function metricLabel(metric) {
    if (metric === "accuracy") return "ACC";
    if (metric === "pp")       return "PP";
    return "WPM";
  }

  // Number of decimals to render for a given metric. Accuracy gets two
  // decimals because race-to-race avg movements are tiny (everyone's
  // operating in the 95-100% range, and a single race in a 25-race
  // window can shift the mean by 0.04% — invisible at 1 decimal). WPM
  // and PP swing more per race, so 1 decimal shows movement clearly.
  // Knock-on effects: applies to current/best/threshold/target display
  // and to the +/- delta pill formatting (zero-after-rounding suppression
  // also benefits — at 2 decimals the "no visible change" threshold
  // drops 10x, so genuinely-different races stop flashing as 0.00).
  function metricDecimals(metric) {
    return metric === "accuracy" ? 2 : 1;
  }

  // Format a metric value for display, with appropriate suffix ("%" for
  // accuracy, otherwise nothing). Pass null for the "no data yet" state.
  function formatMetricVal(v, metric) {
    if (v == null || isNaN(v)) return "—";
    const n = Number(v).toFixed(metricDecimals(metric));
    return metric === "accuracy" ? `${n}%` : n;
  }

  // Format a target value (user-entered, integer-ish). Same as above but
  // without forcing decimals — the user typically enters whole-ish numbers.
  function formatMetricTarget(v, metric) {
    if (v == null) return "—";
    // If the value is a whole number, render without decimals; otherwise
    // honor user-entered precision up to 1 decimal place.
    const isWhole = Math.abs(v - Math.round(v)) < 1e-9;
    const s = isWhole ? String(Math.round(v)) : Number(v).toFixed(metricDecimals(metric));
    return metric === "accuracy" ? `${s}%` : s;
  }

  // Compute the threshold value — the number a new race must beat for the
  // current avg to go up. While the window is filling, that's the current
  // partial avg (any race above it pulls the mean up). Once full, it's the
  // OLDEST race in the window (the one that gets evicted by the next race).
  // Returns null if windowRaces is empty (no data to compute against yet).
  function computeThreshold(windowRaces, windowSize) {
    if (!Array.isArray(windowRaces) || windowRaces.length === 0) return null;
    if (windowRaces.length < windowSize) {
      return arrayMean(windowRaces);
    }
    // windowRaces[0] is the oldest entry — see the avg branch in
    // evaluateRaceRequirements, which pushes new races to the end.
    return windowRaces[0];
  }

  // ── Average-goal post-creation edits (target / rolling window) ────
  // Re-derive the sticky completion flag after the user changes an
  // average goal's target or window. bestAvg is the peak full-window
  // mean this period; when it no longer clears the (possibly raised)
  // target — or the window grew and isn't full yet, so bestAvg is null —
  // the goal is no longer achieved and its completed styling reverts.
  // Symmetric the other way: lowering the target so a known peak now
  // clears it re-marks the goal complete, matching the live evaluator.
  function reconcileAvgCompletion(gd) {
    gd.completedThisPeriod = gd.bestAvg != null && gd.bestAvg >= gd.targetAvg;
  }
  // Resize an average goal's rolling window in place, keeping the most
  // recent races still stored. Growing past what's stored leaves the
  // window under-full, so bestAvg drops back to null (hidden) and refills
  // exactly like a freshly-created goal; shrinking trims to the newest
  // `newSize` races and seeds bestAvg from that now-full window. The
  // unique-quote tracker (windowQuoteIds) is trimmed in lockstep, and the
  // delta trackers are cleared so the next render shows no spurious pill.
  function resizeAvgWindow(gd, newSize) {
    let races = Array.isArray(gd.windowRaces) ? gd.windowRaces.slice() : [];
    let qids  = (gd.uniqueOnly && Array.isArray(gd.windowQuoteIds))
      ? gd.windowQuoteIds.slice() : null;
    if (races.length > newSize) {
      races = races.slice(races.length - newSize); // keep newest (oldest-first)
      if (qids) qids = qids.slice(qids.length - newSize);
    }
    gd.windowSize  = newSize;
    gd.windowRaces = races;
    if (qids) gd.windowQuoteIds = qids;
    // bestAvg only exists for a full window; a partial window hides it.
    gd.bestAvg = (races.length === newSize) ? arrayMean(races) : null;
    delete prevAvgMap[gd.id];
    delete prevBestMap[gd.id];
  }

  // Does this goal's requirements need /quotes/{id} data to evaluate?
  // True iff at least one quote-axis threshold (length or difficulty) is set.
  function goalNeedsQuoteData(req) {
    if (!req) return false;
    return REQ_QUOTE_AXES.some(axis => req[axis] != null);
  }

  // Skill-axis check: race-level fields only. The "user-controlled" half of
  // the requirements — these reflect how the user raced (effort/skill).
  // Strict mode bites on a failure here.
  // Returns true when no req is set (consistent with meetsQuoteRequirements).
  function meetsSkillRequirements(race, req) {
    if (!race) return false;
    if (!req)  return true;
    if (req.wpm      != null && (Number(race.wpm)      || 0)       < req.wpm)      return false;
    // race.accuracy is 0–1 (e.g. 1.0 = 100%); req.accuracy is 0–100 (user input).
    // Multiply race side by 100 to align scales — without this, a perfect 1.0
    // race never beats a 90+ threshold.
    if (req.accuracy != null && (Number(race.accuracy) || 0) * 100 < req.accuracy) return false;
    if (req.pp       != null && (Number(race.pp)       || 0)       < req.pp)       return false;
    return true;
  }

  // Quote-axis check: properties read from the quote object (separate fetch).
  // The "quote-controlled" half — properties of the text the user got dealt
  // (length, difficulty), NOT something they chose. A quote-axis miss is
  // treated like a filter mismatch by the evaluator: invisible, not a fail.
  // If a quote axis is set but `quote` is null/undefined, the race fails —
  // we can't verify, so we don't qualify. Caller is responsible for fetching
  // the quote up-front for any goal where goalNeedsQuoteData(req) is true.
  function meetsQuoteRequirements(quote, req) {
    if (!req) return true;
    if (req.length     != null) {
      if (!quote) return false;
      if ((Number(quote.length)     || 0) < req.length)     return false;
    }
    if (req.difficulty != null) {
      if (!quote) return false;
      if ((Number(quote.difficulty) || 0) < req.difficulty) return false;
    }
    return true;
  }

  // Pre-check applied early in the evaluator when a goal has a filter
  // (quickplay / solo). The race object exposes `gamemode` ∈ {"quickplay","solo"}.
  // Behavior:
  //   - filter="all" / null / undefined → every race matches
  //   - filter="quickplay"               → only quickplay races match
  //   - filter="solo"                    → only solo races match
  // Races that don't match the filter are SKIPPED entirely in the evaluator
  // — they don't increment qualifyingProgress AND they don't trigger a
  // strict-mode reset. This matches the user's mental model: "a slow solo
  // race shouldn't break my quickplay-only streak". Quote-property mismatches
  // (LEN / DIFF) are skipped under the same principle: see the evaluator.
  function raceMatchesFilter(race, filter) {
    if (!filter || filter === "all") return true;
    return race?.gamemode === filter;
  }

  // Compact human-readable suffix for the goal label, split into two
  // strings so they can be rendered on separate lines in the goal display:
  //   - skill: "100+ WPM, 98%+ ACC"  (user-skill requirements)
  //   - quote: "200+ LEN, 0.7+ DIFF" (quote-property requirements)
  // The mode glyphs (⚡ strict / ✨ unique-only) attach to the skill line
  // — and that's not just a visual choice. Strict only fires on skill-axis
  // misses (the user-controlled half), and unique applies whenever a race
  // qualifies on skill, so anchoring the glyphs to the skill line accurately
  // signals what they actually gate. Falls back to the quote line, then to
  // a glyph-only line, when there's no skill content to attach to.
  // PP/WPM/LEN use toLocaleString so 4-digit values get locale separators
  // (e.g. "1,200+ PP" in en-US, "1'200+ PP" in de-CH).
  function formatRequirementsSuffix(req, strict, uniqueOnly) {
    // `req` may be undefined for uniqueOnly-only goals — default to {} so
    // the != null checks below don't throw on property access.
    req = req || {};
    const skillParts = [];
    if (req.wpm      != null) skillParts.push(`${Number(req.wpm).toLocaleString()}+ WPM`);
    if (req.pp       != null) skillParts.push(`${Number(req.pp).toLocaleString()}+ PP`);
    if (req.accuracy != null) skillParts.push(`${req.accuracy}%+ ACC`);

    const quoteParts = [];
    if (req.length     != null) quoteParts.push(`${Number(req.length).toLocaleString()}+ LEN`);
    if (req.difficulty != null) quoteParts.push(`${req.difficulty}+ DIFF`);

    // Build the mode-glyph trailer (e.g. "⚡", "✨", or "⚡ ✨").
    // Both modes can co-exist and stack at the end of the line, sitting
    // just to the right of the requirements text (e.g. "100+ WPM ⚡ ✨").
    const glyphs = [];
    if (strict)     glyphs.push("⚡");
    if (uniqueOnly) glyphs.push("✨");
    const glyphStr = glyphs.join(" ");

    let skill = skillParts.join(", ");
    let quote = quoteParts.join(", ");
    if (glyphStr && skill) skill = `${skill} ${glyphStr}`;
    // Edge case: glyphs present but only quote-axis reqs (no skill) —
    // still show them somewhere. Append to the quote line in that case.
    if (glyphStr && !skill && quote) quote = `${quote} ${glyphStr}`;
    // Final edge: a uniqueOnly-only goal has neither skill nor quote
    // parts — the glyph alone IS the suffix. Put it on the skill line
    // so the user gets a visible reminder that unique-mode is on.
    if (glyphStr && !skill && !quote) skill = glyphStr;
    return { skill, quote };
  }

  function updateModeHint() {
    const cfg = GOAL_CONFIG[selectedType];
    if (selectedMode === "rank") {
      // hint is managed by the async rank fetch — don't touch it here
      return;
    }
    if (!cfg.supportsTarget || selectedMode !== "target") { modeHint.style.display = "none"; return; }
    // Quote-chars target mode measures DISTINCT-new-quote chars, so the "current"
    // figure is the catalog tally — not currentStats.chars (the cumulative stat,
    // which is always higher). Needs the catalog synced; show progress until then.
    if (selectedType === "chars" && selectedCharsKind === "quote") {
      if (!maxCharsReady()) {
        const pct = targetSyncPercent();
        modeHint.textContent = pct == null ? "Catalog still syncing\u2026" : `Catalog still syncing\u2026 (${pct}%)`;
        modeHint.className = "gt-mode-hint"; modeHint.style.display = "block"; return;
      }
      const qcur = tallyMaxChars("all").typed;
      const qfmt = Math.round(qcur).toLocaleString();
      if (selectedValue !== null && selectedValue <= qcur) {
        modeHint.textContent = `\u26a0 Must be above current Quote Chars (${qfmt})`;
        modeHint.className   = "gt-mode-hint gt-mode-hint-error";
      } else {
        modeHint.textContent = `Current Quote Chars: ${qfmt}`;
        modeHint.className   = "gt-mode-hint";
      }
      modeHint.style.display = "block";
      return;
    }
    const cur = currentStats[selectedType];
    if (cur == null) {
      modeHint.textContent = `Loading current ${cfg.label}…`;
      modeHint.className = "gt-mode-hint"; modeHint.style.display = "block"; return;
    }
    const fmt = cfg.decimals > 0 ? parseFloat(cur).toFixed(cfg.decimals) : Math.round(cur).toLocaleString();
    if (selectedValue !== null && selectedValue <= cur) {
      modeHint.textContent = `⚠ Must be above current ${cfg.label} (${fmt})`;
      modeHint.className   = "gt-mode-hint gt-mode-hint-error";
    } else {
      modeHint.textContent = `Current ${cfg.label}: ${fmt}`;
      modeHint.className   = "gt-mode-hint";
    }
    modeHint.style.display = "block";
  }

  function validateConfirm() {
    // Rival goals are valid once a username has been resolved. The metric
    // always has a value (defaults to wpm), so the username is the only gate.
    if (selectedType === "rival") {
      confirmBtn.disabled = rivalMultiMode
        ? (selectedRivalList.length === 0)
        : (rivalFetchedName == null);
      return;
    }
    // Max-quotes kinds drive confirmBtn.disabled directly from their async
    // count fetch (see renderPresets). Don't let the generic target-value
    // checks below re-disable it — selectedValue is intentionally null here.
    if (selectedType === "quotes" && selectedMode === "target" && maxQuotesMode && maxQuotesKind) return;
    if (selectedType === "chars" && selectedMode === "target" && maxCharsMode && maxCharsKind) return;
    // Quote-chars (non-max) gain/custom: a positive number is the only gate. The
    // generic target check below compares selectedValue against currentStats.chars
    // (the REGULAR cumulative stat) — the wrong metric here — so short-circuit it.
    if (selectedType === "chars" && selectedCharsKind === "quote" && !(maxCharsMode && maxCharsKind)) {
      if (selectedValue == null || selectedValue <= 0) { confirmBtn.disabled = true; return; }
      // A custom (target-mode) goal is an ABSOLUTE distinct-quote-char total, so it
      // must exceed your current tally — but only enforce that once the catalog is
      // synced enough to know it; while syncing we allow it (the target resolves
      // against the baseline on the first ready render).
      if (selectedMode === "target" && maxCharsReady()) {
        confirmBtn.disabled = selectedValue <= tallyMaxChars("all").typed;
        return;
      }
      confirmBtn.disabled = false;
      return;
    }
    if (selectedMode === "rank") {
      // If Next Rank is toggled, allow setting immediately unless already #1
      if (nextRankMode) {
        confirmBtn.disabled = (currentStats.rank === 1);
        return;
      }
      // enabled only once we have PP that's above current
      const cur = currentStats.pp;
      confirmBtn.disabled = !(rankFetchedPp != null && cur != null && rankFetchedPp > cur);
      return;
    }
    if (selectedMode === "average") {
      // Average mode: needs an active metric (one chip with a valid value)
      // AND a positive window size. Accuracy bounds (0-100) are enforced
      // at chip-input time, so by the time selectedMetric+selectedValue are
      // set they're already in range — defensive re-check anyway.
      if (selectedMetric == null) { confirmBtn.disabled = true; return; }
      if (selectedValue == null || selectedValue <= 0) { confirmBtn.disabled = true; return; }
      if (selectedMetric === "accuracy" && selectedValue > 100) { confirmBtn.disabled = true; return; }
      if (selectedWindow == null || selectedWindow <= 0) { confirmBtn.disabled = true; return; }
      confirmBtn.disabled = false;
      return;
    }
    if (selectedType === "improvement" && selectedImprovementMode === "target") {
      // Target sub-mode: just a positive per-quote threshold. The filter/sliders
      // are all optional (defaults = whole catalog).
      confirmBtn.disabled = !(selectedValue != null && selectedValue > 0);
      return;
    }
    if (selectedMode === "improvement") {
      // Needs a positive target gain, and — for the average track — a rolling
      // window of at least 2 (a window of 1 is just "vs your last race").
      if (selectedValue == null || selectedValue <= 0) { confirmBtn.disabled = true; return; }
      if (selectedImprovementTrack === "average") {
        if (!Number.isFinite(selectedImprovementAvgWindow) || selectedImprovementAvgWindow < 2) {
          confirmBtn.disabled = true; return;
        }
      }
      confirmBtn.disabled = false;
      return;
    }
    if (selectedValue == null || selectedValue <= 0) { confirmBtn.disabled = true; return; }
    const cfg = GOAL_CONFIG[selectedType];
    if (selectedMode === "target" && cfg.supportsTarget) {
      const cur = currentStats[selectedType];
      if (cur == null || selectedValue <= cur) { confirmBtn.disabled = true; return; }
    }
    confirmBtn.disabled = false;
  }

  function renderPresets() {
    const cfg = GOAL_CONFIG[selectedType];
    selectedValue = null; rankFetchedPp = null; rankFetchedRank = null; maxQuotesFetched = null;
    confirmBtn.disabled = true; customInput.value = "";
    customInput.classList.remove("gt-custom-input--grow");
    if (rivalAddBtn) { rivalAddBtn.style.display = "none"; rivalAddBtn.classList.remove("gt-rival-add-inline-btn--reserved"); } // re-shown by the rival branch
    if (amountTargetRow) amountTargetRow.classList.remove("gt-tagfield"); // rival-only styling
    if (rivalListEl) rivalListEl.innerHTML = ""; // clear any leftover rival chips for non-rival types

    // ── Rival mode (type=rival) ───────────────────────────────
    // The Amount row becomes a username input (like Player mode). No presets,
    // no next-rank/max-quotes buttons, no window row. The metric toggle lives
    // in its own row (gt-rival-metric-row), shown by the type handler.
    if (selectedType === "rival") {
      rivalFetchedName = null;
      rivalPendingName = null;
      amountRow.style.display   = "";
      amountLabel.textContent   = "Rivals";
      presetsEl.innerHTML       = "";
      presetsEl.style.display   = "none";
      customInput.style.display = "";
      customInput.type          = "text";
      customInput.value         = "";
      customInput.removeAttribute("max");
      customInput.removeAttribute("step");
      customInput.placeholder   = rivalMultiMode ? "Add a rival\u2026" : "Username";
      nextRankRow.style.display = "none";
      maxQuotesRow.style.display = "none";
      maxCharsRow.style.display = "none";
      avgWindowRow.style.display = "none";
      if (rivalAddBtn) {
        // Keep the button in the flex layout in both modes so the field is
        // laid out identically (prevents a 1px modal shift on toggle); the
        // --reserved modifier collapses/hides it in single-rival mode.
        rivalAddBtn.style.display = "";
        rivalAddBtn.classList.toggle("gt-rival-add-inline-btn--reserved", !rivalMultiMode);
        rivalAddBtn.disabled = true;
      }
      customInput.classList.add("gt-custom-input--grow"); // borderless inside the tag field
      if (amountTargetRow) amountTargetRow.classList.add("gt-tagfield"); // chips + input share one field
      renderRivalList(); // renders the chosen-rival chips inside the field (multi mode)
      modeHint.textContent   = rivalMultiMode ? "Type a username and press Enter" : "Enter a username";
      modeHint.className     = "gt-mode-hint";
      modeHint.style.display = "block";
      validateConfirm();
      return;
    }

    const isTargetMode = selectedMode === "target" && cfg.supportsTarget;
    const isRankMode   = selectedMode === "rank";
    const isPlayerMode = selectedMode === "player";
    const isAvgMode    = selectedMode === "average";


    if (isAvgMode) {
      // ── Average mode (races + average) ────────────────────────
      // Target & metric live in the chip row (gt-avg-target-row) which
      // is shown by updateAvgRowVisibility. The standalone amount row
      // (gt-amount-row) is hidden — its job is taken over entirely by
      // the chip row. Window size has its own dedicated row below.
      amountRow.style.display = "none";
      customInput.style.display = "none";
      presetsEl.innerHTML = "";
      nextRankRow.style.display = "none";
      maxQuotesRow.style.display = "none";
      maxCharsRow.style.display = "none";
      modeHint.style.display = "none";
      return;
    }
    // Other modes: ensure the amount row is visible (in case we're
    // returning from avg mode) and clear any leftover input attributes.
    amountRow.style.display = "";
    customInput.style.display = "";
    customInput.removeAttribute("max");
    customInput.removeAttribute("step");
    // Hidden by default; only the quotes+target branch turns it on.
    maxQuotesRow.style.display = "none";
    maxCharsRow.style.display = "none";
    // Presets visible by default; the quotes+target branch hides them (they'd
    // otherwise claim flex space next to the max-quotes button row).
    presetsEl.style.display = "";

    if (selectedType === "improvement" && selectedImprovementMode === "target") {
      // Improvement-Target sub-mode: the Amount row hosts the per-quote
      // threshold (presets + custom). The status/played/slider/next rows are
      // owned by updateImprovementRowVisibility.
      renderTargetValuePresets();
      return;
    }

    if (selectedMode === "improvement") {
      // ── Improvement mode (races only) ─────────────────────────
      // Single numeric target = cumulative gain in the chosen metric.
      // Reuses the standard Amount row + presets; no "above current"
      // constraint (it's a fresh accumulator, not an absolute target).
      const metric = selectedImprovementMetric;          // "wpm" | "pp"
      const metricLbl = metric === "pp" ? "PP" : "WPM";
      customInput.type          = "number";
      nextRankRow.style.display = "none";
      amountLabel.textContent   = `Target ${metricLbl} gain`;
      customInput.placeholder   = "Custom";
      modeHint.style.display    = "none";
      presetsEl.innerHTML = (IMPROVEMENT_PRESETS[metric] || IMPROVEMENT_PRESETS.wpm).map(v =>
        `<button class="gt-preset-chip" data-value="${v}">${formatPreset(v)}</button>`
      ).join("");
      presetsEl.querySelectorAll(".gt-preset-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          presetsEl.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
          chip.classList.add("selected"); customInput.value = "";
          selectedValue = parseFloat(chip.dataset.value);
          validateConfirm();
        });
      });
      return;
    }

    if (isRankMode) {
      amountLabel.textContent = "Target rank";
      presetsEl.innerHTML     = "";
      nextRankRow.style.display = "block";
      nextRankToggleBtn.textContent = "⚡ Next Rank";

      if (nextRankMode) {
        // ── Next-rank sub-mode ─────────────────────────────────
        // Keep the manual rank input visible so the user can switch to a
        // specific rank without first un-toggling Next Rank. Typing into
        // the input will deactivate Next Rank in the input handler below.
        customInput.style.display = "";
        customInput.type          = "number";
        customInput.placeholder   = "Rank #";
        nextRankToggleBtn.classList.add("active");

        const isExpType = selectedType === "exp";
        const currentRankValue = isExpType ? currentStats.expRank : currentStats.rank;
        const nr = currentRankValue != null ? currentRankValue - 1 : null;

        if (nr != null && nr >= 1) {
          // Just show the user's current rank — the resolved EXP/PP for the
          // next rank is loaded asynchronously by updateRankGoals() /
          // updateExpRankGoals() and surfaces in the goal display itself.
          modeHint.textContent   = `Your current rank: #${currentRankValue}`;
          modeHint.className     = "gt-mode-hint";
          modeHint.style.display = "block";
          rankFetchedRank = nr;
          validateConfirm();
        } else if (currentRankValue === 1) {
          modeHint.textContent   = "⚠ Already at rank #1!";
          modeHint.className     = "gt-mode-hint gt-mode-hint-error";
          modeHint.style.display = "block";
          confirmBtn.disabled    = true;
        } else {
          modeHint.textContent   = "Loading your rank…";
          modeHint.className     = "gt-mode-hint";
          modeHint.style.display = "block";
          confirmBtn.disabled    = true;
        }
      } else {
        // ── Manual rank input sub-mode ─────────────────────────
        customInput.style.display = "";
        customInput.type          = "number";
        customInput.placeholder   = "Rank #";
        nextRankToggleBtn.classList.remove("active");

        const relevantRank = (selectedType === "exp") ? currentStats.expRank : currentStats.rank;
        console.log(`relevant Rank: ${relevantRank}`)
        console.log(`current EXP Rank: ${currentStats.expRank}`)
        modeHint.textContent      = relevantRank != null
          ? `Your current rank: #${relevantRank}`
          : "Loading your rank…";
        modeHint.className        = "gt-mode-hint";
        modeHint.style.display    = "block";
      }
    } else if (isPlayerMode) {
      customInput.type = "text";
      amountLabel.textContent = "Target player";
      customInput.placeholder = "Username";
      presetsEl.innerHTML = "";

      nextRankRow.style.display = "none";

      modeHint.textContent = "Enter a username";
      modeHint.className = "gt-mode-hint";
      modeHint.style.display = "block";
    } else if (isTargetMode && selectedType === "quotes") {
      // ── Max quotes mode (quotes + target) ──────────────────
      // Three "max" presets live in their own button row (gt-max-quotes-row):
      // ranked-only, unranked-only, or all (ranked + unranked). The legacy
      // single "Max" button was ranked-only; "Max ranked" preserves it.
      customInput.type          = "number";
      amountLabel.textContent   = "Target total";
      customInput.placeholder   = "Custom";
      customInput.style.display = "";   // stays visible alongside the max buttons
      presetsEl.innerHTML = "";
      presetsEl.style.display = "none"; // free the row's flex space for the buttons

      nextRankRow.style.display  = "none";          // rank-only button — not used here
      maxQuotesRow.style.display = "flex";

      // Reflect the active kind on the buttons.
      for (const [kind, btn] of Object.entries(maxQuotesBtns)) {
        btn.classList.toggle("active", maxQuotesMode && maxQuotesKind === kind);
      }

      if (maxQuotesMode && maxQuotesKind) {
        // ── A max kind is selected ─────────────────────────────
        const kind = maxQuotesKind;            // capture for the async guard

        // Input stays visible (the click handler clears any prior value);
        // typing into it deactivates the max kind — see the input handler.
        maxQuotesFetched = null;
        maxQuotesBaseline = null;

        modeHint.textContent = "Loading quote counts…";
        modeHint.className   = "gt-mode-hint";
        modeHint.style.display = "block";
        confirmBtn.disabled  = true;

        // Resolve both the TOTAL on-site count and the user's already-TYPED
        // count for the selected kind, in parallel. Ranked typed comes from
        // the cached quotesTyped stat; unranked typed needs its own endpoint.
        const needRanked   = kind === "ranked" || kind === "all";
        const needUnranked = kind === "unranked" || kind === "all";

        Promise.all([
          needRanked   ? getTypeGGTotalQuotes()         : Promise.resolve(0),
          needUnranked ? getTypeGGTotalUnrankedQuotes() : Promise.resolve(0),
          needUnranked ? getUserQuotesTyped("unranked").catch(() => null) : Promise.resolve(0),
        ]).then(([totalRanked, totalUnranked, typedUnranked]) => {
          // Bail if the user switched kind / closed the modal mid-flight.
          if (!maxQuotesMode || maxQuotesKind !== kind) return;

          const totalsOk =
            (!needRanked   || totalRanked   != null) &&
            (!needUnranked || (totalUnranked != null && typedUnranked != null));
          if (!totalsOk) {
            modeHint.textContent = "⚠ Failed to load quote count";
            modeHint.className   = "gt-mode-hint gt-mode-hint-error";
            confirmBtn.disabled  = true;
            return;
          }

          const typedRanked = currentStats.quotes; // may be null until stats load
          let total, typed, noun;
          if (kind === "ranked") {
            total = totalRanked;   typed = typedRanked;                     noun = "ranked quotes";
          } else if (kind === "unranked") {
            total = totalUnranked; typed = typedUnranked;                   noun = "unranked quotes";
          } else {
            total = totalRanked + totalUnranked;
            typed = (typedRanked != null) ? typedRanked + typedUnranked : null;
            noun  = "quotes (ranked + unranked)";
          }

          maxQuotesFetched  = total;
          maxQuotesBaseline = typed;

          if (typed != null && total <= typed) {
            modeHint.textContent = `⚠ You've already typed all ${total.toLocaleString()} ${noun}!`;
            modeHint.className   = "gt-mode-hint gt-mode-hint-error";
            confirmBtn.disabled  = true;
          } else {
            modeHint.textContent = `Max: ${total.toLocaleString()} ${noun} on TypeGG`;
            modeHint.className   = "gt-mode-hint";
            confirmBtn.disabled  = false;
          }
        });
      } else {
        // ── Manual input for target quotes ────────────────────
        customInput.style.display = "";
        updateModeHint();
      }
    } else if (isTargetMode && selectedType === "chars" && selectedCharsKind === "quote") {
      // ── Max chars mode (chars + target) ──────────────
      // Distinct-quote CHARACTER totals from the catalog (Σ length over the
      // quotes you've raced vs over every quote in the scope). The three ⚡
      // buttons mirror Max quotes; the custom input stays for a plain
      // cumulative chars target when no kind is active.
      customInput.type          = "number";
      amountLabel.textContent   = "Target chars";
      customInput.placeholder   = "Custom";
      customInput.style.display = "";
      nextRankRow.style.display = "none";
      maxCharsRow.style.display = "flex";
      presetsEl.innerHTML       = "";
      for (const [k, b] of Object.entries(maxCharsBtns)) {
        b.classList.toggle("active", maxCharsMode && maxCharsKind === k);
      }
      if (maxCharsMode && maxCharsKind) {
        presetsEl.style.display = "none";
        const pv = previewMaxChars(maxCharsKind);
        modeHint.textContent = pv.ready
          ? `${pv.typed.toLocaleString()} / ${pv.total.toLocaleString()} unique-quote chars`
          : "Catalog still syncing — the goal fills in once it's ready";
        modeHint.className     = "gt-mode-hint";
        modeHint.style.display = "block";
        confirmBtn.disabled    = false;
      } else {
        presetsEl.style.display = "none";
        updateModeHint();
      }
    } else {
      customInput.style.display = "";
      customInput.type          = "number";
      nextRankRow.style.display = "none";
      amountLabel.textContent   = isTargetMode ? "Target total" : "Amount";
      customInput.placeholder   = cfg.isTime ? "min" : "Custom";
      modeHint.style.display    = "none";

      if (isTargetMode) {
        presetsEl.innerHTML = "";
      } else {
        presetsEl.innerHTML = cfg.presets.map(v =>
          `<button class="gt-preset-chip" data-value="${v}">${cfg.isTime ? formatPlaytime(v) : formatPreset(v)}</button>`
        ).join("");
        presetsEl.querySelectorAll(".gt-preset-chip").forEach(chip => {
          chip.addEventListener("click", () => {
            presetsEl.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
            chip.classList.add("selected"); customInput.value = "";
            selectedValue = parseFloat(chip.dataset.value);
            validateConfirm(); updateModeHint();
          });
        });
      }
      updateModeHint();
    }
  }

  customInput.addEventListener("input", () => {
    presetsEl.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));

    // ── Rival mode: validate the entered username ───────────────
    // Mirrors Player mode's debounced lookup, but only checks the user
    // exists (no "above you" comparison — rival is a per-quote comparison,
    // not a target). Resolves rivalFetchedName on success.
    if (selectedType === "rival") {
      const username = customInput.value.trim();
      rivalFetchedName = null;
      rivalPendingName = null;
      if (rivalAddBtn) rivalAddBtn.disabled = true;
      if (!username) {
        modeHint.textContent = rivalMultiMode ? "Enter a username to add" : "Enter a username";
        modeHint.className = "gt-mode-hint";
        validateConfirm(); // multi keeps confirm gated on the existing list
        return;
      }
      clearTimeout(rivalDebounce);
      modeHint.textContent = "Checking…";
      modeHint.className = "gt-mode-hint";
      if (!rivalMultiMode) confirmBtn.disabled = true;
      rivalDebounce = setTimeout(async () => {
        const typed = username;
        try {
          const url = `https://api.typegg.io/v1/users/${encodeURIComponent(typed)}`;
          const r = await gtApiFetch(url, { headers: authHeaders() });
          if (r.status === 404) throw new Error("not found");
          if (!r.ok) throw new Error("busy"); // 429/5xx — not a "no such user"
          const d = await r.json();
          const resolvedName = d?.username || typed;
          // Bail if the input changed while we were fetching.
          if (customInput.value.trim() !== typed) return;
          if (rivalMultiMode) {
            // Arm the Add button for a fresh name; block a duplicate.
            if (selectedRivalList.some(n => n.toLowerCase() === resolvedName.toLowerCase())) {
              rivalPendingName = null;
              if (rivalAddBtn) rivalAddBtn.disabled = true;
              modeHint.textContent = `${resolvedName} is already in the list`;
              modeHint.className = "gt-mode-hint gt-mode-hint-error";
            } else {
              rivalPendingName = resolvedName;
              if (rivalAddBtn) rivalAddBtn.disabled = false;
              modeHint.textContent = `${resolvedName} ✓ — click Add`;
              modeHint.className = "gt-mode-hint";
            }
          } else {
            rivalFetchedName = resolvedName;
            refreshRivalCreateSliders(); // resolved rival -> axes may shift
            modeHint.textContent = `${resolvedName} ✓`;
            modeHint.className = "gt-mode-hint";
            confirmBtn.disabled = false;
          }
        } catch (err) {
          if (customInput.value.trim() !== typed) return;
          rivalFetchedName = null;
          rivalPendingName = null;
          if (rivalAddBtn) rivalAddBtn.disabled = true;
          // A throttle / network error shouldn't claim the user doesn't exist —
          // that's misleading when the lookup never actually completed.
          const couldntCheck = err?.gtThrottled || err?.message === "busy" ||
                               (err instanceof TypeError); // "Failed to fetch"
          modeHint.textContent = couldntCheck ? "Can't reach TypeGG — try again in a moment" : "User not found";
          modeHint.className = "gt-mode-hint gt-mode-hint-error";
          if (!rivalMultiMode) confirmBtn.disabled = true;
        }
      }, 400);
      return;
    }

    // Quotes + target: typing a manual value opts out of any active "max"
    // kind (mirrors the Next Rank behaviour). Clearing the field again does
    // NOT re-select a kind — the user must click a max button to do that.
    if (selectedType === "quotes" && selectedMode === "target" && maxQuotesMode && customInput.value !== "") {
      maxQuotesMode     = false;
      maxQuotesKind     = null;
      maxQuotesFetched  = null;
      maxQuotesBaseline = null;
      for (const btn of Object.values(maxQuotesBtns)) btn.classList.remove("active");
    }
    if (selectedType === "chars" && selectedMode === "target" && maxCharsMode && customInput.value !== "") {
      maxCharsMode = false;
      maxCharsKind = null;
      for (const btn of Object.values(maxCharsBtns)) btn.classList.remove("active");
    }

    if (selectedMode === "rank") {
      // If Next Rank was toggled and the user is now typing a specific rank,
      // treat that as opting out of Next Rank — un-toggle the button so the
      // UI matches the user's intent.
      if (nextRankMode && customInput.value !== "") {
        nextRankMode = false;
        nextRankToggleBtn.classList.remove("active");
      }

      const enteredRank = parseInt(customInput.value);
      const curRank     = selectedType === "pp" ? currentStats.rank : currentStats.expRank;

      if (isNaN(enteredRank) || enteredRank < 1) {
        modeHint.textContent = curRank != null ? `Your current rank: #${curRank}` : "Loading your rank…";
        modeHint.className   = "gt-mode-hint";
        confirmBtn.disabled  = true;
        return;
      }

      if (curRank != null && enteredRank >= curRank) {
        modeHint.textContent = `⚠ Must be above your current rank (#${curRank})`;
        modeHint.className   = "gt-mode-hint gt-mode-hint-error";
        confirmBtn.disabled  = true;
      } else {
        modeHint.textContent = curRank != null ? `Your current rank: #${curRank}` : "Loading your rank…";
        modeHint.className   = "gt-mode-hint";
        rankFetchedRank      = enteredRank;
        confirmBtn.disabled  = false;
      }
      return;
    }

    if (selectedMode === "player") {
      const username = customInput.value.trim();
      const cur = currentStats[selectedType];

      if (!username) {
        modeHint.textContent = "Enter a username";
        modeHint.className = "gt-mode-hint";
        confirmBtn.disabled = true;
        return;
      }

      clearTimeout(playerDebounce);

      playerDebounce = setTimeout(async () => {
        try {
          let value;

          if (selectedType === "pp") {
            value = await getPpByUsername(username);
          } else if (selectedType === "exp") {
            value = await getExpByUsername(username);
          }

          playerFetchedValue = value;
          playerFetchedName = username;

          if (cur != null && value <= cur) {
            modeHint.textContent = `⚠ Player has ${Math.round(value).toLocaleString()} ${GOAL_CONFIG[selectedType].label} (not above you)`;
            modeHint.className = "gt-mode-hint gt-mode-hint-error";
            confirmBtn.disabled = true;
          } else {
            modeHint.textContent = `${username}: ${Math.round(value).toLocaleString()} ${GOAL_CONFIG[selectedType].label}`;
            modeHint.className = "gt-mode-hint";
            confirmBtn.disabled = false;
          }
        } catch {
          modeHint.textContent = "User not found";
          modeHint.className = "gt-mode-hint gt-mode-hint-error";
          confirmBtn.disabled = true;
        }
      }, 400);

      return;
    }

    const v = parseFloat(customInput.value);
    if (!isNaN(v) && v > 0) {
      const cfg = GOAL_CONFIG[selectedType];
      selectedValue = cfg.customMultiplier ? v * cfg.customMultiplier : v;
    } else { selectedValue = null; }
    validateConfirm(); updateModeHint();
  });

  const rankBtn = document.getElementById("gt-rank-btn");
  const playerBtn = document.getElementById("gt-player-btn");

  nextRankToggleBtn.addEventListener("click", () => {
    if (selectedMode === "rank") {
      // Handle next rank toggle for PP and EXP
      nextRankMode    = !nextRankMode;
      rankFetchedPp   = null;
      rankFetchedExp  = null;
      rankFetchedRank = null;
      customInput.value = "";
      renderPresets();
    }
  });

  // Max-quotes kind buttons (quotes + target mode). Clicking a kind selects
  // it; clicking the already-active kind toggles back to manual entry.
  for (const [kind, btn] of Object.entries(maxQuotesBtns)) {
    btn.addEventListener("click", () => {
      if (selectedMode !== "target" || selectedType !== "quotes") return;
      if (maxQuotesMode && maxQuotesKind === kind) {
        maxQuotesMode = false;
        maxQuotesKind = null;
      } else {
        maxQuotesMode = true;
        maxQuotesKind = kind;
      }
      maxQuotesFetched  = null;
      maxQuotesBaseline = null;
      customInput.value = "";
      renderPresets();
    });
  }

  // Max-chars kind buttons (chars + target mode). Same toggle behaviour as the
  // Max-quotes buttons; no API fetch -- totals come from the catalog at render.
  for (const [kind, btn] of Object.entries(maxCharsBtns)) {
    btn.addEventListener("click", () => {
      if (selectedMode !== "target" || selectedType !== "chars") return;
      if (maxCharsMode && maxCharsKind === kind) {
        maxCharsMode = false;
        maxCharsKind = null;
      } else {
        maxCharsMode = true;
        maxCharsKind = kind;
      }
      customInput.value = "";
      renderPresets();
    });
  }

  // Chars-kind toggle (Chars vs Quote Chars). Quote mode unlocks the Max-chars
  // buttons + switches the metric to distinct-new-quote chars; leaving it clears
  // any active Max-chars selection (those are quote-only).
  charsKindBtns.forEach(btn => btn.addEventListener("click", () => {
    const kind = btn.dataset.charsKind;
    if (kind === selectedCharsKind) return;
    selectedCharsKind = kind;
    charsKindBtns.forEach(b => b.classList.toggle("active", b === btn));
    if (selectedCharsKind !== "quote") { maxCharsMode = false; maxCharsKind = null; }
    renderPresets();
  }));

  // Single-vs-multiple toggle for the rival goal type.
  rivalMultiModeBtns.forEach(btn => btn.addEventListener("click", () => {
    const wantMulti = btn.dataset.rivalMultimode === "multi";
    if (wantMulti === rivalMultiMode) return;
    rivalMultiMode = wantMulti;
    rivalMultiModeBtns.forEach(b => b.classList.toggle("active", b === btn));
    // Carry a single-mode resolved name into the list when switching to multi.
    if (rivalMultiMode && rivalFetchedName &&
        !selectedRivalList.some(n => n.toLowerCase() === rivalFetchedName.toLowerCase())) {
      selectedRivalList.push(rivalFetchedName);
    }
    rivalFetchedName = null;
    rivalPendingName = null;
    renderPresets(); // re-lays the amount row + list for the new mode
  }));

  // Add the pending validated rival to the list (multiple mode). Shared by the
  // "+ Add" button and the Enter key in the tag-field input.
  function addPendingRival() {
    if (!rivalMultiMode || !rivalPendingName) return;
    if (!selectedRivalList.some(n => n.toLowerCase() === rivalPendingName.toLowerCase())) {
      selectedRivalList.push(rivalPendingName);
    }
    rivalPendingName = null;
    customInput.value = "";
    if (rivalAddBtn) rivalAddBtn.disabled = true;
    renderRivalList();
    modeHint.textContent = "Type a username and press Enter";
    modeHint.className = "gt-mode-hint";
    validateConfirm();
  }
  if (rivalAddBtn) rivalAddBtn.addEventListener("click", addPendingRival);

  // Tag-field keyboard: Enter adds the pending rival (multi) or confirms (single).
  // Backspace on an empty input pops the last chip — the usual "To:"-field nicety.
  customInput.addEventListener("keydown", (e) => {
    if (selectedType !== "rival") return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (rivalMultiMode) {
        if (rivalPendingName) addPendingRival();
      } else if (!confirmBtn.disabled) {
        confirmBtn.click();
      }
      return;
    }
    if (e.key === "Backspace" && rivalMultiMode && customInput.value === "" && selectedRivalList.length) {
      selectedRivalList = selectedRivalList.slice(0, -1);
      rivalPendingName = null;
      if (rivalAddBtn) rivalAddBtn.disabled = true;
      renderRivalList();
      validateConfirm();
    }
  });

  typeBtns.forEach(btn => btn.addEventListener("click", () => {
    typeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedType = btn.dataset.type;
    const cfg = GOAL_CONFIG[selectedType];
    const isRival = selectedType === "rival";

    // Rival metric row (type=rival only) — same visibility pattern as the
    // race-only rows. The rival username is entered in the reused Amount-row
    // input (set up by renderPresets).
    rivalMetricRow.style.display = isRival ? "block" : "none";
    if (rivalConfigRow) rivalConfigRow.style.display = isRival ? "block" : "none";
    if (isRival) {
      // Reflect the current single/multiple mode on the toggle buttons.
      rivalMultiModeBtns.forEach(b =>
        b.classList.toggle("active", (b.dataset.rivalMultimode === "multi") === rivalMultiMode));
      // Reflect the draft comparison config + build its sliders.
      reflectRivalCfgButtons();
      requestAnimationFrame(buildRivalCreateSliders);
    }

    // Show filter row only for races (the solo/quickplay split is a races-only
    // concept; improvement goals ignore it — see the finish-path filter check).
    filterRow.style.display = (selectedType === "races") ? "block" : "none";

    // Chars-kind toggle row: chars type only. Reflect the current selection.
    charsKindRow.style.display = (selectedType === "chars") ? "block" : "none";
    if (selectedType === "chars") {
      charsKindBtns.forEach(b => b.classList.toggle("active", b.dataset.charsKind === selectedCharsKind));
    }

    // Show rank button only for PP
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";

    // Show player button only for PP
    playerBtn.style.display = (selectedType === "pp" || selectedType == "exp") ? "" : "none";

    // Average mode is races-only — same visibility pattern as rank/player.
    avgBtn.style.display = (selectedType === "races") ? "" : "none";
    // Improvement is its own goal TYPE now — the legacy mode button is retired.
    improvementBtn.style.display = "none";


    // If rank/player was active and we switched away from PP/EXP, fall back to gain
    if ((selectedMode === "rank" || selectedMode === "player") && !(selectedType === "pp" || selectedType === "exp")) {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }
    // Average is races-only: fall back to gain when leaving races.
    if (selectedMode === "average" && selectedType !== "races") {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }
    // Improvement is its own TYPE now. Entering it drives the (gain) improvement
    // flow via selectedMode="improvement"; leaving it returns to gain. The Mode
    // row stays hidden for this type (supportsTarget=false) — the gain/target
    // sub-mode toggle arrives with target mode in the next drop.
    if (selectedType === "improvement") {
      selectedMode = "improvement";
      // Reflect the bespoke Gain/Target sub-mode toggle (reset to gain on entry
      // via resetTargetUI/updateImprovementRowVisibility's leave-reset).
      improvementModeBtns.forEach(b => b.classList.toggle("active", b.dataset.impMode === selectedImprovementMode));
    } else if (selectedMode === "improvement") {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }

    modeRow.style.display = cfg.supportsTarget ? "block" : "none";
    if (!cfg.supportsTarget && (selectedMode === "target" || selectedMode === "rank" || selectedMode === "player")) {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }

    // Recurrence row: hidden in target/rank/player and for rival (no
    // recurrence); visible in gain/average/improvement.
    recRow.style.display = (!isRival && (selectedMode === "gain" || selectedMode === "average" || selectedMode === "improvement")) ? "block" : "none";

    // Requirements row: races + gain only
    updateReqRowVisibility();
    // Average-mode rows: races + average only
    updateAvgRowVisibility();
    // Improvement-mode row: races + improvement only
    updateImprovementRowVisibility();

    renderPresets();
  }));

  modeBtns.forEach(btn => btn.addEventListener("click", () => {
    modeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedMode = btn.dataset.mode;
    if (selectedMode === "target" || selectedMode === "rank" || selectedMode === "player") {
      selectedRec = "none";
      recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
      recRow.style.display = "none";
    } else { recRow.style.display = (selectedType === "rival") ? "none" : "block"; } // rival never has recurrence
    updateReqRowVisibility();
    updateAvgRowVisibility();
    updateImprovementRowVisibility();
    renderPresets();
  }));

  recBtns.forEach(btn => btn.addEventListener("click", () => {
    recBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedRec = btn.dataset.rec;
  }));

  filterBtns.forEach(btn => btn.addEventListener("click", () => {
    filterBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedFilter = btn.dataset.filter;
  }));

  // (The old global WPM/PP + scope toggles in the creation modal were removed:
  // metric / scope / shared / ranges are configured per goal via #gt-rival-config-row,
  // wired above to rivalDraftSettings.)

  // ── Requirements inputs / strict toggle ─────────────────────────
  // Each input drives one axis of selectedReq. Empty / 0 / NaN = inactive
  // (null). Any positive number activates that axis. The chip's .active
  // class is purely visual (cyan border) and follows the input value.
  reqInputs.forEach(input => {
    function syncFromInput() {
      const axis = input.dataset.req;
      const v = parseFloat(input.value);
      const valid = !isNaN(v) && v > 0;
      selectedReq[axis] = valid ? v : null;
      const chip = input.closest(".gt-req-chip");
      if (chip) chip.classList.toggle("active", valid);
    }
    input.addEventListener("input", syncFromInput);
    // Defensive sync on blur — covers paste / autofill paths that don't fire 'input' reliably
    input.addEventListener("blur", syncFromInput);
  });

  reqStrictBtn.addEventListener("click", () => {
    selectedStrict = !selectedStrict;
    reqStrictBtn.classList.toggle("active", selectedStrict);
  });

  reqUniqueBtn.addEventListener("click", () => {
    selectedUnique = !selectedUnique;
    reqUniqueBtn.classList.toggle("active", selectedUnique);
  });

  // Reset the requirements UI to the cleared / inactive state. Called
  // on modal open, on type/mode changes that hide the row, and on close.
  function resetRequirementsUI() {
    selectedReq = { wpm: null, accuracy: null, pp: null, length: null, difficulty: null };
    selectedStrict = false;
    selectedUnique = false;
    reqInputs.forEach(input => {
      input.value = "";
      const chip = input.closest(".gt-req-chip");
      if (chip) chip.classList.remove("active");
    });
    reqStrictBtn.classList.remove("active");
    reqUniqueBtn.classList.remove("active");
    // selectedUnique is shared with avg mode — clear that button's active
    // state too, so the user doesn't see a stale ✨ if they switch modes
    // back and forth.
    avgUniqueBtn.classList.remove("active");
  }

  // The requirements row is only meaningful for races + gain.
  // Called from type / mode click handlers.
  function updateReqRowVisibility() {
    const visible = selectedType === "races" && selectedMode === "gain";
    reqRow.style.display = visible ? "block" : "none";
    if (!visible) resetRequirementsUI();
  }

  // ── Average-mode controls ──────────────────────────────────────
  // Chip-style metric inputs: WPM / ACC / PP, mutually exclusive. Typing
  // in one input deactivates and clears the others, then sets selectedMetric
  // and selectedValue from the active input. Empty input = no metric picked.
  // The unique-quote (✨) toggle on the right of the row applies to the
  // entire rolling window (only one quoteId can occupy the window at a time).
  avgInputs.forEach(input => {
    function syncFromInput() {
      const metric = input.dataset.avg;
      const v = parseFloat(input.value);
      const valid = !isNaN(v) && v > 0
                    && !(metric === "accuracy" && v > 100);
      if (valid) {
        // Activate this chip + set selectedMetric/Value, clear others.
        avgInputs.forEach(other => {
          if (other === input) return;
          other.value = "";
          const otherChip = other.closest(".gt-req-chip");
          if (otherChip) otherChip.classList.remove("active");
        });
        const chip = input.closest(".gt-req-chip");
        if (chip) chip.classList.add("active");
        selectedMetric = metric;
        selectedValue  = v;
      } else {
        // This input went invalid — but ONLY clear selectedMetric/Value
        // if it was this metric that was previously active. If a different
        // metric was active, leave it alone (this can happen if focus
        // moves and an empty/invalid event fires on another chip).
        const chip = input.closest(".gt-req-chip");
        if (chip) chip.classList.remove("active");
        if (selectedMetric === metric) {
          selectedMetric = null;
          selectedValue  = null;
        }
      }
      validateConfirm();
    }
    input.addEventListener("input", syncFromInput);
    // Defensive sync on blur — covers paste / autofill paths that don't
    // fire 'input' reliably.
    input.addEventListener("blur", syncFromInput);
  });

  avgUniqueBtn.addEventListener("click", () => {
    selectedUnique = !selectedUnique;
    avgUniqueBtn.classList.toggle("active", selectedUnique);
  });

  // Improvement metric selector (WPM / PP) — mutually exclusive, mirrors
  // the mode-button look. Switching metric re-renders the Amount presets
  // since the two metrics use different preset magnitudes.
  improvementMetricBtns.forEach(btn => btn.addEventListener("click", () => {
    improvementMetricBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedImprovementMetric = btn.dataset.impMetric; // "wpm" | "pp"
    if (selectedMode === "improvement") renderPresets();
  }));

  // Count-first-time toggle. Off (default) → only quotes you've typed
  // before count (improvement needs a prior best). On → the first race on
  // a quote counts too (baseline 0).
  improvementFirstTimeBtn.addEventListener("click", () => {
    selectedCountFirstTime = !selectedCountFirstTime;
    improvementFirstTimeBtn.classList.toggle("active", selectedCountFirstTime);
  });

  // Track selector (Best / Average) — mutually exclusive. Average reveals the
  // rolling-window row; the 🌱 first-time toggle only applies to the Best
  // track (the average track's warm-up handles new quotes), so hide it for
  // Average.
  improvementTrackBtns.forEach(btn => btn.addEventListener("click", () => {
    improvementTrackBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedImprovementTrack = btn.dataset.impTrack; // "best" | "average"
    if (selectedImprovementTrack === "average" && !improvementAvgWindowInput.value) {
      improvementAvgWindowInput.value = selectedImprovementAvgWindow || 5; // show default
    }
    updateImprovementWindowRowVisibility();
    validateConfirm();
  }));

  improvementAvgWindowInput.addEventListener("input", () => {
    const v = parseInt(improvementAvgWindowInput.value, 10);
    selectedImprovementAvgWindow = (Number.isFinite(v) && v >= 1) ? v : NaN;
    validateConfirm();
  });

  // Render the window-size preset chips. Mirrors renderPresets's main
  // chip-rendering path — clicking a chip selects it (deselects others)
  // and clears the custom input. Typing in the custom input deselects
  // all chips. Both paths converge on selectedWindow + validateConfirm.
  function renderAvgWindowPresets() {
    avgWindowPresets.innerHTML = AVG_WINDOW_PRESETS.map(v =>
      `<button class="gt-preset-chip" data-value="${v}">${v}</button>`
    ).join("");
    avgWindowPresets.querySelectorAll(".gt-preset-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        avgWindowPresets.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected");
        avgWindowInput.value = "";
        selectedWindow = parseInt(chip.dataset.value);
        validateConfirm();
      });
    });
  }

  // Window size input — paired with the preset chips above. Either path
  // sets selectedWindow; selecting a chip clears the input, typing in
  // the input deselects all chips.
  avgWindowInput.addEventListener("input", () => {
    avgWindowPresets.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
    const v = parseInt(avgWindowInput.value);
    selectedWindow = (!isNaN(v) && v > 0) ? v : null;
    validateConfirm();
  });

  // Reset the average-mode UI to defaults. Called on modal open and on
  // mode/type changes that hide the average rows.
  function resetAverageUI() {
    selectedMetric = null;
    selectedWindow = null;
    selectedValue  = null;  // shared with non-avg modes; safe to clear
    selectedUnique = false; // shared with gain mode; safe to clear
    avgWindowInput.value = "";
    avgInputs.forEach(input => {
      input.value = "";
      const chip = input.closest(".gt-req-chip");
      if (chip) chip.classList.remove("active");
    });
    avgUniqueBtn.classList.remove("active");
    // selectedUnique is shared with gain mode — clear that button's
    // active state too (mirror of resetRequirementsUI's avg cleanup).
    reqUniqueBtn.classList.remove("active");
    // Clear any selected window-preset chip. Defensive — the chips may
    // not be rendered yet on first modal open, in which case this is a no-op.
    avgWindowPresets.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
  }

  // Average-mode rows (target-average chips + window size) are only
  // meaningful for races + average. Mirror updateReqRowVisibility().
  function updateAvgRowVisibility() {
    const visible = selectedType === "races" && selectedMode === "average";
    avgTargetRow.style.display = visible ? "block" : "none";
    avgWindowRow.style.display = visible ? "block" : "none";
    if (visible) {
      // Lazy-render the window-size presets the first time the avg rows
      // are shown — and on every show after that to ensure the click
      // handlers point at the current closure (cheap; only 5 chips).
      renderAvgWindowPresets();
    } else {
      resetAverageUI();
    }
  }

  // Reset the improvement-mode UI to defaults (WPM metric, count-first-time
  // off). Called on modal open and on mode/type changes that hide the row.
  function resetImprovementUI() {
    selectedImprovementMetric    = "wpm";
    selectedCountFirstTime       = false;
    selectedImprovementTrack     = "best";
    selectedImprovementAvgWindow = 5;
    improvementMetricBtns.forEach(b =>
      b.classList.toggle("active", b.dataset.impMetric === "wpm"));
    improvementFirstTimeBtn.classList.remove("active");
    improvementFirstTimeBtn.style.display = ""; // shown for Best track
    improvementTrackBtns.forEach(b =>
      b.classList.toggle("active", b.dataset.impTrack === "best"));
    improvementAvgWindowInput.value = "";
    improvementWindowRow.style.display = "none";
  }

  // Improvement rows. Shown only for the improvement type, split by the bespoke
  // Gain/Target sub-mode:
  //   common  : the Gain/Target toggle + the WPM/PP metric row.
  //   gain    : Track row (+ rolling-window when Average), the 🌱 toggle, the
  //             solo/quickplay filter row, and recurrence.
  //   target  : Status / Played / Difficulty / Length / Next-pick rows. No
  //             filter, no recurrence (catalog goals are non-recurring).
  function updateImprovementRowVisibility() {
    const isImp = selectedType === "improvement";
    const isTarget = isImp && selectedImprovementMode === "target";
    // Common rows.
    improvementModeRow.style.display   = isImp ? "block" : "none";
    improvementMetricRow.style.display = isImp ? "block" : "none";
    // Gain-only rows.
    improvementTrackRow.style.display  = (isImp && !isTarget) ? "block" : "none";
    // Target-only rows.
    targetStatusRow.style.display   = isTarget ? "block" : "none";
    targetPlayedRow.style.display   = isTarget ? "block" : "none";
    targetDiffRow.style.display     = isTarget ? "block" : "none";
    targetLenRow.style.display      = isTarget ? "block" : "none";
    if (!isImp) { resetImprovementUI(); resetTargetUI(); return; }
    // The solo/quickplay filter is a races-only concept — hidden for the whole
    // improvement type. Force "all" so a gain goal counts every race.
    filterRow.style.display = "none";
    selectedFilter = "all";
    filterBtns.forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
    if (isTarget) {
      // Hide gain-only bits that live in shared rows (the 🌱 first-time toggle
      // sits in the metric row; the rolling-window row is gain/Average only).
      improvementFirstTimeBtn.style.display = "none";
      improvementWindowRow.style.display = "none";
      // No recurrence for catalog goals.
      selectedRec = "none";
      recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
      recRow.style.display = "none";
      renderTargetSliders();
    } else {
      recRow.style.display = "block";
      updateImprovementWindowRowVisibility();
    }
  }

  // The rolling-window row applies only to the Average track. The 🌱
  // first-time toggle applies only to the Best track (Average's warm-up
  // handles new quotes), so it's hidden for Average.
  function updateImprovementWindowRowVisibility() {
    const isGain = selectedType === "improvement" && selectedImprovementMode === "gain";
    const avg = isGain && selectedImprovementTrack === "average";
    improvementWindowRow.style.display = avg ? "block" : "none";
    // 🌱 applies to the gain Best track only (hidden for Average and Target).
    improvementFirstTimeBtn.style.display = (isGain && !avg) ? "" : "none";
  }

  // ── Improvement-Target sub-mode wiring ──────────────────────────
  // Standalone dual-handle range for the creation modal (the rival one is bound
  // to the settings modal's contentEl/applySettingsDraft, so it isn't reusable
  // here). Feature-matched to the rival slider: decimal steps, "N+" end ticks,
  // and click-to-edit lo/hi numbers. Commits lo/hi to the target draft via
  // set(); a handle at the axis end stores null (= unconstrained on that side).
  // Handlers on the persistent <input>/track elements are ASSIGNED (not
  // addEventListener) so re-running on an axis change replaces them cleanly; the
  // readout number spans are rebuilt each call, so their listeners can't stack.
  function setupTargetRange(rangeId, readoutId, ticksId, opts) {
    const root = document.getElementById(rangeId);
    if (!root) return;
    const loIn = root.querySelector(".gt-range-lo");
    const hiIn = root.querySelector(".gt-range-hi");
    const fill = root.querySelector(".gt-range-fill");
    const readout = document.getElementById(readoutId);
    const ticksEl = document.getElementById(ticksId);
    const { min, max, step, decimals, ticks, lo, hi, set } = opts;
    const snap = (v) => {
      const n = Math.round(v / step) * step;
      return decimals ? Math.round(n * 10) / 10 : Math.round(n);
    };
    const numStr = (v) => (decimals ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
    for (const inp of [loIn, hiIn]) { inp.min = min; inp.max = max; inp.step = step; }
    loIn.value = snap(Math.max(min, Math.min(max, lo)));
    hiIn.value = snap(Math.max(min, Math.min(max, hi)));
    if (ticksEl) {
      const loEnd = ticksEl.querySelector(".gt-range-end-lo");
      const hiEnd = ticksEl.querySelector(".gt-range-end-hi");
      if (loEnd) loEnd.textContent = ticks ? ticks[0] : numStr(min);
      if (hiEnd) hiEnd.textContent = ticks ? ticks[ticks.length - 1] : numStr(max);
    }
    let loNum = null, hiNum = null, capEl = null;
    if (readout) {
      readout.innerHTML =
        `<span class="gt-range-num" data-side="lo" spellcheck="false"></span>` +
        `<span class="gt-range-dash"> - </span>` +
        `<span class="gt-range-num" data-side="hi" spellcheck="false"></span>` +
        `<span class="gt-range-cap">+</span>`;
      loNum = readout.querySelector('[data-side="lo"]');
      hiNum = readout.querySelector('[data-side="hi"]');
      capEl = readout.querySelector(".gt-range-cap");
    }
    const paint = (skip) => {
      const lv = +loIn.value, hv = +hiIn.value;
      const lp = ((lv - min) / (max - min)) * 100;
      const hp = ((hv - min) / (max - min)) * 100;
      fill.style.left = lp + "%";
      fill.style.width = Math.max(0, hp - lp) + "%";
      if (loNum && loNum !== skip) loNum.textContent = numStr(lv);
      if (hiNum && hiNum !== skip) hiNum.textContent = numStr(hv);
      if (capEl) capEl.style.display = (hv >= max) ? "" : "none";
    };
    const commit = () => {
      const lv = +loIn.value, hv = +hiIn.value;
      set(lv <= min ? null : lv, hv >= max ? null : hv);
    };
    const onInput = (which) => {
      let lv = +loIn.value, hv = +hiIn.value;
      if (which === "lo" && lv > hv) { lv = hv; loIn.value = lv; }
      if (which === "hi" && hv < lv) { hv = lv; hiIn.value = hv; }
      paint(); commit(); validateConfirm();
    };
    loIn.oninput = () => onInput("lo");
    hiIn.oninput = () => onInput("hi");
    root.onpointerdown = (e) => {
      const rect = root.getBoundingClientRect();
      if (!rect.width) return;
      const x = e.clientX - rect.left;
      const loX = ((+loIn.value - min) / (max - min)) * rect.width;
      const hiX = ((+hiIn.value - min) / (max - min)) * rect.width;
      const loCloser = Math.abs(x - loX) <= Math.abs(x - hiX);
      loIn.style.zIndex = loCloser ? 5 : 4;
      hiIn.style.zIndex = loCloser ? 4 : 5;
      if (e.target === loIn || e.target === hiIn) return;
      const moveLo = Math.abs(x - loX) < Math.abs(x - hiX);
      const frac = Math.min(1, Math.max(0, x / rect.width));
      let v = Math.min(max, Math.max(min, snap(min + frac * (max - min))));
      if (moveLo) { if (v > +hiIn.value) v = +hiIn.value; loIn.value = v; loIn.style.zIndex = 5; hiIn.style.zIndex = 4; }
      else        { if (v < +loIn.value) v = +loIn.value; hiIn.value = v; hiIn.style.zIndex = 5; loIn.style.zIndex = 4; }
      paint(); commit(); validateConfirm();
    };

    // Inline-edit the lo/hi numbers like a text field (mirrors the rival
    // sliders). Fresh spans each call, so handler assignment is safe.
    const selectAllText = (el) => {
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    };
    const commitEdit = (el, side) => {
      const v0 = parseFloat((el.textContent || "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(v0)) {
        let v = Math.min(max, Math.max(min, snap(v0)));
        if (side === "lo") { if (v > +hiIn.value) v = +hiIn.value; loIn.value = v; }
        else               { if (v < +loIn.value) v = +loIn.value; hiIn.value = v; }
        paint(); commit(); validateConfirm();
      } else {
        paint(); // revert junk entry to the live value
      }
    };
    const wireEdit = (el, side) => {
      if (!el) return;
      // First click takes over focus, makes it editable, and selects the value
      // so a keystroke replaces it. A click while already editing is left alone
      // so the caret can be placed between digits.
      el.onmousedown = (e) => {
        if (el.getAttribute("contenteditable") === "true") return;
        e.preventDefault();
        el.setAttribute("contenteditable", "true");
        el.focus();
        setTimeout(() => selectAllText(el), 0);
      };
      el.onkeydown = (e) => {
        if (e.key === "Enter")  { e.preventDefault(); el.blur(); return; }
        if (e.key === "Escape") { e.preventDefault(); paint(); el.blur(); return; }
        const k = e.key;
        if (k.length === 1 && !/[0-9]/.test(k) && !(decimals && k === ".") && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
        }
      };
      el.onblur = () => {
        el.removeAttribute("contenteditable"); // back to plain text until next click
        commitEdit(el, side);
      };
    };
    wireEdit(loNum, "lo");
    wireEdit(hiNum, "hi");

    paint();
  }

  // (Re)build the difficulty + length sliders for the current status/played
  // filter, resolving stored handles against the live catalog axis (null = end).
  function renderTargetSliders() {
    const axis = catalogAxis(selectedTargetStatus, selectedTargetPlayed);
    const clampD = (v) => Math.max(axis.diffMin, Math.min(axis.diffMax, v));
    const clampL = (v) => Math.max(axis.lenMin,  Math.min(axis.lenMax,  v));
    const dLo = selectedTargetDiffMin == null ? axis.diffMin : clampD(selectedTargetDiffMin);
    const dHi = selectedTargetDiffMax == null ? axis.diffMax : clampD(selectedTargetDiffMax);
    const lLo = selectedTargetLenMin  == null ? axis.lenMin  : clampL(selectedTargetLenMin);
    const lHi = selectedTargetLenMax  == null ? axis.lenMax  : clampL(selectedTargetLenMax);
    setupTargetRange("gt-target-diff-range", "gt-target-diff-readout", "gt-target-diff-ticks", {
      min: axis.diffMin, max: axis.diffMax, step: 0.1, decimals: true,
      ticks: [String(axis.diffMin), `${axis.diffMax}+`], lo: dLo, hi: dHi,
      set: (lo, hi) => { selectedTargetDiffMin = lo; selectedTargetDiffMax = hi; },
    });
    setupTargetRange("gt-target-len-range", "gt-target-len-readout", "gt-target-len-ticks", {
      min: axis.lenMin, max: axis.lenMax, step: 1, decimals: false,
      ticks: [String(axis.lenMin), `${axis.lenMax}+`], lo: lLo, hi: lHi,
      set: (lo, hi) => { selectedTargetLenMin = lo; selectedTargetLenMax = hi; },
    });
    if (targetSyncHintEl) {
      const syncing = !catalogFullySynced();
      targetSyncHintEl.textContent = syncing ? " syncing catalog\u2026 (reopen for full bounds)" : "";
      targetSyncHintEl.style.display = syncing ? "inline" : "none";
    }
  }

  // Threshold value picker (reuses the Amount row: presets + custom). The metric
  // label/presets follow selectedImprovementMetric; the custom input's generic
  // numeric path already sets selectedValue.
  function renderTargetValuePresets() {
    const metric = selectedImprovementMetric;
    const lbl = metric === "pp" ? "PP" : "WPM";
    amountRow.style.display = "";
    customInput.style.display = "";
    customInput.type = "number";
    customInput.removeAttribute("max");
    customInput.removeAttribute("step");
    customInput.placeholder = "Custom";
    customInput.classList.remove("gt-custom-input--grow");
    nextRankRow.style.display = "none";
    maxQuotesRow.style.display = "none";
    maxCharsRow.style.display = "none";
    avgWindowRow.style.display = "none";
    presetsEl.style.display = "";
    amountLabel.textContent = `Target ${lbl}`;
    modeHint.style.display = "none";
    presetsEl.innerHTML = (TARGET_PRESETS[metric] || TARGET_PRESETS.wpm).map(v =>
      `<button class="gt-preset-chip" data-value="${v}">${formatPreset(v)}</button>`
    ).join("");
    presetsEl.querySelectorAll(".gt-preset-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        presetsEl.querySelectorAll(".gt-preset-chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected"); customInput.value = "";
        selectedValue = parseFloat(chip.dataset.value);
        validateConfirm();
      });
    });
  }

  // Reset the Target draft + its UI. Called on modal open, and on type/mode
  // changes that leave the Target sub-mode.
  function resetTargetUI() {
    selectedImprovementMode = "gain";
    selectedTargetStatus = "ranked";
    selectedTargetPlayed = "played";
    selectedTargetDiffMin = null; selectedTargetDiffMax = null;
    selectedTargetLenMin  = null; selectedTargetLenMax  = null;
    improvementModeBtns.forEach(b => b.classList.toggle("active", b.dataset.impMode === "gain"));
    targetStatusBtns.forEach(b => b.classList.toggle("active", b.dataset.targetStatus === "ranked"));
    targetPlayedBtns.forEach(b => b.classList.toggle("active", b.dataset.targetPlayed === "played"));
    if (improvementModeRow) improvementModeRow.style.display = "none";
    for (const r of [targetStatusRow, targetPlayedRow, targetDiffRow, targetLenRow]) {
      if (r) r.style.display = "none";
    }
  }

  // Bespoke Gain/Target toggle (improvement type only).
  improvementModeBtns.forEach(btn => btn.addEventListener("click", () => {
    improvementModeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedImprovementMode = btn.dataset.impMode; // "gain" | "target"
    updateImprovementRowVisibility();
    renderPresets();
    validateConfirm();
  }));

  // Target Status / Played: both change the catalog axis (and the played pool),
  // so reset the diff/len handles to full range and rebuild the sliders.
  targetStatusBtns.forEach(btn => btn.addEventListener("click", () => {
    targetStatusBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedTargetStatus = btn.dataset.targetStatus;
    selectedTargetDiffMin = selectedTargetDiffMax = null;
    selectedTargetLenMin  = selectedTargetLenMax  = null;
    renderTargetSliders();
    validateConfirm();
  }));
  targetPlayedBtns.forEach(btn => btn.addEventListener("click", () => {
    targetPlayedBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedTargetPlayed = btn.dataset.targetPlayed;
    selectedTargetDiffMin = selectedTargetDiffMax = null;
    selectedTargetLenMin  = selectedTargetLenMax  = null;
    renderTargetSliders();
    validateConfirm();
  }));

  function openModal() {
    overlay.classList.add("open");
    typeBtns.forEach(b => b.classList.toggle("active", b.dataset.type === "exp"));
    recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
    modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    filterBtns.forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
    selectedType = "exp"; selectedRec = "none"; selectedMode = "gain"; selectedFilter = "all";
    rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesKind = null; maxQuotesFetched = null; maxQuotesBaseline = null;
    maxCharsMode = false; maxCharsKind = null;
    selectedCharsKind = "regular";
    charsKindBtns.forEach(b => b.classList.toggle("active", b.dataset.charsKind === "regular"));
    charsKindRow.style.display = "none";
    // Rival defaults: a fresh draft comparison config (seeded from the global
    // template), no resolved username yet.
    rivalFetchedName = null; clearTimeout(rivalDebounce);
    rivalMultiMode = false; selectedRivalList = []; rivalPendingName = null;
    rivalMultiModeBtns.forEach(b => b.classList.toggle("active", b.dataset.rivalMultimode === "single"));
    renderRivalList();
    rivalDraftSettings = defaultRivalGoalSettings();
    reflectRivalCfgButtons();
    rivalMetricRow.style.display = "none";
    if (rivalConfigRow) rivalConfigRow.style.display = "none";
    resetRequirementsUI();
    resetAverageUI();
    resetImprovementUI();
    playerBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    avgBtn.style.display = (selectedType === "races") ? "" : "none";
    improvementBtn.style.display = "none";
    nextRankRow.style.display = "none";
    maxQuotesRow.style.display = "none";
    maxCharsRow.style.display = "none";
    filterRow.style.display = "none"; // hide filter row initially (only show for races)
    reqRow.style.display = "none";    // hide req row initially (only show for races + gain)
    avgTargetRow.style.display = "none"; // hide avg rows initially (only show for races + average)
    avgWindowRow.style.display = "none";
    improvementMetricRow.style.display = "none"; // hide improvement rows initially
    improvementTrackRow.style.display = "none";
    improvementWindowRow.style.display = "none";
    resetTargetUI(); // hides the sub-mode toggle + all Target rows
    modeRow.style.display = "block"; recRow.style.display = "block";
    renderPresets();
  }
  function closeModal() {
    overlay.classList.remove("open");
    selectedValue = null; rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesKind = null; maxQuotesFetched = null; maxQuotesBaseline = null;
    maxCharsMode = false; maxCharsKind = null;
    rivalFetchedName = null; rivalPendingName = null; clearTimeout(rivalDebounce);
    resetRequirementsUI();
    resetAverageUI();
    resetImprovementUI();
    resetTargetUI();
    clearTimeout(rankDebounce);
    customInput.value = "";
  }

  document.getElementById("set-goal-btn").addEventListener("click", openModal);
  document.getElementById("close-modal-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  // ── Goal data ──────────────────────────────────────────────────
  // Now stores arrays of goals per type
  let goalData = {
    exp:      JSON.parse(localStorage.getItem("gt-goals-exp"))      || [],
    pp:       JSON.parse(localStorage.getItem("gt-goals-pp"))       || [],
    races:    JSON.parse(localStorage.getItem("gt-goals-races"))    || [],
    quotes:   JSON.parse(localStorage.getItem("gt-goals-quotes"))   || [],
    playtime: JSON.parse(localStorage.getItem("gt-goals-playtime")) || [],
    chars: JSON.parse(localStorage.getItem("gt-goals-chars")) || [],
    rival: JSON.parse(localStorage.getItem("gt-goals-rival")) || [],
    improvement: JSON.parse(localStorage.getItem("gt-goals-improvement")) || [],
  };

  // One-time migration: improvement goals used to be a MODE on the races type
  // (stored in gt-goals-races with mode:"improvement"). They're their own type
  // now — relocate any such goals into gt-goals-improvement, leaving the rest of
  // the races list intact. Idempotent: a second run finds nothing to move.
  function migrateImprovementToOwnType() {
    const races = goalData.races || [];
    const movers = races.filter(g => g && g.mode === "improvement");
    if (movers.length === 0) return;
    goalData.races = races.filter(g => !(g && g.mode === "improvement"));
    goalData.improvement = [...(goalData.improvement || []), ...movers];
    try {
      localStorage.setItem("gt-goals-races", JSON.stringify(goalData.races));
      localStorage.setItem("gt-goals-improvement", JSON.stringify(goalData.improvement));
    } catch {}
  }
  migrateImprovementToOwnType();
  migrateRivalGoalSettings(); // seed each rival goal's filter settings from the old global object

  // ── Save goals to localStorage ─────────────────────────────────
  function saveGoals(type) {
    const cfg = GOAL_CONFIG[type];
    localStorage.setItem(cfg.storageKey, JSON.stringify(goalData[type]));
    // Broadcast to other tabs (storage events fire in OTHER tabs only;
    // BroadcastChannel is faster and more reliable than waiting for them).
    channel?.postMessage({ type: 'goals-changed', goalType: type });
  }

  // ── Remove goal ────────────────────────────────────────────────
  // ── Confirm modal ──────────────────────────────────────────────
  // Builds an ad-hoc modal asking the user to confirm an action.
  // Resolves to true iff the user clicks the confirm button; false on
  // cancel, backdrop click, or ESC. Cancel is focused by default —
  // pressing Enter or ESC dismisses without confirming (safer for
  // destructive actions). Uses textContent for dynamic strings to
  // avoid HTML injection.
  //
  // Options:
  //   title         — bold heading, e.g. "Delete goal?"
  //   message       — body text directly under the title
  //   detail        — optional highlighted box (multi-line ok via \n)
  //   warning       — optional warning line under the detail box
  //   confirmLabel  — confirm button text (default: "Confirm")
  //   cancelLabel   — cancel button text  (default: "Cancel")
  //   danger        — if true, confirm button uses the destructive
  //                   red style; otherwise the primary blue style
  function showConfirmModal({
    title,
    message,
    detail = "",
    warning = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  }) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "gt-confirm-overlay";
      overlay.innerHTML = `
        <div class="gt-confirm-modal">
          <div class="gt-confirm-title"></div>
          <div class="gt-confirm-message"></div>
          <div class="gt-confirm-detail" style="display:none;"></div>
          <div class="gt-confirm-warning" style="display:none;"></div>
          <div class="gt-confirm-actions">
            <button class="gt-confirm-cancel-btn"></button>
            <button class="gt-confirm-confirm-btn"></button>
          </div>
        </div>
      `;

      overlay.querySelector(".gt-confirm-title").textContent = title;
      overlay.querySelector(".gt-confirm-message").textContent = message;
      if (detail) {
        const el = overlay.querySelector(".gt-confirm-detail");
        el.textContent = detail;
        el.style.display = "";
      }
      if (warning) {
        const el = overlay.querySelector(".gt-confirm-warning");
        el.textContent = warning;
        el.style.display = "";
      }
      const cancelBtn = overlay.querySelector(".gt-confirm-cancel-btn");
      const confirmBtn = overlay.querySelector(".gt-confirm-confirm-btn");
      cancelBtn.textContent = cancelLabel;
      confirmBtn.textContent = confirmLabel;
      if (danger) confirmBtn.classList.add("danger");

      document.body.appendChild(overlay);

      const cleanup = (result) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      };
      document.addEventListener("keydown", onKey);

      cancelBtn.addEventListener("click", () => cleanup(false));
      confirmBtn.addEventListener("click", () => cleanup(true));
      overlay.addEventListener("click", e => { if (e.target === overlay) cleanup(false); });

      // Focus Cancel by default — safer for destructive actions.
      setTimeout(() => cancelBtn.focus(), 0);
    });
  }

  // Thin wrapper for the goal-row ✕ button.
  function confirmDeleteGoal(goalLabel) {
    return showConfirmModal({
      title: "Delete goal?",
      message: "Are you sure you want to delete this goal?",
      detail: goalLabel,
      confirmLabel: "Delete",
      danger: true,
    });
  }

  function removeGoal(type, goalId) {
    goalData[type] = goalData[type].filter(g => g.id !== goalId);
    saveGoals(type);
    const section = document.getElementById(`${goalId}-goal-section`);
    if (section) section.remove();
    delete prevGainMap[goalId];
    delete prevAvgMap[goalId];
    delete prevBestMap[goalId];
    delete prevRivalYouMap[goalId];
    targetStandingsCache.delete(goalId);

    // Remove from its owning group. If that empties a detached widget,
    // destroy it. Main group is allowed to be empty.
    const gid = findGroupIdOfGoal(goalId);
    if (gid) {
      const g = groupData[gid];
      g.goalIds = g.goalIds.filter(id => id !== goalId);
      if (gid !== MAIN_GROUP_ID && g.goalIds.length === 0) {
        delete groupData[gid];
        const w = document.querySelector(`.gt-widget-detached[data-group-id="${gid}"]`);
        if (w) w.remove();
      }
      saveGroups();
    }
    // Removing the last avg goal from a widget should drop its bumped
    // min-width back to the default. This handler doesn't call
    // renderAllGoals, so refresh the .gt-widget-has-avg gating
    // explicitly — same reasoning as in the drag-drop handler.
    updateAllWidgetAvgClasses();
    // If this was a rival goal, reconcile managed stores — a rival whose
    // last referencing goal just went away gets its store dropped and its
    // polling stopped (the self store always stays).
    if (type === "rival" && isLeader) ensureRivalSync();
  }

  confirmBtn.addEventListener("click", async () => {
    // ── Rival goal ────────────────────────────────────────────
    // A rival goal carries only a resolved username + a metric. No baseline,
    // target, recurrence or stat fetch needed. The store sync + live
    // comparison machinery (further down) does the rest.
    if (selectedType === "rival") {
      // Validate per mode: single needs a resolved name, multiple needs a list.
      if (rivalMultiMode) { if (selectedRivalList.length === 0) return; }
      else if (rivalFetchedName == null) return;
      // The comparison filters are PER-GOAL and were configured right here in the
      // modal — seed the new goal straight from the draft. Nothing is written
      // back to the global object; the bulk fetch is keyed to the rival username
      // only, so ensureRivalSync still starts the right stream.
      const rivalCfg = { ...rivalDraftSettings, settingsV: RIVAL_GOAL_SETTINGS_V };
      const goalId = generateGoalId("rival");
      let newGoal;
      if (rivalMultiMode) {
        // De-dup defensively (case-insensitive; first spelling wins).
        const seen = new Set();
        const rivals = [];
        for (const n of selectedRivalList) {
          const k = n.toLowerCase();
          if (!seen.has(k)) { seen.add(k); rivals.push(n); }
        }
        newGoal = { id: goalId, rivals, mode: "multi", rivalSettings: rivalCfg };
      } else {
        newGoal = {
          id: goalId,
          rival: rivalFetchedName,         // display name (as TypeGG returns it)
          rivalSettings: rivalCfg,
        };
      }
      goalData.rival.push(newGoal);
      saveGoals("rival");
      if (!groupData[MAIN_GROUP_ID].goalIds.includes(newGoal.id)) {
        groupData[MAIN_GROUP_ID].goalIds.push(newGoal.id);
        saveGroups();
      }
      closeModal();
      renderAllGoals();
      // Leader kicks off (or reuses) the fetch for this rival + ensures the
      // self store is being built. Followers will pick up store updates over
      // the channel / storage events.
      if (isLeader) ensureRivalSync();
      return;
    }

    // ── Improvement-Target goal ─────────────────────────────────
    // Catalog-based; needs no user-stats fetch. Build + store directly, then
    // return (bypasses the cumulative gain-goal construction below). Stored in
    // goalData.improvement with mode:"target" so goalIsImprovementTarget() picks
    // it up; recurrence is always "none". Handles are numbers or null (= the
    // axis end / unconstrained on that side).
    if (selectedType === "improvement" && selectedImprovementMode === "target") {
      if (selectedValue == null || selectedValue <= 0) return;
      const goalId = generateGoalId("improvement");
      const newGoal = {
        id: goalId,
        mode: "target",
        metric: (selectedImprovementMetric === "pp") ? "pp" : "wpm",
        target: selectedValue,
        status: selectedTargetStatus,   // "all" | "ranked" | "unranked"
        played: selectedTargetPlayed,   // "all" | "played"
        diffMin: selectedTargetDiffMin, diffMax: selectedTargetDiffMax,
        lenMin:  selectedTargetLenMin,  lenMax:  selectedTargetLenMax,
        recurrence: "none",
      };
      goalData.improvement.push(newGoal);
      saveGoals("improvement");
      if (!groupData[MAIN_GROUP_ID].goalIds.includes(newGoal.id)) {
        groupData[MAIN_GROUP_ID].goalIds.push(newGoal.id);
        saveGroups();
      }
      closeModal();
      renderAllGoals();
      // Kick the catalog build/refresh now that a Target goal exists (leader).
      if (isLeader) maybeRunQuoteCatalog();
      return;
    }

    try {
      const response = await gtApiFetch(userEndpoint(), { headers: authHeaders() });
      const data     = await response.json();
      const cfg      = GOAL_CONFIG[selectedType];
      
      // For races with quickplay/solo filter, use the appropriate stat instead
      let currentVal;
      if (selectedType === "races" && selectedFilter === "quickplay") {
        currentVal = data.stats?.quickplayRaces;
      } else if (selectedType === "races" && selectedFilter === "solo") {
        currentVal = data.stats?.soloRaces;
      } else if (selectedType === "improvement") {
        // No cumulative stat — use lifetime races so the null-guard passes and
        // lastEvalRaces seeds from the same field the evaluator reads.
        currentVal = data.stats?.races ?? 0;
      } else {
        currentVal = data.stats?.[cfg.statKey];
      }
      
      if (currentVal == null) return;

      let gainTarget;
      let isMaxQuotes = false;
      let maxQuotesBaselineOverride = null; // kind-appropriate typed count for unranked/all
      let maxQuotesKindForGoal = null;      // captured kind written onto the goal
      let isMaxChars = false;
      let maxCharsKindForGoal = null;
      const isQuoteChars = selectedType === "chars" && selectedCharsKind === "quote";
      let quoteCharsBaseline = null;       // distinct-quote-char baseline (null = lock lazily once synced)
      let quoteCharsAbsoluteTarget = null; // custom (target-mode) goal: the absolute total to reach
      
      if (selectedMode === "rank") {
        if (rankFetchedRank == null) return;

        // All rank goals (next-rank or regular, PP or EXP) save with target=0
        // initially so the modal closes instantly. updateRankGoals() /
        // updateExpRankGoals() compute the real target in the background; the
        // goal display shows "Loading PP..." / "Loading EXP..." in the meantime.
        gainTarget = 0;

      } else if (selectedMode === "player") {
          if (playerFetchedValue == null) return;

          gainTarget = playerFetchedValue - currentVal;
          if (gainTarget <= 0) gainTarget = 0;
    } else if (selectedMode === "average") {
      // Average mode doesn't have a "gain target" in the cumulative sense.
      // The target is targetAvg (a metric value, not a delta), and progress
      // is computed from windowRaces. We still set gd.target = 0 to satisfy
      // anywhere downstream that reads .target — the avg-rendering path
      // ignores it. selectedValue here is the user-entered target avg.
      if (selectedValue == null || selectedValue <= 0) return;
      if (selectedWindow == null || selectedWindow <= 0) return;
      if (selectedMetric === "accuracy" && selectedValue > 100) return;
      gainTarget = 0;
    } else if (selectedMode === "improvement") {
      // Improvement mode: target is a cumulative WPM-gain figure. No
      // "above current" check — it's a fresh accumulator starting at 0.
      if (selectedValue == null || selectedValue <= 0) return;
      gainTarget = selectedValue;
    } else if (selectedMode === "target" && cfg.supportsTarget) {
        if (selectedType === "quotes" && maxQuotesMode && maxQuotesKind) {
          // ── Max quotes mode (ranked / unranked / all) ──────────
          if (maxQuotesFetched == null) return;   // total count failed to load
          const kind = maxQuotesKind;

          // Baseline = how many of this kind the user has ALREADY typed.
          //   ranked   → quotesTyped (currentVal, freshly fetched above)
          //   unranked → dedicated endpoint
          //   all      → ranked + unranked
          const typedRanked = currentVal;         // == data.stats.quotesTyped
          let typedUnranked = 0;
          if (kind === "unranked" || kind === "all") {
            try { typedUnranked = await getUserQuotesTyped("unranked"); }
            catch { typedUnranked = null; }
            if (typedUnranked == null) return;     // can't establish a baseline
            // Seed the live cache so the first render shows correct progress
            // before the next stats poll fetches it.
            currentStats.quotesUnranked = typedUnranked;
          }

          let baseline;
          if (kind === "ranked")        baseline = typedRanked;
          else if (kind === "unranked") baseline = typedUnranked;
          else                          baseline = typedRanked + typedUnranked;

          maxQuotesBaselineOverride = baseline;
          maxQuotesKindForGoal      = kind;
          gainTarget = Math.max(0, maxQuotesFetched - baseline);
          isMaxQuotes = true;
        } else if (selectedType === "chars" && maxCharsMode && maxCharsKind) {
          // Max chars: a computed catalog goal (no cumulative target). Store the
          // kind; the render tallies Σ length live off the catalog + self store.
          isMaxChars = true;
          maxCharsKindForGoal = maxCharsKind;
          gainTarget = 0;
        } else if (selectedType === "chars" && isQuoteChars) {
          // Quote-chars custom target — an ABSOLUTE distinct-quote-char total to
          // reach. Resolved into a gain target against the baseline below (lazily
          // once the catalog finishes syncing, so creation isn't blocked).
          if (selectedValue == null || selectedValue <= 0) return;
          gainTarget = selectedValue; // placeholder; refined once baseline known
        } else {
          // Regular target mode
          if (selectedValue == null || selectedValue <= currentVal) return;
          gainTarget = selectedValue - currentVal;
        }
      } else {
        if (selectedValue == null || selectedValue <= 0) return;
        gainTarget = selectedValue;
      }

      // Quote-chars (non-max): lock the distinct-quote baseline now if the catalog
      // is synced, else defer it (the goal renders "Syncing…" until the first ready
      // render locks it). For a target-mode goal, resolve the absolute target into
      // a gain target against that baseline.
      if (isQuoteChars && !(maxCharsMode && maxCharsKind)) {
        quoteCharsBaseline = maxCharsReady() ? tallyMaxChars("all").typed : null;
        if (selectedMode === "target") {
          quoteCharsAbsoluteTarget = selectedValue;
          if (quoteCharsBaseline != null) {
            gainTarget = Math.max(1, selectedValue - quoteCharsBaseline);
            quoteCharsAbsoluteTarget = null;
          }
        }
      }

      const isRecurring = selectedRec !== "none";
      const goalId = generateGoalId(selectedType);

      // Requirements: only set for race + gain goals where the user actually
      // entered ≥1 threshold. Stored as { wpm, accuracy, pp } (any subset can be null).
      // qualifyingProgress replaces the gain calculation for these goals — it's
      // incremented by the requirement evaluator (see evaluateRaceRequirements),
      // not derived from currentVal - baseline.
      // uniqueOnly: when true, each qualifying race must be on a different
      // quoteId.
      //   - In gain mode: tracked via seenQuoteIds (a permanent set of
      //     quoteIds we've already qualified on this period). Can be
      //     enabled standalone (no thresholds) — in that case every race
      //     trivially passes the bar and the unique-quote check is the
      //     ONLY gate.
      //   - In avg mode: tracked via windowQuoteIds (an array running
      //     parallel to windowRaces). When a race is evicted from the
      //     window, its quoteId is also evicted — so the user can re-do
      //     a quote once it leaves the window. This keeps "the last 25
      //     races consist of 25 different quotes" without permanent
      //     lockout.
      // Strict mode is meaningless without thresholds (nothing can fail),
      // so it's tied to reqActive.
      const reqActive       = selectedType === "races" && selectedMode === "gain" && hasAnyReq(selectedReq);
      const gainUniqueActive = selectedType === "races" && selectedMode === "gain"    && selectedUnique;
      const avgUniqueActive  = selectedType === "races" && selectedMode === "average" && selectedUnique;
      const uniqueActive    = gainUniqueActive || avgUniqueActive;
      const usesEvaluator   = reqActive || gainUniqueActive;
      const requirements = reqActive ? { ...selectedReq } : undefined;
      const strictMode   = reqActive ? selectedStrict : undefined;
      const uniqueOnly   = uniqueActive ? true : undefined;

      // Average-mode fields. Only meaningful in mode=average; everything
      // else stores undefined which JSON-serializes away. windowRaces
      // starts empty; bestAvg null until window first fills. lastEvalRaces
      // seeds from lifetime races for the same reason gated goals do —
      // see the comment on lastEvalRaces below.
      const isAvgMode    = selectedMode === "average" && selectedType === "races";
      const avgMetric    = isAvgMode ? selectedMetric : undefined;
      const avgWindow    = isAvgMode ? selectedWindow : undefined;
      const avgTarget    = isAvgMode ? selectedValue : undefined;

      // Improvement mode. Like avg, it consumes the recent-races list and
      // seeds lastEvalRaces from lifetime races so only post-creation races
      // count. quoteBests starts empty (baselines are seeded lazily at
      // quote-start); accumulatedGain starts at 0.
      const isImprovementMode = selectedType === "improvement";
      const goalMode     = isAvgMode ? "average" : (isImprovementMode ? "improvement" : undefined);

      // Improvement track config: "best" (ratchet your PB) vs "average"
      // (rolling-average improvement). The average track always uses a rolling
      // window — improvementAvgWindow is the window, warm-up, and baseline
      // sample size. Per-quote state lives in quoteBests (best) or quoteAvgs
      // (average); only the relevant one is initialized.
      const impTrack    = isImprovementMode ? selectedImprovementTrack : undefined;
      const impIsAvg    = isImprovementMode && selectedImprovementTrack === "average";
      const impAvgWin   = impIsAvg ? selectedImprovementAvgWindow : undefined;

      const newGoal = {
        id: goalId,
        target: gainTarget,
        targetRank: selectedMode === "rank" ? rankFetchedRank : undefined,
        nextRank: (selectedMode === "rank" && nextRankMode) || undefined,
        targetUsername: selectedMode === "player" ? playerFetchedName : undefined,
        maxQuotes: isMaxQuotes || undefined,
        maxQuotesKind: maxQuotesKindForGoal || undefined,
        maxChars: isMaxChars || undefined,
        maxCharsKind: maxCharsKindForGoal || undefined,
        quoteChars: isQuoteChars || undefined,
        baselineQuoteChars: (isQuoteChars && !(maxCharsMode && maxCharsKind)) ? quoteCharsBaseline : undefined,
        quoteCharsAbsoluteTarget: quoteCharsAbsoluteTarget != null ? quoteCharsAbsoluteTarget : undefined,
        filter: (selectedType === "races" || selectedType === "improvement") ? selectedFilter : undefined,
        targetLoaded: selectedMode === "rank" ? false : true, // false for rank goals — target is loaded async by updateRankGoals/updateExpRankGoals
        [cfg.baselineKey]: maxQuotesBaselineOverride != null ? maxQuotesBaselineOverride : currentVal,
        recurrence: selectedRec,
        supportsRecurrence: (selectedMode === "gain" || selectedMode === "average" || selectedMode === "improvement"),
        periodStart: isRecurring ? getCurrentPeriodStart(selectedRec) : null,
        streak: 0,
        totalCompletions: 0,
        completedThisPeriod: false,
        // Requirements fields (undefined fields are dropped on JSON serialization)
        requirements,
        strictMode,
        uniqueOnly,
        // Gain-mode unique tracker: a permanent set of quoteIds we've
        // already qualified on this period. Reset to [] on period rollover
        // so each period gets a fresh slate of quotes to qualify on.
        seenQuoteIds: gainUniqueActive ? [] : undefined,
        qualifyingProgress: usesEvaluator ? 0 : undefined,
        // Snapshot of the LIFETIME races stat we've already evaluated.
        // The evaluator works off currentStats.races (lifetime), not the
        // filtered counter — so this must be seeded from the same field.
        // Bug fix: previously seeded from `currentVal`, which for a quickplay
        // goal is `quickplayRaces` (e.g. 200) while the evaluator's snapshot
        // was lifetime races (e.g. 5000). Mismatch → delta of 4800 → goal
        // instantly filled itself with the most recent threshold-passing
        // races. Always seed from lifetime here.
        // For average goals: same field, same purpose — the evaluator
        // also walks the recent-races list to slide the window.
        lastEvalRaces: (usesEvaluator || isAvgMode || isImprovementMode) ? (currentStats.races ?? 0) : undefined,
        // Average-mode fields. mode="average" is the marker that flips
        // render and eval onto the rolling-avg path.
        mode: goalMode,
        metric: avgMetric,
        windowSize: avgWindow,
        targetAvg: avgTarget,
        windowRaces: isAvgMode ? [] : undefined,
        // Avg-mode unique tracker: parallel to windowRaces. Push together,
        // shift together. When a race leaves the window, so does its
        // quoteId — letting the user re-race that quote later.
        windowQuoteIds: avgUniqueActive ? [] : undefined,
        bestAvg: isAvgMode ? null : undefined,
        // Improvement-mode fields. quoteBests maps quoteId → the user's best
        // (best track). quoteAvgs maps quoteId → rolling-average state
        // {window:[…], baseline, peak} (average track), seeded lazily at
        // quote-start. accumulatedGain sums the per-quote banked peak lift.
        quoteBests: (isImprovementMode && !impIsAvg) ? {} : undefined,
        quoteAvgs:  impIsAvg ? {} : undefined,
        accumulatedGain: isImprovementMode ? 0 : undefined,
        improvementMetric: isImprovementMode ? selectedImprovementMetric : undefined,
        countFirstTime: (isImprovementMode && !impIsAvg) ? selectedCountFirstTime : undefined,
        improvementTrack: impTrack,
        improvementAvgWindow: impAvgWin,
      };

      goalData[selectedType].push(newGoal);
      saveGoals(selectedType);

      // Add to main group so a widget contains it.
      // findGroupIdOfGoal will return null for the brand-new ID, so we
      // append to main unconditionally here.
      if (!groupData[MAIN_GROUP_ID].goalIds.includes(newGoal.id)) {
        groupData[MAIN_GROUP_ID].goalIds.push(newGoal.id);
        saveGroups();
      }

      closeModal();
      // Re-render immediately with currently cached stats (no fetch needed)
      renderAllGoals();
      // If we're the leader, trigger target updates directly.
      // If we're a follower, saveGoals() already fired a storage event
      // which the leader will pick up and handle.
      if (isLeader) {
        inFlight(updateRankGoals)();
        inFlight(updateExpRankGoals)();
        inFlight(updateMaxQuotesGoals)();
        // Newly-created req goal — kick off an evaluation in case races
        // happened between the cached baseline and now (rare, but cheap to check).
        // Same for fresh average goals — they need the evaluator to walk
        // pre-creation races... wait, we don't want pre-creation races to
        // count. The evaluator uses lastEvalRaces to bound what gets read,
        // so seeding lastEvalRaces = currentStats.races above means "look
        // at races AFTER right now". So this kick-off is a no-op on
        // creation but ensures the eval cycle has a chance to wire up.
        if (usesEvaluator || isAvgMode) evaluateRaceRequirementsGuarded();
        if (isImprovementMode) { evaluateImprovementGuarded(); maybeRunQuoteCatalog(); }
      }
    } catch (err) { console.error("Failed to set goal:", err); }
  });

  // ── Update a rolling-average goal section ─────────────────────
  // Renders the avg-specific layout (best line, live line, footer) and
  // hides the gain-row + progress-bar that updateGoalSection uses.
  // Called from the renderAllGoals loop with the avg branch.
  //
  // State conventions:
  //   - gd.windowRaces holds metric values, oldest-first. Length 0..windowSize.
  //   - gd.bestAvg is the peak full-window mean this period (null while filling).
  //   - gd.completedThisPeriod is the sticky achievement flag.
  //
  // Visuals:
  //   - Best line: "best <val> / <target>" with the ✓ pill far-right when
  //     achieved. Val is "——" while filling. Val turns green once
  //     bestAvg ≥ targetAvg (i.e. window has been full and a full-window
  //     mean cleared the bar at some point this period).
  //   - Live line: "current <val> [+delta]". The +/- pill is inserted
  //     inline by the gain-indicator code below — same 5-second pop
  //     animation used by other goals, anchored to the current-wrap.
  //   - Bottom line: "threshold: <val> .... <n> / <N> races". Threshold
  //     left, race counter right (space-between).
  function updateAverageGoalSection(goalId, type, cfg, gd, isRecurring) {
    // Hide the gain-row + progress-bar (used by all other goal modes).
    // Do this every render — a goal's mode can't actually change after
    // creation, but defensive hiding keeps things simple.
    const gainRow = document.querySelector(`#${goalId}-goal-section .gt-gain-row`);
    const progressBar = document.querySelector(`#${goalId}-goal-section .gt-progress-bar`);
    if (gainRow)     gainRow.style.display     = "none";
    if (progressBar) progressBar.style.display = "none";

    // Show avg-specific rows
    const bestRow   = document.getElementById(`${goalId}-avg-best-row`);
    const liveRow   = document.getElementById(`${goalId}-avg-live-row`);
    const bottomRow = document.getElementById(`${goalId}-avg-bottom-row`);
    if (bestRow)   bestRow.style.display   = "flex";
    if (liveRow)   liveRow.style.display   = "flex";
    if (bottomRow) bottomRow.style.display = "flex";

    // ── Header label & badges ─────────────────────────────────
    // "Rolling avg WPM (quickplay) ✨" — filter chip and unique-mode
    // glyph both appended after the metric label. The ✨ tells the user
    // at a glance that the goal requires unique quotes; without it,
    // there's no other on-card indication of the unique-quote setting.
    const filterStr = (gd.filter && gd.filter !== "all") ? ` (${gd.filter})` : "";
    const uniqueStr = gd.uniqueOnly ? " ✨" : "";
    document.getElementById(`${goalId}-label`).textContent =
      `Avg ${metricLabel(gd.metric)}${filterStr}${uniqueStr}`;

    // Recurrence badge — same visual treatment as other goals.
    const recBadgeEl = document.getElementById(`${goalId}-rec-badge`);
    recBadgeEl.textContent   = REC_LABELS[gd.recurrence] ?? "";
    recBadgeEl.style.display = isRecurring ? "inline" : "none";

    // Streak counter — same as other goals (driven by displaySettings).
    const streakEl = document.getElementById(`${goalId}-streak`);
    if (isRecurring) {
      const mode = displaySettings.streakMode;
      if (mode === "streak" && gd.streak > 0) {
        streakEl.textContent = `🔥 ${gd.streak}`;
        streakEl.style.display = "inline";
      } else if (mode === "total") {
        const total = gd.totalCompletions ?? gd.streak ?? 0;
        if (total > 0) {
          streakEl.textContent = String(total);
          streakEl.style.display = "inline";
        } else {
          streakEl.style.display = "none";
        }
      } else {
        streakEl.style.display = "none";
      }
    } else {
      streakEl.style.display = "none";
    }

    // Countdown for recurring goals — same as other goals.
    const countdownEl = document.getElementById(`${goalId}-countdown`);
    if (isRecurring) {
      countdownEl.textContent = formatCountdown(getNextResetTime(gd.recurrence) - Date.now());
      countdownEl.style.display = "block";
    } else {
      countdownEl.style.display = "none";
    }

    // ── Compute live values ───────────────────────────────────
    const windowRaces  = Array.isArray(gd.windowRaces) ? gd.windowRaces : [];
    const windowSize   = gd.windowSize ?? 0;
    const currentAvg   = arrayMean(windowRaces);  // null when empty
    const threshold    = computeThreshold(windowRaces, windowSize);
    const bestAvg      = gd.bestAvg ?? null;
    const targetAvg    = gd.targetAvg ?? 0;
    // Sticky achievement: completedThisPeriod is set once bestAvg ≥ target.
    // For non-recurring goals it stays set forever (no period rollover).
    // For recurring goals it resets at rollover.
    const isAchieved   = !!gd.completedThisPeriod
                         || (bestAvg != null && bestAvg >= targetAvg);

    // ── Best line ─────────────────────────────────────────────
    // "best <val> / <target>" plus optional ✓. Val shows em-dash while
    // bestAvg is null (i.e., window has never been full this period).
    const bestValEl    = document.getElementById(`${goalId}-avg-best-val`);
    const bestTargetEl = document.getElementById(`${goalId}-avg-best-target`);
    const doneEl       = document.getElementById(`${goalId}-avg-done`);
    if (bestValEl) {
      if (bestAvg == null) {
        bestValEl.textContent = "——";
        bestValEl.classList.remove("gt-avg-best-done");
        bestValEl.classList.add("gt-avg-best-empty");
      } else {
        bestValEl.textContent = formatMetricVal(bestAvg, gd.metric);
        bestValEl.classList.remove("gt-avg-best-empty");
        bestValEl.classList.toggle("gt-avg-best-done", isAchieved);
      }
    }
    if (bestTargetEl) {
      bestTargetEl.textContent = `/ ${formatMetricTarget(targetAvg, gd.metric)}`;
    }
    if (doneEl) doneEl.style.display = isAchieved ? "inline" : "none";

    // ── Live & threshold ──────────────────────────────────────
    // current <val> on the live row, threshold + race counter on the
    // bottom row. Plain text updates — both rows themselves are sized
    // and positioned by CSS.
    const currentEl   = document.getElementById(`${goalId}-avg-current`);
    const thresholdEl = document.getElementById(`${goalId}-avg-threshold`);
    if (currentEl)   currentEl.textContent   = formatMetricVal(currentAvg, gd.metric);
    if (thresholdEl) thresholdEl.textContent = formatMetricVal(threshold,  gd.metric);

    // Race-count progress on the bottom row, right-aligned. (No hint
    // text for now — the user hasn't picked a final placement, so
    // "filling" / "achieved" status is conveyed by the ✓ pill alone.)
    const progressEl = document.getElementById(`${goalId}-avg-progress`);
    if (progressEl) progressEl.textContent = `${windowRaces.length} / ${windowSize} races`;

    // ── Delta detection (current avg & best avg) ─────────────
    // Two independent indicators:
    //   1. ±X pill on `current` — flashes after any race that changes
    //      the rolling avg (positive OR negative).
    //   2. +X pill on `best` — flashes only when bestAvg goes UP.
    // Both use the same 5-second animation as the existing gain pill.
    // Both suppress when the rounded delta == 0 (no visual change).
    const prevAvg  = prevAvgMap[goalId];
    const prevBest = prevBestMap[goalId];

    // Delta on current avg. Skip first render (prev == null) to avoid
    // a spurious "+138" flash when the goal first appears.
    if (currentAvg != null && prevAvg != null && currentAvg !== prevAvg) {
      const delta = currentAvg - prevAvg;
      const decimals = metricDecimals(gd.metric);
      const absStr = Math.abs(delta).toFixed(decimals);
      // Skip the pill if the delta rounds to zero at display precision.
      // The user sees the same number as before the race, so flashing
      // "−0.0" or "+0.0" is just visual noise. Compare to the all-zeros
      // string ("0", "0.0", "0.00") to handle any decimals value.
      const roundsToZero = parseFloat(absStr) === 0;
      if (!roundsToZero) {
        const positive = delta > 0;
        const deltaStr = `${positive ? "+" : "−"}${absStr}`;

        const existing = document.getElementById(`${goalId}-gain-indicator`);
        if (existing) existing.remove();
        const indicator = document.createElement("span");
        indicator.id = `${goalId}-gain-indicator`;
        indicator.className = positive ? "gt-gain-indicator" : "gt-gain-indicator gt-gain-indicator-neg";
        indicator.textContent = deltaStr;
        // Anchor the pill right after the current value (the user explicitly
        // wanted it inline next to the number that changed, not far-right).
        const currentWrap = document.querySelector(`#${goalId}-goal-section .gt-avg-current-wrap`);
        if (currentWrap) currentWrap.appendChild(indicator);
        indicator.addEventListener("animationend", () => indicator.remove());
      }
    }
    // Track current avg for the next render's delta computation.
    if (currentAvg != null) prevAvgMap[goalId] = currentAvg;

    // Best-avg delta. Same green pop pill as the current-avg one, just
    // anchored to the best line. Only fires when bestAvg increases — by
    // construction it can never decrease (it's a monotonic peak per
    // period). Suppressed in two cases:
    //   - First render (prevBest === undefined) — avoids a phantom pill
    //     when the goal first appears with a non-null bestAvg.
    //   - First time bestAvg leaves null (window just hit full size) —
    //     a "+143" pill there is misleading because there's no prior
    //     best to compare against; the user explicitly didn't want this.
    if (bestAvg != null && prevBest != null && bestAvg > prevBest) {
      const delta = bestAvg - prevBest;
      const decimals = metricDecimals(gd.metric);
      const deltaStr = `+${delta.toFixed(decimals)}`;
      // Same zero-after-rounding suppression as the current-avg pill —
      // a "+0.0" flash on best is even less informative than on current
      // (best can only move when current sets a new high, so by the time
      // we get here the user already saw the current pill).
      if (parseFloat(deltaStr) !== 0) {
        const existing = document.getElementById(`${goalId}-newbest-indicator`);
        if (existing) existing.remove();
        const indicator = document.createElement("span");
        indicator.id = `${goalId}-newbest-indicator`;
        // Same class as current-avg pill so the visuals match (green, same
        // 5s pop animation). Only difference is the DOM anchor point.
        indicator.className = "gt-gain-indicator";
        indicator.textContent = deltaStr;
        // Anchor the pill as a SIBLING of the target span (inside
        // .gt-avg-best-group), not as a child of target. Two reasons:
        //
        //  1. textContent reset survival. The render path reassigns
        //     bestTargetEl.textContent on every tick (`/ 150`), and at
        //     the moment a goal is first achieved updateAverageGoalSection
        //     is called twice in a row (once on the bestAvg cross, then
        //     again after completedThisPeriod is flipped so the ✓ shows
        //     immediately) — a pill nested inside target would be wiped
        //     by the second pass before the user ever saw it. As a
        //     sibling, the textContent reset on target leaves it alone.
        //
        //  2. Baseline alignment. As a regular flex item of
        //     .gt-avg-best-group (which has align-items: baseline),
        //     the pill baselines correctly with target/val automatically
        //     — same pattern as the current-row pill on .gt-avg-current-wrap.
        //     An earlier iteration anchored on bestTargetEl with
        //     position:absolute to keep adding the pill from changing
        //     the row's geometry, but lost baseline alignment in
        //     practice and put the pill too high.
        //
        // Adding the pill expands best-group's content rightward, but
        // the row's space-between keeps ✓ anchored to the right edge
        // and nothing visible shifts. Min-width on widgets that host
        // avg goals (.gt-widget-has-avg) reserves enough horizontal
        // room that the pill never collides with ✓.
        const bestGroup = document.querySelector(`#${goalId}-goal-section .gt-avg-best-group`);
        if (bestGroup) bestGroup.appendChild(indicator);
        indicator.addEventListener("animationend", () => indicator.remove());
      }
    }
    prevBestMap[goalId] = bestAvg;
  }

  // ── Update a single goal section ───────────────────────────────
  function updateGoalSection(goalId, type, cfg, gd, gain, isRecurring, gainDelta = 0) {
    // Defensive: a non-avg goal might be inside a section that previously
    // rendered an avg goal (shouldn't happen since mode is immutable post-
    // creation, but cheap to guarantee). Hide the avg rows; show the gain
    // row + progress bar that this function actually populates.
    const bestRow   = document.getElementById(`${goalId}-avg-best-row`);
    const liveRow   = document.getElementById(`${goalId}-avg-live-row`);
    const bottomRow = document.getElementById(`${goalId}-avg-bottom-row`);
    if (bestRow)   bestRow.style.display   = "none";
    if (liveRow)   liveRow.style.display   = "none";
    if (bottomRow) bottomRow.style.display = "none";
    const gainRowEl = document.querySelector(`#${goalId}-goal-section .gt-gain-row`);
    const progBarEl = document.querySelector(`#${goalId}-goal-section .gt-progress-bar`);
    if (gainRowEl) gainRowEl.style.display = "";
    if (progBarEl) progBarEl.style.display = "";

    // Calculate percentage - for max quotes use total progress, otherwise use gain
    let pct, isComplete;
    if (gd.maxQuotes) {
      const currentQuotes = gd.baselineQuotes + gain;
      const totalQuotes = gd.baselineQuotes + gd.target;
      pct = totalQuotes > 0 ? Math.min(Math.floor((currentQuotes / totalQuotes) * 100), 100) : 0;
      isComplete = currentQuotes >= totalQuotes && totalQuotes > 0;
    } else {
      pct = Math.max(0, Math.min(Math.floor((gain / gd.target) * 100), 100));
      isComplete = gain >= gd.target && gd.target > 0;
    }

    // Label
    document.getElementById(`${goalId}-label`).textContent = cfg.label;

    // Progress text — gain / target, or "Z to go" (Z = target − gain) when this
    // goal's per-goal count view is flipped to "remaining" (via the header
    // toggle). No PP carve-out: cumulative & next-rank are accumulations.
    const gainTextEl = document.getElementById(`${goalId}-gain-text`);
    const remainingView = goalCountView(gd) === "remaining";
    if (gd.targetRank && !gd.targetLoaded) {
      // Any rank goal whose target hasn't been resolved by updateRankGoals /
      // updateExpRankGoals yet — show a type-specific loading message.
      gainTextEl.textContent = type === "exp" ? "Loading EXP..." : "Loading PP...";
    } else if (gd.maxQuotes && gd.target === 0) {
      gainTextEl.textContent = "Loading target...";
    } else if (gd.maxQuotes) {
      // For max quotes, show total completed / total max instead of gain / remaining
      const currentQuotes = gd.baselineQuotes + gain;
      const totalQuotes = gd.baselineQuotes + gd.target;
      gainTextEl.textContent = remainingView
        ? `${Math.round(totalQuotes - currentQuotes).toLocaleString()} to go`
        : `${Math.round(currentQuotes).toLocaleString()} / ${totalQuotes.toLocaleString()}`;
    } else if (cfg.isTime) {
      gainTextEl.textContent = remainingView
        ? `${formatPlaytime(gd.target - gain)} to go`
        : `${formatPlaytime(gain)} / ${formatPlaytime(gd.target)}`;
    } else {
      const gainStr   = cfg.decimals > 0 ? parseFloat(gain).toFixed(cfg.decimals)   : Math.round(gain).toLocaleString();
      const targetStr = cfg.decimals > 0 ? parseFloat(gd.target).toFixed(cfg.decimals) : gd.target.toLocaleString();
      if (remainingView) {
        const rem = gd.target - gain;
        const remStr = cfg.decimals > 0 ? parseFloat(rem).toFixed(cfg.decimals) : Math.round(rem).toLocaleString();
        gainTextEl.textContent = `${remStr} to go`;
      } else {
        gainTextEl.textContent = `${gainStr} / ${targetStr}`;
      }
    }

    document.getElementById(`${goalId}-progress-fill`).style.width      = `${pct}%`;
    document.getElementById(`${goalId}-progress-fill`).style.background = isComplete ? "#4ade80" : "#60a5fa";

    const recBadgeEl = document.getElementById(`${goalId}-rec-badge`);
    recBadgeEl.textContent   = REC_LABELS[gd.recurrence] ?? "";
    recBadgeEl.style.display = isRecurring ? "inline" : "none";

    const streakEl = document.getElementById(`${goalId}-streak`);
    if (isRecurring) {
      const mode = displaySettings.streakMode;
      if (mode === "streak" && gd.streak > 0) {
        streakEl.textContent = `🔥 ${gd.streak}`;
        streakEl.style.display = "inline";
      } else if (mode === "total") {
        // Lazy-backfill for goals created before totalCompletions existed:
        // fall back to the streak value so pre-existing users don't see a
        // regression to 0 on first render after enabling total mode.
        const total = gd.totalCompletions ?? gd.streak ?? 0;
        if (total > 0) {
          streakEl.textContent = String(total);
          streakEl.style.display = "inline";
        } else {
          streakEl.style.display = "none";
        }
      } else {
        streakEl.style.display = "none";
      }
    } else {
      streakEl.style.display = "none";
    }

    document.getElementById(`${goalId}-done-badge`).style.display = isComplete ? "inline" : "none";

    const countdownEl = document.getElementById(`${goalId}-countdown`);
    if (isRecurring) { countdownEl.textContent = formatCountdown(getNextResetTime(gd.recurrence) - Date.now()); countdownEl.style.display = "block"; }
    else countdownEl.style.display = "none";

    // Requirement lines (sub-rows beneath the header) — shown only for race
    // goals with active requirements. Two separate lines so skill axes
    // (WPM/ACC/PP) and quote axes (LEN/DIFF) can render independently;
    // the user explicitly asked for these on different rows since they're
    // conceptually different (user performance vs text properties).
    // Always reset both to hidden first so a goal that lost a category
    // (or a non-req goal) doesn't keep a stale line from a previous render.
    const reqLineEl  = document.getElementById(`${goalId}-req-line`);
    const reqLine2El = document.getElementById(`${goalId}-req-line-2`);
    if (reqLineEl)  { reqLineEl.textContent  = ""; reqLineEl.style.display  = "none"; }
    if (reqLine2El) { reqLine2El.textContent = ""; reqLine2El.style.display = "none"; }

    if (gd.quoteChars) {
      document.getElementById(`${goalId}-label`).textContent = "Quote Chars";
    } else if (gd.nextRank && gd.targetRank) {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → #${gd.targetRank} (next rank)`;
    } else if (gd.targetRank) {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → rank #${gd.targetRank}`;
    } else if (gd.targetUsername) {
      document.getElementById(`${goalId}-label`).textContent =
        `${cfg.label} (vs ${gd.targetUsername})`;
    } else if (gd.maxQuotes) {
      const kind = maxQuotesKindOf(gd);
      const suffix = kind === "unranked" ? "max unranked"
                   : kind === "all"      ? "max all"
                   :                       "max ranked";
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → ${suffix}`;
    } else if (goalIsImprovement(gd)) {
      const metricLbl = (gd.improvementMetric === "pp") ? "PP" : "WPM";
      const filterStr = (gd.filter && gd.filter !== "all") ? ` (${gd.filter})` : "";
      const trackStr = (gd.improvementTrack === "average")
        ? ` avg·${Math.max(2, gd.improvementAvgWindow || 5)}`
        : "";
      document.getElementById(`${goalId}-label`).textContent = `${metricLbl}${trackStr} gain${filterStr}`;
    } else if (type === "races" && goalIsGated(gd)) {
      // Requirement-bearing or unique-quote race goal — keep main label
      // clean (just the type + filter chip) and put the threshold summary /
      // mode glyphs on their own row(s) so they don't compete with the
      // recurrence badge / streak counter that already live in the header.
      const filterStr = (gd.filter && gd.filter !== "all") ? ` (${gd.filter})` : "";
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label}${filterStr}`;
      const { skill, quote } = formatRequirementsSuffix(gd.requirements, gd.strictMode, gd.uniqueOnly);
      if (reqLineEl && skill) {
        reqLineEl.textContent = skill;
        reqLineEl.style.display = "block";
      }
      if (reqLine2El && quote) {
        reqLine2El.textContent = quote;
        reqLine2El.style.display = "block";
      }
    } else if (type === "races" && gd.filter === "quickplay") {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} (quickplay)`;
    } else if (type === "races" && gd.filter === "solo") {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} (solo)`;
    }

    // ── Auto-reset completed next-rank goals ───────────────────
    // When a next-rank goal is reached, kick off a refresh to track
    // the NEW next rank after a 5s delay (delay is pure UX so the
    // user gets to see the green/completed state before it resets).
    // Previously this only happened on the 5-min poll, which was slow.
    if (isComplete && gd.nextRank && (type === "pp" || type === "exp")) {
      scheduleNextRankReset(goalId, type);
    }

    // ── Gain delta indicator (+X / −X pop-up) ──────────────────
    // Positive delta = green "+N" indicator (a qualifying race).
    // Negative delta = red "−N ⚡" indicator (strict-mode reset on a miss).
    if (gainDelta !== 0) {
      // `good` = progress was made → green; a strict-mode reset is the only
      // bad case → red + ⚡. In remaining-view the DISPLAYED sign flips (a gain
      // shows "−N" because Z drops toward 0), but the colour still tracks
      // good/bad, so a normal gain reads "−N" green and a strict reset reads
      // "+N ⚡" red (Z rose). `positive` keeps driving the colour class below.
      const good = gainDelta > 0;
      const positive = good;
      const showPlus = remainingView ? !good : good;
      const signChar = showPlus ? "+" : "−";
      const absDelta = Math.abs(gainDelta);
      let deltaStr;
      if (cfg.isTime) {
        deltaStr = `${signChar}${formatPlaytime(absDelta)}`;
      } else if (cfg.decimals > 0) {
        deltaStr = `${signChar}${parseFloat(absDelta).toFixed(cfg.decimals)}`;
      } else {
        deltaStr = `${signChar}${Math.round(absDelta).toLocaleString()}`;
      }
      // Append the lightning glyph for strict resets so the cause is obvious
      if (!good) deltaStr += " ⚡";

      // Remove any existing indicator so re-triggering restarts the animation
      const existing = document.getElementById(`${goalId}-gain-indicator`);
      if (existing) existing.remove();

      const indicator = document.createElement("span");
      indicator.id = `${goalId}-gain-indicator`;
      // Reuse the same CSS animation; .gt-gain-indicator-neg overrides the colour
      indicator.className = positive ? "gt-gain-indicator" : "gt-gain-indicator gt-gain-indicator-neg";
      indicator.textContent = deltaStr;

      // Insert into the gain row so it sits next to the progress text
      const gainRow = document.getElementById(`${goalId}-gain-text`)?.parentElement;
      if (gainRow) gainRow.appendChild(indicator);

      // Self-remove after animation completes so the DOM stays clean
      indicator.addEventListener("animationend", () => indicator.remove());
    }
  }

  // Improvement-Target card. Mirrors the rival card (no progress bar): a value
  // row showing "<your current-quote value> / <target>" — your number greens
  // once you hit the target — then a count sub-line ("quotes ≥ N METRIC: X / Y"
  // over the filtered catalog) and the full-width "Next quote" button. The
  // current-quote value reads the self store for the live quoteId (0 = never
  // raced here), exactly like the rival "you" number.
  // Shared filter-band formatter for the goal cards: "Label: lo - hi", or
  // "Label: lo+" / "Label: \u2264hi" when one end is open, or null when both ends
  // are open (axis full range \u2192 caller omits it). Used by the improvement-
  // target and rival cards so their length / difficulty / WPM filter lines read
  // identically: "Len: 300 - 700 \u2022 Diff: 6 - 8 \u2022 WPM: 100 - 120".
  function gtFilterBand(label, lo, hi, loOpen, hiOpen) {
    if (loOpen && hiOpen) return null;
    if (loOpen) return `${label}: \u2264${hi}`;
    if (hiOpen) return `${label}: ${lo}+`;
    return `${label}: ${lo} - ${hi}`;
  }

  function updateTargetGoalSection(goalId, type, cfg, gd) {
    const metric = targetMetricOf(gd);
    const metricLbl = metric === "pp" ? "PP" : "WPM";
    const target = Number(gd.target) || 0;

    const labelEl = document.getElementById(`${goalId}-label`);
    if (labelEl) labelEl.textContent = `Target ${metricLbl} \u2265 ${target}`;

    // ── Value row: your current-quote value / target ──
    const wrapEl = document.getElementById(`${goalId}-target-value-wrap`);
    const youEl  = document.getElementById(`${goalId}-target-you`);
    const themEl = document.getElementById(`${goalId}-target-them`);
    const msgEl  = document.getElementById(`${goalId}-target-msg`);
    const showMsg = (text) => {
      const gainPill = document.getElementById(`${goalId}-target-gain`);
      if (gainPill) gainPill.remove();
      if (wrapEl) wrapEl.style.display = "none";
      if (msgEl) { msgEl.textContent = text; msgEl.style.display = ""; }
    };

    const liveQid = getCurrentQuoteIdLive();
    const selfStore = loadRivalStore(RIVAL_SELF_NAME);
    // When we have catalog metadata for the live quote and it fails the goal's
    // status/difficulty/length filters, racing it can never move this goal's
    // count (progress is scoped to the filtered pool), so say so instead of
    // showing a value that looks comparable. The "Played" pool is handled the
    // same way: a quote you haven't typed yet is not in the pool, so showing a
    // "0 / target" row would be misleading — it flips to the value row the moment
    // you race it (and it enters the pool). Missing meta (catalog not synced yet)
    // falls through to the value row rather than asserting a mismatch.
    const liveMeta = liveQid ? quoteCatalog[liveQid] : null;
    const liveSelfEntry = liveQid ? selfStore.quotes[liveQid] : undefined;
    const playedOnly = gd.played === "played";
    if (!liveQid) {
      showMsg("Race a quote to compare");
    } else if (liveMeta && !targetQuotePassesMeta(liveMeta, gd)) {
      showMsg("Quote doesn't match filters");
    } else if (playedOnly && !liveSelfEntry) {
      showMsg("Quote doesn't match filters");
    } else {
      const sEntry = liveSelfEntry;
      const sv = sEntry ? (Number(sEntry[metric]) || 0) : 0;
      if (msgEl)  msgEl.style.display = "none";
      if (wrapEl) wrapEl.style.display = "";
      if (youEl) {
        youEl.textContent = rivalFmt(sv);
        // Green once you've met or beaten the target on this quote.
        youEl.className = "gt-rival-you" + (sv >= target - RIVAL_PP_EPS ? " gt-rival-you-done" : "");
      }
      if (themEl) themEl.textContent = ` / ${rivalFmt(target)}`;

      // +X gain pill when your value on THIS quote rises (mirrors the rival
      // card). Only baseline/compare once self is settled so a 0→real fill
      // never flashes a phantom gain; re-baseline on a quote change.
      const settledSelf = !!sEntry || rivalBulkDone(selfStore);
      if (settledSelf && wrapEl) {
        const prev = prevRivalYouMap[goalId];
        if (prev && prev.quoteId === liveQid && prev.metric === metric && prev.value > RIVAL_PP_EPS && sv > prev.value + RIVAL_PP_EPS) {
          const delta = sv - prev.value;
          if (Number(delta.toFixed(2)) > 0) {
            const existing = document.getElementById(`${goalId}-target-gain`);
            if (existing) existing.remove();
            const ind = document.createElement("span");
            ind.id = `${goalId}-target-gain`;
            ind.className = "gt-gain-indicator";
            ind.textContent = `+${delta.toFixed(2)}`;
            wrapEl.appendChild(ind);
            ind.addEventListener("animationend", () => ind.remove());
          }
        }
        prevRivalYouMap[goalId] = { quoteId: liveQid, value: sv, metric };
      }
    }

    // ── Filter display lines (mirror the requirement-goal req lines) ──
    // Line 1 (cyan): "Quote Pool: <Played?>, <Ranked|Unranked?>" → "All" if both open.
    const poolParts = [];
    if (gd.played === "played")        poolParts.push("Played");
    if (gd.status === "ranked")        poolParts.push("Ranked");
    else if (gd.status === "unranked") poolParts.push("Unranked");
    const poolEl = document.getElementById(`${goalId}-target-pool`);
    if (poolEl) {
      poolEl.textContent = `Quote Pool: ${poolParts.length ? poolParts.join(", ") : "All"}`;
      poolEl.style.display = "block";
    }

    // Line 2 (darker blue): "<lo> - <hi> LEN, <lo> - <hi> DIFF" — only the
    // constrained axes. Open lower = "≤hi", open upper = "lo+", matching the
    // requirement goals' "+ " convention. Hidden entirely when both are open.
    const bandParts = [];
    const lenStr  = gtFilterBand("Len",  gd.lenMin,  gd.lenMax,  gd.lenMin  == null, gd.lenMax  == null);
    const diffStr = gtFilterBand("Diff", gd.diffMin, gd.diffMax, gd.diffMin == null, gd.diffMax == null);
    if (lenStr)  bandParts.push(lenStr);
    if (diffStr) bandParts.push(diffStr);
    const bandEl = document.getElementById(`${goalId}-target-band`);
    if (bandEl) {
      bandEl.textContent = bandParts.join(" \u2022 ");
      bandEl.style.display = bandParts.length ? "block" : "none";
    }

    // ── Count sub-line: Quotes ≥ N METRIC: X / Y (filters shown above) ──
    const { hit, total, catalogSynced, selfDone } = computeTargetStanding(gd);
    const settled = catalogSynced && selfDone;
    // Combined catalog + self-store sync progress: one bar that only climbs.
    const syncPct = targetSyncPercent();
    const syncLbl = syncPct == null ? "syncing\u2026" : `syncing\u2026 (${syncPct}%)`;
    const countEl = document.getElementById(`${goalId}-target-count`);
    if (countEl) {
      const loadingCount = (total === 0 && !catalogSynced);
      if (goalCountView(gd) === "remaining") {
        // "Z to go" flips the comparator: the count of quotes still BELOW the
        // threshold (those left to conquer). Only this count line flips — the
        // value row (your-value / target) always stays X / Y.
        const z = loadingCount ? "\u2026" : `${(total - hit).toLocaleString()} to go`;
        countEl.textContent = `Quotes < ${target} ${metricLbl}: ${z}`;
      } else {
        const xy = loadingCount ? "\u2026" : `${hit.toLocaleString()} / ${total.toLocaleString()}`;
        countEl.textContent = `Quotes \u2265 ${target} ${metricLbl}: ${xy}`;
      }
    }
    // Build status on its own muted line below the count (hidden once settled).
    const syncEl = document.getElementById(`${goalId}-target-sync`);
    if (syncEl) {
      syncEl.textContent = settled ? "" : syncLbl;
      syncEl.style.display = settled ? "none" : "block";
    }

    // ── Next button ──
    const nextBtn = document.getElementById(`${goalId}-target-next`);
    if (nextBtn) {
      const remaining = total - hit;
      if (total === 0 && !settled) {
        nextBtn.textContent = "\u23ed Finding quotes\u2026";
        nextBtn.disabled = true;
      } else if (total > 0 && remaining <= 0) {
        nextBtn.textContent = "\u2713 All hit \ud83c\udf89";
        nextBtn.disabled = true;
      } else if (remaining <= 0) {
        nextBtn.textContent = "No quotes match filters";
        nextBtn.disabled = true;
      } else {
        nextBtn.textContent = "\u23ed Next quote";
        nextBtn.disabled = false;
      }
    }
  }

  // \u2500\u2500 Next-rank reset scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500────────────────
  // Runs in every tab (renderAllGoals runs everywhere), but only the
  // leader actually fires the reset. The Set prevents double-scheduling
  // across multiple renders while the timeout is pending.
  const scheduledNextRankResets = new Set();
  const NEXT_RANK_RESET_DELAY_MS = 5_000;

  function scheduleNextRankReset(goalId, type) {
    if (scheduledNextRankResets.has(goalId)) return;
    scheduledNextRankResets.add(goalId);

    setTimeout(async () => {
      scheduledNextRankResets.delete(goalId);
      if (!isLeader) return;

      // Sanity check: goal still exists and is still a next-rank goal
      const goals = goalData[type];
      const gd = goals?.find(g => g.id === goalId);
      if (!gd || !gd.nextRank) return;

      try {
        if (type === "pp") {
          // rank is already kept fresh by loadStats, so just run the update
          await inFlight(updateRankGoals)();
        } else if (type === "exp") {
          // expRank needs a refresh first (not in loadStats response)
          await updateExpRankTracking();
          await inFlight(updateExpRankGoals)();
        }
      } catch (err) {
        console.error("Next-rank reset failed:", err);
      }
    }, NEXT_RANK_RESET_DELAY_MS);
  }

  // ── Fetch user data (pure fetch, no side effects) ────────────
  async function fetchUserData() {
    // Only hit the unranked-quotes endpoint when an unranked/all goal
    // actually needs it — ranked goals are fully covered by quotesTyped.
    const needUnranked = quotesNeedUnrankedData();
    const [response, unrankedTyped] = await Promise.all([
      gtApiFetch(userEndpoint(), { headers: authHeaders() }, { lane: "urgent" }),
      needUnranked
        ? getUserQuotesTyped("unranked").catch(e => {
            console.error("Unranked-typed fetch failed:", e.message);
            return undefined; // leave currentStats.quotesUnranked untouched on failure
          })
        : Promise.resolve(undefined),
    ]);
    if (!response.ok) throw new Error(`User fetch failed: ${response.status}`);
    const data = await response.json();
    return {
      exp:            data.stats?.experience,
      pp:             data.stats?.totalPp,
      races:          data.stats?.races,
      quotes:         data.stats?.quotesTyped,
      quotesUnranked: unrankedTyped,
      playtime:       data.stats?.playTime,
      rank:           data.globalRank ?? null,
      chars:          data.stats?.completionCharactersTyped,
      quickplayRaces: data.stats?.quickplayRaces,
      soloRaces:      data.stats?.soloRaces,
    };
  }

  // ── Apply fetched user data to in-memory state + render ──────
  // Apply incoming stats data:
  //   - commitUserData updates currentStats only (no render, no eval)
  //   - applyUserData = commit + renderAllGoals + trigger req eval
  //
  // The split exists so the quote-finish flow can sequence things as:
  //   commit → await eval → render
  // …which collapses what would otherwise be two renders (one before eval
  // updates qualifyingProgress, one after) into a single render where all
  // gain indicators pop in the same animation frame. Without this, req-goal
  // indicators always appear ~1 microtask after non-req ones, which is
  // visible to the user as a slight stagger.
  //
  // Returns: prevRaces (the value of currentStats.races BEFORE the commit),
  // so callers can decide whether a races-based eval is needed.
  function commitUserData(data) {
    if (!data) return undefined;
    const gtPrevSnap = { ...currentStats }; // [GT log] pre-commit snapshot for the diff below
    const prevRaces = currentStats.races;
    currentStats.exp            = data.exp;
    currentStats.pp             = data.pp;
    currentStats.races          = data.races;
    currentStats.quotes         = data.quotes;
    // Only overwrite when this fetch actually retrieved an unranked count
    // (undefined = the fetch was skipped or failed — keep the prior value,
    // which may have been seeded at goal-creation time).
    if (data.quotesUnranked !== undefined) currentStats.quotesUnranked = data.quotesUnranked;
    currentStats.playtime       = data.playtime;
    currentStats.rank           = data.rank;
    currentStats.chars          = data.chars;
    currentStats.quickplayRaces = data.quickplayRaces;
    currentStats.soloRaces      = data.soloRaces;
    const gtDiff = gtStatsDiff(gtPrevSnap, currentStats,
      ["exp", "pp", "races", "quotes", "quotesUnranked", "playtime", "rank", "chars", "quickplayRaces", "soloRaces"]);
    if (Object.keys(gtDiff).length > 0) {
      gtLog("User stats changed", Object.keys(gtDiff).join(", "), gtDiff);
    }
    return prevRaces;
  }

  function applyUserData(data) {
    if (!data) return;
    const prevRaces = commitUserData(data);
    renderAllGoals();

    // Leader-only: when the lifetime races count changes, re-evaluate any
    // race goals that carry requirements. We trigger on ANY races-stat
    // change (not just increases) to also handle the initial-hydration
    // case where prevRaces was null and a goal's lastEvalRaces is behind.
    // The function self-gates further on whether any goal actually has
    // pending races to look at.
    //
    // Note: this is the "general" path (background polls, cross-tab, etc).
    // The quote-finish path bypasses applyUserData and uses commitUserData
    // + explicit eval-then-render to avoid a double-render stagger.
    if (isLeader && data.races != null && data.races !== prevRaces) {
      evaluateRaceRequirementsGuarded();
      evaluateImprovementGuarded();
    }
  }

  // ── Render all goal sections using in-memory state ───────────
  // Pure DOM updates — no fetch, safe to call from any tab.
  // ── Logged-out gate (render) ─────────────────────────────────
  // When logged out the extension can't do anything useful and every fetch
  // would 401, so we replace the goal UI with a single "please log in" panel
  // and let the fetch guards short-circuit all polling. Toggling one class on
  // the main widget (CSS hides .gt-content + .gt-header-actions and reveals the
  // panel); a body class hides any detached group widgets.
  function ensureLoginPanel() {
    if (document.getElementById("gt-login-panel")) return;
    const panel = document.createElement("div");
    panel.id = "gt-login-panel";
    panel.className = "gt-login-panel";
    panel.textContent = "Please log in to TypeGG to use Goal Tracker.";
    container.appendChild(panel); // sibling of .gt-content; shown only via the gt-loggedout class
  }
  // Apply the gate to the DOM and return true when logged out (caller should
  // then skip the rest of its render).
  function applyLoginGate() {
    const out = !isLoggedIn();
    if (out) ensureLoginPanel();
    container.classList.toggle("gt-loggedout", out);
    document.body.classList.toggle("gt-app-loggedout", out);
    return out;
  }

  // ── Max-chars goals (chars + target) ─────────────
  // Distinct-quote CHARACTER totals over the catalog -- the char-weighted
  // analog of Max quotes: total = Σ length of every quote in scope; typed =
  // Σ length of the ones you've raced (present in the self store). Lengths are
  // already in the catalog (`l`) so there's NO extra fetch -- it rides the
  // catalog driver and recomputes whenever the catalog or self store changes
  // (epoch-memoized, like computeTargetStanding).
  function maxCharsScopeOk(r, kind) {
    if (kind === "ranked")   return r !== false;
    if (kind === "unranked") return r === false;
    return true; // "all"
  }
  function tallyMaxChars(kind) {
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    let total = 0, typed = 0;
    for (const qid in quoteCatalog) {
      const m = quoteCatalog[qid];
      if (!maxCharsScopeOk(m.r, kind)) continue;
      const len = Number(m.l);
      if (!Number.isFinite(len) || len <= 0) continue;
      total += len;
      if (sq[qid]) typed += len;
    }
    return { typed, total };
  }
  function maxCharsReady() {
    return catalogFullySynced() && rivalBulkDone(loadRivalStore(RIVAL_SELF_NAME));
  }
  // Modal preview for the creation flow.
  function previewMaxChars(kind) {
    const { typed, total } = tallyMaxChars(kind);
    return { typed, total, ready: maxCharsReady() };
  }
  const maxCharsCache = new Map(); // goalId -> { catEpoch, selfEpoch, kind, typed, total }
  function computeMaxChars(gd) {
    const kind = gd.maxCharsKind || "all";
    const catEpoch = catalogEpoch, selfEpoch = rivalStoreEpoch;
    const c = maxCharsCache.get(gd.id);
    if (c && c.catEpoch === catEpoch && c.selfEpoch === selfEpoch && c.kind === kind) return c;
    const { typed, total } = tallyMaxChars(kind);
    const res = { catEpoch, selfEpoch, kind, typed, total };
    maxCharsCache.set(gd.id, res);
    return res;
  }
  // Render a quote-chars goal (the toggle's "Quote Chars" mode, non-max): gain
  // or custom target measured in DISTINCT-new-quote characters, sourced from the
  // catalog tally rather than the lifetime cumulative chars stat. Needs the
  // catalog + self-quote store synced; until then it shows "Syncing… (N%)" like
  // the max-chars goal. The distinct-quote baseline is locked lazily on the first
  // ready render (and any pending absolute target resolved against it), then the
  // goal delegates to updateGoalSection so it shares the exact same gain-row /
  // progress-bar / pill / count-view machinery as every other cumulative goal.
  function updateQuoteCharsGoalSection(goalId, type, cfg, gd, isRecurring) {
    const gainTextEl = document.getElementById(`${goalId}-gain-text`);
    const fillEl     = document.getElementById(`${goalId}-progress-fill`);
    if (!maxCharsReady()) {
      const labelEl = document.getElementById(`${goalId}-label`);
      if (labelEl) labelEl.textContent = "Quote Chars";
      const syncPct = targetSyncPercent();
      if (gainTextEl) gainTextEl.textContent = syncPct == null ? "Syncing\u2026" : `Syncing\u2026 (${syncPct}%)`;
      if (fillEl) { fillEl.style.width = `${syncPct == null ? 0 : syncPct}%`; fillEl.style.background = "#60a5fa"; }
      return;
    }
    // Catalog ready — lock the baseline (and resolve a pending absolute target)
    // once, persisting so it survives reloads.
    const scope = gd.quoteCharsScope || "all";
    const { typed } = tallyMaxChars(scope);
    if (gd.baselineQuoteChars == null) {
      const goals = goalData[type];
      const live  = goals && goals.find(g => g.id === goalId);
      if (live) {
        live.baselineQuoteChars = typed;
        if (live.quoteCharsAbsoluteTarget != null) {
          live.target = Math.max(1, live.quoteCharsAbsoluteTarget - typed);
          delete live.quoteCharsAbsoluteTarget;
        }
        saveGoals(type);
        gd = live;
      }
    }
    const baseline = gd.baselineQuoteChars || 0;
    const gain = Math.max(0, typed - baseline);

    // +N pop when distinct-quote chars climb; skip the first ready render
    // (prev == null) so the goal doesn't flash its whole accumulated gain.
    const prev = prevGainMap[goalId];
    let gainDelta = 0;
    if (prev != null && gain > prev) gainDelta = gain - prev;
    prevGainMap[goalId] = gain;

    // Sticky completion for recurring goals (mirrors the standard path).
    if (isRecurring && !gd.completedThisPeriod && gain >= gd.target) {
      const goals = goalData[type];
      const idx = goals ? goals.findIndex(g => g.id === goalId) : -1;
      if (idx >= 0) { goals[idx] = { ...goals[idx], completedThisPeriod: true }; saveGoals(type); gd = goals[idx]; }
    }

    updateGoalSection(goalId, type, cfg, gd, gain, isRecurring, gainDelta);
  }

  // Render a max-chars goal into the standard gain-row + progress-bar layout --
  // visually identical to a Max quotes goal, just chars instead of a count.
  function updateMaxCharsGoalSection(goalId, type, cfg, gd) {
    const bestRow   = document.getElementById(`${goalId}-avg-best-row`);
    const liveRow   = document.getElementById(`${goalId}-avg-live-row`);
    const bottomRow = document.getElementById(`${goalId}-avg-bottom-row`);
    if (bestRow)   bestRow.style.display   = "none";
    if (liveRow)   liveRow.style.display   = "none";
    if (bottomRow) bottomRow.style.display = "none";
    const gainRowEl = document.querySelector(`#${goalId}-goal-section .gt-gain-row`);
    const progBarEl = document.querySelector(`#${goalId}-goal-section .gt-progress-bar`);
    if (gainRowEl) gainRowEl.style.display = "";
    if (progBarEl) progBarEl.style.display = "";

    const kind   = gd.maxCharsKind || "all";
    const suffix = kind === "unranked" ? "max unranked" : kind === "all" ? "max all" : "max ranked";
    document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → ${suffix}`;

    const gainTextEl = document.getElementById(`${goalId}-gain-text`);
    const fillEl     = document.getElementById(`${goalId}-progress-fill`);
    const doneBadge  = document.getElementById(`${goalId}-done-badge`);

    let isComplete = false;
    if (!maxCharsReady()) {
      const syncPct = targetSyncPercent();
      if (gainTextEl) gainTextEl.textContent = syncPct == null ? "Syncing\u2026" : `Syncing\u2026 (${syncPct}%)`;
      if (fillEl) { fillEl.style.width = `${syncPct == null ? 0 : syncPct}%`; fillEl.style.background = "#60a5fa"; }
    } else {
      const { typed, total } = computeMaxChars(gd);
      const pct = total > 0 ? Math.min(Math.floor((typed / total) * 100), 100) : 0;
      isComplete = total > 0 && typed >= total;
      if (gainTextEl) gainTextEl.textContent = (goalCountView(gd) === "remaining")
        ? `${Math.round(total - typed).toLocaleString()} to go`
        : `${Math.round(typed).toLocaleString()} / ${Math.round(total).toLocaleString()}`;
      if (fillEl) { fillEl.style.width = `${pct}%`; fillEl.style.background = isComplete ? "#4ade80" : "#60a5fa"; }
      // Gain pill: +N pop when distinct-quote chars climb (a new in-scope quote
      // raced). Mirrors the Max-quotes indicator; reuses prevGainMap (cleared on
      // goal removal). Skip the first ready render (prev == null) so the goal
      // doesn't flash its whole total when it first settles.
      const prev = prevGainMap[goalId];
      if (prev != null && typed > prev) {
        const delta = Math.round(typed - prev);
        if (delta > 0) {
          const existing = document.getElementById(`${goalId}-gain-indicator`);
          if (existing) existing.remove();
          const indicator = document.createElement("span");
          indicator.id = `${goalId}-gain-indicator`;
          indicator.className = "gt-gain-indicator";
          indicator.textContent = `${goalCountView(gd) === "remaining" ? "−" : "+"}${delta.toLocaleString()}`;
          const gainRow = gainTextEl ? gainTextEl.parentElement : null;
          if (gainRow) gainRow.appendChild(indicator);
          indicator.addEventListener("animationend", () => indicator.remove());
        }
      }
      prevGainMap[goalId] = typed;
    }
    if (doneBadge) doneBadge.style.display = isComplete ? "inline" : "none";

    // Max goals aren't recurring -- keep the recurrence/streak/countdown hidden.
    const recBadge    = document.getElementById(`${goalId}-rec-badge`);
    const streakEl    = document.getElementById(`${goalId}-streak`);
    const countdownEl = document.getElementById(`${goalId}-countdown`);
    if (recBadge)    recBadge.style.display    = "none";
    if (streakEl)    streakEl.style.display    = "none";
    if (countdownEl) countdownEl.style.display = "none";
  }

  function renderAllGoals() {
    if (applyLoginGate()) return; // logged out → show panel, skip goal rendering
    const statValues = {
      exp:      currentStats.exp,
      pp:       currentStats.pp,
      races:    currentStats.races,
      quotes:   currentStats.quotes,
      playtime: currentStats.playtime,
      chars:    currentStats.chars,
    };
    const quickplayRaces = currentStats.quickplayRaces;
    const soloRaces      = currentStats.soloRaces;
    const typeOrder = ['exp', 'pp', 'races', 'improvement', 'quotes', 'playtime', 'chars', 'rival'];

    // Collect all active goal IDs for orphan removal
    const allActiveGoalIds = new Set();
    for (const type of typeOrder) {
      const goals = goalData[type];
      if (goals && goals.length > 0) {
        goals.forEach(g => allActiveGoalIds.add(g.id));
      }
    }

    // Remove orphaned sections (goals that were deleted)
    document.querySelectorAll(`[id$="-goal-section"]`).forEach(section => {
      const id = section.id.replace("-goal-section", "");
      if (!allActiveGoalIds.has(id)) section.remove();
    });

    // Process goals in type order
    for (const type of typeOrder) {
      // Rival goals are a comparison type with their own card layout and
      // data source (the per-user quote-best stores). Handle them entirely
      // in their own pass and skip the stat-delta machinery below.
      if (type === "rival") { renderRivalSections(); continue; }
      const cfg = GOAL_CONFIG[type];
      let currentVal = statValues[type];
      const goals = goalData[type];
      if (!goals || goals.length === 0) continue;

      for (let i = 0; i < goals.length; i++) {
        let gd = goals[i];
        const goalId = gd.id;

        // For races, use the appropriate stat based on filter
        if (type === "races" && gd.filter === "quickplay") {
          currentVal = quickplayRaces;
        } else if (type === "races" && gd.filter === "solo") {
          currentVal = soloRaces;
        } else if (type === "races") {
          currentVal = statValues[type];
        } else if (type === "improvement") {
          // Improvement has no cumulative stat — its progress is accumulatedGain
          // (computed below). Give a non-null currentVal so the stat-guard
          // doesn't skip the goal before its section is created.
          currentVal = currentStats.races ?? 0;
        }

        // For max-quotes goals, the "current" value depends on which quote
        // bucket the goal tracks. Ranked is the live quotesTyped stat;
        // unranked comes from currentStats.quotesUnranked; all is the sum.
        // (null until the unranked count has been fetched at least once —
        // the goal then just skips this tick via the guard below.)
        if (type === "quotes" && gd.maxQuotes) {
          const kind = maxQuotesKindOf(gd);
          if (kind === "unranked") {
            currentVal = currentStats.quotesUnranked;
          } else if (kind === "all") {
            currentVal = (currentStats.quotes != null && currentStats.quotesUnranked != null)
              ? currentStats.quotes + currentStats.quotesUnranked
              : null;
          } else {
            currentVal = currentStats.quotes; // ranked (and legacy)
          }
        }
        if (type === "chars" && (gd.maxChars || gd.quoteChars)) {
          currentVal = currentStats.chars ?? 0; // non-null so the goal reaches its section; value unused
        }

        // Skip if stat unavailable for this specific goal
        if (currentVal == null) continue;

        // Figure out which group this goal belongs to (migrates orphans
        // to the main group). Ordering within the widget is driven by
        // group.goalIds — NOT by type — since users can now reorder via drag.
        let gid = findGroupIdOfGoal(goalId);
        if (!gid) {
          groupData[MAIN_GROUP_ID].goalIds.push(goalId);
          saveGroups();
          gid = MAIN_GROUP_ID;
        }
        const targetContent = contentElForGroup(gid) || container.querySelector(".gt-content");

        // Create section if it doesn't exist
        let section = document.getElementById(`${goalId}-goal-section`);
        if (!section) {
          section = createGoalSection(goalId, type, cfg, targetContent);
        } else if (section.parentNode !== targetContent) {
          // Section exists but lives in the wrong widget (usually due to
          // a cross-tab group change). Exception: if this goal is the one
          // currently being dragged, its parentNode is document.body (it's
          // floating at the cursor). Reparenting it mid-drag pulls it back
          // into the source widget's stacking context, where — being inside
          // an element at z-index 9998 — it gets painted under any later-
          // DOM-order widget at the same z-index. Visible symptom: the
          // floating goal suddenly goes "behind" other widgets, and stays
          // that way until release re-detaches it.
          const isFloating = dragInProgress && gDrag?.goalId === goalId;
          if (!isFloating) targetContent.appendChild(section);
        }

        // NOTE: DOM ordering within the widget is NOT done here anymore.
        // It used to be a per-goal insertBefore() driven by this goal's
        // index in group.goalIds — but that index is into the FULL goalIds
        // array, while the live sibling list only contains the sections
        // created SO FAR. On a fresh page load, goals stream in over several
        // seconds as their async data resolves (rank @3s, exp-rank @6s,
        // max-quotes @12s, race-reqs @15s — see startLeaderIntervals). While
        // only a subset of sections exist, a global goalIds index maps to the
        // wrong slot in the partial sibling list, so late-arriving goals land
        // in the wrong position — visible as goals briefly swapping places
        // until every section finally exists. Ordering is now done in a single
        // whole-list pass (reconcileGoalOrder, called once below) that sorts
        // all PRESENT sections by their goalIds position at once — correct for
        // any subset, regardless of which goals have loaded yet.

        const isRecurring = !!(gd.recurrence && gd.recurrence !== "none");
        const hasReq = type === "races" && goalIsGated(gd);
        const isAvg  = type === "races" && goalIsAverage(gd);
        const isImprovement = goalIsImprovement(gd);
        const isTarget = goalIsImprovementTarget(gd);

        // Period reset check
        if (isRecurring) {
          const currentPeriodStart = getCurrentPeriodStart(gd.recurrence);
          if (currentPeriodStart > gd.periodStart) {
            const completed  = gd.completedThisPeriod;
            // prevTotal falls back through legacy shapes — see render logic
            // for the same pattern. Goals created before totalCompletions
            // existed get seeded from streak on their first completed rollover.
            const prevTotal  = gd.totalCompletions ?? gd.streak ?? 0;
            const nextStreak = completed ? gd.streak + 1 : 0;
            const nextTotal  = completed ? prevTotal + 1 : prevTotal;
            gd = { ...gd, [cfg.baselineKey]: currentVal, periodStart: currentPeriodStart,
                   streak: nextStreak, totalCompletions: nextTotal, completedThisPeriod: false };
            // Requirement goals: also reset the qualifying progress and
            // jump lastEvalRaces forward to the current count, so races
            // from the previous period don't leak into the new one.
            // For uniqueOnly goals: wipe the seen-quotes list too — the
            // user gets a fresh slate of quotes to qualify on next period.
            // NOTE: lastEvalRaces must be seeded from LIFETIME races
            // (currentStats.races), not from currentVal — currentVal is
            // the filtered counter for filter=quickplay/solo goals, which
            // would mismatch the evaluator's snapshot. Same bug, same fix
            // as the goal-creation path above.
            if (hasReq) {
              gd.qualifyingProgress = 0;
              gd.lastEvalRaces      = currentStats.races ?? currentVal;
              if (gd.uniqueOnly) gd.seenQuoteIds = [];
            }
            // Average goals: wipe the rolling window AND the bestAvg —
            // each period gets a fresh slate. lastEvalRaces jumps forward
            // for the same reason as gated goals (prevent old races from
            // leaking into the new period). Streak/totalCompletions handled
            // by the generic block above based on completedThisPeriod.
            // For uniqueOnly avg goals: also wipe windowQuoteIds in lockstep
            // (it must match windowRaces' state).
            if (isAvg) {
              gd.windowRaces  = [];
              gd.bestAvg      = null;
              gd.lastEvalRaces = currentStats.races ?? currentVal;
              if (gd.uniqueOnly) gd.windowQuoteIds = [];
              // Wipe the delta-tracker maps so the first race of the new
              // period doesn't compute a delta against last period's avg.
              delete prevAvgMap[goalId];
              delete prevBestMap[goalId];
            }
            // Improvement goals: zero the accumulated gain and clear the
            // per-quote baselines so each period measures improvement from
            // scratch. lastEvalRaces jumps forward like avg/gated goals.
            // Wipe prevGainMap so the new period's first +X indicator isn't
            // computed against last period's accumulated total.
            if (isImprovement) {
              gd.accumulatedGain = 0;
              gd.quoteBests      = {};
              gd.quoteAvgs       = {};
              gd.lastEvalRaces   = currentStats.races ?? currentVal;
              delete prevGainMap[goalId];
              // The wipe above leaves the quote the user is currently on
              // unseeded for the new period. Without a fresh seed, the first
              // finished race of the new period would be dropped (unseeded)
              // and lastEvalRaces would skip past it. Re-seed the live quote
              // now (fire-and-forget); onQuoteStarted refreshes lastSeedPromise
              // so the finish-eval can await it. No-ops if not on a quote /
              // not the racing tab (live id null).
              const liveQid = getCurrentQuoteIdLive();
              if (liveQid) onQuoteStarted(liveQid);
            }
            // Quote-chars goals re-lock their distinct-quote baseline each new
            // period: null it now and the next ready render captures the period-
            // start tally (so "gain N new-quote chars per week" resets cleanly).
            if (type === "chars" && gd.quoteChars && !gd.maxChars) {
              gd.baselineQuoteChars = null;
            }
            goals[i] = gd;
            saveGoals(type);
          }
        }

        // Improvement-Target goals (X/Y over the catalog) have their own
        // catalog-driven renderer and share no gain-delta machinery.
        if (isTarget) {
          updateTargetGoalSection(goalId, type, cfg, gd);
          continue;
        }
        if (type === "chars" && gd.maxChars) {
          updateMaxCharsGoalSection(goalId, type, cfg, gd);
          continue;
        }
        if (type === "chars" && gd.quoteChars) {
          updateQuoteCharsGoalSection(goalId, type, cfg, gd, isRecurring);
          continue;
        }

        // Average goals take a completely separate render path — they
        // don't have a "gain" in the cumulative sense, and their UI
        // (best vs target / current / threshold / window) doesn't share
        // any DOM with the gain-row + progress-bar layout.
        if (isAvg) {
          updateAverageGoalSection(goalId, type, cfg, gd, isRecurring);
          // Sticky achievement: once bestAvg ≥ targetAvg, mark complete.
          // For recurring goals, this drives the streak +1 at next rollover
          // and resets along with bestAvg/windowRaces. For non-recurring
          // goals, completedThisPeriod stays true forever (no rollover) —
          // matches "I did it" semantics.
          if (!gd.completedThisPeriod
              && gd.bestAvg != null && gd.bestAvg >= gd.targetAvg) {
            gd = { ...gd, completedThisPeriod: true };
            goals[i] = gd;
            saveGoals(type);
            // Re-render once with the newly-set flag so the ✓ pill shows
            // immediately rather than waiting for the next render tick.
            updateAverageGoalSection(goalId, type, cfg, gd, isRecurring);
          }
          continue;
        }

        // For requirement goals, ignore the lifetime-stat delta and use
        // qualifyingProgress instead. The evaluator (evaluateRaceRequirements)
        // is the only writer of qualifyingProgress; render is purely a reader here.
        // Improvement goals read accumulatedGain (also written by the evaluator).
        const gain = isImprovement
          ? (gd.accumulatedGain ?? 0)
          : hasReq
            ? (gd.qualifyingProgress ?? 0)
            : Math.max(0, currentVal - gd[cfg.baselineKey]);
        // Compute delta for the +X indicator. Skip on first render (prevGain == null).
        const prevGain = prevGainMap[goalId];
        let gainDelta = 0;
        if (prevGain != null) {
          if (gain > prevGain) {
            gainDelta = gain - prevGain;
          } else if (gain < prevGain && hasReq && gd.strictMode) {
            // Strict-mode reset — surface the drop with a negative indicator
            // so the user sees why their progress fell. (Improvement goals are
            // monotonic, so they never take this branch.)
            gainDelta = gain - prevGain; // negative
          }
        }
        prevGainMap[goalId] = gain;
        

        // Mark completed
        if (isRecurring && !gd.completedThisPeriod && gain >= gd.target) {
          gd = { ...gd, completedThisPeriod: true };
          goals[i] = gd;
          saveGoals(type);
        }

        updateGoalSection(goalId, type, cfg, gd, gain, isRecurring, gainDelta);
      }
    }
    // Sort every widget's goal sections into group.goalIds order in one
    // pass, now that all sections for this render have been created/updated.
    // This replaces the old per-goal insertBefore() and is robust while
    // goals are still streaming in during page load (see note in the loop).
    reconcileGoalOrder();

    // Re-evaluate which widgets currently host an avg goal and toggle
    // the .gt-widget-has-avg class accordingly. Cheap (loops over a
    // handful of groups), and putting it in renderAllGoals means every
    // mutation that triggers a render — goal add/remove, drag between
    // groups, period rollover — also updates the min-width gating
    // without each call site needing to remember to do it explicitly.
    updateAllWidgetAvgClasses();
  }

  // ── Whole-list DOM order reconciliation ──────────────────────
  // Order goal sections within each widget to match group.goalIds. Done as
  // a single sort over the sections that ACTUALLY EXIST in each container
  // (rather than per-goal insertBefore using a full-array index), so it is
  // correct no matter which subset of goals has loaded yet — that subset
  // independence is what kills the transient swap-on-refresh. Skipped during
  // a drag: the drag system owns DOM order while active (placeholder moves,
  // FLIP animations), and its mouseup commit already leaves the DOM matching
  // groupData, so there's nothing to fix once the drag ends.
  function reconcileGoalOrder() {
    if (dragInProgress) return;
    for (const [gid, group] of Object.entries(groupData)) {
      const content = contentElForGroup(gid);
      if (!content) continue;
      const order = group.goalIds;
      const sections = Array.from(content.children).filter(c =>
        c.id && c.id.endsWith("-goal-section")
      );
      if (sections.length < 2) continue;
      // Sort by position in goalIds; any id not tracked there sinks to the
      // end. Array.prototype.sort is stable, so untracked sections keep
      // their relative order.
      const sorted = sections.slice().sort((a, b) => {
        const ai = order.indexOf(a.id.replace("-goal-section", ""));
        const bi = order.indexOf(b.id.replace("-goal-section", ""));
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      });
      // Only touch the DOM if the order actually changed, to avoid needless
      // reflow on every render tick.
      let differs = false;
      for (let i = 0; i < sorted.length; i++) {
        if (sections[i] !== sorted[i]) { differs = true; break; }
      }
      if (differs) sorted.forEach(sec => content.appendChild(sec));
    }
  }

  // ── Stats + reset logic (leader only) ────────────────────────
  async function loadStats() {
    if (!isLoggedIn()) return; // logged out — don't fetch (avoids 401s)
    try {
      const data = await fetchUserData();
      applyUserData(data);
      // Share with other tabs so they render without fetching
      try {
        localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch {}
      channel?.postMessage({ type: 'stats', payload: data });
    } catch (err) { console.error(err); }
  }

  // ── Wrap loadStats so concurrent ticks can't stack up ─────────
  const loadStatsGuarded = inFlight(loadStats);

  // ── Self-resetting stats poll (replaces setInterval) ──────────
  // The poll exists as a fallback in case the quote-finish detector
  // misses an event. When the detector DOES catch a quote and freshly
  // updates the goal display, we call scheduleNextStatsPoll() to push
  // the next fallback fetch out to a full POLL_STATS_MS — no point
  // re-fetching seconds later when we just got fresh data.
  let statsPollTimer = null;
  function scheduleNextStatsPoll() {
    clearTimeout(statsPollTimer);
    statsPollTimer = setTimeout(() => {
      if (anyTabVisibleRecently()) loadStatsGuarded();
      scheduleNextStatsPoll(); // chain
    }, POLL_STATS_MS);
  }
  // Note: initial loadStats() + scheduleNextStatsPoll() kicked off in leader election block below

  // ── Quote-finish trigger ─────────────────────────
  // When the user finishes a quote (#typegame-input becomes disabled),
  // the TypeGG server takes anywhere from ~0.5s to ~16s to reflect the new
  // stats on the /users/{username} endpoint — and it reflects them
  // PIECEMEALLY: different fields (exp, races, chars, playtime, …) can land
  // seconds apart, in NO fixed order. So a single fetch — or a chain that
  // stops at the FIRST changed field — commits a partial race and strands the
  // late fields until the slow 20s fallback poll; goals tied to those fields
  // then lag ~20s and update out of sync. Instead we SAMPLE on a steady
  // cadence, committing each field as it lands, until the stats stop changing
  // (settle). No field is privileged, so the fix is order-agnostic.
  //
  // Follower tabs can't fetch (per the leader model), so they just
  // broadcast a 'quote-finished' message and let the leader handle it.
  //
  // Cadence: a quick first poll to catch an instant reflect, then a STEADY
  // short interval. Steady beats exponential backoff here because we're not
  // waiting for one event — we're tracking several fields landing across a
  // short window, which wants tight, even sampling. (Backoff's late 6–10s
  // gaps are exactly where a straggler field would hide.)
  const QF_FIRST_DELAY_MS      = 450;
  const QF_POLL_INTERVAL_MS    = 1000;
  const QF_MAX_ATTEMPTS        = 20;   // ~19.5s window; covers the server's observed ~16s worst-case reflect
  // "Settled" = this many consecutive polls with NO new field beyond what
  // we've already committed, AFTER at least one field has changed. The grace
  // guards against declaring victory in a lull between two fields landing.
  // If the landing-timeline logs show fields arriving >~2s apart, raise this.
  const QF_SETTLE_STABLE_POLLS = 2;
  // Fast path: the fields that move on EVERY completed race — the race
  // counter plus the aggregate exp/chars/playtime write (pp & quotes ride that
  // same write). Once all of these have landed the race is fully reflected, so
  // we reveal immediately instead of spending ~2 more polls confirming quiet.
  // The stable-poll settle above stays as the fallback for the rare race that
  // doesn't move the whole set (e.g. an abandoned run that still triggered
  // detection).
  const QF_EXPECT_FIELDS = ["races", "exp", "chars", "playtime"];

  let qfPending       = false; // another quote finished while we were retrying
  let qfWorkerRunning = false; // retry chain currently executing
  let qfFinishedQuoteId = null; // quoteId captured at the finish edge (before any
                                // "next vs rival" nav), so the post-race confirm
                                // targets the quote you actually completed.

  // ── Pending start-seed tracking ─────────────────────────────
  // Improvement baselines are seeded asynchronously at quote-START (see
  // seedImprovementForCurrentQuote). The finish-eval must NOT run before
  // that seed lands: an unseeded quote makes the evaluator silently drop
  // the finished race (`if (!st) continue`) while STILL advancing
  // lastEvalRaces past it — so the race is consumed and its gain is lost,
  // and a seed that arrives later (e.g. when a new goal forces a re-seed)
  // re-absorbs the whole climb as a single lump instead of incrementally.
  // We therefore record the latest start-seed promise and await it (bounded)
  // before evaluating. The start-seed reads history from BEFORE the in-
  // progress race, so awaiting it can't double-count the finishing race.
  let lastSeedPromise = null;
  const SEED_AWAIT_TIMEOUT_MS = 2500;
  function awaitPendingSeed(timeoutMs = SEED_AWAIT_TIMEOUT_MS) {
    if (!lastSeedPromise) return Promise.resolve();
    const p = lastSeedPromise;
    return Promise.race([
      Promise.resolve(p).catch(() => {}), // ignore seed errors; eval proceeds
      new Promise(r => setTimeout(r, timeoutMs)),
    ]);
  }

  // Run one retry chain: fetch up to N times, stop when stats change
  // ── TEMP timing probe — rival-card vs standard-goal update lag ──────────
  // Sync threshold: on a quote finish we hold the standard-goal render up to
  // this long so the rival card (which needs a separate /races fetch) can
  // appear in the SAME frame. Past it, the standard goals render immediately
  // and the rival card catches up on its own. Measured baseline: /races
  // ≈ 400ms (min ~370, max ~500), so 1s syncs in the normal case and the cap
  // only fires on a genuinely slow fetch (network blip / backoff).
  const RIVAL_SYNC_THRESHOLD_MS = 1000;

  // ── TEMP timing probe — rival fetch latency + sync outcome ──────────────
  // Per quote finish: how long the rival /races fetch+merge takes from the
  // moment it's kicked, whether that beat RIVAL_SYNC_THRESHOLD_MS (SYNCED,
  // rendered in one frame with the standard goals) or fell back to decoupled,
  // plus a running average / min / max / timeout count to spot outliers.
  // Logs under [GT-PERF]. TEMPORARY — search "gtPerf" / "GT-PERF" to remove.
  const gtPerf = {
    n: 0, sum: 0, min: Infinity, max: -Infinity, sumRaces: 0, timeouts: 0,
    // anchor: rival /races fetch just kicked; carry this iteration's stats-fetch time
    startRivalLag(statsFetchMs) { return { t0: performance.now(), statsFetchMs, done: false }; },
    // called once the rival /races fetch has resolved + merged
    endRivalLag(s, racesFetchMs, changed) {
      if (!s || s.done) return;
      s.done = true;
      const lag = performance.now() - s.t0;
      const synced = lag <= RIVAL_SYNC_THRESHOLD_MS;
      this.n++; this.sum += lag; this.sumRaces += racesFetchMs;
      if (!synced) this.timeouts++;
      if (lag < this.min) this.min = lag;
      if (lag > this.max) this.max = lag;
      console.log(
        `[GT-PERF] #${this.n}  rival ready +${lag.toFixed(0)}ms` +
        `  (stats fetch ${(s.statsFetchMs ?? 0).toFixed(0)}ms → races fetch ${racesFetchMs.toFixed(0)}ms,` +
        ` ${changed ? "new best" : "no new best"}) → ${synced ? "SYNCED" : "DECOUPLED (>threshold)"}` +
        `  |  avg ${(this.sum / this.n).toFixed(0)}ms  min ${this.min.toFixed(0)}  max ${this.max.toFixed(0)}` +
        `  timeouts ${this.timeouts}/${this.n}  n=${this.n}`
      );
    },
  };

  async function runQuoteFinishRetryChain() {
    // Core fields fetchUserData ALWAYS returns. quotesUnranked is a separate,
    // sometimes-skipped endpoint — commitUserData still persists it when
    // present, but it must NOT drive settle-detection (an undefined value
    // would read as a perpetual "change" and the chain would never settle).
    const FIELDS = ["races", "pp", "exp", "quotes", "chars", "playtime"];
    const snap = {
      races: currentStats.races, pp: currentStats.pp, exp: currentStats.exp,
      quotes: currentStats.quotes, chars: currentStats.chars, playtime: currentStats.playtime,
    };
    // Freeze the finished quote for THIS chain run (a finish that lands while
    // we're sampling re-runs the chain with its own id), so the per-quote
    // confirm stays consistent across every poll of this run.
    const finishedQuoteId = qfFinishedQuoteId;

    // Reset the 20s fallback timer up front so it can't fire mid-window and
    // race our own sampling (the chain owns stats polling for its window).
    // Re-armed again when we settle or hit the cap.
    scheduleNextStatsPoll();

    const chainT0 = performance.now();
    const landing = {};              // field → ms after finish when it FIRST appeared (instrumentation)
    let lastCommitted = { ...snap }; // what we've already pushed to the goals; diffed against, not `snap`
    let sawAnyChange = false;
    let stablePolls = 0;

    // ── Deferred single-frame reveal ────────────────────────
    // The server writes a race's fields seconds apart (see the landing
    // timeline logs), so committing each field's RENDER as it lands makes the
    // goal cards trickle out of sync. Instead we commit each field's STATE
    // silently (currentStats, cache, rival-store merges all stay current) and
    // defer the visible render to flushGoalRender() at settle — so every card
    // moves in one frame. Not "hold until all fields arrive" (which could wait
    // forever): we reveal when the stats go quiet, so a genuinely late
    // straggler still surfaces (next settle, or the 20s fallback) rather than
    // being held indefinitely.
    const pendingSelfWork = [];   // in-flight rival/self-store merges to let the reveal wait on
    let renderPending = false;    // committed state exists that hasn't been rendered yet
    let lastRenderData = null;    // newest full payload — broadcast to followers once, at reveal
    async function flushGoalRender() {
      if (!renderPending) return;
      // Briefly wait for any rival/self-store fetches so the one render shows
      // freshly-merged bests too. Bounded, so a slow fetch can't stall the reveal.
      if (pendingSelfWork.length) {
        await Promise.race([
          Promise.all(pendingSelfWork).catch(() => {}),
          new Promise(res => setTimeout(res, RIVAL_SYNC_THRESHOLD_MS)),
        ]);
      }
      renderAllGoals();
      // One stats broadcast (not one per poll) so follower tabs reveal in sync too.
      if (lastRenderData) channel?.postMessage({ type: 'stats', payload: lastRenderData });
      renderPending = false;
    }

    gtLog(
      "Post-race stats chain started",
      `quote ${finishedQuoteId ?? "(unknown)"} — sampling every ~${QF_POLL_INTERVAL_MS}ms until every field of the race is reflected (settle)`,
      { finishedQuoteId, statsSnapshotBeforeUpdate: { ...snap },
        cadence: { firstMs: QF_FIRST_DELAY_MS, intervalMs: QF_POLL_INTERVAL_MS, maxAttempts: QF_MAX_ATTEMPTS, settleStablePolls: QF_SETTLE_STABLE_POLLS } }
    );

    for (let i = 0; i < QF_MAX_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? QF_FIRST_DELAY_MS : QF_POLL_INTERVAL_MS));

      // Prefetch /races (and chained quotes) IN PARALLEL with the user-data
      // fetch, so the requirement/improvement eval finds warm caches and its
      // gain indicator pops alongside the non-req ones instead of ~1s later.
      // Only the leader prefetches (followers don't run the eval anyway).
      const reqPrefetch = isLeader
        ? (async () => { await prefetchRacesIfNeeded(); await prefetchQuotesIfNeeded(); })()
        : null;

      let data;
      const gtStatsT0 = performance.now(); // [GT-PERF]
      try { data = await fetchUserData(); }
      catch {
        gtLog("Post-race stats attempt", `#${i + 1}/${QF_MAX_ATTEMPTS} — user fetch FAILED (will retry)`);
        if (reqPrefetch) await reqPrefetch; // don't leak the promise
        continue;
      }
      const gtStatsFetchMs = performance.now() - gtStatsT0; // [GT-PERF] stats fetch latency

      // What's NEW since our LAST commit? Diffing against lastCommitted (not
      // the pre-race snap) means each field is detected once, when it first
      // lands — and keeps us immune to the fallback poll mutating currentStats
      // between awaits. Any non-empty diff = the race is still landing.
      const newDiff = gtStatsDiff(lastCommitted, data, FIELDS);
      const newFields = Object.keys(newDiff);
      const atMs = Math.round(performance.now() - chainT0);
      for (const f of newFields) if (!(f in landing)) landing[f] = atMs;

      // ── Nothing new this poll ────────────────────────────
      if (newFields.length === 0) {
        if (reqPrefetch) await reqPrefetch; // don't leak
        if (sawAnyChange) {
          stablePolls++;
          gtLog(
            "Post-race stats attempt",
            `#${i + 1}/${QF_MAX_ATTEMPTS} — +${atMs}ms: no new fields — stable ${stablePolls}/${QF_SETTLE_STABLE_POLLS}`,
            { attempt: i + 1, atMs, stablePolls }
          );
          if (stablePolls >= QF_SETTLE_STABLE_POLLS) {
            gtLog(
              "Post-race stats chain settled",
              `race fully reflected — field landing timeline (ms after finish): ${Object.entries(landing).map(([f, t]) => `${f}@${t}`).join(", ") || "(none)"}`,
              { finishedQuoteId, landingMs: landing, totalMs: atMs, attempts: i + 1 }
            );
            await flushGoalRender(); // reveal every goal card in one frame
            scheduleNextStatsPoll();
            return;
          }
        } else {
          gtLog(
            "Post-race stats attempt",
            `#${i + 1}/${QF_MAX_ATTEMPTS} — +${atMs}ms: server still stale (nothing reflected yet), waiting then retrying`,
            { attempt: i + 1, atMs }
          );
        }
        continue;
      }

      // ── New field(s) landed — commit them ───────────────────
      sawAnyChange = true;
      stablePolls = 0;
      gtLog(
        "Post-race stats attempt",
        `#${i + 1}/${QF_MAX_ATTEMPTS} — +${atMs}ms: new fields reflected [${newFields.join(", ")}] — committing + recalculating goals (logs below)`,
        { attempt: i + 1, atMs, statsFetchMs: Math.round(gtStatsFetchMs), newFields: newDiff }
      );

      // Wait for prefetch to land before applyUserData triggers the eval —
      // otherwise the eval might fire before the caches are warm and fall
      // back to sequential fetches (defeating the optimization).
      if (reqPrefetch) await reqPrefetch;

      // ── Commit this poll's fields (state only, NO render) ──────
      // Each poll commits whatever fields just landed and updates eval state,
      // but does NOT render — the visible reveal is deferred to flushGoalRender()
      // at settle so every card (incl. req/improvement gain indicators) moves in
      // ONE frame instead of trickling as the server dribbles fields out. Eval
      // runs with deferRender:true so it only updates qualifyingProgress here.
      const prevRaces = commitUserData(data);
      const racesChanged = isLeader && data.races != null && data.races !== prevRaces;
      const anyEvalGoals = (goalData.races || []).some(g => goalNeedsRaceList(g));
      const anyImprovement = (goalData.improvement || []).some(g => goalIsImprovement(g));
      if (racesChanged && (anyEvalGoals || anyImprovement)) {
        // If any improvement goal is present, make sure the just-finished
        // quote's pre-race baseline seed (kicked off at quote-start) has
        // landed first — otherwise the evaluator drops this race as
        // unseeded and the gain is lost / later lumped. Bounded so a hung
        // seed fetch can't stall the finish path.
        if (anyImprovement) {
          const gtSeedT0 = performance.now();
          await awaitPendingSeed();
          const gtSeedWaitMs = Math.round(performance.now() - gtSeedT0);
          if (gtSeedWaitMs > 50) {
            gtLog(
              "Waited for quote-start baseline seed",
              `${gtSeedWaitMs}ms before improvement eval${gtSeedWaitMs >= SEED_AWAIT_TIMEOUT_MS ? " — TIMED OUT (seed may not have landed; this race could be dropped as unseeded)" : ""}`,
              { waitedMs: gtSeedWaitMs, timeoutMs: SEED_AWAIT_TIMEOUT_MS }
            );
          }
        }
        try {
          if (anyEvalGoals)   await evaluateRaceRequirementsGuarded({ deferRender: true });
          if (anyImprovement) await evaluateImprovementGuarded({ deferRender: true });
        } catch (err) {
          console.error("[Goal Tracker] eval error in quote-finish path:", err);
        }
      }
      // ── Silent rival/self-store merge (render deferred to settle) ──
      // Fire the rival /races merge + per-quote PB confirm for this race, but
      // DON'T render — selfRender=false merges the store quietly. We collect the
      // promise so flushGoalRender() can wait briefly and show merged bests in
      // the single reveal. (gtPerf still logs the rival fetch lag internally.)
      if (racesChanged && ((goalData.rival || []).length > 0 || haveImprovementTargetGoals() || haveMaxCharsGoals())) {
        const gtPerfSession = gtPerf.startRivalLag(gtStatsFetchMs); // [GT-PERF] anchor: rival fetch kicked
        const maintainPromise = maintainSelfStoreFromRaces(gtPerfSession, false)
          .catch(e => { console.warn("[Goal Tracker] rival self-store maintenance failed:", e); return false; });
        const confirmPromise = confirmSelfQuoteAfterRace(finishedQuoteId).catch(() => false);
        pendingSelfWork.push(Promise.all([maintainPromise, confirmPromise]));
      }
      try {
        localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch {}
      // State committed silently. The visible render + the single follower
      // broadcast happen once, at settle, via flushGoalRender().
      renderPending = true;
      lastRenderData = data;

      // Fast path — the whole expected set is in, so the race is fully
      // reflected: reveal now rather than waiting ~2 polls to confirm quiet.
      // (pp/quotes committed this same poll ride the exp write, so they're in
      // the reveal too.)
      if (QF_EXPECT_FIELDS.every(f => f in landing)) {
        gtLog(
          "Post-race stats chain settled",
          `all expected fields in [${QF_EXPECT_FIELDS.join(", ")}] — revealing without waiting for quiet polls — landing timeline (ms after finish): ${Object.entries(landing).map(([f, t]) => `${f}@${t}`).join(", ")}`,
          { finishedQuoteId, landingMs: landing, totalMs: atMs, attempts: i + 1, via: "expected-complete" }
        );
        await flushGoalRender();
        scheduleNextStatsPoll();
        return;
      }

      // Record what we've now pushed to the goals, so the next poll only
      // reports genuinely-new fields (and we can tell when things settle).
      lastCommitted = {
        races: data.races, pp: data.pp, exp: data.exp,
        quotes: data.quotes, chars: data.chars, playtime: data.playtime,
      };
    }

    // Window exhausted without hitting the settle grace. Everything observed
    // IN-window was committed as it landed (never orphaned to the fallback);
    // only a field still unreflected after the whole window falls to the 20s
    // poll — rare, and no worse than a genuinely missed detection.
    gtLog(
      "Post-race stats chain window ended",
      sawAnyChange
        ? `committed every field that landed in-window; landing timeline (ms): ${Object.entries(landing).map(([f, t]) => `${f}@${t}`).join(", ")} — any later straggler goes to the 20s fallback poll`
        : "no stat change at all after the full window (unusual server lag?) — the 20s fallback poll will catch it",
      { finishedQuoteId, landingMs: landing, sawAnyChange }
    );
    await flushGoalRender(); // reveal whatever landed in-window, in one frame
    scheduleNextStatsPoll();
  }

  // Worker loop: coalesces rapid-fire quote-finishes into a single chain,
  // then re-runs the chain if another finish happened while we were busy.
  // This replaces the old hard 10s cooldown — the chain's ~20s duration
  // naturally rate-limits, without dropping legitimate back-to-back updates.
  async function qfWorker() {
    if (qfWorkerRunning) return;
    qfWorkerRunning = true;
    try {
      while (qfPending) {
        qfPending = false;
        await runQuoteFinishRetryChain();
      }
    } finally {
      qfWorkerRunning = false;
    }
  }

  function handleQuoteFinishAsLeader() {
    if (!isLoggedIn()) return; // logged out — don't start the stats retry chain
    // Freeze the just-finished quote NOW, at the disabled edge, before the user
    // can navigate (e.g. "next vs rival"). The chain uses this for an
    // authoritative per-quote PB confirm even if the live quote changes mid-chain.
    qfFinishedQuoteId = getCurrentQuoteIdLive() || qfFinishedQuoteId;
    qfPending = true;
    qfWorker(); // no-op if already running; picks up pending flag on loop
  }

  // Called in every tab (user could be typing on leader OR follower).
  function onQuoteFinished() {
    gtLog(
      "Quote finish detected",
      isLeader ? "leader tab — starting post-race stats chain" : "follower tab — notifying leader (goal recalculations run — and log — in the LEADER tab's console)",
      { role: isLeader ? "leader" : "follower", quoteId: getCurrentQuoteIdLive() }
    );
    if (isLeader) {
      handleQuoteFinishAsLeader();
    } else {
      channel?.postMessage({ type: 'quote-finished' });
    }
  }

  // ── Improvement-goal seeding (S1 baselines) ──────────────────
  // Improvement goals measure each race against the user's best on that
  // quote captured BEFORE the race. We therefore record that baseline at
  // quote-START, before the new race is absorbed by the API. Solo races
  // carry the quoteId in the URL (/solo/{id}); quickplay races expose it
  // via the "view in solo" link inside #typegame-view. The URL is the
  // primary source (rock-solid); the link is the quickplay fallback,
  // keyed on the href rather than brittle utility classes.
  function getCurrentQuoteIdLive() {
    const m = location.pathname.match(/^\/solo\/([^/?#]+)/);
    if (m) return m[1];
    const a = document.querySelector('#typegame-view a[href^="/solo/"]');
    if (a) {
      const hm = (a.getAttribute("href") || "").match(/\/solo\/([^/?#]+)/);
      if (hm) return hm[1];
    }
    return null;
  }

  // The user's best on a quote, via /v1/users/{username}/quotes/{quoteId}.
  // Returns { wpm, pp } from bestRace, or null when the user has never raced
  // the quote (404 "User has not raced this quote", or no bestRace). One
  // fetch serves both WPM- and PP-metric goals. In-flight dedupe keyed by
  // quoteId so multiple improvement goals seeding the same quote at once
  // share one request. No long-lived cache: once a quote is seeded into a
  // goal's quoteBests we never re-fetch it (the evaluator ratchets it).
  const userQuoteBestInFlight = new Map(); // quoteId → Promise<{wpm,pp}|null>
  async function fetchUserQuoteBest(quoteId) {
    const { username } = getAuth();
    if (!username) return null;
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}/quotes/${encodeURIComponent(quoteId)}`;
    const r = await gtApiFetch(url, { headers: authHeaders() });
    if (r.status === 404) return null;          // never raced this quote
    if (!r.ok) throw new Error(`user-quote ${quoteId} → ${r.status}`);
    const data = await r.json();
    const br = data?.bestRace;
    if (!br) return null;
    return { wpm: Number(br.wpm), pp: Number(br.pp) };
  }
  function getUserQuoteBest(quoteId) {
    if (userQuoteBestInFlight.has(quoteId)) return userQuoteBestInFlight.get(quoteId);
    const p = fetchUserQuoteBest(quoteId).finally(() => userQuoteBestInFlight.delete(quoteId));
    userQuoteBestInFlight.set(quoteId, p);
    return p;
  }

  // Full race history for a quote (newest-first), via
  // /v1/users/{username}/races?quoteId=… , paged at perPage 500. Used to seed
  // AVERAGE-track goals: all-time goals fold it into {sum,count}; rolling
  // goals keep the last n values. Returns [] if the user never raced the quote.
  // Fetching the whole history (rather than just the last n) lets one request
  // serve both all-time and rolling goals on the same quote; per-quote dedupe.
  const userQuoteRacesInFlight = new Map(); // quoteId → Promise<race[]>
  async function fetchUserQuoteRaces(quoteId) {
    const { username } = getAuth();
    if (!username) return [];
    const base = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}/races?quoteId=${encodeURIComponent(quoteId)}`;
    const out = [];
    let page = 1, totalPages = 1;
    do {
      const r = await gtApiFetch(`${base}&page=${page}&perPage=500`, { headers: authHeaders() });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`user-quote-races ${quoteId} → ${r.status}`);
      const d = await r.json();
      if (Array.isArray(d?.races)) out.push(...d.races);
      totalPages = d?.totalPages || 1;
      page++;
    } while (page <= totalPages);
    return out; // newest-first
  }
  function getUserQuoteRaces(quoteId) {
    if (userQuoteRacesInFlight.has(quoteId)) return userQuoteRacesInFlight.get(quoteId);
    const p = fetchUserQuoteRaces(quoteId).finally(() => userQuoteRacesInFlight.delete(quoteId));
    userQuoteRacesInFlight.set(quoteId, p);
    return p;
  }

  // Has this improvement goal already captured a baseline for this quote?
  // Best track stores it in quoteBests; average track in quoteAvgs.
  function goalHasQuoteSeed(g, quoteId) {
    const map = (g.improvementTrack === "average") ? g.quoteAvgs : g.quoteBests;
    return !!(map && quoteId in map);
  }

  // Seed the current quote's baseline into every improvement goal that
  // doesn't already have it. Runs in whichever tab is racing (the only one
  // that can read the live quoteId). The quickplay link can render a beat
  // after the start edge, so we retry the read for a few seconds — we have
  // the whole attempt duration before the race result lands. Per-quoteId
  // fetch dedupe + idempotent writes make overlapping calls safe.
  const SEED_RETRY_DELAYS_MS = [0, 250, 700, 1500, 3000];
  async function seedImprovementForCurrentQuote(knownQuoteId) {
    const goals = goalData.improvement;
    if (!goals || !goals.some(g => goalIsImprovement(g))) return;

    // The quote-change watcher already has the live id, so it passes it in
    // and we skip the read/retry. The input-edge trigger doesn't (and the
    // quickplay link can lag), so without a known id we retry the read for
    // a few seconds — we have the whole attempt before the result lands.
    let quoteId = knownQuoteId || null;
    if (!quoteId) {
      for (const d of SEED_RETRY_DELAYS_MS) {
        if (d) await new Promise(r => setTimeout(r, d));
        quoteId = getCurrentQuoteIdLive();
        if (quoteId) break;
      }
    }
    if (!quoteId) {
      // couldn't detect — this race won't count (pure S1)
      gtLog("Quote start — quoteId NOT detected", "no baseline seeded; this race won't count toward improvement goals");
      return;
    }

    // Goals still missing a baseline for this quote. (Already-seeded quotes
    // are left untouched — only the evaluator updates them.)
    const missing = goalData.improvement.filter(
      g => goalIsImprovement(g) && !goalHasQuoteSeed(g, quoteId)
    );
    if (missing.length === 0) return;

    const needBest = missing.some(g => g.improvementTrack !== "average");
    const needAvg  = missing.some(g => g.improvementTrack === "average");

    let best, races;
    try {
      [best, races] = await Promise.all([
        needBest ? getUserQuoteBest(quoteId)  : Promise.resolve(undefined), // {wpm,pp}|null
        needAvg  ? getUserQuoteRaces(quoteId) : Promise.resolve(undefined), // race[] (newest-first)
      ]);
    } catch (err) {
      console.warn("[Goal Tracker] improvement seed failed:", err);
      return;
    }

    let changed = false;
    const gtSeeded = []; // [GT log] what got seeded, per goal
    const arr = goalData.improvement;
    for (let i = 0; i < arr.length; i++) {
      const g = arr[i];
      if (!goalIsImprovement(g)) continue;
      if (goalHasQuoteSeed(g, quoteId)) continue;
      const metric = g.improvementMetric || "wpm";

      if (g.improvementTrack !== "average") {
        // ── Best track ──
        let baseline;
        if (best == null) {
          // Never raced this quote → no prior best.
          if (g.countFirstTime) baseline = 0;       // count first race from scratch
          else {
            gtSeeded.push({ goal: gtGoalTag(g, "improvement"), track: "best", metric, outcome: "NOT seeded — never raced this quote and countFirstTime is off (re-checked next quote start)" });
            continue;                               // don't seed; re-check next time
          }
        } else {
          baseline = Number(best[metric]);
          if (!isFinite(baseline)) baseline = 0;
        }
        arr[i] = { ...g, quoteBests: { ...(g.quoteBests || {}), [quoteId]: baseline } };
        gtSeeded.push({ goal: gtGoalTag(g, "improvement"), track: "best", metric, baseline });
        changed = true;
      } else {
        // ── Average track ── seed the rolling-window state from prior history.
        // The ongoing window is the most-recent W race values, but the BASELINE
        // is the PEAK rolling-W average ever seen on this quote (the best any
        // W-window has averaged), computed over the full history. So every
        // (re)seed — including each period reset of a recurring goal — measures
        // improvement above your best-ever sustained level, not your recent
        // level. That ratchets up across periods (history grows to include the
        // peaks you just set) and removes the "dip then re-earn" loophole.
        // Only races matching the goal's filter (all/solo/quickplay) count,
        // matching the evaluator. < W matching races → warm up (baseline null).
        const W = Math.max(2, g.improvementAvgWindow || 5);
        const chrono = (Array.isArray(races) ? races : [])
          .filter(r => raceMatchesFilter(r, g.filter))
          .map(r => Number(r[metric]))
          .filter(Number.isFinite)
          .reverse(); // API is newest-first → flip to oldest→newest
        let state;
        if (chrono.length >= W) {
          let sum = 0;
          for (let k = 0; k < W; k++) sum += chrono[k];
          let peakAvg = sum / W;                       // best W-window so far
          let peakEnd = W;                             // exclusive end index of that window
          for (let k = W; k < chrono.length; k++) {
            sum += chrono[k] - chrono[k - W];           // slide the window
            if (sum / W > peakAvg) { peakAvg = sum / W; peakEnd = k + 1; }
          }
          // peakWindow = the actual W scores that produced peakAvg (for logging /
          // display). Not read by the math — baseline/peak/window are unchanged.
          const peakWindow = chrono.slice(peakEnd - W, peakEnd);
          state = { window: chrono.slice(chrono.length - W), baseline: peakAvg, peak: 0, peakWindow };
        } else {
          state = { window: chrono.slice(), baseline: null, peak: 0 }; // warming up
        }
        arr[i] = { ...g, quoteAvgs: { ...(g.quoteAvgs || {}), [quoteId]: state } };
        gtSeeded.push({
          goal: gtGoalTag(g, "improvement"), track: "average", metric,
          windowSize: W,
          windowValues: state.window.slice(),
          priorMatchingRaces: chrono.length,
          baselinePeakAvg: state.baseline == null
            ? "(warming up — fewer prior races than the window)"
            : Math.round(state.baseline * 100) / 100,
          peakWindowScores: state.peakWindow || undefined, // the W scores that made the peak
          peakWindowCalc: state.peakWindow ? gtAvgCalc(state.peakWindow, state.baseline) : undefined,
          baselineNote: state.baseline == null
            ? undefined
            : `peak ${W}-race rolling average across ${chrono.length} prior matching races`,
        });
        changed = true;
      }
    }
    if (gtSeeded.length > 0) {
      gtLog("Improvement baselines seeded", `quote ${quoteId} — ${gtSeeded.length} goal(s)`, { quoteId, seeded: gtSeeded });
    }
    if (changed) saveGoals("improvement");
  }

  function onQuoteStarted(knownQuoteId, source) {
    const goals = goalData.improvement;
    if (!goals || !goals.some(g => goalIsImprovement(g))) return;
    // For the log only: when the trigger didn't pass an id (the input-edge
    // paths), try one live read — on a restart of the same quote the page
    // still shows the id, so the log can name it immediately. Seeding below
    // still does its own read WITH retries, so behaviour is unchanged.
    const gtLiveId = knownQuoteId || getCurrentQuoteIdLive();
    gtLog(
      "Quote start detected",
      `${source || "unknown trigger"} — ${gtLiveId ? `quote ${gtLiveId}` : "quoteId not readable yet (seeding retries for a few seconds)"}`,
      { source: source || null, quoteId: gtLiveId || null }
    );
    // Hold the promise so the quote-finish path can await this seed before
    // it evaluates the finished race (prevents the drop-then-lump bug).
    lastSeedPromise = seedImprovementForCurrentQuote(knownQuoteId);
  }

  // ── Input-disabled watcher ──────────────────────────────────
  // Runs in every tab. Watches #typegame-input for the
  // enabled→disabled transition that signals quote completion.
  (() => {
    let input          = null;
    let inputObserver  = null;
    let fired          = false;
    let wasDisabled    = null;

    function attach(newInput) {
      if (inputObserver) inputObserver.disconnect();
      input        = newInput;
      fired        = false;
      wasDisabled  = input.disabled;
      console.log('[Goal Tracker] attached to #typegame-input');

      inputObserver = new MutationObserver(() => {
        const isDisabled = input.disabled;
        // Quote finished: enabled → disabled transition
        if (!wasDisabled && isDisabled && !fired) {
          fired = true;
          onQuoteFinished();
        }
        // New quote started: reset the fire-once flag and seed the
        // improvement baseline for the freshly-loaded quote.
        if (wasDisabled && !isDisabled) {
          fired = false;
          onQuoteStarted(null, "typing input re-enabled (next quote or restart)");
        }
        wasDisabled = isDisabled;
      });
      inputObserver.observe(input, {
        attributes: true,
        attributeFilter: ['disabled'],
      });

      // If we attach mid-attempt — the session's first quote, or a refresh
      // while the input is already enabled — there's no disabled→enabled
      // edge to catch, so seed the current quote now. Otherwise that quote
      // would lack an S1 baseline and its race wouldn't count.
      if (!input.disabled) onQuoteStarted(null, "watcher attached mid-attempt");
    }

    function scan() {
      const found = document.querySelector('#typegame-input');
      if (found && found !== input) attach(found);
    }

    // Watch the DOM for the input element appearing/changing
    new MutationObserver(scan).observe(document.body, {
      childList: true,
      subtree:   true,
    });
    scan();
  })();

  // ── Quote-change watcher (quoteId-based) ────────────────────
  // The input-disabled watcher above catches the cases where the input
  // toggles: finishing a quote → next quote, and redoing a finished quote.
  // It MISSES the cases where the input stays put while the quote changes:
  //   • skipping an un-typed quote (input never goes disabled→enabled)
  //   • the first quote of a session (input goes absent→enabled, with no
  //     edge the observer reliably catches)
  // Both are unambiguous at the quoteId level: when the live quoteId
  // changes — or is seen for the first time — a new quote has started.
  // So we poll the live quoteId and fire onQuoteStarted on any change.
  // This runs ON TOP of the input watcher; seeding is idempotent (a quote
  // already in quoteBests is skipped), so overlapping triggers are safe.
  // We pass the id we just read straight through, so the seed skips its
  // own read/retry. Skipped while the tab is hidden (no racing happens in
  // a background tab, and the id can't change without interaction).
  (() => {
    let lastSeenQuoteId = null;
    function check() {
      if (document.hidden) return;
      const improvementGoals = goalData.improvement;
      const hasImprovement = improvementGoals && improvementGoals.some(g => goalIsImprovement(g));
      const hasRival = (goalData.rival || []).length > 0;
      const hasTarget = haveImprovementTargetGoals();
      // The PP-rebalance self-heal applies whenever a goal reads the PP cache
      // (rival / improvement-Target / max-chars), so widen the early-out to
      // include max-chars-only setups.
      const hasPpCacheConsumer = hasRival || hasTarget || haveMaxCharsGoals();
      if (!hasImprovement && !hasPpCacheConsumer) return; // cheap no-op when irrelevant
      const qid = getCurrentQuoteIdLive();
      if (!qid) return;
      // Run the rebalance check EVERY tick, not just on a quote change: a cold
      // start can fire before IDB hydration / the self bulk completes, and the
      // change edge would then be consumed (lastSeenQuoteId set) without a real
      // check ever happening for the quote you're sitting on. It's internally
      // gated and deduped per quote, so steady state is just a Set lookup.
      if (hasPpCacheConsumer) maybePpRebalanceRefetch(qid);
      if (qid !== lastSeenQuoteId) {
        lastSeenQuoteId = qid;
        if (hasImprovement) onQuoteStarted(qid, "live quoteId changed");
        // Rival + Target goals: the compare / current-value line tracks the
        // quote you're on, so a new quote means re-render (rival on-demand-
        // fetches the new quote's bests; target just reads the self store).
        if (hasRival || hasTarget) renderAllGoals();
      }
    }
    // 500ms latency is irrelevant — we have the whole attempt to seed.
    setInterval(check, 500);
    // Deferred a tick: the cold-start pass can re-render rival cards, whose
    // helpers are defined just below this IIFE — running it synchronously
    // here would hit their temporal dead zone. The seed latency is moot.
    setTimeout(check, 0); // immediate pass for the cold-start (first quote of the session)
  })();

  // ══════════════════════════════════════════════════════════════
  // ── RIVAL GOALS ───────────────────────────────────────────────
  // A rival goal compares your best WPM (or PP) against another player's,
  // per quote. The heavy lifting is two persisted "quote-best" stores —
  // one for you, one per rival — each a map { quoteId: { wpm, pp } } built
  // from /v1/users/{name}/quotes (paginated, bestRace per quote).
  //
  // Consistency model (given the API): TypeGG's "best race" is decided by PP,
  // and PP↑ ⟹ WPM↑, so a quote-best only changes when PP improves. We mirror
  // that exactly with a PP-keyed idempotent merge: an entry only supersedes
  // the stored one when its PP is strictly higher, and we carry that race's
  // WPM along with it. Idempotency is what makes the whole thing robust to
  // interruptions, overlapping fetches, and racing-while-fetching: re-merging
  // the same or an older entry is a no-op, so nothing is ever double-counted
  // or lost regardless of ordering.
  //
  //   • Initial build = bulk pagination with reverse=true (oldest-first), so
  //     a player improving quotes mid-fetch appends to the END rather than
  //     shifting unfetched rows past our page cursor. Resumable: the page
  //     cursor is persisted after every page, so a closed browser resumes
  //     exactly where it left off (re-fetching the in-progress page is safe).
  //   • Ongoing refresh = read page 1 in default (most-recent-PB-first) order
  //     and stop at the first quote whose PP we already have — because only
  //     improvements reorder the list, everything behind it is unchanged.
  //   • Your store additionally updates live on every quote-finish from the
  //     recent /races list (no dedicated fetch), so your side of the compare
  //     reflects a fresh PB immediately.
  //
  // Only the leader fetches; stores live in localStorage and propagate to
  // follower tabs via the 'rival-store' channel message + storage events.
  // ══════════════════════════════════════════════════════════════
  const RIVAL_SELF_NAME  = "__self__";
  const RIVAL_SELF_KEY   = "gt-rivalq-self";
  const RIVAL_KEY_PREFIX = "gt-rivalq-u-";
  const RIVAL_POLL_MS    = 60_000;   // ongoing refresh cadence (per the spec)
  const RIVAL_PAGE_SIZE  = 250;      // bulk-build page-size CAP / legacy-cursor
                                     // default. NOTE: server cost is SUPER-linear
                                     // in page size (measured: 50→~5s, 100→~35s,
                                     // 250→~120s), not linear as once assumed, so a
                                     // 250-row page reliably blows the 30s bulk cap.
                                     // The live size is now adaptive (rivalBulkPerPage);
                                     // this constant only caps it and seeds the cursor
                                     // rebase for stores whose cursor predates it.
  const RIVAL_REFRESH_PAGE_SIZE = 50;  // ongoing refresh: page the recently-raced
                                       // prefix. Halved from 100 — same endpoint, same
                                       // super-linear cost, so a large catch-up window
                                       // at 100 could also cross the cap.
  // Safety cap on the catch-up scan. In steady state the refresh stops within a
  // page (it halts at the first already-tracked quote whose completed-race count
  // is unchanged); this cap only bounds the one-time first scan of a store with
  // no per-quote race baseline yet, so a refresh can never runaway-scan history.
  const RIVAL_REFRESH_MAX_PAGES = 50;
  const RIVAL_PP_EPS     = 1e-6;
  // Pace consecutive bulk-build page fetches. A tight fetch loop over a
  // many-page store (perPage=1000) saturates the connection and is a prime
  // trigger for TypeGG's per-IP rate limiter — once tripped, requests come
  // back with no CORS header (surfacing as "Failed to fetch"), and the whole
  // account/IP gets throttled (even unrelated TypeGG tools slow down). A
  // short delay between pages keeps the build under the limiter.
  const RIVAL_PAGE_DELAY_MS = 1500;

  // ── Adaptive bulk page size ───────────────────────────────────────────
  // The /users/<name>/quotes endpoint is super-linear in page size (see
  // RIVAL_PAGE_SIZE), so a fixed large page reliably exceeds API_TIMEOUT_BULK_MS
  // (30s) and gets aborted+retried forever, while several small pages cover the
  // same quotes far faster AND always finish under the cap. So we self-tune: a
  // page that times out (or runs slow) HALVES the size; a fast page GROWS it by
  // aligning to what we've already covered, capped at a safe band. Aligning the
  // grow (rather than nudging) keeps the page boundary on the covered offset, so
  // changing size mid-build re-fetches ~nothing. Persisted across sessions.
  const RIVAL_PAGE_MIN      = 25;
  const RIVAL_PAGE_INIT     = 50;     // safe default from the measurements
  const RIVAL_PAGE_SLOW_MS  = 18000;  // a successful page this slow is near the cap → shrink
  const RIVAL_PAGE_FAST_MS  = 8000;   // a successful page this fast has headroom → grow
  const RIVAL_PAGE_SIZE_KEY = "gt-rival-bulk-pagesize";
  let rivalBulkPerPage = (() => {
    const n = parseInt(localStorage.getItem(RIVAL_PAGE_SIZE_KEY) || "", 10);
    return Number.isFinite(n) ? Math.min(RIVAL_PAGE_SIZE, Math.max(RIVAL_PAGE_MIN, n)) : RIVAL_PAGE_INIT;
  })();
  function setRivalBulkPerPage(n) {
    const clamped = Math.min(RIVAL_PAGE_SIZE, Math.max(RIVAL_PAGE_MIN, Math.round(n)));
    if (clamped === rivalBulkPerPage) return;
    const prev = rivalBulkPerPage;
    rivalBulkPerPage = clamped;
    try { localStorage.setItem(RIVAL_PAGE_SIZE_KEY, String(clamped)); } catch {}
    console.warn(`[Goal Tracker] bulk page size ${prev} → ${clamped} (adapting to server latency).`);
  }
  // Called after a SUCCESSFUL bulk page with its latency and the new covered
  // offset. A fast page GROWS the size by aligning it to what we've covered — the
  // largest aligned size is `covered` itself (next page = [covered, 2·covered),
  // zero re-read), capped at RIVAL_PAGE_SIZE. A slow page HALVES it. Aligning is
  // what keeps the boundary on the offset so a size change doesn't re-fetch a
  // prefix. (covered ≥ current size, so the max() never shrinks here.)
  function adaptBulkPageSizeOnSuccess(ms, covered) {
    if (ms < RIVAL_PAGE_FAST_MS)      setRivalBulkPerPage(Math.min(RIVAL_PAGE_SIZE, Math.max(rivalBulkPerPage, covered)));
    else if (ms > RIVAL_PAGE_SLOW_MS) setRivalBulkPerPage(rivalBulkPerPage * 0.5);
  }

  // (Backoff is now shared across ALL API calls via gtApiFetch / apiThrottled —
  // see the top of the file. Rival sync just consults apiThrottled() to avoid
  // spinning up work while paused; gtApiFetch handles escalation/reset.)

  // The self store is keyed by the logged-in username (gt-rivalq-self-<name>)
  // so a different account on the same browser can't inherit the previous
  // user's quote bests (which would mislabel wins). Reads getAuth() fresh, so a
  // re-login picks up the right key automatically. Falls back to the legacy
  // unscoped key only when logged out — nothing writes to it in that state.
  // Rival stores stay account-independent (keyed by the rival's username).
  function rivalStoreKey(name) {
    if (name === RIVAL_SELF_NAME) {
      const u = getAuth().username;
      return u ? `${RIVAL_SELF_KEY}-${String(u).toLowerCase()}` : RIVAL_SELF_KEY;
    }
    return `${RIVAL_KEY_PREFIX}${String(name).toLowerCase()}`;
  }

  // Parsed-store cache so renders don't re-parse JSON each frame. Reloaded
  // from disk when another tab changes a store (channel / storage event).
  const rivalStores = new Map(); // storeKey → { quotes, fetch }

  // Monotonic version bumped whenever ANY rival/self store changes. Used to
  // memoize computeRivalStandings (a full-store scan) so repeated renders
  // within one finish don't rescan thousands of quotes each time.
  let rivalStoreEpoch = 0;
  const rivalStandingsCache = new Map(); // goalId → { epoch, metric, result }
  // Narrower epoch bumped ONLY when a RIVAL's own store (or the shared quote
  // meta) changes — NOT when your self store changes. Setting a PB rewrites the
  // self store and bumps rivalStoreEpoch on every such race; caching the rival
  // composite against THIS epoch instead lets a self-only PB reuse the existing
  // composite and skip the full per-rival history re-scan (the PB-finish stutter).
  let rivalRivalsEpoch = 0;
  const rivalCompositeCache = new Map(); // "namesSig:metric" → { epoch, composite }

  // ── Quote catalog (the COMPLETE site quote set) ───────────────
  // Drop 2 (improvement Target mode) needs every quote's difficulty/length/
  // ranked, not just the ones seen via rival/self history. This is a SEPARATE
  // table from rivalQuoteMeta (which only covers quotes some store has seen):
  // the catalog is the full ~14k-quote universe, fetched once (status=any) and
  // delta-refreshed. Stored lean as qid → { d, l, r } (NO text). Built
  // leader-only and ONLY when at least one improvement-Target goal exists —
  // never fetch 14k quotes for users without one.
  let quoteCatalog = Object.create(null);   // qid → { d, l, r }
  // Persisted sync state (resume cursor + counts). phase: "idle"|"bulk"|"done".
  let quoteCatalogMeta = { totalCount: 0, totalPages: null, nextPage: 1, phase: "idle", lastFullSync: null, lastReconcile: null };
  let catalogReady = false;     // hydrated from IDB? (mirrors rivalIdbReady)
  let catalogBulkActive = false; // exactly one catalog driver runs at a time
  // Monotonic version bumped whenever the catalog changes — the render/eval
  // memo invalidator, mirroring rivalStoreEpoch.
  let catalogEpoch = 0;

  // ── IndexedDB persistence (replaces localStorage) ────────────
  // Rival/self stores live in IndexedDB now, not localStorage: a few rivals
  // could blow past localStorage's ~5 MB origin cap, while IDB has orders of
  // magnitude more room. The in-memory `rivalStores` Map stays the SYNCHRONOUS
  // source of truth for the (many, per-frame) reads — IDB is hydrated into it
  // once at startup (initRivalStorage) and writes update the Map synchronously
  // then persist to IDB asynchronously. Cross-tab propagation rides the existing
  // BroadcastChannel (localStorage's automatic `storage` event is gone for these
  // keys). All async; on IDB failure we degrade to in-memory-only for the
  // session (a warning, no crash) — the leader rebuilds from the API anyway.
  const RIVAL_IDB_NAME     = GT_NS + "gt-rival";
  const RIVAL_IDB_STORE    = "kv";
  const RIVAL_META_KEY     = "gt-rivalq-meta";          // shared quote-meta record
  const RIVAL_MIGRATED_KEY = "gt-rivalq-idb-migrated";  // one-time LS→IDB marker
  // Quote-catalog IDB records (same DB/store as the rival data — reuses idbGet/
  // idbPut). The catalog map and its sync/count meta are two separate records.
  const CATALOG_KEY        = "gt-quote-catalog";        // qid → { d, l, r }
  const CATALOG_META_KEY   = "gt-quote-catalog-meta";   // { totalCount, totalPages, nextPage, phase, lastFullSync, lastReconcile }
  const CATALOG_PAGE_SIZE  = 250;   // same as RIVAL_PAGE_SIZE — 1000 flakes server-side
  // Delta refresh pages newest-first until it reaches an already-stored quote.
  // This caps a pathological run (e.g. if the created-DESC sort assumption is
  // wrong); exceeding it forces a full re-sync. ~250×40 = 10k newest quotes.
  const CATALOG_DELTA_MAX_PAGES = 40;
  // Catalog reconcile (post-build maintenance): a cheap count-probe (site ranked
  // + unranked vs the live catalog) triggers a full re-page when existing quotes
  // were ranked-flipped or deleted -- changes the append-only delta can't see.
  // The probe is throttled by lastReconcile so a persistent mismatch can't loop;
  // a low-frequency unconditional sweep is the safety net for offsetting changes
  // (a flip + its opposite net the same counts, so the count-probe is blind to it).
  const RECONCILE_MIN_INTERVAL_MS = 60 * 60 * 1000;       // 1 h between triggered reconciles
  const RECONCILE_BACKSTOP_MS     = 24 * 60 * 60 * 1000;  // daily unconditional sweep (count-blind net)
  // Fallback slider bounds before the catalog has synced (the real axis is
  // derived from the catalog once present). Difficulty is a small float scale;
  // length is char count. Mirrors the rival axis fallbacks but catalog-scoped.
  const CATALOG_DIFF_MIN = 0, CATALOG_DIFF_MAX = 15;
  const CATALOG_LEN_MIN  = 0, CATALOG_LEN_MAX  = 1000;
  const CATALOG_LEN_ROUND = 50; // length axis ends floored/ceiled to this
  let rivalIdb = null;
  function idbOpen() {
    if (rivalIdb) return Promise.resolve(rivalIdb);
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(RIVAL_IDB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RIVAL_IDB_STORE)) db.createObjectStore(RIVAL_IDB_STORE);
      };
      req.onsuccess = () => { rivalIdb = req.result; resolve(rivalIdb); };
      req.onerror   = () => reject(req.error);
    });
  }
  function idbStore(mode) {
    return rivalIdb.transaction(RIVAL_IDB_STORE, mode).objectStore(RIVAL_IDB_STORE);
  }
  function idbGet(key) {
    return idbOpen().then(() => new Promise((res, rej) => {
      const r = idbStore("readonly").get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  }
  function idbGetAll() {
    return idbOpen().then(() => new Promise((res, rej) => {
      const out = [];
      const cur = idbStore("readonly").openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else res(out); };
      cur.onerror = () => rej(cur.error);
    }));
  }
  function idbPut(key, value) {
    return idbOpen().then(() => new Promise((res, rej) => {
      const r = idbStore("readwrite").put(value, key);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  }
  function idbDelete(key) {
    return idbOpen().then(() => new Promise((res, rej) => {
      const r = idbStore("readwrite").delete(key);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    }));
  }
  let rivalIdbReady = false; // hydration complete? fetch/write paths gate on this

  // ── Shared quote-meta table (storage trim) ───────────────────
  // difficulty (`d`) / length (`l`) / ranked (`r`) are QUOTE-level facts —
  // identical across every rival + self — so they're factored OUT of the
  // per-store entries (now just `{ wpm, pp }`) into ONE shared table keyed by
  // quoteId. Roughly halves per-store size and de-duplicates across rivals.
  // Persisted as the single RIVAL_META_KEY IDB record; never GC'd (tiny, and a
  // quote's meta is reusable by any store).
  let rivalQuoteMeta = Object.create(null); // qid → { d, l, r }
  let rivalMetaDirty = false;
  const EMPTY_META = Object.freeze({});
  function rivalMetaOf(qid) { return rivalQuoteMeta[qid] || EMPTY_META; }
  // Fill/refresh a quote's shared meta. Returns true iff something changed (so a
  // merge that only learned a ranked tag still triggers a save + standings
  // recompute, since scope filtering depends on it).
  function rivalMetaMerge(qid, ranked, d, l) {
    if (!qid) return false;
    let m = rivalQuoteMeta[qid];
    if (!m) { m = {}; rivalQuoteMeta[qid] = m; }
    let touched = false;
    if (typeof ranked === "boolean" && m.r !== ranked) { m.r = ranked; touched = true; }
    const dn = Number(d); if (Number.isFinite(dn) && m.d !== dn) { m.d = dn; touched = true; }
    const ln = Number(l); if (Number.isFinite(ln) && m.l !== ln) { m.l = ln; touched = true; }
    if (touched) rivalMetaDirty = true;
    return touched;
  }
  // Trim a fat (pre-trim) store in place: hoist each entry's d/l/r into the
  // shared meta table and reduce the entry to { wpm, pp }. Used by the LS→IDB
  // migration and tolerated again on any store that still carries fat entries.
  function trimStoreIntoMeta(store) {
    const q = store.quotes;
    for (const qid in q) {
      const e = q[qid];
      if (e == null) { delete q[qid]; continue; }
      // Self-heal phantom entries: drop only those with NEITHER a positive PP
      // nor a positive WPM (a DNF / null row). A valid unranked result has PP 0
      // but a real WPM, so it's kept -- gating on PP alone dropped all unranked.
      if (!((Number(e.pp) > 0) || (Number(e.wpm) > 0))) { delete q[qid]; continue; }
      if (e.r !== undefined || e.d !== undefined || e.l !== undefined) {
        rivalMetaMerge(qid, e.r, e.d, e.l);
        q[qid] = { wpm: e.wpm, pp: e.pp };
      }
    }
  }

  // Each store has ONE fetch stream (`fetch`) that bulk-builds EVERY quote in a
  // single pass via the API's `status=any` filter (ranked + unranked together).
  // Each /users/<name>/quotes row carries its own `quote.ranked` flag, so every
  // entry is tagged with `r` (true=ranked, false=unranked) as it merges and the
  // scope filter (all/ranked/unranked) is then a pure read-time concern — no
  // refetch on a scope change. A missing `r` is treated as ranked (legacy data,
  // until that store's one-time status=any re-bulk re-tags it).
  function freshRivalFetch() { return { phase: "bulk", nextPage: 1, totalPages: null, syncBurst: true, covered: 0 }; }
  // Store meta version.
  //   v1: per-entry difficulty/length (`d`/`l`) capture.
  //   v2: single status=any build (ranked + unranked + `r` in one stream).
  // A store below the current version gets a one-time re-bulk (backfillMeta-
  // IfNeeded) under status=any, which captures everything v2 needs at once.
  const RIVAL_META_V = 3;
  function freshRivalStore() {
    return { quotes: {}, raceCounts: {}, fetch: freshRivalFetch(), metaV: RIVAL_META_V, lastSync: null };
  }
  // Re-bulk ONCE under status=any when a store predates the current schema:
  //  - v1 stores were ranked-only (or two ranked/unranked streams).
  //  - v2 stores DID page status=any, but the old rivalMergeEntry rejected every
  //    pp<=0 row, so unranked results (0 PP) never made it in -- v3 re-bulks them
  //    under the fixed merge guard.
  // Existing quotes stay (merges are idempotent); the user just sees the normal
  // "syncing…" state until the re-bulk finishes, after which metaV is stamped
  // current and this never fires again.
  function backfillMetaIfNeeded(store) {
    if (store.metaV === RIVAL_META_V) return;
    store.fetch = freshRivalFetch(); // re-page from the start under status=any
    delete store.fetchU;             // obsolete two-stream cursor
    // Mark the store as on the v2 (status=any) model NOW, not on completion, so
    // the freshly-reset cursor isn't reset again next session — an interrupted
    // re-bulk then resumes from its persisted page instead of restarting. The
    // store still reports "syncing…" until fetch.phase === "done" (rivalBulkDone
    // checks the phase, not metaV), so an incomplete re-bulk is never "done".
    store.metaV = RIVAL_META_V;
  }
  // Legacy unscoped-self adoption, IDB era. The self store used to live at the
  // unscoped `gt-rivalq-self`; it's now keyed by username. Post-hydration, on
  // the first self load as a logged-in user, if the scoped store is absent in
  // the cache but the legacy one is present, adopt it (cache + IDB) so the user
  // keeps their built store. Cache-based + sync; retried (flag stays false)
  // until both hydration and login have happened.
  let selfStoreMigrated = false;
  function adoptLegacySelfFromCache() {
    if (selfStoreMigrated) return;
    if (!rivalIdbReady) return;           // wait until the cache is hydrated
    const u = getAuth().username;
    if (!u) return;                       // can't scope yet — retry once logged in
    selfStoreMigrated = true;
    const scopedKey = rivalStoreKey(RIVAL_SELF_NAME);
    if (rivalStores.has(scopedKey)) return; // already have the scoped store
    const legacy = rivalStores.get(RIVAL_SELF_KEY);
    if (!legacy) return;                  // nothing to adopt
    rivalStores.set(scopedKey, legacy);
    rivalStores.delete(RIVAL_SELF_KEY);
    idbPut(scopedKey, legacy).catch(() => {});
    idbDelete(RIVAL_SELF_KEY).catch(() => {});
  }
  // Synchronous read against the in-memory cache (hydrated from IDB at startup).
  // A cache miss BEFORE hydration completes means "not loaded yet" → return a
  // transient empty store WITHOUT caching, so hydration's real data isn't
  // shadowed by a placeholder (all fetch/write paths gate on rivalIdbReady, so
  // nothing mutates the transient). After hydration a miss is a genuinely new
  // store and is cached.
  function loadRivalStore(name) {
    if (name === RIVAL_SELF_NAME) adoptLegacySelfFromCache();
    const key = rivalStoreKey(name);
    if (rivalStores.has(key)) return rivalStores.get(key);
    const fresh = freshRivalStore();
    if (rivalIdbReady) rivalStores.set(key, fresh);
    return fresh;
  }
  // Update the in-memory store synchronously (already done by the caller), then
  // persist to IDB and broadcast AFTER the write commits so followers reload
  // fresh. Flushes the shared meta table in the same chain when it's dirty.
  function saveRivalStore(name, { broadcast = true } = {}) {
    const key = rivalStoreKey(name);
    const store = rivalStores.get(key);
    if (!store) return;
    rivalStoreEpoch++; // invalidate standings cache
    const flushMeta = rivalMetaDirty;
    if (flushMeta) rivalMetaDirty = false;
    // A self-only PB (name === self, no meta flush) must NOT invalidate the
    // rival composite — it never reads the self store. Only a rival's store or a
    // shared-meta change (which carries r/d/l used by the composite) does.
    if (name !== RIVAL_SELF_NAME || flushMeta) rivalRivalsEpoch++;
    const metaSnapshot = rivalQuoteMeta; // live ref — persists the latest state
    idbPut(key, store)
      .then(() => flushMeta ? idbPut(RIVAL_META_KEY, metaSnapshot) : null)
      .then(() => {
        if (!broadcast) return;
        channel?.postMessage({ type: "rival-store", storeKey: key });
        if (flushMeta) channel?.postMessage({ type: "rival-meta" });
      })
      .catch(e => console.warn("[Goal Tracker] rival store IDB save failed:", e));
  }
  // Cross-tab: a follower reloads one store (or, when the leader GC'd it, drops
  // it) from IDB and re-renders. Async (IDB), so it renders on completion rather
  // than relying on a caller's render.
  function reloadRivalStoreFromDisk(key) {
    idbGet(key).then(parsed => {
      if (parsed && typeof parsed === "object" && typeof parsed.quotes === "object") {
        if (!parsed.fetch) parsed.fetch = freshRivalFetch();
        rivalStores.set(key, parsed);
      } else {
        rivalStores.delete(key); // leader deleted it (GC)
      }
      rivalStoreEpoch++;
      if (key.startsWith(RIVAL_KEY_PREFIX)) rivalRivalsEpoch++; // a rival's store, not self's
      renderAllGoals();
    }).catch(() => {});
  }
  function reloadRivalMetaFromDisk() {
    idbGet(RIVAL_META_KEY).then(m => {
      if (m && typeof m === "object") { rivalQuoteMeta = m; rivalStoreEpoch++; rivalRivalsEpoch++; renderAllGoals(); }
    }).catch(() => {});
  }
  // One-time localStorage → IndexedDB migration (cross-tab idempotent via the
  // IDB marker). Trims each store into the shared meta table on the way in, then
  // clears the localStorage keys to reclaim that space. A per-key IDB-write
  // failure leaves that localStorage key in place to retry next run.
  async function migrateLocalStorageToIdb() {
    let done = false;
    try { done = await idbGet(RIVAL_MIGRATED_KEY); } catch {}
    if (done) return;
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(RIVAL_SELF_KEY) || k.startsWith(RIVAL_KEY_PREFIX))) keys.push(k);
      }
    } catch {}
    for (const k of keys) {
      let store = null;
      try { store = JSON.parse(localStorage.getItem(k) || "null"); } catch {}
      if (store && typeof store === "object" && typeof store.quotes === "object") {
        if (!store.fetch) store.fetch = freshRivalFetch();
        trimStoreIntoMeta(store); // hoist d/l/r → shared meta; entries → { wpm, pp }
        try { await idbPut(k, store); }
        catch (e) { console.warn("[Goal Tracker] rival store migration failed (kept in localStorage):", k, e); continue; }
      }
      try { localStorage.removeItem(k); } catch {}
    }
    try { await idbPut(RIVAL_META_KEY, rivalQuoteMeta); } catch {}
    try { await idbPut(RIVAL_MIGRATED_KEY, true); } catch {}
  }
  // Hydrate the in-memory cache from IDB once at startup (every tab), running the
  // one-time LS→IDB migration first. Until this completes, reads return empty
  // and all fetch/write paths are gated (rivalIdbReady), so the leader never
  // re-bulks over data that's merely "not loaded yet". On completion we enable
  // sync, invalidate any standings computed on empty stores, and re-render.
  async function initRivalStorage() {
    try {
      await idbOpen();
      await migrateLocalStorageToIdb();
      const all = await idbGetAll();
      for (const { key, value } of all) {
        if (key === RIVAL_META_KEY) { if (value && typeof value === "object") rivalQuoteMeta = value; continue; }
        if (key === RIVAL_MIGRATED_KEY) continue;
        if (key === CATALOG_KEY) { if (value && typeof value === "object") quoteCatalog = value; continue; }
        if (key === CATALOG_META_KEY) {
          if (value && typeof value === "object") {
            quoteCatalogMeta = {
              totalCount:  Number(value.totalCount) || 0,
              totalPages:  (value.totalPages == null) ? null : Number(value.totalPages),
              nextPage:    Number(value.nextPage) || 1,
              phase:       (value.phase === "bulk" || value.phase === "done") ? value.phase : "idle",
              lastFullSync: value.lastFullSync || null,
              lastReconcile: value.lastReconcile || null,
            };
          }
          continue;
        }
        if (value && typeof value === "object" && typeof value.quotes === "object") {
          if (!value.fetch) value.fetch = freshRivalFetch();
          trimStoreIntoMeta(value);    // tolerate any still-fat entries
          backfillMetaIfNeeded(value); // pre-v2 stores: one-time status=any re-bulk
          rivalStores.set(key, value);
        }
      }
    } catch (e) {
      console.warn("[Goal Tracker] IndexedDB unavailable — rival data won't persist this session:", e);
    } finally {
      rivalIdbReady = true;
      catalogReady = true;       // catalog hydrated from IDB (empty map if none)
      rivalStoreEpoch++;
      rivalRivalsEpoch++;        // rival stores just hydrated from IDB — composite cache is stale
      catalogEpoch++;            // a render computed on an empty catalog is stale now
      renderAllGoals();
      if (isLeader) { ensureRivalSync(); maybeRunQuoteCatalog(); }
    }
  }
  // ── Scope (all / ranked / unranked) ──────────────────────────
  // A single global preference (Settings → Rival, also surfaced in the add-goal
  // modal) decides which of the rival's quotes count toward every rival goal.
  function rivalScope(rs) {
    const s = (rs || rivalSettings).scope;
    return (s === "ranked" || s === "unranked" || s === "all") ? s : "all";
  }
  // Comparison metric for a rival goal — a PER-GOAL setting (gd.rivalSettings).
  function rivalMetric(rs) {
    return (rs || rivalSettings).metric === "pp" ? "pp" : "wpm";
  }
  // Whether a rival quote falls inside the active scope. A missing `r` flag is
  // legacy data, which was ranked-only, so it counts as ranked.
  function rivalQuoteInScope(entry, scope) {
    if (scope === "ranked")   return entry.r !== false;
    if (scope === "unranked") return entry.r === false;
    return true; // all
  }
  // "Fully synced": the single status=any bulk stream has finished. Scope no
  // longer affects what's fetched (everything is fetched once and tagged), so
  // this is just whether that one stream is done. Drives the card's "syncing…"
  // hint and the settled/loading logic.
  function rivalBulkDone(store) {
    return !!(store && store.fetch && store.fetch.phase === "done");
  }

  // ── Sync-burst progress (shared by the rival + target sync bars) ─────────
  // A "sync burst" is a maximal stretch during which >=1 leg (a rival/self
  // store, or the quote catalog) is paging. Each leg carries a persisted
  // `syncBurst` flag: set true when its bulk (re)starts (freshRivalFetch /
  // the catalog bulk start), and cleared for EVERY leg once the whole burst
  // ends (clearSyncBurstIfEnded, called as each leg finishes). The bar then
  // counts only the legs IN the burst — pending ones, plus ones that finished
  // during it (so it never drops when one leg completes ahead of another) —
  // and excludes legs already done BEFORE the burst began (so it starts at
  // 0%, not at their page share). All state is persisted, so a reload mid-
  // sync resumes at the same %.
  function anySyncLegPending() {
    if (!catalogFullySynced()) return true; // catalog (re)building counts as pending
    if (!rivalBulkDone(loadRivalStore(RIVAL_SELF_NAME))) return true;
    for (const name of rivalManaged.keys()) {
      if (name === RIVAL_SELF_NAME) continue;
      if (!rivalBulkDone(loadRivalStore(name))) return true;
    }
    return false;
  }
  // Called as each leg finishes. Once nothing anywhere is still paging the
  // burst is over, so drop every leg's membership — the next burst then
  // starts from a clean slate (and at 0%). No-op while any leg is pending.
  function clearSyncBurstIfEnded() {
    if (anySyncLegPending()) return;
    if (quoteCatalogMeta.syncBurst) { quoteCatalogMeta.syncBurst = false; saveQuoteCatalog({ broadcast: false }); }
    for (const name of new Set([RIVAL_SELF_NAME, ...rivalManaged.keys()])) {
      const s = loadRivalStore(name);
      if (s.fetch && s.fetch.syncBurst) { s.fetch.syncBurst = false; saveRivalStore(name, { broadcast: false }); }
    }
  }
  // Combined 0..99 across a set of legs, scoped to the current burst. Each
  // leg: { pending, inBurst, totalPages, nextPage }. A leg counts iff it's
  // pending OR finished-this-burst (inBurst); a pending leg contributes its
  // fetched pages (from 0), a finished one its full span. 0 while a counted
  // leg's page count isn't known yet; null when nothing of the burst is still
  // pending (settled — the caller hides the line anyway).
  function syncBurstPercentFromLegs(legs) {
    let donePages = 0, totalPages = 0, known = false, anyPending = false;
    for (const lg of legs) {
      const pending = !!lg.pending;
      if (!pending && !lg.inBurst) continue;   // done before this burst -> excluded
      if (pending) anyPending = true;
      const tp = Number(lg.totalPages);
      if (Number.isFinite(tp) && tp > 0) {
        known = true;
        totalPages += tp;
        donePages += pending ? Math.max(0, Math.min(tp, (Number(lg.nextPage) || 1) - 1)) : tp;
      }
    }
    if (!anyPending) return null;            // nothing of this burst still pending
    if (!known || totalPages <= 0) return 0; // syncing, page counts not known yet -> 0%
    return Math.max(0, Math.min(99, Math.floor((donePages / totalPages) * 100)));
  }

  // Rival card bar: self + this goal's rival store(s). Self is counted only
  // when it's part of the current burst — already-synced-self (the common
  // case when a rival goal is added) is excluded, so the bar starts at 0% and
  // tracks the rival fetch; when self ALSO needs (re)building (initial sync,
  // PP rebalance) it's included so both legs sum into one 0->100 bar. The
  // card settles on rivalDone AND selfDone separately, so a self-excluded bar
  // can't read "done" while self is still paging.
  function rivalSyncPercent(gd) {
    const names = goalRivalNames(gd);
    if (!names.length) return null;
    const legs = [RIVAL_SELF_NAME, ...names].map(n => {
      const f = loadRivalStore(n).fetch || {};
      return { pending: f.phase !== "done", inBurst: !!f.syncBurst, totalPages: f.totalPages, nextPage: f.nextPage };
    });
    return syncBurstPercentFromLegs(legs);
  }

  // PP-keyed idempotent merge. Returns true iff anything changed (store entry OR
  // shared quote-meta). The per-store entry is just `{ wpm, pp }`; the quote's
  // ranked/difficulty/length go to the shared meta table (identical across all
  // stores). The ranked tag is applied even when PP didn't improve, so a quote
  // first seen untagged (on-demand fill) or mis-tagged is corrected the moment
  // its authoritative stream delivers it.
  function rivalMergeEntry(store, quoteId, wpm, pp, ranked, d, l) {
    if (!quoteId) return false;
    const p = Number(pp);
    const w = Number(wpm);
    // A real completion is either a ranked result (PP > 0) or an UNRANKED result
    // (ranked === false) with a real WPM. Unranked quotes award 0 PP, so gating
    // on PP alone wrongly dropped every unranked result (cause of "0 unranked
    // chars typed"). Ranked / untagged rows still require PP > 0 -- that keeps
    // the phantom DNF / null-pp guard (a DNF coerces to pp 0 via Number(null)).
    const realRanked   = Number.isFinite(p) && p > 0;
    const realUnranked = ranked === false && Number.isFinite(w) && w > 0;
    if (!(realRanked || realUnranked)) return false;
    const metaTouched = rivalMetaMerge(quoteId, ranked, d, l);
    const cur = store.quotes[quoteId];
    // Ranked entries ratchet their best on PP; unranked (PP always 0) on WPM.
    if (cur) {
      const better = realRanked ? (p > cur.pp + RIVAL_PP_EPS) : (w > (cur.wpm || 0));
      if (!better) return metaTouched; // no improvement; entry unchanged
    }
    store.quotes[quoteId] = { wpm: Number.isFinite(w) ? w : (cur ? cur.wpm : 0), pp: realRanked ? p : 0 };
    return true;
  }
  function entryFromQuoteRecord(q) {
    const br = q?.bestRace;
    if (!br || !br.quoteId) return null;
    const qq = q.quote || null; // /users/<u>/quotes rows nest the quote meta under .quote
    const d = qq ? Number(qq.difficulty) : NaN;
    const l = qq ? Number(qq.length)     : NaN;
    // status=any rows carry the quote's ranked flag; capture it so scope
    // filtering needs no separate stream. Undefined when absent (e.g. a /races
    // row) → treated as ranked downstream until the bulk re-tags it.
    const r = (qq && typeof qq.ranked === "boolean") ? qq.ranked : undefined;
    // Top-level `races` is the USER's completed-race count on this quote (not
    // q.quote.races, the quote's global total). The incremental refresh uses it
    // as the "raced since last scan?" signal and stop key.
    const races = Number(q?.races);
    return {
      quoteId: br.quoteId, wpm: Number(br.wpm), pp: Number(br.pp),
      d: Number.isFinite(d) ? d : undefined,
      l: Number.isFinite(l) ? l : undefined,
      r,
      races: Number.isFinite(races) ? races : undefined,
    };
  }

  // ── Fetching ────────────────────────────────────────────────
  async function fetchRivalQuotesPage(fetchName, { page, reverse, perPage = RIVAL_PAGE_SIZE, status }) {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (reverse) params.set("reverse", "true");
    if (status)  params.set("status", status); // ranked | unranked | any (omitted → API default = ranked)
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(fetchName)}/quotes?${params.toString()}`;

    // ── DIAGNOSTIC ALARM (Issue 2) — quiet by design ────────────────────
    // Silent on normal, fast pages. Fires only when something is wrong or
    // regressing:
    //   • a thrown fetch (network/CORS; real HTTP status is invisible to JS →
    //     check the DevTools Network tab),
    //   • a non-ok HTTP status (logged with headers + raw body),
    //   • a 200 with an unparseable/truncated body,
    //   • a SUCCESSFUL page that ran unusually slow (> GT_DIAG_SLOW_MS) — the
    //     early warning that we're drifting back toward the gateway-timeout
    //     zone that caused the original intermittent failures.
    // Watches every real page (the perPage=1 count probe is gone — the refresh
    // now bounds itself by the per-quote race-count stop key instead).
    const GT_DIAG_SLOW_MS = 20000;
    const gtDiagWatch = perPage > 1;
    const gtDiagTag = `[GT-DIAG] quotes ${fetchName} p${page} perPage=${perPage}${status ? " " + status : ""}`;
    const gtDiagT0  = gtDiagWatch ? performance.now() : 0;

    let r;
    try {
      r = await gtApiFetch(url, { headers: authHeaders() });
    } catch (e) {
      if (gtDiagWatch && !e?.gtThrottled) {
        const ms = Math.round(performance.now() - gtDiagT0);
        console.error(`${gtDiagTag} THREW after ${ms}ms — network/CORS, no JS-visible status. Check the DevTools Network tab for the real status (e.g. 429 / 502 / 504).`, e);
      }
      throw e;
    }
    const gtDiagMs = gtDiagWatch ? Math.round(performance.now() - gtDiagT0) : 0;

    if (gtDiagWatch && !r.ok) {
      let body = "";
      try { body = (await r.clone().text()).slice(0, 500); } catch {}
      console.error(`${gtDiagTag} → HTTP ${r.status} in ${gtDiagMs}ms | retry-after=${r.headers.get("retry-after")} ratelimit-remaining=${r.headers.get("x-ratelimit-remaining") ?? r.headers.get("ratelimit-remaining")} | body[0:500]: ${body}`);
    }

    if (!r.ok) throw new Error(`rival quotes ${fetchName} p${page} → ${r.status}`);

    // On watched pages, read the body as text first so a 200-with-truncated/
    // invalid body surfaces here (with the raw text) rather than as a bare
    // parse throw; and warn if a successful page ran slow enough to flirt with
    // the gateway timeout.
    let d;
    if (gtDiagWatch) {
      if (gtDiagMs > GT_DIAG_SLOW_MS) console.warn(`${gtDiagTag} → ${r.status} OK but SLOW: ${gtDiagMs}ms (watch for timeouts)`);
      const raw = await r.text();
      try { d = JSON.parse(raw); }
      catch (e) {
        console.error(`${gtDiagTag} → ${r.status} but JSON.parse FAILED in ${gtDiagMs}ms | raw.length=${raw.length} | raw[0:300]: ${raw.slice(0, 300)}`, e);
        throw e;
      }
    } else {
      d = await r.json();
    }
    // Exact quote count for this status. The API's documented field is
    // `totalCount`; the older names are kept as harmless fallbacks. When absent
    // it's null and callers fall back to the perPage=1 trick (totalPages ===
    // count at one-per-page).
    const total = (typeof d?.totalCount === "number") ? d.totalCount
                : (typeof d?.total === "number") ? d.total
                : (typeof d?.totalQuotes === "number") ? d.totalQuotes
                : (typeof d?.count === "number") ? d.count
                : null;
    return { quotes: Array.isArray(d?.quotes) ? d.quotes : [], totalPages: d?.totalPages || 1, total };
  }

  // The single-quote best for any user, used for on-demand current-quote
  // fills before bulk completes. Returns { wpm, pp } | null (never raced).
  const rivalQuoteBestInFlight = new Map(); // `${key}:${qid}` → Promise
  async function fetchRivalQuoteBest(fetchName, quoteId) {
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(fetchName)}/quotes/${encodeURIComponent(quoteId)}`;
    const r = await gtApiFetch(url, { headers: authHeaders() }, { lane: "urgent" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`rival quote ${fetchName}/${quoteId} → ${r.status}`);
    const d = await r.json();
    const br = d?.bestRace;
    if (!br) return null;
    return { wpm: Number(br.wpm), pp: Number(br.pp) };
  }

  // ── Sync orchestration (leader-only fetching) ────────────────
  const rivalSyncInFlight = new Set(); // storeKeys currently bulk/incremental syncing
  // ONE rotation timer drives all ongoing refreshes (not one per store): each
  // tick advances the global bulk driver if anything is still building, else
  // refreshes exactly ONE managed store (round-robin via rivalRefreshCursor), so
  // steady-state traffic stays ~one small request per RIVAL_POLL_MS regardless
  // of how many rivals are listed. (gtApiFetch backs off but doesn't serialise,
  // so N per-store timers could otherwise burst N requests at once.)
  let rivalPollTimer    = null;
  let rivalRefreshCursor = 0;
  const rivalManaged      = new Map(); // lowerName ("__self__"|username) → fetchName
  // At most ONE bulk build runs at a time. Self + a rival firing their first
  // pages concurrently is exactly the doubled request rate that trips the
  // limiter fastest; serializing them (self first, then each rival) keeps the
  // request rate low and predictable.
  let rivalBulkActive = false;

  function rivalFetchNameFor(name) {
    if (name === RIVAL_SELF_NAME) return getAuth().username;
    return rivalManaged.get(name) || name;
  }

  // ── Bulk build, round-robin across stores ─────────────────────────────
  // The bulk loads every quote for the self store and each rival store, paged.
  // Instead of draining one store completely before starting the next (which
  // left standings empty the entire time the self store built — no overlap
  // means no matches), a single driver advances every not-yet-complete store
  // one page at a time, round-robin (1:1). Self and the rival grow together, so
  // their intersection — the matches — starts surfacing almost immediately
  // rather than only after self finishes. A store that's already complete drops
  // out of the rotation, so the common "self already loaded, just add a rival"
  // case behaves exactly like a plain single-store drain.
  //
  // Still strictly one request in flight at a time, with the same
  // RIVAL_PAGE_DELAY_MS pacing between every page: this is a reordering, not
  // more concurrency, so it adds no burst pressure. The cursor (fetch.nextPage)
  // is persisted every page, so a pause/freeze/lost-leadership resumes cleanly
  // from where it stopped.

  // Truthy ("any") while this store still has bulk work, else null. (Single
  // status=any stream now, but kept as a string so the driver's truthiness
  // checks and pending-set logic stay unchanged.)
  function pendingBulkStreamFor(name) {
    return rivalBulkDone(loadRivalStore(name)) ? null : "any";
  }

  // Fetch + merge ONE bulk page (status=any) for a store and advance its cursor.
  // Returns "advanced" (more pages remain), "done" (the build is complete), or
  // "failed" (the request threw — gtApiFetch has already escalated the shared
  // backoff). `persist(name, force)` saves the store and renders (throttled).
  async function fetchOneRivalBulkPage(name, persist) {
    const fetchName = rivalFetchNameFor(name);
    if (!fetchName) return "failed"; // auth not ready yet
    const store = loadRivalStore(name);
    const fobj  = store.fetch;
    if (fobj.phase === "done") return "done";

    // Forward-only OFFSET cursor. `covered` = quotes confirmed fetched, contiguous
    // from 0. We always page FORWARD from there — page = floor(covered/perPage)+1 —
    // so the window starts on the covered boundary and we never restart at page 1
    // (the old rebase did, re-reading the whole prefix whenever covered < size).
    // The API only addresses quotes by page×perPage, so the sole possible re-read
    // is `covered % perPage` when the size isn't aligned to the boundary — and
    // align-on-grow keeps that at zero in the common case. Legacy cursors stored a
    // page NUMBER (+ maybe pageSize); derive covered from them once on first use.
    const perPage = rivalBulkPerPage;
    const covered = (typeof fobj.covered === "number")
      ? fobj.covered
      : ((fobj.nextPage || 1) - 1) * (fobj.pageSize || RIVAL_PAGE_SIZE); // migrate
    const page = Math.floor(covered / perPage) + 1;

    const gtT0 = performance.now();
    let res;
    try { res = await fetchRivalQuotesPage(fetchName, { page, reverse: true, perPage, status: "any" }); }
    catch (e) {
      // A 30s abort means the page was too big for the cap → halve so the retry
      // (same covered offset, smaller size) finishes. A plain network error fails
      // fast and isn't a size signal, so leave the size alone for that.
      if (e?.gtTimeout) setRivalBulkPerPage(rivalBulkPerPage * 0.5);
      fobj.covered  = covered;   // unchanged — the page didn't land
      fobj.pageSize = perPage;
      console.warn("[Goal Tracker] rival bulk page failed (paused):", e);
      persist(name, true);
      return "failed";
    }

    if (!store.raceCounts) store.raceCounts = {};
    for (const q of res.quotes) {
      const e = entryFromQuoteRecord(q);
      if (!e) continue;
      rivalMergeEntry(store, e.quoteId, e.wpm, e.pp, e.r, e.d, e.l);
      // Seed the per-quote completed-race baseline as the bulk passes each row,
      // so the first incremental refresh has a stop key and never deep-scans.
      if (e.races !== undefined) store.raceCounts[e.quoteId] = e.races;
    }
    const newCovered = page * perPage;   // end of the window just fetched
    fobj.covered    = newCovered;
    fobj.pageSize   = perPage;
    fobj.totalPages = res.totalPages;    // for the CURRENT perPage (drives the bar)
    fobj.nextPage   = page + 1;          // display-only now (progress bar)
    adaptBulkPageSizeOnSuccess(performance.now() - gtT0, newCovered); // size for next page
    if (page >= res.totalPages) {
      fobj.phase = "done";
      store.metaV = RIVAL_META_V; // status=any build done -> ranked/unranked/d/l/r all captured
      store.lastSync = new Date().toISOString(); // refresh anchor: all captured up to now
      persist(name, true);
      clearSyncBurstIfEnded(); // drop burst membership once nothing is still paging
      return "done";
    }
    persist(name, false);
    return "advanced";
  }

  // The single bulk driver: round-robins one page at a time across every
  // managed store that still has bulk work, until all are complete (or it's
  // paused by lost leadership / backoff, which the 60s poll later resumes).
  // `rivalBulkActive` keeps exactly one driver running at a time.
  async function runRivalBulkDriver() {
    if (!isLeader) return;
    // No visibility gate: this one-time build runs to completion even while the
    // tab is hidden (tab away to Discord and it keeps loading). Only the
    // recurring refresh and live polls stay visibility-gated. (Browser-level
    // background throttling/freezing of a long-hidden tab still applies — the
    // per-store cursor resumes on return.)
    if (apiThrottled()) return;     // shared backoff in effect
    if (rivalBulkActive) return;    // a driver is already running
    let anyPending = false;
    for (const n of rivalManaged.keys()) { if (pendingBulkStreamFor(n)) { anyPending = true; break; } }
    if (!anyPending) return;

    // Persist every page (cheap next to the multi-second page latency, and it
    // keeps each store's resume cursor current); throttle only the expensive
    // render to ~1/s to avoid main-thread jank / starving the quote-finish path.
    let lastRender = 0;
    const persist = (name, force) => {
      saveRivalStore(name);
      const now = Date.now();
      if (force || now - lastRender > 1000) { renderAllGoals(); lastRender = now; }
    };

    rivalBulkActive = true;
    try {
      let lastName = null, firstFetch = true;
      while (isLeader && !apiThrottled()) {
        // Rebuild the pending set each iteration so stores registered mid-run
        // (the rivals are added just after the self store kicks the driver) and
        // stores that just completed are reflected immediately.
        const pending = [];
        for (const name of rivalManaged.keys()) {
          if (pendingBulkStreamFor(name)) pending.push({ name });
        }
        if (pending.length === 0) break; // every bulk complete

        // Round-robin: take the store after the last one we fetched (1:1).
        let pick = 0;
        if (lastName != null) {
          const li = pending.findIndex(j => j.name === lastName);
          pick = li >= 0 ? (li + 1) % pending.length : 0;
        }
        const job = pending[pick];

        if (!firstFetch) {
          await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
          if (!isLeader || apiThrottled()) break;
        }
        firstFetch = false;

        const result = await fetchOneRivalBulkPage(job.name, persist);
        if (result === "failed") break; // backoff in effect; poll resumes later
        lastName = job.name;
      }
    } finally {
      rivalBulkActive = false;
      // If every bulk is now complete, hand each store off to its incremental
      // refresh immediately rather than waiting for the next 60s poll. If we
      // instead paused with work still pending, leave it — the poll re-kicks the
      // driver. We deliberately don't start incremental refreshes while any bulk
      // is pending (keeps to one logical fetch stream at a time).
      let stillPending = false;
      for (const n of rivalManaged.keys()) { if (pendingBulkStreamFor(n)) { stillPending = true; break; } }
      // Hand each completed store to its incremental refresh — but only when a
      // rival goal exists. In the self-prefetch state (logged in, no rival
      // goal) the bulk is the whole job; don't kick an ongoing self refresh.
      const haveRivalGoals = (goalData.rival || []).length > 0 || haveImprovementTargetGoals();
      if (!stillPending && isLeader && !apiThrottled() && haveRivalGoals) {
        for (const name of rivalManaged.keys()) {
          if (rivalBulkDone(loadRivalStore(name))) rivalIncrementalSync(name);
        }
      }
    }
  }

  // Ongoing refresh: catch up on a store's new PBs since we last looked. Runs
  // one store per tick via the rotation timer (RIVAL_POLL_MS).
  //
  // The /users/<name>/quotes list is sorted by most-recent COMPLETED race
  // (descending), and the top-level `races` is the user's completed-race count
  // on each quote. Incomplete attempts neither appear nor bump `races`, so the
  // two move in lockstep: every event that floats a quote up the list also
  // increments its `races`. The quotes raced since our last scan are therefore
  // exactly the contiguous prefix from the top, and the boundary is the first
  // already-tracked quote whose `races` is unchanged — everything below it was
  // raced even longer ago. (startDate is ignored server-side on this endpoint,
  // so we bound the scan this way instead of by date.)
  //
  // Per row, top→down: a new quote, or a tracked one whose `races` grew, may
  // carry a new PB → feed it to rivalMergeEntry (ratchets; non-PB re-races and
  // meta-only rows no-op) and (re)record its race count. The first tracked quote
  // with an unchanged count means we've caught up → stop. RIVAL_REFRESH_MAX_PAGES
  // bounds the one-time first scan of a store with no baseline yet. NOTE: a PP
  // rebalance moves pp WITHOUT a race, so `races` won't change and this refresh
  // won't see it — that case is owned by the PP-rebalance reconcile path, by
  // design.
  async function rivalIncrementalRefresh(name) {
    const fetchName = rivalFetchNameFor(name);
    if (!fetchName) return false;
    const store  = loadRivalStore(name);
    if (!store.raceCounts) store.raceCounts = {};
    const status = "any";

    let changed  = false;
    let caughtUp = false;
    let page = 1;
    while (isLeader && anyTabVisibleRecently() && !apiThrottled()) {
      if (page > 1) await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
      let res;
      try { res = await fetchRivalQuotesPage(fetchName, { page, reverse: false, perPage: RIVAL_REFRESH_PAGE_SIZE, status }); }
      catch (e) { console.warn("[Goal Tracker] rival refresh failed (paused):", e); break; }
      for (const q of res.quotes) {
        const e = entryFromQuoteRecord(q);
        if (!e) continue;
        const races     = e.races; // undefined if the row carried no count
        const tracked   = !!store.quotes[e.quoteId];
        const prevRaces = store.raceCounts[e.quoteId];
        // Caught up: an already-tracked quote whose completed-race count has not
        // moved. The list is last-raced-desc, so every row below is older → stop.
        if (tracked && races !== undefined && prevRaces !== undefined && races <= prevRaces) {
          caughtUp = true;
          break;
        }
        // New / re-raced since last scan: merge any PB (ratchets; non-PB re-races
        // and meta-only rows no-op) and advance the stored race count so the next
        // scan can stop here. The `r` tag is (re)applied so a mis-tag heals.
        if (rivalMergeEntry(store, e.quoteId, e.wpm, e.pp, e.r, e.d, e.l)) changed = true;
        if (races !== undefined && store.raceCounts[e.quoteId] !== races) {
          store.raceCounts[e.quoteId] = races;
          changed = true; // persist the advanced baseline even with no PB change
        }
      }
      if (caughtUp) break;
      if (page >= res.totalPages) break;
      if (page >= RIVAL_REFRESH_MAX_PAGES) {
        console.warn("[Goal Tracker] rival refresh hit page cap without catching up", { name, pages: page });
        break;
      }
      page += 1;
    }
    return changed;
  }

  async function rivalIncrementalSync(name) {
    if (!isLeader) return;
    if (!anyTabVisibleRecently()) return;
    if (apiThrottled()) return; // shared backoff in effect
    const key = rivalStoreKey(name);
    if (rivalSyncInFlight.has(key)) return;
    const fetchName = rivalFetchNameFor(name);
    if (!fetchName) return;
    const store = loadRivalStore(name);
    if (!rivalBulkDone(store)) return; // still building
    rivalSyncInFlight.add(key);
    try {
      if (await rivalIncrementalRefresh(name)) { saveRivalStore(name); renderAllGoals(); }
    } finally {
      rivalSyncInFlight.delete(key);
    }
  }

  // The single rotation timer. Started lazily once anything is managed; cleared
  // by stopAllRivalTimers (logout). It no-ops cheaply while idle.
  function ensureRivalPollTimer() {
    if (rivalPollTimer != null) return;
    rivalPollTimer = setInterval(rivalPollOnce, RIVAL_POLL_MS);
  }
  // One rotation tick: resume the global bulk if any store is still building,
  // otherwise refresh ONE managed store (round-robin). Fires regardless of
  // visibility so an interrupted one-time bulk resumes in the background; the
  // incremental refresh inside rivalIncrementalSync is itself visibility-gated,
  // so the ongoing refresh still pauses when hidden.
  function rivalPollOnce() {
    if (!isLeader) return;
    if (!rivalIdbReady) return;    // hydration not done yet
    if (!isLoggedIn()) return;     // logged out — nothing to sync (no 401s)
    if (apiThrottled()) return;    // backing off after recent fetch failures
    if (rivalManaged.size === 0) return;
    // Any store still building → advance the round-robin bulk driver (it builds
    // every pending store together) and do nothing else this tick.
    for (const n of rivalManaged.keys()) {
      if (pendingBulkStreamFor(n)) { runRivalBulkDriver(); return; }
    }
    // All bulk complete. The ongoing incremental refresh runs when a rival OR
    // an improvement-Target goal exists (Target goals need the self store kept
    // current so X/Y tracks new PBs). In the bare self-prefetch state (logged
    // in, no rival/target goal) the one-time bulk is the whole job.
    if ((goalData.rival || []).length === 0 && !haveImprovementTargetGoals()) return;
    // Round-robin: refresh exactly ONE managed store per tick. Self is included
    // (its PBs need refreshing too); the cursor wraps and tolerates the set
    // changing between ticks.
    const names = Array.from(rivalManaged.keys());
    if (names.length === 0) return;
    if (rivalRefreshCursor >= names.length) rivalRefreshCursor = 0;
    const name = names[rivalRefreshCursor];
    rivalRefreshCursor = (rivalRefreshCursor + 1) % names.length;
    rivalIncrementalSync(name);
  }

  // Drive one store: run the status=any bulk while it's still building, else do
  // an incremental refresh pass. Used for the immediate kick on registration
  // (the recurring cadence is rivalPollOnce).
  function rivalSyncTick(name) {
    if (!isLoggedIn()) return; // logged out — nothing to sync (no 401s)
    if (apiThrottled()) return; // backing off after recent fetch failures
    // If ANY managed store still has bulk work, run the round-robin driver (it
    // advances all of them together); otherwise this store does its incremental
    // refresh. `name` matters only for the incremental branch — bulk is global
    // across stores, so the driver ignores it.
    for (const n of rivalManaged.keys()) {
      if (pendingBulkStreamFor(n)) { runRivalBulkDriver(); return; }
    }
    // No bulk pending. The ongoing incremental refresh runs when a rival OR an
    // improvement-Target goal exists (the latter needs the self store fresh).
    // The poll still ran the driver above, so an interrupted bulk resumes.
    if ((goalData.rival || []).length === 0 && !haveImprovementTargetGoals()) return;
    rivalIncrementalSync(name);
  }

  function startRivalManaged(name, fetchName) {
    rivalManaged.set(name, fetchName);
    rivalSyncTick(name);    // kick immediately (bulk resumes / first refresh)
    ensureRivalPollTimer(); // the single rotation timer drives the recurring cadence
  }
  function stopRivalManaged(name) {
    const key = rivalStoreKey(name);
    rivalManaged.delete(name);
    if (rivalRefreshCursor >= rivalManaged.size) rivalRefreshCursor = 0; // keep cursor in range
    if (name !== RIVAL_SELF_NAME) {
      try { localStorage.removeItem(key); } catch {}
      rivalStores.delete(key);
      channel?.postMessage({ type: "rival-store", storeKey: key });
    }
  }

  // Clear ALL rival/self poll timers and forget the managed set, WITHOUT
  // deleting any store from localStorage (unlike stopRivalManaged, which GCs a
  // rival's data). Used on logout: stops every rival fetch loop while keeping
  // the account-independent rival stores and the self store on disk for the
  // next login. A running bulk driver exits cleanly once rivalManaged is empty.
  function stopAllRivalTimers() {
    if (rivalPollTimer != null) { clearInterval(rivalPollTimer); rivalPollTimer = null; }
    rivalManaged.clear();
    rivalRefreshCursor = 0;
  }

  // ── Single vs multiple rivals ─────────────────────────────────
  // A rival goal is either SINGLE ({ id, rival }) or MULTI
  // ({ id, rivals: [name, ...], mode: "multi" }). An absent `mode` (and a
  // present `rival`) means single — so existing goals migrate for free, with
  // no destructive rewrite. goalRivalNames flattens either shape to a name
  // list; goalIsMulti reports the shape.
  function goalIsMulti(gd) {
    return !!(gd && gd.mode === "multi" && Array.isArray(gd.rivals));
  }
  function goalRivalNames(gd) {
    if (goalIsMulti(gd)) return gd.rivals.filter(Boolean);
    return gd && gd.rival ? [gd.rival] : [];
  }
  // Map lowercased rival → display-cased name (first goal wins) so we fetch
  // with a real username and key the store case-insensitively. Flattens both
  // single- and multi-rival goals, deduping rivals shared across goals.
  function referencedRivalMap() {
    const m = new Map();
    for (const g of (goalData.rival || [])) {
      for (const name of goalRivalNames(g)) {
        if (name && !m.has(name.toLowerCase())) m.set(name.toLowerCase(), name);
      }
    }
    return m;
  }

  // Reconcile managed stores against the current rival goals. Always keeps the
  // self store alive (the spec wants it built regardless of any rival goal).
  function ensureRivalSync() {
    if (!isLeader) return;
    if (!rivalIdbReady) return; // wait for the IDB hydration before any fetch/build
    if (!isLoggedIn()) { stopAllRivalTimers(); return; } // logged out: no rival/self work, stores kept
    const map = referencedRivalMap();
    const haveRivalGoals = map.size > 0;
    const { token, username } = getAuth();
    // F1 — proactive self prefetch. Even with NO rival goal yet, build the self
    // store for a logged-in user so the FIRST rival goal is low-friction rather
    // than triggering a multi-minute bulk build. Only the one-time self bulk
    // runs in this state: rivalSyncTick and the bulk-driver handoff both gate
    // the ongoing incremental refresh on a rival goal existing, and
    // ensureCurrentQuoteForRivals only fires when a rival goal is on screen. So
    // "logged in, no rival goal" runs the self bulk to completion and then goes
    // quiet. Gated on being logged in (token present); skipped when logged out.
    //
    // (Historically the self store built ONLY once a rival goal existed, to
    // avoid an unconditional bulk for every user at startup. The bulk is a paced,
    // serialized, ONE-TIME build — once fetch.phase === "done" it never bulk-
    // fetches again — so with a small user base the friction win is worth the
    // one-time cost. The self store is still never DELETED, only its active
    // syncing stops when there's neither a rival goal nor a login to prefetch.)
    const prefetchSelf = !!token;
    const wanted     = new Set();
    const wantedKeys = new Set();
    if (haveRivalGoals || prefetchSelf) {
      wanted.add(RIVAL_SELF_NAME);
      wantedKeys.add(rivalStoreKey(RIVAL_SELF_NAME));
    }
    if (haveRivalGoals) {
      for (const k of map.keys()) { wanted.add(k); wantedKeys.add(rivalStoreKey(k)); }
      startRivalManaged(RIVAL_SELF_NAME, username);
      for (const [lower, display] of map) startRivalManaged(lower, display);
    } else if (prefetchSelf) {
      // Self-only: register + kick the bulk (resume timer included). No rival
      // machinery — see the gating in rivalSyncTick / runRivalBulkDriver.
      startRivalManaged(RIVAL_SELF_NAME, username);
    }
    // Stop timers for managed-but-no-longer-wanted stores. Removing the last
    // rival goal stops the rival timers; the self timer is kept while logged in
    // (it's wanted for prefetch — its poll just goes quiet once the bulk is
    // done) and only stops when logged out. stopRivalManaged always leaves the
    // self store's localStorage intact by design.
    for (const name of Array.from(rivalManaged.keys())) {
      if (!wanted.has(name)) stopRivalManaged(name);
    }
    // Garbage-collect ANY persisted rival store whose user isn't referenced by
    // a current goal — including stale keys left by a goal removed in a prior
    // session (which stopRivalManaged alone would miss). Scans IDB keys (async).
    gcStaleRivalStores(wantedKeys);
  }
  async function gcStaleRivalStores(wantedKeys) {
    try {
      const all = await idbGetAll();
      for (const { key } of all) {
        if (key === RIVAL_META_KEY || key === RIVAL_MIGRATED_KEY) continue;
        if (key.startsWith(RIVAL_KEY_PREFIX) && !wantedKeys.has(key)) {
          await idbDelete(key);
          rivalStores.delete(key);
          channel?.postMessage({ type: "rival-store", storeKey: key });
        }
      }
    } catch {}
  }

  // Merge the recent /races list into the self store (called on quote-finish).
  async function maintainSelfStoreFromRaces(gtPerfSession = null, selfRender = true) {
    if (!rivalIdbReady) return false; // self store not hydrated yet
    if (apiHardThrottled()) return false; // only a real 429 blocks the urgent post-race lane
    let races;
    const gtRacesT0 = performance.now(); // [GT-PERF]
    try { races = await getRecentRacesData(); } catch { return false; }
    const gtRacesFetchMs = performance.now() - gtRacesT0; // [GT-PERF] /races fetch latency
    if (!Array.isArray(races) || races.length === 0) {
      if (gtPerfSession) gtPerf.endRivalLag(gtPerfSession, gtRacesFetchMs, false); // [GT-PERF]
      return false;
    }
    const store = loadRivalStore(RIVAL_SELF_NAME);
    let changed = false;
    const gtMerged = []; // [GT log] new personal bests merged this pass
    for (const race of races) {
      if (race && rivalMergeEntry(store, race.quoteId, race.wpm, race.pp)) {
        changed = true;
        gtMerged.push({ quoteId: race.quoteId, wpm: race.wpm, pp: race.pp });
      }
    }
    if (changed) gtLog("Self store updated from /races", `${gtMerged.length} new personal best(s) merged`, { merged: gtMerged });
    // selfRender=false lets the quote-finish path render once (so the rival
    // merge lands in the same frame as the standard goals when it's fast).
    if (changed) { saveRivalStore(RIVAL_SELF_NAME); if (selfRender) renderAllGoals(); }
    if (gtPerfSession) gtPerf.endRivalLag(gtPerfSession, gtRacesFetchMs, changed); // [GT-PERF]
    return changed;
  }

  // Authoritative post-race confirm for ONE quote (the just-finished one). The
  // aggregate /races merge above is gated on the stats tick and reads a list that
  // can lag the server's per-quote best, so it can silently miss a fresh PB. The
  // /users/<me>/quotes/<id> endpoint is per-quote and can't lag that way, so we
  // read it directly and ratchet it into the self store. Urgent lane (a bulk
  // soft-pause must not block it); only a genuine 429 holds it off. Returns
  // whether a new best merged.
  async function confirmSelfQuoteAfterRace(quoteId) {
    if (!quoteId) return false;
    if (!isLeader || !rivalIdbReady || !isLoggedIn()) return false;
    if (apiHardThrottled()) return false; // only a real 429 blocks the urgent lane
    const { username } = getAuth();
    if (!username) return false;
    let best;
    try { best = await fetchRivalQuoteBest(username, quoteId); }
    catch { return false; }
    if (!best) return false; // 404 (never raced) or no bestRace — nothing to merge
    const store = loadRivalStore(RIVAL_SELF_NAME);
    if (rivalMergeEntry(store, quoteId, best.wpm, best.pp)) {
      gtLog("Self store — post-race per-quote confirm merged a new best", `quote ${quoteId}`, { quoteId, wpm: best.wpm, pp: best.pp });
      saveRivalStore(RIVAL_SELF_NAME);
      return true;
    }
    return false;
  }

  // On-demand fill of the current quote's bests (leader only), so the compare
  // line is accurate before bulk completes. Records confirmed "never raced"
  // results to avoid refetch loops; store-presence always wins over that memo.
  const rivalAbsentMemo = new Map(); // storeKey → Set(quoteId) known-never-raced
  function rememberAbsent(key, qid) {
    let s = rivalAbsentMemo.get(key);
    if (!s) { s = new Set(); rivalAbsentMemo.set(key, s); }
    s.add(qid);
  }
  function isRememberedAbsent(key, qid) {
    return rivalAbsentMemo.get(key)?.has(qid);
  }
  function ensureCurrentQuoteForRivals(quoteId) {
    if (!isLeader || !quoteId) return;
    if (!rivalIdbReady) return; // stores not hydrated yet
    if (apiHardThrottled()) return; // only a real 429 blocks this urgent on-demand fill
    const refMap = referencedRivalMap();
    if (refMap.size === 0) return; // no rival goals → nothing to compare, don't fetch self
    const names = [RIVAL_SELF_NAME, ...refMap.keys()];
    for (const name of names) {
      const key = rivalStoreKey(name);
      const store = loadRivalStore(name);
      if (store.quotes[quoteId]) continue;          // already known
      if (isRememberedAbsent(key, quoteId)) continue; // confirmed never-raced
      const inflightKey = `${key}:${quoteId}`;
      if (rivalQuoteBestInFlight.has(inflightKey)) continue;
      const fetchName = rivalFetchNameFor(name);
      if (!fetchName) continue;
      const p = fetchRivalQuoteBest(fetchName, quoteId)
        .then(best => {
          if (best == null) { rememberAbsent(key, quoteId); return; }
          const st = loadRivalStore(name);
          if (rivalMergeEntry(st, quoteId, best.wpm, best.pp)) { saveRivalStore(name); renderAllGoals(); }
        })
        .catch(() => { /* gtApiFetch already escalated the shared backoff */ })
        .finally(() => rivalQuoteBestInFlight.delete(inflightKey));
      rivalQuoteBestInFlight.set(inflightKey, p);
    }
  }

  // Re-run the urgent post-race refresh for the live quote once an API backoff
  // window clears, so a rival / improvement-target card that couldn't update
  // during the pause heals itself within a couple of seconds instead of staying
  // stale until the next race (re-type) or a slow periodic poll. Leader-only and
  // a no-op while a genuine 429 window is still up.
  function runBackoffCatchUp() {
    if (!isLeader || !rivalIdbReady) return;
    if (apiHardThrottled()) return; // a genuine rate-limit is still in effect
    const haveRival = (goalData.rival || []).length > 0;
    if (!haveRival && !haveImprovementTargetGoals() && !haveMaxCharsGoals()) return;
    // Pull your latest /races into the self store (fills the just-set PB the
    // gated finish missed), then fill the live quote's bests for each rival.
    maintainSelfStoreFromRaces().catch(() => {});
    const liveQid = getCurrentQuoteIdLive();
    if (liveQid && haveRival) ensureCurrentQuoteForRivals(liveQid);
    renderAllGoals();
  }


  // ── PP-rebalance self-heal ───────────────────────────────────
  // TypeGG occasionally rebalances its PP system and recalculates every
  // race's PP server-side. Our self/rival stores cache per-quote PP, and the
  // merge RATCHETS (keeps the higher value), so a recalculation that LOWERS a
  // quote's PP would otherwise never propagate. We catch it cheaply: on each
  // quote change, read the server's pre-race best for that quote and compare
  // it to our cached value. They match in normal operation (the cache is
  // derived from the server); a mismatch means PP was recalculated, so we
  // re-fetch every store that holds a PP value.
  //
  // Timing: the read is kicked at quote START (before this attempt is
  // absorbed), so it reflects the OLD best — the same basis as the cache.
  const PP_REBALANCE_EPS = 0.5;          // sub-PP deltas are float noise, not a rebalance
  const ppRebalanceChecked = new Set();  // quoteIds reconciled this session (per-race cost cap)
  let ppRebalanceRefetchActive = false;  // re-entrancy guard for the store reset itself
  // A genuine server PP rebalance moves ESSENTIALLY EVERY quote; a single quote
  // disagreeing is almost always local staleness (a post-race PB the /races merge
  // missed). So we track DISTINCT mismatched quotes and only escalate to the full
  // multi-store wipe once enough of them disagree — below that we reconcile each
  // quote in place. This stops one missed merge from nuking every store into a
  // slow full re-bulk (the "Syncing… 0/0" thrash).
  const ppRebalanceMismatches = new Set(); // distinct quoteIds seen disagreeing this session
  const PP_REBALANCE_ESCALATE = 4;         // distinct disagreeing quotes that confirm a real rebalance

  async function maybePpRebalanceRefetch(quoteId) {
    if (!quoteId) return;
    if (!isLeader || !rivalIdbReady || !isLoggedIn()) return;
    if (apiHardThrottled()) return;              // a real 429 is up — re-check on a later quote
    if (ppRebalanceRefetchActive) return;        // a refetch is mid-reset
    if (ppRebalanceChecked.has(quoteId)) return; // already reconciled this quote this session
    // Only worth doing when something actually reads the PP cache.
    if ((goalData.rival || []).length === 0 && !haveImprovementTargetGoals() && !haveMaxCharsGoals()) return;

    const selfStore = loadRivalStore(RIVAL_SELF_NAME);
    // Never compare against a half-built cache: during the one-time bulk a
    // missing or low entry is expected, not a rebalance.
    if (!rivalBulkDone(selfStore)) return;

    const cached = selfStore.quotes[quoteId];
    // "Played at least once" AND ranked (PP-bearing). Never-raced or unranked
    // (pp 0) quotes have no old-best PP to reconcile.
    if (!cached || !(Number(cached.pp) > 0)) return;

    // Claim the quote up-front so overlapping ticks don't double-fetch; on a
    // transient error we release it so the next visit can retry.
    ppRebalanceChecked.add(quoteId);

    let live;
    try { live = await fetchUserQuoteBest(quoteId); } // pre-race best { wpm, pp } | null
    catch { ppRebalanceChecked.delete(quoteId); return; }
    // A 404 (null) against a cached PB is ambiguous (deleted/unranked quote or
    // a transient miss), not a clear rebalance — don't nuke everything on it.
    if (!live || !Number.isFinite(Number(live.pp))) return;

    if (Math.abs(Number(live.pp) - Number(cached.pp)) <= PP_REBALANCE_EPS) {
      ppRebalanceMismatches.delete(quoteId); // realigned (our own confirm caught up) — drop it
      return;
    }

    // Reconcile THIS quote in place first — overwrite the self entry with the
    // authoritative live value (an OVERWRITE, not the ratcheting merge: correct
    // whether the true value went UP — a missed PB — or DOWN — a rebalance). This
    // corrects the card / win count for the quote you're on without touching any
    // other store. `quoteId` is already in ppRebalanceChecked (claimed up-front),
    // so we won't re-fetch it this session.
    const sStore = loadRivalStore(RIVAL_SELF_NAME);
    sStore.quotes[quoteId] = { wpm: Number(live.wpm) || (sStore.quotes[quoteId]?.wpm || 0), pp: Number(live.pp) || 0 };
    saveRivalStore(RIVAL_SELF_NAME);
    ensureCurrentQuoteForRivals(quoteId); // rivals could have moved too (real rebalance); a no-op on plain staleness
    renderAllGoals();

    // Only a BROAD disagreement confirms a real server-side rebalance. Until the
    // distinct-quote count crosses the threshold, treat each mismatch as isolated
    // staleness (already fixed in place above) rather than wiping every store.
    ppRebalanceMismatches.add(quoteId);
    if (ppRebalanceMismatches.size < PP_REBALANCE_ESCALATE) {
      console.warn(`[Goal Tracker] PP mismatch on quote ${quoteId} (cached ${cached.pp} vs server ${live.pp}) — reconciled in place (${ppRebalanceMismatches.size}/${PP_REBALANCE_ESCALATE} distinct before a full re-sync).`);
      return;
    }

    console.warn(`[Goal Tracker] PP rebalance confirmed — ${ppRebalanceMismatches.size} distinct quotes disagreed with the server; re-fetching all PP stores.`);
    ppRebalanceMismatches.clear();
    refetchAllPpStores();
  }

  // Full re-fetch of every PP-bearing store (self + all managed rivals). The
  // recalculated server values can move DOWN, but rivalMergeEntry ratchets on
  // PP, so a plain re-page would keep stale-high values — we must CLEAR each
  // store's entries first, then rewind its cursor to re-bulk from scratch.
  // Resetting fetch.phase to "bulk" flips the cards back to the same
  // "syncing…" state as the initial build, and the existing bulk driver (plus
  // the recurring poll, if this immediate kick is throttled) refills them.
  function refetchAllPpStores() {
    if (!isLeader || !rivalIdbReady) return;
    if (ppRebalanceRefetchActive) return;
    ppRebalanceRefetchActive = true;
    try {
      // Every per-quote "aligned" memo was taken against the now-stale cache.
      ppRebalanceChecked.clear();
      // The reset legs are flagged into the current sync burst by freshRivalFetch
      // (syncBurst), so the bars scope to them (the intact catalog is excluded).
      // rivalManaged holds exactly the stores we actively sync (self + rivals).
      for (const name of Array.from(rivalManaged.keys())) {
        const store = loadRivalStore(name);
        store.quotes     = {};              // drop stale PP/WPM so the rebuild can lower values
        store.raceCounts = {};              // baseline rebuilds alongside quotes (bulk re-seeds it)
        store.fetch      = freshRivalFetch(); // rewind to page 1 (phase "bulk" → "syncing…")
        store.lastSync   = null;            // vestigial anchor; reset for tidiness
        rivalAbsentMemo.delete(rivalStoreKey(name)); // re-confirm "never raced" on refill
        saveRivalStore(name);               // persist + broadcast + bump epochs (caches invalidated)
      }
    } finally {
      ppRebalanceRefetchActive = false;
    }
    renderAllGoals();     // surface the "syncing…" state immediately
    runRivalBulkDriver(); // kick the rebuild now rather than waiting for the poll tick
  }

  // ══════════════════════════════════════════════════════════════
  // Quote catalog: fetch + sync (leader-only; prefetched for any logged-in user)
  // ══════════════════════════════════════════════════════════════
  // Mirrors the rival bulk subsystem: one paged build (status=any, 250/page)
  // through the shared gtApiFetch backoff gate, persisted-per-page so a
  // pause/lost-leadership resumes from the stored cursor, then an ongoing
  // newest-first delta refresh. The build is prefetched for any logged-in user
  // (no longer gated on a Target goal) so the catalog is ready ahead of time --
  // useful for Target goals and any future catalog-backed feature.

  // Fetch ONE catalog page. status=any so we get ranked + unranked together and
  // read each row's own `ranked` flag (the API default is ranked-only). Quotes
  // are public, so no auth header (matches getTypeGGTotalQuotes). Throws on a
  // non-2xx so the caller's catch pauses + persists the cursor.
  async function fetchQuoteCatalogPage({ page, perPage = CATALOG_PAGE_SIZE }) {
    const params = new URLSearchParams({ status: "any", perPage: String(perPage), page: String(page) });
    const url = `https://api.typegg.io/v1/quotes?${params.toString()}`;
    const res = await gtApiFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      page:       Number(data.page) || page,
      perPage:    Number(data.perPage) || perPage,
      totalPages: Number(data.totalPages) || 0,
      totalCount: Number(data.totalCount) || 0,
      quotes:     Array.isArray(data.quotes) ? data.quotes : [],
    };
  }

  // Merge one catalog row into the lean qid → { d, l, r } map. NO text stored.
  // Returns true iff the entry was added or changed. A missing `ranked` defaults
  // to true (the API's ranked-only default), but status=any rows always carry it.
  function mergeCatalogQuote(q) {
    const qid = q && q.quoteId;
    if (!qid) return false;
    const cur = quoteCatalog[qid];
    const dn = Number(q.difficulty);
    const ln = Number(q.length);
    const d = Number.isFinite(dn) ? dn : (cur ? cur.d : undefined);
    const l = Number.isFinite(ln) ? ln : (cur ? cur.l : undefined);
    const r = (typeof q.ranked === "boolean") ? q.ranked : (cur ? cur.r : true);
    if (cur && cur.d === d && cur.l === l && cur.r === r) return false;
    quoteCatalog[qid] = { d, l, r };
    return true;
  }

  // Persist both catalog records, bump the epoch (invalidates render/eval memos),
  // and broadcast so follower tabs reload. Async (IDB); on failure we keep the
  // in-memory copy for the session.
  function saveQuoteCatalog({ broadcast = true } = {}) {
    catalogEpoch++;
    const mapSnap = quoteCatalog, metaSnap = quoteCatalogMeta;
    idbPut(CATALOG_KEY, mapSnap)
      .then(() => idbPut(CATALOG_META_KEY, metaSnap))
      .then(() => { if (broadcast) channel?.postMessage({ type: "quote-catalog" }); })
      .catch(e => console.warn("[Goal Tracker] quote-catalog IDB save failed:", e));
  }

  // Follower path: the leader changed the catalog → reload both records + render.
  function reloadQuoteCatalogFromDisk() {
    Promise.all([idbGet(CATALOG_KEY), idbGet(CATALOG_META_KEY)]).then(([map, meta]) => {
      if (map && typeof map === "object") quoteCatalog = map;
      if (meta && typeof meta === "object") quoteCatalogMeta = { ...quoteCatalogMeta, ...meta };
      catalogEpoch++;
      renderAllGoals();
    }).catch(() => {});
  }

  // Has the one-time full build finished? Drives the render "syncing catalog…"
  // state and the slider-bounds fallback.
  function catalogFullySynced() {
    return catalogReady && quoteCatalogMeta.phase === "done";
  }

  // Combined sync progress for a Target goal as an integer 0..99, spanning the
  // TWO builds it depends on -- the shared quote catalog and your own self-race
  // store -- measured in pages so they sum into one bar. A finished leg counts
  // its full page span on BOTH sides, so the bar only ever climbs: it never
  // resets to 0 when one leg finishes while the other is still paging. Returns
  // 0 while syncing before any page count is known, and null once BOTH are done
  // (the caller hides the line on `settled`, so null is just belt-and-braces).
  function targetSyncPercent() {
    // Catalog + self legs through the shared burst rule: whichever of the two
    // actually needs (re)building counts (from 0%); a leg already synced before
    // this burst is excluded. So an initial sync shows catalog+self, while a PP
    // rebalance (catalog intact, self reset) shows self only — each starting at
    // 0% and climbing without a drop.
    const sf = (loadRivalStore(RIVAL_SELF_NAME).fetch) || {};
    return syncBurstPercentFromLegs([
      { pending: !catalogFullySynced(), inBurst: !!quoteCatalogMeta.syncBurst,
        totalPages: quoteCatalogMeta.totalPages, nextPage: quoteCatalogMeta.nextPage },
      { pending: sf.phase !== "done", inBurst: !!sf.syncBurst,
        totalPages: sf.totalPages, nextPage: sf.nextPage },
    ]);
  }


  // Full build: page 1..totalPages at 250/page, persisting the resume cursor
  // every page (cheap next to multi-second page latency). Runs to completion in
  // one call; a throttle / lost leadership breaks the loop and the cursor + the
  // 5-min poll resume it. Like the rival bulk, this runs even while every tab
  // is hidden (no visibility gate on the build); the cursor resumes after any
  // browser-level freeze of a long-hidden tab.
  async function runCatalogFullSync() {
    let lastRender = 0, firstFetch = true;
    while (isLeader && !apiThrottled() && isLoggedIn()) {
      if (!firstFetch) {
        await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
        if (!isLeader || apiThrottled()) break;
      }
      firstFetch = false;
      const page = quoteCatalogMeta.nextPage || 1;
      let data;
      try { data = await fetchQuoteCatalogPage({ page }); }
      catch (e) {
        console.warn("[Goal Tracker] quote-catalog page failed (paused):", e);
        saveQuoteCatalog(); // persist cursor so we resume from here
        break;
      }
      let changed = false;
      for (const q of data.quotes) { if (mergeCatalogQuote(q)) changed = true; }
      quoteCatalogMeta.totalCount = data.totalCount;
      quoteCatalogMeta.totalPages = data.totalPages;
      quoteCatalogMeta.phase = "bulk";
      quoteCatalogMeta.syncBurst = true; // part of the current sync burst
      if (data.totalPages === 0 || page >= data.totalPages) {
        quoteCatalogMeta.phase = "done";
        quoteCatalogMeta.nextPage = (data.totalPages || 0) + 1;
        quoteCatalogMeta.lastFullSync = new Date().toISOString();
        saveQuoteCatalog();
        clearSyncBurstIfEnded(); // drop burst membership once nothing is still paging
        renderAllGoals();
        break;
      }
      quoteCatalogMeta.nextPage = page + 1;
      saveQuoteCatalog();
      const now = Date.now();
      if (changed && now - lastRender > 1000) { renderAllGoals(); lastRender = now; }
    }
  }

  // Delta refresh (post-build): a cheap perPage=1 probe reads the newest quote +
  // totalCount. Page newest-first until a page is entirely already-known when
  // EITHER the count grew OR the newest quote's qid is unknown (the latter also
  // catches a net-zero add+delete the count alone would hide). Default sort is
  // created-DESC (page 1 = newest), confirmed against the live endpoint. The page
  // cap is the safety net: exceeding it without reaching known data forces a full
  // re-sync.
  async function runCatalogDeltaRefresh() {
    let probe;
    try { probe = await fetchQuoteCatalogPage({ page: 1, perPage: 1 }); }
    catch (e) { return; }
    const serverCount = probe.totalCount;
    // Default sort is created-DESC, so quotes[0] is the newest quote; if its qid
    // isn't in the catalog there's been an addition even when the count didn't
    // grow (one added + one deleted in the same window nets zero). Page anyway so
    // the newcomer is folded in -- the resulting catalog overshoot then trips
    // maybeReconcileCatalog into evicting the deleted ghost.
    const newest = probe.quotes[0];
    const newestUnknown = !!(newest && newest.quoteId && !(String(newest.quoteId) in quoteCatalog));
    if (!(serverCount > (quoteCatalogMeta.totalCount || 0)) && !newestUnknown) {
      if (serverCount && serverCount !== quoteCatalogMeta.totalCount) {
        quoteCatalogMeta.totalCount = serverCount; // shrank (deletions) — just record
        saveQuoteCatalog({ broadcast: false });
      }
      return;
    }
    let page = 1, learned = 0, firstFetch = true, reachedKnown = false;
    while (isLeader && !apiThrottled() && page <= CATALOG_DELTA_MAX_PAGES) {
      if (!firstFetch) {
        await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
        if (!isLeader || apiThrottled()) break;
      }
      firstFetch = false;
      let data;
      try { data = await fetchQuoteCatalogPage({ page }); }
      catch (e) { break; }
      if (data.quotes.length === 0) { reachedKnown = true; break; }
      let pageHadNew = false;
      for (const q of data.quotes) {
        const isNew = !(q.quoteId in quoteCatalog);
        if (mergeCatalogQuote(q) && isNew) learned++;
        if (isNew) pageHadNew = true;
      }
      quoteCatalogMeta.totalPages = data.totalPages;
      if (!pageHadNew) { reachedKnown = true; break; } // reached the synced region
      page++;
    }
    quoteCatalogMeta.totalCount = serverCount;
    if (learned > 0 || reachedKnown) saveQuoteCatalog();
    if (learned > 0) renderAllGoals();
    if (!reachedKnown) {
      console.warn("[Goal Tracker] quote-catalog delta hit page cap without reaching known quotes — forcing full re-sync (verify the API sort is created-DESC)");
      quoteCatalogMeta.phase = "bulk";
      quoteCatalogMeta.nextPage = 1;
      quoteCatalogMeta.syncBurst = true; // re-entering a sync burst
      saveQuoteCatalog();
    }
  }

  // Full reconcile (rare): re-page ALL quotes (status=any) over the existing
  // catalog. mergeCatalogQuote heals ranked-flips for free -- a re-delivered
  // quote whose `ranked` changed overwrites its entry. We also record every qid
  // seen across the whole pass and, ONLY after a COMPLETE pass, evict catalog
  // entries never seen -- those are deletions. A partial/aborted pass (lost
  // leadership, throttle, fetch error) evicts NOTHING (never wipe the catalog on
  // a half-finished sweep). Stamps lastReconcile on a complete pass so the probe
  // and the daily backstop throttle off it.
  async function runCatalogReconcile() {
    const seen = new Set();
    let page = 1, firstFetch = true, changed = false, complete = false;
    while (isLeader && !apiThrottled() && isLoggedIn()) {
      if (!firstFetch) {
        await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
        if (!isLeader || apiThrottled()) break;
      }
      firstFetch = false;
      let data;
      try { data = await fetchQuoteCatalogPage({ page }); }
      catch (e) { break; } // aborted mid-pass -> evict nothing
      for (const q of data.quotes) {
        if (q && q.quoteId) seen.add(String(q.quoteId));
        if (mergeCatalogQuote(q)) changed = true;
      }
      quoteCatalogMeta.totalCount = data.totalCount;
      quoteCatalogMeta.totalPages = data.totalPages;
      if (data.totalPages === 0 || page >= data.totalPages) { complete = true; break; }
      page++;
    }
    if (!complete) {                 // partial pass: keep any heals, evict nothing
      if (changed) saveQuoteCatalog();
      return;
    }
    const toEvict = [];              // complete pass: unseen qids are deletions
    for (const qid in quoteCatalog) if (!seen.has(qid)) toEvict.push(qid);
    for (const qid of toEvict) delete quoteCatalog[qid];
    quoteCatalogMeta.lastReconcile = new Date().toISOString();
    if (changed || toEvict.length > 0) { saveQuoteCatalog(); renderAllGoals(); }
    else saveQuoteCatalog({ broadcast: false }); // nothing changed; still stamp lastReconcile
  }

  // Cheap probe (piggybacks the 5-min catalog poll, AFTER the delta refresh):
  // compare the site's ranked + unranked counts against the catalog's. New
  // additions are already absorbed by the delta, so a *residual* mismatch means
  // ranked-flips and/or deletions on existing quotes -> run a full reconcile.
  // catRanked/catTotal come from the live map (not the stored count) so a delta
  // that merely recorded a shrunk totalCount can't hide a ghost entry. A daily
  // backstop runs the reconcile UNCONDITIONALLY (skipping the probe) to catch
  // offsetting changes the count-probe is blind to. Throttled via lastReconcile
  // so a persistent mismatch can't loop the expensive pass. Catalog-only: self/
  // rival stores are intentionally left untouched.
  async function maybeReconcileCatalog() {
    if (quoteCatalogMeta.phase !== "done") return; // don't fight the build / a forced re-sync
    const last = Date.parse(quoteCatalogMeta.lastReconcile || quoteCatalogMeta.lastFullSync || "") || 0;
    const sinceLast = Date.now() - last;
    if (sinceLast < RECONCILE_BACKSTOP_MS) {           // backstop not due -> probe first
      if (sinceLast < RECONCILE_MIN_INTERVAL_MS) return; // throttle: reconciled recently
      const [siteRanked, siteUnranked] = await Promise.all([
        getTypeGGTotalQuotes(), getTypeGGTotalUnrankedQuotes()
      ]);
      if (siteRanked == null || siteUnranked == null) return; // probe failed -> skip this cycle
      let catRanked = 0, catTotal = 0;
      for (const qid in quoteCatalog) { catTotal++; if (quoteCatalog[qid].r !== false) catRanked++; }
      if (siteRanked === catRanked && (siteRanked + siteUnranked) === catTotal) return; // counts agree
    }
    await runCatalogReconcile();
  }

  // The single catalog driver: full-build if not done, else a delta refresh.
  // catalogBulkActive keeps exactly one running at a time (mirrors
  // rivalBulkActive). Self-gates on leader / login / throttle; the build runs
  // even while hidden, the delta refresh only while a tab is visible.
  async function runQuoteCatalogDriver() {
    if (!isLeader) return;
    if (!catalogReady) return;
    if (!isLoggedIn()) return;
    if (apiThrottled()) return;
    if (catalogBulkActive) return;
    catalogBulkActive = true;
    try {
      // The one-time build runs to completion even while every tab is hidden
      // (mirrors the rival bulk: tab away and it keeps loading). The recurring
      // delta refresh stays visibility-gated, matching rivalIncrementalSync.
      if (quoteCatalogMeta.phase !== "done") await runCatalogFullSync();
      else if (anyTabVisibleRecently()) {
        await runCatalogDeltaRefresh();
        await maybeReconcileCatalog();
      }
    } finally {
      catalogBulkActive = false;
    }
  }

  // Guarded kick. The driver self-gates on leader / login / throttle, so no
  // visibility wrapper here -- the one-time build must run even while hidden
  // (the delta-refresh branch inside the driver stays visibility-gated).
  function maybeRunQuoteCatalog() {
    if (!isLeader || !catalogReady) return;
    runQuoteCatalogDriver();
  }

  // Difficulty/length axis over the catalog, filtered by a goal's status (and,
  // when played==="played", restricted to quotes in the self store). Drives the
  // creation-modal slider bounds. Cached by catalogEpoch + status + played
  // (mirrors rivalFilterAxis). Falls back to fixed bounds until the catalog has
  // some data. Difficulty floored/ceiled to integers; length to CATALOG_LEN_ROUND.
  let catalogAxisCache = null;
  function catalogAxis(status, played) {
    const key = `${catalogEpoch}:${status}:${played}`;
    if (catalogAxisCache && catalogAxisCache.key === key) return catalogAxisCache;
    const sq = (played === "played") ? loadRivalStore(RIVAL_SELF_NAME).quotes : null;
    let dLo = Infinity, dHi = -Infinity, lLo = Infinity, lHi = -Infinity;
    for (const qid in quoteCatalog) {
      const m = quoteCatalog[qid];
      if (status === "ranked"   && m.r === false) continue;
      if (status === "unranked" && m.r !== false) continue;
      if (sq && !(qid in sq)) continue;
      const d = Number(m.d), l = Number(m.l);
      if (Number.isFinite(d)) { if (d < dLo) dLo = d; if (d > dHi) dHi = d; }
      if (Number.isFinite(l)) { if (l < lLo) lLo = l; if (l > lHi) lHi = l; }
    }
    const floorTo = (v, s) => Math.floor(v / s) * s;
    const ceilTo  = (v, s) => Math.ceil(v / s) * s;
    const axis = {
      key,
      diffMin: Number.isFinite(dLo) ? Math.floor(dLo) : CATALOG_DIFF_MIN,
      diffMax: Number.isFinite(dHi) ? Math.ceil(dHi)  : CATALOG_DIFF_MAX,
      lenMin:  Number.isFinite(lLo) ? floorTo(lLo, CATALOG_LEN_ROUND) : CATALOG_LEN_MIN,
      lenMax:  Number.isFinite(lHi) ? ceilTo(lHi, CATALOG_LEN_ROUND)  : CATALOG_LEN_MAX,
    };
    if (axis.diffMax <= axis.diffMin) axis.diffMax = axis.diffMin + 1;
    if (axis.lenMax  <= axis.lenMin)  axis.lenMax  = axis.lenMin + CATALOG_LEN_ROUND;
    catalogAxisCache = axis;
    return axis;
  }

  // ══════════════════════════════════════════════════════════════
  // Improvement-Target evaluation + Next-quote
  // ══════════════════════════════════════════════════════════════
  // "Hit a flat metric threshold on every quote in a filtered catalog set."
  //   Y (total)  = catalog quotes passing the goal's {status, diff, len} filter
  //                (and, if played==="played", present in the self store).
  //   X (hit)    = of those, where your best metric value >= target.
  //   best       = self store entry's wpm/pp; a never-raced quote = 0 (not hit).
  // Memoized by (catalogEpoch, selfEpoch=rivalStoreEpoch, filterSig) like
  // computeRivalStandings, since it scans the whole catalog.

  // Does a catalog meta entry pass a target goal's status + diff/len band?
  // A null diff/len handle = that bound is open (axis end). A CONSTRAINED axis
  // excludes a quote whose meta is unknown (defensive; catalog rows always carry
  // d/l). Status: missing `r` is treated as ranked (matches rivalQuoteInScope).
  function targetQuotePassesMeta(m, gd) {
    if (!m) return false;
    if (gd.status === "ranked"   && m.r === false) return false;
    if (gd.status === "unranked" && m.r !== false) return false;
    if (gd.diffMin != null || gd.diffMax != null) {
      const d = Number(m.d);
      if (!Number.isFinite(d)) return false;
      if (gd.diffMin != null && d < gd.diffMin) return false;
      if (gd.diffMax != null && d > gd.diffMax) return false;
    }
    if (gd.lenMin != null || gd.lenMax != null) {
      const l = Number(m.l);
      if (!Number.isFinite(l)) return false;
      if (gd.lenMin != null && l < gd.lenMin) return false;
      if (gd.lenMax != null && l > gd.lenMax) return false;
    }
    return true;
  }

  function targetMetricOf(gd) { return gd && gd.metric === "pp" ? "pp" : "wpm"; }

  // Full tally over the catalog. Returns { hit, total, catalogSynced, selfDone }.
  function tallyTarget(gd) {
    const metric = targetMetricOf(gd);
    const target = Number(gd.target) || 0;
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    const playedOnly = gd.played === "played";
    let total = 0, hit = 0;
    for (const qid in quoteCatalog) {
      if (!targetQuotePassesMeta(quoteCatalog[qid], gd)) continue;
      const se = sq[qid];
      if (playedOnly && !se) continue;
      total++;
      const best = se ? (Number(se[metric]) || 0) : 0;
      if (best >= target) hit++;
    }
    return {
      hit, total,
      catalogSynced: catalogFullySynced(),
      selfDone: rivalBulkDone(loadRivalStore(RIVAL_SELF_NAME)),
    };
  }

  function targetFilterSig(gd) {
    return [gd.metric, gd.target, gd.status, gd.played,
            gd.diffMin, gd.diffMax, gd.lenMin, gd.lenMax].join("|");
  }
  const targetStandingsCache = new Map(); // goalId → { catEpoch, selfEpoch, sig, result }
  function computeTargetStanding(gd) {
    const catEpoch = catalogEpoch, selfEpoch = rivalStoreEpoch, sig = targetFilterSig(gd);
    const cached = targetStandingsCache.get(gd.id);
    if (cached && cached.catEpoch === catEpoch && cached.selfEpoch === selfEpoch && cached.sig === sig) {
      return cached.result;
    }
    const result = tallyTarget(gd);
    targetStandingsCache.set(gd.id, { catEpoch, selfEpoch, sig, result });
    return result;
  }

  // The not-yet-hit pool for "Next quote": catalog quotes passing the filter
  // with best < target, each with its gap (= target - best). Recomputed per
  // click off the live stores (cheap enough; not cached).
  function targetCandidates(gd) {
    const metric = targetMetricOf(gd);
    const target = Number(gd.target) || 0;
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    const playedOnly = gd.played === "played";
    const out = [];
    for (const qid in quoteCatalog) {
      if (!targetQuotePassesMeta(quoteCatalog[qid], gd)) continue;
      const se = sq[qid];
      if (playedOnly && !se) continue;
      const best = se ? (Number(se[metric]) || 0) : 0;
      if (best < target) out.push({ qid, gap: target - best });
    }
    return out;
  }

  // Per-goal Next cursor (own localStorage key). Same served-map semantics as
  // the rival Next cursor: a quote stays parked until the cycle wraps UNLESS
  // you've improved your score on it since it was served (re-eligible). Keyed by
  // goal id; GC'd against the live improvement-target goals.
  const TARGET_NEXT_CURSOR_KEY = "gt-target-next-cursor";
  function loadTargetNextCursors() {
    try { const o = JSON.parse(localStorage.getItem(TARGET_NEXT_CURSOR_KEY) || "{}"); return (o && typeof o === "object") ? o : {}; }
    catch { return {}; }
  }
  function saveTargetNextCursors(map) {
    const live = new Set((goalData.improvement || []).filter(goalIsImprovementTarget).map(g => g.id));
    for (const id of Object.keys(map)) if (!live.has(id)) delete map[id];
    try { localStorage.setItem(TARGET_NEXT_CURSOR_KEY, JSON.stringify(map)); } catch {}
  }

  function onTargetNextClicked(goalId) {
    const gd = (goalData.improvement || []).find(g => g.id === goalId && goalIsImprovementTarget(g));
    if (!gd) return;
    const cands = targetCandidates(gd);
    if (cands.length === 0) return;
    const sort = improveNextSort();
    const liveQid = getCurrentQuoteIdLive();

    let pick;
    if (sort === "random") {
      let pool = cands.map(c => c.qid);
      if (liveQid && pool.length > 1) pool = pool.filter(q => q !== liveQid);
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      cands.sort((a, b) => sort === "biggest" ? b.gap - a.gap : a.gap - b.gap);
      const sorted = cands.map(c => c.qid);
      const metric = targetMetricOf(gd);
      const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
      const selfVal = (qid) => (sq[qid] ? (Number(sq[qid][metric]) || 0) : 0);
      const cursors = loadTargetNextCursors();
      const cur = cursors[goalId];
      let served = (cur && cur.sort === sort && cur.served
        && typeof cur.served === "object" && !Array.isArray(cur.served)) ? cur.served : {};
      for (const qid of Object.keys(served)) {
        if (selfVal(qid) > served[qid] + RIVAL_PP_EPS) delete served[qid];
      }
      pick = sorted.find(q => q !== liveQid && !Object.prototype.hasOwnProperty.call(served, q));
      if (!pick) { served = {}; pick = sorted.find(q => q !== liveQid); }
      if (!pick) return;
      served[pick] = selfVal(pick);
      cursors[goalId] = { sort, served };
      saveTargetNextCursors(cursors);
    }
    window.location.href = `${location.origin}/solo/${encodeURIComponent(pick)}`;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────────
  // Values are shown with two decimals to match how TypeGG displays WPM/PP.
  function rivalFmt(v) {
    return Number.isFinite(v) ? Number(v).toFixed(2) : "0.00";
  }

  // Wins + the "you beat them worse" set for the Next button, computed over the
  // rival's whole store. self-missing counts as 0 (i.e. a loss). Memoized by
  // store epoch + metric so the chain's repeated renders don't rescan the
  // whole store (potentially thousands of quotes) every time.
  // ── Difficulty / length filter ───────────────────────────────
  // Active iff a handle is off its end. When inactive the dimension is ignored
  // (its d/l value is never read), so a default filter needs no meta at all.
  // Axis bounds derived from the rival's stored quotes (difficulty floored to
  // an integer, length floored to the nearest 1000). Cached by store epoch
  // (rebuilt when the rival stores change). Falls back to the fixed bounds
  // until at least one rival quote with meta is known.
  // Per-goal axis cache. Now keyed by goal id + rival set + scope + require-both
  // (the inputs that move the bounds), so two goals with different filters don't
  // thrash a single slot. The axis is scoped to THIS goal's rivals so the
  // popover sliders reflect the rivals the goal actually compares against.
  const rivalAxisCache = new Map();
  function goalRivalNamesSig(gd) {
    return goalRivalNames(gd).map(n => String(n).toLowerCase()).sort().join(",");
  }
  function rivalFilterAxis(rs, gd) {
    rs = rs || rivalSettings;
    const scope = rivalScope(rs);
    const requireBoth = !!rs.requireBoth;
    const gid = (gd && gd.id) || "";
    const axisKey = `${gid}:${rivalStoreEpoch}:${goalRivalNamesSig(gd)}:${scope}:${requireBoth}`;
    const hit = rivalAxisCache.get(gid);
    if (hit && hit.axisKey === axisKey) return hit;
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes; // for the "shared quotes only" pool
    let dLo = Infinity, dHi = -Infinity, lLo = Infinity, lHi = -Infinity;
    for (const rname of goalRivalNames(gd)) {
      const q = loadRivalStore(rname).quotes;
      for (const qid in q) {
        const m = rivalMetaOf(qid);
        if (!rivalQuoteInScope(m, scope)) continue;   // honour ranked/unranked status
        if (requireBoth && !(qid in sq)) continue;     // honour shared-only quote pool
        const d = Number(m.d), l = Number(m.l);
        if (Number.isFinite(d)) { if (d < dLo) dLo = d; if (d > dHi) dHi = d; }
        if (Number.isFinite(l)) { if (l < lLo) lLo = l; if (l > lHi) lHi = l; }
      }
    }
    const floorTo = (v, step) => Math.floor(v / step) * step;
    const axis = {
      axisKey,
      diffMin: Number.isFinite(dLo) ? Math.floor(dLo) : RIVAL_DIFF_MIN,
      diffMax: Number.isFinite(dHi) ? Math.floor(dHi) : RIVAL_DIFF_MAX,
      lenMin:  Number.isFinite(lLo) ? floorTo(lLo, RIVAL_LEN_AXIS_ROUND) : RIVAL_LEN_MIN,
      lenMax:  Number.isFinite(lHi) ? floorTo(lHi, RIVAL_LEN_AXIS_ROUND) : RIVAL_LEN_MAX,
    };
    if (axis.diffMax <= axis.diffMin) axis.diffMax = axis.diffMin + 1;                  // keep a usable span
    if (axis.lenMax  <= axis.lenMin)  axis.lenMax  = axis.lenMin + RIVAL_LEN_AXIS_ROUND;
    rivalAxisCache.set(gid, axis);
    return axis;
  }
  // Metric-value axis (WPM/PP) — data-driven and metric-dependent. Two ranges:
  // YOUR values (self store) and the RIVAL's (across all rival stores). Cached by
  // store epoch + metric; floored to integers; a max at the axis end = uncapped.
  const rivalMetricAxisCache = new Map();
  function rivalMetricAxis(rs, gd) {
    rs = rs || rivalSettings;
    const metric = rivalMetric(rs);
    const scope = rivalScope(rs);
    const requireBoth = !!rs.requireBoth;
    const gid = (gd && gd.id) || "";
    const key = `${gid}:${rivalStoreEpoch}:${goalRivalNamesSig(gd)}:${metric}:${scope}:${requireBoth}`;
    const hit = rivalMetricAxisCache.get(gid);
    if (hit && hit.key === key) return hit;
    let sLo = Infinity, sHi = -Infinity, rLo = Infinity, rHi = -Infinity;
    const selfQ = loadRivalStore(RIVAL_SELF_NAME).quotes;
    for (const qid in selfQ) {
      if (!rivalQuoteInScope(rivalMetaOf(qid), scope)) continue;
      const v = Number(selfQ[qid][metric]);
      if (Number.isFinite(v)) { if (v < sLo) sLo = v; if (v > sHi) sHi = v; }
    }
    for (const rname of goalRivalNames(gd)) {
      const rq = loadRivalStore(rname).quotes;
      for (const qid in rq) {
        if (!rivalQuoteInScope(rivalMetaOf(qid), scope)) continue;  // ranked/unranked
        if (requireBoth && !(qid in selfQ)) continue;               // shared-only pool
        const v = Number(rq[qid][metric]);
        if (Number.isFinite(v)) { if (v < rLo) rLo = v; if (v > rHi) rHi = v; }
      }
    }
    const fb = (metric === "pp") ? 1000 : 200; // fallback span when no data yet
    const axis = {
      key,
      selfMin:  Number.isFinite(sLo) ? Math.floor(sLo) : 0,
      selfMax:  Number.isFinite(sHi) ? Math.floor(sHi) : fb,
      rivalMin: Number.isFinite(rLo) ? Math.floor(rLo) : 0,
      rivalMax: Number.isFinite(rHi) ? Math.floor(rHi) : fb,
    };
    if (axis.selfMax  <= axis.selfMin)  axis.selfMax  = axis.selfMin  + 1;
    if (axis.rivalMax <= axis.rivalMin) axis.rivalMax = axis.rivalMin + 1;
    rivalMetricAxisCache.set(gid, axis);
    return axis;
  }
  // Resolve the stored handles (null = at an axis end) against the live axis.
  function rivalFilterState(rs, gd) {
    rs = rs || rivalSettings;
    const s = rs, axis = rivalFilterAxis(rs, gd);
    const clampD = (v) => Math.min(axis.diffMax, Math.max(axis.diffMin, v));
    const clampL = (v) => Math.min(axis.lenMax,  Math.max(axis.lenMin,  v));
    const dMin = (s.diffMin == null) ? axis.diffMin : clampD(s.diffMin);
    const dMax = (s.diffMax == null) ? axis.diffMax : clampD(s.diffMax);
    const lMin = (s.lenMin  == null) ? axis.lenMin  : clampL(s.lenMin);
    const lMax = (s.lenMax  == null) ? axis.lenMax  : clampL(s.lenMax);
    return {
      dMin, dMax, lMin, lMax, axis,
      dActive: dMin > axis.diffMin || dMax < axis.diffMax,
      lActive: lMin > axis.lenMin  || lMax < axis.lenMax,
    };
  }
  // Which stored handles apply for the CURRENT metric (per-metric storage).
  function rivalMetricKeys(rs) {
    return rivalMetric(rs) === "pp"
      ? { sMin: "mfPpSelfMin", sMax: "mfPpSelfMax", rMin: "mfPpRivalMin", rMax: "mfPpRivalMax" }
      : { sMin: "mfWpmSelfMin", sMax: "mfWpmSelfMax", rMin: "mfWpmRivalMin", rMax: "mfWpmRivalMax" };
  }
  // Resolve the metric-filter handles (null = axis end) against the live axis.
  function rivalMetricFilterState(rs, gd) {
    rs = rs || rivalSettings;
    const s = rs, axis = rivalMetricAxis(rs, gd), k = rivalMetricKeys(rs);
    const clampR = (v) => Math.min(axis.rivalMax, Math.max(axis.rivalMin, v));
    const rMin = (s[k.rMin] == null) ? axis.rivalMin : clampR(s[k.rMin]);
    const rMax = (s[k.rMax] == null) ? axis.rivalMax : clampR(s[k.rMax]);
    return {
      rMin, rMax, axis,
      rActive: rMin > axis.rivalMin || rMax < axis.rivalMax,
    };
  }
  // Signature for the standings memo so a filter change invalidates it.
  function rivalFilterSig(rs, gd) {
    const f = rivalFilterState(rs, gd);
    const m = rivalMetricFilterState(rs, gd);
    const dl = (f.dActive || f.lActive) ? `${f.dMin},${f.dMax},${f.lMin},${f.lMax}` : "";
    const mm = m.rActive ? `r${m.rMin}-${m.rMax}` : "";
    return `${dl}|${mm}`;
  }
  // Whether a quote entry passes the active filter. A CONSTRAINED dimension
  // excludes entries whose meta is unknown (legacy data not yet backfilled); a
  // dimension at full range is skipped. A max handle at the axis max = no upper
  // bound (so "14+" still includes a difficulty-14.2 quote).
  function rivalQuotePassesFilter(entry, f) {
    if (f.dActive) {
      const d = Number(entry && entry.d);
      if (!Number.isFinite(d) || d < f.dMin) return false;
      if (f.dMax < f.axis.diffMax && d > f.dMax) return false;
    }
    if (f.lActive) {
      const l = Number(entry && entry.l);
      if (!Number.isFinite(l) || l < f.lMin) return false;
      if (f.lMax < f.axis.lenMax && l > f.lMax) return false;
    }
    return true;
  }
  // Per-quote metric-value predicate. rv = the rival's value on the current
  // metric. A max handle at the axis max = no upper bound. (Filtering by YOUR
  // own value was removed: as you improve toward the rival you'd climb out of
  // your own window, so a quote could never convert to a win inside the filter.)
  function rivalMetricPasses(rv, m) {
    if (m.rActive) {
      if (!Number.isFinite(rv) || rv < m.rMin) return false;
      if (m.rMax < m.axis.rivalMax && rv > m.rMax) return false;
    }
    return true;
  }
  // ── Composite across the listed rivals ───────────────────────
  // A multi-rival goal's target on each quote is the HIGHEST score any listed
  // rival holds on that quote (beating it = beating every rival). buildRival-
  // Composite returns qid -> { v, holder, r, d, l } where v is the per-quote
  // max on `metric` and holder is the rival who set it; r/d/l are quote-level
  // (identical across rivals) so the existing scope/difficulty/length filters
  // apply unchanged. For a single-rival goal the names list is length 1, so
  // this degenerates to that rival's own entries.
  function buildRivalComposite(names, metric) {
    // Memoized against rivalRivalsEpoch (rival-store/meta changes only), so a
    // self-only PB reuses this instead of re-scanning every listed rival's full
    // quote history (×N rivals) — that synchronous re-scan was the PB stutter.
    const namesSig = names.map(n => String(n).toLowerCase()).sort().join(",");
    const cacheKey = `${namesSig}:${metric}`;
    const cached = rivalCompositeCache.get(cacheKey);
    if (cached && cached.epoch === rivalRivalsEpoch) return cached.composite;
    const out = Object.create(null);
    for (const name of names) {
      const q = loadRivalStore(name).quotes;
      for (const qid in q) {
        const e = q[qid];
        const v = Number(e[metric]);
        if (!Number.isFinite(v)) continue;
        const cur = out[qid];
        if (!cur) {
          // Quote-level meta (r/d/l) is shared + identical across rivals, so it
          // only needs reading once per quote (from the shared table).
          const m = rivalMetaOf(qid);
          out[qid] = { v, holder: name, r: m.r, d: m.d, l: m.l };
        } else if (v > cur.v + RIVAL_PP_EPS) {
          cur.v = v; cur.holder = name;
        }
      }
    }
    rivalCompositeCache.set(cacheKey, { epoch: rivalRivalsEpoch, composite: out });
    return out;
  }
  // The composite for a single quote (the live-quote render path): the max
  // `metric` value across the listed rivals plus its holder, or null if none
  // of them have raced it.
  function rivalCompositeForQuote(gd, metric, qid) {
    if (!qid) return null;
    let best = null, holder = null;
    for (const name of goalRivalNames(gd)) {
      const e = loadRivalStore(name).quotes[qid];
      if (!e) continue;
      const v = Number(e[metric]);
      if (!Number.isFinite(v)) continue;
      if (best === null || v > best + RIVAL_PP_EPS) { best = v; holder = name; }
    }
    return best === null ? null : { rv: best, holder };
  }
  // Core standings tally for an arbitrary list of rival names (length-1 for a
  // single rival). Applies every active PER-GOAL filter (scope, difficulty/
  // length, metric-value, shared-only) exactly as the card does, reading them
  // from the goal's own settings (`rs` = goalRivalCfg(gd)). NOT memoized —
  // callers that render every frame go through computeRivalStandings; the rivals
  // modal calls this directly per rival.
  function tallyStandings(names, rs, gd) {
    rs = rs || rivalSettings;
    const metric = rivalMetric(rs);
    const scope  = rivalScope(rs);
    const requireBoth = !!rs.requireBoth; // count only quotes you've both raced
    const filter = rivalFilterState(rs, gd);
    const mf = rivalMetricFilterState(rs, gd);
    const selfStore  = loadRivalStore(RIVAL_SELF_NAME);
    const selfDone   = rivalBulkDone(selfStore);     // your history fully synced?
    const sq = selfStore.quotes;
    // Composite = per-quote max across the listed rivals (length-1 list for a
    // single rival). Beating the composite value = beating every listed rival.
    const composite = buildRivalComposite(names, metric);
    let total = 0, wins = 0;
    const worse = []; // the "⚔ Next vs" pool: quotes a rival currently beats you on
    for (const qid in composite) {
      const c = composite[qid];
      if (!rivalQuoteInScope(c, scope)) continue; // only count in-scope quotes
      if ((filter.dActive || filter.lActive) && !rivalQuotePassesFilter(c, filter)) continue;
      const se = sq[qid];
      // "Shared only" mode: skip quotes you haven't raced, so the wins total
      // reflects a head-to-head on common ground rather than counting every
      // quote the rival(s) have typed (where unraced ones would read as losses).
      if (requireBoth && !se) continue;
      const rv = c.v;                  // the highest score any listed rival holds
      const sv = se ? se[metric] : 0;
      // Metric-value filter (the composite rival value), if active.
      if (mf.rActive && !rivalMetricPasses(rv, mf)) continue;
      total++;
      if (sv > rv + RIVAL_PP_EPS) { wins++; continue; } // you beat them all here
      // Not a win → candidate for the "⚔ Next vs" pool (a quote to go beat):
      if (se) {
        // You have a recorded time and you're behind (ties are neither a win
        // nor a target — you've matched but not beaten the leader).
        if (sv < rv - RIVAL_PP_EPS) worse.push(qid);
      } else if (!requireBoth && selfDone) {
        // Default ("Rival's quotes") mode: a quote you've NEVER raced is a valid
        // target — you want to beat all the rival scores, including new ones.
        // Gated on selfDone: only once your own history is fully synced does a
        // missing entry reliably mean "never raced" rather than "not synced
        // yet" (which could be a quote you've actually already won). Before that
        // these are held back so Next never sends you somewhere you've beaten.
        worse.push(qid);
      }
      // unraced while not yet synced, or in shared-only mode → not a target
    }
    // Every listed rival fully synced (so the pools are settled).
    const rivalDone = names.length > 0 && names.every(n => rivalBulkDone(loadRivalStore(n)));
    return { total, wins, worse, rivalDone, selfDone };
  }
  function computeRivalStandings(gd) {
    const rs = goalRivalCfg(gd);
    const metric = rivalMetric(rs);
    const scope  = rivalScope(rs);
    const requireBoth = !!rs.requireBoth;
    const filterSig = rivalFilterSig(rs, gd);
    const selfDone  = rivalBulkDone(loadRivalStore(RIVAL_SELF_NAME));
    // The set of listed rivals is part of the goal identity; include a signature
    // so editing the list (or a name resolving to different casing) invalidates
    // the memo even when nothing else changed.
    const names = goalRivalNames(gd);
    const namesSig = names.map(n => String(n).toLowerCase()).sort().join(",");
    const cached = rivalStandingsCache.get(gd.id);
    if (cached && cached.epoch === rivalStoreEpoch && cached.metric === metric
        && cached.scope === scope && cached.requireBoth === requireBoth
        && cached.selfDone === selfDone && cached.filterSig === filterSig
        && cached.namesSig === namesSig) {
      return cached.result;
    }
    const result = tallyStandings(names, rs, gd);
    rivalStandingsCache.set(gd.id, { epoch: rivalStoreEpoch, metric, scope, requireBoth, selfDone, filterSig, namesSig, result });
    return result;
  }

  // A rival goal's active filters as short human labels (for the modal header).
  function activeRivalFilterLabels(rs, gd) {
    rs = rs || rivalSettings;
    const out = [];
    const scope = rivalScope(rs);
    if (scope === "ranked") out.push("Ranked only");
    else if (scope === "unranked") out.push("Unranked only");
    if (rs.requireBoth) out.push("Shared quotes only");
    const f = rivalFilterState(rs, gd);
    if (f.dActive) out.push(`Difficulty ${f.dMin}\u2013${f.dMax < f.axis.diffMax ? f.dMax : f.dMax + "+"}`);
    if (f.lActive) out.push(`Length ${f.lMin}\u2013${f.lMax < f.axis.lenMax ? f.lMax : f.lMax + "+"}`);
    const mf = rivalMetricFilterState(rs, gd);
    if (mf.rActive) out.push(`${rivalMetric(rs).toUpperCase()} ${mf.rMin}\u2013${mf.rMax < mf.axis.rivalMax ? mf.rMax : mf.rMax + "+"}`);
    return out;
  }

  // The per-goal "manage rivals" modal (gear icon on a multi-rival card). Lists
  // each rival's wins vs you (respecting the active global filters), floored %
  // progress + a bar (green + ✓ at 100%), and a remove button. Sorted A–Z;
  // rebuilds after a removal. The last rival can't be removed here (delete the
  // whole goal from its card instead).
  function openRivalsModal(goalId) {
    const gd = (goalData.rival || []).find(g => g.id === goalId);
    if (!gd || !goalIsMulti(gd)) return;
    const rs = goalRivalCfg(gd);

    const overlay = document.createElement("div");
    overlay.className = "gt-rivals-overlay";
    overlay.innerHTML = `
      <div class="gt-rivals-modal">
        <div class="gt-rivals-modal-header">
          <span class="gt-rivals-modal-title">Current Rivals</span>
          <button class="gt-rivals-modal-close" title="Close" aria-label="Close">\u2715</button>
        </div>
        <div class="gt-rivals-modal-sub"></div>
        <div class="gt-rivals-filter-note" style="display:none;"></div>
        <table class="gt-rivals-table">
          <thead><tr><th>Rival</th><th>Wins</th><th>Progress</th><th></th><th></th></tr></thead>
          <tbody class="gt-rivals-tbody"></tbody>
        </table>
        <div class="gt-rivals-empty" style="display:none;">No rivals left in this goal.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const subEl   = overlay.querySelector(".gt-rivals-modal-sub");
    const noteEl  = overlay.querySelector(".gt-rivals-filter-note");
    const tbody   = overlay.querySelector(".gt-rivals-tbody");
    const emptyEl = overlay.querySelector(".gt-rivals-empty");
    const tableEl = overlay.querySelector(".gt-rivals-table");

    let refreshTimer = null;
    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // An overlaid confirm (e.g. remove-rival) owns Escape while it is up
      // — don't also close the rivals modal underneath it.
      if (document.querySelector(".gt-confirm-overlay")) return;
      e.preventDefault(); cleanup();
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", e => { if (e.target === overlay) cleanup(); });
    overlay.querySelector(".gt-rivals-modal-close").addEventListener("click", cleanup);

    // Header line + active-filter note. Cheap; safe to run on every refresh.
    const renderHeaderNote = () => {
      const metric = rivalMetric(rs);
      subEl.textContent = `Wins compared by ${metric.toUpperCase()} \u00b7 sorted A\u2013Z`;
      const labels = activeRivalFilterLabels(rs, gd);
      if (labels.length) {
        noteEl.textContent = `Filters applied (this goal): ${labels.join(" \u00b7 ")}`;
        noteEl.style.display = "";
      } else {
        noteEl.style.display = "none";
      }
    };

    // Build one rival's row (name / wins / progress / next / remove). Shared by
    // the full render and the live sync-refresh so both stay in step.
    const buildRivalRow = (name, canRemove) => {
      const { total, wins, worse, rivalDone, selfDone } = tallyStandings([name], rs, gd);
      const pct  = total > 0 ? Math.floor((wins / total) * 100) : 0;
      const done = total > 0 && wins >= total;

      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.className = "gt-rivals-name";
      nameTd.textContent = name;

      const winsTd = document.createElement("td");
      winsTd.className = "gt-rivals-wins";
      // Wins depend on YOUR PBs too, so they stay provisional until the self
      // store is done as well -- not just this rival's store (matches the card).
      const rowSynced = rivalDone && selfDone;
      winsTd.textContent = rowSynced ? `${wins} / ${total}` : `${wins} / ${total} \u00b7 syncing\u2026`;

      const progTd = document.createElement("td");
      progTd.className = "gt-rivals-progress-cell";
      const bar = document.createElement("div");
      bar.className = "gt-rivals-bar";
      const fill = document.createElement("div");
      fill.className = "gt-rivals-bar-fill" + (done ? " done" : "");
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      const pctLine = document.createElement("div");
      pctLine.className = "gt-rivals-pct";
      pctLine.textContent = `${pct}%`;
      if (done) {
        const chk = document.createElement("span");
        chk.className = "done-check";
        chk.textContent = "\u2713";
        pctLine.appendChild(chk);
      }
      progTd.appendChild(bar);
      progTd.appendChild(pctLine);

      // Per-rival "Next vs" -- jump to the next quote where THIS rival beats you
      // (single-rival scope, not the goal's composite). Enabled only when this
      // rival currently leads on some in-scope quote.
      const nextTd = document.createElement("td");
      nextTd.className = "gt-rivals-next-cell";
      const nextBtn = document.createElement("button");
      nextBtn.className = "gt-rivals-next";
      nextBtn.textContent = "\u2694"; // crossed swords
      const canNext = worse.length > 0;
      nextBtn.disabled = !canNext;
      if (canNext) {
        nextBtn.title = `Next quote where ${name} beats you`;
      } else if (!rivalDone || !selfDone) {
        nextBtn.title = "Finding quotes\u2026";
      } else if (total === 0) {
        nextBtn.title = "No quotes match the current filters";
      } else {
        nextBtn.title = `All ${name}'s quotes beaten \ud83e\udd47`;
      }
      nextBtn.addEventListener("click", () => {
        if (!nextBtn.disabled) onRivalRowNextClicked(goalId, name);
      });
      nextTd.appendChild(nextBtn);

      const removeTd = document.createElement("td");
      removeTd.className = "gt-rivals-remove-cell";
      const x = document.createElement("button");
      x.className = "gt-rivals-remove";
      x.textContent = "\u2715";
      x.disabled = !canRemove;
      x.title = canRemove
        ? `Remove ${name}`
        : "A multiple-rivals goal needs at least one rival \u2014 delete the goal from its card instead.";
      x.addEventListener("click", async () => {
        if (x.disabled) return;
        // Confirm first (mirrors goal deletion) instead of removing instantly.
        const ok = await showConfirmModal({
          title: "Remove rival?",
          message: `Remove ${name} from this goal?`,
          warning: "Their head-to-head results stop counting toward this goal. You can add them back later.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        // Re-check at confirm time: never strip the goal's last rival (a second
        // open confirm could otherwise empty it), and no-op if already gone.
        if (goalRivalNames(gd).length <= 1) return;
        if (!goalRivalNames(gd).some(n => n.toLowerCase() === name.toLowerCase())) return;
        gd.rivals = gd.rivals.filter(n => n.toLowerCase() !== name.toLowerCase());
        saveGoals("rival");
        renderAllGoals();
        if (isLeader) ensureRivalSync(); // GC the dropped rival's store if now unreferenced
        renderTable();
      });
      removeTd.appendChild(x);

      tr.appendChild(nameTd);
      tr.appendChild(winsTd);
      tr.appendChild(progTd);
      tr.appendChild(nextTd);
      tr.appendChild(removeTd);
      return tr;
    };

    // Live refresh of just the rival rows (Task 2): re-runs while the modal is
    // open so wins / % / progress / syncing->final track stores arriving,
    // WITHOUT rebuilding the add-rival row -- so a half-typed username + its
    // focus survive a background sync. Replaces only the data rows, in place.
    const syncRivalRows = () => {
      renderHeaderNote();
      const names = goalRivalNames(gd).slice().sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()));
      if (names.length === 0) { tableEl.style.display = "none"; emptyEl.style.display = ""; return; }
      tableEl.style.display = ""; emptyEl.style.display = "none";
      const canRemove = names.length > 1;
      // Drop existing rival rows but keep the add + status rows untouched.
      Array.from(tbody.children).forEach(tr => {
        if (!tr.classList.contains("gt-rivals-add-row")
          && !tr.classList.contains("gt-rivals-add-status-row")) tr.remove();
      });
      const addRow = tbody.querySelector(".gt-rivals-add-row");
      for (const name of names) {
        const row = buildRivalRow(name, canRemove);
        if (addRow) tbody.insertBefore(row, addRow);
        else tbody.appendChild(row);
      }
    };

    const renderTable = () => {
      renderHeaderNote();
      const names = goalRivalNames(gd).slice().sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()));
      tbody.innerHTML = "";
      if (names.length === 0) { tableEl.style.display = "none"; emptyEl.style.display = ""; return; }
      tableEl.style.display = ""; emptyEl.style.display = "none";
      const canRemove = names.length > 1;
      for (const name of names) {
        tbody.appendChild(buildRivalRow(name, canRemove));
      }

      // ── Add-rival row ────────────────────────────────────────
      // Below the last rival, in the name column: a "Username" input + "+ Add"
      // to grow this multi-rival goal after creation. The name is validated
      // against the API first (canonical case resolved; 404 / duplicate / throttle
      // handled) — same as the create flow — so a typo can't add a phantom rival
      // whose store would just sync forever empty.
      const addTr = document.createElement("tr");
      addTr.className = "gt-rivals-add-row";
      const addInputTd = document.createElement("td");
      addInputTd.className = "gt-rivals-add-cell";
      const addInput = document.createElement("input");
      addInput.type = "text";
      addInput.className = "gt-rivals-add-input";
      addInput.placeholder = "Username";
      addInput.maxLength = 40;
      addInput.autocomplete = "off";
      addInput.spellcheck = false;
      addInputTd.appendChild(addInput);
      const addBtnTd = document.createElement("td");
      addBtnTd.className = "gt-rivals-add-btn-cell";
      addBtnTd.colSpan = 4;
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "gt-rivals-add-btn";
      addBtn.textContent = "+ Add";
      addBtnTd.appendChild(addBtn);
      addTr.appendChild(addInputTd);
      addTr.appendChild(addBtnTd);
      tbody.appendChild(addTr);

      const statusTr = document.createElement("tr");
      statusTr.className = "gt-rivals-add-status-row";
      const statusTd = document.createElement("td");
      statusTd.colSpan = 5;
      statusTd.className = "gt-rivals-add-status";
      statusTd.style.display = "none";
      statusTr.appendChild(statusTd);
      tbody.appendChild(statusTr);

      const setAddStatus = (msg, isError) => {
        if (!msg) { statusTd.style.display = "none"; statusTd.textContent = ""; return; }
        statusTd.textContent = msg;
        statusTd.className = "gt-rivals-add-status" + (isError ? " gt-rivals-add-status-error" : "");
        statusTd.style.display = "";
      };

      let adding = false;
      const doAddRival = async () => {
        if (adding) return;
        const typed = addInput.value.trim();
        if (!typed) { setAddStatus("Enter a username", true); addInput.focus(); return; }
        if (goalRivalNames(gd).some(n => n.toLowerCase() === typed.toLowerCase())) {
          setAddStatus(`${typed} is already in this goal`, true); return;
        }
        adding = true; addBtn.disabled = true; setAddStatus("Checking\u2026", false);
        try {
          const url = `https://api.typegg.io/v1/users/${encodeURIComponent(typed)}`;
          const r = await gtApiFetch(url, { headers: authHeaders() });
          if (r.status === 404) throw new Error("not found");
          if (!r.ok) throw new Error("busy"); // 429/5xx — not a "no such user"
          const d = await r.json();
          const resolved = d?.username || typed;
          // Re-check against the resolved (canonical) name and the live list.
          if (goalRivalNames(gd).some(n => n.toLowerCase() === resolved.toLowerCase())) {
            setAddStatus(`${resolved} is already in this goal`, true);
            adding = false; addBtn.disabled = false; return;
          }
          gd.rivals.push(resolved);
          saveGoals("rival");
          renderAllGoals();
          if (isLeader) ensureRivalSync(); // build the new rival's store
          adding = false;
          renderTable(); // rebuild: the new rival appears + a fresh empty input
          const fresh = tbody.querySelector(".gt-rivals-add-input");
          if (fresh) fresh.focus();
        } catch (err) {
          // A throttle / network error shouldn't claim the user doesn't exist.
          const couldntCheck = err?.gtThrottled || err?.message === "busy" || (err instanceof TypeError);
          setAddStatus(couldntCheck ? "Can't reach TypeGG \u2014 try again in a moment" : "User not found", true);
          adding = false; addBtn.disabled = false; addInput.focus();
        }
      };
      addBtn.addEventListener("click", doAddRival);
      addInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doAddRival(); } });
      addInput.addEventListener("input", () => { if (statusTd.style.display !== "none") setAddStatus("", false); });
    };

    renderTable();
    // Keep the rows live while the modal is open: the rival-store epoch bumps on
    // local sync progress AND incoming cross-tab broadcasts, so poll it and
    // re-sync the rows (only) whenever it changes. Torn down in cleanup().
    let lastEpoch = rivalStoreEpoch;
    refreshTimer = setInterval(() => {
      if (rivalStoreEpoch !== lastEpoch) {
        lastEpoch = rivalStoreEpoch;
        syncRivalRows();
      }
    }, 500);
  }

  function renderRivalSections() {
    const goals = goalData.rival || [];
    const liveQid = getCurrentQuoteIdLive();
    for (const gd of goals) {
      const goalId = gd.id;
      let gid = findGroupIdOfGoal(goalId);
      if (!gid) { groupData[MAIN_GROUP_ID].goalIds.push(goalId); saveGroups(); gid = MAIN_GROUP_ID; }
      const targetContent = contentElForGroup(gid) || container.querySelector(".gt-content");
      let section = document.getElementById(`${goalId}-goal-section`);
      if (!section) {
        section = createGoalSection(goalId, "rival", GOAL_CONFIG.rival, targetContent);
      } else if (section.parentNode !== targetContent) {
        const isFloating = dragInProgress && gDrag?.goalId === goalId;
        if (!isFloating) targetContent.appendChild(section);
      }
      updateRivalGoalSection(goalId, gd, liveQid);
    }
    // Fill the current quote's bests on demand (leader) so the compare line
    // is accurate even mid-bulk. Only when at least one rival goal exists —
    // otherwise there's nothing to compare and no reason to fetch the self best.
    if (liveQid && goals.length > 0) ensureCurrentQuoteForRivals(liveQid);
    scheduleRivalStandingsRefresh();
  }

  // Coalesce the (potentially expensive) Wins/Next standings recompute for every
  // rival goal into one deferred pass per tick, so it never runs in the same
  // synchronous block as the cheap value-row + gain-pill update above. Reads
  // goalData.rival fresh when it fires (not captured now) so a goal added or
  // removed between scheduling and firing is handled correctly.
  let rivalStandingsRefreshPending = false;
  function scheduleRivalStandingsRefresh() {
    if (rivalStandingsRefreshPending) return;
    rivalStandingsRefreshPending = true;
    setTimeout(() => {
      rivalStandingsRefreshPending = false;
      for (const gd of (goalData.rival || [])) {
        if (document.getElementById(`${gd.id}-goal-section`)) {
          updateRivalGoalSectionStandings(gd.id, gd);
        }
      }
    }, 0);
  }

  function updateRivalGoalSection(goalId, gd, liveQid) {
    const rs = goalRivalCfg(gd);
    const metric = rivalMetric(rs);
    const names = goalRivalNames(gd);
    const multi = goalIsMulti(gd);
    const rivalName = multi
      ? (names.length === 1 ? names[0] : `${names.length} rivals`)
      : (gd.rival || "rival");

    const labelEl = document.getElementById(`${goalId}-label`);
    if (labelEl) labelEl.textContent = `Rival vs ${rivalName}`;
    const badge = document.getElementById(`${goalId}-metric-badge`);
    if (badge) badge.textContent = metric.toUpperCase();
    const gearEl = document.getElementById(`${goalId}-rival-gear`);
    if (gearEl) gearEl.style.display = multi ? "" : "none";

    const selfStore  = loadRivalStore(RIVAL_SELF_NAME);

    const wrapEl = document.getElementById(`${goalId}-rival-value-wrap`);
    const youEl  = document.getElementById(`${goalId}-rival-you`);
    const themEl = document.getElementById(`${goalId}-rival-them`);
    const msgEl  = document.getElementById(`${goalId}-rival-msg`);

    // Helper: switch the value row into "message" mode (loading / status).
    const showMsg = (text) => {
      const gain = document.getElementById(`${goalId}-rival-gain`);
      if (gain) gain.remove();
      if (wrapEl) wrapEl.style.display = "none";
      if (msgEl) { msgEl.textContent = text; msgEl.style.display = ""; }
    };

    const sKey = rivalStoreKey(RIVAL_SELF_NAME);
    // Composite (highest score across the listed rivals) for the live quote;
    // for a single-rival goal this is just that rival's entry + their name.
    const comp = liveQid ? rivalCompositeForQuote(gd, metric, liveQid) : null;
    const sEntry = liveQid ? selfStore.quotes[liveQid]  : undefined;

    // Does the live quote fall inside this goal's filtered pool? Mirrors the
    // accept logic in tallyStandings exactly (scope, difficulty/length, the
    // rival metric-value band, and shared-only). A quote the rival has raced but
    // which the filters exclude can never move the Wins count, so we say so
    // rather than showing a comparison that looks like it would count. Only
    // meaningful once the rival's value is known (comp present).
    const liveInPool = (() => {
      if (!liveQid || !comp) return true;
      const meta = rivalMetaOf(liveQid);
      if (!rivalQuoteInScope(meta, rivalScope(rs))) return false;
      const filter = rivalFilterState(rs, gd);
      if ((filter.dActive || filter.lActive) && !rivalQuotePassesFilter(meta, filter)) return false;
      if (rs.requireBoth && !sEntry) return false; // shared-only: must have raced it too
      const mf = rivalMetricFilterState(rs, gd);
      if (mf.rActive && !rivalMetricPasses(comp.rv, mf)) return false;
      return true;
    })();

    if (!liveQid) {
      showMsg("Race a quote to compare");
    } else if (comp && !liveInPool) {
      showMsg("Quote doesn't match filters");
    } else if (comp) {
      // ── Value mode ──
      // We know the rival number (the highest among the listed rivals), so
      // render the matchup immediately. Your number defaults to 0 when you've
      // never raced this quote (the "Next vs" target case) — no fetch wait.
      const rv = comp.rv;
      const sv = sEntry ? sEntry[metric] : 0;
      const settled = !!sEntry || isRememberedAbsent(sKey, liveQid) || rivalBulkDone(selfStore);

      if (msgEl)  msgEl.style.display = "none";
      if (wrapEl) wrapEl.style.display = "";
      if (youEl) {
        youEl.textContent = rivalFmt(sv);
        // Green once you've matched or beaten them on this quote (same
        // "reached the target" feel as the average goals).
        youEl.className = "gt-rival-you" + (sv >= rv - RIVAL_PP_EPS ? " gt-rival-you-done" : "");
      }
      if (themEl) themEl.textContent = multi
        ? ` / ${rivalFmt(rv)} (${comp.holder})`
        : ` / ${rivalFmt(rv)}`;

      // +X gain pill: pops when your value on THIS quote rises (i.e. you just
      // set a new best here). Only baseline/compare once self is settled, so
      // a 0→real correction (from the on-demand fill) never flashes a phantom
      // gain, and a quote change re-baselines instead of comparing across
      // different quotes.
      if (settled && wrapEl) {
        const prev = prevRivalYouMap[goalId];
        if (prev && prev.quoteId === liveQid && prev.metric === metric && prev.value > RIVAL_PP_EPS && sv > prev.value + RIVAL_PP_EPS) {
          const delta = sv - prev.value;
          if (Number(delta.toFixed(2)) > 0) {
            const existing = document.getElementById(`${goalId}-rival-gain`);
            if (existing) existing.remove();
            const ind = document.createElement("span");
            ind.id = `${goalId}-rival-gain`;
            ind.className = "gt-gain-indicator";
            ind.textContent = `+${delta.toFixed(2)}`;
            wrapEl.appendChild(ind);
            ind.addEventListener("animationend", () => ind.remove());
          }
        }
        prevRivalYouMap[goalId] = { quoteId: liveQid, value: sv, metric };
      }
    } else {
      // Rival number unknown for this quote. "Resolved" = every listed rival is
      // either fully synced or confirmed to have never raced this quote.
      const rivalResolved = names.length > 0 && names.every(n =>
        rivalBulkDone(loadRivalStore(n)) || isRememberedAbsent(rivalStoreKey(n), liveQid));
      const noneMsg = multi ? "No rival has raced this quote" : `${rivalName} hasn't raced this quote`;
      showMsg(rivalResolved ? noneMsg : "Loading…");
    }

    // ── Filter display lines (mirror the improvement-target card) ──
    // Rival filters are PER-GOAL now, so each card shows its own pool + band.
    // Line 1 (cyan): the quote pool (scope + shared). Line 2 (darker blue): the
    // length / difficulty / metric bands, hidden when all are full-range.
    const rivalPoolEl = document.getElementById(`${goalId}-rival-pool`);
    if (rivalPoolEl) {
      const poolParts = [];
      const psc = rivalScope(rs);
      if (psc === "ranked")        poolParts.push("Ranked");
      else if (psc === "unranked") poolParts.push("Unranked");
      if (rs.requireBoth) poolParts.push("Shared");
      rivalPoolEl.textContent = `Quote Pool: ${poolParts.length ? poolParts.join(", ") : "All"}`;
      rivalPoolEl.style.display = "block";
    }
    const rivalBandEl = document.getElementById(`${goalId}-rival-band`);
    if (rivalBandEl) {
      const f  = rivalFilterState(rs, gd);
      const mf = rivalMetricFilterState(rs, gd);
      const bandParts = [];
      if (f.lActive) {
        const s = gtFilterBand("Len", f.lMin, f.lMax, f.lMin <= f.axis.lenMin, f.lMax >= f.axis.lenMax);
        if (s) bandParts.push(s);
      }
      if (f.dActive) {
        const s = gtFilterBand("Diff", f.dMin, f.dMax, f.dMin <= f.axis.diffMin, f.dMax >= f.axis.diffMax);
        if (s) bandParts.push(s);
      }
      if (mf.rActive) {
        const s = gtFilterBand(rivalMetric(rs).toUpperCase(), mf.rMin, mf.rMax, mf.rMin <= mf.axis.rivalMin, mf.rMax >= mf.axis.rivalMax);
        if (s) bandParts.push(s);
      }
      rivalBandEl.textContent = bandParts.join(" \u2022 ");
      rivalBandEl.style.display = bandParts.length ? "block" : "none";
    }

    // Wins line + "⚔ Next vs" button are recomputed separately by
    // updateRivalGoalSectionStandings, deferred a tick by renderRivalSections so
    // the heavier full-store standings scan can't delay the cheap value-row + +X
    // gain-pill paint above (see the comment there).
  }

  // The "Wins: X / Y" line, the syncing… status, and the "⚔ Next vs" button.
  // Split out of updateRivalGoalSection because computeRivalStandings (via
  // tallyStandings/buildRivalComposite) scans every quote in each listed rival's
  // history; on a goal with thousands of races synced that's enough work that
  // running it inline — in the same synchronous pass that inserts the +X gain
  // pill — delays the next paint and makes the pop-in animation visibly late on a
  // PB. renderRivalSections calls this on a deferred tick so the value row + pill
  // paint first and this heavier recompute lands a frame later, unfelt.
  function updateRivalGoalSectionStandings(goalId, gd) {
    const names = goalRivalNames(gd);
    const multi = goalIsMulti(gd);
    const rivalName = multi
      ? (names.length === 1 ? names[0] : `${names.length} rivals`)
      : (gd.rival || "rival");

    const { total, wins, worse, rivalDone, selfDone } = computeRivalStandings(gd);
    // Live combined self + rival bulk-build %, shared by the wins line and the
    // Next button. Climbs until BOTH your history and the rival store(s) sync.
    const rivalPct = rivalSyncPercent(gd);
    const rivalSyncLbl = rivalPct == null ? "syncing…" : `syncing… (${rivalPct}%)`;
    const winsEl = document.getElementById(`${goalId}-rival-wins`);
    if (winsEl) {
      // Scope + shared now live in the Quote Pool line above; keep Wins clean.
      winsEl.textContent = (goalCountView(gd) === "remaining")
        ? `Wins: ${total - wins} to go`
        : `Wins: ${wins} / ${total}`;
    }
    // Build status on its own muted line below the wins (hidden once synced).
    const rivalSyncEl = document.getElementById(`${goalId}-rival-sync`);
    if (rivalSyncEl) {
      // Settle on BOTH legs: the wins stay provisional while the self store is
      // still paging in, even after every rival store is done, so keep the live
      // % visible until self is done too (matches the Target card + Next button).
      const settled = rivalDone && selfDone;
      rivalSyncEl.textContent = settled ? "" : rivalSyncLbl;
      rivalSyncEl.style.display = settled ? "none" : "block";
    }
    const nextBtn = document.getElementById(`${goalId}-rival-next`);
    if (nextBtn) {
      if (worse.length > 0) {
        nextBtn.disabled = false;
        nextBtn.textContent = `⚔ Next vs ${rivalName}`;
      } else if (!rivalDone || !selfDone) {
        // Still building the pools — in default mode the unraced targets only
        // appear once your own history is synced, so wait on selfDone too before
        // claiming you're ahead on everything.
        nextBtn.disabled = true;
        nextBtn.textContent = "⚔ Finding quotes…";
      } else if (total === 0) {
        // No quote survived the current scope + filters (+ shared-only) — there's
        // nothing to be ahead OR behind on, so "You lead" would be misleading.
        nextBtn.disabled = true;
        nextBtn.textContent = "⚔ No quotes found";
      } else {
        nextBtn.disabled = true;
        nextBtn.textContent = "All Quotes beaten 🥇";
      }
    }
  }

  // Active Next-vs sort order (validated): "random" | "closest" | "biggest".
  function rivalNextSort() {
    const s = rivalSettings.nextSort;
    return RIVAL_NEXT_SORT_VALUES.includes(s) ? s : "random";
  }

  // The Next-vs pool sorted by gap on the goal's OWN metric. Gap = rival value −
  // your value (always > 0 for worse quotes). "closest" → smallest gap first,
  // "biggest" → largest first. Returns an array of quoteIds. Recomputed every
  // click off the live stores, so it tracks the rival's new quotes / PBs.
  function rivalWorseSortedByGap(gd, sort) {
    const metric = rivalMetric(goalRivalCfg(gd));
    const { worse } = computeRivalStandings(gd);
    const composite = buildRivalComposite(goalRivalNames(gd), metric);
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    const withGap = worse.map(qid => {
      const rv = composite[qid] ? composite[qid].v : 0;
      const sv = sq[qid] ? sq[qid][metric] : 0;
      return { qid, gap: rv - sv };
    });
    withGap.sort((a, b) => sort === "biggest" ? b.gap - a.gap : a.gap - b.gap);
    return withGap.map(x => x.qid);
  }

  // The sorted Next-vs modes walk the pool one quote per click, wrapping at the
  // end. Because clicking the button does a full page navigation (which wipes
  // in-memory state), the cursor is persisted to localStorage: per goal we store
  // the sort it was built under plus a `served` map { quoteId -> self value (on
  // the goal's metric) at the time it was served }. A served quote is skipped
  // until the cycle wraps UNLESS you've since improved your score on it (current
  // self value beats the recorded serve-time value), in which case it re-enters
  // the rotation and re-sorts to its new, smaller gap. Switching the sort order
  // (or finishing the cycle) starts fresh. (Legacy cursors stored `served` as a
  // flat array; those are treated as a fresh cycle on first use.)
  const RIVAL_NEXT_CURSOR_KEY = "gt-rival-next-cursor";
  function loadRivalNextCursors() {
    try { const o = JSON.parse(localStorage.getItem(RIVAL_NEXT_CURSOR_KEY) || "{}"); return (o && typeof o === "object") ? o : {}; }
    catch { return {}; }
  }
  function saveRivalNextCursors(map) {
    // Drop cursors for goals that no longer exist so the key can't grow forever.
    const live = new Set((goalData.rival || []).map(g => g.id));
    for (const id of Object.keys(map)) if (!live.has(id)) delete map[id];
    try { localStorage.setItem(RIVAL_NEXT_CURSOR_KEY, JSON.stringify(map)); } catch {}
  }

  function onRivalNextClicked(goalId) {
    const gd = (goalData.rival || []).find(g => g.id === goalId);
    if (!gd) return;
    const liveQid = getCurrentQuoteIdLive();
    const sort = rivalNextSort();

    let pick;
    if (sort === "random") {
      // Unordered: a random quote where the rival beats you, avoiding the one
      // you're already on when there's a choice.
      const { worse } = computeRivalStandings(gd);
      if (worse.length === 0) return;
      let pool = worse;
      if (liveQid && worse.length > 1) pool = worse.filter(q => q !== liveQid);
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      // Sorted: step through the pool by gap, one quote per click. The cursor's
      // `served` is a map { qid -> self value (on gd.metric) at serve time }, so
      // we can tell an improved quote from a parked one (see the doc above).
      const sorted = rivalWorseSortedByGap(gd, sort);
      if (sorted.length === 0) return;
      const metric = rivalMetric(goalRivalCfg(gd));
      const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
      const selfVal = (qid) => (sq[qid] ? sq[qid][metric] : 0);
      const cursors = loadRivalNextCursors();
      const cur = cursors[goalId];
      // Fresh cycle on first use, on a sort switch, or for the legacy array shape.
      let served = (cur && cur.sort === sort && cur.served
        && typeof cur.served === "object" && !Array.isArray(cur.served))
        ? cur.served : {};
      const isParked = (q) => Object.prototype.hasOwnProperty.call(served, q);
      // Re-eligibility: drop any served quote you've IMPROVED since serving it
      // (current self value beats the captured serve-time value) so it can be
      // met again at its new, smaller gap. (A quote you beat outright already
      // left `worse`, so it isn't in `sorted` at all.)
      for (const qid of Object.keys(served)) {
        if (selfVal(qid) > served[qid] + RIVAL_PP_EPS) delete served[qid];
      }
      // Pick the first quote that's neither parked nor the one you're on. The
      // current-quote exclusion always wins for this pick — even a just-improved
      // liveQid is skipped now (else Next would reload the same quote); it can be
      // served again on a later click once you've moved off it.
      pick = sorted.find(q => q !== liveQid && !isParked(q));
      if (!pick) {                         // whole cycle served → wrap, start fresh
        served = {};
        pick = sorted.find(q => q !== liveQid);
      }
      if (!pick) return;                   // only the current quote is a target
      served[pick] = selfVal(pick);        // record serve-time self value
      cursors[goalId] = { sort, served };
      saveRivalNextCursors(cursors);
    }

    const base = `${location.origin}/solo/${encodeURIComponent(pick)}`;
    // Global setting (Settings → Rival): optionally open the head-to-head
    // "/vs/<rival>" page instead of the quote on its own.
    const url = (rivalSettings.nextUsesVsLink && gd.rival)
      ? `${base}/vs/${encodeURIComponent(gd.rival)}`
      : base;
    window.location.href = url;
  }

  // The single-rival analogue of rivalWorseSortedByGap: given an explicit names
  // list (here always one rival) and its already-computed "worse" set, order the
  // pool by gap on the goal's metric. Kept separate from the card path so the
  // composite cursor logic stays untouched.
  function rivalRowWorseSortedByGap(names, worse, sort, rs) {
    const metric = rivalMetric(rs);
    const composite = buildRivalComposite(names, metric);
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    const withGap = worse.map(qid => {
      const rv = composite[qid] ? composite[qid].v : 0;
      const sv = sq[qid] ? sq[qid][metric] : 0;
      return { qid, gap: rv - sv };
    });
    withGap.sort((a, b) => sort === "biggest" ? b.gap - a.gap : a.gap - b.gap);
    return withGap.map(x => x.qid);
  }

  // Per-(goal, rival) Next-vs cursors. Own localStorage key: the composite keys
  // here aren't goal ids, so saveRivalNextCursors would GC them. Same served-map
  // semantics as the card cursor; keyed by goalId + NUL + lower(name).
  const RIVAL_ROW_NEXT_CURSOR_KEY = "gt-rival-row-next-cursor";
  function rivalRowCursorKey(goalId, name) { return goalId + "\u0000" + String(name).toLowerCase(); }
  function loadRivalRowNextCursors() {
    try { const o = JSON.parse(localStorage.getItem(RIVAL_ROW_NEXT_CURSOR_KEY) || "{}"); return (o && typeof o === "object") ? o : {}; }
    catch { return {}; }
  }
  function saveRivalRowNextCursors(map) {
    // Drop cursors whose owning goal no longer exists so the key can't grow forever.
    const live = new Set((goalData.rival || []).map(g => g.id));
    for (const k of Object.keys(map)) {
      const gid = k.split("\u0000")[0];
      if (!live.has(gid)) delete map[k];
    }
    try { localStorage.setItem(RIVAL_ROW_NEXT_CURSOR_KEY, JSON.stringify(map)); } catch {}
  }

  // Per-rival "Next vs" (manage-rivals modal row). Mirrors onRivalNextClicked but
  // scoped to ONE rival: navigates to the next quote where that rival beats you.
  // Honors the global nextSort + nextUsesVsLink settings; sorted modes walk a
  // per-(goal, rival) cursor (a full page nav wipes in-memory state).
  function onRivalRowNextClicked(goalId, name) {
    const gd = (goalData.rival || []).find(g => g.id === goalId);
    if (!gd) return;
    const rs = goalRivalCfg(gd);
    const liveQid = getCurrentQuoteIdLive();
    const sort = rivalNextSort();
    const { worse } = tallyStandings([name], rs, gd);
    if (worse.length === 0) return;

    let pick;
    if (sort === "random") {
      let pool = worse;
      if (liveQid && worse.length > 1) pool = worse.filter(q => q !== liveQid);
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      const sorted = rivalRowWorseSortedByGap([name], worse, sort, rs);
      if (sorted.length === 0) return;
      const metric = rivalMetric(rs);
      const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
      const selfVal = (qid) => (sq[qid] ? sq[qid][metric] : 0);
      const cursors = loadRivalRowNextCursors();
      const ckey = rivalRowCursorKey(goalId, name);
      const cur = cursors[ckey];
      // Fresh cycle on first use, on a sort switch, or for any legacy shape.
      let served = (cur && cur.sort === sort && cur.served
        && typeof cur.served === "object" && !Array.isArray(cur.served))
        ? cur.served : {};
      const isParked = (q) => Object.prototype.hasOwnProperty.call(served, q);
      // Re-eligibility: a served quote you've since IMPROVED re-enters the cycle.
      for (const qid of Object.keys(served)) {
        if (selfVal(qid) > served[qid] + RIVAL_PP_EPS) delete served[qid];
      }
      pick = sorted.find(q => q !== liveQid && !isParked(q));
      if (!pick) {                         // whole cycle served -> wrap, start fresh
        served = {};
        pick = sorted.find(q => q !== liveQid);
      }
      if (!pick) return;                   // only the current quote is a target
      served[pick] = selfVal(pick);        // record serve-time self value
      cursors[ckey] = { sort, served };
      saveRivalRowNextCursors(cursors);
    }

    const base = `${location.origin}/solo/${encodeURIComponent(pick)}`;
    const url = rivalSettings.nextUsesVsLink
      ? `${base}/vs/${encodeURIComponent(name)}`
      : base;
    window.location.href = url;
  }

  // ── Rank goal target computation ──────────────────────────────
  // Returns the effective target PP and the rank being tracked against,
  // based on where the player currently sits relative to their target rank.
  async function computeRankTarget(targetRank, currentRank) {
    // Player is still trying to reach the target rank — track that rank's PP
    if (currentRank == null || currentRank > targetRank) {
      const pp = await getPpByRank(targetRank);
      return { pp, trackedRank: targetRank };
    }
    // Player is AT or ABOVE the target rank — track the rank just below (targetRank + 1)
    // so the goal shows how much PP buffer they have before dropping
    const pp = await getPpByRank(targetRank + 1);
    return { pp, trackedRank: targetRank + 1 };
  }

  async function computeExpRankTarget(targetRank, currentRank) {
    // Player is still trying to reach the target rank — track that rank's EXP
    if (currentRank == null || currentRank > targetRank) {
      const exp = await getExpByRank(targetRank);
      return { exp, trackedRank: targetRank };
    }
    // Player is AT or ABOVE the target rank — track the rank just below (targetRank + 1)
    // so the goal shows how much EXP buffer they have before dropping
    const exp = await getExpByRank(targetRank + 1);
    return { exp, trackedRank: targetRank + 1 };
  }

  async function updateRankGoals() {
    try {
      const goals = goalData.pp;
      if (!goals || goals.length === 0) return;
      if (currentStats.pp == null) return;

      // ── Within-run page cache ────────────────────────────────
      // If 3 goals target ranks 45/50/55, they all live on page 3
      // of a perPage=20 leaderboard — fetch that page ONCE, not 3x.
      const pageCache = new Map();
      const ppByRank = async (rank) => {
        const perPage = 20;
        const page    = Math.ceil(rank / perPage);
        if (!pageCache.has(page)) {
          const url = withLang(`https://api.typegg.io/v1/leaders?sort=totalPp&page=${page}&perPage=${perPage}`);
          pageCache.set(page, gtApiFetch(url, { headers: authHeaders() }).then(r => {
            if (!r.ok) throw new Error("Leaderboard fetch failed");
            return r.json();
          }));
        }
        const data = await pageCache.get(page);
        const u = data.users?.find(u => u.stats?.ranking === rank);
        if (!u) throw new Error(`Rank #${rank} not found on page ${page}`);
        return u.stats.totalPp;
      };

      for (let i = 0; i < goals.length; i++) {
        let gd = goals[i];
        if (!gd.targetRank) continue;

        if (gd.nextRank) {
          // ── Next-rank goal ─────────────────────────────────────
          if (currentStats.rank == null || currentStats.rank <= 1) continue;
          const nextRank = currentStats.rank - 1;

          if (gd.targetRank !== nextRank) {
            // User ranked up — reset baseline to current PP and track new next rank
            gd.baselinePp  = currentStats.pp;
            gd.targetRank  = nextRank;
            const newPp    = await ppByRank(nextRank);
            gd.target      = Math.max(0, newPp - gd.baselinePp);
            gd.targetLoaded = true;
            gtLog("Next-rank goal — ranked up", `now chasing rank #${nextRank}`, { targetRank: nextRank, newBaselinePp: gd.baselinePp, rankHolderPp: newPp, ppNeeded: gd.target });
            goals[i] = gd;
            saveGoals("pp");
            continue;
          }

          // Same rank — dynamically update target PP in case the leaderboard shifted
          const newPp    = await ppByRank(nextRank);
          const newTarget = Math.max(0, newPp - gd.baselinePp);
          if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
            gtLog("Next-rank goal target updated", `rank #${nextRank} PP shifted — PP needed ${gd.target} → ${Math.round(newTarget * 100) / 100}`, { targetRank: nextRank, rankHolderPp: newPp, baselinePp: gd.baselinePp, target: { from: gd.target, to: newTarget } });
            gd.target   = newTarget;
            gd.targetLoaded = true;
            goals[i] = gd;
            saveGoals("pp");
          }
          continue;
        }

        // ── Regular rank goal ──────────────────────────────────
        // Track targetRank if currentRank > targetRank, else track targetRank+1
        const trackedRank = (currentStats.rank == null || currentStats.rank > gd.targetRank)
          ? gd.targetRank
          : gd.targetRank + 1;
        const newPp = await ppByRank(trackedRank);
        const newTarget = Math.max(0, newPp - gd.baselinePp);

        if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
          gtLog("Rank goal target updated", `tracking rank #${trackedRank} — PP needed ${gd.target} → ${Math.round(newTarget * 100) / 100}`, { trackedRank, rankHolderPp: newPp, baselinePp: gd.baselinePp, target: { from: gd.target, to: newTarget } });
          gd.target = newTarget;
          gd.targetLoaded = true;
          goals[i] = gd;
          saveGoals("pp");
        }
      }
    } catch (err) {
      console.error("Rank update failed:", err);
    }
  }

  // Interval set up in leader election block below

  async function updateExpRankGoals() {
    try {
      const goals = goalData.exp;
      if (!goals || goals.length === 0) return;
      if (currentStats.exp == null) return;

      // ── Within-run page cache (same pattern as updateRankGoals) ─
      const pageCache = new Map();
      const expByRank = async (rank) => {
        const perPage = 20;
        const page    = Math.ceil(rank / perPage);
        if (!pageCache.has(page)) {
          const url = `https://api.typegg.io/v1/leaders?sort=level&page=${page}&perPage=${perPage}`;
          pageCache.set(page, gtApiFetch(url, { headers: authHeaders() }).then(r => {
            if (!r.ok) throw new Error("Leaderboard fetch failed");
            return r.json();
          }));
        }
        const data = await pageCache.get(page);
        const u = data.users?.find(u => u.stats?.ranking === rank);
        if (!u) throw new Error(`Rank #${rank} not found on page ${page}`);
        return u.stats.experience;
      };

      for (let i = 0; i < goals.length; i++) {
        let gd = goals[i];
        if (!gd.targetRank) continue;

        if (gd.nextRank) {
          // ── Next-rank goal ─────────────────────────────────────
          if (currentStats.expRank == null || currentStats.expRank <= 1) continue;
          const nextRank = currentStats.expRank - 1;

          if (gd.targetRank !== nextRank) {
            // User ranked up — reset baseline to current EXP and track new next rank
            gd.baselineExp  = currentStats.exp;
            gd.targetRank  = nextRank;
            const newExp    = await expByRank(nextRank);
            gd.target      = Math.max(0, newExp - gd.baselineExp);
            gd.targetLoaded = true;
            gtLog("Next-EXP-rank goal — ranked up", `now chasing EXP rank #${nextRank}`, { targetRank: nextRank, newBaselineExp: gd.baselineExp, rankHolderExp: newExp, expNeeded: gd.target });
            goals[i] = gd;
            saveGoals("exp");
            continue;
          }

          // Same rank — dynamically update target EXP in case the leaderboard shifted
          const newExp    = await expByRank(nextRank);
          const newTarget = Math.max(0, newExp - gd.baselineExp);
          if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
            gtLog("Next-EXP-rank goal target updated", `EXP rank #${nextRank} shifted — EXP needed ${gd.target} → ${Math.round(newTarget)}`, { targetRank: nextRank, rankHolderExp: newExp, baselineExp: gd.baselineExp, target: { from: gd.target, to: newTarget } });
            gd.target   = newTarget;
            gd.targetLoaded = true;
            goals[i] = gd;
            saveGoals("exp");
          }
          continue;
        }

        // ── Regular rank goal ──────────────────────────────────
        const trackedRank = (currentStats.expRank == null || currentStats.expRank > gd.targetRank)
          ? gd.targetRank
          : gd.targetRank + 1;
        const newExp = await expByRank(trackedRank);
        const newTarget = Math.max(0, newExp - gd.baselineExp);

        if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
          gtLog("EXP-rank goal target updated", `tracking EXP rank #${trackedRank} — EXP needed ${gd.target} → ${Math.round(newTarget)}`, { trackedRank, rankHolderExp: newExp, baselineExp: gd.baselineExp, target: { from: gd.target, to: newTarget } });
          gd.target = newTarget;
          gd.targetLoaded = true;
          goals[i] = gd;
          saveGoals("exp");
        }
      }
    } catch (err) {
      console.error("Exp rank update failed:", err);
    }
  }

  // Interval set up in leader election block below

  // ── Player goal target computation ────────────────────────────
  async function updatePlayerGoals() {
    try {
      const types = ["pp", "exp"];

      // ── Collect unique usernames across ALL player goals ───
      // If a user has both a PP and EXP goal targeting "keegan", that's
      // one request — not two. The /users/{username} endpoint already
      // returns both totalPp and experience, so no need to hit it twice.
      const usernames = new Set();
      for (const type of types) {
        const goals = goalData[type];
        if (!goals) continue;
        for (const g of goals) {
          if (g.targetUsername) usernames.add(g.targetUsername);
        }
      }
      if (usernames.size === 0) return;

      // Fetch each unique user once, in parallel
      const userStats = new Map();
      await Promise.all([...usernames].map(async (name) => {
        try {
          const url = withLang(`https://api.typegg.io/v1/users/${encodeURIComponent(name)}`);
          const r = await gtApiFetch(url, { headers: authHeaders() });
          if (!r.ok) return;
          const data = await r.json();
          userStats.set(name, {
            pp: data.stats?.totalPp,
            exp: data.stats?.experience,
          });
        } catch { /* ignore individual failures */ }
      }));

      for (const type of types) {
        const goals = goalData[type];
        if (!goals || goals.length === 0) continue;

        for (let i = 0; i < goals.length; i++) {
          let gd = goals[i];
          if (!gd.targetUsername) continue;

          const stats = userStats.get(gd.targetUsername);
          if (!stats) continue;
          const newValue = type === "pp" ? stats.pp : stats.exp;
          if (newValue == null) continue;

          const baselineKey = GOAL_CONFIG[type].baselineKey;
          let newTarget = newValue - gd[baselineKey];
          if (newTarget < 0) newTarget = 0;

          if (Math.abs(newTarget - gd.target) > 0.01) {
            gtLog("Player goal target updated", `${gd.targetUsername} (${type}) — target ${gd.target} → ${Math.round(newTarget * 100) / 100}`, { player: gd.targetUsername, type, playerCurrentValue: newValue, yourBaseline: gd[baselineKey], target: { from: gd.target, to: newTarget } });
            gd.target = newTarget;
            goals[i] = gd;
            saveGoals(type);
          }
        }
      }
    } catch (err) {
      console.error("Player target update failed:", err);
    }
  }

  // Check for player PP updates every 60 seconds
  // Interval set up in leader election block below

  // ── /races endpoint cache ────────────────────────────────────
  // Used to eliminate the gain-indicator lag for requirement goals.
  //
  // Without a cache: on every quote-finish, fetchUserData runs and updates
  // currentStats.races, applyUserData renders non-req goals (indicator pops),
  // then evaluator triggers a SECOND HTTP fetch to /races and only then
  // updates req goals (indicator pops ~1s later).
  //
  // With this cache + a parallel prefetch on quote-finish: /races is fetched
  // alongside fetchUserData, so by the time applyUserData triggers the eval,
  // the data is already sitting in cache and the eval is effectively
  // synchronous → req-goal indicator pops at the same time as non-req ones.
  //
  // TTL is short — just long enough to bridge the gap between prefetch and
  // applyUserData. Much longer and we'd risk evaluating against stale data
  // if a user keeps racing while a previous /races response is still cached.
  const RACES_CACHE_TTL_MS = 3000;
  let racesEndpointCache = null; // { races: [...], ts: <ms> }

  function isRacesCacheFresh() {
    return racesEndpointCache && (Date.now() - racesEndpointCache.ts) < RACES_CACHE_TTL_MS;
  }

  // Fetches the /v1/users/<name>/races list. Returns the races array or
  // throws on auth/network failure (caller handles). Always updates the
  // cache on success so a parallel fetcher (e.g. quote-finish prefetch)
  // benefits the next eval.
  async function fetchRacesEndpoint() {
    const { username } = getAuth();
    if (!username) throw new Error("no auth");
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}/races`;
    const r = await gtApiFetch(url, { headers: authHeaders() }, { lane: "urgent" });
    if (!r.ok) throw new Error(`races endpoint ${r.status}`);
    const data = await r.json();
    const races = Array.isArray(data?.races) ? data.races : null;
    if (races) racesEndpointCache = { races, ts: Date.now() };
    return races;
  }

  // Public helper: returns races, using cache when fresh.
  async function getRecentRacesData() {
    if (isRacesCacheFresh()) return racesEndpointCache.races;
    return await fetchRacesEndpoint();
  }

  // Prefetch only if there's at least one goal that needs the races list
  // (gated goals OR rolling-average goals — both consume new races) AND
  // we don't already have fresh cache. Fires-and-forgets on error so it
  // never blocks the quote-finish flow.
  function prefetchRacesIfNeeded() {
    // Consumers of the recent-races list live in TWO arrays: gated/average
    // goals in goalData.races AND improvement goals in goalData.improvement
    // (post-migration). Checking only goalData.races skipped the prefetch
    // for improvement-only setups, so their eval fell back to its own
    // sequential /races fetch after fetchUserData — slower gain indicator,
    // and the parallel-prefetch optimisation was silently defeated.
    const needed =
      (goalData.races || []).some(g => goalNeedsRaceList(g)) ||
      (goalData.improvement || []).some(g => goalIsImprovement(g));
    if (!needed) return Promise.resolve();
    if (isRacesCacheFresh()) return Promise.resolve();
    return fetchRacesEndpoint().catch(() => {/* swallow */});
  }

  // ── /quotes/{quoteId} endpoint cache ─────────────────────────
  // Quote-axis requirements (length, difficulty) need data from a SECOND
  // endpoint that's keyed by quoteId. Each race carries a quoteId, so to
  // evaluate a race we may need to fetch the quote it was based on.
  //
  // Quotes are immutable — same quoteId always returns the same content —
  // so we cache aggressively. Bounded LRU cap prevents unbounded growth
  // for long sessions where the user races many distinct quotes.
  //
  // Concurrent gets: an in-flight Map prevents double-fetching the same
  // quoteId from racing parallel callers (e.g. evaluator + prefetcher
  // both ask for the same quoteId at the same time).
  const QUOTE_CACHE_MAX = 200;
  const quoteCache    = new Map(); // quoteId → quote object  (insertion-order = LRU)
  const quoteInFlight = new Map(); // quoteId → Promise<quote> currently fetching

  async function fetchQuoteFromApi(quoteId) {
    const url = `https://api.typegg.io/v1/quotes/${encodeURIComponent(quoteId)}`;
    const r = await gtApiFetch(url, { headers: authHeaders() }, { lane: "urgent" });
    if (!r.ok) throw new Error(`quote ${quoteId} → ${r.status}`);
    return await r.json();
  }

  // Public helper. Returns the quote object (with .length, .difficulty, ...)
  // or throws on failure. Caller is responsible for catching errors and
  // deciding whether to bail out of the eval.
  async function getQuote(quoteId) {
    if (!quoteId) throw new Error("getQuote: missing quoteId");
    if (quoteCache.has(quoteId)) {
      // Touch for LRU: re-insert at end.
      const v = quoteCache.get(quoteId);
      quoteCache.delete(quoteId);
      quoteCache.set(quoteId, v);
      return v;
    }
    if (quoteInFlight.has(quoteId)) return quoteInFlight.get(quoteId);

    const p = (async () => {
      try {
        const quote = await fetchQuoteFromApi(quoteId);
        // Evict oldest if at cap. Map iteration order is insertion order,
        // so the first key is the least-recently-set.
        if (quoteCache.size >= QUOTE_CACHE_MAX) {
          const firstKey = quoteCache.keys().next().value;
          if (firstKey !== undefined) quoteCache.delete(firstKey);
        }
        quoteCache.set(quoteId, quote);
        return quote;
      } finally {
        quoteInFlight.delete(quoteId);
      }
    })();
    quoteInFlight.set(quoteId, p);
    return p;
  }

  // Prefetch the quotes for the most-recent N races IF any requirement
  // goal needs quote data. Used in the quote-finish flow so by the time
  // the eval runs, the quote data is already in cache → indicator pops
  // in sync with non-req goals.
  //
  // We can only prefetch from cached /races data; if /races itself isn't
  // cached yet, this no-ops (the eval will fetch quotes itself, just a
  // tick later — same fallback as before).
  //
  // Errors swallowed — prefetch is opportunistic.
  async function prefetchQuotesIfNeeded() {
    const goals = goalData.races;
    if (!goals || !goals.some(g => hasAnyReq(g.requirements) && goalNeedsQuoteData(g.requirements))) {
      return;
    }
    if (!isRacesCacheFresh()) return; // /races prefetch hasn't landed yet
    const races = racesEndpointCache.races;
    if (!Array.isArray(races) || races.length === 0) return;

    // How many recent races might we evaluate? Mirror the evaluator's
    // logic: max delta across all goals that need quote data.
    const racesSnap = currentStats.races;
    if (racesSnap == null) return;
    const targets = goals.filter(g =>
      hasAnyReq(g.requirements) &&
      goalNeedsQuoteData(g.requirements) &&
      racesSnap > (g.lastEvalRaces ?? g[GOAL_CONFIG.races.baselineKey] ?? 0)
    );
    if (targets.length === 0) return;
    const maxDelta = Math.max(...targets.map(g =>
      racesSnap - (g.lastEvalRaces ?? g[GOAL_CONFIG.races.baselineKey] ?? 0)
    ));
    const window = races.slice(0, Math.min(maxDelta, races.length));

    // Kick off all fetches in parallel; await them all (or any to fail
    // silently — getQuote handles its own caching either way).
    await Promise.all(
      window
        .map(r => r?.quoteId)
        .filter(Boolean)
        .map(id => getQuote(id).catch(() => {/* swallow */}))
    );
  }


  // For race goals carrying requirements, the displayed gain isn't the
  // raw delta in the lifetime `races` stat — it's `qualifyingProgress`,
  // counting only races that meet every active threshold. This function
  // walks the user's most recent races (via /users/{username}/races) and
  // updates qualifyingProgress for each requirement-bearing goal.
  //
  // There are two requirement categories:
  //   - SKILL axes (wpm / accuracy / pp): on the race object itself.
  //   - QUOTE axes (length / difficulty): need a per-race fetch to
  //     /quotes/{quoteId}. Only fetched when at least one goal in this
  //     evaluation actually has a quote-axis threshold set.
  //
  // Strict mode: a single SKILL-axis miss resets qualifyingProgress to 0
  // — UNTIL the goal is completed; afterwards strictness no longer applies
  // (consistent with the "10 in a row to complete" semantics). Quote-axis
  // misses do NOT reset (see below) — strict only fires on user-controlled
  // failures.
  //
  // Strict + uniqueOnly: a re-typed quote that was already qualified-on
  // this period is neutral on BOTH the pass side (no qualification — it's
  // a duplicate) AND the fail side (no reset — the user already cleared
  // the bar on that quote). Each quote gets exactly one streak-affecting
  // attempt per period.
  //
  // Filter interaction: the evaluator uses `currentStats.races` (lifetime
  // total) for delta math — i.e. "how many recent races to look at" — and
  // then per-race applies the goal's filter via raceMatchesFilter (using
  // each race's `gamemode` field). Non-matching races are INVISIBLE: they
  // don't qualify and they don't trigger strict resets. This means filter
  // and requirements compose cleanly (e.g. "5 quickplay races at 100+ WPM").
  //
  // Quote-axis miss = also INVISIBLE. Same principle as filter: the user
  // can't choose which quote shows up, only how they race on it. So a
  // 100-char quote during a "200+ LEN" goal is treated like the wrong
  // gamemode — silently skipped, no qualification, no strict reset. Only
  // skill-axis misses on a qualifying-context race trigger strict reset.
  //
  // Quote-fetch failure: if a quote can't be fetched mid-evaluation, the
  // affected goal is skipped (state unchanged) and will retry next cycle.
  // Other goals in the same evaluation are unaffected.
  async function evaluateRaceRequirements({ deferRender = false } = {}) {
    if (!isLeader) return;
    const goals = goalData.races;
    if (!goals || goals.length === 0) return;
    if (currentStats.races == null) return;

    // Snapshot currentStats.races at entry so we use a consistent count
    // across the async fetch boundary. If a race finishes WHILE we're
    // fetching, currentStats.races bumps mid-flight; using the snapshot
    // means we don't accidentally treat the still-uncounted race as
    // already-evaluated. The next applyUserData → eval cycle picks it up.
    const racesSnapshot = currentStats.races;

    // Filter to goals that actually need work — any goal that consumes
    // new races (gated goals OR rolling-average goals) with new races
    // since its last evaluation.
    const targets = goals
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => goalNeedsRaceList(g) &&
                         racesSnapshot > (g.lastEvalRaces ?? g[GOAL_CONFIG.races.baselineKey] ?? 0));
    if (targets.length === 0) return;

    // Maximum number of recent races we may need to look at across all goals.
    // The /users/{username}/races endpoint returns a chunk of recent races
    // (typically newest-first); we trust that races[0] is the latest.
    const maxDelta = Math.max(...targets.map(({ g }) =>
      racesSnapshot - (g.lastEvalRaces ?? g[GOAL_CONFIG.races.baselineKey] ?? 0)
    ));
    if (maxDelta <= 0) return;

    // Fetch the user's recent race list (via cache when warm).
    let recentRaces;
    try {
      recentRaces = await getRecentRacesData();
    } catch (err) {
      console.error("Race requirement fetch failed:", err);
      return;
    }
    if (!Array.isArray(recentRaces) || recentRaces.length === 0) return;

    // ── Quote-data pre-fetch (warmup) ──────────────────────────
    // Goals with length / difficulty requirements need /quotes/{id} data
    // for each race they evaluate. We warm the quote cache in parallel
    // here so the per-race awaits inside the goal loop hit cache instead
    // of doing sequential round-trips. For goals without quote-axis
    // requirements this whole block is a no-op.
    //
    // Note: we ignore individual fetch failures at this stage and let the
    // inner loop handle them per-goal — that keeps the bail-out granular
    // (one transient quote failure shouldn't stall every other goal).
    const needsQuoteData = targets.some(({ g }) => goalNeedsQuoteData(g.requirements));
    if (needsQuoteData) {
      const quoteIds = new Set();
      for (const { g } of targets) {
        if (!goalNeedsQuoteData(g.requirements)) continue;
        const last = g.lastEvalRaces ?? g[GOAL_CONFIG.races.baselineKey] ?? 0;
        const d = racesSnapshot - last;
        if (d <= 0) continue;
        const w = recentRaces.slice(0, Math.min(d, recentRaces.length));
        for (const race of w) {
          if (race?.quoteId) quoteIds.add(race.quoteId);
        }
      }
      if (quoteIds.size > 0) {
        await Promise.all(
          [...quoteIds].map(id => getQuote(id).catch(() => {/* per-goal handles */}))
        );
      }
    }

    let changed = false;
    for (const { i } of targets) {
      const gd = goals[i];
      if (!gd) continue;
      const baseline = gd[GOAL_CONFIG.races.baselineKey] ?? 0;
      const lastEval = gd.lastEvalRaces ?? baseline;
      const delta = racesSnapshot - lastEval;
      if (delta <= 0) continue;

      // The new races are the most recent `delta` in the API response.
      // recentRaces is newest-first; reverse the slice so we evaluate in
      // chronological order — important for strict-mode reset semantics
      // (a streak of qualifies followed by a miss should reset, not the
      // other way around).
      const window = recentRaces.slice(0, Math.min(delta, recentRaces.length));
      const chronological = window.slice().reverse();

      // ── Rolling-average branch ────────────────────────────────
      // Self-contained: avg goals don't share state with gated goals
      // (no qualifyingProgress, no seenQuoteIds, no quote fetches). We
      // walk the new races, apply the goal's filter, and slide the
      // window. Best avg only updates once the window is full.
      //
      // Unique-quote handling: when gd.uniqueOnly is on, we maintain
      // a parallel windowQuoteIds array that mirrors windowRaces. A
      // race is skipped entirely if its quoteId is already in that
      // array (i.e. currently in the window). On eviction, both arrays
      // shift in lockstep — so a quoteId leaves the "blocked" set the
      // moment it leaves the window, letting the user re-race that
      // quote. This avoids the "ran out of quotes" failure mode that
      // a permanent set would produce over time.
      if (goalIsAverage(gd)) {
        let windowRaces    = Array.isArray(gd.windowRaces) ? gd.windowRaces.slice() : [];
        let windowQuoteIds = gd.uniqueOnly
          ? (Array.isArray(gd.windowQuoteIds) ? gd.windowQuoteIds.slice() : [])
          : null;
        let bestAvg        = gd.bestAvg ?? null;
        const windowSize   = gd.windowSize ?? 0;
        const metric       = gd.metric;
        let avgChanged = false;
        const gtRaceLog = []; // [GT log] per-race outcomes for this goal
        const gtBestAvgBefore = bestAvg;

        for (const race of chronological) {
          // Filter (quickplay/solo/all) — same semantics as gated goals.
          if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "ignored — doesn't match goal filter" }); continue; }
          const v = getRaceMetricValue(race, metric);
          if (!isFinite(v)) { gtRaceLog.push({ quoteId: race?.quoteId, outcome: "ignored — no numeric metric value" }); continue; }

          // Unique-quote check: skip if this quoteId is already in the
          // current window. Defensive: also skip if uniqueOnly is on
          // but the race has no quoteId (can't enforce uniqueness, so
          // safer to drop than to count). includes() is O(n) but n is
          // small (window size, typically 25-250).
          if (windowQuoteIds) {
            if (!race.quoteId) { gtRaceLog.push({ [metric]: v, outcome: "ignored — unique-only goal but race has no quoteId" }); continue; }
            if (windowQuoteIds.includes(race.quoteId)) { gtRaceLog.push({ quoteId: race.quoteId, [metric]: v, outcome: "ignored — quote already in current window (unique-only)" }); continue; }
          }

          windowRaces.push(v);
          if (windowQuoteIds) windowQuoteIds.push(race.quoteId);
          if (windowRaces.length > windowSize) {
            windowRaces.shift();
            if (windowQuoteIds) windowQuoteIds.shift();
          }
          avgChanged = true;

          // Best avg only tracks once the window is full. Partial-window
          // means are noisy and not comparable to full-window means, so
          // we deliberately exclude them from the "best" peak.
          if (windowRaces.length === windowSize) {
            const m = arrayMean(windowRaces);
            if (m != null && (bestAvg == null || m > bestAvg)) {
              bestAvg = m;
            }
          }
          gtRaceLog.push({
            quoteId: race.quoteId, [metric]: v,
            windowFill: `${windowRaces.length}/${windowSize}`,
            avgCalc: gtAvgCalc(windowRaces, arrayMean(windowRaces) ?? 0),
            currentAvg: Math.round((arrayMean(windowRaces) ?? 0) * 100) / 100,
            bestAvg: bestAvg == null ? "(window not full yet)" : Math.round(bestAvg * 100) / 100,
          });
        }

        gtLog(
          "Average goal recalculated",
          `${gtGoalTag(gd, "races")} — current avg ${Math.round((arrayMean(windowRaces) ?? 0) * 100) / 100}, best avg ${gtBestAvgBefore == null ? "—" : Math.round(gtBestAvgBefore * 100) / 100} → ${bestAvg == null ? "—" : Math.round(bestAvg * 100) / 100}`,
          {
            goal: gtGoalTag(gd, "races"), metric, windowSize,
            newRacesConsidered: chronological.length,
            racesEvaluated: gtRaceLog,
            windowFill: `${windowRaces.length}/${windowSize}`,
            windowValues: windowRaces.slice(),
            bestAvg: { from: gtBestAvgBefore, to: bestAvg },
            lastEvalRaces: { from: lastEval, to: racesSnapshot },
          }
        );
        if (avgChanged || lastEval !== racesSnapshot) {
          const next = {
            ...gd,
            windowRaces,
            bestAvg,
            lastEvalRaces: racesSnapshot,
          };
          // Only write windowQuoteIds back when uniqueOnly is on. If
          // it's off, leave the field absent so old goal shapes don't
          // get polluted with empty arrays they don't need.
          if (windowQuoteIds) next.windowQuoteIds = windowQuoteIds;
          goals[i] = next;
          changed = true;
        }
        continue; // avg goals don't run the gated-goal logic below
      }

      // ── Improvement branch (S1 cumulative gain) ───────────────────
      // Keyed off the FINISHED race's quoteId (ground truth from /races) and
      // the per-quote state seeded BEFORE the race at quote-start. A quote
      // never seeded in time simply isn't counted — we never derive state from
      // post-race data, keeping this strictly S1. lastEvalRaces still advances
      // so an unmeasured race isn't reprocessed. Both tracks are monotonic:
      //   • Best track: delta = max(0, val − prevBest); ratchet the best up.
      //   • Average track: a rolling window of the last W races. The window's
      //     average locks as the baseline once it first reaches W races (warm-
      //     up; prior history counts). Thereafter gain = the PEAK lift of the
      //     rolling average above that baseline. A below-baseline race lowers
      //     the current average but never reduces the banked peak → it
      //     contributes 0, never negative (so there's no not-submit incentive).
      if (goalIsImprovement(gd)) {
        const metric = gd.improvementMetric || "wpm";   // "wpm" | "pp"
        let accumulatedGain = gd.accumulatedGain ?? 0;
        let impChanged = false;

        if (gd.improvementTrack === "average") {
          const W = Math.max(2, gd.improvementAvgWindow || 5);
          const quoteAvgs = { ...(gd.quoteAvgs || {}) };
          const gtRaceLog = []; // [GT log] per-race outcomes for this goal

          for (const race of chronological) {
            if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "ignored — doesn't match goal filter" }); continue; }
            const val = Number(race[metric]);
            if (!isFinite(val)) { gtRaceLog.push({ quoteId: race?.quoteId, outcome: "ignored — no numeric metric value" }); continue; }
            const qid = race.quoteId;
            if (!qid) { gtRaceLog.push({ [metric]: val, outcome: "ignored — race has no quoteId" }); continue; }
            const st = quoteAvgs[qid];
            if (!st) { gtRaceLog.push({ quoteId: qid, [metric]: val, outcome: "skipped — quote had no pre-race baseline seed (S1: race not counted)" }); continue; } // not seeded → unmeasurable (S1)
            const gtGainBefore = accumulatedGain;
            // Previous PEAK (before this race): its scores + their average. Prefer
            // the stored peakWindow; fall back to baseline+peak for goals seeded
            // before peakWindow tracking existed.
            const gtPrevPeakWindow = Array.isArray(st.peakWindow) ? st.peakWindow.slice() : null;
            const gtPrevPeakAvg = gtPrevPeakWindow
              ? gtPrevPeakWindow.reduce((a, b) => a + b, 0) / gtPrevPeakWindow.length
              : (st.baseline == null ? null : st.baseline + (st.peak ?? 0));
            const gtBaselineWasNull = (st.baseline == null);

            const w = Array.isArray(st.window) ? st.window.slice() : [];
            w.push(val);
            while (w.length > W) w.shift();
            const avg = w.reduce((a, b) => a + b, 0) / w.length;

            let baseline = (st.baseline == null) ? null : st.baseline;
            let peak = st.peak ?? 0;
            let peakWindow = Array.isArray(st.peakWindow) ? st.peakWindow.slice() : null;
            let gtNewPeak = false;
            if (baseline == null) {
              // Warming up. Lock the baseline the moment the window is full;
              // that race itself contributes nothing (it defines the baseline).
              if (w.length >= W) { baseline = avg; peak = 0; peakWindow = w.slice(); gtNewPeak = true; }
            } else {
              const lift = avg - baseline;
              if (lift > peak) { accumulatedGain += (lift - peak); peak = lift; peakWindow = w.slice(); gtNewPeak = true; }
            }
            quoteAvgs[qid] = { window: w, baseline, peak, peakWindow };
            gtRaceLog.push({
              quoteId: qid, [metric]: val,
              currentWindow: w.slice(),                          // the 3 (=W) scores now
              currentAvgCalc: gtAvgCalc(w, avg),                 // "(a + b + c) / 3 = X"
              currentAvg: Math.round(avg * 100) / 100,
              previousPeakWindow: gtPrevPeakWindow
                ? gtPrevPeakWindow
                : (gtBaselineWasNull ? "(no peak yet — window still warming up)"
                                     : "(individual scores weren't stored for this goal's existing peak before this build — the previousPeakAvg below is read from saved state (baseline+peak), NOT recomputed from races; the scores populate once this quote sets a NEW peak or the goal re-seeds)"),
              previousPeakAvg: gtPrevPeakAvg == null ? "(warming up)" : Math.round(gtPrevPeakAvg * 100) / 100,
              newPeakSetThisRace: gtNewPeak || undefined,        // true when this race beat the old peak
              gainAdded: Math.round((accumulatedGain - gtGainBefore) * 100) / 100,
            });
            impChanged = true;                  // window/state advanced
          }

          gtLog(
            "Improvement goal recalculated (LEGACY races-array path)",
            `${gtGoalTag(gd, "races")} — gain ${Math.round((gd.accumulatedGain ?? 0) * 100) / 100} → ${Math.round(accumulatedGain * 100) / 100}`,
            {
              note: "this goal still lives in goalData.races — the one-time migration to goalData.improvement didn't move it",
              goal: gtGoalTag(gd, "races"), track: "average", metric, windowSize: W,
              newRacesConsidered: chronological.length,
              racesEvaluated: gtRaceLog,
              accumulatedGain: { from: Math.round((gd.accumulatedGain ?? 0) * 100) / 100, to: Math.round(accumulatedGain * 100) / 100, gain: Math.round((accumulatedGain - (gd.accumulatedGain ?? 0)) * 100) / 100 },
              lastEvalRaces: { from: lastEval, to: racesSnapshot },
            }
          );
          if (impChanged || lastEval !== racesSnapshot) {
            goals[i] = { ...gd, quoteAvgs, accumulatedGain, lastEvalRaces: racesSnapshot };
            changed = true;
          }
          continue;
        }

        // Best track (default)
        const quoteBests = { ...(gd.quoteBests || {}) };
        const gtRaceLog = []; // [GT log] per-race outcomes for this goal
        for (const race of chronological) {
          if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "ignored — doesn't match goal filter" }); continue; }
          const val = Number(race[metric]);
          if (!isFinite(val)) { gtRaceLog.push({ quoteId: race?.quoteId, outcome: "ignored — no numeric metric value" }); continue; }
          const qid = race.quoteId;
          if (!qid) { gtRaceLog.push({ [metric]: val, outcome: "ignored — race has no quoteId" }); continue; }
          if (!(qid in quoteBests)) { gtRaceLog.push({ quoteId: qid, [metric]: val, outcome: "skipped — quote had no pre-race baseline seed (S1: race not counted)" }); continue; } // no pre-race baseline → unmeasurable
          const prev = quoteBests[qid];
          if (val > prev) {
            accumulatedGain += (val - prev);
            quoteBests[qid]  = val;            // ratchet the stored best up
            impChanged = true;
            gtRaceLog.push({ quoteId: qid, [metric]: val, prevBest: prev, newBest: val, gainAdded: Math.round((val - prev) * 100) / 100 });
          } else {
            gtRaceLog.push({ quoteId: qid, [metric]: val, prevBest: prev, outcome: "no gain — didn't beat the stored best" });
          }
        }

        gtLog(
          "Improvement goal recalculated (LEGACY races-array path)",
          `${gtGoalTag(gd, "races")} — gain ${Math.round((gd.accumulatedGain ?? 0) * 100) / 100} → ${Math.round(accumulatedGain * 100) / 100}`,
          {
            note: "this goal still lives in goalData.races — the one-time migration to goalData.improvement didn't move it",
            goal: gtGoalTag(gd, "races"), track: "best", metric,
            newRacesConsidered: chronological.length,
            racesEvaluated: gtRaceLog,
            accumulatedGain: { from: Math.round((gd.accumulatedGain ?? 0) * 100) / 100, to: Math.round(accumulatedGain * 100) / 100, gain: Math.round((accumulatedGain - (gd.accumulatedGain ?? 0)) * 100) / 100 },
            lastEvalRaces: { from: lastEval, to: racesSnapshot },
          }
        );
        if (impChanged || lastEval !== racesSnapshot) {
          goals[i] = { ...gd, quoteBests, accumulatedGain, lastEvalRaces: racesSnapshot };
          changed = true;
        }
        continue; // improvement goals don't run the gated-goal logic below
      }

      const goalNeedsQuotes = goalNeedsQuoteData(gd.requirements);

      let qualifying = gd.qualifyingProgress ?? 0;
      const target = gd.target ?? 0;
      let goalFailed = false; // set if a quote fetch fails — bail w/o saving
      const gtRaceLog = []; // [GT log] per-race outcomes for this goal
      const gtQualifyingBefore = qualifying;

      // Unique-quote tracking: a Set seeded from the persisted array so
      // membership checks are O(1). We mutate this in-loop and serialize
      // back to an array on save. Null when uniqueOnly is off — every
      // call site checks for null before using it.
      const seenQuoteIds = gd.uniqueOnly ? new Set(gd.seenQuoteIds || []) : null;

      for (const race of chronological) {
        // Strict-only freeze: once a strict goal has been completed, stop
        // counting. A subsequent miss must NOT undo the completion (cruel),
        // and we don't over-fill either (the goal is done).
        //
        // Non-strict goals keep counting past target — same UX as regular
        // gain goals which show "55 / 50" once you blow past your target.
        // Resetting isn't a concern here since strictMode is off.
        if (gd.strictMode && target > 0 && qualifying >= target) { gtRaceLog.push({ outcome: "frozen — strict goal already completed; remaining races not counted" }); break; }

        // Filter check: a race that doesn't match the goal's filter is
        // invisible to this goal — neither qualifying nor strict-resetting.
        // (e.g. a 60 WPM solo race during a "100+ WPM quickplay" strict goal
        // shouldn't break the streak.)
        if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "invisible — doesn't match goal filter" }); continue; }

        // For goals with quote-axis requirements we need the quote object.
        // Cache should be warm from the pre-fetch above; this await is
        // effectively synchronous on the happy path.
        let quote = null;
        if (goalNeedsQuotes) {
          if (!race.quoteId) {
            // Can't evaluate — skip this race. Don't qualify, don't reset.
            // It'll be re-attempted next eval cycle.
            gtRaceLog.push({ outcome: "skipped — race has no quoteId (can't check quote requirements)" });
            continue;
          }
          try {
            quote = await getQuote(race.quoteId);
          } catch (err) {
            console.error("[Goal Tracker] quote fetch failed; bailing out of goal", gd.id, err);
            goalFailed = true;
            break;
          }
        }

        // Quote-property check: a race on a quote that doesn't meet the
        // LEN/DIFF bar is INVISIBLE to the goal — same semantics as filter.
        // The user can't choose which quote shows up (especially in quickplay),
        // so punishing them with a strict reset for getting "the wrong quote"
        // would be unfair. Strict only fires on things the user controls (skill).
        if (!meetsQuoteRequirements(quote, gd.requirements)) { gtRaceLog.push({ quoteId: race.quoteId, outcome: "invisible — quote doesn't meet the LEN/DIFF requirement" }); continue; }

        // Skill check: this is the user-controlled half (WPM / ACC / PP).
        // Failure here IS a strict reset — the race was on a qualifying
        // quote (otherwise we'd have skipped above) and the user didn't
        // hit the bar. Returns true when there are no skill thresholds set
        // (e.g. uniqueOnly-only goals or quote-property-only goals).
        if (meetsSkillRequirements(race, gd.requirements)) {
          // Unique-only: a passing race on a quoteId we've already counted
          // this period is a NO-OP — doesn't add to qualifying, and (notably)
          // doesn't trigger a strict reset either. The user *did* meet the
          // bar; the race just doesn't count for THIS goal because of the
          // unique restriction. Penalising them with a strict reset for
          // re-typing a quote they already qualified on would be wrong.
          if (seenQuoteIds && race.quoteId && seenQuoteIds.has(race.quoteId)) {
            gtRaceLog.push({ quoteId: race.quoteId, outcome: "neutral — passed, but quote already counted this period (unique-only)" });
            continue;
          }
          qualifying++;
          if (seenQuoteIds && race.quoteId) seenQuoteIds.add(race.quoteId);
          gtRaceLog.push({
            quoteId: race.quoteId, wpm: race.wpm,
            accuracyPct: race.accuracy != null ? Math.round(race.accuracy * 1000) / 10 : undefined,
            pp: race.pp,
            outcome: `qualified ✓ (${qualifying}${target > 0 ? ` / ${target}` : ""})`,
          });
        } else if (gd.strictMode) {
          // Strict reset — but ONLY for first-attempt fails. If we've
          // already qualified on this quoteId this period, the user has
          // demonstrably cleared the bar on this quote; a later miss on
          // a re-type is just casual practice and shouldn't kill the
          // streak. Symmetric with the pass-side: each quote gets exactly
          // one chance per period to affect the streak (positively or
          // negatively); after that it's neutral.
          if (seenQuoteIds && race.quoteId && seenQuoteIds.has(race.quoteId)) {
            gtRaceLog.push({ quoteId: race.quoteId, outcome: "neutral — missed, but quote already qualified this period (no strict reset)" });
            continue;
          }
          gtRaceLog.push({
            quoteId: race.quoteId, wpm: race.wpm,
            accuracyPct: race.accuracy != null ? Math.round(race.accuracy * 1000) / 10 : undefined,
            pp: race.pp,
            outcome: `STRICT RESET — skill requirement missed (progress ${qualifying} → 0)`,
          });
          qualifying = 0;
          // Wipe the seen set on a strict reset — the streak is gone, so
          // the no-repeat-quotes restriction starts fresh too. Without this
          // a user who strict-resets would still be locked out of every
          // quote they previously qualified on, which feels punishing.
          if (seenQuoteIds) seenQuoteIds.clear();
        } else {
          // not strict + not qualifying → no goal change, but log the miss
          gtRaceLog.push({
            quoteId: race.quoteId, wpm: race.wpm,
            accuracyPct: race.accuracy != null ? Math.round(race.accuracy * 1000) / 10 : undefined,
            pp: race.pp,
            outcome: "no count — skill requirement missed (non-strict: no reset)",
          });
        }
      }

      // If a quote fetch failed mid-loop, bail out of this goal entirely.
      // Don't update qualifyingProgress or lastEvalRaces — leaving them
      // unchanged means the next eval will retry from the same point,
      // which is exactly what we want for a transient API failure.
      if (goalFailed) {
        gtLog("Requirement goal eval BAILED", `${gtGoalTag(gd, "races")} — quote fetch failed; state unchanged, will retry next cycle`, { goal: gtGoalTag(gd, "races"), racesEvaluatedSoFar: gtRaceLog });
        continue;
      }

      // Cap qualifyingProgress at target ONLY for strict goals — for the
      // same reason as the freeze above. Non-strict goals are allowed to
      // exceed target so the user gets the same "overshoot" feedback as
      // regular gain goals.
      if (gd.strictMode && target > 0 && qualifying > target) qualifying = target;

      gtLog(
        "Requirement goal recalculated",
        `${gtGoalTag(gd, "races")} — qualifying ${gtQualifyingBefore} → ${qualifying}${target > 0 ? ` (target ${target})` : ""}`,
        {
          goal: gtGoalTag(gd, "races"),
          newRacesConsidered: chronological.length,
          racesEvaluated: gtRaceLog,
          qualifying: { from: gtQualifyingBefore, to: qualifying },
          target,
          strictMode: !!gd.strictMode,
          uniqueOnly: !!gd.uniqueOnly,
          lastEvalRaces: { from: lastEval, to: racesSnapshot },
        }
      );

      // Always advance lastEvalRaces to the snapshot — even if the API
      // returned fewer races than the delta (in which case we missed a few).
      // Trade-off: we might under-count by 1-2 races during API lag, but we
      // never DOUBLE-count, which is the bigger correctness concern.
      if (qualifying !== (gd.qualifyingProgress ?? 0) || lastEval !== racesSnapshot) {
        const next = { ...gd, qualifyingProgress: qualifying, lastEvalRaces: racesSnapshot };
        // Serialize the seen-quotes Set back to an array for storage.
        // Only when uniqueOnly is on — otherwise we leave the field absent
        // to avoid polluting old goal shapes.
        if (seenQuoteIds) next.seenQuoteIds = [...seenQuoteIds];
        goals[i] = next;
        changed = true;
      }
    }

    if (changed) {
      saveGoals("races");
      // When the caller is going to render right after we return (e.g. the
      // quote-finish flow does commit → eval → render to keep all gain
      // indicators in the same animation frame), skip the render here to
      // avoid a redundant double-paint.
      if (!deferRender) renderAllGoals();
    }
  }

  // Wrap with inFlight so concurrent triggers (rapid quote-finishes) coalesce
  const evaluateRaceRequirementsGuarded = inFlight(evaluateRaceRequirements);

  // ── Improvement-goal evaluator (its own type) ─────────────
  // Decoupled from evaluateRaceRequirements: scoped to goalData.improvement and
  // contains only the per-quote gain logic (best + average tracks) that used to
  // live inline in the races evaluator. Same S1 semantics — a race counts only
  // against a baseline seeded BEFORE it (at quote-start). Leader-only; reads the
  // shared recent-races cache. Both tracks are monotonic (never negative).
  async function evaluateImprovementGoals({ deferRender = false } = {}) {
    if (!isLeader) return;
    const goals = goalData.improvement;
    if (!goals || goals.length === 0) return;
    if (currentStats.races == null) return;
    const racesSnapshot = currentStats.races;

    const targets = goals
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => goalIsImprovement(g) && racesSnapshot > (g.lastEvalRaces ?? 0));
    if (targets.length === 0) {
      // Explain the silence — the #1 "why didn't my goal update?" question.
      const gains = goals.filter(g => goalIsImprovement(g));
      if (gains.length === 0) {
        gtLog("Improvement eval skipped", "improvement-type goals exist, but none are Gain-mode — Target-mode goals update from the self quote store (watch the 'Self store' logs), not this evaluator");
      } else {
        gtLog("Improvement eval skipped", "no Gain goal has new races since its last evaluation", {
          lifetimeRacesNow: racesSnapshot,
          goals: gains.map(g => ({ goal: gtGoalTag(g, "improvement"), lastEvalRaces: g.lastEvalRaces ?? 0 })),
        });
      }
      return;
    }

    let recentRaces;
    try { recentRaces = await getRecentRacesData(); }
    catch (err) { console.error("Improvement eval fetch failed:", err); return; }
    if (!Array.isArray(recentRaces) || recentRaces.length === 0) {
      gtLog("Improvement eval skipped", "the /races endpoint returned no races — nothing to evaluate");
      return;
    }

    let changed = false;
    for (const { i } of targets) {
      const gd = goals[i];
      if (!gd || !goalIsImprovement(gd)) continue;
      const lastEval = gd.lastEvalRaces ?? 0;
      const delta = racesSnapshot - lastEval;
      if (delta <= 0) continue;

      // New races are the most recent `delta`; reverse to chronological order.
      const window = recentRaces.slice(0, Math.min(delta, recentRaces.length));
      const chronological = window.slice().reverse();

      const metric = gd.improvementMetric || "wpm";   // "wpm" | "pp"
      let accumulatedGain = gd.accumulatedGain ?? 0;
      let impChanged = false;

      if (gd.improvementTrack === "average") {
        const W = Math.max(2, gd.improvementAvgWindow || 5);
        const quoteAvgs = { ...(gd.quoteAvgs || {}) };
        const gtRaceLog = []; // [GT log] per-race outcomes for this goal
        for (const race of chronological) {
          if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "ignored — doesn't match goal filter" }); continue; }
          const val = Number(race[metric]);
          if (!isFinite(val)) { gtRaceLog.push({ quoteId: race?.quoteId, outcome: "ignored — no numeric metric value" }); continue; }
          const qid = race.quoteId;
          if (!qid) { gtRaceLog.push({ [metric]: val, outcome: "ignored — race has no quoteId" }); continue; }
          const st = quoteAvgs[qid];
          if (!st) { gtRaceLog.push({ quoteId: qid, [metric]: val, outcome: "skipped — quote had no pre-race baseline seed (S1: race not counted)" }); continue; } // not seeded -> unmeasurable (S1)
          const gtGainBefore = accumulatedGain;
          // Previous PEAK (before this race): its scores + their average. Prefer
          // the stored peakWindow; fall back to baseline+peak for goals seeded
          // before peakWindow tracking existed.
          const gtPrevPeakWindow = Array.isArray(st.peakWindow) ? st.peakWindow.slice() : null;
          const gtPrevPeakAvg = gtPrevPeakWindow
            ? gtPrevPeakWindow.reduce((a, b) => a + b, 0) / gtPrevPeakWindow.length
            : (st.baseline == null ? null : st.baseline + (st.peak ?? 0));
          const gtBaselineWasNull = (st.baseline == null);
          const w = Array.isArray(st.window) ? st.window.slice() : [];
          w.push(val);
          while (w.length > W) w.shift();
          const avg = w.reduce((a, b) => a + b, 0) / w.length;
          let baseline = (st.baseline == null) ? null : st.baseline;
          let peak = st.peak ?? 0;
          let peakWindow = Array.isArray(st.peakWindow) ? st.peakWindow.slice() : null;
          let gtNewPeak = false;
          if (baseline == null) {
            if (w.length >= W) { baseline = avg; peak = 0; peakWindow = w.slice(); gtNewPeak = true; }
          } else {
            const lift = avg - baseline;
            if (lift > peak) { accumulatedGain += (lift - peak); peak = lift; peakWindow = w.slice(); gtNewPeak = true; }
          }
          quoteAvgs[qid] = { window: w, baseline, peak, peakWindow };
          gtRaceLog.push({
            quoteId: qid, [metric]: val,
            currentWindow: w.slice(),
            currentAvgCalc: gtAvgCalc(w, avg),
            currentAvg: Math.round(avg * 100) / 100,
            previousPeakWindow: gtPrevPeakWindow
              ? gtPrevPeakWindow
              : (gtBaselineWasNull ? "(no peak yet — window still warming up)"
                                   : "(individual scores weren't stored for this goal's existing peak before this build — the previousPeakAvg below is read from saved state (baseline+peak), NOT recomputed from races; the scores populate once this quote sets a NEW peak or the goal re-seeds)"),
            previousPeakAvg: gtPrevPeakAvg == null ? "(warming up)" : Math.round(gtPrevPeakAvg * 100) / 100,
            newPeakSetThisRace: gtNewPeak || undefined,
            gainAdded: Math.round((accumulatedGain - gtGainBefore) * 100) / 100,
          });
          impChanged = true;
        }
        gtLog(
          "Improvement goal recalculated",
          `${gtGoalTag(gd, "improvement")} — gain ${Math.round((gd.accumulatedGain ?? 0) * 100) / 100} → ${Math.round(accumulatedGain * 100) / 100}`,
          {
            goal: gtGoalTag(gd, "improvement"), track: "average", metric, windowSize: W,
            newRacesConsidered: chronological.length,
            racesEvaluated: gtRaceLog,
            accumulatedGain: { from: Math.round((gd.accumulatedGain ?? 0) * 100) / 100, to: Math.round(accumulatedGain * 100) / 100, gain: Math.round((accumulatedGain - (gd.accumulatedGain ?? 0)) * 100) / 100 },
            lastEvalRaces: { from: lastEval, to: racesSnapshot },
          }
        );
        if (impChanged || lastEval !== racesSnapshot) {
          goals[i] = { ...gd, quoteAvgs, accumulatedGain, lastEvalRaces: racesSnapshot };
          changed = true;
        }
        continue;
      }

      // Best track (default)
      const quoteBests = { ...(gd.quoteBests || {}) };
      const gtRaceLog = []; // [GT log] per-race outcomes for this goal
      for (const race of chronological) {
        if (!raceMatchesFilter(race, gd.filter)) { gtRaceLog.push({ quoteId: race?.quoteId, gamemode: race?.gamemode, outcome: "ignored — doesn't match goal filter" }); continue; }
        const val = Number(race[metric]);
        if (!isFinite(val)) { gtRaceLog.push({ quoteId: race?.quoteId, outcome: "ignored — no numeric metric value" }); continue; }
        const qid = race.quoteId;
        if (!qid) { gtRaceLog.push({ [metric]: val, outcome: "ignored — race has no quoteId" }); continue; }
        if (!(qid in quoteBests)) { gtRaceLog.push({ quoteId: qid, [metric]: val, outcome: "skipped — quote had no pre-race baseline seed (S1: race not counted)" }); continue; } // no pre-race baseline -> unmeasurable
        const prev = quoteBests[qid];
        if (val > prev) {
          accumulatedGain += (val - prev);
          quoteBests[qid]  = val;            // ratchet the stored best up
          impChanged = true;
          gtRaceLog.push({ quoteId: qid, [metric]: val, prevBest: prev, newBest: val, gainAdded: Math.round((val - prev) * 100) / 100 });
        } else {
          gtRaceLog.push({ quoteId: qid, [metric]: val, prevBest: prev, outcome: "no gain — didn't beat the stored best" });
        }
      }
      gtLog(
        "Improvement goal recalculated",
        `${gtGoalTag(gd, "improvement")} — gain ${Math.round((gd.accumulatedGain ?? 0) * 100) / 100} → ${Math.round(accumulatedGain * 100) / 100}`,
        {
          goal: gtGoalTag(gd, "improvement"), track: "best", metric,
          newRacesConsidered: chronological.length,
          racesEvaluated: gtRaceLog,
          accumulatedGain: { from: Math.round((gd.accumulatedGain ?? 0) * 100) / 100, to: Math.round(accumulatedGain * 100) / 100, gain: Math.round((accumulatedGain - (gd.accumulatedGain ?? 0)) * 100) / 100 },
          lastEvalRaces: { from: lastEval, to: racesSnapshot },
        }
      );
      if (impChanged || lastEval !== racesSnapshot) {
        goals[i] = { ...gd, quoteBests, accumulatedGain, lastEvalRaces: racesSnapshot };
        changed = true;
      }
    }

    if (changed) {
      saveGoals("improvement");
      if (!deferRender) renderAllGoals();
    }
  }
  const evaluateImprovementGuarded = inFlight(evaluateImprovementGoals);

  // ── Max quotes goal target computation ────────────────────────
  async function updateMaxQuotesGoals() {
    try {
      const goals = goalData.quotes;
      if (!goals || goals.length === 0) return;

      // ── Skip entirely if no goal actually uses maxQuotes ─────
      if (!goals.some(g => g.maxQuotes)) return;

      // Work out which on-site totals we actually need, then fetch each
      // ONCE (outside the loop) and in parallel.
      const needRanked   = goals.some(g => g.maxQuotes && maxQuotesKindOf(g) !== "unranked"); // ranked or all
      const needUnranked = goals.some(g => g.maxQuotes && (maxQuotesKindOf(g) === "unranked" || maxQuotesKindOf(g) === "all"));

      const [totalRanked, totalUnranked] = await Promise.all([
        needRanked   ? getTypeGGTotalQuotes()         : Promise.resolve(null),
        needUnranked ? getTypeGGTotalUnrankedQuotes() : Promise.resolve(null),
      ]);

      let changed = false;
      for (let i = 0; i < goals.length; i++) {
        const gd = goals[i];
        if (!gd.maxQuotes) continue;

        const kind = maxQuotesKindOf(gd);
        let total;
        if (kind === "ranked")        total = totalRanked;
        else if (kind === "unranked") total = totalUnranked;
        else                          total = (totalRanked != null && totalUnranked != null) ? totalRanked + totalUnranked : null;
        if (total == null) continue; // its fetch failed this tick — try again later

        const finalTarget = Math.max(0, total - gd.baselineQuotes);
        if (Math.abs(finalTarget - gd.target) > 0.01) {
          gtLog("Max-quotes goal target updated", `site total (${kind}) is now ${total} — target ${gd.target} → ${finalTarget}`, { kind, siteTotalQuotes: total, yourBaseline: gd.baselineQuotes, target: { from: gd.target, to: finalTarget } });
          gd.target = finalTarget;
          goals[i] = gd;
          changed = true;
        }
      }
      if (changed) saveGoals("quotes");
    } catch (err) {
      console.error("Max quotes update failed:", err);
    }
  }

  // ════════════════════════════════════════════════════════════
  // Cross-tab coordination: leader election + message listeners
  // ════════════════════════════════════════════════════════════

  // ── Start all fetch intervals. Only called once per browser,
  //    by whichever tab wins the leader lock. ─────────────────
  function startLeaderIntervals() {
    // Primary user-stats polling (fast, self-resetting — see scheduleNextStatsPoll)
    loadStats();
    scheduleNextStatsPoll();

    // Slow background updates — staggered initial kickoffs so we don't
    // burst the API in the first seconds after becoming leader. Bursting all
    // of these together is a primary trigger for TypeGG's per-IP rate limiter
    // (which then throttles every request, extension and otherwise), so each
    // kickoff gets its own slot.
    setTimeout(() => runIfAnyTabVisible(inFlight(updateRankGoals))(),      3_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updateExpRankGoals))(),   6_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updatePlayerGoals))(),    9_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updateMaxQuotesGoals))(), 12_000);
    setTimeout(() => runIfAnyTabVisible(evaluateRaceRequirementsGuarded)(), 15_000);
    setTimeout(() => runIfAnyTabVisible(evaluateImprovementGuarded)(), 16_000);
    // EXP-rank tracking paginates the /leaders board; it used to fire
    // synchronously at leader start, landing right on top of the other
    // kickoffs. Stagger it too. (Internally gated on having EXP rank goals.)
    setTimeout(() => updateExpRankTracking(), 18_000);
    // Rival stores: build/resume the self store (only if a rival goal exists)
    // + any referenced rival stores, and register refresh timers. Pushed to
    // the END of the stagger so the heavy bulk build doesn't pile onto the
    // leaderboard polls. ensureRivalSync is leader-gated and its fetches
    // self-gate on visibility + the global rival backoff.
    setTimeout(() => ensureRivalSync(), 21_000);
    // Quote catalog (improvement-Target goals only): one-time full build /
    // resume, else a delta refresh. Self-gates on a Target goal existing, so
    // this is a cheap no-op for everyone else. Last in the stagger.
    setTimeout(() => maybeRunQuoteCatalog(), 24_000);

    setInterval(runIfAnyTabVisible(inFlight(updateRankGoals)),       POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateExpRankGoals)),    POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updatePlayerGoals)),     POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateMaxQuotesGoals)),  POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateExpRankTracking)), POLL_SLOW_MS);
    // Slow safety-net for race requirement goals — the primary trigger is
    // applyUserData detecting a races stat bump (driven by quote-finish events
    // and the 20s stats poll). This interval just catches edge cases where
    // a quote-finish was missed and stats were already in sync on next render.
    setInterval(runIfAnyTabVisible(evaluateRaceRequirementsGuarded), POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(evaluateImprovementGuarded), POLL_SLOW_MS);
    setInterval(runQuoteCatalogDriver, POLL_SLOW_MS); // build runs hidden; delta self-gates inside
  }

  // ── Channel listener (followers receive stats from leader) ──
  channel?.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'visible-ping') {
      lastAnyVisibleTime = Date.now();
      return;
    }

    if (msg.type === 'rec-settings-changed') {
      recSettings = loadRecSettings();
      migrateRecurringGoalPeriodStarts(); // preserve in-period progress
      renderAllGoals();
      return;
    }

    if (msg.type === 'display-settings-changed') {
      displaySettings = loadDisplaySettings();
      renderAllGoals();
      return;
    }

    if (msg.type === 'improve-settings-changed') {
      // Target Next-quote ordering is read live at click time, so just refresh
      // the cached value for this tab.
      improveSettings = loadImproveSettings();
      return;
    }

    if (msg.type === 'rival-settings-changed') {
      rivalSettings = loadRivalSettings();
      // Scope affects the standings shown on every rival card, so re-render;
      // the leader also reconciles in case the unranked stream is now needed.
      renderAllGoals();
      if (isLeader) ensureRivalSync();
      return;
    }

    if (msg.type === 'groups-changed') {
      // Another tab reshaped the group layout. Skip if we're mid-drag.
      if (dragInProgress) return;
      const saved = loadGroups();
      if (saved) groupData = saved;
      ensureMainGroup();
      renderGroupWidgets();
      renderAllGoals();
      return;
    }

    if (msg.type === 'stats' && !isLeader) {
      // Fresh stats from the leader — apply and re-render
      applyUserData(msg.payload);
      return;
    }

    if (msg.type === 'quote-finished' && isLeader) {
      // A follower tab detected a quote finish — honor it (with cooldown)
      handleQuoteFinishAsLeader();
      return;
    }

    if (msg.type === 'rival-store') {
      // The leader updated (or GC'd) a rival/self store. Reload our cached copy
      // from IDB; reloadRivalStoreFromDisk re-renders on completion.
      if (msg.storeKey) reloadRivalStoreFromDisk(msg.storeKey);
      return;
    }

    if (msg.type === 'rival-meta') {
      // The leader updated the shared quote-meta table. Reload + re-render.
      reloadRivalMetaFromDisk();
      return;
    }

    if (msg.type === 'quote-catalog') {
      // The leader grew / re-synced the quote catalog. Reload + re-render.
      reloadQuoteCatalogFromDisk();
      return;
    }

    if (msg.type === 'goals-changed') {
      // Another tab modified goals. Reload from localStorage + re-render.
      const t = msg.goalType;
      if (t && GOAL_CONFIG[t]) {
        try {
          goalData[t] = JSON.parse(localStorage.getItem(GOAL_CONFIG[t].storageKey) || '[]');
        } catch { goalData[t] = []; }
        renderAllGoals();
        // Leader: run relevant target updates for the new/changed goals
        if (isLeader) {
          if (t === 'pp')     inFlight(updateRankGoals)();
          if (t === 'exp')    inFlight(updateExpRankGoals)();
          if (t === 'quotes') inFlight(updateMaxQuotesGoals)();
          if (t === 'races')  evaluateRaceRequirementsGuarded();
          if (t === 'improvement') { evaluateImprovementGuarded(); maybeRunQuoteCatalog(); }
          if (t === 'pp' || t === 'exp') inFlight(updatePlayerGoals)();
          if (t === 'rival')  ensureRivalSync();
        }
      }
      return;
    }
  });

  // ── Storage event listener (backup path for goal changes) ───
  // Fires in OTHER tabs when localStorage is modified. Handles the case
  // where a tab joins late or misses a BroadcastChannel message.
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    // Native storage events carry the PHYSICAL key (universe-prefixed); map
    // it back to logical key space so the comparisons below still match.
    const k = logiKey(e.key);

    // Auth changed in another tab (TypeGG's own key)? Re-evaluate the gate.
    if (k === 'pocketbase_auth') { checkAuthTransition(); return; }

    // Recurrence settings change?
    if (k === REC_SETTINGS_KEY) {
      recSettings = loadRecSettings();
      migrateRecurringGoalPeriodStarts(); // preserve in-period progress
      renderAllGoals();
      return;
    }

    // Display settings change?
    if (k === DISPLAY_SETTINGS_KEY) {
      displaySettings = loadDisplaySettings();
      renderAllGoals();
      return;
    }

    // Improve settings change? (Next-quote ordering — read live, no re-render.)
    if (k === IMPROVE_SETTINGS_KEY) {
      improveSettings = loadImproveSettings();
      return;
    }

    // Rival settings change?
    if (k === RIVAL_SETTINGS_KEY) {
      rivalSettings = loadRivalSettings();
      renderAllGoals();
      if (isLeader) ensureRivalSync();
      return;
    }

    // Groups (widget layout) change?
    if (k === GROUPS_KEY) {
      if (dragInProgress) return;
      try {
        const parsed = e.newValue ? JSON.parse(e.newValue) : null;
        if (parsed && parsed[MAIN_GROUP_ID]) groupData = parsed;
      } catch {}
      ensureMainGroup();
      renderGroupWidgets();
      renderAllGoals();
      return;
    }

    // Goal data change?
    for (const [type, cfg] of Object.entries(GOAL_CONFIG)) {
      if (k === cfg.storageKey) {
        try {
          goalData[type] = JSON.parse(e.newValue || '[]');
        } catch { goalData[type] = []; }
        renderAllGoals();
        if (isLeader) {
          if (type === 'pp')     inFlight(updateRankGoals)();
          if (type === 'exp')    inFlight(updateExpRankGoals)();
          if (type === 'quotes') inFlight(updateMaxQuotesGoals)();
          if (type === 'races')  evaluateRaceRequirementsGuarded();
          if (type === 'improvement') { evaluateImprovementGuarded(); maybeRunQuoteCatalog(); }
          if (type === 'pp' || type === 'exp') inFlight(updatePlayerGoals)();
          if (type === 'rival')  ensureRivalSync();
        }
        return;
      }
    }

    // (Rival/self stores moved to IndexedDB — they no longer fire storage
    // events; cross-tab propagation rides the 'rival-store' / 'rival-meta'
    // BroadcastChannel messages instead.)

    // Stats cache updated by leader? Hydrate.
    if (k === STATS_CACHE_KEY && e.newValue && !isLeader) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed?.data) applyUserData(parsed.data);
      } catch {}
      return;
    }

    // EXP rank cache updated by leader? Hydrate.
    if (k === 'gt-exp-rank' && e.newValue) {
      try { currentStats.expRank = JSON.parse(e.newValue).rank; } catch {}
    }
  });

  // ── Auth-state watcher (login / logout transitions) ──────────
  // getAuth() (TypeGG's pocketbase_auth) is the source of truth. A login or
  // logout in THIS tab does NOT fire a storage event (those are cross-tab
  // only), and when logged out the stats poll is paused so there's nothing to
  // piggyback — so we also poll the auth state on a light interval. The
  // cross-tab case is handled by the storage listener above; both funnel
  // through checkAuthTransition. On a transition we re-render (panel ↔ goals)
  // and, when logging in as the leader, kick an immediate refresh so the user
  // doesn't wait a full poll; logging out tears down the rival timers (the
  // fetch guards already stop traffic — this just clears the machinery).
  let gtAuthState = isLoggedIn();
  function onAuthChange(loggedIn) {
    if (loggedIn) {
      renderGroupWidgets(); // rebuild detached widgets that were hidden
      renderAllGoals();     // clears the gate, renders goals
      if (isLeader) {
        loadStatsGuarded(); // immediate stats — don't wait for the 20s poll
        ensureRivalSync();  // self prefetch + any rival stores
      }
    } else {
      renderAllGoals();     // show the login panel, hide goal UI
      if (isLeader) ensureRivalSync(); // logged-out branch stops rival timers
    }
  }
  function checkAuthTransition() {
    const now = isLoggedIn();
    if (now === gtAuthState) return;
    gtAuthState = now;
    console.log(`[Goal Tracker] auth ${now ? "login" : "logout"} detected`);
    onAuthChange(now);
  }
  setInterval(checkAuthTransition, 3_000);

  // ── Hydrate rival stores from IndexedDB (every tab) ──────────
  // Runs the one-time localStorage→IDB migration, loads stores into the cache,
  // then enables sync. Fire-and-forget; self-gates everything on rivalIdbReady.
  initRivalStorage();

  // ── Hydrate from cached stats for immediate render ───────────
  // Lets fresh tabs show accurate progress without waiting for the
  // leader's next fetch tick. Works even if we end up as leader.
  try {
    const cached = JSON.parse(localStorage.getItem(STATS_CACHE_KEY) || 'null');
    if (cached?.data && (Date.now() - cached.timestamp < STATS_CACHE_TTL)) {
      applyUserData(cached.data);
    }
  } catch {}

  // ── Leader election ─────────────────────────────────────────
  // Uses the Web Locks API to ensure exactly one tab fetches data.
  // The lock callback holds forever; when the tab closes, the lock
  // releases automatically and another tab's pending request wins.
  //
  // Firefox note: inside a content script, navigator.locks.request with
  // an async callback can reject with "Permission denied to access
  // property 'then'" — the platform can't read .then on the promise our
  // callback returns across the content-script security boundary. When
  // that happens (or the API is missing entirely), we fall back to acting
  // as our own leader so the widget still fetches and renders. Worst case
  // is the old per-tab behaviour (each tab fetches) — cross-tab dedup is
  // lost, but the widget always works. becomeLeader() is idempotent so the
  // callback path and the error-fallback path can't double-start intervals.
  function becomeLeader(reason) {
    if (isLeader) return;
    isLeader = true;
    console.log(`[Goal Tracker] became leader tab${reason ? ` (${reason})` : ""}`);
    startLeaderIntervals();
  }

  if ('locks' in navigator) {
    try {
      const req = navigator.locks.request(LEADER_LOCK_NAME, { mode: 'exclusive' }, () => {
        becomeLeader();
        // Hold the lock for the lifetime of this tab
        return new Promise(() => {});
      });
      // The returned value may reject asynchronously on Firefox (the .then
      // Xray error). Guard the .catch call itself in case the return value
      // isn't a normal promise in some engines.
      if (req && typeof req.catch === 'function') {
        req.catch(err => {
          console.warn('[Goal Tracker] leader lock error — falling back to per-tab fetching:', err);
          becomeLeader('lock error fallback');
        });
      }
    } catch (err) {
      // Synchronous throw (also seen on some Firefox builds).
      console.warn('[Goal Tracker] leader lock threw — falling back to per-tab fetching:', err);
      becomeLeader('lock throw fallback');
    }
  } else {
    // Old browsers without Web Locks API.
    console.warn('[Goal Tracker] Web Locks API unavailable — falling back to per-tab fetching');
    becomeLeader('no Web Locks API');
  }

}

// ── Bootstrap ──────────────────────────────────────────────────
// Do NOT rely solely on the "load" event. Content scripts run at
// document_idle by default, and on Firefox that often fires AFTER the
// page's load event has already happened — a "load" listener added then
// never fires, so the whole widget never builds (and no leader-election
// error appears, because that code never runs either). This is the cause
// of the widget vanishing on refresh in Firefox while Chromium is fine.
// Run immediately if the document is already loaded; otherwise wait once.
(function bootstrap() {
  let started = false;
  const start = () => { if (started) return; started = true; gtMain(); };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();