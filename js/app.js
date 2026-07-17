/**
 * TV Time — Upcoming Episodes Tracker
 * Simplified data pipeline with visible progress logging.
 */

(function() {
'use strict';

// ─── State ────────────────────────────────────────────────────
var shows = [];                  // [{name: "Silo"}, ...]
var tmdbIndex = {};              // {"Silo": {tmdbId, posterPath, ...}}
var upcoming = [];               // enriched episode objects
var currentFilter = 'all';
var currentTab = 'upcoming';
var userShows = [];              // user-added shows: [{name, tmdbId, posterPath, ...}]
var followedTmdbIds = new Set(); // Set of followed TMDB IDs (strings)
var explorePage = 1;
var exploreMode = 'trending';
var exploreCache = {};           // {trending: {1: [shows]}, popular: {1: [shows]}}
var watchedEpisodes = {};        // {showId: {seasonNum: Set of episodeNums}}
var watchedShowNames = {};       // {tmdbShowId: showName} — loaded from GDPR import
var currentShowDetailId = null;  // TMDB show ID currently open in show detail modal
var currentShowSeasons = null;   // seasons data for currently open show (for total episode count)

// ─── Helpers ──────────────────────────────────────────────────
function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}

function log(msg) {
    console.log('[TVTime]', msg);
    var el = document.getElementById('statusText');
    if (el) el.textContent = msg;
}

// ─── Init ─────────────────────────────────────────────────────
function init() {
    // ── Data version check: clear stale caches when shows-data updates ──
    var DATA_VER = window.TVTIME_DATA_VERSION || 0;
    var storedVer = 0;
    try { storedVer = parseInt(localStorage.getItem('tvtime_data_version')) || 0; } catch(e) {}
    console.log('[TVTime] Data version: current=' + DATA_VER + ', stored=' + storedVer +
        ', followed shows=' + (window.FOLLOWED_SHOWS ? window.FOLLOWED_SHOWS.length : 0));

    if (DATA_VER !== storedVer) {
        console.log('[TVTime] Data version changed (' + storedVer + ' → ' + DATA_VER + '). Clearing stale caches.');
        // Save user-added shows AND watched episodes before clearing
        var savedUserShows = null;
        var savedWatchedEps = null;
        try { savedUserShows = localStorage.getItem('tvtime_user_shows'); } catch(e) {}
        try { savedWatchedEps = localStorage.getItem('tvtime_watched_episodes'); } catch(e) {}
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('tvtime_') === 0) keys.push(k);
        }
        keys.forEach(function(k) { localStorage.removeItem(k); });
        // Restore user-added shows
        if (savedUserShows) {
            try { localStorage.setItem('tvtime_user_shows', savedUserShows); } catch(e) {}
        }
        // Restore watched episodes
        if (savedWatchedEps) {
            try { localStorage.setItem('tvtime_watched_episodes', savedWatchedEps); } catch(e) {}
        }
        try { localStorage.setItem('tvtime_data_version', String(DATA_VER)); } catch(e) {}
    }

    // Load show list (built-in + user-added)
    try {
        shows = (window.FOLLOWED_SHOWS || []).map(function(n) { return {name: n}; });
    } catch(e) {
        shows = [];
    }

    console.log('[TVTime] followed shows count: ' + shows.length);
    try {
        var rawUser = localStorage.getItem('tvtime_user_shows');
        if (rawUser) {
            userShows = JSON.parse(rawUser);
            // Merge user shows into shows array and ID set
            userShows.forEach(function(us) {
                if (!shows.some(function(s) { return s.name === us.name; })) {
                    shows.push({name: us.name});
                }
                if (us.tmdbId) followedTmdbIds.add(String(us.tmdbId));
                // Pre-populate tmdbIndex
                if (!tmdbIndex[us.name]) {
                    tmdbIndex[us.name] = {
                        tmdbId: us.tmdbId,
                        name: us.name,
                        posterPath: us.posterPath,
                        backdropPath: us.backdropPath,
                        firstAirDate: us.firstAirDate,
                        overview: us.overview,
                        voteAverage: us.voteAverage
                    };
                }
            });
        }
    } catch(e) {}

    // Restore cached TMDB index
    try {
        var raw = localStorage.getItem('tvtime_tmdb_index');
        if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.data) tmdbIndex = parsed.data;
        }
    } catch(e) {}

    // Restore cached upcoming episodes
    try {
        var raw2 = localStorage.getItem('tvtime_upcoming_episodes');
        if (raw2) {
            var parsed2 = JSON.parse(raw2);
            if (parsed2 && parsed2.data && parsed2.data.length > 0) {
                upcoming = parsed2.data.map(function(ep) {
                    ep.airDate = ep.airDate ? new Date(ep.airDate) : null;
                    return ep;
                });
            }
        }
    } catch(e) {}

    // Load watched episodes
    loadWatchedEpisodes();

    // Listen for localStorage changes from other tabs (e.g. GDPR import)
    window.addEventListener('storage', function(e) {
        if (e.key === 'tvtime_watched_episodes' || e.key === 'tvtime_watched_show_names') {
            console.log('[TVTime] Detected watched data change from another tab, reloading...');
            loadWatchedEpisodes();
            // Re-render current tab to reflect changes
            if (currentTab === 'shows') renderShows();
            if (currentTab === 'watched') renderWatched();
            // Update show detail progress if open
            updateWatchedProgress();
        }
    });

    document.getElementById('showCount').textContent = shows.length + ' shows';

    // Bind nav
    document.querySelectorAll('.nav-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            switchTab(currentTab);
        });
    });

    // Bind filter buttons (upcoming)
    document.querySelectorAll('#upcomingTab .filter-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#upcomingTab .filter-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderTimeline();
        });
    });

    // Bind explore filter buttons
    document.querySelectorAll('#exploreFilterGroup .filter-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#exploreFilterGroup .filter-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            exploreMode = btn.dataset.explore;
            explorePage = 1;
            exploreCache = {};
            exploreSearchQuery = '';
            document.getElementById('exploreSearch').value = '';
            var countEl = document.getElementById('exploreResultCount');
            if (countEl) countEl.textContent = '';
            renderExplore();
        });
    });

    // Load more button
    document.getElementById('loadMoreBtn').addEventListener('click', function() {
        explorePage++;
        if (exploreSearchQuery) {
            renderExploreSearch(exploreSearchQuery, true);
        } else {
            renderExplore(true);
        }
    });

    // Explore search — debounced
    var exploreSearchTimeout;
    document.getElementById('exploreSearch').addEventListener('input', function() {
        clearTimeout(exploreSearchTimeout);
        var query = this.value.trim();
        exploreSearchTimeout = setTimeout(function() {
            if (query.length > 0) {
                renderExploreSearch(query);
            } else {
                // Return to trending/popular
                explorePage = 1;
                exploreCache = {};
                renderExplore();
            }
        }, 400);
    });

    // Bind settings
    document.getElementById('settingsBtn').addEventListener('click', function() {
        document.getElementById('apiKey').value = TMDB.getKey();
        document.getElementById('anthropicKey').value = Anthropic.getKey();
        document.getElementById('settingsModal').classList.add('active');
    });
    document.getElementById('settingsClose').addEventListener('click', function() {
        document.getElementById('settingsModal').classList.remove('active');
    });
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    document.getElementById('clearCache').addEventListener('click', clearCache);
    document.getElementById('refreshBtn').addEventListener('click', function() {
        localStorage.removeItem('tvtime_upcoming_episodes');
        upcoming = [];
        loadUpcoming(true);
    });

    // Bind modals
    document.getElementById('modalClose').addEventListener('click', function() {
        document.getElementById('episodeModal').classList.remove('active');
    });
    document.getElementById('showDetailClose').addEventListener('click', function() {
        document.getElementById('showDetailModal').classList.remove('active');
        currentShowDetailId = null;
        currentShowSeasons = null;
    });
    document.querySelectorAll('.modal-backdrop').forEach(function(bd) {
        bd.addEventListener('click', function() {
            document.querySelectorAll('.modal.active').forEach(function(m) { m.classList.remove('active'); });
            currentShowDetailId = null;
            currentShowSeasons = null;
        });
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(function(m) { m.classList.remove('active'); });
        }
    });

    // Check API key
    var key = TMDB.getKey();
    if (!key) {
        showWelcome();
    } else {
        switchTab('upcoming');
    }
}

// ─── Navigation ──────────────────────────────────────────────
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
    var el = document.getElementById(tab + 'Tab');
    if (el) el.classList.add('active');

    // Reload watched data in case it was updated externally (e.g. GDPR import in another tab)
    if (tab === 'watched' || tab === 'shows') {
        loadWatchedEpisodes();
    }

    if (tab === 'upcoming') loadUpcoming(false);
    if (tab === 'explore') renderExplore();
    if (tab === 'shows') renderShows();
    if (tab === 'watched') renderWatched();
}

// ─── Settings ────────────────────────────────────────────────
function saveSettings() {
    var key = document.getElementById('apiKey').value.trim();
    TMDB.setKey(key);
    var anthropicKey = document.getElementById('anthropicKey').value.trim();
    Anthropic.setKey(anthropicKey);
    document.getElementById('settingsModal').classList.remove('active');
    // Clear everything and restart
    tmdbIndex = {};
    upcoming = [];
    localStorage.removeItem('tvtime_tmdb_index');
    localStorage.removeItem('tvtime_upcoming_episodes');
    switchTab('upcoming');
}

function clearCache() {
    // Preserve user data: watched episodes and user-added shows
    var savedUserShows = null;
    var savedWatchedEps = null;
    try { savedUserShows = localStorage.getItem('tvtime_user_shows'); } catch(e) {}
    try { savedWatchedEps = localStorage.getItem('tvtime_watched_episodes'); } catch(e) {}

    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('tvtime_') === 0) keys.push(k);
    }
    keys.forEach(function(k) { localStorage.removeItem(k); });

    // Restore user data
    if (savedUserShows) {
        try { localStorage.setItem('tvtime_user_shows', savedUserShows); } catch(e) {}
    }
    if (savedWatchedEps) {
        try { localStorage.setItem('tvtime_watched_episodes', savedWatchedEps); } catch(e) {}
    }

    tmdbIndex = {};
    upcoming = [];
    document.getElementById('settingsModal').classList.remove('active');
    switchTab('upcoming');
}

