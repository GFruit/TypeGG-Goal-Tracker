window.addEventListener("load", () => {

  // ── Cached stats (for target-mode hint in modal) ───────────────
  let currentStats = { exp: null, pp: null, races: null, quotes: null, playtime: null, rank: null, expRank: JSON.parse(localStorage.getItem("gt-exp-rank"))?.rank ?? null };

  // ── Gain delta tracking (for +X pop-up indicators) ─────────────
  // Stores the last known gain value per goal ID so renderAllGoals()
  // can compute the delta and trigger a visual indicator on increase.
  const prevGainMap = {};

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
    return () => { if (anyTabVisibleRecently()) fn(); };
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
      <div class="gt-gain-row">
        <span class="gt-gain-text-wrap">
          <span id="${goalId}-gain-text">0 / 0</span>
        </span>
        <span id="${goalId}-done-badge" class="gt-done-badge" style="display:none;">✓</span>
      </div>
      <div class="gt-progress-bar">
        <div id="${goalId}-progress-fill" class="gt-progress-fill"></div>
      </div>
      <div id="${goalId}-countdown" class="gt-countdown" style="display:none;"></div>
    `;

    (parentContent || container.querySelector(".gt-content")).appendChild(section);

    // Attach remove handler
    document.getElementById(`${goalId}-remove-btn`).addEventListener("click", () => {
      removeGoal(type, goalId);
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

  // ── Resize persistence (main widget only — detached are auto-sized) ──
  {
    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!groupData[MAIN_GROUP_ID]) return;
        groupData[MAIN_GROUP_ID].size = { width: container.offsetWidth + "px" };
        saveGroups();
      }, 300);
    }).observe(container);
  }

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
    }
  });

  // ── Render widgets from groupData ─────────────────────────────
  // Creates/destroys detached widget DOM to match groupData. Does NOT
  // move goal sections around; that's driven by drag commits and goal
  // lifecycle events (create/remove). Safe to call any time; idempotent.
  function renderGroupWidgets() {
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
      <div class="gt-section-label" id="gt-amount-label">Amount</div>
      <div class="gt-target-row">
        <div id="gt-next-rank-row" style="display:none; margin-bottom: 6px;">
          <button id="gt-next-rank-btn" class="gt-mode-btn" style="width:100%;">⚡ Next Rank</button>
        </div>
        <div id="gt-presets" class="gt-presets"></div>
        <input id="gt-custom-input" class="gt-custom-input" type="number" min="1" placeholder="Custom" />
      </div>
      <div id="gt-mode-hint" class="gt-mode-hint" style="display:none;"></div>
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
        <span class="gt-modal-title">Settings</span>
        <button id="gt-settings-close" class="gt-close-btn">✕</button>
      </div>
      <div class="gt-settings-body">
        <nav class="gt-settings-sidebar" id="gt-settings-sidebar"></nav>
        <div class="gt-settings-content" id="gt-settings-content"></div>
      </div>
      <div class="gt-settings-actions">
        <button id="gt-settings-cancel" class="gt-settings-action-btn secondary">Cancel</button>
        <button id="gt-settings-save"   class="gt-settings-action-btn primary">Save</button>
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
  let settingsDraft       = null;    // pending edits while the modal is open; committed on Save

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

    // Wheel init deferred one frame so offsetHeight is correct.
    requestAnimationFrame(() => {
      if (activeRecSubTab === "weekly") {
        const wheelEl = document.getElementById("gt-rs-wheel");
        const summary = document.getElementById("gt-rs-summary");
        activeWheel = createWheel(wheelEl, WEEKDAY_ITEMS, draft.recSettings.weekly.weekday, (v) => {
          draft.recSettings.weekly.weekday = v; // live-update draft so sub-tab swaps preserve it
          if (summary) summary.innerHTML = `Your weekly goals reset every <b>${WEEKDAY_NAMES[v]}</b> at…`;
        });
      } else if (activeRecSubTab === "monthly") {
        const wheelEl = document.getElementById("gt-rs-wheel");
        const summary = document.getElementById("gt-rs-summary");
        const dayItems = Array.from({ length: 31 }, (_, i) => ({ label: String(i + 1), value: i + 1 }));
        activeWheel = createWheel(wheelEl, dayItems, draft.recSettings.monthly.day, (v) => {
          draft.recSettings.monthly.day = v; // live-update draft
          if (summary) summary.innerHTML = `Your monthly goals reset on the <b>${ordinal(v)}</b> at…`;
          updateMonthlyNote(v);
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
      });
    });
  }

  function commitDisplayTab(draft) {
    if (draft.displaySettings.streakMode === displaySettings.streakMode) return; // no change
    displaySettings = { ...draft.displaySettings };
    saveDisplaySettings();
    renderAllGoals();
  }

  // ── Backup tab (import / export) ──────────────────────────────
  // Lets the user save their goals + widget layout + settings to a
  // JSON file, and later restore it — e.g. when moving to a new
  // browser or PC. Export/import act outside the modal's draft flow:
  // clicking Export downloads immediately, clicking Import and
  // confirming replaces state immediately. Both actions bypass the
  // modal's Save/Cancel (commitBackupTab is a no-op).
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

    // Reload in-memory state from storage
    for (const [type, cfg] of Object.entries(GOAL_CONFIG)) {
      try { goalData[type] = JSON.parse(localStorage.getItem(cfg.storageKey) || "[]"); }
      catch { goalData[type] = []; }
    }
    groupData       = loadGroups() || { [MAIN_GROUP_ID]: { position: null, size: null, goalIds: [] } };
    ensureMainGroup();
    recSettings     = loadRecSettings();
    displaySettings = loadDisplaySettings();

    // Clear ephemeral state. prevGainMap would otherwise trigger
    // fake "+N gained!" pop-ups on the next render if any of the
    // imported goals have baselines that happen to match prior IDs.
    for (const k of Object.keys(prevGainMap)) delete prevGainMap[k];

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
      const ok = confirm(
        `Import will REPLACE your current setup with:\n\n${summary}\n\n` +
        `Your current goals and layout will be lost (unless you copied them first).\n\nContinue?`
      );
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
  // confirm() dialog. Counting goals per type rather than listing them
  // individually keeps the message short.
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
    { id: "backup",     label: "Backup",     render: renderBackupTab,     commit: commitBackupTab     },
  ];

  // ── Capture currently-visible form values into the draft ─────
  // Number inputs only update `draft` on blur (via the wheel/callback
  // path or manual persist). Called before any action that would
  // replace the DOM (tab/sub-tab switch) or commit (Save), so
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
  function openSettingsModal() {
    settingsDraft = {
      recSettings:     JSON.parse(JSON.stringify(recSettings)),
      displaySettings: { ...displaySettings },
      // future tabs seed their own draft slice here
    };
    if (!activeSettingsTabId) activeSettingsTabId = SETTINGS_TABS[0].id;
    activeRecSubTab = "daily";
    activeWheel = null;

    buildSettingsSidebar();
    renderActiveSettingsTab();
    settingsOverlay.classList.add("open");
  }

  function closeSettingsModal() {
    settingsOverlay.classList.remove("open");
    settingsDraft = null;
    activeWheel = null;
  }

  function saveSettings() {
    persistActiveFormToDraft(); // capture any unblurred input edits
    for (const tab of SETTINGS_TABS) tab.commit(settingsDraft);
    closeSettingsModal();
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
  document.getElementById("gt-settings-cancel").addEventListener("click", closeSettingsModal);
  document.getElementById("gt-settings-save")  .addEventListener("click", saveSettings);
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
    const s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
    if(d>0) return `resets in ${d}d ${h}h`;
    if(h>0) return `resets in ${h}h ${m}m`;
    return `resets in ${m}m`;
  }

  // ── Playtime formatter (ms → human) ───────────────────────────
  function formatPlaytime(ms) {
    if (ms <= 0) return "0m";
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
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error("Leaderboard fetch failed");
    const data = await response.json();
    const targetUser = data.users?.find(u => u.stats?.ranking === targetRank);
    if (!targetUser) throw new Error(`Rank #${targetRank} not found on page ${page}`);
    return targetUser.stats.totalPp;
  }

  // ── Username → PP lookup ─────────────────────────────────────────
  async function getPpByUsername(username) {
    const url = `https://api.typegg.io/v1/users/${encodeURIComponent(username)}`;
    
    const response = await fetch(url, { headers: authHeaders() });
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
    
    const response = await fetch(url, { headers: authHeaders() });
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
    
    const response = await fetch(url, { headers: authHeaders() });
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

    const response = await fetch(url.toString(), {
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
      const res = await fetch('https://api.typegg.io/v1/quotes?perPage=1&status=ranked', {
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
  };

  // ── Modal state ────────────────────────────────────────────────
  const presetsEl   = document.getElementById("gt-presets");
  const confirmBtn  = document.getElementById("confirm-goal-btn");
  const customInput = document.getElementById("gt-custom-input");
  const typeBtns    = document.querySelectorAll(".gt-type-btn");
  const recBtns     = document.querySelectorAll(".gt-rec-btn");
  const modeBtns    = document.querySelectorAll(".gt-mode-selector .gt-mode-btn");
  const filterBtns  = document.querySelectorAll(".gt-filter-btn");
  const modeRow     = document.getElementById("gt-mode-row");
  const recRow      = document.getElementById("gt-rec-row");
  const filterRow   = document.getElementById("gt-filter-row");
  const modeHint    = document.getElementById("gt-mode-hint");
  const amountLabel = document.getElementById("gt-amount-label");

  let selectedType  = "exp";
  let selectedRec   = "none";
  let selectedMode  = "gain";
  let selectedFilter = "all"; // for races: "all" or "quickplay"
  let selectedValue = null; // always raw units (ms for playtime)

  // rank mode state
  let rankFetchedPp     = null; // PP fetched for the entered rank
  let rankFetchedExp    = null; // EXP fetched for the entered rank
  let rankFetchedRank   = null; // the rank number we fetched for
  let rankDebounce      = null;
  let nextRankMode      = false; // "next rank" toggle

  const nextRankRow        = document.getElementById("gt-next-rank-row");
  const nextRankToggleBtn  = document.getElementById("gt-next-rank-btn");

  let playerFetchedValue = null;
  let playerFetchedName = null;
  let playerDebounce = null;

  // max quotes mode state
  let maxQuotesMode = false; // "max" toggle for quotes
  let maxQuotesFetched = null; // total ranked quotes count

  function formatPreset(n) {
    if (n >= 1000) return (n/1000)%1===0 ? `${n/1000}k` : `${(n/1000).toFixed(1)}k`;
    return String(n);
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

    const isTargetMode = selectedMode === "target" && cfg.supportsTarget;
    const isRankMode   = selectedMode === "rank";
    const isPlayerMode = selectedMode === "player";


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
      customInput.style.display = "";
      customInput.type          = "number";
      amountLabel.textContent   = "Target total";
      customInput.placeholder   = "Custom";
      presetsEl.innerHTML = "";
      
      nextRankRow.style.display = "block";
      nextRankToggleBtn.textContent = "⚡ Max";

      if (maxQuotesMode) {
        // ── Max quotes sub-mode ────────────────────────────────
        customInput.style.display = "none";
        nextRankToggleBtn.classList.add("active");
        
        modeHint.textContent = "Loading total ranked quotes…";
        modeHint.className = "gt-mode-hint";
        modeHint.style.display = "block";
        
        getTypeGGTotalQuotes().then(total => {
          if (total != null) {
            maxQuotesFetched = total;
            const cur = currentStats.quotes;
            
            if (cur != null && total <= cur) {
              modeHint.textContent = `⚠ You've already typed all ${total.toLocaleString()} ranked quotes!`;
              modeHint.className = "gt-mode-hint gt-mode-hint-error";
              confirmBtn.disabled = true;
            } else {
              modeHint.textContent = `Max: ${total.toLocaleString()} ranked quotes on TypeGG`;
              modeHint.className = "gt-mode-hint";
              confirmBtn.disabled = false;
            }
          } else {
            modeHint.textContent = "⚠ Failed to load quote count";
            modeHint.className = "gt-mode-hint gt-mode-hint-error";
            confirmBtn.disabled = true;
          }
        });
      } else {
        // ── Manual input for target quotes ────────────────────
        customInput.style.display = "";
        nextRankToggleBtn.classList.remove("active");
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
    } else if (selectedMode === "target" && selectedType === "quotes") {
      // Handle max quotes toggle for Quotes
      maxQuotesMode = !maxQuotesMode;
      maxQuotesFetched = null;
      customInput.value = "";
      renderPresets();
    }
  });

  typeBtns.forEach(btn => btn.addEventListener("click", () => {
    typeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedType = btn.dataset.type;
    const cfg = GOAL_CONFIG[selectedType];

    // Show filter row only for races
    filterRow.style.display = (selectedType === "races") ? "block" : "none";

    // Show rank button only for PP
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";

    // Show player button only for PP
    playerBtn.style.display = (selectedType === "pp" || selectedType == "exp") ? "" : "none";


    // If rank/player was active and we switched away from PP/EXP, fall back to gain
    if ((selectedMode === "rank" || selectedMode === "player") && !(selectedType === "pp" || selectedType === "exp")) {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }

    modeRow.style.display = cfg.supportsTarget ? "block" : "none";
    if (!cfg.supportsTarget && (selectedMode === "target" || selectedMode === "rank" || selectedMode === "player")) {
      selectedMode = "gain";
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    }

    // Recurrence row mirrors the final mode: shown only for gain
    recRow.style.display = (selectedMode === "gain") ? "block" : "none";

    renderPresets();
  }));

  modeBtns.forEach(btn => btn.addEventListener("click", () => {
    modeBtns.forEach(b => b.classList.remove("active")); btn.classList.add("active");
    selectedMode = btn.dataset.mode;
    if (selectedMode === "target" || selectedMode === "rank" || selectedMode === "player") {
      selectedRec = "none";
      recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
      recRow.style.display = "none";
    } else { recRow.style.display = "block"; }
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

  function openModal() {
    overlay.classList.add("open");
    typeBtns.forEach(b => b.classList.toggle("active", b.dataset.type === "exp"));
    recBtns.forEach(b => b.classList.toggle("active", b.dataset.rec === "none"));
    modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === "gain"));
    filterBtns.forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
    selectedType = "exp"; selectedRec = "none"; selectedMode = "gain"; selectedFilter = "all";
    rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesFetched = null;
    playerBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    rankBtn.style.display = (selectedType === "pp" || selectedType === "exp") ? "" : "none";
    nextRankRow.style.display = "none";
    filterRow.style.display = "none"; // hide filter row initially (only show for races)
    modeRow.style.display = "block"; recRow.style.display = "block";
    renderPresets();
  }
  function closeModal() {
    overlay.classList.remove("open");
    selectedValue = null; rankFetchedPp = null; rankFetchedRank = null; nextRankMode = false;
    maxQuotesMode = false; maxQuotesFetched = null;
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
  function removeGoal(type, goalId) {
    goalData[type] = goalData[type].filter(g => g.id !== goalId);
    saveGoals(type);
    const section = document.getElementById(`${goalId}-goal-section`);
    if (section) section.remove();
    delete prevGainMap[goalId];

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
  }

  confirmBtn.addEventListener("click", async () => {
    try {
      const response = await fetch(userEndpoint(), { headers: authHeaders() });
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
    } else if (selectedMode === "target" && cfg.supportsTarget) {
        if (selectedType === "quotes" && maxQuotesMode) {
          // Max quotes mode
          if (maxQuotesFetched == null) return;
          gainTarget = maxQuotesFetched - currentVal;
          if (gainTarget <= 0) gainTarget = 0;
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
      
      const newGoal = {
        id: goalId,
        target: gainTarget,
        targetRank: selectedMode === "rank" ? rankFetchedRank : undefined,
        nextRank: (selectedMode === "rank" && nextRankMode) || undefined,
        targetUsername: selectedMode === "player" ? playerFetchedName : undefined,
        maxQuotes: isMaxQuotes || undefined,
        filter: selectedType === "races" ? selectedFilter : undefined,
        targetLoaded: selectedMode === "rank" ? false : true, // false for rank goals — target is loaded async by updateRankGoals/updateExpRankGoals
        [cfg.baselineKey]: currentVal,
        recurrence: selectedRec,
        periodStart: isRecurring ? getCurrentPeriodStart(selectedRec) : null,
        streak: 0,
        totalCompletions: 0,
        completedThisPeriod: false,
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
      }
    } catch (err) { console.error("Failed to set goal:", err); }
  });

  // ── Update a single goal section ───────────────────────────────
  function updateGoalSection(goalId, type, cfg, gd, gain, isRecurring, gainDelta = 0) {
    // Calculate percentage - for max quotes use total progress, otherwise use gain
    let pct, isComplete;
    if (gd.maxQuotes) {
      const currentQuotes = gd.baselineQuotes + gain;
      const totalQuotes = gd.baselineQuotes + gd.target;
      pct = totalQuotes > 0 ? Math.min(Math.floor((currentQuotes / totalQuotes) * 100), 100) : 0;
      isComplete = currentQuotes >= totalQuotes && totalQuotes > 0;
    } else {
      pct = Math.min(Math.floor((gain / gd.target) * 100), 100);
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

    if (gd.nextRank && gd.targetRank) {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → #${gd.targetRank} (next rank)`;
    } else if (gd.targetRank) {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → rank #${gd.targetRank}`;
    } else if (gd.targetUsername) {
      document.getElementById(`${goalId}-label`).textContent =
        `${cfg.label} (vs ${gd.targetUsername})`;
    } else if (gd.maxQuotes) {
      document.getElementById(`${goalId}-label`).textContent = `${cfg.label} → max quotes`;
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

    // ── Gain delta indicator (+X pop-up) ───────────────────────
    if (gainDelta > 0) {
      // Format the delta the same way the gain text is formatted
      let deltaStr;
      if (cfg.isTime) {
        deltaStr = `+${formatPlaytime(gainDelta)}`;
      } else if (cfg.decimals > 0) {
        deltaStr = `+${parseFloat(gainDelta).toFixed(cfg.decimals)}`;
      } else {
        deltaStr = `+${Math.round(gainDelta).toLocaleString()}`;
      }

      // Remove any existing indicator so re-triggering restarts the animation
      const existing = document.getElementById(`${goalId}-gain-indicator`);
      if (existing) existing.remove();

      const indicator = document.createElement("span");
      indicator.id = `${goalId}-gain-indicator`;
      indicator.className = "gt-gain-indicator";
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
    const response = await fetch(userEndpoint(), { headers: authHeaders() });
    if (!response.ok) throw new Error(`User fetch failed: ${response.status}`);
    const data = await response.json();
    return {
      exp:            data.stats?.experience,
      pp:             data.stats?.totalPp,
      races:          data.stats?.races,
      quotes:         data.stats?.quotesTyped,
      playtime:       data.stats?.playTime,
      rank:           data.globalRank ?? null,
      chars:          data.stats?.completionCharactersTyped,
      quickplayRaces: data.stats?.quickplayRaces,
      soloRaces:      data.stats?.soloRaces,
    };
  }

  // ── Apply fetched user data to in-memory state + render ──────
  function applyUserData(data) {
    if (!data) return;
    currentStats.exp            = data.exp;
    currentStats.pp             = data.pp;
    currentStats.races          = data.races;
    currentStats.quotes         = data.quotes;
    currentStats.playtime       = data.playtime;
    currentStats.rank           = data.rank;
    currentStats.chars          = data.chars;
    currentStats.quickplayRaces = data.quickplayRaces;
    currentStats.soloRaces      = data.soloRaces;
    renderAllGoals();
  }

  // ── Render all goal sections using in-memory state ───────────
  // Pure DOM updates — no fetch, safe to call from any tab.
  function renderAllGoals() {
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
    const typeOrder = ['exp', 'pp', 'races', 'quotes', 'playtime', 'chars'];

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

        // Ensure correct position within the widget based on group.goalIds.
        // Skipped entirely during a drag: the drag system owns DOM order
        // while active (moving the placeholder, running FLIP animations).
        // If renderAllGoals fought it, siblings could jump mid-animation.
        // Drag's own commit at mouseup leaves the DOM consistent with
        // groupData, so this code has nothing to fix once the drag ends.
        if (!dragInProgress) {
          const desiredIndex = groupData[gid].goalIds.indexOf(goalId);
          const siblings = Array.from(targetContent.children).filter(c =>
            !c.classList.contains("gt-goal-placeholder")
          );
          const currentIndex = siblings.indexOf(section);
          if (currentIndex !== desiredIndex && desiredIndex >= 0) {
            if (desiredIndex >= siblings.length) targetContent.appendChild(section);
            else                                 targetContent.insertBefore(section, siblings[desiredIndex]);
          }
        }

        const isRecurring = !!(gd.recurrence && gd.recurrence !== "none");

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
            goals[i] = gd;
            saveGoals(type);
          }
        }

        const gain = Math.max(0, currentVal - gd[cfg.baselineKey]);
        // Compute delta for the +X indicator. Skip on first render (prevGain == null).
        const prevGain = prevGainMap[goalId];
        const gainDelta = (prevGain != null && gain > prevGain) ? gain - prevGain : 0;
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
  }

  // ── Stats + reset logic (leader only) ────────────────────────
  async function loadStats() {
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

  // Run one retry chain: fetch up to N times, stop when stats change
  async function runQuoteFinishRetryChain() {
    // Snapshot of stats at the moment the quote finished.
    // We compare against this — not against `currentStats`, which may
    // get updated mid-chain by the 20s poll.
    const snap = {
      races:    currentStats.races,
      pp:       currentStats.pp,
      exp:      currentStats.exp,
      quotes:   currentStats.quotes,
      chars:    currentStats.chars,
      playtime: currentStats.playtime,
    };

    for (let i = 0; i < QF_RETRY_DELAYS_MS.length; i++) {
      await new Promise(r => setTimeout(r, QF_RETRY_DELAYS_MS[i]));

      let data;
      try { data = await fetchUserData(); }
      catch { continue; } // transient error — try again next tick

      // Always apply + broadcast the freshest data we got
      applyUserData(data);
      try {
        localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch {}
      channel?.postMessage({ type: 'stats', payload: data });

      // Any change vs the pre-finish snapshot? → server has updated, stop.
      const changed =
        data.races    !== snap.races    ||
        data.pp       !== snap.pp       ||
        data.exp      !== snap.exp      ||
        data.quotes   !== snap.quotes   ||
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
        // New quote started: reset the fire-once flag
        if (wasDisabled && !isDisabled) fired = false;
        wasDisabled = isDisabled;
      });
      inputObserver.observe(input, {
        attributes: true,
        attributeFilter: ['disabled'],
      });
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
          pageCache.set(page, fetch(url, { headers: authHeaders() }).then(r => {
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
          pageCache.set(page, fetch(url, { headers: authHeaders() }).then(r => {
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
          const r = await fetch(url, { headers: authHeaders() });
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

  // ── Max quotes goal target computation ────────────────────────
  async function updateMaxQuotesGoals() {
    try {
      const goals = goalData.quotes;
      if (!goals || goals.length === 0) return;
      if (currentStats.quotes == null) return;

      // ── Skip entirely if no goal actually uses maxQuotes ─────
      if (!goals.some(g => g.maxQuotes)) return;

      // ── Fetch ONCE, outside the loop ─────────────────────────
      // Previously this was called inside the for-loop, meaning a user
      // with 5 max-quote goals fired 5 identical requests every tick.
      const newTotal = await getTypeGGTotalQuotes();
      if (newTotal == null) return;

      for (let i = 0; i < goals.length; i++) {
        let gd = goals[i];
        if (!gd.maxQuotes) continue;

        const newTarget = newTotal - gd.baselineQuotes;
        const finalTarget = Math.max(0, newTarget);

        if (Math.abs(finalTarget - gd.target) > 0.01) {
          gd.target = finalTarget;
          goals[i] = gd;
          saveGoals("quotes");
        }
      }
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
    // burst the API in the first second after becoming leader
    setTimeout(() => runIfAnyTabVisible(inFlight(updateRankGoals))(),      3_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updateExpRankGoals))(),   6_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updatePlayerGoals))(),    9_000);
    setTimeout(() => runIfAnyTabVisible(inFlight(updateMaxQuotesGoals))(), 12_000);
    updateExpRankTracking(); // gated internally on having EXP rank goals

    setInterval(runIfAnyTabVisible(inFlight(updateRankGoals)),       POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateExpRankGoals)),    POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updatePlayerGoals)),     POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateMaxQuotesGoals)),  POLL_SLOW_MS);
    setInterval(runIfAnyTabVisible(inFlight(updateExpRankTracking)), POLL_SLOW_MS);
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
          if (t === 'pp' || t === 'exp') inFlight(updatePlayerGoals)();
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
          if (type === 'pp' || type === 'exp') inFlight(updatePlayerGoals)();
        }
        return;
      }
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
  if ('locks' in navigator) {
    navigator.locks.request(LEADER_LOCK_NAME, { mode: 'exclusive' }, async () => {
      isLeader = true;
      console.log('[Goal Tracker] became leader tab');
      startLeaderIntervals();
      // Hold the lock for the lifetime of this tab
      await new Promise(() => {});
    }).catch(err => console.error('[Goal Tracker] leader lock error:', err));
  } else {
    // Fallback for old browsers without Web Locks API:
    // act as leader. Worst case = original behavior (each tab fetches).
    console.warn('[Goal Tracker] Web Locks API unavailable — falling back to per-tab fetching');
    isLeader = true;
    startLeaderIntervals();
  }

});