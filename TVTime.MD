# TV Time App — Developer Notes

## Overview

Single-file vanilla JavaScript PWA for tracking TV show episodes. No frameworks, no build tools, no npm dependencies. Runs directly from the filesystem (`index.html`).

- **API**: TMDB v3 (The Movie Database) for all show/episode/artwork/cast data
- **AI**: DeepSeek API (OpenAI-compatible, `api.deepseek.com/v1/chat/completions`) for "Extra Info" show research — misnamed `anthropic.js`
- **Storage**: `localStorage` with `tvtime_` prefix, TTL-based caching via `store.js`
- **Offline**: Service Worker (`sw.js`) with network-first strategy for app shell files only (not API responses)

## File Map

| File | Role |
|------|------|
| `index.html` | App shell, all CSS (in `<style>`), navigation markup, modals |
| `js/store.js` | Generic localStorage cache with TTL (`Store.get/set/remove/clearAll`) |
| `js/shows-data.js` | `FOLLOWED_SHOWS` array (102 show names), `TVTIME_DATA_VERSION` |
| `js/tmdb.js` | TMDB API client — `getShow`, `getShowDetail`, `getSeason`, `getEpisode`, `searchShow`, `searchTv`, `getTrending`, `getPopular`, `imageUrl`. Concurrency limit: 4, 15s timeout, retry on 429 |
| `js/app.js` | All app logic — IIFE scope. State, init, tab switching, rendering, modals |
| `js/anthropic.js` | DeepSeek API client — `askAboutShow()` for AI analysis |
| `data/shows.json` | Alternative show data (64 entries with TMDB IDs) |
| `gdpr-data/` | Raw TV Time GDPR export CSVs (not imported by the app) |

## Architecture

### Script Load Order (all global, no modules)
```
store.js → shows-data.js → tmdb.js → anthropic.js → app.js
```

### Core State (app.js IIFE scope)
```js
var shows = [];              // [{name: "Silo"}, ...] — combined built-in + user-added
var tmdbIndex = {};          // {showName: {tmdbId, posterPath, ...}} — cached TMDB lookups
var upcoming = [];           // enriched episode objects (7 days ago to ~12 months ahead)
var watchedEpisodes = {};    // {showId: {seasonNum: Set of episodeNums}} — persistent watch tracking
var userShows = [];          // user-added shows from Explore tab
var followedTmdbIds = Set(); // string TMDB IDs that are followed
var currentFilter = 'all';   // 'all' | 'week' | 'today'
var currentTab = 'upcoming'; // 'upcoming' | 'explore' | 'shows' | 'watched'
```

### localStorage Keys (all prefixed `tvtime_`)
| Key | TTL | Content |
|-----|-----|---------|
| `tvtime_tmdb_index` | 24h | `{data: {showName: {...}}, expires: timestamp}` |
| `tvtime_upcoming_episodes` | 6h (configurable) | `{data: [enriched episodes], expires: timestamp}` |
| `tvtime_user_shows` | permanent | `[{name, tmdbId, posterPath, ...}]` |
| `tvtime_watched_episodes` | permanent | `{showId: {seasonNum: [episodeNum, ...]}}` |
| `tvtime_data_version` | permanent | version number for cache-busting |

### Two-Phase Episode Loading
1. **Phase 1** (fast, batches of 8): Fetch show metadata for ALL matched shows to classify as active/dormant/failed
2. **Phase 2** (targeted, batches of 4): Deep-fetch current season episodes only for active shows
3. Dormant shows (ended/canceled) only contribute `next_episode_to_air`/`last_episode_to_air`

### Enriched Episode Object
```js
{
    showId, showName, showPoster, showBackdrop, networks,
    season_number, episode_number, name, overview, air_date,
    still_path, vote_average, runtime, airDate (Date),
    tmdbShowId, tmdbEpisodeId
}
```

### Version Busting
When `TVTIME_DATA_VERSION` changes in `shows-data.js`, all `tvtime_*` keys are cleared, but **user-added shows AND watched episodes are preserved** through the wipe.