// ─── Welcome Screen ──────────────────────────────────────────
function showWelcome() {
    var c = document.getElementById('timelineContainer');
    c.innerHTML =
        '<div class="empty-state">' +
            '<div class="empty-icon">📺</div>' +
            '<h3>Welcome to TV Time</h3>' +
            '<p style="margin-bottom:16px;">Track upcoming episodes for ' + shows.length + ' shows you follow.</p>' +
            '<p style="margin-bottom:24px;font-size:14px;color:var(--text-muted);">' +
                'To get started, add your TMDB API key in Settings.</p>' +
            '<button class="btn-primary" onclick="document.getElementById(\'settingsBtn\').click()" style="margin-bottom:12px;">' +
                '⚙️ Add TMDB API Key</button>' +
            '<p style="font-size:12px;color:var(--text-muted);">' +
                'Get a free key at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org</a></p>' +
        '</div>';
    renderShows();
}

// ─── Load Upcoming Episodes (two-phase optimization) ────────
//
//  Phase 1 (fast): Fetch show metadata for ALL matched shows in parallel.
//                  Only ~1 API call per show. We get in_production, status,
//                  next_episode_to_air, last_episode_to_air — enough to
//                  decide which shows are actually active.
//
//  Phase 2 (targeted): Deep-fetch the current season's episodes ONLY for
//                       the handful of shows that are actively airing.
//                       Ended/canceled shows skip this entirely.
//
//  Result: ~70 API calls instead of ~124 for 62 shows. The expensive
//          getSeason() calls only hit the 5-15 shows that matter.

async function loadUpcoming(force) {
    var c = document.getElementById('timelineContainer');
    var key = TMDB.getKey();

    if (!key) { showWelcome(); return; }
    if (!force && upcoming.length > 0) { renderTimeline(); return; }

    c.innerHTML =
        '<div class="loading-spinner">' +
            '<div class="spinner"></div>' +
            '<p id="statusText">Starting...</p>' +
            '<p style="font-size:12px;color:var(--text-muted);margin-top:8px;" id="statusDetail"></p>' +
        '</div>';

    var statusEl = function() { return document.getElementById('statusText'); };
    var detailEl = function() { return document.getElementById('statusDetail'); };
    function status(msg) { log(msg); var e = statusEl(); if (e) e.textContent = msg; }
    function detail(msg) { var e = detailEl(); if (e) e.textContent = msg; }

    try {
        // ── Step 1: Build TMDB index for uncached shows ──────────
        var uncached = shows.filter(function(s) { return !tmdbIndex[s.name]; });

        if (uncached.length > 0) {
            status('Identifying ' + uncached.length + ' shows on TMDB...');
            for (var i = 0; i < uncached.length; i += 4) {
                var batch = uncached.slice(i, Math.min(i + 4, uncached.length));
                await Promise.allSettled(batch.map(function(s) {
                    return TMDB.searchShow(s.name).then(function(r) {
                        if (r) {
                            tmdbIndex[s.name] = { tmdbId: r.id, name: r.name,
                                posterPath: r.poster_path, backdropPath: r.backdrop_path,
                                firstAirDate: r.first_air_date, overview: r.overview,
                                voteAverage: r.vote_average };
                        } else { tmdbIndex[s.name] = null; }
                    }).catch(function(e) {
                        console.warn('Search failed: ' + s.name, e.message);
                        tmdbIndex[s.name] = null;
                    });
                }));
                detail('Matched ' + Math.min(i + 4, uncached.length) + '/' + uncached.length);
            }
            try { localStorage.setItem('tvtime_tmdb_index',
                JSON.stringify({data: tmdbIndex, expires: Date.now() + 24*60*60*1000}));
            } catch(e) {}
        }

        var matched = shows.filter(function(s) {
            var m = tmdbIndex[s.name]; return m && m.tmdbId;
        });

        if (matched.length === 0) {
            c.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div>' +
                '<h3>No shows matched on TMDB</h3><p>Check your API key or try again.</p></div>';
            return;
        }

        // ── Step 2: PHASE 1 — Quick liveness check on ALL shows ──
        // Fetch show metadata for every matched show (batches of 8).
        // This gives us: in_production, status, next_episode_to_air,
        // last_episode_to_air, seasons[], number_of_seasons.
        status('Phase 1/2: Checking which of ' + matched.length + ' shows are active...');

        var activeShows   = [];  // {name, tmdbId, show}
        var dormantShows  = [];  // shows that ended — we'll only check next/last episode
        var failedShows   = [];  // shows where getShow() API call failed
        var now = new Date(); now.setHours(0, 0, 0, 0);
        var ninetyDaysAgo = new Date(now); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        for (var j = 0; j < matched.length; j += 8) {
            var showBatch = matched.slice(j, Math.min(j + 8, matched.length));
            var results = await Promise.allSettled(showBatch.map(function(s) {
                return TMDB.getShow(tmdbIndex[s.name].tmdbId);
            }));

            results.forEach(function(r, idx) {
                var name = showBatch[idx].name;
                if (r.status !== 'fulfilled' || !r.value) {
                    failedShows.push(name);
                    console.warn('Phase 1 FAILED for', name,
                        r.status === 'rejected' ? r.reason && r.reason.message : 'empty response');
                    return;
                }
                var show = r.value;

                // Classify: is this show still active?
                var inProduction = show.in_production === true;
                var returning    = show.status === 'Returning Series';
                var hasNext      = show.next_episode_to_air && show.next_episode_to_air.air_date;
                var recentLast   = show.last_episode_to_air && show.last_episode_to_air.air_date &&
                                   new Date(show.last_episode_to_air.air_date + 'T00:00:00') >= ninetyDaysAgo;

                // DEBUG: log first few shows regardless of classification
                if (activeShows.length + dormantShows.length < 3) {
                    console.log('Show:', name,
                        'in_production:', show.in_production,
                        'status:', show.status,
                        'hasNext:', hasNext,
                        'recentLast:', recentLast,
                        'next:', show.next_episode_to_air && show.next_episode_to_air.air_date,
                        'last:', show.last_episode_to_air && show.last_episode_to_air.air_date);
                }

                if (inProduction || returning || hasNext || recentLast) {
                    activeShows.push({name: name, tmdbId: show.id, show: show});
                } else {
                    dormantShows.push({name: name, tmdbId: show.id, show: show});
                }
            });

            status('Phase 1/2: Scanned ' + Math.min(j + 8, matched.length) + '/' + matched.length +
                   ' shows • ' + activeShows.length + ' active, ' + dormantShows.length + ' ended' +
                   (failedShows.length > 0 ? ', ' + failedShows.length + ' FAILED' : ''));
            detail(activeShows.map(function(s) { return s.name; }).slice(0, 5).join(', ') +
                   (activeShows.length > 5 ? ' +' + (activeShows.length - 5) + ' more' : '') +
                   (failedShows.length > 0 ? ' | FAILED: ' + failedShows.slice(0,3).join(', ') : ''));
        }

        console.log('Phase 1 complete:',
            activeShows.length, 'active,',
            dormantShows.length, 'dormant,',
            failedShows.length, 'failed');

        // ── Step 3: PHASE 2 — Deep-fetch only active shows ──────
        status('Phase 2/2: Fetching episodes for ' + activeShows.length + ' active shows...');
        detail('Skipping ' + dormantShows.length + ' ended shows');

        var allEps = [];
        var sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Helper: build an episode object from raw TMDB episode + show data
        function enrich(ep, show) {
            return {
                showId: show.id, showName: show.name,
                showPoster: TMDB.imageUrl(show.poster_path, '/w185'),
                showBackdrop: TMDB.imageUrl(show.backdrop_path, '/w780'),
                networks: (show.networks || []).map(function(n) {
                    return { name: n.name, logo: TMDB.imageUrl(n.logo_path, '/w92') };
                }),
                season_number: ep.season_number, episode_number: ep.episode_number,
                name: ep.name || '', overview: ep.overview || '',
                air_date: ep.air_date || '', still_path: ep.still_path || '',
                vote_average: ep.vote_average || 0, runtime: ep.runtime || 0,
                airDate: ep.air_date ? new Date(ep.air_date + 'T00:00:00') : null,
                tmdbShowId: show.id, tmdbEpisodeId: ep.id
            };
        }

        // Process active shows: fetch current season for full episode list
        for (var k = 0; k < activeShows.length; k += 4) {
            var activeBatch = activeShows.slice(k, Math.min(k + 4, activeShows.length));
            var epResults = await Promise.allSettled(activeBatch.map(function(item) {
                return fetchSeasonEpisodes(item.show, item.tmdbId, sevenDaysAgo, enrich);
            }));

            epResults.forEach(function(r) {
                if (r.status === 'fulfilled' && r.value) {
                    allEps.push.apply(allEps, r.value);
                }
            });

            status('Phase 2/2: Processed ' + Math.min(k + 4, activeShows.length) + '/' +
                   activeShows.length + ' active shows');
            detail('Total episodes found: ' + allEps.length);
        }

        // Process dormant shows: just check next_episode_to_air and last_episode_to_air
        // (no extra API calls — data already in the show object from Phase 1)
        dormantShows.forEach(function(item) {
            var show = item.show;
            var next = show.next_episode_to_air;
            var last = show.last_episode_to_air;

            if (next && next.air_date) {
                var nd = new Date(next.air_date + 'T00:00:00');
                if (nd >= sevenDaysAgo) allEps.push(enrich(next, show));
            }
            if (last && last.air_date) {
                var ld = new Date(last.air_date + 'T00:00:00');
                if (ld >= sevenDaysAgo) {
                    var dup = allEps.some(function(e) {
                        return e.tmdbShowId === show.id &&
                               e.season_number === last.season_number &&
                               e.episode_number === last.episode_number;
                    });
                    if (!dup) allEps.push(enrich(last, show));
                }
            }
        });

        // Sort, deduplicate, cache
        allEps.sort(function(a, b) {
            return (a.airDate ? a.airDate.getTime() : 0) - (b.airDate ? b.airDate.getTime() : 0);
        });

        var seen = {};
        upcoming = allEps.filter(function(ep) {
            if (!ep.airDate) return false;
            var key = ep.tmdbShowId + '_S' + ep.season_number + '_E' + ep.episode_number;
            if (seen[key]) return false; seen[key] = true; return true;
        });

        try { localStorage.setItem('tvtime_upcoming_episodes',
            JSON.stringify({data: upcoming, expires: Date.now() + 6*60*60*1000}));
        } catch(e) {}

        status('Done! ' + upcoming.length + ' upcoming episodes from ' +
               activeShows.length + ' active + ' + dormantShows.length + ' ended shows');
        detail(activeShows.length + ' shows actively airing • ' +
               dormantShows.length + ' shows ended • ' +
               (shows.length - matched.length) + ' not found on TMDB');

        renderTimeline();

    } catch(e) {
        console.error('FATAL:', e);
        c.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div>' +
            '<h3>Error</h3><p>' + esc(e.message) + '</p>' +
            '<button class="btn-primary" style="margin-top:12px;" onclick="location.reload()">Reload App</button></div>';
    }
}

/**
 * Fetch all episodes for the current/latest season of an active show.
 * Also checks specials (season 0) when relevant.
 */
