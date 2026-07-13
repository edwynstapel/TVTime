# TV Time — Upcoming Episodes Tracker

A web app that mimics the [TV Time](https://www.tvtime.com) experience, built from your GDPR data export. Track upcoming episodes for all 62 shows you follow.

## Screenshots

The UI matches these TV Time app screens:
- **`IMG_0623.PNG`** — Upcoming episodes timeline (dark mode, grouped by date, show artwork, countdown badges)
- **`IMG_0624.PNG`** — Episode detail view (backdrop, still, cast, watch providers, synopsis)

## Features

- **📅 Upcoming Timeline** — Episodes grouped by date with countdown badges, show posters, and network logos
- **📚 My Shows** — Grid view of all 62 followed shows with TMDB artwork
- **✅ Recently Aired** — Episodes from the last 30 days
- **🔍 Episode Detail** — Full modal with backdrop, still image, cast, overview, ratings, and where-to-watch
- **⚙️ Settings** — TMDB API key management and cache control
- **🌙 Dark Mode** — Matches the TV Time app aesthetic
- **💾 Offline Caching** — All API responses cached in localStorage to minimize TMDB calls

## Getting Started

### 1. Get a TMDB API Key (Free)

1. Go to [themoviedb.org/signup](https://www.themoviedb.org/signup) and create a free account
2. Go to [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)
3. Click "API Key (v3 auth)" and copy your key

### 2. Open the App

**Option A: Open directly** — Double-click `index.html` in your file explorer. Works in Chrome, Edge, and Firefox without any server.

**Option B: Local server** (if you prefer):
```bash
# Python 3
python -m http.server 8000

# Or with npx
npx serve .
```
Then open http://localhost:8000

### 3. Enter Your API Key

On first launch, click **⚙️ Settings** (top-right gear icon), paste your TMDB API key, and click **Save**. The app will identify your shows and fetch upcoming episodes.

## Project Structure

```
TVTime/
├── index.html              # Main app (open this)
├── css/
│   └── style.css           # Dark mode styles
├── js/
│   ├── app.js              # Main application logic
│   ├── tmdb.js             # TMDB API client
│   ├── store.js            # localStorage cache
│   └── shows-data.js       # Embedded show list (offline fallback)
├── data/
│   └── shows.json          # Followed shows (JSON)
├── gdpr-data/              # TV Time GDPR export (CSV files)
├── IMG_0623.PNG            # Reference: Upcoming tab
└── IMG_0624.PNG            # Reference: Episode detail
```

## Data Source

The 62 followed shows were extracted from your TV Time GDPR data export (`gdpr-data.zip` → `followed_tv_show.csv`). The CSV files also contain your watch history, ratings, comments, and emotions — these can be integrated in future iterations.

## APIs Used

- **[TMDB v3](https://developer.themoviedb.org/docs/getting-started)** — Show search, episode listings, artwork, cast, watch providers (free, rate-limited to ~50 req/sec)

## Future Roadmap

- [ ] PWA support for mobile installation
- [ ] Push notifications for upcoming episodes
- [ ] Mark episodes as watched
- [ ] Rating and emoji reactions
- [ ] Import watch history from GDPR CSV data
- [ ] Native iOS app via React Native / SwiftUI

## Privacy

Your TMDB API key is stored locally in your browser's localStorage. No data is sent anywhere except to the TMDB API.
