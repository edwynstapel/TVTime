/**
 * Local storage cache for API responses.
 * Avoids hitting rate limits and speeds up repeat loads.
 */
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