async function fetchSeasonEpisodes(show, tmdbId, sevenDaysAgo, enrich) {
    var eps = [];
    var latestSeason = show.number_of_seasons;
    var seasonInfo = (show.seasons || []).find(function(s) {
        return s.season_number === latestSeason;
    });

    if (seasonInfo && seasonInfo.air_date) {
        var seasonDate = new Date(seasonInfo.air_date + 'T00:00:00');
        var oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        if (seasonDate >= oneYearAgo) {
            try {
                var seasonEps = await TMDB.getSeason(tmdbId, latestSeason);
                seasonEps.forEach(function(ep) {
                    if (!ep.air_date) return;
                    var d = new Date(ep.air_date + 'T00:00:00');
                    if (d >= sevenDaysAgo) eps.push(enrich(ep, show));
                });
            } catch(e) {
                console.warn('Season fetch failed for ' + show.name + ' S' + latestSeason, e.message);
            }
        }
    }

    // If no season episodes found, fall back to next/last from show object
    if (eps.length === 0) {
        var next = show.next_episode_to_air;
        var last = show.last_episode_to_air;
        if (next && next.air_date) {
            var nd = new Date(next.air_date + 'T00:00:00');
            if (nd >= sevenDaysAgo) eps.push(enrich(next, show));
        }
        if (last && last.air_date) {
            var ld = new Date(last.air_date + 'T00:00:00');
            if (ld >= sevenDaysAgo) {
                var dup = eps.some(function(e) {
                    return e.season_number === last.season_number && e.episode_number === last.episode_number;
                });
                if (!dup) eps.push(enrich(last, show));
            }
        }
    }

    // Check specials (season 0) if they exist
    var hasSpecials = (show.seasons || []).some(function(s) { return s.season_number === 0; });
    if (hasSpecials) {
        try {
            var specialEps = await TMDB.getSeason(tmdbId, 0);
            specialEps.forEach(function(ep) {
                if (!ep.air_date) return;
                var d = new Date(ep.air_date + 'T00:00:00');
                if (d >= sevenDaysAgo) eps.push(enrich(ep, show));
            });
        } catch(e) { /* ignore specials failures */ }
    }

    return eps;
}

// ─── Render Timeline ─────────────────────────────────────────
function renderTimeline() {
    var c = document.getElementById('timelineContainer');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);

    // Apply filter
    var filtered = upcoming.slice();
    if (currentFilter === 'today') {
        filtered = filtered.filter(function(ep) {
            if (!ep.airDate) return false;
            return ep.airDate.getFullYear() === now.getFullYear() &&
                   ep.airDate.getMonth() === now.getMonth() &&
                   ep.airDate.getDate() === now.getDate();
        });
    } else if (currentFilter === 'week') {
        filtered = filtered.filter(function(ep) {
            return ep.airDate && ep.airDate >= now && ep.airDate < weekEnd;
        });
    }

    // Empty state
    if (filtered.length === 0) {
        var msg, hint = '';
        if (upcoming.length === 0) {
            msg = 'No upcoming episodes found across any of your shows.';
            hint = '<br><br><b>Debug info:</b> Check the status messages above — ' +
                   'did Phase 1 find active shows? Did any fail?<br>' +
                   'Open DevTools (F12) → Console to see detailed logs.<br>' +
                   'Also try: <a href="#" onclick="localStorage.removeItem(\'tvtime_tmdb_index\');' +
                   'localStorage.removeItem(\'tvtime_upcoming_episodes\');location.reload();return false;">' +
                   'Clear cache & reload</a>';
        } else if (currentFilter === 'today') {
            msg = 'No episodes airing today.';
        } else if (currentFilter === 'week') {
            msg = 'No episodes airing this week.';
        } else {
            msg = 'No episodes match the current filter.';
        }
        c.innerHTML =
            '<div class="empty-state">' +
                '<div class="empty-icon">🎬</div>' +
                '<h3>No episodes to show</h3>' +
                '<p>' + msg + '</p>' +
                hint +
                (upcoming.length > 0 ?
                '<p style="margin-top:8px;font-size:13px;color:var(--text-muted);">' +
                    upcoming.length + ' total episodes loaded. ' +
                    (currentFilter !== 'all' ? '<a href="#" onclick="currentFilter=\'all\';document.querySelectorAll(\'.filter-btn\').forEach(function(b){b.classList.remove(\'active\')});document.querySelector(\'[data-filter=all]\').classList.add(\'active\');renderTimeline();return false;">Show all</a>' : '') +
                '</p>' : '') +
            '</div>';
        return;
    }

    // Group by date
    var groups = {};
    filtered.forEach(function(ep) {
        if (!ep.airDate) return;
        var key = ep.airDate.toISOString().split('T')[0];
        if (!groups[key]) groups[key] = [];
        groups[key].push(ep);
    });

    var dates = Object.keys(groups).sort();
    if (dates.length > 0) {
        var first = new Date(dates[0] + 'T00:00:00');
        var last = new Date(dates[dates.length - 1] + 'T00:00:00');
        var opts = { month: 'short', day: 'numeric' };
        document.getElementById('dateRangeLabel').textContent =
            first.toLocaleDateString('en-US', opts) + ' – ' +
            last.toLocaleDateString('en-US', opts);
    }

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    var html = '';
    dates.forEach(function(dateKey) {
        var date = new Date(dateKey + 'T00:00:00');
        var isToday = date.getTime() === today.getTime();
        var isTomorrow = date.getTime() === tomorrow.getTime();

        var label;
        if (isToday) label = 'Today';
        else if (isTomorrow) label = 'Tomorrow';
        else {
            var diff = Math.ceil((date - today) / 86400000);
            if (diff < 0) label = Math.abs(diff) + 'd ago';
            else if (diff > 0) label = 'in ' + diff + ' days';
            else label = '';
        }

        var dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        var monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        html += '<div class="date-group"><div class="date-header">' +
            '<span class="date-day">' + dayName + ' <span class="date-month">' + monthDay + '</span></span>' +
            (label ? '<span class="date-relative">' + label + '</span>' : '') +
            '</div>' +
            groups[dateKey].map(renderCard).join('') +
            '</div>';
    });

    c.innerHTML = html;

    // Bind card clicks → episode detail
    c.querySelectorAll('.episode-card').forEach(function(card) {
        card.addEventListener('click', function(e) {
            // Don't fire if the show name link was clicked
            if (e.target.classList.contains('episode-show-name-link')) return;
            showDetail(card.dataset.tmdbShowId,
                parseInt(card.dataset.season),
                parseInt(card.dataset.episode));
        });
    });

    // Bind show name clicks → show detail
    c.querySelectorAll('.episode-show-name-link').forEach(function(link) {
        link.addEventListener('click', function(e) {
            e.stopPropagation();
            openShowDetail(this.dataset.showName);
        });
    });

    // --- Past episode graying + scroll reveal ---
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var cards = c.querySelectorAll('.episode-card');
    var anchorFound = false;

    // Find the first card with airDate >= today (the "next to air" anchor)
    // and mark all cards before it as past
    cards.forEach(function(card) {
        var airDateStr = card.dataset.airDate;
        if (!airDateStr) return;
        var airDate = new Date(airDateStr + 'T00:00:00');
        if (!anchorFound && airDate >= today) {
            anchorFound = true;
        }
        if (!anchorFound) {
            card.classList.add('episode-past');
        }
    });

    // IntersectionObserver: reveal past episodes when scrolled into view.
    // We delay activation by 200ms so the initial paint shows past episodes
    // grayed — otherwise the observer fires immediately for any past episodes
    // already visible in the viewport, defeating the effect.
    if (window._pastEpisodeObserver) window._pastEpisodeObserver.disconnect();
    if (window._pastObserverTimer) clearTimeout(window._pastObserverTimer);
    window._pastObserverReady = false;
    var observer = new IntersectionObserver(function(entries) {
        if (!window._pastObserverReady) return;
        entries.forEach(function(entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('episode-revealed');
                observer.unobserve(entry.target);
            }
        });
    }, { rootMargin: '0px 0px -20px 0px' });

    c.querySelectorAll('.episode-past').forEach(function(card) {
        observer.observe(card);
    });
    window._pastEpisodeObserver = observer;
    window._pastObserverTimer = setTimeout(function() {
        window._pastObserverReady = true;
    }, 200);
}

function renderCard(ep) {
    var posterHtml;
    if (ep.showPoster) {
        posterHtml =
            '<img class="episode-poster" src="' + esc(ep.showPoster) + '" alt="" loading="lazy" ' +
            'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
            '<div class="episode-poster-placeholder" style="display:none">📺</div>';
    } else {
        posterHtml = '<div class="episode-poster-placeholder">📺</div>';
    }

    var networks = '';
    if (ep.networks && ep.networks.length > 0) {
        networks = ep.networks.map(function(n) {
            var logoHtml = n.logo ? '<img src="' + esc(n.logo) + '" alt="" onerror="this.style.display=\'none\';">' : '';
            return '<span class="episode-network">' + logoHtml + esc(n.name) + '</span>';
        }).join('');
    }

    var countdown = '';
    var countdownPill = '';
    if (ep.airDate) {
        var now = new Date();
        now.setHours(0, 0, 0, 0);
        var diff = Math.ceil((ep.airDate.getTime() - now.getTime()) / 86400000);
        if (diff === 0) { countdown = 'Today'; countdownPill = 'Today'; }
        else if (diff === 1) { countdown = 'Tomorrow'; countdownPill = 'Tomorrow'; }
        else if (diff > 1 && diff <= 14) { countdown = 'in ' + diff + ' days'; countdownPill = diff + 'd'; }
        else if (diff < 0 && diff >= -7) { countdown = Math.abs(diff) + 'd ago'; countdownPill = Math.abs(diff) + 'd ago'; }
        else if (diff > 14) { countdown = 'in ' + diff + ' days'; countdownPill = diff + 'd'; }
    }

    var title = ep.overview || ep.name || '';
    var epName = ep.name ? ('<span class="episode-sep">·</span>' + esc(ep.name)) : '';

    return '<div class="episode-card" data-tmdb-show-id="' + ep.tmdbShowId +
        '" data-season="' + ep.season_number + '" data-episode="' + ep.episode_number + '" data-air-date="' + (ep.air_date || '') + '">' +
        posterHtml +
        '<div class="episode-info">' +
            '<div class="episode-header">' +
                '<span class="episode-show-name episode-show-name-link" data-show-name="' + escAttr(ep.showName) + '">' + esc(ep.showName) + '</span>' +
                (countdownPill ? '<span class="episode-countdown-pill">' + countdownPill + '</span>' : '') +
            '</div>' +
            '<div class="episode-meta">' + fmtSE(ep.season_number, ep.episode_number) + epName + '</div>' +
            (title ? '<div class="episode-title">' + esc(title) + '</div>' : '') +
            (networks ? '<div class="episode-footer">' + networks + '</div>' : '') +
        '</div></div>';
}

