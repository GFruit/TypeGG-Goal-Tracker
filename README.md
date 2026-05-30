# TypeGG Goal Tracker

Create personalized goals to track your typing progress on [TypeGG](https://typegg.io/) in real time. **TypeGG Goal Tracker** is a minimalistic, customizable browser extension that helps you stay motivated and improve your typing speed.

Goals update live as you race and are shown in a compact panel right on the TypeGG page.

## Goal Types

| Type | Tracks |
| --- | --- |
| **EXP** | Experience points |
| **PP** | Performance points |
| **Races** | Races completed |
| **Quotes** | Unique quotes (texts) typed |
| **Time** | Time spent typing |
| **Chars** | Characters typed |

## Goal Modes

The extension supports **6 goal modes**:

- **Gain** — track how much you gain over time *(every type)*
- **Target** — track progress toward an absolute target *(every type)*
- **Rank** — reach a certain rank on the EXP / PP leaderboards *(EXP & PP only)*
- **Player** — reach the EXP / PP of a specific player *(EXP & PP only)*
- **Average** — reach a target average across your last *n* races *(Races only)*
- **Improvement** — improve your personal bests, quote by quote *(Races only)*

### Rank Mode
Set a goal of reaching a certain rank on the EXP / PP leaderboards. The tracker tells you how much EXP / PP you still need to gain, and the target updates automatically since the EXP / PP required for a rank can change at any time.

- **Next Rank** — create the goal with this button enabled to target the next rank above you. When you reach it, a new goal is automatically created for the following rank.

### Player Mode
Set a goal of reaching the EXP / PP of a specific player. The target updates automatically as that player's EXP / PP changes.

### Average Mode
Set a goal for reaching a certain average **WPM**, **Accuracy** or **PP** across your last *n* races. You need to complete at least *n* races before the goal can be completed.

- **Unique-quote toggle** — require every race in the rolling window to be on a different quote.

### Improvement Mode
Set a goal for improving your personal bests, quote by quote. It adds up how much you beat your previous best on each quote — for example, if your PB on a quote was 100 WPM and you hit 120, that counts as **+20** toward your goal.

- Track **WPM gain** or **PP gain**.
- By default, only quotes you've raced before count, since improvement needs a previous best to measure against. An optional toggle also counts the first time you ever type a quote.

## Requirements (Races + Gain mode)

Add requirements so that only races that qualify count toward your goal:

- **Skill thresholds** — minimum WPM, Accuracy, PP
- **Quote thresholds** — minimum length and difficulty
- **Strict mode** — progress resets to zero whenever a race misses the requirements
- **Unique-quote mode** — each quote only counts once

## Filters (Races)

Count **all** races, only **Quickplay** races, or only **Solo** races.

## Recurrence

Goals can repeat **daily**, **weekly** or **monthly**, with a streak display that tracks how many periods in a row you've hit the goal.

Use the built-in presets, or set your own custom goals.

## Example Goals

| Goal | Type | Mode | Settings |
| --- | --- | --- | --- |
| Gain 1000 EXP per day | EXP | Gain | Daily · Amount 1000 |
| Reach a target PP of 15'000 | PP | Target | Amount 15'000 |
| Complete 10 races per day | Races | Gain | Daily · Amount 10 |
| Reach the next rank | PP | Rank | "Next Rank" |
| Reach rank #50 | PP | Rank | Target Rank 50 |
| Reach the PP of player "Fruit" | PP | Player | Target Player Fruit |
| Type for 30 minutes per day | Time | Gain | Daily · Amount 30 |
| 100 WPM average over your last 50 races | Races | Average | WPM · Window 50 · Target 100 |
| 50 races at 80+ WPM and 95%+ accuracy | Races | Gain | WPM ≥ 80, Acc ≥ 95 · Amount 50 |
| Improve your WPM by 500 across your quotes | Races | Improvement | WPM · Target 500 |
| Type 50'000 characters per week | Chars | Gain | Weekly · Amount 50'000 |

## Installation

**From the stores:**

- **Chrome** — [Chrome Web Store](https://chromewebstore.google.com/detail/typegg-goal-tracker/bemdlbiilfkdbaoiepjbknhinpkiicaa?hl=en)
- **Edge** — [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/typegg-goal-tracker/ijeddnikoigpmleiadnkahkfflggjjhl)
- **Firefox** — [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/ADDON_SLUG/)

> Chrome, Edge, and Firefox are three separate stores with separate URLs — replace the placeholders above with your real listing links once published.

**Load it unpacked (for development):**

1. Download or clone this repository.
2. **Chrome / Edge:** open `chrome://extensions` (or `edge://extensions`), enable *Developer mode*, click *Load unpacked*, and select the extension folder.
3. **Firefox:** open `about:debugging` → *This Firefox* → *Load Temporary Add-on…*, and select the `manifest.json` file.

## Notes

- Goals are stored in `localStorage` and stay in sync across multiple open tabs.
- You need a TypeGG account for the extension to work properly.
- **Privacy:** the extension uses your existing TypeGG login session to read your own account data from TypeGG's API (the same data the site already shows you) and stores your goals locally in your browser. No data is ever sent to the developer or any third party.

## Disclaimer

This is an unofficial community-made browser extension for "TypeGG" (typegg.io), a brand and platform operated by TYPEGG LTD. This extension is not affiliated with, endorsed by, sponsored by, or officially associated with "TypeGG" or TYPEGG LTD.
