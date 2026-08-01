/**
 * Local storage cache for API responses.
 * Avoids hitting rate limits and speeds up repeat loads.
 */

// ── IndexedDB persistence layer ───────────────────────────────
// iOS Home Screen Web Apps can lose localStorage between sessions.
// IndexedDB is more reliably persistent, so we mirror critical
// data there and restore it on startup if localStorage is empty.

var IDB = {
    _db: null,
    _dbName: 'TVTimeStore',
    _storeName: 'kv',

    _open: function() {
        if (this._db) return Promise.resolve(this._db);
        var self = this;
        return new Promise(function(resolve) {
            try {
                var req = indexedDB.open(self._dbName, 1);
                req.onupgradeneeded = function(e) {
                    if (!e.target.result.objectStoreNames.contains(self._storeName)) {
                        e.target.result.createObjectStore(self._storeName);
                    }
                };
                req.onsuccess = function(e) {
                    self._db = e.target.result;
                    resolve(self._db);
                };
                req.onerror = function() {
                    console.warn('[IDB] Could not open IndexedDB');
                    resolve(null);
                };
            } catch(e) {
                console.warn('[IDB] IndexedDB not available');
                resolve(null);
            }
        });
    },

    get: function(key) {
        var self = this;
        return this._open().then(function(db) {
            if (!db) return null;
            return new Promise(function(resolve) {
                try {
                    var tx = db.transaction(self._storeName, 'readonly');
                    var req = tx.objectStore(self._storeName).get(key);
                    req.onsuccess = function() { resolve(req.result !== undefined ? req.result : null); };
                    req.onerror = function() { resolve(null); };
                } catch(e) { resolve(null); }
            });
        });
    },

    set: function(key, value) {
        var self = this;
        return this._open().then(function(db) {
            if (!db) return;
            return new Promise(function(resolve) {
                try {
                    var tx = db.transaction(self._storeName, 'readwrite');
                    tx.objectStore(self._storeName).put(value, key);
                    tx.oncomplete = function() { resolve(); };
                    tx.onerror = function() { resolve(); };
                } catch(e) { resolve(); }
            });
        });
    },

    remove: function(key) {
        var self = this;
        return this._open().then(function(db) {
            if (!db) return;
            return new Promise(function(resolve) {
                try {
                    var tx = db.transaction(self._storeName, 'readwrite');
                    tx.objectStore(self._storeName).delete(key);
                    tx.oncomplete = function() { resolve(); };
                    tx.onerror = function() { resolve(); };
                } catch(e) { resolve(); }
            });
        });
    },

    // Restore all mirrored keys from IndexedDB into localStorage
    // Called at startup when localStorage appears empty.
    restoreAll: function() {
        var self = this;
        var keys = [
            'tvtime_tmdb_key', 'tvtime_deepseek_key',
            'tvtime_user_shows', 'tvtime_watched_episodes',
            'tvtime_data_version', 'tvtime_watched_show_names'
        ];
        return this._open().then(function(db) {
            if (!db) return;
            return Promise.allSettled(keys.map(function(key) {
                return self.get(key).then(function(val) {
                    if (val !== null && val !== undefined) {
                        try { localStorage.setItem(key, val); } catch(e) {}
                        console.log('[IDB] Restored ' + key + ' (' + val.length + ' bytes)');
                    }
                });
            }));
        });
    },

    // Mirror a key: save to IndexedDB as fire-and-forget backup
    mirror: function(key, value) {
        this.set(key, value).catch(function() {});
    }
};

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

    set(key, data, ttlHours) {
        ttlHours = ttlHours || 6;
        try {
            const entry = {
                data: data,
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

    remove: function(key) {
        localStorage.removeItem(this._prefix + key);
    },

    clearAll: function() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(this._prefix)) keys.push(k);
        }
        keys.forEach(function(k) { localStorage.removeItem(k); });
    },

    getTtl: function() {
        return parseInt(document.getElementById('cacheHours')?.value || '6');
    }
};