// ─── Episode Detail Modal ───────────────────────────────────
async function showDetail(showId, season, episode) {
    var modal = document.getElementById('episodeModal');
    var detail = document.getElementById('episodeDetail');
    modal.classList.add('active');
    detail.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading details...</p></div>';

    try {
        var ep = await TMDB.getEpisode(showId, season, episode);
        ep.tmdbShowId = showId;  // Ensure tmdbShowId is set for watched toggle
        renderDetail(ep, detail);
    } catch(e) {
        detail.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div>' +
            '<h3>Failed to load episode</h3><p>' + esc(e.message) + '</p></div>';
    }
}

function renderDetail(ep, container) {
    var airDateStr = ep.airDate
        ? ep.airDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'Unknown';

    var backdropHtml = ep.showBackdrop
        ? '<img class="episode-detail-backdrop" src="' + esc(ep.showBackdrop) + '" alt="" onerror="this.style.display=\'none\';">'
        : '<div class="episode-detail-backdrop-placeholder"></div>';

    // Episode still → show poster fallback → placeholder
    var posterImgUrl = ep.stillUrl || ep.showPoster || null;
    var stillHtml = posterImgUrl
        ? '<img class="episode-detail-still" src="' + esc(posterImgUrl) + '" alt="" ' +
          'onerror="this.parentElement.innerHTML=\'<div class=&quot;episode-detail-still-placeholder&quot;>🎬</div>\';">'
        : '<div class="episode-detail-still-placeholder">🎬</div>';

    var castHtml = '';
    if (ep.cast && ep.cast.length > 0) {
        castHtml = '<div class="episode-detail-cast"><h3>Cast</h3><div class="cast-list">';
        ep.cast.forEach(function(c) {
            castHtml += '<div class="cast-member">';
            if (c.photo) {
                castHtml += '<img class="cast-member-photo" src="' + esc(c.photo) + '" alt="" loading="lazy" ' +
                    'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                    '<div class="cast-member-photo-placeholder" style="display:none">👤</div>';
            } else {
                castHtml += '<div class="cast-member-photo-placeholder">👤</div>';
            }
            castHtml += '<div class="cast-member-name">' + esc(c.name) + '</div>' +
                '<div class="cast-member-character">' + esc(c.character || '') + '</div></div>';
        });
        if (ep.guestStars) {
            ep.guestStars.forEach(function(g) {
                castHtml += '<div class="cast-member">';
                if (g.photo) {
                    castHtml += '<img class="cast-member-photo" src="' + esc(g.photo) + '" alt="" loading="lazy" ' +
                        'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                        '<div class="cast-member-photo-placeholder" style="display:none">👤</div>';
                } else {
                    castHtml += '<div class="cast-member-photo-placeholder">👤</div>';
                }
                castHtml += '<div class="cast-member-name">' + esc(g.name) + '</div>' +
                    '<div class="cast-member-character">' + esc(g.character || 'Guest') + '</div></div>';
            });
        }
        castHtml += '</div></div>';
    }

    var providers = (ep.watchProviders && ep.watchProviders.US && ep.watchProviders.US.flatrate)
        ? ep.watchProviders.US.flatrate : [];
    var watchHtml = '';
    if (providers.length > 0) {
        watchHtml = '<div class="episode-detail-watch"><h3>Where to Watch</h3><div class="watch-providers">';
        providers.forEach(function(p) {
            watchHtml += '<div class="watch-provider">';
            if (p.logo_path) {
                watchHtml += '<img src="' + TMDB.imageUrl(p.logo_path, '/w45') + '" alt="" width="24" height="24" style="border-radius:4px;">';
            }
            watchHtml += esc(p.provider_name) + '</div>';
        });
        watchHtml += '</div></div>';
    }

    var network = (ep.networks && ep.networks.length > 0)
        ? ep.networks.map(function(n) { return n.name; }).join(', ')
        : 'Unknown';

    // Check watched status for this episode
    var epWatched = isEpisodeWatched(ep.tmdbShowId, ep.season_number, ep.episode_number);
    var toggleId = 'epDetailToggle_' + ep.tmdbShowId + '_' + ep.season_number + '_' + ep.episode_number;

    container.innerHTML =
        '<div class="episode-detail-header">' + backdropHtml + '</div>' +
        '<div class="episode-detail-poster-row">' + stillHtml + '</div>' +
        '<div class="episode-detail-body">' +
            '<a href="#" class="episode-detail-show episode-detail-show-link" data-show-name="' + escAttr(ep.showName) + '">' + esc(ep.showName) + '</a>' +
            '<div class="episode-detail-title">' + esc(ep.name || 'Episode ' + ep.episode_number) + '</div>' +
            '<div class="episode-detail-meta">Season ' + ep.season_number + ' • Episode ' + ep.episode_number + ' • ' + airDateStr + '</div>' +
            '<button class="episode-detail-watched-toggle' + (epWatched ? ' watched' : '') + '" ' +
                'id="' + toggleId + '" ' +
                'data-show-id="' + ep.tmdbShowId + '" ' +
                'data-season="' + ep.season_number + '" ' +
                'data-episode="' + ep.episode_number + '" data-air-date="' + (ep.air_date || '') + '">' +
                (epWatched ? '✓ Watched' : '○ Mark as watched') +
            '</button>' +
            (ep.overview ? '<div class="episode-detail-overview">' + esc(ep.overview) + '</div>' : '') +
            '<div class="episode-detail-info-grid">' +
                '<div class="detail-info-item"><div class="detail-info-label">Network</div><div class="detail-info-value">' + network + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Air Date</div><div class="detail-info-value">' + airDateStr + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Rating</div><div class="detail-info-value">⭐ ' + (ep.vote_average ? ep.vote_average.toFixed(1) + '/10' : 'N/A') + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Runtime</div><div class="detail-info-value">' + (ep.runtime ? ep.runtime + ' min' : 'N/A') + '</div></div>' +
            '</div>' +
            castHtml +
            watchHtml +
        '</div>';

    // Bind watched toggle in episode detail
    var detailToggle = container.querySelector('.episode-detail-watched-toggle');
    if (detailToggle) {
        detailToggle.addEventListener('click', function(e) {
            e.preventDefault();
            var sid = this.dataset.showId;
            var sn = parseInt(this.dataset.season);
            var epNum = parseInt(this.dataset.episode);
            var nowWatched = toggleEpisodeWatched(sid, sn, epNum);

            if (nowWatched) {
                this.classList.add('watched');
                this.textContent = '✓ Watched';
            } else {
                this.classList.remove('watched');
                this.textContent = '○ Mark as watched';
            }

            // Also update the show detail progress if it's open
            updateWatchedProgress();
        });
    }

    // Make show name clickable → opens show detail
    var showLink = container.querySelector('.episode-detail-show-link');
    if (showLink) {
        showLink.addEventListener('click', function(e) {
            e.preventDefault();
            var showName = this.dataset.showName;
            // Close episode modal, open show detail
            document.getElementById('episodeModal').classList.remove('active');
            openShowDetail(showName);
        });
    }
}

// Helper: find TMDB ID for a show name using all available sources
function findTmdbId(showName) {
    // First check tmdbIndex
    var t = tmdbIndex[showName];
    if (t && t.tmdbId) return t.tmdbId;
    // Fallback: check watchedShowNames (reverse lookup)
    for (var sid in watchedShowNames) {
        if (watchedShowNames[sid] === showName) return parseInt(sid);
    }
    return null;
}

// ─── Shows Grid ──────────────────────────────────────────────
function renderShows() {
    var container = document.getElementById('showsGrid');
    if (shows.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">📚</div><h3>No shows</h3></div>';
        return;
    }

    function render(filter) {
        var list = shows;
        if (filter) {
            var q = filter.toLowerCase();
            list = shows.filter(function(s) { return s.name.toLowerCase().indexOf(q) !== -1; });
        }
        document.getElementById('showCount').textContent = list.length + ' of ' + shows.length + ' shows';

        container.innerHTML = list.map(function(s) {
            var t = tmdbIndex[s.name];
            var posterUrl = (t && t.posterPath) ? TMDB.imageUrl(t.posterPath, '/w342') : null;
            var year = (t && t.firstAirDate) ? t.firstAirDate.split('-')[0] : '';
            var tmdbId = findTmdbId(s.name);
            var watchedCount = tmdbId ? getWatchedCount(tmdbId) : 0;

            var progressHtml = '';
            if (watchedCount > 0) {
                progressHtml = '<div class="show-card-watched-count">✓ ' + watchedCount + ' watched</div>';
            }

            if (posterUrl) {
                return '<div class="show-card" data-show="' + esc(s.name) + '">' +
                    '<img class="show-card-poster" src="' + esc(posterUrl) + '" alt="' + esc(s.name) + '" loading="lazy" ' +
                    'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                    '<div class="show-card-poster-placeholder" style="display:none">📺</div>' +
                    '<div class="show-card-info"><div class="show-card-name">' + esc(s.name) + '</div>' +
                    (year ? '<div class="show-card-episodes">Since ' + year + '</div>' : '') +
                    progressHtml +
                    '</div></div>';
            }
            return '<div class="show-card" data-show="' + esc(s.name) + '">' +
                '<div class="show-card-poster-placeholder">📺</div>' +
                '<div class="show-card-info"><div class="show-card-name">' + esc(s.name) + '</div>' +
                (year ? '<div class="show-card-episodes">Since ' + year + '</div>' : '') +
                progressHtml +
                '</div></div>';
        }).join('');

        // Click on a show card opens the show detail modal
        container.querySelectorAll('.show-card').forEach(function(card) {
            card.addEventListener('click', function() {
                var showName = card.dataset.show;
                openShowDetail(showName);
            });
        });
    }

    render('');
    var timeout;
    document.getElementById('showSearch').oninput = function() {
        clearTimeout(timeout);
        var val = this.value.trim();
        timeout = setTimeout(function() { render(val); }, 200);
    };
}

// ─── Explore Tab ─────────────────────────────────────────────
function isShowFollowed(showName) {
    return shows.some(function(s) { return s.name === showName; });
}

function isShowFollowedById(tmdbId) {
    var result = followedTmdbIds.has(String(tmdbId));
    return result;
}

