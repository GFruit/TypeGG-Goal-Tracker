# TypeGG Goal Tracker

A browser extension that adds a live goal-tracking widget to [TypeGG](https://typegg.io). Set goals for your typing — EXP, PP, races, quotes, rolling averages, improvement, time, characters — and the widget keeps score in real time as you race. Nothing to log by hand; finish a quote and your goals update.

> Disclaimer:
This is an unofficial community-made browser extension for "TypeGG" (typegg.io), a brand and platform operated by TYPEGG LTD. This extension is not affiliated with, endorsed by, sponsored by, or officially associated with "TypeGG" or TYPEGG LTD.

---

## Table of contents

- [Features](#features)
  - [Stats you can track](#stats-you-can-track)
  - [Goal modes](#goal-modes)
  - [Race goals: filters, requirements & modes](#race-goals-filters-requirements--modes)
  - [Recurring goals & streaks](#recurring-goals--streaks)
  - [Widget layout](#widget-layout)
  - [Live feedback](#live-feedback)
  - [Backup & restore](#backup--restore)
- [Example goals](#example-goals)
- [Installation](#installation)
- [How it works](#how-it-works)
- [Privacy & data](#privacy--data)
- [Browser support](#browser-support)
- [Contributing](#contributing)

---

## Features

### Stats you can track

Six core TypeGG stats:

| Stat | Description |
|------|-------------|
| **EXP** | Experience points |
| **PP** | Performance points (skill rating) |
| **Races** | Races completed |
| **Quotes** | Quotes typed |
| **Time** | Total time spent typing |
| **Chars** | Characters typed |

### Goal modes

Each stat can be framed as a different *kind* of goal:

- **Gain** — counts upward from a baseline snapshotted when the goal is created. *"Gain 1,000 EXP."* Available for every stat.
- **Target** — aim at an absolute total rather than a delta; the modal warns if you pick a value you've already passed. *"Reach 5,000 PP."* Available for EXP, PP, Races, Quotes, Chars.
- **Rank** *(PP & EXP)* — target a leaderboard position. The extension fetches the PP/EXP of whoever currently holds that rank and uses it as the target. A **Next Rank** toggle aims at the next position above you and auto-re-targets the moment you overtake someone.
- **Player** *(PP & EXP)* — target another user's PP/EXP by username and race to catch them.
- **Average** *(Races)* — a rolling average over your last *N* races for one metric (WPM, accuracy, or PP). Tracks current average, best (peak) average, and how full the window is, against a target average. Optional unique-quote constraint.
- **Improvement** *(Races)* — cumulative growth. For each quote, compares your result to your prior best (or rolling average) on that quote and sums the positive deltas. Choose WPM or PP, track against **best** (ratchets PBs) or **average** (raises your typical level), and optionally count first-ever attempts.
- **Max quotes** *(Quotes)* — one tap auto-fills the total number of quotes on TypeGG (**all**, **ranked**, or **unranked**) as the target, for completionist goals.

### Race goals: filters, requirements & modes

Race goals are the most configurable:

- **Filters** — restrict a goal to **All**, **Solo**, or **Quickplay** games.
- **Requirements** — gate which races count by setting minimums for any combination of:
  - Skill axes: **WPM**, **Accuracy**, **PP**
  - Quote axes: **Length**, **Difficulty**

  Only races clearing *every* active threshold count toward the goal.
- **Strict mode (⚡)** — a single race that misses the requirements resets the goal to zero. For holding a standard, not just touching it.
- **Unique-quote mode (✨)** — each qualifying race must be on a quote not already counted this period, so you can't pad progress by repeating one quote.

### Recurring goals & streaks

Any goal can repeat **Daily**, **Weekly**, or **Monthly**:

- Configure the reset time per cadence — hour for daily; weekday + time for weekly; day-of-month + time for monthly (with a fallback to the last day in shorter months).
- A live **countdown** shows time until the next reset.
- A **🔥 streak** counter tracks consecutive completed periods. Switchable to a **total** lifetime-completions counter, or **off**.
- Editing the reset schedule preserves the progress already made in the current period — it re-aligns the period start without discarding your baseline.

### Widget layout

- Starts as a single widget pinned to the corner.
- **Drag to reorder** goals within a widget.
- **Drag a goal out** to spawn a detached widget anywhere on screen.
- **Stack** goals by dropping one onto another widget.
- FLIP-based animations for smooth reordering; layout is persisted between sessions; the main widget is resizable.

### Live feedback

- Quote-finish detection updates goals immediately, no refresh needed.
- Each goal card shows a progress bar, current-vs-target figures, and a ✓ when complete.
- A green **+X** flashes on each qualifying race; a red **−X ⚡** flashes on a strict-mode reset.
- Average goals get a dedicated three-line card: best, current rolling average, and threshold + window progress.

### Backup & restore

Export goals, widget layout, and settings to a single versioned JSON file, and import it later — useful when switching browsers or machines.

---

## Example goals

| Goal | Configuration |
|------|---------------|
| Type 50,000 EXP this week | EXP · Gain · Weekly |
| Reach 5,000 PP | PP · Target |
| Climb to rank #100 | PP · Rank |
| Catch up to a friend's EXP | EXP · Player |
| Run 100 races today | Races · Gain · Daily |
| 25 races at 120+ WPM & 98%+ accuracy, strict | Races · Gain · Requirements · Strict ⚡ |
| 50 quickplay races on 50 different quotes | Races · Quickplay · Unique ✨ |
| Type every ranked quote on TypeGG | Quotes · Max ranked |
| Hold a 130 WPM average over your last 25 races | Races · Average |
| 99% accuracy average over 50 unique-quote races | Races · Average · Unique ✨ |
| Gain 500 WPM of improvement across your PBs | Races · Improvement · Best |
| Raise average WPM by 250 over a 10-race window | Races · Improvement · Average |
| Type for one hour every day | Time · Daily |
| Type one million characters | Chars · Target |
| 10 races on 300+ char quotes at difficulty 5+ | Races · Gain · Length & Difficulty requirements |

---

## Installation

> Replace the placeholders below with your actual store links / repo details.

**From the store**

- Chrome / Edge: *(Chrome Web Store link)*
- Firefox: *(Add-ons link)*

**From source (developer / unpacked)**

1. Clone the repository:
   ```bash
   git clone https://github.com/<you>/typegg-goal-tracker.git
   ```
2. **Chromium (Chrome, Edge, Brave):** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the project folder.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select the `manifest.json`.
4. Open [typegg.io](https://typegg.io) — the goal widget appears automatically.

---

## How it works

The extension is a single content script injected on TypeGG that builds and manages the widget. The notable pieces:

- **Auth reuse.** It reads TypeGG's own session token from `localStorage` (`pocketbase_auth`) to call the public TypeGG API. There's no separate login.
- **Quote-finish detection.** A `MutationObserver` watches the typing input's `disabled` attribute for the enabled→disabled transition that marks a finished quote, backed up by polling the live quote ID to catch skips and the first quote of a session. Each finish triggers a goal re-evaluation.
- **Cross-tab coordination.** With multiple TypeGG tabs open, exactly one becomes the "leader" via the [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) and performs all API fetching. Followers receive updates over a `BroadcastChannel` and re-render, with a `localStorage` stats cache (and `storage` events) as a fallback so late-joining tabs hydrate immediately. Fetching is visibility-aware: it keeps polling while *any* tab is visible. If the Web Locks API is unavailable (or errors, as it can inside Firefox content scripts), each tab falls back to fetching for itself.
- **Evaluation paths.** Pure stat goals (EXP, PP, time, etc.) use a lightweight current-minus-baseline delta. Goals that need per-race detail — anything with requirements, unique-quote mode, rolling averages, or improvement tracking — pull the recent race list (and, where length/difficulty requirements are set, the relevant quote records) and evaluate race-by-race.
- **State.** Goals, widget layout (groups), recurrence settings, and display settings are all stored in `localStorage` and kept in sync across tabs.

---

## Privacy & data

- All goal data, layout, and settings live in your browser's `localStorage`. Nothing is sent to any third-party server.
- API requests go only to TypeGG, using your existing TypeGG session, to read the stats needed to evaluate your goals.
- No analytics, no tracking, no accounts.

---

## Browser support

Chromium-based browsers (Chrome, Edge, Brave) and Firefox. The extension includes specific handling for Firefox content-script quirks around the Web Locks API and content-script load timing.