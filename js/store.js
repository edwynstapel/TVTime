/**
 * Local storage cache for API responses.
 * Avoids hitting rate limits and speeds up repeat loads.
 */

// ── Cookie helpers ────────────────────────────────────────────
// Bridge localStorage between Safari and iOS Home Screen Web App.
// On iOS, localStorage is isolated per context, but cookies are shared.

function setCookie(name, value, days) {
    try {
        var expires = '';
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = '; expires=' + date.toUTCString();
        }
        var encoded = encodeURIComponent(value);
        // Warn if encoded size approaches 4KB cookie limit
        if (encoded.length > 3800) console.warn('[CookieBridge] Large cookie "' + name + '": ' + encoded.length + ' bytes encoded');
        document.cookie = name + '=' + encoded + expires + '; path=/; SameSite=Lax';
    } catch(e) { console.warn('[CookieBridge] setCookie failed for "' + name + '":', e.message); }
}

function getCookie(name) {
    try {
        var nameEQ = name + '=';
        var ca = document.cookie.split(';');
        for (var i = 0; i < ca.length; i++) {
            var c = ca[i].trim();
            if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length));
        }
    } catch(e) { /* Silently ignore */ }
    return null;
}

function eraseCookie(name) {
    try {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
    } catch(e) { /* Silently ignore */ }
}

// ── Multi-part cookie for larger data (up to ~20KB) ──────────
// Splits data across multiple 2KB chunks so cache data can
// bridge between Safari and iOS Home Screen Web App.
// Chunk size is conservative to stay under 4KB after URI encoding
// (JSON special chars like " { } become 3-byte %XX sequences).

var COOKIE_CHUNK_SIZE = 2000; // bytes per chunk, safe after URI encoding
var COOKIE_MAX_CHUNKS = 10;   // 10 × 2KB ≈ 20KB max

function setLargeCookie(name, value, days) {
    try {
        // Clear old chunks first
        var oldCount = parseInt(getCookie(name + '_n')) || 0;
        for (var i = 0; i < Math.max(oldCount, COOKIE_MAX_CHUNKS); i++) {
            eraseCookie(name + '_c' + i);
        }
        eraseCookie(name + '_n');

        if (!value) return;

        // Don't bother if it fits in a single cookie
        if (value.length <= COOKIE_CHUNK_SIZE) {
            setCookie(name, value, days);
            console.log('[CookieBridge] Stored "' + name + '" as single cookie (' + value.length + ' bytes)');
            return;
        }

        // Split into chunks
        var chunks = Math.ceil(value.length / COOKIE_CHUNK_SIZE);
        if (chunks > COOKIE_MAX_CHUNKS) {
            console.warn('[CookieBridge] "' + name + '" too large: ' + value.length + ' bytes, need ' + chunks + ' chunks (max ' + COOKIE_MAX_CHUNKS + ')');
            return;
        }

        for (var j = 0; j < chunks; j++) {
            setCookie(name + '_c' + j, value.substring(j * COOKIE_CHUNK_SIZE, (j + 1) * COOKIE_CHUNK_SIZE), days);
        }
        setCookie(name + '_n', String(chunks), days);
        console.log('[CookieBridge] Stored "' + name + '" as ' + chunks + ' chunks (' + value.length + ' bytes total)');
    } catch(e) { console.warn('[CookieBridge] setLargeCookie failed for "' + name + '":', e.message); }
}

function getLargeCookie(name) {
    try {
        var count = parseInt(getCookie(name + '_n')) || 0;
        if (count === 0) {
            // Try single cookie (fit in one)
            var single = getCookie(name);
            if (single) console.log('[CookieBridge] Read "' + name + '" from single cookie (' + single.length + ' bytes)');
            return single;
        }
        if (count > COOKIE_MAX_CHUNKS) return null;

        var result = '';
        for (var i = 0; i < count; i++) {
            var chunk = getCookie(name + '_c' + i);
            if (chunk === null) {
                console.warn('[CookieBridge] Missing chunk ' + i + '/' + count + ' for "' + name + '"');
                return null;
            }
            result += chunk;
        }
        console.log('[CookieBridge] Read "' + name + '" from ' + count + ' chunks (' + result.length + ' bytes)');
        return result || null;
    } catch(e) { return null; }
}

function eraseLargeCookie(name) {
    try {
        var count = parseInt(getCookie(name + '_n')) || 0;
        for (var i = 0; i < Math.max(count, COOKIE_MAX_CHUNKS); i++) {
            eraseCookie(name + '_c' + i);
        }
        eraseCookie(name + '_n');
        eraseCookie(name);
    } catch(e) { /* Silently ignore */ }
}
var Store = {
    _prefix: 'tvtime_',

    get(key) {
        try {
            const raw = localStorage.getItem(this._prefix + key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            // Check expiry
            if (entry.expires && Date.now() > entry.expires) {
                localStorage.removeItem(this._prefix + key);
                return null;
            }
            return entry.data;
        } catch {
            return null;
        }
    },

    set(key, data, ttlHours = 6) {
        try {
            const entry = {
                data,
                expires: Date.now() + (ttlHours * 60 * 60 * 1000)
            };
            localStorage.setItem(this._prefix + key, JSON.stringify(entry));
        } catch (e) {
            // Storage full — clear old entries and retry
            console.warn('Storage full, clearing cache...');
            this.clearAll();
            try {
                localStorage.setItem(this._prefix + key, JSON.stringify(entry));
            } catch {
                console.error('Still cannot write to localStorage');
            }
        }
    },

    remove(key) {
        localStorage.removeItem(this._prefix + key);
    },

    clearAll() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(this._prefix)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    },

    getTtl() {
        return parseInt(document.getElementById('cacheHours')?.value || '6');
    }
};