// Debug helper: call from browser console — checkFollowed(403245)
window.checkFollowed = function(id) {
    console.log('checkFollowed(' + id + '):');
    console.log('  as string: ' + id + ' → ' + followedTmdbIds.has(String(id)));
    console.log('  as number: ' + id + ' → ' + followedTmdbIds.has(id));
    console.log('  Set size: ' + followedTmdbIds.size);
    console.log('  Set has "403245"?: ' + followedTmdbIds.has('403245'));
    console.log('  Set has "446526"?: ' + followedTmdbIds.has('446526'));
    // Show first 5 entries
    var entries = [];
    followedTmdbIds.forEach(function(v) { if (entries.length < 5) entries.push(v); });
    console.log('  First 5 entries:', entries);
};

// Debug helper: check watched episodes state
window.debugWatched = function(showId) {
    // Check localStorage
    var raw = localStorage.getItem('tvtime_watched_episodes');
    console.log('=== Watched Episodes Debug ===');
    if (!raw) {
        console.log('localStorage: EMPTY - no tvtime_watched_episodes key');
        console.log('Did you run import-gdpr.html first?');
        return;
    }
    var parsed = JSON.parse(raw);
    var totalShows = Object.keys(parsed).length;
    var totalEps = 0;
    Object.keys(parsed).forEach(function(sid) {
        Object.keys(parsed[sid]).forEach(function(sn) {
            totalEps += parsed[sid][sn].length;
        });
    });
    console.log('localStorage: ' + totalEps + ' episodes across ' + totalShows + ' shows');

    // Check in-memory state
    var memShows = Object.keys(watchedEpisodes).length;
    var memEps = 0;
    Object.keys(watchedEpisodes).forEach(function(sid) {
        Object.keys(watchedEpisodes[sid]).forEach(function(sn) {
            memEps += watchedEpisodes[sid][sn].size;
        });
    });
    console.log('In-memory: ' + memEps + ' episodes across ' + memShows + ' shows');

    if (showId) {
        var sid = String(showId);
        console.log('Show ' + sid + ':');
        console.log('  localStorage:', JSON.stringify(parsed[sid] || {}));
        console.log('  in-memory:', watchedEpisodes[sid] || {});
        // Check a few lookups
        console.log('  isEpisodeWatched(' + sid + ', 1, 1):', isEpisodeWatched(sid, 1, 1));
        console.log('  isEpisodeWatched(' + sid + ', 1, 5):', isEpisodeWatched(sid, 1, 5));
        console.log('  getWatchedCount(' + sid + '):', getWatchedCount(sid));
    }

    // Show top 10 shows by watched count
    var counts = Object.keys(watchedEpisodes).map(function(sid) {
        var c = 0;
        Object.keys(watchedEpisodes[sid]).forEach(function(sn) {
            c += watchedEpisodes[sid][sn].size;
        });
        return {id: sid, count: c};
    });
    counts.sort(function(a, b) { return b.count - a.count; });
    console.log('Top 10 shows in memory:');
    counts.slice(0, 10).forEach(function(s) {
        var name = watchedShowNames[s.id] || '';
        // Also try reverse lookup from tmdbIndex as fallback
        if (!name) {
            Object.keys(tmdbIndex).forEach(function(k) {
                if (tmdbIndex[k] && String(tmdbIndex[k].tmdbId) === s.id) name = k;
            });
        }
        if (!name) {
            shows.forEach(function(sh) {
                var t = tmdbIndex[sh.name];
                if (t && String(t.tmdbId) === s.id) name = sh.name;
            });
        }
        console.log('  ' + s.id + ' (' + (name || 'unknown') + '): ' + s.count + ' episodes');
    });
    console.log('');
    console.log('tmdbIndex: ' + Object.keys(tmdbIndex).length + ' keys, watchedShowNames: ' + Object.keys(watchedShowNames).length + ' keys');
    // Show sample tmdbIndex entry for debugging
    var sample = Object.keys(tmdbIndex).find(function(k) { return tmdbIndex[k] && tmdbIndex[k].tmdbId; });
    if (sample) console.log('Sample tmdbIndex: "' + sample + '" → tmdbId=' + tmdbIndex[sample].tmdbId + ' (' + typeof tmdbIndex[sample].tmdbId + ')');
};

function saveUserShows() {
    try {
        localStorage.setItem('tvtime_user_shows', JSON.stringify(userShows));
    } catch(e) {}
}

function addUserShow(showInfo) {
    // showInfo: {name, tmdbId, posterPath, backdropPath, firstAirDate, overview, voteAverage}
    if (userShows.some(function(us) { return us.name === showInfo.name; })) return;
    if (isShowFollowed(showInfo.name)) return;

    userShows.push(showInfo);
    shows.push({name: showInfo.name});
    followedTmdbIds.add(String(showInfo.tmdbId));

    // Add to tmdbIndex
    if (!tmdbIndex[showInfo.name]) {
        tmdbIndex[showInfo.name] = {
            tmdbId: showInfo.tmdbId,
            name: showInfo.name,
            posterPath: showInfo.posterPath,
            backdropPath: showInfo.backdropPath,
            firstAirDate: showInfo.firstAirDate,
            overview: showInfo.overview,
            voteAverage: showInfo.voteAverage
        };
    }

    saveUserShows();
    document.getElementById('showCount').textContent = shows.length + ' shows';

    // Refresh the current explore view to update button states
    var btn = document.querySelector('.show-card[data-show="' + escAttr(showInfo.name) + '"] .show-add-btn');
    if (btn) {
        btn.classList.add('show-following-btn');
        btn.classList.remove('show-add-btn');
        btn.textContent = '✓ Following';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.border = '';
        btn.style.cursor = 'default';
    }
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtSE(s, e) { return 'S' + pad2(s) + ' | E' + pad2(e); }

function escAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Watched Episodes Tracking ──────────────────────────────
function loadWatchedEpisodes() {
    try {
        var raw = localStorage.getItem('tvtime_watched_episodes');
        if (raw) {
            var parsed = JSON.parse(raw);
            var showCount = 0, epCount = 0;
            // Convert arrays back to Sets
            Object.keys(parsed).forEach(function(showId) {
                watchedEpisodes[showId] = {};
                Object.keys(parsed[showId]).forEach(function(season) {
                    var eps = parsed[showId][season];
                    watchedEpisodes[showId][season] = new Set(eps);
                    epCount += eps.length;
                    showCount++;
                });
            });
            console.log('[TVTime] Loaded watched episodes: ' + epCount + ' episodes across ' +
                Object.keys(parsed).length + ' shows');
        } else {
            console.log('[TVTime] No watched episodes found in localStorage');
        }

        // Also load show name mapping from GDPR import
        var rawNames = localStorage.getItem('tvtime_watched_show_names');
        if (rawNames) {
            watchedShowNames = JSON.parse(rawNames);
            console.log('[TVTime] Loaded watched show names for ' + Object.keys(watchedShowNames).length + ' shows');
        }
    } catch(e) {
        console.warn('Failed to load watched episodes:', e);
        watchedEpisodes = {};
    }
}

function saveWatchedEpisodes() {
    try {
        // Convert Sets to arrays for JSON serialization
        var obj = {};
        Object.keys(watchedEpisodes).forEach(function(showId) {
            obj[showId] = {};
            Object.keys(watchedEpisodes[showId]).forEach(function(season) {
                var eps = [];
                watchedEpisodes[showId][season].forEach(function(ep) { eps.push(ep); });
                if (eps.length > 0) {
                    obj[showId][season] = eps;
                }
            });
            // Remove empty show entries
            if (Object.keys(obj[showId]).length === 0) {
                delete obj[showId];
            }
        });
        localStorage.setItem('tvtime_watched_episodes', JSON.stringify(obj));
    } catch(e) {
        console.warn('Failed to save watched episodes:', e);
    }
}

function isEpisodeWatched(showId, season, episode) {
    var s = watchedEpisodes[String(showId)];
    if (!s) return false;
    var eps = s[String(season)];
    if (!eps) return false;
    return eps.has(episode);
}

function toggleEpisodeWatched(showId, season, episode) {
    var sid = String(showId);
    var ssn = String(season);
    if (!watchedEpisodes[sid]) watchedEpisodes[sid] = {};
    if (!watchedEpisodes[sid][ssn]) watchedEpisodes[sid][ssn] = new Set();

    var eps = watchedEpisodes[sid][ssn];
    if (eps.has(episode)) {
        eps.delete(episode);
        // Clean up empty season/show entries
        if (eps.size === 0) {
            delete watchedEpisodes[sid][ssn];
            if (Object.keys(watchedEpisodes[sid]).length === 0) {
                delete watchedEpisodes[sid];
            }
        }
        saveWatchedEpisodes();
        return false; // now unwatched
    } else {
        eps.add(episode);
        saveWatchedEpisodes();
        return true; // now watched
    }
}

function getWatchedCount(showId) {
    var sid = String(showId);
    var count = 0;
    var s = watchedEpisodes[sid];
    if (s) {
        Object.keys(s).forEach(function(season) {
            count += s[season].size;
        });
    }
    return count;
}

function getTotalEpisodesForShow(showId, seasonsList) {
    // seasonsList is the show.seasons array from TMDB (has episode_count per season)
    if (!seasonsList || !seasonsList.length) return 0;
    var total = 0;
    seasonsList.forEach(function(s) {
        if (s.season_number > 0 && s.episode_count) {
            total += s.episode_count;
        }
    });
    return total;
}

// Build a lookup of watched episode keys for quick matching against the upcoming list
function buildWatchedKeySet() {
    var keys = {};
    Object.keys(watchedEpisodes).forEach(function(showId) {
        var seasons = watchedEpisodes[showId];
        Object.keys(seasons).forEach(function(season) {
            seasons[season].forEach(function(ep) {
                keys[showId + '_S' + season + '_E' + ep] = true;
            });
        });
    });
    return keys;
}

// Update the watched progress bar in the show detail modal
function updateWatchedProgress() {
    if (!currentShowDetailId) return;
    var progressEl = document.getElementById('showWatchedProgress');
    if (!progressEl) return;

    var watchedCount = getWatchedCount(currentShowDetailId);
    var totalEps = getTotalEpisodesForShow(currentShowDetailId, currentShowSeasons);
    var progressPercent = totalEps > 0 ? Math.round((watchedCount / totalEps) * 100) : 0;

    var countEl = progressEl.querySelector('.show-watched-progress-count');
    var fillEl = progressEl.querySelector('.show-watched-bar-fill');
    if (countEl) countEl.textContent = watchedCount + ' of ' + totalEps;
    if (fillEl) fillEl.style.width = progressPercent + '%';
}

// ─── Explore ─────────────────────────────────────────────
async function renderExplore(append) {
    var container = document.getElementById('exploreGrid');
    var key = TMDB.getKey();

    if (!key) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">🔑</div>' +
            '<h3>API key required</h3><p>Add your TMDB API key in Settings to explore shows.</p></div>';
        document.getElementById('exploreLoadMore').style.display = 'none';
        return;
    }

    if (!append) {
        container.innerHTML = '<div class="loading-spinner" style="grid-column:1/-1;"><div class="spinner"></div><p>Loading ' + exploreMode + ' shows...</p></div>';
        document.getElementById('exploreLoadMore').style.display = 'none';
    }

    try {
        // Check cache
        var cacheEntry = exploreCache[exploreMode] && exploreCache[exploreMode][explorePage];
        var results;
        if (cacheEntry) {
            results = cacheEntry;
        } else {
            if (exploreMode === 'trending') {
                results = await TMDB.getTrending(explorePage);
            } else {
                results = await TMDB.getPopular(explorePage);
            }
            if (!exploreCache[exploreMode]) exploreCache[exploreMode] = {};
            exploreCache[exploreMode][explorePage] = results;
        }

        if (!results || results.length === 0) {
            if (!append) {
                container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">📺</div>' +
                    '<h3>No shows found</h3><p>Try a different filter.</p></div>';
            }
            document.getElementById('exploreLoadMore').style.display = 'none';
            return;
        }

        var cardsHtml = results.map(function(show) {
            var posterUrl = show.posterPath ? TMDB.imageUrl(show.posterPath, '/w342') : null;
            var year = show.firstAirDate ? show.firstAirDate.split('-')[0] : '';
            var rating = show.voteAverage ? show.voteAverage.toFixed(1) : '';
            var followed = isShowFollowedById(show.id) || isShowFollowed(show.name);

            var actionsHtml;
            if (followed) {
                actionsHtml = '<button class="show-following-btn" disabled>✓ Following</button>';
            } else {
                actionsHtml = '<button class="show-add-btn">+ Add</button>';
            }

            var cardContent;
            if (posterUrl) {
                cardContent = '<img class="show-card-poster" src="' + esc(posterUrl) + '" alt="' + esc(show.name) + '" loading="lazy" ' +
                    'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                    '<div class="show-card-poster-placeholder" style="display:none">📺</div>';
            } else {
                cardContent = '<div class="show-card-poster-placeholder">📺</div>';
            }

            return '<div class="show-card" data-show="' + escAttr(show.name) + '">' +
                cardContent +
                '<div class="show-card-info">' +
                    '<div class="show-card-name" title="' + esc(show.name) + '">' + esc(show.name) + '</div>' +
                    '<div class="show-card-episodes">' +
                        (year ? year + ' • ' : '') +
                        (rating ? '⭐ ' + rating : '') +
                    '</div>' +
                '</div>' +
                '<div class="show-card-actions">' + actionsHtml + '</div>' +
                '</div>';
        }).join('');

        if (append) {
            container.insertAdjacentHTML('beforeend', cardsHtml);
        } else {
            container.innerHTML = cardsHtml;
        }

        // Show load more button
        document.getElementById('exploreLoadMore').style.display = 'block';

        // Bind click handlers — only to unbound cards
        container.querySelectorAll('.show-card:not([data-bound])').forEach(function(card) {
            card.setAttribute('data-bound', '1');
            // Card click → show detail (but not when clicking the add button)
            card.addEventListener('click', function(e) {
                if (e.target.classList.contains('show-add-btn') ||
                    e.target.classList.contains('show-following-btn')) {
                    return;
                }
                var showName = card.dataset.show;
                openShowDetail(showName);
            });

            // Add button click
            var addBtn = card.querySelector('.show-add-btn');
            if (addBtn) {
                addBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var showName = card.dataset.show;
                    var result = results.find(function(r) { return r.name === showName; });
                    if (result) {
                        addUserShow({
                            name: result.name,
                            tmdbId: result.id,
                            posterPath: result.posterPath,
                            backdropPath: result.backdropPath,
                            firstAirDate: result.firstAirDate,
                            overview: result.overview,
                            voteAverage: result.voteAverage
                        });
                    }
                });
            }
        });

    } catch(e) {
        console.error('Explore error:', e);
        if (!append) {
            container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">⚠️</div>' +
                '<h3>Error</h3><p>' + esc(e.message) + '</p></div>';
        }
    }
}

