/**
 * TMDB API v3 integration.
 * Requires an API key — free tier at themoviedb.org/settings/api
 */

var TMDB_BASE = 'https://api.themoviedb.org/3';
var TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Image sizes (var for cross-script access)
var POSTER_SM  = '/w185';
var POSTER_MD  = '/w342';
var POSTER_LG  = '/w500';
var BACKDROP   = '/w780';
var STILL      = '/w300';
var PROFILE    = '/w185';
var LOGO       = '/w92';

var TMDB = {
    _key: null,
    _inFlight: 0,
    _maxConcurrent: 4,

    getKey() {
        if (this._key) return this._key;
        this._key = localStorage.getItem('tvtime_tmdb_key') || '';
        return this._key;
    },

    setKey(key) {
        this._key = key;
        localStorage.setItem('tvtime_tmdb_key', key);
    },

    /**
     * Generic API call with caching and concurrency limiting.
     */
    async fetch(endpoint, params = {}) {
        const key = this.getKey();
        if (!key) throw new Error('TMDB_API_KEY_REQUIRED');

        // Build URL by string concat — new URL(endpoint, base) would replace
        // the /3 path prefix in the base, producing the wrong URL.
        var url = new URL(TMDB_BASE + endpoint);
        url.searchParams.set('api_key', key);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
        });

        const cacheKey = 'tmdb_' + url.pathname + '_' + url.searchParams.toString();

        // Try cache first
        const cached = Store.get(cacheKey);
        if (cached) return cached;

        // Concurrency limiter — keep at most _maxConcurrent requests in flight
        while (this._inFlight >= this._maxConcurrent) {
            await new Promise(r => setTimeout(r, 100));
        }
        this._inFlight++;

        try {
            // 15-second timeout per request — prevents infinite hanging on CORS blocks
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 15000);

            var res;
            try {
                res = await fetch(url.toString(), { signal: controller.signal });
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                if (fetchErr.name === 'AbortError') {
                    throw new Error('Request timed out after 15s — check your network or try a different browser (Safari works best for local files).');
                }
                // Network error or CORS block from file:// origin
                throw new Error('Network request failed. If using a local file, try opening with Safari instead — some browsers block API calls from file:// URLs. (' + (fetchErr.message || 'unknown') + ')');
            }
            clearTimeout(timeoutId);

            if (res.status === 401) throw new Error('TMDB_API_KEY_INVALID');
            if (res.status === 429) {
                await new Promise(r => setTimeout(r, 2000));
                this._inFlight--;
                return this.fetch(endpoint, params); // retry once
            }
            if (!res.ok) throw new Error('TMDB error: ' + res.status + ' for ' + endpoint);
            const data = await res.json();
            Store.set(cacheKey, data, Store.getTtl());
            return data;
        } finally {
            this._inFlight--;
        }
    },

    /** Build full image URL, or null */
    imageUrl(path, size = POSTER_SM) {
        if (!path) return null;
        return TMDB_IMAGE_BASE + size + path;
    },

    /** Search for a TV show by name. Returns the best match or null. */
    async searchShow(name) {
        const data = await this.fetch('/search/tv', { query: name });
        if (!data.results || data.results.length === 0) return null;
        // Prefer exact name match, then first result (sorted by popularity)
        const exact = data.results.find(
            r => r.name.toLowerCase() === name.toLowerCase()
        );
        return exact || data.results[0];
    },

    /** Search for TV shows by name. Returns all matching results. */
    async searchTv(query, page) {
        page = page || 1;
        var data = await this.fetch('/search/tv', { query: query, page: page });
        return {
            results: (data.results || []).map(function(r) {
                return {
                    id: r.id,
                    name: r.name,
                    posterPath: r.poster_path,
                    backdropPath: r.backdrop_path,
                    firstAirDate: r.first_air_date,
                    overview: r.overview,
                    voteAverage: r.vote_average,
                    popularity: r.popularity,
                    originCountry: r.origin_country || [],
                    genreIds: r.genre_ids || []
                };
            }),
            totalPages: data.total_pages || 1,
            totalResults: data.total_results || 0
        };
    },

    /**
     * Get show details. TMDB includes next_episode_to_air and last_episode_to_air
     * directly on the show object — no need to iterate seasons for basic upcoming info.
     */
    async getShow(showId) {
        return this.fetch('/tv/' + showId);
    },

    /** Get all episodes for a season. */
    async getSeason(showId, seasonNumber) {
        const data = await this.fetch('/tv/' + showId + '/season/' + seasonNumber);
        return data.episodes || [];
    },

    /**
     * Get upcoming episodes for a show — fast path using show-level data.
     *
     * The /tv/{id} response includes:
     *   next_episode_to_air — the next airing episode (full object)
     *   last_episode_to_air — the most recently aired episode (full object)
     *   seasons[] — array with season_number, air_date, episode_count
     *
     * Strategy:
     *   1. Use next_episode_to_air / last_episode_to_air for immediate results (1 API call)
     *   2. If the show is currently airing, fetch the current season for all upcoming episodes
     */
    async getUpcomingEpisodes(showId) {
        const show = await this.fetch('/tv/' + showId, { append_to_response: 'images' });
        const episodes = [];
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Extract show logo (prefer English, fallback to first available)
        var logos = (show.images && show.images.logos) ? show.images.logos : [];
        var logo = logos.find(function(l) { return l.iso_639_1 === 'en'; }) || logos[0];
        var showLogo = logo ? this.imageUrl(logo.file_path, LOGO) : null;

        const enrich = (ep) => ({
            showId: show.id,
            showName: show.name,
            showLogo: showLogo,
            showPoster: this.imageUrl(show.poster_path, POSTER_SM),
            showBackdrop: this.imageUrl(show.backdrop_path, BACKDROP),
            networks: (show.networks || []).map(n => ({
                name: n.name,
                logo: this.imageUrl(n.logo_path, LOGO)
            })),
            season_number: ep.season_number,
            episode_number: ep.episode_number,
            name: ep.name || '',
            overview: ep.overview || '',
            air_date: ep.air_date || '',
            still_path: ep.still_path || '',
            vote_average: ep.vote_average || 0,
            runtime: ep.runtime || 0,
            airDate: ep.air_date ? new Date(ep.air_date + 'T00:00:00') : null,
            tmdbShowId: show.id,
            tmdbEpisodeId: ep.id
        });

        // If show has a currently airing season, fetch its episodes for full upcoming list
        const currentSeason = (show.seasons || []).find(s => s.season_number === show.number_of_seasons);
        const hasActiveSeason = currentSeason && currentSeason.air_date;
        let seasonAirDate = null;
        if (hasActiveSeason) {
            seasonAirDate = new Date(currentSeason.air_date + 'T00:00:00');
        }

        // Fetch full season if it started within last year (covers currently airing)
        if (hasActiveSeason && seasonAirDate) {
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
            if (seasonAirDate >= oneYearAgo) {
                try {
                    const seasonEps = await this.getSeason(showId, currentSeason.season_number);
                    for (const ep of seasonEps) {
                        if (!ep.air_date) continue;
                        const airDate = new Date(ep.air_date + 'T00:00:00');
                        if (airDate >= sevenDaysAgo) {
                            episodes.push(enrich(ep));
                        }
                    }
                } catch (e) {
                    console.warn('Failed season fetch for ' + show.name + ' S' + currentSeason.season_number, e.message);
                }
            }
        }

        // If no season episodes found (e.g. show between seasons), use next/last from show
        if (episodes.length === 0) {
            if (show.next_episode_to_air && show.next_episode_to_air.air_date) {
                const airDate = new Date(show.next_episode_to_air.air_date + 'T00:00:00');
                if (airDate >= sevenDaysAgo) {
                    episodes.push(enrich(show.next_episode_to_air));
                }
            }
            if (show.last_episode_to_air && show.last_episode_to_air.air_date) {
                const airDate = new Date(show.last_episode_to_air.air_date + 'T00:00:00');
                if (airDate >= sevenDaysAgo) {
                    const alreadyAdded = episodes.some(
                        e => e.season_number === show.last_episode_to_air.season_number &&
                             e.episode_number === show.last_episode_to_air.episode_number
                    );
                    if (!alreadyAdded) {
                        episodes.push(enrich(show.last_episode_to_air));
                    }
                }
            }
            // Also check specials (season 0)
            const specials = (show.seasons || []).find(s => s.season_number === 0);
            if (specials) {
                try {
                    const specialEps = await this.getSeason(showId, 0);
                    for (const ep of specialEps) {
                        if (!ep.air_date) continue;
                        const airDate = new Date(ep.air_date + 'T00:00:00');
                        if (airDate >= sevenDaysAgo) {
                            episodes.push(enrich(ep));
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }

        // Sort by air date
        episodes.sort((a, b) => (a.airDate?.getTime() || 0) - (b.airDate?.getTime() || 0));
        return episodes;
    },

    /**
     * Fetch upcoming episodes for multiple shows concurrently.
     * Returns a flat array of all upcoming episodes.
     */
    async batchUpcoming(shows, onProgress) {
        const allEpisodes = [];
        let completed = 0;
        const total = shows.length;

        // Process in parallel batches
        const batchSize = this._maxConcurrent;
        for (let i = 0; i < shows.length; i += batchSize) {
            const batch = shows.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(
                batch.map(async (show) => {
                    try {
                        const eps = await this.getUpcomingEpisodes(show.tmdbId);
                        return eps;
                    } catch (e) {
                        console.warn('Failed upcoming for ' + show.name + ':', e.message);
                        return [];
                    }
                })
            );

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    allEpisodes.push(...result.value);
                }
            }

            completed += batch.length;
            if (onProgress) onProgress(completed, total);
        }

        // Sort by air date, deduplicate
        allEpisodes.sort((a, b) => (a.airDate?.getTime() || 0) - (b.airDate?.getTime() || 0));

        const seen = new Set();
        const unique = allEpisodes.filter(ep => {
            if (!ep.airDate) return false;
            const key = ep.showId + '_' + ep.season_number + '_' + ep.episode_number;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return unique;
    },

    /**
     * Get episode detail with full credits, images, and show info.
     */
    async getEpisode(showId, seasonNumber, episodeNumber) {
        const [data, show] = await Promise.all([
            this.fetch('/tv/' + showId + '/season/' + seasonNumber + '/episode/' + episodeNumber,
                { append_to_response: 'credits,images' }),
            this.getShow(showId)
        ]);

        const stillPath = data.still_path || (data.images?.stills?.[0]?.file_path);
        const cast = (data.credits?.cast || show.credits?.cast || []).slice(0, 10);
        const guestStars = (data.credits?.guest_stars || []).slice(0, 5);

        // Get watch providers
        let watchProviders = {};
        try {
            const wp = await this.fetch('/tv/' + showId + '/watch/providers');
            watchProviders = wp.results || {};
        } catch (e) { /* optional */ }

        return {
            ...data,
            showName: show.name,
            showPoster: this.imageUrl(show.poster_path, POSTER_SM),
            showBackdrop: this.imageUrl(show.backdrop_path, BACKDROP),
            stillUrl: this.imageUrl(stillPath, STILL),
            stillFull: this.imageUrl(stillPath, POSTER_LG),
            networks: (show.networks || []).map(n => ({
                name: n.name,
                logo: this.imageUrl(n.logo_path, LOGO)
            })),
            watchProviders,
            cast: cast.map(c => ({
                name: c.name,
                character: c.character,
                photo: this.imageUrl(c.profile_path, PROFILE)
            })),
            guestStars: guestStars.map(g => ({
                name: g.name,
                character: g.character,
                photo: this.imageUrl(g.profile_path, PROFILE)
            })),
            airDate: data.air_date ? new Date(data.air_date + 'T00:00:00') : null
        };
    },

    /**
     * Get full show detail: show info + aggregate credits + watch providers.
     */
    async getShowDetail(showId) {
        const [show, credits, providers, videos] = await Promise.all([
            this.fetch('/tv/' + showId),
            this.fetch('/tv/' + showId + '/aggregate_credits'),
            this.fetch('/tv/' + showId + '/watch/providers').catch(() => ({ results: {} })),
            this.fetch('/tv/' + showId + '/videos').catch(() => ({ results: [] }))
        ]);

        // Find the best trailer: prefer official YouTube trailers
        var videoResults = (videos.results || []).filter(function(v) {
            return v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser');
        });
        if (videoResults.length === 0) {
            videoResults = (videos.results || []).filter(function(v) {
                return v.site === 'YouTube';
            });
        }
        var trailer = videoResults.length > 0 ? videoResults[0] : null;
        var trailerUrl = trailer ? 'https://www.youtube.com/watch?v=' + trailer.key : null;

        const cast = (credits.cast || []).slice(0, 15).map(c => ({
            name: c.name,
            character: c.roles ? c.roles.map(r => r.character).join(', ') : (c.character || ''),
            photo: this.imageUrl(c.profile_path, PROFILE),
            order: c.order || c.total_episode_count || 0,
            episodes: c.total_episode_count || 0
        }));

        // Group cast by importance
        const mainCast = cast.filter(c => c.episodes >= 5).slice(0, 10);
        const recurringCast = cast.filter(c => c.episodes < 5 && c.episodes > 0).slice(0, 5);

        return {
            ...show,
            posterUrl: this.imageUrl(show.poster_path, POSTER_LG),
            backdropUrl: this.imageUrl(show.backdrop_path, BACKDROP),
            mainCast,
            recurringCast,
            watchProviders: providers.results || {},
            seasons: (show.seasons || []).filter(s => s.season_number > 0).sort((a, b) => b.season_number - a.season_number),
            trailerUrl: trailerUrl,
            trailerName: trailer ? trailer.name : null
        };
    },

    /**
     * Get episodes for a specific season of a show.
     */
    async getShowSeasonEpisodes(showId, seasonNumber) {
        const data = await this.fetch('/tv/' + showId + '/season/' + seasonNumber);
        return (data.episodes || []).map(ep => ({
            ...ep,
            stillUrl: this.imageUrl(ep.still_path, STILL),
            airDate: ep.air_date ? new Date(ep.air_date + 'T00:00:00') : null,
            vote_average: ep.vote_average || 0,
            runtime: ep.runtime || 0
        }));
    },

    /**
     * Get trending TV shows for the week.
     */
    async getTrending(page) {
        page = page || 1;
        var data = await this.fetch('/trending/tv/week', { page: page });
        return (data.results || []).map(function(r) {
            return {
                id: r.id,
                name: r.name,
                posterPath: r.poster_path,
                backdropPath: r.backdrop_path,
                firstAirDate: r.first_air_date,
                overview: r.overview,
                voteAverage: r.vote_average,
                popularity: r.popularity,
                originCountry: r.origin_country || [],
                genreIds: r.genre_ids || []
            };
        });
    },

    /**
     * Get popular TV shows.
     */
    async getPopular(page) {
        page = page || 1;
        var data = await this.fetch('/tv/popular', { page: page });
        return (data.results || []).map(function(r) {
            return {
                id: r.id,
                name: r.name,
                posterPath: r.poster_path,
                backdropPath: r.backdrop_path,
                firstAirDate: r.first_air_date,
                overview: r.overview,
                voteAverage: r.vote_average,
                popularity: r.popularity,
                originCountry: r.origin_country || [],
                genreIds: r.genre_ids || []
            };
        });
    },

    /**
     * Batch search shows — returns map of name -> matched TMDB info.
     */
    async batchSearch(shows, onProgress) {
        const results = {};
        let completed = 0;

        const batchSize = this._maxConcurrent;
        for (let i = 0; i < shows.length; i += batchSize) {
            const batch = shows.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(
                batch.map(async (show) => {
                    const result = await this.searchShow(show.name);
                    if (result) {
                        results[show.name] = {
                            tmdbId: result.id,
                            name: result.name,
                            posterPath: result.poster_path,
                            backdropPath: result.backdrop_path,
                            firstAirDate: result.first_air_date,
                            overview: result.overview,
                            voteAverage: result.vote_average
                        };
                    } else {
                        results[show.name] = null;
                    }
                })
            );
            completed += batch.length;
            if (onProgress) onProgress(completed, shows.length);
        }

        return results;
    }
};