### Cache Clearing
`clearCache()` also preserves user-added shows and watched episodes — these are user data, not cache.

## Watched Episode Tracking (added 2026-07-13)

### Data Model
```json
{
  "<tmdbShowId>": {
    "<seasonNum>": [<episodeNum>, ...]
  }
}
```
Stored as `tvtime_watched_episodes`. In memory, arrays are converted to JavaScript `Set` objects for fast membership checks.

### Key Functions
- `loadWatchedEpisodes()` / `saveWatchedEpisodes()` — localStorage persistence with Set↔Array conversion
- `isEpisodeWatched(showId, season, episode)` — boolean lookup
- `toggleEpisodeWatched(showId, season, episode)` — toggles state, saves, returns new state
- `getWatchedCount(showId)` — returns number of watched episodes for a show
- `getTotalEpisodesForShow(showId, seasonsList)` — sums `episode_count` from TMDB seasons array
- `buildWatchedKeySet()` — flat lookup `{"showId_S1_E5": true}` for matching against the upcoming list
- `updateWatchedProgress()` — live-updates the progress bar in the show detail modal

### UI Integration
- **Show detail episode list**: Toggle button (○/✓) on the right of each episode row. Clicking it doesn't open the episode detail (separate event handler with `stopPropagation`).
- **Show detail hero**: "📺 X of Y episodes watched" with a green progress bar (only shown when `totalEps > 0`).
- **Watched tab**: Two sections — "✓ Watched" (episodes from `upcoming` that are in the watched set) and "📅 Recently Aired" (unwatched episodes from past 90 days). Each has toggle buttons.
- **My Shows cards**: Shows "✓ N watched" text below the show name when `watchedCount > 0`.

### State Tracking
- `currentShowDetailId` and `currentShowSeasons` are set when a show detail modal opens, cleared when it closes (close button, backdrop click, Escape key).
- `updateWatchedProgress()` reads these to update the progress bar — guards against null when no modal is open.

## Navigation & Tabs
| Tab | ID | Content |
|-----|----|---------|
| Upcoming | `upcomingTab` | Timeline grouped by date with filter (All/This Week/Today) |
| Explore | `exploreTab` | Trending/Popular shows with search, pagination, Add/Following buttons |
| My Shows | `showsTab` | Grid of followed shows with poster, name, year, watched count |
| Watched | `watchedTab` | Actually-watched episodes + recently aired unwatched |

## Modals
- **Show Detail**: Backdrop hero with overlapping poster, metadata, overview, watched progress, season pills, episode list with toggles, cast, watch providers, trailer/extra-info buttons
- **Episode Detail**: Backdrop, still image, show link, metadata grid, cast, guest stars, watch providers
- **Settings**: TMDB API key, DeepSeek API key, cache duration selector, save/clear buttons

## Responsive Design
- Mobile-first, breakpoints at 500px and 600px
- iPhone safe-area support (`env(safe-area-inset-*)`)
- Dark mode only, GitHub-inspired palette (`#0d1117` background, `#58a6ff` accent, `#3fb950` green)

## CSS
All styles are in `index.html` `<style>` block (not in `css/style.css` — that file exists but is not loaded; the HTML has an embedded copy). When adding styles, edit `index.html`, not `css/style.css`.

## Gotchas
- `Date.now()` is not available in workflow scripts — but the app itself uses `Date.now()` freely
- TMDB image URLs use `imageUrl(path, size)` helper — paths from API are bare, sizes are like `/w185`, `/w342`, `/w780`
- The `upcoming` array is deduplicated by `tmdbShowId_S{season}_E{episode}` key
- The `enrich()` function creates episode objects used throughout the app
- Service Worker is registered but only caches app shell files (HTML, CSS, JS, manifest, icons) — TMDB API responses are NOT cached by SW (they use localStorage instead)
- The watched toggle buttons use `e.stopPropagation()` to prevent triggering the episode detail modal
- `fmtSE(s, e)` formats season/episode as `S01 | E05` — used in both upcoming timeline and watched tab