var exploreSearchQuery = '';
var exploreSearchTotal = 0;

async function renderExploreSearch(query, append) {
    var container = document.getElementById('exploreGrid');
    var key = TMDB.getKey();

    if (!key) return;

    if (!append) {
        exploreSearchQuery = query;
        explorePage = 1;
        container.innerHTML = '<div class="loading-spinner" style="grid-column:1/-1;"><div class="spinner"></div><p>Searching for "' + esc(query) + '"...</p></div>';
        document.getElementById('exploreLoadMore').style.display = 'none';
    }

    try {
        var data = await TMDB.searchTv(query, explorePage);
        var results = data.results;
        exploreSearchTotal = data.totalResults;

        if (!results || results.length === 0) {
            if (!append) {
                container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">🔍</div>' +
                    '<h3>No shows found</h3><p>No results for "' + esc(query) + '". Try a different search.</p></div>';
            }
            document.getElementById('exploreLoadMore').style.display = 'none';
            return;
        }

        // Update header to show result count
        var countEl = document.getElementById('exploreResultCount');
        if (!append) {
            if (!countEl) {
                var header = document.querySelector('#exploreTab .explore-header');
                var existingCount = document.getElementById('exploreResultCount');
                if (!existingCount) {
                    var span = document.createElement('span');
                    span.id = 'exploreResultCount';
                    span.style.cssText = 'font-size:13px;color:var(--text-muted);margin-left:auto;';
                    var controlsEl = document.querySelector('#exploreTab .explore-controls');
                    if (controlsEl) controlsEl.appendChild(span);
                    countEl = span;
                }
            }
        }
        countEl = document.getElementById('exploreResultCount');
        if (countEl) {
            countEl.textContent = exploreSearchTotal + ' results for "' + query + '"';
        }

        var cardsHtml = results.map(function(show) {
            var posterUrl = show.posterPath ? TMDB.imageUrl(show.posterPath, '/w342') : null;
            var year = show.firstAirDate ? show.firstAirDate.split('-')[0] : '';
            var rating = show.voteAverage ? show.voteAverage.toFixed(1) : '';
            var followed = isShowFollowedById(show.id) || isShowFollowed(show.name);

            var actionsHtml;
            if (followed) {
                actionsHtml = '<button class="show-following-btn" disabled>✓ Following</button>';
            } else {
                actionsHtml = '<button class="show-add-btn">+ Add</button>';
            }

            var cardContent;
            if (posterUrl) {
                cardContent = '<img class="show-card-poster" src="' + esc(posterUrl) + '" alt="' + esc(show.name) + '" loading="lazy" ' +
                    'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                    '<div class="show-card-poster-placeholder" style="display:none">📺</div>';
            } else {
                cardContent = '<div class="show-card-poster-placeholder">📺</div>';
            }

            return '<div class="show-card" data-show="' + escAttr(show.name) + '">' +
                cardContent +
                '<div class="show-card-info">' +
                    '<div class="show-card-name" title="' + esc(show.name) + '">' + esc(show.name) + '</div>' +
                    '<div class="show-card-episodes">' +
                        (year ? year + ' • ' : '') +
                        (rating ? '⭐ ' + rating : '') +
                    '</div>' +
                '</div>' +
                '<div class="show-card-actions">' + actionsHtml + '</div>' +
                '</div>';
        }).join('');

        if (append) {
            container.insertAdjacentHTML('beforeend', cardsHtml);
        } else {
            container.innerHTML = cardsHtml;
        }

        // Show load more if more pages
        document.getElementById('exploreLoadMore').style.display =
            (explorePage < data.totalPages) ? 'block' : 'none';

        // Bind click handlers — only unbound cards
        container.querySelectorAll('.show-card:not([data-bound])').forEach(function(card) {
            card.setAttribute('data-bound', '1');
            card.addEventListener('click', function(e) {
                if (e.target.classList.contains('show-add-btn') ||
                    e.target.classList.contains('show-following-btn')) {
                    return;
                }
                openShowDetail(card.dataset.show);
            });

            var addBtn = card.querySelector('.show-add-btn');
            if (addBtn) {
                addBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var showName = card.dataset.show;
                    var result = results.find(function(r) { return r.name === showName; });
                    if (result) {
                        addUserShow({
                            name: result.name,
                            tmdbId: result.id,
                            posterPath: result.posterPath,
                            backdropPath: result.backdropPath,
                            firstAirDate: result.firstAirDate,
                            overview: result.overview,
                            voteAverage: result.voteAverage
                        });
                    }
                });
            }
        });

    } catch(e) {
        console.error('Explore search error:', e);
        if (!append) {
            container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">⚠️</div>' +
                '<h3>Error</h3><p>' + esc(e.message) + '</p></div>';
        }
    }
}

// ─── Show Detail Modal ───────────────────────────────────────
async function openShowDetail(showName) {
    var modal = document.getElementById('showDetailModal');
    var content = document.getElementById('showDetailContent');

    modal.classList.add('active');
    content.innerHTML = '<div class="show-detail-loading"><div class="spinner"></div><p>Loading show details...</p></div>';

    try {
        var t = tmdbIndex[showName];
        if (!t || !t.tmdbId) {
            // Try searching first
            try {
                var result = await TMDB.searchShow(showName);
                if (result) {
                    tmdbIndex[showName] = { tmdbId: result.id, name: result.name,
                        posterPath: result.poster_path, backdropPath: result.backdrop_path,
                        firstAirDate: result.first_air_date, overview: result.overview,
                        voteAverage: result.vote_average };
                    try { localStorage.setItem('tvtime_tmdb_index',
                        JSON.stringify({data: tmdbIndex, expires: Date.now() + 24*60*60*1000}));
                    } catch(e) {}
                    t = tmdbIndex[showName];
                }
            } catch(e) {}
        }

        if (!t || !t.tmdbId) {
            content.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div>' +
                '<h3>Show not found</h3><p>Could not find "' + esc(showName) + '" on TMDB.</p></div>';
            return;
        }

        var showDetail = await TMDB.getShowDetail(t.tmdbId);
        renderShowDetail(showDetail, showName);
    } catch(e) {
        console.error('Failed to load show detail:', e);
        content.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div>' +
            '<h3>Error loading show</h3><p>' + esc(e.message) + '</p></div>';
    }
}

