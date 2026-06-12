function gtMain() {

  // Defensive: if our widget somehow already exists (double injection),
  // don't build a second one.
  if (document.getElementById("goal-tracker")) return;

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

  // ── Cross-tab coordination ───────────────────────────────────
  // Goal: with 4 TypeGG tabs open, only ONE fetches from the API.
  // The "leader" tab runs the intervals; follower tabs receive data
  // via BroadcastChannel and just update their UI.
  const CHANNEL_NAME     = 'gt-sync';
  const LEADER_LOCK_NAME = 'gt-leader';
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
  //   • On a network/CORS failure or a 429/5xx, escalates a SHARED backoff
  //     (30s → 60s → … → 15 min cap) that pauses ALL API traffic together.
  //   • On any genuine response (2xx, or a 404 "not found"), resets it.
  // This single coordinated gate is the thing that lets a throttle clear.
  const API_BACKOFF_BASE_MS = 30_000;
  const API_BACKOFF_MAX_MS  = 15 * 60_000;
  let apiBackoffUntil = 0;
  let apiBackoffFails = 0;
  function apiThrottled() { return Date.now() < apiBackoffUntil; }
  function apiBackoffRemainingMs() { return Math.max(0, apiBackoffUntil - Date.now()); }
  function apiNoteFailure() {
    apiBackoffFails = Math.min(apiBackoffFails + 1, 12);
    const wait = Math.min(API_BACKOFF_MAX_MS, API_BACKOFF_BASE_MS * 2 ** (apiBackoffFails - 1));
    // Only ever extend the window (concurrent failures shouldn't shrink it).
    apiBackoffUntil = Math.max(apiBackoffUntil, Date.now() + wait);
    console.warn(`[Goal Tracker] API throttled — pausing all requests ~${Math.round(wait / 1000)}s (failure #${apiBackoffFails})`);
  }
  function apiNoteSuccess() {
    if (apiBackoffFails || apiBackoffUntil) {
      apiBackoffFails = 0;
      apiBackoffUntil = 0;
    }
  }
  // Marker so callers can tell "we deliberately skipped" from a real failure.
  const API_THROTTLED_ERR  = "gt-api-throttled";
  const API_LOGGED_OUT_ERR = "gt-api-logged-out";
  async function gtApiFetch(url, opts) {
    if (!isLoggedIn()) {
      // Logged out: make NO request (every TypeGG endpoint would 401, and the
      // logged-out gate already short-circuits the pollers — this is the final
      // backstop). Throw the same shape as the throttle skip so existing catch
      // paths handle it; do NOT escalate the backoff (not a rate-limit signal).
      const e = new Error(API_LOGGED_OUT_ERR);
      e.gtLoggedOut = true;
      throw e;
    }
    if (apiThrottled()) {
      const e = new Error(API_THROTTLED_ERR);
      e.gtThrottled = true;
      throw e;
    }
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      apiNoteFailure(); // network / CORS-with-no-header → the rate-limit signature
      throw e;
    }
    if (r.ok || r.status === 404) apiNoteSuccess();
    else apiNoteFailure(); // 429 / 500 / 502 / 503 → back off too
    return r;
  }

  function userEndpoint() {
    const { username } = getAuth();
    return `https://api.typegg.io/v1/users/${username ?? "fruit"}`;
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
  // Shape: { [groupId]: { position: {left,top}|null, size: {width}|null, goalIds: [...] } }
  //   - position: null for main = use CSS default (top-right). Detached widgets always have a position.
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
    const typeOrder = ['exp', 'pp', 'races', 'quotes', 'playtime', 'chars'];
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
    w.classList.toggle("gt-widget-has-avg", groupHasAvgGoal(groupId));
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
            <button id="${goalId}-remove-btn" class="gt-remove-btn" title="Remove goal">✕</button>
          </div>
        </div>
        <div class="gt-rival-value-row">
          <span id="${goalId}-rival-value-wrap" class="gt-rival-value-wrap">
            <span id="${goalId}-rival-you" class="gt-rival-you"></span><span id="${goalId}-rival-them" class="gt-rival-them"></span>
          </span>
          <span id="${goalId}-rival-msg" class="gt-rival-msg" style="display:none;"></span>
        </div>
        <div id="${goalId}-rival-wins" class="gt-rival-wins">Wins: …</div>
        <button id="${goalId}-rival-next" class="gt-rival-next-btn" disabled>⚔ Next</button>
      `;
      (parentContent || container.querySelector(".gt-content")).appendChild(section);

      document.getElementById(`${goalId}-remove-btn`).addEventListener("click", async () => {
        const gd = (goalData.rival || []).find(g => g.id === goalId);
        const labelText = gd ? `Rival · ${gd.rival} (${(gd.metric || "wpm").toUpperCase()})` : "Rival goal";
        if (await confirmDeleteGoal(labelText)) removeGoal("rival", goalId);
      });

      // Clicking the challenge button jumps to a random quote where the rival
      // currently beats you. Handler reads live state at click time.
      document.getElementById(`${goalId}-rival-next`).addEventListener("click", () => {
        onRivalNextClicked(goalId);
      });

      wireGoalDrag(section, goalId);
      return section;
    }

    section.innerHTML = `
      <div class="gt-gain-header">
        <div class="gt-goal-label-group">
          <span id="${goalId}-label">${cfg.label}</span>
          <span id="${goalId}-rec-badge" class="gt-rec-badge" style="display:none;"></span>
        </div>
        <div class="gt-goal-actions">
          <span id="${goalId}-streak" class="gt-streak" style="display:none;"></span>
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

    // Wire goal-level drag
    wireGoalDrag(section, goalId);

    return section;
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
    if (position) {
      w.style.left = position.left;
      w.style.top  = position.top;
    }
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

  // ── Apply position / size from groupData to a widget ──────────
  function applyWidgetTransform(widgetEl, groupId) {
    const group = groupData[groupId];
    if (!group) return;
    if (group.position) {
      widgetEl.style.right = "auto";
      widgetEl.style.left  = group.position.left;
      widgetEl.style.top   = group.position.top;
    }
    if (group.size?.width) {
      widgetEl.style.width = group.size.width;
    }
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
      groupData[groupId].position = { left: widgetEl.style.left, top: widgetEl.style.top };
      saveGroups();
    }
    wDrag = null;
  });

  wireWidgetDrag(container, MAIN_GROUP_ID);

  // ── Resize persistence ────────────────────────────────────────
  // Watches a widget for size changes and persists the new width to
  // its group's storage. Debounced so dragging the resize handle
  // doesn't spam saveGroups(). One observer per widget; when the
  // widget is removed from the DOM the observer becomes inert.
  function observeWidgetResize(widgetEl, groupId) {
    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!groupData[groupId]) return;
        groupData[groupId].size = { width: widgetEl.offsetWidth + "px" };
        saveGroups();
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
            groupData[d.sourceGroupId].position = {
              left: widgetEl.style.left,
              top:  widgetEl.style.top,
            };
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

      if (!targetGroupId) {
        // Empty space → new detached widget at drop point
        targetGroupId = generateGroupId();
        groupData[targetGroupId] = {
          position: { left: (e.clientX - d.offX) + "px", top: (e.clientY - d.offY) + "px" },
          size: null,
          goalIds: [],
        };
        targetIndex = 0;
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
      <!-- Rival-mode controls (type=rival only). A WPM/PP metric selector
           chooses which stat is compared against the rival. The rival's
           username is entered in the standard Amount-row input (reused as a
           text field, like Player mode). No mode / recurrence / target. -->
      <div id="gt-rival-metric-row" style="display:none;">
        <div class="gt-section-label">Metric</div>
        <div class="gt-req-selector">
          <div class="gt-req-group gt-rival-metric-group">
            <button class="gt-mode-btn active" data-rival-metric="wpm" type="button">WPM</button>
            <button class="gt-mode-btn"        data-rival-metric="pp"  type="button">PP</button>
          </div>
        </div>
        <div class="gt-section-label">Track</div>
        <div class="gt-mode-selector gt-rival-scope-group">
          <button class="gt-mode-btn active" data-rival-scope="all"      type="button">All</button>
          <button class="gt-mode-btn"        data-rival-scope="ranked"   type="button">Ranked</button>
          <button class="gt-mode-btn"        data-rival-scope="unranked" type="button">Unranked</button>
        </div>
        <div class="gt-mode-hint" id="gt-rival-scope-modal-hint" style="display:block;"></div>
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
        <div class="gt-target-row">
          <div id="gt-max-quotes-row" style="display:none;">
            <button id="gt-max-all-btn"      class="gt-mode-btn">⚡ Max all</button>
            <button id="gt-max-ranked-btn"   class="gt-mode-btn">⚡ Max ranked</button>
            <button id="gt-max-unranked-btn" class="gt-mode-btn">⚡ Max unranked</button>
          </div>
          <div id="gt-next-rank-row" style="display:none; margin-bottom: 6px;">
            <button id="gt-next-rank-btn" class="gt-mode-btn" style="width:100%;">⚡ Next Rank</button>
          </div>
          <div id="gt-presets" class="gt-presets"></div>
          <input id="gt-custom-input" class="gt-custom-input" type="number" min="1" placeholder="Custom" />
        </div>
      </div>
      <div id="gt-mode-hint" class="gt-mode-hint" style="display:none;"></div>
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

  let activeSettingsTabId = null;    // which sidebar tab is currently shown
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

  // ── Rival tab ─────────────────────────────────────────────────
  // Settings that apply globally to every rival goal: which quotes are tracked
  // (all / ranked / unranked) and where the "⚔ Next vs …" button navigates.
  const RIVAL_SCOPE_OPTIONS = [
    { value: "all",      label: "All",      hint: "Counts every quote your rival has typed — ranked and unranked." },
    { value: "ranked",   label: "Ranked",   hint: "Counts only your rival's ranked quotes." },
    { value: "unranked", label: "Unranked", hint: "Counts only your rival's unranked quotes." },
  ];
  const RIVAL_NEXT_LINK_OPTIONS = [
    { value: false, label: "Quote only",  hint: "Opens the quote on its own: typegg.io/solo/<quote>" },
    { value: true,  label: "Versus rival", hint: "Opens a head-to-head against the rival on that quote: typegg.io/solo/<quote>/vs/<rival>" },
  ];
  const RIVAL_NEXT_SORT_OPTIONS = [
    { value: "random",  label: "Random",   hint: "Picks a random quote where the rival beats you." },
    { value: "closest", label: "Closest",  hint: "Smallest gap first — the quote you're nearest to beating; each click steps to the next-closest, then wraps around." },
    { value: "biggest", label: "Biggest",  hint: "Largest gap first — where you're furthest behind; each click steps to the next-biggest, then wraps around." },
  ];
  const RIVAL_COUNT_OPTIONS = [
    { value: false, label: "Rival's quotes", hint: "Counts every quote the rival has typed, and the “⚔ Next vs …” button can send you to any of them — including quotes you haven't raced yet, so you can chase all their scores." },
    { value: true,  label: "Shared only",    hint: "Counts only quotes you've both raced, and “⚔ Next vs …” stays on those — a strict head-to-head on common ground." },
  ];

  function renderRivalTab(contentEl, draft) {
    const curScope = RIVAL_SCOPE_VALUES.includes(draft.rivalSettings.scope) ? draft.rivalSettings.scope : "all";
    const curSort  = RIVAL_NEXT_SORT_VALUES.includes(draft.rivalSettings.nextSort) ? draft.rivalSettings.nextSort : "random";
    const curCount = !!draft.rivalSettings.requireBoth;
    const current  = draft.rivalSettings.nextUsesVsLink;
    contentEl.innerHTML = `
      <div class="gt-section-label">Track which of the rival's quotes</div>
      <div class="gt-mode-selector" id="gt-rival-scope-selector">
        ${RIVAL_SCOPE_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === curScope ? " active" : ""}" data-rival-scope="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-scope-hint" style="display:block;">${
        RIVAL_SCOPE_OPTIONS.find(o => o.value === curScope)?.hint ?? ""
      }</div>
      <div class="gt-mode-hint" style="display:block; margin-top:8px; opacity:0.75;">Sets the wins total and the “⚔ Next vs …” pool for every rival goal.</div>

      <div class="gt-section-label" style="margin-top:16px;">Difficulty filter<span class="gt-range-readout" id="gt-rival-diff-readout"></span></div>
      <div class="gt-range" id="gt-rival-diff-range">
        <div class="gt-range-track"><div class="gt-range-fill"></div></div>
        <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum difficulty" />
        <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum difficulty" />
      </div>
      <div class="gt-range-ticks" id="gt-rival-diff-ticks"></div>

      <div class="gt-section-label" style="margin-top:14px;">Quote length filter<span class="gt-range-readout" id="gt-rival-len-readout"></span></div>
      <div class="gt-range" id="gt-rival-len-range">
        <div class="gt-range-track"><div class="gt-range-fill"></div></div>
        <input class="gt-range-input gt-range-lo" type="range" aria-label="Minimum length" />
        <input class="gt-range-input gt-range-hi" type="range" aria-label="Maximum length" />
      </div>
      <div class="gt-range-ticks" id="gt-rival-len-ticks"></div>
      <div class="gt-mode-hint" style="display:block; margin-top:8px; opacity:0.75;">Only the rival's quotes inside both ranges count toward the wins total and the Next-vs pool. Full range = no filter.</div>

      <div class="gt-section-label" style="margin-top:16px;">Quotes to beat</div>
      <div class="gt-mode-selector" id="gt-rival-count-selector">
        ${RIVAL_COUNT_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === curCount ? " active" : ""}" data-rival-count="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-count-hint" style="display:block;">${
        RIVAL_COUNT_OPTIONS.find(o => o.value === curCount)?.hint ?? ""
      }</div>
      <div class="gt-mode-hint" style="display:block; margin-top:8px; opacity:0.75;">Sets the wins total and which quotes “⚔ Next vs …” can send you to.</div>

      <div class="gt-section-label" style="margin-top:16px;">“⚔ Next vs …” button picks</div>
      <div class="gt-mode-selector" id="gt-rival-nextsort-selector">
        ${RIVAL_NEXT_SORT_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === curSort ? " active" : ""}" data-next-sort="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-nextsort-hint" style="display:block;">${
        RIVAL_NEXT_SORT_OPTIONS.find(o => o.value === curSort)?.hint ?? ""
      }</div>
      <div class="gt-mode-hint" style="display:block; margin-top:8px; opacity:0.75;">Gap is measured on each goal's own metric (WPM or PP).</div>

      <div class="gt-section-label" style="margin-top:16px;">“⚔ Next vs …” button opens</div>
      <div class="gt-mode-selector" id="gt-rival-nextlink-selector">
        ${RIVAL_NEXT_LINK_OPTIONS.map(o =>
          `<button class="gt-mode-btn${o.value === current ? " active" : ""}" data-next-vs="${o.value}">${o.label}</button>`
        ).join("")}
      </div>
      <div class="gt-mode-hint" id="gt-rival-nextlink-hint" style="display:block;">${
        RIVAL_NEXT_LINK_OPTIONS.find(o => o.value === current)?.hint ?? ""
      }</div>
      <div class="gt-mode-hint" style="display:block; margin-top:8px; opacity:0.75;">Applies to the “⚔ Next vs …” button on every rival goal.</div>
    `;

    const scopeHintEl = contentEl.querySelector("#gt-rival-scope-hint");
    contentEl.querySelectorAll("[data-rival-scope]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.rivalScope;
        draft.rivalSettings.scope = val;
        contentEl.querySelectorAll("[data-rival-scope]").forEach(b => b.classList.toggle("active", b === btn));
        if (scopeHintEl) scopeHintEl.textContent = RIVAL_SCOPE_OPTIONS.find(o => o.value === val)?.hint ?? "";
        applySettingsDraft();
      });
    });

    const countHintEl = contentEl.querySelector("#gt-rival-count-hint");
    contentEl.querySelectorAll("[data-rival-count]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.rivalCount === "true";
        draft.rivalSettings.requireBoth = val;
        contentEl.querySelectorAll("[data-rival-count]").forEach(b => b.classList.toggle("active", b === btn));
        if (countHintEl) countHintEl.textContent = RIVAL_COUNT_OPTIONS.find(o => o.value === val)?.hint ?? "";
        applySettingsDraft();
      });
    });

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

    // ── Difficulty / length range sliders ──────────────────────
    // Two overlapping range inputs per axis form a dual-handle slider. The
    // lo/hi numbers in the readout are inline-editable: click to drop a caret
    // (the value auto-selects so you can just type a replacement), digits and
    // backspace work like a text field, Enter or blur commits, Escape reverts.
    // Both dragging and typing are clamped so the min handle can never pass the
    // max (and vice versa). Difficulty steps 0.1, length steps 1.
    const rvAxis = rivalFilterAxis(); // data-driven bounds for both sliders
    const clampVal = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    function setupRivalRange(rangeId, readoutId, ticksId, opts) {
      const root = contentEl.querySelector(`#${rangeId}`);
      if (!root) return;
      const loIn = root.querySelector(".gt-range-lo");
      const hiIn = root.querySelector(".gt-range-hi");
      const fill = root.querySelector(".gt-range-fill");
      const readout = contentEl.querySelector(`#${readoutId}`);
      const ticksEl = contentEl.querySelector(`#${ticksId}`);
      const { min, max, step, ticks, set, decimals } = opts;
      const snap = (v) => {
        const n = Math.round(v / step) * step;
        return decimals ? Math.round(n * 10) / 10 : Math.round(n);
      };
      const numStr = (v) => (decimals ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
      for (const inp of [loIn, hiIn]) { inp.min = min; inp.max = max; inp.step = step; }
      loIn.value = snap(opts.lo); hiIn.value = snap(opts.hi);
      if (ticksEl) ticksEl.innerHTML = ticks.map(t => `<span>${t}</span>`).join("");

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

      const onInput = (which) => {
        let lv = +loIn.value, hv = +hiIn.value;
        if (which === "lo" && lv > hv) { lv = hv; loIn.value = lv; }
        if (which === "hi" && hv < lv) { hv = lv; hiIn.value = hv; }
        set(lv, hv);
        paint();
      };
      loIn.addEventListener("input", () => onInput("lo"));
      hiIn.addEventListener("input", () => onInput("hi"));
      loIn.addEventListener("change", applySettingsDraft);
      hiIn.addEventListener("change", applySettingsDraft);

      // Raise whichever thumb is nearer the pointer so overlapping handles stay grabbable.
      root.addEventListener("pointerdown", (e) => {
        const rect = root.getBoundingClientRect();
        if (!rect.width) return;
        const x = e.clientX - rect.left;
        const loX = ((+loIn.value - min) / (max - min)) * rect.width;
        const hiX = ((+hiIn.value - min) / (max - min)) * rect.width;
        const loCloser = Math.abs(x - loX) <= Math.abs(x - hiX);
        loIn.style.zIndex = loCloser ? 5 : 4;
        hiIn.style.zIndex = loCloser ? 4 : 5;
        // A direct thumb grab reports e.target as the input itself (the thumb is
        // pointer-events:auto); a track click passes through the pointer-events:none
        // input. So when this isn't a thumb hit, treat it as a track click: jump the
        // nearer handle to the click (tie -> max) and commit via the same path as a drag.
        if (e.target === loIn || e.target === hiIn) return;
        const moveLo = Math.abs(x - loX) < Math.abs(x - hiX);
        const frac = Math.min(1, Math.max(0, x / rect.width));
        let v = Math.min(max, Math.max(min, snap(min + frac * (max - min))));
        if (moveLo) {
          if (v > +hiIn.value) v = +hiIn.value;
          loIn.value = v; loIn.style.zIndex = 5; hiIn.style.zIndex = 4;
        } else {
          if (v < +loIn.value) v = +loIn.value;
          hiIn.value = v; hiIn.style.zIndex = 5; loIn.style.zIndex = 4;
        }
        set(+loIn.value, +hiIn.value);
        paint();
        applySettingsDraft();
      });

      // Inline-edit the lo/hi numbers like a text field.
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
          set(+loIn.value, +hiIn.value);
          applySettingsDraft();
        }
        paint(); // normalise the display (also reverts a junk entry)
      };
      const wireEdit = (el, side) => {
        if (!el) return;
        // First click on the number: take over focus ourselves (so the gap
        // around it can't grab a caret), make it editable, and select the value
        // so a keystroke replaces it. A click while already editing is left
        // alone so you can place the caret between digits.
        el.addEventListener("mousedown", (e) => {
          if (el.getAttribute("contenteditable") === "true") return;
          e.preventDefault();
          el.setAttribute("contenteditable", "true");
          el.focus();
          setTimeout(() => selectAllText(el), 0);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter")  { e.preventDefault(); el.blur(); return; }
          if (e.key === "Escape") { e.preventDefault(); paint(); el.blur(); return; }
          const k = e.key;
          if (k.length === 1 && !/[0-9]/.test(k) && !(decimals && k === ".") && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
          }
        });
        el.addEventListener("blur", () => {
          el.removeAttribute("contenteditable"); // back to plain text until the next click
          commitEdit(el, side);
        });
      };
      wireEdit(loNum, "lo");
      wireEdit(hiNum, "hi");

      paint();
    }
    // Difficulty ticks: integers across the axis (thinned if the span is wide),
    // last shown as "N+". A null handle (open) sits at the axis end; on commit a
    // handle dragged/typed to an axis end is stored back as null so it stays open.
    // Only the two ends, like the length slider: difficulty values aren't evenly
    // spaced across the axis, so flex-spaced middle ticks would misalign.
    const diffTicks = [String(rvAxis.diffMin), `${rvAxis.diffMax}+`];
    setupRivalRange("gt-rival-diff-range", "gt-rival-diff-readout", "gt-rival-diff-ticks", {
      min: rvAxis.diffMin, max: rvAxis.diffMax, step: 0.1, decimals: true, ticks: diffTicks,
      lo: (draft.rivalSettings.diffMin == null) ? rvAxis.diffMin : clampVal(draft.rivalSettings.diffMin, rvAxis.diffMin, rvAxis.diffMax, rvAxis.diffMin),
      hi: (draft.rivalSettings.diffMax == null) ? rvAxis.diffMax : clampVal(draft.rivalSettings.diffMax, rvAxis.diffMin, rvAxis.diffMax, rvAxis.diffMax),
      set: (lo, hi) => {
        draft.rivalSettings.diffMin = (lo <= rvAxis.diffMin) ? null : lo;
        draft.rivalSettings.diffMax = (hi >= rvAxis.diffMax) ? null : hi;
      },
    });
    setupRivalRange("gt-rival-len-range", "gt-rival-len-readout", "gt-rival-len-ticks", {
      min: rvAxis.lenMin, max: rvAxis.lenMax, step: 1, decimals: false,
      ticks: [String(rvAxis.lenMin), `${rvAxis.lenMax}+`],
      lo: (draft.rivalSettings.lenMin == null) ? rvAxis.lenMin : clampVal(draft.rivalSettings.lenMin, rvAxis.lenMin, rvAxis.lenMax, rvAxis.lenMin),
      hi: (draft.rivalSettings.lenMax == null) ? rvAxis.lenMax : clampVal(draft.rivalSettings.lenMax, rvAxis.lenMin, rvAxis.lenMax, rvAxis.lenMax),
      set: (lo, hi) => {
        draft.rivalSettings.lenMin = (lo <= rvAxis.lenMin) ? null : lo;
        draft.rivalSettings.lenMax = (hi >= rvAxis.lenMax) ? null : hi;
      },
    });
  }

  function commitRivalTab(draft) {
    const linkChanged  = draft.rivalSettings.nextUsesVsLink !== rivalSettings.nextUsesVsLink;
    const scopeChanged = draft.rivalSettings.scope        !== rivalSettings.scope;
    const sortChanged  = draft.rivalSettings.nextSort     !== rivalSettings.nextSort;
    const countChanged = draft.rivalSettings.requireBoth  !== rivalSettings.requireBoth;
    const filterChanged =
      draft.rivalSettings.diffMin !== rivalSettings.diffMin ||
      draft.rivalSettings.diffMax !== rivalSettings.diffMax ||
      draft.rivalSettings.lenMin  !== rivalSettings.lenMin  ||
      draft.rivalSettings.lenMax  !== rivalSettings.lenMax;
    if (!linkChanged && !scopeChanged && !sortChanged && !countChanged && !filterChanged) return; // no change
    rivalSettings = { ...draft.rivalSettings };
    saveRivalSettings();
    if (scopeChanged) {
      // Scope drives the standings (wins/total) and the Next-vs pool, and may
      // newly require the unranked stream — re-render and (leader) reconcile.
      renderAllGoals();
      if (isLeader) ensureRivalSync();
    } else if (countChanged || filterChanged) {
      // requireBoth / the difficulty+length filter only change the displayed
      // standings (wins denominator + Next-vs pool) -- re-render, no refetch.
      renderAllGoals();
    }
    // nextUsesVsLink and nextSort are both read live at click time in
    // onRivalNextClicked, so they need no re-render. (Switching nextSort starts
    // a fresh cursor cycle automatically — see the sort-mismatch reset there.)
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

    // Reload in-memory state from storage
    for (const [type, cfg] of Object.entries(GOAL_CONFIG)) {
      try { goalData[type] = JSON.parse(localStorage.getItem(cfg.storageKey) || "[]"); }
      catch { goalData[type] = []; }
    }
    groupData       = loadGroups() || { [MAIN_GROUP_ID]: { position: null, size: null, goalIds: [] } };
    ensureMainGroup();
    recSettings     = loadRecSettings();
    displaySettings = loadDisplaySettings();
    rivalSettings   = loadRivalSettings();

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
      // future tabs seed their own draft slice here
    };
    if (!activeSettingsTabId) activeSettingsTabId = SETTINGS_TABS[0].id;
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
    const before = JSON.stringify({ recSettings, displaySettings, rivalSettings });
    for (const tab of SETTINGS_TABS) tab.commit(settingsDraft);
    const after = JSON.stringify({ recSettings, displaySettings, rivalSettings });
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
    nextUsesVsLink: false, scope: "all", nextSort: "random", requireBoth: false,
    diffMin: null, diffMax: null, lenMin: null, lenMax: null, fv: 1,
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
      return {
        nextUsesVsLink: typeof saved.nextUsesVsLink === "boolean"
          ? saved.nextUsesVsLink
          : DEFAULT_RIVAL_SETTINGS.nextUsesVsLink,
        scope: RIVAL_SCOPE_VALUES.includes(saved.scope)
          ? saved.scope
          : DEFAULT_RIVAL_SETTINGS.scope,
        nextSort: RIVAL_NEXT_SORT_VALUES.includes(saved.nextSort)
          ? saved.nextSort
          : DEFAULT_RIVAL_SETTINGS.nextSort,
        requireBoth: typeof saved.requireBoth === "boolean"
          ? saved.requireBoth
          : DEFAULT_RIVAL_SETTINGS.requireBoth,
        diffMin, diffMax, lenMin, lenMax, fv: 1,
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
    const url     = `https://api.typegg.io/v1/leaders?sort=totalPp&page=${page}&perPage=${perPage}`;
    const response = await gtApiFetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("Leaderboard fetch failed");
    const data = await response.json();
    const targetUser = data.users?.find(u => u.stats?.ranking === targetRank);
    if (!targetUser) throw new Error(`Rank #${targetRank} not found on page ${page}`);
    return targetUser.stats.totalPp;
  }

  // ── Username → PP lookup ─────────────────────────────────────────
  async function getPpByUsername(username) {
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}`;
    
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

  // rank mode state
  let rankFetchedPp     = null; // PP fetched for the entered rank
  let rankFetchedExp    = null; // EXP fetched for the entered rank
  let rankFetchedRank   = null; // the rank number we fetched for
  let rankDebounce      = null;
  let nextRankMode      = false; // "next rank" toggle

  const nextRankRow        = document.getElementById("gt-next-rank-row");
  const nextRankToggleBtn  = document.getElementById("gt-next-rank-btn");

  const maxQuotesRow       = document.getElementById("gt-max-quotes-row");
  const maxAllBtn          = document.getElementById("gt-max-all-btn");
  const maxRankedBtn       = document.getElementById("gt-max-ranked-btn");
  const maxUnrankedBtn     = document.getElementById("gt-max-unranked-btn");
  const maxQuotesBtns = { all: maxAllBtn, ranked: maxRankedBtn, unranked: maxUnrankedBtn };

  // Rival-mode controls (type=rival).
  const rivalMetricRow  = document.getElementById("gt-rival-metric-row");
  const rivalMetricBtns = document.querySelectorAll(".gt-rival-metric-group .gt-mode-btn");
  const rivalScopeBtns  = document.querySelectorAll(".gt-rival-scope-group .gt-mode-btn");
  const rivalScopeHintEl = document.getElementById("gt-rival-scope-modal-hint");
  // selectedRivalMetric ∈ {"wpm","pp"} — which stat is compared (default wpm).
  // selectedRivalScope ∈ {"all","ranked","unranked"} — which of the rival's
  // quotes count. It's a global preference (mirrored in Settings → Rival), so
  // the modal seeds it from the current setting and writes it back on add.
  // rivalFetchedName: the validated rival username (null until a valid user is
  // confirmed via the username input). rivalDebounce: input debounce timer.
  let selectedRivalMetric = "wpm";
  let selectedRivalScope  = "all";
  let rivalFetchedName    = null;
  let rivalDebounce       = null;

  let playerFetchedValue = null;
  let playerFetchedName = null;
  let playerDebounce = null;

  // max quotes mode state
  let maxQuotesMode = false; // "max" toggle for quotes (any kind active)
  let maxQuotesKind = null;  // "ranked" | "unranked" | "all" when active
  let maxQuotesFetched = null; // total quotes count for the selected kind
  let maxQuotesBaseline = null; // user's currently-typed count for the selected kind (becomes the goal baseline)

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
      confirmBtn.disabled = (rivalFetchedName == null);
      return;
    }
    // Max-quotes kinds drive confirmBtn.disabled directly from their async
    // count fetch (see renderPresets). Don't let the generic target-value
    // checks below re-disable it — selectedValue is intentionally null here.
    if (selectedType === "quotes" && selectedMode === "target" && maxQuotesMode && maxQuotesKind) return;
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

    // ── Rival mode (type=rival) ───────────────────────────────
    // The Amount row becomes a username input (like Player mode). No presets,
    // no next-rank/max-quotes buttons, no window row. The metric toggle lives
    // in its own row (gt-rival-metric-row), shown by the type handler.
    if (selectedType === "rival") {
      rivalFetchedName = null;
      amountRow.style.display   = "";
      amountLabel.textContent   = "Rival player";
      presetsEl.innerHTML       = "";
      presetsEl.style.display   = "none";
      customInput.style.display = "";
      customInput.type          = "text";
      customInput.removeAttribute("max");
      customInput.removeAttribute("step");
      customInput.placeholder   = "Username";
      nextRankRow.style.display = "none";
      maxQuotesRow.style.display = "none";
      avgWindowRow.style.display = "none";
      modeHint.textContent   = "Enter a username";
      modeHint.className     = "gt-mode-hint";
      modeHint.style.display = "block";
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
    // Presets visible by default; the quotes+target branch hides them (they'd
    // otherwise claim flex space next to the max-quotes button row).
    presetsEl.style.display = "";

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
      if (!username) {
        modeHint.textContent = "Enter a username";
        modeHint.className = "gt-mode-hint";
        confirmBtn.disabled = true;
        return;
      }
      clearTimeout(rivalDebounce);
      modeHint.textContent = "Checking…";
      modeHint.className = "gt-mode-hint";
      confirmBtn.disabled = true;
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
          rivalFetchedName = resolvedName;
          modeHint.textContent = `${resolvedName} ✓`;
          modeHint.className = "gt-mode-hint";
          confirmBtn.disabled = false;
        } catch (err) {
          if (customInput.value.trim() !== typed) return;
          rivalFetchedName = null;
          // A throttle / network error shouldn't claim the user doesn't exist —
          // that's misleading when the lookup never actually completed.
          const couldntCheck = err?.gtThrottled || err?.message === "busy" ||
                               (err instanceof TypeError); // "Failed to fetch"
          modeHint.textContent = couldntCheck ? "Can't reach TypeGG — try again in a moment" : "User not found";
          modeHint.className = "gt-mode-hint gt-mode-hint-error";
          confirmBtn.disabled = true;
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

  typeBtns.forEach(btn => btn.addEventListener("click", () => {
    typeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedType = btn.dataset.type;
    const cfg = GOAL_CONFIG[selectedType];
    const isRival = selectedType === "rival";

    // Rival metric row (type=rival only) — same visibility pattern as the
    // race-only rows. The rival username is entered in the reused Amount-row
    // input (set up by renderPresets).
    rivalMetricRow.style.display = isRival ? "block" : "none";
    if (isRival) {
      // Seed the scope buttons from the current global preference.
      selectedRivalScope = rivalScope();
      rivalScopeBtns.forEach(b => b.classList.toggle("active", b.dataset.rivalScope === selectedRivalScope));
      if (rivalScopeHintEl) rivalScopeHintEl.textContent =
        RIVAL_SCOPE_OPTIONS.find(o => o.value === selectedRivalScope)?.hint ?? "";
    }

    // Show filter row only for races
    filterRow.style.display = (selectedType === "races") ? "block" : "none";

    // Show rank button only for PP
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";

    // Show player button only for PP
    playerBtn.style.display = (selectedType === "pp" || selectedType == "exp") ? "" : "none";

    // Average mode is races-only — same visibility pattern as rank/player.
    avgBtn.style.display = (selectedType === "races") ? "" : "none";
    // Improvement mode is races-only too.
    improvementBtn.style.display = (selectedType === "races") ? "" : "none";


    // If rank/player was active and we switched away from PP/EXP, fall back to gain
    if ((selectedMode === "rank" || selectedMode === "player") && !(selectedType === "pp" || selectedType === "exp")) {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }
    // Same fallback for average/improvement when leaving races
    if ((selectedMode === "average" || selectedMode === "improvement") && selectedType !== "races") {
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

  // Rival metric toggle (WPM / PP). Mutually exclusive; no async work — just
  // flips which stat the comparison + wins use. Re-validates confirm in case
  // a valid username is already entered.
  rivalMetricBtns.forEach(btn => btn.addEventListener("click", () => {
    rivalMetricBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedRivalMetric = btn.dataset.rivalMetric;
    validateConfirm();
  }));

  // Rival scope (all / ranked / unranked): which of the rival's quotes count.
  // Seeded from the global setting when the rival type is shown; applied back
  // to the global setting when the goal is added.
  rivalScopeBtns.forEach(btn => btn.addEventListener("click", () => {
    rivalScopeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedRivalScope = btn.dataset.rivalScope;
    if (rivalScopeHintEl) rivalScopeHintEl.textContent =
      RIVAL_SCOPE_OPTIONS.find(o => o.value === selectedRivalScope)?.hint ?? "";
  }));

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

  // Improvement-mode rows (metric + track, and conditionally the rolling
  // window) are only meaningful for races + improvement. Mirror
  // updateAvgRowVisibility().
  function updateImprovementRowVisibility() {
    const visible = selectedType === "races" && selectedMode === "improvement";
    improvementMetricRow.style.display = visible ? "block" : "none";
    improvementTrackRow.style.display  = visible ? "block" : "none";
    if (!visible) { resetImprovementUI(); return; }
    updateImprovementWindowRowVisibility();
  }

  // The rolling-window row applies only to the Average track. The 🌱
  // first-time toggle applies only to the Best track (Average's warm-up
  // handles new quotes), so it's hidden for Average.
  function updateImprovementWindowRowVisibility() {
    const avg = selectedType === "races" && selectedMode === "improvement"
                && selectedImprovementTrack === "average";
    improvementWindowRow.style.display = avg ? "block" : "none";
    improvementFirstTimeBtn.style.display = avg ? "none" : "";
  }

  function openModal() {
    overlay.classList.add("open");
    typeBtns.forEach(b => b.classList.toggle("active", b.dataset.type === "exp"));
    recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
    modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    filterBtns.forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
    selectedType = "exp"; selectedRec = "none"; selectedMode = "gain"; selectedFilter = "all";
    rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesKind = null; maxQuotesFetched = null; maxQuotesBaseline = null;
    // Rival defaults: metric=wpm, scope from the global setting, no resolved username yet.
    selectedRivalMetric = "wpm"; rivalFetchedName = null; clearTimeout(rivalDebounce);
    rivalMetricBtns.forEach(b => b.classList.toggle("active", b.dataset.rivalMetric === "wpm"));
    selectedRivalScope = rivalScope();
    rivalScopeBtns.forEach(b => b.classList.toggle("active", b.dataset.rivalScope === selectedRivalScope));
    if (rivalScopeHintEl) rivalScopeHintEl.textContent =
      RIVAL_SCOPE_OPTIONS.find(o => o.value === selectedRivalScope)?.hint ?? "";
    rivalMetricRow.style.display = "none";
    resetRequirementsUI();
    resetAverageUI();
    resetImprovementUI();
    playerBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    avgBtn.style.display = (selectedType === "races") ? "" : "none";
    improvementBtn.style.display = (selectedType === "races") ? "" : "none";
    nextRankRow.style.display = "none";
    maxQuotesRow.style.display = "none";
    filterRow.style.display = "none"; // hide filter row initially (only show for races)
    reqRow.style.display = "none";    // hide req row initially (only show for races + gain)
    avgTargetRow.style.display = "none"; // hide avg rows initially (only show for races + average)
    avgWindowRow.style.display = "none";
    improvementMetricRow.style.display = "none"; // hide improvement rows initially
    improvementTrackRow.style.display = "none";
    improvementWindowRow.style.display = "none";
    modeRow.style.display = "block"; recRow.style.display = "block";
    renderPresets();
  }
  function closeModal() {
    overlay.classList.remove("open");
    selectedValue = null; rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesKind = null; maxQuotesFetched = null; maxQuotesBaseline = null;
    rivalFetchedName = null; clearTimeout(rivalDebounce);
    resetRequirementsUI();
    resetAverageUI();
    resetImprovementUI();
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
  };

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
      if (rivalFetchedName == null) return;
      // Scope is a shared/global preference (also in Settings → Rival). Apply
      // the modal's choice now; saveRivalSettings broadcasts to other tabs and
      // the ensureRivalSync below will start the unranked stream if needed.
      if (RIVAL_SCOPE_VALUES.includes(selectedRivalScope) && selectedRivalScope !== rivalSettings.scope) {
        rivalSettings = { ...rivalSettings, scope: selectedRivalScope };
        saveRivalSettings();
      }
      const goalId = generateGoalId("rival");
      const newGoal = {
        id: goalId,
        rival: rivalFetchedName,           // display name (as TypeGG returns it)
        metric: selectedRivalMetric,       // "wpm" | "pp"
      };
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
      } else {
        currentVal = data.stats?.[cfg.statKey];
      }
      
      if (currentVal == null) return;

      let gainTarget;
      let isMaxQuotes = false;
      let maxQuotesBaselineOverride = null; // kind-appropriate typed count for unranked/all
      let maxQuotesKindForGoal = null;      // captured kind written onto the goal
      
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
        } else {
          // Regular target mode
          if (selectedValue == null || selectedValue <= currentVal) return;
          gainTarget = selectedValue - currentVal;
        }
      } else {
        if (selectedValue == null || selectedValue <= 0) return;
        gainTarget = selectedValue;
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
      const isImprovementMode = selectedMode === "improvement" && selectedType === "races";
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
        filter: selectedType === "races" ? selectedFilter : undefined,
        targetLoaded: selectedMode === "rank" ? false : true, // false for rank goals — target is loaded async by updateRankGoals/updateExpRankGoals
        [cfg.baselineKey]: maxQuotesBaselineOverride != null ? maxQuotesBaselineOverride : currentVal,
        recurrence: selectedRec,
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
        if (usesEvaluator || isAvgMode || isImprovementMode) evaluateRaceRequirementsGuarded();
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

    // Progress text — always gain / target
    const gainTextEl = document.getElementById(`${goalId}-gain-text`);
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
      gainTextEl.textContent = `${Math.round(currentQuotes).toLocaleString()} / ${totalQuotes.toLocaleString()}`;
    } else if (cfg.isTime) {
      gainTextEl.textContent = `${formatPlaytime(gain)} / ${formatPlaytime(gd.target)}`;
    } else {
      const gainStr   = cfg.decimals > 0 ? parseFloat(gain).toFixed(cfg.decimals)   : Math.round(gain).toLocaleString();
      const targetStr = cfg.decimals > 0 ? parseFloat(gd.target).toFixed(cfg.decimals) : gd.target.toLocaleString();
      gainTextEl.textContent = `${gainStr} / ${targetStr}`;
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

    if (gd.nextRank && gd.targetRank) {
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
    } else if (type === "races" && goalIsImprovement(gd)) {
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
      const positive = gainDelta > 0;
      const absDelta = Math.abs(gainDelta);
      let deltaStr;
      if (cfg.isTime) {
        deltaStr = `${positive ? "+" : "−"}${formatPlaytime(absDelta)}`;
      } else if (cfg.decimals > 0) {
        deltaStr = `${positive ? "+" : "−"}${parseFloat(absDelta).toFixed(cfg.decimals)}`;
      } else {
        deltaStr = `${positive ? "+" : "−"}${Math.round(absDelta).toLocaleString()}`;
      }
      // Append the lightning glyph for strict resets so the cause is obvious
      if (!positive) deltaStr += " ⚡";

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

  // ── Next-rank reset scheduler ────────────────────────────────
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
      gtApiFetch(userEndpoint(), { headers: authHeaders() }),
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
    const typeOrder = ['exp', 'pp', 'races', 'quotes', 'playtime', 'chars', 'rival'];

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
        const isImprovement = type === "races" && goalIsImprovement(gd);

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
            goals[i] = gd;
            saveGoals(type);
          }
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

  // ── Quote-finish trigger ─────────────────────────────────────
  // When the user finishes a quote (#typegame-input becomes disabled),
  // the TypeGG server takes anywhere from ~0.5s to ~16s to actually
  // reflect the new stats on the /users/{username} endpoint. A single
  // immediate fetch usually returns stale data. So instead: fire a
  // short retry chain with exponential-ish backoff, stopping as soon
  // as ANY tracked stat changes vs our snapshot.
  //
  // Follower tabs can't fetch (per the leader model), so they just
  // broadcast a 'quote-finished' message and let the leader handle it.
  const QF_RETRY_DELAYS_MS = [400, 1200, 3000, 6000, 10000]; // ~20.6s total

  let qfPending       = false; // another quote finished while we were retrying
  let qfWorkerRunning = false; // retry chain currently executing

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
    // Snapshot of stats at the moment the quote finished.
    // We compare against this — not against `currentStats`, which may
    // get updated mid-chain by the 20s poll.
    const snap = {
      races:    currentStats.races,
      pp:       currentStats.pp,
      exp:      currentStats.exp,
      quotes:   currentStats.quotes,
      quotesUnranked: currentStats.quotesUnranked,
      chars:    currentStats.chars,
      playtime: currentStats.playtime,
    };

    for (let i = 0; i < QF_RETRY_DELAYS_MS.length; i++) {
      await new Promise(r => setTimeout(r, QF_RETRY_DELAYS_MS[i]));

      // Prefetch /races IN PARALLEL with the user-data fetch. Both arrive
      // around the same time, and the cache primed here is consumed by the
      // eval inside applyUserData → req-goal indicator now pops alongside
      // the non-req gain indicators instead of ~1s later.
      //
      // Quote prefetch is CHAINED after races prefetch (we need the races
      // list before we know which quoteIds to fetch), but the whole chain
      // still runs in parallel with fetchUserData. If no goal has length
      // or difficulty requirements, prefetchQuotesIfNeeded returns
      // immediately — the quote endpoint is never hit unnecessarily.
      // Only the leader prefetches (followers don't run the eval anyway).
      const reqPrefetch = isLeader
        ? (async () => {
            await prefetchRacesIfNeeded();
            await prefetchQuotesIfNeeded();
          })()
        : null;

      let data;
      const gtStatsT0 = performance.now(); // [GT-PERF]
      try { data = await fetchUserData(); }
      catch {
        if (reqPrefetch) await reqPrefetch; // don't leak the promise
        continue;
      }
      const gtStatsFetchMs = performance.now() - gtStatsT0; // [GT-PERF] stats fetch latency

      // Wait for prefetch to land before applyUserData triggers the eval —
      // otherwise the eval might fire before the caches are warm and fall
      // back to sequential fetches (defeating the optimization).
      if (reqPrefetch) await reqPrefetch;

      // ── Single-frame render path ───────────────────────────────
      // We want every gain indicator (req and non-req) to appear in the
      // SAME animation frame. The general applyUserData path renders
      // first and triggers eval async, which produces a tiny stagger
      // (req goals always pop ~1 microtask after non-req ones). Here
      // we have full control over the sequence, so:
      //   1. Commit stats (no render)
      //   2. Run eval to update qualifyingProgress (no render — defer)
      //   3. Render once with everything in place
      //
      // Followers and tabs without req goals just commit + render directly.
      const prevRaces = commitUserData(data);
      const racesChanged = isLeader && data.races != null && data.races !== prevRaces;
      const anyEvalGoals = (goalData.races || []).some(g => goalNeedsRaceList(g));
      if (racesChanged && anyEvalGoals) {
        // If any improvement goal is present, make sure the just-finished
        // quote's pre-race baseline seed (kicked off at quote-start) has
        // landed first — otherwise the evaluator drops this race as
        // unseeded and the gain is lost / later lumped. Bounded so a hung
        // seed fetch can't stall the finish path.
        if ((goalData.races || []).some(g => goalIsImprovement(g))) {
          await awaitPendingSeed();
        }
        try {
          await evaluateRaceRequirementsGuarded({ deferRender: true });
        } catch (err) {
          console.error("[Goal Tracker] eval error in quote-finish path:", err);
        }
      }
      // ── Standard-goal render + rival-card sync ─────────────────
      // Stats are committed above, so the standard goals (max-quotes, …) are
      // ready to render now. The rival card needs a SEPARATE /races fetch.
      // Preference: render both in ONE frame. Cap: don't hold the standard
      // goals longer than RIVAL_SYNC_THRESHOLD_MS — past that, render them
      // immediately and let the rival card catch up when the fetch lands (the
      // old decoupled behaviour). renderAllGoals() reads the live store, so in
      // the synced case it shows the freshly merged rival bests too.
      if (racesChanged && (goalData.rival || []).length > 0) {
        const gtPerfSession = gtPerf.startRivalLag(gtStatsFetchMs); // [GT-PERF] anchor: rival fetch kicked
        // selfRender=false → the caller owns the render in this path.
        const maintainPromise = maintainSelfStoreFromRaces(gtPerfSession, false)
          .catch(e => { console.warn("[Goal Tracker] rival self-store maintenance failed:", e); return false; });
        const winner = await Promise.race([
          maintainPromise.then(() => "synced"),
          new Promise(res => setTimeout(res, RIVAL_SYNC_THRESHOLD_MS, "timeout")),
        ]);
        renderAllGoals(); // synced → standard + freshly-merged rival in one frame; timed out → standard now
        if (winner === "timeout") {
          // Slow fetch: re-render the rival card once it finally lands.
          maintainPromise.then(changed => { if (changed) renderAllGoals(); });
        }
      } else {
        renderAllGoals();
      }
      try {
        localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch {}
      channel?.postMessage({ type: 'stats', payload: data });

      // Any change vs the pre-finish snapshot? → server has updated, stop.
      const changed =
        data.races    !== snap.races    ||
        data.pp       !== snap.pp       ||
        data.exp      !== snap.exp       ||
        data.quotes   !== snap.quotes   ||
        (data.quotesUnranked !== undefined && data.quotesUnranked !== snap.quotesUnranked) ||
        data.chars    !== snap.chars   ||
        data.playtime !== snap.playtime;
      if (changed) {
        // We just freshly updated the goal display — push the fallback
        // poll out to a full interval so we don't re-fetch immediately.
        scheduleNextStatsPoll();
        return;
      }
    }
    // Fell through all retries with no change — give up.
    // The regular 20s poll will catch any eventual update.
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
    qfPending = true;
    qfWorker(); // no-op if already running; picks up pending flag on loop
  }

  // Called in every tab (user could be typing on leader OR follower).
  function onQuoteFinished() {
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
    const goals = goalData.races;
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
    if (!quoteId) return; // couldn't detect — this race won't count (pure S1)

    // Goals still missing a baseline for this quote. (Already-seeded quotes
    // are left untouched — only the evaluator updates them.)
    const missing = goalData.races.filter(
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
    const arr = goalData.races;
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
          else continue;                            // don't seed; re-check next time
        } else {
          baseline = Number(best[metric]);
          if (!isFinite(baseline)) baseline = 0;
        }
        arr[i] = { ...g, quoteBests: { ...(g.quoteBests || {}), [quoteId]: baseline } };
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
          for (let k = W; k < chrono.length; k++) {
            sum += chrono[k] - chrono[k - W];           // slide the window
            if (sum / W > peakAvg) peakAvg = sum / W;
          }
          state = { window: chrono.slice(chrono.length - W), baseline: peakAvg, peak: 0 };
        } else {
          state = { window: chrono.slice(), baseline: null, peak: 0 }; // warming up
        }
        arr[i] = { ...g, quoteAvgs: { ...(g.quoteAvgs || {}), [quoteId]: state } };
        changed = true;
      }
    }
    if (changed) saveGoals("races");
  }

  function onQuoteStarted(knownQuoteId) {
    const goals = goalData.races;
    if (!goals || !goals.some(g => goalIsImprovement(g))) return;
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
          onQuoteStarted();
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
      if (!input.disabled) onQuoteStarted();
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
      const races = goalData.races;
      const hasImprovement = races && races.some(g => goalIsImprovement(g));
      const hasRival = (goalData.rival || []).length > 0;
      if (!hasImprovement && !hasRival) return; // cheap no-op when irrelevant
      const qid = getCurrentQuoteIdLive();
      if (qid && qid !== lastSeenQuoteId) {
        lastSeenQuoteId = qid;
        if (hasImprovement) onQuoteStarted(qid);
        // Rival goals: the compare line tracks the quote you're on, so a new
        // quote means re-render (which on-demand-fetches the new quote's
        // bests if they're not in the stores yet).
        if (hasRival) renderAllGoals();
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
  const RIVAL_PAGE_SIZE  = 250;      // bulk-build page size. Was 1000, but a
                                     // 1000-row page took 30–90s server-side
                                     // and occasionally crossed the gateway
                                     // timeout (the intermittent failure). Cost
                                     // is ~linear in rows, so 250 → ~10s/page
                                     // with a wide timeout margin, same per-row
                                     // efficiency, finer resume checkpoints.
  const RIVAL_REFRESH_PAGE_SIZE = 100; // ongoing refresh: only the recent changes matter (early-stop)
  const RIVAL_PP_EPS     = 1e-6;
  // Pace consecutive bulk-build page fetches. A tight fetch loop over a
  // many-page store (perPage=1000) saturates the connection and is a prime
  // trigger for TypeGG's per-IP rate limiter — once tripped, requests come
  // back with no CORS header (surfacing as "Failed to fetch"), and the whole
  // account/IP gets throttled (even unrelated TypeGG tools slow down). A
  // short delay between pages keeps the build under the limiter.
  const RIVAL_PAGE_DELAY_MS = 1500;

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

  // Each store now has TWO fetch streams: `fetch` builds the RANKED quotes and
  // `fetchU` builds the UNRANKED ones (the API's /users/<name>/quotes endpoint
  // takes a `status=ranked|unranked|any` filter; its default is ranked, which
  // is what the single original stream fetched). The unranked stream only runs
  // when the active scope needs it (see rivalNeedsUnranked). Its phase is
  // "none" until first started. Quote entries carry an `r` flag (true=ranked,
  // false=unranked) so standings can be filtered per scope without refetching;
  // a missing `r` is treated as ranked (legacy stores were ranked-only).
  function freshRivalFetch()  { return { phase: "bulk", nextPage: 1, totalPages: null }; }
  function freshRivalFetchU() { return { phase: "none", nextPage: 1, totalPages: null }; }
  // Store meta version. Bumped when we started capturing each quote's
  // difficulty/length (`d`/`l`) on its entry. A store built before this lacks
  // metaV and gets a one-time re-bulk (backfillMetaIfNeeded) to fill it in.
  const RIVAL_META_V = 1;
  function freshRivalStore() {
    return { quotes: {}, fetch: freshRivalFetch(), fetchU: freshRivalFetchU(), metaV: RIVAL_META_V };
  }
  // Older stores predate the d/l capture: re-run any COMPLETED bulk stream once
  // so the re-paged /quotes rows backfill each entry's difficulty/length. The
  // user just sees the normal "syncing" state during the re-bulk. metaV is
  // stamped when the ranked stream finishes (fetchOneRivalBulkPage), so this
  // fires at most once per store. Streams still building (or never built) are
  // left alone -- they capture d/l natively as they run.
  function backfillMetaIfNeeded(store) {
    if (store.metaV === RIVAL_META_V) return;
    for (const fobj of [store.fetch, store.fetchU]) {
      if (fobj && fobj.phase === "done") { fobj.phase = "bulk"; fobj.nextPage = 1; fobj.totalPages = null; }
    }
  }
  // One-time migration (pre-scoped self key → gt-rivalq-self-<username>). The
  // self store used to live at the unscoped `gt-rivalq-self`. On the first
  // self-store load as a logged-in user, if the new scoped key is empty but the
  // legacy key holds a built store, adopt it — so an existing user keeps their
  // store instead of re-paying the long bulk rebuild. Runs once per session;
  // skipped (and retried later) while logged out, since there's no username to
  // scope to yet. Idempotent and multi-tab safe (last write wins on identical
  // data; the legacy remove is a no-op once gone).
  let selfStoreMigrated = false;
  function migrateLegacySelfStore() {
    if (selfStoreMigrated) return;
    const u = getAuth().username;
    if (!u) return; // can't scope yet — retry on a later (logged-in) load
    selfStoreMigrated = true;
    try {
      const scopedKey = rivalStoreKey(RIVAL_SELF_NAME); // gt-rivalq-self-<u>
      if (localStorage.getItem(scopedKey) != null) return; // already migrated
      const legacy = localStorage.getItem(RIVAL_SELF_KEY);
      if (legacy == null) return; // nothing to adopt
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(RIVAL_SELF_KEY);
    } catch {}
  }
  function loadRivalStore(name) {
    if (name === RIVAL_SELF_NAME) migrateLegacySelfStore();
    const key = rivalStoreKey(name);
    if (rivalStores.has(key)) return rivalStores.get(key);
    let store = null;
    try { store = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
    if (!store || typeof store !== "object" || typeof store.quotes !== "object") {
      store = freshRivalStore();
    }
    if (!store.fetch)  store.fetch  = freshRivalFetch();
    if (!store.fetchU) store.fetchU = freshRivalFetchU();
    backfillMetaIfNeeded(store); // legacy stores: re-bulk once to capture d/l
    rivalStores.set(key, store);
    return store;
  }
  function saveRivalStore(name, { broadcast = true } = {}) {
    const key = rivalStoreKey(name);
    const store = rivalStores.get(key);
    if (!store) return;
    rivalStoreEpoch++; // invalidate standings cache
    try {
      localStorage.setItem(key, JSON.stringify(store));
    } catch (e) {
      console.warn("[Goal Tracker] rival store save failed (quota?):", e);
    }
    if (broadcast) channel?.postMessage({ type: "rival-store", storeKey: key });
  }
  function reloadRivalStoreFromDisk(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (parsed && typeof parsed.quotes === "object") {
        if (!parsed.fetch)  parsed.fetch  = freshRivalFetch();
        if (!parsed.fetchU) parsed.fetchU = freshRivalFetchU();
        rivalStores.set(key, parsed);
        rivalStoreEpoch++; // invalidate standings cache
      }
    } catch {}
  }
  // ── Scope (all / ranked / unranked) ──────────────────────────
  // A single global preference (Settings → Rival, also surfaced in the add-goal
  // modal) decides which of the rival's quotes count toward every rival goal.
  function rivalScope() {
    const s = rivalSettings.scope;
    return (s === "ranked" || s === "unranked" || s === "all") ? s : "all";
  }
  // Whether a rival quote falls inside the active scope. A missing `r` flag is
  // legacy data, which was ranked-only, so it counts as ranked.
  function rivalQuoteInScope(entry, scope) {
    if (scope === "ranked")   return entry.r !== false;
    if (scope === "unranked") return entry.r === false;
    return true; // all
  }
  // The unranked stream is only fetched when some scope needs it. Scope is
  // global, so this is all-or-nothing across every managed store (self + each
  // rival) — mirrors the quotes-goal `quotesNeedUnrankedData()` gate so a
  // ranked-only setup never pays for the extra stream.
  function rivalNeedsUnranked() {
    if (rivalScope() === "ranked") return false;
    return (goalData.rival || []).length > 0;
  }
  function rivalRankedDone(store)   { return !!(store && store.fetch  && store.fetch.phase  === "done"); }
  function rivalUnrankedDone(store) { return !!(store && store.fetchU && store.fetchU.phase === "done"); }
  // How many stored quotes belong to one stream's bucket (ranked = r !== false,
  // unranked = r === false; a missing `r` counts as ranked). Compared against
  // the rival's API count to detect a drifted store in the incremental refresh.
  function rivalStoreBucketCount(store, unranked) {
    const q = store.quotes; let n = 0;
    for (const id in q) { const u = q[id].r === false; if (unranked ? u : !u) n++; }
    return n;
  }
  // "Fully synced for the active scope": the ranked stream always, plus the
  // unranked stream when the scope needs it. Drives the card's "syncing…" hint
  // and the settled/loading logic.
  function rivalBulkDone(store) {
    if (!rivalRankedDone(store)) return false;
    if (rivalNeedsUnranked() && !rivalUnrankedDone(store)) return false;
    return true;
  }

  // PP-keyed idempotent merge. Returns true iff the store changed. `ranked`
  // (optional boolean) tags the quote's ranking bucket; it's applied even when
  // the PP didn't improve, so a quote first seen untagged (on-demand fill) or
  // mis-tagged is corrected the moment its authoritative stream delivers it.
  function rivalMergeEntry(store, quoteId, wpm, pp, ranked, d, l) {
    if (!quoteId) return false;
    const p = Number(pp);
    if (!Number.isFinite(p)) return false;
    const w = Number(wpm);
    const dn = Number(d), ln = Number(l);
    const haveD = Number.isFinite(dn), haveL = Number.isFinite(ln);
    const cur = store.quotes[quoteId];
    if (cur && !(p > cur.pp + RIVAL_PP_EPS)) {
      // No PP improvement -- but we may still need to record/fix the ranked tag
      // or backfill the difficulty/length meta onto an older entry.
      let touched = false;
      if (typeof ranked === "boolean" && cur.r !== ranked) { cur.r = ranked; touched = true; }
      if (haveD && cur.d !== dn) { cur.d = dn; touched = true; }
      if (haveL && cur.l !== ln) { cur.l = ln; touched = true; }
      return touched;
    }
    const entry = { wpm: Number.isFinite(w) ? w : (cur ? cur.wpm : 0), pp: p };
    if (typeof ranked === "boolean") entry.r = ranked;
    else if (cur && typeof cur.r === "boolean") entry.r = cur.r; // preserve known tag
    // Difficulty/length: prefer fresh values, else carry forward what we had.
    if (haveD) entry.d = dn; else if (cur && Number.isFinite(cur.d)) entry.d = cur.d;
    if (haveL) entry.l = ln; else if (cur && Number.isFinite(cur.l)) entry.l = cur.l;
    store.quotes[quoteId] = entry;
    return true;
  }
  function entryFromQuoteRecord(q) {
    const br = q?.bestRace;
    if (!br || !br.quoteId) return null;
    const qq = q.quote || null; // /users/<u>/quotes rows nest the quote meta under .quote
    const d = qq ? Number(qq.difficulty) : NaN;
    const l = qq ? Number(qq.length)     : NaN;
    return {
      quoteId: br.quoteId, wpm: Number(br.wpm), pp: Number(br.pp),
      d: Number.isFinite(d) ? d : undefined,
      l: Number.isFinite(l) ? l : undefined,
    };
  }

  // ── Fetching ────────────────────────────────────────────────
  async function fetchRivalQuotesPage(fetchName, { page, reverse, perPage = RIVAL_PAGE_SIZE, status }) {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (reverse) params.set("reverse", "true");
    if (status)  params.set("status", status); // ranked | unranked (omitted → API default = ranked)
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
    // Watches every real page; skips the perPage=1 count probe.
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
    // `total` (exact quote count for this status) is surfaced when the API
    // provides it under any of the common field names; the incremental refresh
    // uses it to detect a drifted count. When absent it's null, and callers
    // fall back to the perPage=1 trick (totalPages === count at one-per-page).
    const total = (typeof d?.total === "number") ? d.total
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
    const r = await gtApiFetch(url, { headers: authHeaders() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`rival quote ${fetchName}/${quoteId} → ${r.status}`);
    const d = await r.json();
    const br = d?.bestRace;
    if (!br) return null;
    return { wpm: Number(br.wpm), pp: Number(br.pp) };
  }

  // ── Sync orchestration (leader-only fetching) ────────────────
  const rivalSyncInFlight = new Set(); // storeKeys currently bulk/incremental syncing
  const rivalPollTimers   = new Map(); // storeKey → interval id
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

  // Bulk build of ONE stream (resumable, oldest-first). `stream` is "ranked"
  // (the `fetch` cursor, status=ranked) or "unranked" (the `fetchU` cursor,
  // status=unranked). Loops every page in one invocation; persists the cursor
  // + re-renders after each page so progress is visible. Entries are tagged
  // with their ranked bucket as they merge.
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
  // more concurrency, so it adds no burst pressure. ranked builds before
  // unranked per store. The cursor (fobj.nextPage) is persisted every page, so
  // a pause/freeze/lost-leadership resumes cleanly from where it stopped.

  // Which bulk stream this store still needs, or null if its bulk is complete.
  function pendingBulkStreamFor(name) {
    const store = loadRivalStore(name);
    if (!rivalRankedDone(store)) return "ranked";
    if (rivalNeedsUnranked() && !rivalUnrankedDone(store)) return "unranked";
    return null;
  }

  // Fetch + merge ONE bulk page for a store/stream and advance its cursor.
  // Returns "advanced" (more pages remain), "done" (this stream is complete), or
  // "failed" (the request threw — gtApiFetch has already escalated the shared
  // backoff). `persist(name, force)` saves the store and renders (throttled).
  async function fetchOneRivalBulkPage(name, stream, persist) {
    const fetchName = rivalFetchNameFor(name);
    if (!fetchName) return "failed"; // auth not ready yet
    const store     = loadRivalStore(name);
    const unranked  = stream === "unranked";
    const fobj      = unranked ? store.fetchU : store.fetch;
    const status    = unranked ? "unranked" : "ranked";
    const rankedTag = !unranked;
    if (fobj.phase === "done") return "done";
    if (unranked && fobj.phase === "none") { fobj.phase = "bulk"; fobj.nextPage = 1; }
    const page = fobj.nextPage || 1;
    let res;
    try { res = await fetchRivalQuotesPage(fetchName, { page, reverse: true, status }); }
    catch (e) {
      console.warn("[Goal Tracker] rival bulk page failed (paused):", e);
      persist(name, true); // persist progress so we resume from here
      return "failed";
    }
    for (const q of res.quotes) {
      const e = entryFromQuoteRecord(q);
      if (e) rivalMergeEntry(store, e.quoteId, e.wpm, e.pp, rankedTag, e.d, e.l);
    }
    fobj.totalPages = res.totalPages;
    if (page >= res.totalPages) {
      fobj.phase = "done";
      fobj.nextPage = res.totalPages + 1;
      if (!unranked) store.metaV = RIVAL_META_V; // ranked stream done -> d/l fully captured
      persist(name, true);
      return "done";
    }
    fobj.nextPage = page + 1; // advance cursor (persisted below)
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
          const s = pendingBulkStreamFor(name);
          if (s) pending.push({ name, stream: s });
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

        const result = await fetchOneRivalBulkPage(job.name, job.stream, persist);
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
      const haveRivalGoals = (goalData.rival || []).length > 0;
      if (!stillPending && isLeader && !apiThrottled() && haveRivalGoals) {
        for (const name of rivalManaged.keys()) {
          if (rivalBulkDone(loadRivalStore(name))) rivalIncrementalSync(name);
        }
      }
    }
  }

  // Ongoing refresh of ONE stream. Runs every RIVAL_POLL_MS.
  //
  // The old version read page 1 (recent-sorted) and stopped at the first quote
  // it already had, assuming everything past it was older/known. That leaks
  // quotes two ways: (a) quotes the rival typed while we weren't syncing
  // (browser closed, not the leader, throttled) sit behind newer activity we
  // never paged to, and (b) a quote we already hold can be bumped to the front
  // by a re-race or a sub-epsilon PB, so a genuinely new quote right behind it
  // is never reached → a small, *permanent* gap (the classic "rival has N, card
  // shows N-4").
  //
  // So instead of trusting the early-stop, we make the refresh count-aware:
  // learn how many quotes the rival actually has for this status and keep
  // paging the recent list until our stored count matches. Counts agreeing is
  // the cheap common case (one tiny request); we only scan deeper when behind.
  async function rivalIncrementalStream(name, stream) {
    const fetchName = rivalFetchNameFor(name);
    if (!fetchName) return false;
    const store     = loadRivalStore(name);
    const unranked  = stream === "unranked";
    const status    = unranked ? "unranked" : "ranked";
    const rankedTag = !unranked;
    let changed = false;

    // (1) Authoritative count for this status. `perPage=1` makes totalPages ===
    // the number of quotes, so this one tiny request says exactly how many the
    // rival has (the API's `total`, if it exposes one, is used in preference).
    // We also merge the single most-recent record it returns (a free PB catch),
    // and remember whether the very front changed.
    let apiCount = null, frontChanged = false;
    try {
      const head = await fetchRivalQuotesPage(fetchName, { page: 1, perPage: 1, reverse: false, status });
      apiCount = (typeof head.total === "number") ? head.total : head.totalPages;
      for (const q of head.quotes) {
        const e = entryFromQuoteRecord(q);
        if (e && rivalMergeEntry(store, e.quoteId, e.wpm, e.pp, rankedTag, e.d, e.l)) { changed = true; frontChanged = true; }
      }
    } catch (e) {
      console.warn("[Goal Tracker] rival count probe failed (paused):", e);
      return changed; // gtApiFetch already escalated the shared backoff
    }

    const behind = apiCount != null && rivalStoreBucketCount(store, unranked) < apiCount;

    // Counts agree and the most-recent quote is unchanged → nothing new at the
    // front and nothing missing. Skip the page fetch entirely (steady state is
    // just the one tiny probe above).
    if (!behind && !frontChanged) return changed;

    // (2) Page the recent-sorted list.
    //  - BEHIND: scan without early-stopping until the stored count catches up
    //    to apiCount (the missing quotes may hide behind already-known ones),
    //    bounded by totalPages and the usual leader/visible/throttle gates.
    //  - NOT behind (just front activity): one page with the safe early-stop —
    //    only PBs can have changed and they cluster at the very front.
    let page = 1;
    pages: while (isLeader && anyTabVisibleRecently() && !apiThrottled()) {
      if (page > 1) await new Promise(r => setTimeout(r, RIVAL_PAGE_DELAY_MS));
      let res;
      try { res = await fetchRivalQuotesPage(fetchName, { page, reverse: false, perPage: RIVAL_REFRESH_PAGE_SIZE, status }); }
      catch (e) { console.warn("[Goal Tracker] rival refresh failed (paused):", e); break; }
      for (const q of res.quotes) {
        const e = entryFromQuoteRecord(q);
        if (!e) continue;
        const cur = store.quotes[e.quoteId];
        const improved = !cur || e.pp > cur.pp + RIVAL_PP_EPS;
        // Front-refresh (not behind): stop at the first quote we already hold —
        // only PBs matter and they're at the very front. Catch-up (behind): keep
        // going and merge *every* quote. The merge is idempotent on value but
        // also (re)applies the ranked `r` tag, so a mis-tagged entry can't keep
        // the bucket count permanently short (which would re-scan every tick).
        if (!improved && !behind) break pages;
        if (rivalMergeEntry(store, e.quoteId, e.wpm, e.pp, rankedTag, e.d, e.l)) changed = true;
      }
      if (page >= res.totalPages) {
        if (behind && rivalStoreBucketCount(store, unranked) < apiCount) {
          // Scanned every page and still short — apiCount is likely stale/odd.
          // Stop for this tick rather than loop; the next tick re-probes.
          console.warn("[Goal Tracker] rival refresh: count still short after full scan", { name, stream, apiCount });
        }
        break;
      }
      if (!behind) break;                                                       // front-refresh: one page is enough
      if (rivalStoreBucketCount(store, unranked) >= apiCount) break;            // caught up
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
    if (!rivalBulkDone(store)) return; // still building (for the active scope)
    rivalSyncInFlight.add(key);
    try {
      let changed = false;
      if (await rivalIncrementalStream(name, "ranked")) changed = true;
      if (rivalNeedsUnranked() && rivalUnrankedDone(store) && !apiThrottled()) {
        if (await rivalIncrementalStream(name, "unranked")) changed = true;
      }
      if (changed) { saveRivalStore(name); renderAllGoals(); }
    } finally {
      rivalSyncInFlight.delete(key);
    }
  }

  // Drive one store: build ranked first, then unranked (if the scope needs it),
  // else do an incremental refresh pass.
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
    // No bulk pending. The ongoing incremental refresh is rival-goal-only
    // machinery — in the self-prefetch state (logged in, no rival goal) the
    // one-time bulk is the whole job, so don't start an ongoing self refresh.
    // The poll still ran the driver above, so an interrupted bulk resumes.
    if ((goalData.rival || []).length === 0) return;
    rivalIncrementalSync(name);
  }

  function startRivalManaged(name, fetchName) {
    const key = rivalStoreKey(name);
    rivalManaged.set(name, fetchName);
    rivalSyncTick(name); // kick immediately (bulk resumes / first refresh)
    if (!rivalPollTimers.has(key)) {
      const t = setInterval(() => {
        // Fire regardless of visibility so an interrupted one-time bulk resumes
        // in the background. rivalSyncTick → rivalIncrementalSync is itself
        // visibility-gated, so the recurring refresh still pauses when hidden;
        // only the bulk-resume path proceeds.
        if (!isLeader) return;
        rivalSyncTick(name);
      }, RIVAL_POLL_MS);
      rivalPollTimers.set(key, t);
    }
  }
  function stopRivalManaged(name) {
    const key = rivalStoreKey(name);
    rivalManaged.delete(name);
    const t = rivalPollTimers.get(key);
    if (t) { clearInterval(t); rivalPollTimers.delete(key); }
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
    for (const t of rivalPollTimers.values()) clearInterval(t);
    rivalPollTimers.clear();
    rivalManaged.clear();
  }

  // Map lowercased rival → display-cased name (first goal wins) so we fetch
  // with a real username and key the store case-insensitively.
  function referencedRivalMap() {
    const m = new Map();
    for (const g of (goalData.rival || [])) {
      if (g.rival && !m.has(g.rival.toLowerCase())) m.set(g.rival.toLowerCase(), g.rival);
    }
    return m;
  }

  // Reconcile managed stores against the current rival goals. Always keeps the
  // self store alive (the spec wants it built regardless of any rival goal).
  function ensureRivalSync() {
    if (!isLeader) return;
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
    // session (which stopRivalManaged alone would miss, since it only knows
    // about rivals managed this session). Scan localStorage directly.
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(RIVAL_KEY_PREFIX) && !wantedKeys.has(k)) stale.push(k);
      }
      for (const k of stale) {
        localStorage.removeItem(k);
        rivalStores.delete(k);
        channel?.postMessage({ type: "rival-store", storeKey: k });
      }
    } catch {}
  }

  // Merge the recent /races list into the self store (called on quote-finish).
  async function maintainSelfStoreFromRaces(gtPerfSession = null, selfRender = true) {
    if (apiThrottled()) return false; // don't add load during a backoff window
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
    for (const race of races) {
      if (race && rivalMergeEntry(store, race.quoteId, race.wpm, race.pp)) changed = true;
    }
    // selfRender=false lets the quote-finish path render once (so the rival
    // merge lands in the same frame as the standard goals when it's fast).
    if (changed) { saveRivalStore(RIVAL_SELF_NAME); if (selfRender) renderAllGoals(); }
    if (gtPerfSession) gtPerf.endRivalLag(gtPerfSession, gtRacesFetchMs, changed); // [GT-PERF]
    return changed;
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
    if (apiThrottled()) return; // backing off after recent failures
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

  // ── Rendering ────────────────────────────────────────────────
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
  let rivalAxisCache = null;
  function rivalFilterAxis() {
    if (rivalAxisCache && rivalAxisCache.epoch === rivalStoreEpoch) return rivalAxisCache;
    let dLo = Infinity, dHi = -Infinity, lLo = Infinity, lHi = -Infinity;
    for (const gd of (goalData.rival || [])) {
      const q = loadRivalStore(gd.rival).quotes;
      for (const qid in q) {
        const d = Number(q[qid].d), l = Number(q[qid].l);
        if (Number.isFinite(d)) { if (d < dLo) dLo = d; if (d > dHi) dHi = d; }
        if (Number.isFinite(l)) { if (l < lLo) lLo = l; if (l > lHi) lHi = l; }
      }
    }
    const floorTo = (v, step) => Math.floor(v / step) * step;
    const axis = {
      epoch: rivalStoreEpoch,
      diffMin: Number.isFinite(dLo) ? Math.floor(dLo) : RIVAL_DIFF_MIN,
      diffMax: Number.isFinite(dHi) ? Math.floor(dHi) : RIVAL_DIFF_MAX,
      lenMin:  Number.isFinite(lLo) ? floorTo(lLo, RIVAL_LEN_AXIS_ROUND) : RIVAL_LEN_MIN,
      lenMax:  Number.isFinite(lHi) ? floorTo(lHi, RIVAL_LEN_AXIS_ROUND) : RIVAL_LEN_MAX,
    };
    if (axis.diffMax <= axis.diffMin) axis.diffMax = axis.diffMin + 1;                  // keep a usable span
    if (axis.lenMax  <= axis.lenMin)  axis.lenMax  = axis.lenMin + RIVAL_LEN_AXIS_ROUND;
    rivalAxisCache = axis;
    return axis;
  }
  // Resolve the stored handles (null = at an axis end) against the live axis.
  function rivalFilterState() {
    const s = rivalSettings, axis = rivalFilterAxis();
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
  // Signature for the standings memo so a filter change invalidates it.
  function rivalFilterSig() {
    const f = rivalFilterState();
    return (f.dActive || f.lActive) ? `${f.dMin},${f.dMax},${f.lMin},${f.lMax}` : "";
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
  function computeRivalStandings(gd) {
    const metric = gd.metric || "wpm";
    const scope  = rivalScope();
    const requireBoth = !!rivalSettings.requireBoth; // count only quotes you've both raced
    const filter = rivalFilterState();
    const filterSig = rivalFilterSig();
    const selfStore  = loadRivalStore(RIVAL_SELF_NAME);
    const selfDone   = rivalBulkDone(selfStore);     // your history fully synced?
    const cached = rivalStandingsCache.get(gd.id);
    if (cached && cached.epoch === rivalStoreEpoch && cached.metric === metric
        && cached.scope === scope && cached.requireBoth === requireBoth
        && cached.selfDone === selfDone && cached.filterSig === filterSig) {
      return cached.result;
    }
    const rivalStore = loadRivalStore(gd.rival);
    const rq = rivalStore.quotes;
    const sq = selfStore.quotes;
    let total = 0, wins = 0;
    const worse = []; // the "⚔ Next vs" pool: quotes the rival currently beats you on
    for (const qid in rq) {
      const rentry = rq[qid];
      if (!rivalQuoteInScope(rentry, scope)) continue; // only count in-scope quotes
      if ((filter.dActive || filter.lActive) && !rivalQuotePassesFilter(rentry, filter)) continue;
      const se = sq[qid];
      // "Shared only" mode: skip quotes you haven't raced, so the wins total
      // reflects a head-to-head on common ground rather than counting every
      // quote the rival has typed (where unraced ones would read as losses).
      if (requireBoth && !se) continue;
      total++;
      const rv = rentry[metric];
      const sv = se ? se[metric] : 0;
      if (sv > rv + RIVAL_PP_EPS) { wins++; continue; } // you already beat them here
      // Not a win → candidate for the "⚔ Next vs" pool (a quote to go beat):
      if (se) {
        // You have a recorded time and you're behind (ties are neither a win
        // nor a target — you've matched but not beaten them).
        if (sv < rv - RIVAL_PP_EPS) worse.push(qid);
      } else if (!requireBoth && selfDone) {
        // Default ("Rival's quotes") mode: a quote you've NEVER raced is a valid
        // target — you want to beat all the rival's scores, including new ones.
        // Gated on selfDone: only once your own history is fully synced does a
        // missing entry reliably mean "never raced" rather than "not synced
        // yet" (which could be a quote you've actually already won). Before that
        // these are held back so Next never sends you somewhere you've beaten.
        worse.push(qid);
      }
      // unraced while not yet synced, or in shared-only mode → not a target
    }
    const result = { total, wins, worse, rivalDone: rivalBulkDone(rivalStore), selfDone };
    rivalStandingsCache.set(gd.id, { epoch: rivalStoreEpoch, metric, scope, requireBoth, selfDone, filterSig, result });
    return result;
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
  }

  function updateRivalGoalSection(goalId, gd, liveQid) {
    const metric = gd.metric || "wpm";
    const rivalName = gd.rival || "rival";

    const labelEl = document.getElementById(`${goalId}-label`);
    if (labelEl) labelEl.textContent = `Rival vs ${rivalName}`;
    const badge = document.getElementById(`${goalId}-metric-badge`);
    if (badge) badge.textContent = metric.toUpperCase();

    const rivalStore = loadRivalStore(gd.rival);
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

    const rKey = rivalStoreKey(gd.rival);
    const sKey = rivalStoreKey(RIVAL_SELF_NAME);
    const rEntry = liveQid ? rivalStore.quotes[liveQid] : undefined;
    const sEntry = liveQid ? selfStore.quotes[liveQid]  : undefined;

    if (!liveQid) {
      showMsg("Race a quote to compare");
    } else if (rEntry) {
      // ── Value mode ──
      // We know the rival's number, so render the matchup immediately. Your
      // number defaults to 0 when you've never raced this quote (which is
      // exactly the case for a "Next vs" target) — no waiting on a fetch.
      const rv = rEntry[metric];
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
      if (themEl) themEl.textContent = ` / ${rivalFmt(rv)}`;

      // +X gain pill: pops when your value on THIS quote rises (i.e. you just
      // set a new best here). Only baseline/compare once self is settled, so
      // a 0→real correction (from the on-demand fill) never flashes a phantom
      // gain, and a quote change re-baselines instead of comparing across
      // different quotes.
      if (settled && wrapEl) {
        const prev = prevRivalYouMap[goalId];
        if (prev && prev.quoteId === liveQid && prev.value > RIVAL_PP_EPS && sv > prev.value + RIVAL_PP_EPS) {
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
        prevRivalYouMap[goalId] = { quoteId: liveQid, value: sv };
      }
    } else {
      // Rival number unknown for this quote.
      const rivalResolved = rivalBulkDone(rivalStore) || isRememberedAbsent(rKey, liveQid);
      showMsg(rivalResolved ? `${rivalName} hasn't raced this quote` : "Loading…");
    }

    // ── Wins + Next button ──
    const { total, wins, worse, rivalDone, selfDone } = computeRivalStandings(gd);
    const winsEl = document.getElementById(`${goalId}-rival-wins`);
    if (winsEl) {
      const sc = rivalScope();
      const tags = [];
      if (sc !== "all") tags.push(sc);               // "ranked" / "unranked"
      if (rivalSettings.requireBoth) tags.push("shared"); // both-raced denominator
      const scopeTag = tags.length ? ` ${tags.join(", ")}` : "";
      winsEl.textContent = rivalDone
        ? `Wins: ${wins} / ${total}${scopeTag}`
        : `Wins: ${wins} / ${total}${scopeTag}  · syncing…`;
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
      } else {
        nextBtn.disabled = true;
        nextBtn.textContent = `⚔ You lead ${rivalName} 🎉`;
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
    const metric = gd.metric || "wpm";
    const { worse } = computeRivalStandings(gd);
    const rq = loadRivalStore(gd.rival).quotes;
    const sq = loadRivalStore(RIVAL_SELF_NAME).quotes;
    const withGap = worse.map(qid => {
      const rv = rq[qid] ? rq[qid][metric] : 0;
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
      const metric = gd.metric || "wpm";
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

    const base = `https://typegg.io/solo/${encodeURIComponent(pick)}`;
    // Global setting (Settings → Rival): optionally open the head-to-head
    // "/vs/<rival>" page instead of the quote on its own.
    const url = (rivalSettings.nextUsesVsLink && gd.rival)
      ? `${base}/vs/${encodeURIComponent(gd.rival)}`
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
          const url = `https://api.typegg.io/v1/leaders?sort=totalPp&page=${page}&perPage=${perPage}`;
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
            goals[i] = gd;
            saveGoals("pp");
            continue;
          }

          // Same rank — dynamically update target PP in case the leaderboard shifted
          const newPp    = await ppByRank(nextRank);
          const newTarget = Math.max(0, newPp - gd.baselinePp);
          if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
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
            goals[i] = gd;
            saveGoals("exp");
            continue;
          }

          // Same rank — dynamically update target EXP in case the leaderboard shifted
          const newExp    = await expByRank(nextRank);
          const newTarget = Math.max(0, newExp - gd.baselineExp);
          if (Math.abs(newTarget - gd.target) > 0.01 || !gd.targetLoaded) {
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
          const url = `https://api.typegg.io/v1/users/${encodeURIComponent(name)}`;
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
    const r = await gtApiFetch(url, { headers: authHeaders() });
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
    const goals = goalData.races;
    if (!goals || !goals.some(g => goalNeedsRaceList(g))) return Promise.resolve();
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
    const r = await gtApiFetch(url, { headers: authHeaders() });
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

        for (const race of chronological) {
          // Filter (quickplay/solo/all) — same semantics as gated goals.
          if (!raceMatchesFilter(race, gd.filter)) continue;
          const v = getRaceMetricValue(race, metric);
          if (!isFinite(v)) continue;

          // Unique-quote check: skip if this quoteId is already in the
          // current window. Defensive: also skip if uniqueOnly is on
          // but the race has no quoteId (can't enforce uniqueness, so
          // safer to drop than to count). includes() is O(n) but n is
          // small (window size, typically 25-250).
          if (windowQuoteIds) {
            if (!race.quoteId) continue;
            if (windowQuoteIds.includes(race.quoteId)) continue;
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
        }

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

          for (const race of chronological) {
            if (!raceMatchesFilter(race, gd.filter)) continue;
            const val = Number(race[metric]);
            if (!isFinite(val)) continue;
            const qid = race.quoteId;
            if (!qid) continue;
            const st = quoteAvgs[qid];
            if (!st) continue;                  // not seeded → unmeasurable (S1)

            const w = Array.isArray(st.window) ? st.window.slice() : [];
            w.push(val);
            while (w.length > W) w.shift();
            const avg = w.reduce((a, b) => a + b, 0) / w.length;

            let baseline = (st.baseline == null) ? null : st.baseline;
            let peak = st.peak ?? 0;
            if (baseline == null) {
              // Warming up. Lock the baseline the moment the window is full;
              // that race itself contributes nothing (it defines the baseline).
              if (w.length >= W) { baseline = avg; peak = 0; }
            } else {
              const lift = avg - baseline;
              if (lift > peak) { accumulatedGain += (lift - peak); peak = lift; }
            }
            quoteAvgs[qid] = { window: w, baseline, peak };
            impChanged = true;                  // window/state advanced
          }

          if (impChanged || lastEval !== racesSnapshot) {
            goals[i] = { ...gd, quoteAvgs, accumulatedGain, lastEvalRaces: racesSnapshot };
            changed = true;
          }
          continue;
        }

        // Best track (default)
        const quoteBests = { ...(gd.quoteBests || {}) };
        for (const race of chronological) {
          if (!raceMatchesFilter(race, gd.filter)) continue;
          const val = Number(race[metric]);
          if (!isFinite(val)) continue;
          const qid = race.quoteId;
          if (!qid) continue;
          if (!(qid in quoteBests)) continue; // no pre-race baseline → unmeasurable
          const prev = quoteBests[qid];
          if (val > prev) {
            accumulatedGain += (val - prev);
            quoteBests[qid]  = val;            // ratchet the stored best up
            impChanged = true;
          }
        }

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
        if (gd.strictMode && target > 0 && qualifying >= target) break;

        // Filter check: a race that doesn't match the goal's filter is
        // invisible to this goal — neither qualifying nor strict-resetting.
        // (e.g. a 60 WPM solo race during a "100+ WPM quickplay" strict goal
        // shouldn't break the streak.)
        if (!raceMatchesFilter(race, gd.filter)) continue;

        // For goals with quote-axis requirements we need the quote object.
        // Cache should be warm from the pre-fetch above; this await is
        // effectively synchronous on the happy path.
        let quote = null;
        if (goalNeedsQuotes) {
          if (!race.quoteId) {
            // Can't evaluate — skip this race. Don't qualify, don't reset.
            // It'll be re-attempted next eval cycle.
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
        if (!meetsQuoteRequirements(quote, gd.requirements)) continue;

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
            continue;
          }
          qualifying++;
          if (seenQuoteIds && race.quoteId) seenQuoteIds.add(race.quoteId);
        } else if (gd.strictMode) {
          // Strict reset — but ONLY for first-attempt fails. If we've
          // already qualified on this quoteId this period, the user has
          // demonstrably cleared the bar on this quote; a later miss on
          // a re-type is just casual practice and shouldn't kill the
          // streak. Symmetric with the pass-side: each quote gets exactly
          // one chance per period to affect the streak (positively or
          // negatively); after that it's neutral.
          if (seenQuoteIds && race.quoteId && seenQuoteIds.has(race.quoteId)) {
            continue;
          }
          qualifying = 0;
          // Wipe the seen set on a strict reset — the streak is gone, so
          // the no-repeat-quotes restriction starts fresh too. Without this
          // a user who strict-resets would still be locked out of every
          // quote they previously qualified on, which feels punishing.
          if (seenQuoteIds) seenQuoteIds.clear();
        }
        // else: not strict + not qualifying → no change
      }

      // If a quote fetch failed mid-loop, bail out of this goal entirely.
      // Don't update qualifyingProgress or lastEvalRaces — leaving them
      // unchanged means the next eval will retry from the same point,
      // which is exactly what we want for a transient API failure.
      if (goalFailed) continue;

      // Cap qualifyingProgress at target ONLY for strict goals — for the
      // same reason as the freeze above. Non-strict goals are allowed to
      // exceed target so the user gets the same "overshoot" feedback as
      // regular gain goals.
      if (gd.strictMode && target > 0 && qualifying > target) qualifying = target;

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
      // The leader updated a rival/self quote-best store. Refresh our cached
      // copy from disk and re-render the rival cards.
      if (msg.storeKey) reloadRivalStoreFromDisk(msg.storeKey);
      renderAllGoals();
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

    // Auth changed in another tab (TypeGG's own key)? Re-evaluate the gate.
    if (e.key === 'pocketbase_auth') { checkAuthTransition(); return; }

    // Recurrence settings change?
    if (e.key === REC_SETTINGS_KEY) {
      recSettings = loadRecSettings();
      migrateRecurringGoalPeriodStarts(); // preserve in-period progress
      renderAllGoals();
      return;
    }

    // Display settings change?
    if (e.key === DISPLAY_SETTINGS_KEY) {
      displaySettings = loadDisplaySettings();
      renderAllGoals();
      return;
    }

    // Rival settings change?
    if (e.key === RIVAL_SETTINGS_KEY) {
      rivalSettings = loadRivalSettings();
      renderAllGoals();
      if (isLeader) ensureRivalSync();
      return;
    }

    // Groups (widget layout) change?
    if (e.key === GROUPS_KEY) {
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
      if (e.key === cfg.storageKey) {
        try {
          goalData[type] = JSON.parse(e.newValue || '[]');
        } catch { goalData[type] = []; }
        renderAllGoals();
        if (isLeader) {
          if (type === 'pp')     inFlight(updateRankGoals)();
          if (type === 'exp')    inFlight(updateExpRankGoals)();
          if (type === 'quotes') inFlight(updateMaxQuotesGoals)();
          if (type === 'races')  evaluateRaceRequirementsGuarded();
          if (type === 'pp' || type === 'exp') inFlight(updatePlayerGoals)();
          if (type === 'rival')  ensureRivalSync();
        }
        return;
      }
    }

    // Rival/self quote-best store updated by the leader (or GC'd)? Refresh
    // our cached copy and re-render the rival cards. startsWith(RIVAL_SELF_KEY)
    // matches both the legacy unscoped key and the scoped gt-rivalq-self-<name>.
    if (e.key.startsWith(RIVAL_SELF_KEY) || e.key.startsWith(RIVAL_KEY_PREFIX)) {
      reloadRivalStoreFromDisk(e.key);
      renderAllGoals();
      return;
    }

    // Stats cache updated by leader? Hydrate.
    if (e.key === STATS_CACHE_KEY && e.newValue && !isLeader) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed?.data) applyUserData(parsed.data);
      } catch {}
      return;
    }

    // EXP rank cache updated by leader? Hydrate.
    if (e.key === 'gt-exp-rank' && e.newValue) {
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