function renderShowDetail(show, showName) {
    var container = document.getElementById('showDetailContent');

    // Store current show info for watched progress updates
    currentShowDetailId = show.id;
    currentShowSeasons = show.seasons || null;

    // Calculate watched progress
    var watchedCount = getWatchedCount(show.id);
    var totalEps = getTotalEpisodesForShow(show.id, show.seasons);
    var progressPercent = totalEps > 0 ? Math.round((watchedCount / totalEps) * 100) : 0;

    // Build backdrop
    var backdropHtml = show.backdropUrl
        ? '<img class="show-detail-backdrop" src="' + esc(show.backdropUrl) + '" alt="" onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'block\';">' +
          '<div class="show-detail-backdrop-placeholder" style="display:none"></div>'
        : '<div class="show-detail-backdrop-placeholder"></div>';

    // Poster
    var posterHtml = show.posterUrl
        ? '<img class="show-detail-poster" src="' + esc(show.posterUrl) + '" alt="" onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
          '<div class="show-detail-poster-placeholder" style="display:none">📺</div>'
        : '<div class="show-detail-poster-placeholder">📺</div>';

    // Metadata
    var year = show.first_air_date ? show.first_air_date.split('-')[0] : '';
    var seasons = show.number_of_seasons || 0;
    var episodes = show.number_of_episodes || 0;
    var rating = show.vote_average ? show.vote_average.toFixed(1) : 'N/A';
    var status = show.status || '';
    var genres = (show.genres || []).map(function(g) { return g.name; }).join(', ') || '';
    var networks = (show.networks || []).map(function(n) { return n.name; }).join(', ') || '';
    var createdBy = (show.created_by || []).map(function(c) { return c.name; }).join(', ') || '';

    container.innerHTML =
        '<div class="show-detail-hero">' +
            backdropHtml +
            '<div class="show-detail-hero-gradient"></div>' +
            '<div class="show-detail-poster-wrap">' + posterHtml + '</div>' +
            '<div class="show-detail-hero-info">' +
                '<div class="show-detail-hero-name">' + esc(show.name || showName) + '</div>' +
                '<div class="show-detail-hero-meta">' +
                    (year ? '<span>' + year + '</span>' : '') +
                    (year ? '<span class="meta-sep"></span>' : '') +
                    '<span>' + seasons + ' Season' + (seasons !== 1 ? 's' : '') + '</span>' +
                    '<span class="meta-sep"></span>' +
                    '<span>' + episodes + ' Episode' + (episodes !== 1 ? 's' : '') + '</span>' +
                    '<span class="meta-sep"></span>' +
                    '<span class="show-detail-hero-rating">⭐ ' + rating + '</span>' +
                '</div>' +
                '<div class="show-hero-buttons">' +
                    (show.trailerUrl ?
                    '<a href="' + esc(show.trailerUrl) + '" target="_blank" rel="noopener" class="show-trailer-btn" ' +
                        'title="' + esc(show.trailerName || 'Watch Trailer') + '">' +
                        '<svg class="trailer-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
                        '<span>Watch Trailer</span>' +
                    '</a>' : '') +
                    '<button class="show-extra-info-btn" id="extraInfoBtn" data-show-id="' + show.id + '">' +
                        '<svg class="trailer-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>' +
                        '<span>Extra Info</span>' +
                    '</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="show-detail-body">' +
            // Overview
            (show.overview ? '<div class="show-detail-overview">' + esc(show.overview) + '</div>' : '') +
            // Watched progress
            (totalEps > 0 ?
            '<div class="show-watched-progress" id="showWatchedProgress">' +
                '<div class="show-watched-progress-header">' +
                    '<span class="show-watched-progress-label">📺 Episodes watched</span>' +
                    '<span class="show-watched-progress-count">' + watchedCount + ' of ' + totalEps + '</span>' +
                '</div>' +
                '<div class="show-watched-bar">' +
                    '<div class="show-watched-bar-fill" style="width:' + progressPercent + '%"></div>' +
                '</div>' +
            '</div>' : '') +
            // Extra Info panel (hidden until activated)
            '<div id="extraInfoPanel" class="extra-info-panel" style="display:none;"></div>' +
            // Info grid
            '<div class="show-detail-info-grid">' +
                '<div class="detail-info-item"><div class="detail-info-label">Status</div><div class="detail-info-value">' + esc(status) + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Network</div><div class="detail-info-value">' + (networks || 'N/A') + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Genre</div><div class="detail-info-value">' + (genres || 'N/A') + '</div></div>' +
                '<div class="detail-info-item"><div class="detail-info-label">Rating</div><div class="detail-info-value">⭐ ' + rating + '/10</div></div>' +
            '</div>' +
            // Episodes section
            '<div class="show-detail-section">' +
                '<div class="show-detail-section-header"><h3>Episodes</h3></div>' +
                '<div class="season-pills" id="seasonPills"></div>' +
                '<div id="showEpisodesContainer" class="show-episodes-list">' +
                    '<div class="show-episodes-loading">Select a season to view episodes</div>' +
                '</div>' +
            '</div>' +
            // Cast section
            (show.mainCast && show.mainCast.length > 0 ?
            '<div class="show-detail-cast">' +
                '<h3>Cast</h3>' +
                '<div class="cast-list">' +
                    show.mainCast.map(function(c) {
                        var photoHtml = c.photo
                            ? '<img class="cast-member-photo" src="' + esc(c.photo) + '" alt="" loading="lazy" ' +
                              'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                              '<div class="cast-member-photo-placeholder" style="display:none">👤</div>'
                            : '<div class="cast-member-photo-placeholder">👤</div>';
                        return '<div class="cast-member">' + photoHtml +
                            '<div class="cast-member-name">' + esc(c.name) + '</div>' +
                            '<div class="cast-member-character">' + esc(c.character || '') + '</div></div>';
                    }).join('') +
                '</div>' +
            '</div>' : '') +
            // Where to watch
            (function() {
                var providers = (show.watchProviders && show.watchProviders.US && show.watchProviders.US.flatrate)
                    ? show.watchProviders.US.flatrate : [];
                if (providers.length === 0) return '';
                return '<div class="episode-detail-watch"><h3>Where to Watch</h3><div class="watch-providers">' +
                    providers.map(function(p) {
                        var logoHtml = p.logo_path
                            ? '<img src="' + TMDB.imageUrl(p.logo_path, '/w45') + '" alt="" width="24" height="24" style="border-radius:4px;">'
                            : '';
                        return '<div class="watch-provider">' + logoHtml + esc(p.provider_name) + '</div>';
                    }).join('') + '</div></div>';
            })() +
        '</div>';

    // Populate season pills
    var pillsContainer = document.getElementById('seasonPills');
    var seasonsList = show.seasons || [];
    if (seasonsList.length > 0) {
        pillsContainer.innerHTML = seasonsList.map(function(s, i) {
            return '<button class="season-pill' + (i === 0 ? ' active' : '') + '" ' +
                'data-season="' + s.season_number + '">Season ' + s.season_number +
                (s.episode_count ? ' <span style="opacity:0.7;font-size:11px;">(' + s.episode_count + ')</span>' : '') +
                '</button>';
        }).join('');

        // Bind season pill clicks
        pillsContainer.querySelectorAll('.season-pill').forEach(function(pill) {
            pill.addEventListener('click', function() {
                pillsContainer.querySelectorAll('.season-pill').forEach(function(p) { p.classList.remove('active'); });
                pill.classList.add('active');
                var seasonNum = parseInt(pill.dataset.season);
                loadSeasonEpisodes(show.id, seasonNum, show.posterUrl);
            });
        });

        // Auto-load first season
        loadSeasonEpisodes(show.id, seasonsList[0].season_number, show.posterUrl);
    } else {
        pillsContainer.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">No seasons available</span>';
    }

    // Bind Extra Info button
    var extraBtn = document.getElementById('extraInfoBtn');
    if (extraBtn) {
        extraBtn.addEventListener('click', function() {
            fetchExtraInfo(show);
        });
    }
}

async function fetchExtraInfo(show) {
    var panel = document.getElementById('extraInfoPanel');
    var btn = document.getElementById('extraInfoBtn');
    if (!panel || !btn) return;

    // Toggle panel
    if (panel.style.display === 'block') {
        panel.style.display = 'none';
        btn.classList.remove('active');
        return;
    }

    // Show loading
    panel.style.display = 'block';
    panel.innerHTML = '<div class="show-episodes-loading"><div class="spinner" style="width:24px;height:24px;border-width:2px;"></div><p>Asking AI about ' + esc(show.name) + '...</p></div>';
    btn.classList.add('active');
    btn.innerHTML = '<svg class="trailer-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg><span>Loading...</span>';

    try {
        // Get latest season episodes for context
        var latestSeason = show.number_of_seasons || 1;
        var lastEpisodes = [];
        try {
            lastEpisodes = await TMDB.getShowSeasonEpisodes(show.id, latestSeason);
            lastEpisodes = lastEpisodes.slice(-5); // last 5 episodes
        } catch(e) {}

        var analysis = await Anthropic.askAboutShow(show, show.seasons || [], lastEpisodes);
        renderExtraInfo(panel, analysis);
    } catch(e) {
        console.error('Extra Info error:', e);
        panel.innerHTML = '<div class="extra-info-error">' +
            '<p><strong>Could not get AI analysis</strong></p>' +
            '<p style="font-size:13px;color:var(--text-muted);">' + esc(e.message) + '</p>' +
            '<p style="font-size:12px;color:var(--text-muted);margin-top:8px;">Add a DeepSeek API key in Settings, or check that your key is valid.</p>' +
            '</div>';
    }

    // Restore button
    btn.classList.remove('active');
    btn.innerHTML = '<svg class="trailer-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg><span>Extra Info</span>';
}

function renderExtraInfo(panel, markdown) {
    // Simple markdown → HTML conversion
    var html = markdown
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/s, function(m) { return '<ul>' + m + '</ul>'; })
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');

    html = '<div class="extra-info-content"><p>' + html + '</p></div>';

    // Add a disclaimer
    html += '<div class="extra-info-disclaimer">' +
        '🤖 AI-generated analysis based on available data and training knowledge. ' +
        'Verify important details from official sources.' +
        '</div>';

    panel.innerHTML = html;
}

async function loadSeasonEpisodes(showId, seasonNumber, fallbackPosterUrl) {
    var container = document.getElementById('showEpisodesContainer');
    container.innerHTML = '<div class="show-episodes-loading"><div class="spinner" style="width:24px;height:24px;border-width:2px;"></div></div>';

    try {
        var episodes = await TMDB.getShowSeasonEpisodes(showId, seasonNumber);

        // DEBUG: Log watched lookup details
        console.log('[TVTime] loadSeasonEpisodes: showId=' + showId + ' (type=' + typeof showId + '), season=' + seasonNumber);
        var sidStr = String(showId);
        var ssnStr = String(seasonNumber);
        console.log('[TVTime]   String keys: showId="' + sidStr + '", season="' + ssnStr + '"');
        var showEntry = watchedEpisodes[sidStr];
        console.log('[TVTime]   watchedEpisodes["' + sidStr + '"] exists? ' + !!showEntry);
        if (showEntry) {
            console.log('[TVTime]   Seasons for this show: ' + Object.keys(showEntry).join(', '));
            var seasonEntry = showEntry[ssnStr];
            console.log('[TVTime]   Season "' + ssnStr + '" exists? ' + !!seasonEntry);
            if (seasonEntry) {
                var epsArr = [];
                seasonEntry.forEach(function(e) { epsArr.push(e); });
                console.log('[TVTime]   Episodes in Set: [' + epsArr.join(', ') + ']');
            }
        }

        if (episodes.length === 0) {
            container.innerHTML = '<div class="show-episodes-loading">No episodes found for this season.</div>';
            return;
        }

        container.innerHTML = episodes.map(function(ep) {
            // Use episode still, or fall back to show poster, or placeholder
            var imgUrl = ep.stillUrl || fallbackPosterUrl || null;
            var stillHtml;
            if (imgUrl) {
                stillHtml = '<img class="show-episode-still" src="' + esc(imgUrl) + '" alt="" loading="lazy" ' +
                  'onerror="this.style.display=\'none\';var ns=this.nextElementSibling;if(ns)ns.style.display=\'flex\';">' +
                  '<div class="show-episode-still-placeholder" style="display:none">🎬</div>';
            } else {
                stillHtml = '<div class="show-episode-still-placeholder">🎬</div>';
            }

            var airDateStr = ep.airDate
                ? ep.airDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : 'TBA';

            var ratingStr = ep.vote_average ? '⭐ ' + ep.vote_average.toFixed(1) : '';
            var watched = isEpisodeWatched(showId, seasonNumber, ep.episode_number);
            var watchedClass = watched ? ' watched-episode' : '';

            return '<div class="show-episode-item' + watchedClass + '" ' +
                'data-show-id="' + showId + '" ' +
                'data-season="' + seasonNumber + '" ' +
                'data-episode="' + ep.episode_number + '" data-air-date="' + (ep.air_date || '') + '">' +
                stillHtml +
                '<div class="show-episode-item-info">' +
                    '<div class="show-episode-item-header">' +
                        '<span class="show-episode-number">E' + ep.episode_number + '</span>' +
                        '<span class="show-episode-title">' + esc(ep.name || 'Episode ' + ep.episode_number) + '</span>' +
                        (ratingStr ? '<span class="show-episode-rating">' + ratingStr + '</span>' : '') +
                    '</div>' +
                    '<div class="show-episode-airdate">' + airDateStr +
                        (ep.runtime ? ' • ' + ep.runtime + ' min' : '') + '</div>' +
                    (ep.overview ? '<div class="show-episode-overview">' + esc(ep.overview) + '</div>' : '') +
                '</div>' +
                '<button class="episode-watched-toggle' + (watched ? ' watched' : '') + '" ' +
                    'data-show-id="' + showId + '" ' +
                    'data-season="' + seasonNumber + '" ' +
                    'data-episode="' + ep.episode_number + '" ' +
                    'title="' + (watched ? 'Mark as unwatched' : 'Mark as watched') + '">' +
                    (watched ? '✓' : '○') +
                '</button></div>';
        }).join('');

        // Bind toggle button clicks (separate from episode item clicks)
        container.querySelectorAll('.episode-watched-toggle').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var sid = btn.dataset.showId;
                var sn = parseInt(btn.dataset.season);
                var ep = parseInt(btn.dataset.episode);
                var nowWatched = toggleEpisodeWatched(sid, sn, ep);

                // Update button appearance
                if (nowWatched) {
                    btn.classList.add('watched');
                    btn.textContent = '✓';
                    btn.title = 'Mark as unwatched';
                    btn.parentElement.classList.add('watched-episode');
                } else {
                    btn.classList.remove('watched');
                    btn.textContent = '○';
                    btn.title = 'Mark as watched';
                    btn.parentElement.classList.remove('watched-episode');
                }

                // Update the watched progress counter
                updateWatchedProgress();
            });
        });

        // Bind episode clicks to open episode detail modal
        container.querySelectorAll('.show-episode-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
                // Don't fire if the toggle button was clicked
                if (e.target.classList.contains('episode-watched-toggle')) return;
                showDetail(
                    item.dataset.showId,
                    parseInt(item.dataset.season),
                    parseInt(item.dataset.episode)
                );
            });
        });

    } catch(e) {
        console.error('Failed to load season episodes:', e);
        container.innerHTML = '<div class="show-episodes-loading">Failed to load episodes: ' + esc(e.message) + '</div>';
    }
}

// ─── Watched Tab ─────────────────────────────────────────────
function renderWatched() {
    var container = document.getElementById('watchedList');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 90); // look back 90 days for context

    // Find episodes in upcoming that are marked as watched
    var watchedList = [];
    var watchedSeen = {}; // dedup key
    var watchedKeySet = buildWatchedKeySet();

    upcoming.forEach(function(ep) {
        var key = ep.tmdbShowId + '_S' + ep.season_number + '_E' + ep.episode_number;
        if (watchedKeySet[key] && !watchedSeen[key]) {
            watchedSeen[key] = true;
            watchedList.push(ep);
        }
    });

    // Sort watched by air date descending (most recent first)
    watchedList.sort(function(a, b) {
        return (b.airDate ? b.airDate.getTime() : 0) - (a.airDate ? a.airDate.getTime() : 0);
    });

    // Find recently aired episodes NOT already watched
    var unwatchedAired = upcoming.filter(function(ep) {
        var key = ep.tmdbShowId + '_S' + ep.season_number + '_E' + ep.episode_number;
        return ep.airDate && ep.airDate < now && ep.airDate >= cutoff && !watchedKeySet[key];
    }).sort(function(a, b) {
        return b.airDate.getTime() - a.airDate.getTime();
    });

    var totalWatched = Object.keys(watchedSeen).length;
    document.getElementById('watchedCount').textContent =
        (totalWatched > 0 ? totalWatched + ' watched' : '') +
        (totalWatched > 0 && unwatchedAired.length > 0 ? ' • ' : '') +
        (unwatchedAired.length > 0 ? unwatchedAired.length + ' recently aired' : '');

    if (watchedList.length === 0 && unwatchedAired.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div>' +
            '<h3>Nothing watched yet</h3><p>Mark episodes as watched in a show\'s episode list, and they\'ll appear here.</p>' +
            '<p style="font-size:13px;color:var(--text-muted);margin-top:8px;">' +
            'Tip: Open a show from My Shows, select a season, and tap ○ to mark episodes as watched.</p></div>';
        return;
    }

    var html = '';

    // Watched section
    if (watchedList.length > 0) {
        html += '<div style="font-size:14px;font-weight:600;color:var(--accent-secondary);padding:8px 0;margin-top:4px;">✓ Watched (' + totalWatched + ')</div>';
        html += watchedList.map(function(ep) {
            var img = ep.showPoster
                ? '<img class="watched-poster" src="' + esc(ep.showPoster) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';">'
                : '<div class="watched-poster" style="background:var(--bg-card);display:flex;align-items:center;justify-content:center;font-size:18px;">📺</div>';
            var date = ep.airDate ? ep.airDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            return '<div class="watched-card watched-episode-card" data-tmdb-show-id="' + ep.tmdbShowId +
                '" data-season="' + ep.season_number + '" data-episode="' + ep.episode_number + '" data-air-date="' + (ep.air_date || '') + '">' +
                img +
                '<div class="watched-info">' +
                    '<div class="watched-show-name">' + esc(ep.showName) + '</div>' +
                    '<div class="watched-episode">' + fmtSE(ep.season_number, ep.episode_number) +
                        ' • ' + esc(ep.name || 'Episode ' + ep.episode_number) + '</div>' +
                    (date ? '<div class="watched-date">Aired ' + date + '</div>' : '') +
                '</div>' +
                '<button class="watched-toggle-btn watched" ' +
                    'data-show-id="' + ep.tmdbShowId + '" ' +
                    'data-season="' + ep.season_number + '" ' +
                    'data-episode="' + ep.episode_number + '" ' +
                    'title="Mark as unwatched">✓</button>' +
            '</div>';
        }).join('');
    }

    // Recently aired (unwatched) section
    if (unwatchedAired.length > 0) {
        html += '<div style="font-size:14px;font-weight:600;color:var(--text-secondary);padding:12px 0 8px;margin-top:4px;">📅 Recently Aired</div>';
        html += unwatchedAired.map(function(ep) {
            var img = ep.showPoster
                ? '<img class="watched-poster" src="' + esc(ep.showPoster) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';">'
                : '<div class="watched-poster" style="background:var(--bg-card);display:flex;align-items:center;justify-content:center;font-size:18px;">📺</div>';
            var date = ep.airDate ? ep.airDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            return '<div class="watched-card" data-tmdb-show-id="' + ep.tmdbShowId +
                '" data-season="' + ep.season_number + '" data-episode="' + ep.episode_number + '" data-air-date="' + (ep.air_date || '') + '">' +
                img +
                '<div class="watched-info">' +
                    '<div class="watched-show-name">' + esc(ep.showName) + '</div>' +
                    '<div class="watched-episode">' + fmtSE(ep.season_number, ep.episode_number) +
                        ' • ' + esc(ep.name || 'Episode ' + ep.episode_number) + '</div>' +
                    (date ? '<div class="watched-date">Aired ' + date + '</div>' : '') +
                '</div>' +
                '<button class="watched-toggle-btn" ' +
                    'data-show-id="' + ep.tmdbShowId + '" ' +
                    'data-season="' + ep.season_number + '" ' +
                    'data-episode="' + ep.episode_number + '" ' +
                    'title="Mark as watched">○</button>' +
            '</div>';
        }).join('');
    }

    container.innerHTML = html;

    // Bind card clicks → episode detail
    container.querySelectorAll('.watched-card').forEach(function(card) {
        card.addEventListener('click', function(e) {
            if (e.target.classList.contains('watched-toggle-btn')) return;
            showDetail(card.dataset.tmdbShowId,
                parseInt(card.dataset.season),
                parseInt(card.dataset.episode));
        });
    });

    // Bind toggle button clicks
    container.querySelectorAll('.watched-toggle-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var sid = btn.dataset.showId;
            var sn = parseInt(btn.dataset.season);
            var epNum = parseInt(btn.dataset.episode);
            var nowWatched = toggleEpisodeWatched(sid, sn, epNum);

            if (nowWatched) {
                btn.classList.add('watched');
                btn.textContent = '✓';
                btn.title = 'Mark as unwatched';
                btn.parentElement.classList.add('watched-episode-card');
            } else {
                btn.classList.remove('watched');
                btn.textContent = '○';
                btn.title = 'Mark as watched';
                btn.parentElement.classList.remove('watched-episode-card');
            }

            // Update show detail progress if open
            updateWatchedProgress();
        });
    });
}

// ─── Boot ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

})();
