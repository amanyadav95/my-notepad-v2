/* ==========================================================================
   Google Drive sync for my-notepad-v2
   - Sign in with Google (Identity Services button)
   - Backs up notes + files as a visible JSON file in the user's My Drive
   - Auto-syncs a few seconds after any change, plus "Sync now" / "Restore"
   - Two-way sync: when sync runs it first checks Drive for an existing
     backup, downloads it and MERGES it with local data (newest edit wins)
     before writing anything, so a device never clobbers changes that were
     made elsewhere
   - The Drive access token expires every hour, so it is renewed silently
     (prompt='none', no popup) whenever it is needed, which keeps auto-sync
     running instead of stopping when the session expires
   ========================================================================== */

const GS_CONFIG = {
    // >>> PASTE YOUR WEB APPLICATION OAUTH CLIENT ID HERE <<<
    clientId: '362568772028-mff6hpvilde2k34vpmel72d14501c735.apps.googleusercontent.com',
    backupFileName: 'my-notepad-backup.json',
    scope: 'https://www.googleapis.com/auth/drive.file'
};

// Use app.js constants when available, otherwise the same literal values
const GS_INDEX_KEY = (typeof NOTES_INDEX_KEY !== 'undefined') ? NOTES_INDEX_KEY : 'notes_index';
const GS_FILE_PREFIX = (typeof FILE_KEY_PREFIX !== 'undefined') ? FILE_KEY_PREFIX : 'note_file_';
const GS_USER_KEY = 'google_sync_user';
const GS_LAST_SYNC_KEY = 'google_sync_last_sync';
const GS_TOKEN_KEY = 'google_sync_token';
const GS_GRANTED_KEY = 'google_sync_granted';
const GS_ERROR_KEY = 'google_sync_last_error';
const GS_TIMES_KEY = 'google_sync_times';         // storageKey -> last edited/deleted time
const GS_BASELINE_KEY = 'google_sync_baseline';   // snapshot of the last successful upload
const GS_PAYLOAD_VERSION = 2;                     // v2 = carries per-key edit times
const GS_SILENT_RETRY_COOLDOWN = 60000;           // don't hammer Drive after a failed background renewal

let gsUser = null;
let gsToken = null;
let gsTokenExpiresAt = 0;
let gsTokenClient = null;
let gsSyncTimer = null;
let gsConsentHintShown = false;
let gsTokenInteractive = false;   // is the token request in flight user-triggered?
let gsTokenRequest = null;        // promise of that request (one at a time)
let gsSilentRetryAt = 0;          // cooldown after a failed background renewal

/* ----------------------------- small helpers ----------------------------- */

function gsToast(message, type) {
    if (typeof showToast === 'function') showToast(message, type || 'success');
    else console.log('[GS]', message);
}

function gsDecodeJwt(token) {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
        return JSON.parse(atob(padded));
    } catch (e) {
        return null;
    }
}

function gsReadUser() {
    try {
        const raw = localStorage.getItem(GS_USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

// Access token survives page reloads (sessionStorage) so auto-sync keeps
// working after an update-triggered reload without needing a popup
function gsSaveToken(token, expiresAt) {
    try {
        sessionStorage.setItem(GS_TOKEN_KEY, JSON.stringify({ token: token, expiresAt: expiresAt }));
    } catch (e) { /* ignore */ }
}

function gsLoadToken() {
    try {
        const raw = sessionStorage.getItem(GS_TOKEN_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data && data.token && data.expiresAt > Date.now()) {
            gsToken = data.token;
            gsTokenExpiresAt = data.expiresAt;
            return gsToken;
        }
        gsClearToken(); // expired → forget it so a renewal is attempted
    } catch (e) { /* ignore */ }
    return null;
}

function gsClearToken() {
    try { sessionStorage.removeItem(GS_TOKEN_KEY); } catch (e) { /* ignore */ }
}

function gsRelativeTime(d) {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return d.toLocaleString();
}

/* --------------------------------- UI ----------------------------------- */

function gsUpdateUserUi() {
    const signedOut = document.getElementById('gsSignedOut');
    const signedIn = document.getElementById('gsSignedIn');
    if (!signedOut || !signedIn) return;

    if (gsUser) {
        signedOut.style.display = 'none';
        signedIn.style.display = 'block';
        const avatar = document.getElementById('gsAvatar');
        if (avatar) {
            if (gsUser.picture) { avatar.src = gsUser.picture; avatar.style.display = ''; }
            else avatar.style.display = 'none';
        }
        const nameEl = document.getElementById('gsName');
        if (nameEl) nameEl.textContent = gsUser.name;
        gsRenderLastSync();
    } else {
        signedOut.style.display = 'block';
        signedIn.style.display = 'none';
    }
    gsRefreshPermissionPulse();
}

function gsRenderLastSync() {
    const el = document.getElementById('gsLastSync');
    if (!el) return;
    const raw = localStorage.getItem(GS_LAST_SYNC_KEY);
    el.textContent = raw ? 'Last synced: ' + gsRelativeTime(new Date(raw)) : 'Not synced yet';
}

function gsMarkSynced() {
    localStorage.setItem(GS_LAST_SYNC_KEY, new Date().toISOString());
    gsSetError(null);
    gsRenderLastSync();
}

/* Persistent on-page status: every failure is shown in the sidebar so the
   exact cause is visible without opening the browser console */
function gsRenderError() {
    const el = document.getElementById('gsError');
    if (!el) return;
    let msg = '';
    try { msg = localStorage.getItem(GS_ERROR_KEY) || ''; } catch (e) { msg = ''; }
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

/* Pulsing "Sync now" while Drive permission is still missing */
function gsRefreshPermissionPulse() {
    const btn = document.getElementById('gsSyncNow');
    if (!btn) return;
    const needs = !!gsUser && localStorage.getItem(GS_GRANTED_KEY) !== '1';
    btn.classList.toggle('gs-needs-permission', needs);
}

function gsSetError(msg) {
    try {
        if (msg) localStorage.setItem(GS_ERROR_KEY, msg);
        else localStorage.removeItem(GS_ERROR_KEY);
    } catch (e) { /* ignore */ }
    gsRenderError();
}

function gsSetSyncing(isSyncing) {
    const btn = document.getElementById('gsSyncNow');
    if (!btn) return;
    btn.disabled = isSyncing;
    btn.textContent = isSyncing ? 'Syncing…' : 'Sync now';
}

/* ----------------------------- Google auth ------------------------------ */

function gsDecodeCredential(response) {
    const payload = gsDecodeJwt((response && response.credential) || '');
    if (!payload || !payload.sub) return null;
    return {
        sub: payload.sub,
        name: payload.name || payload.email || 'Signed in',
        email: payload.email || '',
        picture: payload.picture || ''
    };
}

function gsHandleCredential(response) {
    const user = gsDecodeCredential(response);
    if (!user) {
        gsToast('Google sign-in failed.', 'danger');
        return;
    }
    gsUser = user;
    localStorage.setItem(GS_USER_KEY, JSON.stringify(gsUser));
    gsUpdateUserUi();
    gsSetError(null); // fresh sign-in: clear any old error
    // Instruction toast doubles as the consent hint for the first sync
    gsConsentHintShown = true;
    gsToast('Signed in as ' + gsUser.name + '. Click "Sync now" to allow Drive access.', 'info');
    // If Drive access was granted before, this syncs silently right away
    gsSyncToDrive(false).then(function(ok) {
        if (ok) gsToast('Synced to Google Drive.', 'success');
    });
}

let gsTokenResolve = null; // resolver of the token request currently in flight

/* Global token-response callback: requestAccessToken() only delivers to this
   one callback (a per-request "callback" is ignored by GIS) */
function gsDeliverToken(resp) {
    const interactive = gsTokenInteractive;
    if (resp && resp.access_token) {
        gsToken = resp.access_token;
        gsTokenExpiresAt = Date.now() + Math.max(60, (resp.expires_in || 3600) - 60) * 1000;
        gsSaveToken(gsToken, gsTokenExpiresAt);
        localStorage.setItem(GS_GRANTED_KEY, '1');
        gsSilentRetryAt = 0;
        gsRefreshPermissionPulse();
    } else if (resp && resp.error && resp.error !== 'interaction_required') {
        // interaction_required is the normal "not granted yet" answer
        console.warn('[GS] no access token', resp.error);
        if (interactive) {
            gsSetError(resp.error === 'access_denied'
                ? 'Google denied access — add your account under Cloud Console → OAuth consent screen → Test users'
                : 'Google token error: ' + resp.error);
        } else {
            gsSessionExpired();
        }
    } else if (resp && resp.error === 'interaction_required' && !interactive) {
        // prompt='none' could not be satisfied: the Google session behind the
        // grant is gone, so auto-sync has to pause until the user clicks again
        gsSessionExpired();
    }
    const done = gsTokenResolve;
    gsTokenResolve = null;
    if (done) done(resp && resp.access_token ? gsToken : null);
}

/* A silent renewal can fail (Google session ended, grant withdrawn, timeout).
   Auto-sync cannot open a popup, so say so instead of stopping silently */
function gsSessionExpired() {
    gsSilentRetryAt = Date.now() + GS_SILENT_RETRY_COOLDOWN;
    gsSetError('Google session expired — click "Sync now" to resume auto-sync');
}

function gsRequestToken(prompt, interactive) {
    // GIS delivers every response to ONE global callback, so two requests must
    // never run at once — a background renewal and a "Sync now" click share it
    if (gsTokenRequest) return gsTokenRequest;

    gsTokenInteractive = !!interactive;
    gsTokenRequest = new Promise(function(resolve) {
        if (!gsTokenClient) return resolve(null);
        let finished = false;
        function settle(v) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve(v);
        }
        // Safety net: never leave the UI hanging if Google's response is lost
        const timer = setTimeout(function() {
            if (gsTokenResolve === settle) gsTokenResolve = null;
            if (interactive) gsSetError('Google did not respond — click "Sync now" again');
            else gsSessionExpired();
            settle(null);
        }, 180000);
        try {
            gsTokenResolve = settle; // responses arrive at the GLOBAL callback (see gsDeliverToken)
            gsTokenClient.requestAccessToken({
                prompt: prompt,
                error_callback: function(err) {
                    if (gsTokenResolve === settle) gsTokenResolve = null;
                    console.warn('[GS] token request error', err);
                    if (interactive) {
                        const t = err && err.type;
                        if (t === 'popup_failed_to_open') {
                            gsSetError('Google popup was blocked — allow popups for this site, then click "Sync now" again');
                        } else if (t === 'popup_closed') {
                            gsSetError('Google popup was closed before finishing — click "Sync now" again');
                        } else {
                            gsSetError('Google sign-in problem' + (t ? ': ' + t : ''));
                        }
                    } else {
                        gsSessionExpired(); // background renewal: no popup wording
                    }
                    settle(null);
                }
            });
        } catch (e) {
            if (gsTokenResolve === settle) gsTokenResolve = null;
            console.error('[GS] token request failed', e);
            if (interactive) gsSetError('Google sign-in problem: ' + (e.message || e));
            settle(null);
        }
    }).then(function(v) {
        gsTokenRequest = null;
        return v;
    });
    return gsTokenRequest;
}

async function gsEnsureToken(interactive) {
    if (gsToken && Date.now() < gsTokenExpiresAt) return gsToken;

    const granted = localStorage.getItem(GS_GRANTED_KEY) === '1';

    // Auto-sync must NEVER open a popup (no user gesture = browser blocks it),
    // so it only renews silently with prompt='none'. This is what keeps
    // auto-sync running after the one-hour access token expires.
    if (!interactive) {
        if (!granted) return null;                     // Drive never authorised yet
        if (Date.now() < gsSilentRetryAt) return null; // cooldown after a failed renewal
        return gsRequestToken('none', false);
    }
    // First-ever grant: go STRAIGHT to consent — one popup, gesture intact.
    // (Trying a silent attempt first could spend the click's popup permission.)
    if (!granted) return gsRequestToken('consent', true);
    // Already granted before: renew silently, fall back to consent if Google
    // insists (session ended / grant withdrawn)
    const silent = await gsRequestToken('none', true);
    if (silent) return silent;
    localStorage.removeItem(GS_GRANTED_KEY); // consent is needed again next click
    return gsRequestToken('consent', true);
}

/* Drop the current token so the next call renews it (used after a 401) */
function gsInvalidateToken() {
    gsToken = null;
    gsTokenExpiresAt = 0;
    gsSilentRetryAt = 0;
    gsClearToken();
}

function gsSignOut() {
    const token = gsToken;
    gsToken = null;
    gsTokenExpiresAt = 0;
    gsSilentRetryAt = 0;
    localStorage.removeItem(GS_USER_KEY);
    localStorage.removeItem(GS_GRANTED_KEY); // token was revoked → consent needed again
    try { localStorage.removeItem(GS_BASELINE_KEY); } catch (e) { /* ignore */ } // no cross-account merges
    gsClearToken();
    gsSetError(null);
    gsUser = null;
    clearTimeout(gsSyncTimer);
    if (window.google && google.accounts) {
        try {
            if (token && google.accounts.oauth2) google.accounts.oauth2.revoke(token, function() {});
            if (google.accounts.id) google.accounts.id.disableAutoSelect();
        } catch (e) { /* ignore */ }
    }
    gsUpdateUserUi();
    gsToast('Signed out of Google sync.', 'success');
}

/* ------------------------------ Drive API ------------------------------- */

function gsAuthHeaders(token) {
    return { Authorization: 'Bearer ' + token };
}

function gsApiError(what, status) {
    let hint = '';
    if (status === 403) hint = ' — the Google Drive API may be disabled: enable it in Cloud Console → APIs & Services → Library → Google Drive API';
    else if (status === 401) hint = ' — access token expired';
    const err = new Error(what + ' (' + status + ')' + hint);
    err.status = status; // lets the sync retry once with a fresh token
    throw err;
}

async function gsFindBackup(token) {
    const q = "name='" + GS_CONFIG.backupFileName + "' and trashed=false";
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
                '&fields=files(id,name,modifiedTime)';
    const r = await fetch(url, { headers: gsAuthHeaders(token) });
    if (!r.ok) gsApiError('Drive list failed', r.status);
    const data = await r.json();
    return (data.files && data.files.length) ? data.files[0].id : null;
}

function gsBuildPayload() {
    const files = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.indexOf(GS_FILE_PREFIX) === 0) {
            files[key] = localStorage.getItem(key); // raw string = exact round-trip
        }
    }
    return {
        app: 'my-notepad-v2',
        version: GS_PAYLOAD_VERSION,
        savedAt: new Date().toISOString(),
        notes: localStorage.getItem(GS_INDEX_KEY),  // raw string or null
        files: files,
        times: gsReadTimes() // per-key edit times → conflicts resolve "newest edit wins"
    };
}

async function gsCreateFile(token, payload) {
    const boundary = 'my-notepad-' + Date.now();
    const meta = {
        name: GS_CONFIG.backupFileName,
        description: 'my-notepad backup (created automatically by the app)'
    };
    const body = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(meta),
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n',
        JSON.stringify(payload),
        '\r\n--' + boundary + '--\r\n'
    ], { type: 'multipart/related; boundary=' + boundary });

    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: gsAuthHeaders(token),
        body: body
    });
    if (!r.ok) gsApiError('Drive create failed', r.status);
}

async function gsUpdateFile(token, fileId, payload) {
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', {
        method: 'PATCH',
        headers: Object.assign(gsAuthHeaders(token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    if (!r.ok) gsApiError('Drive update failed', r.status);
}

async function gsDownload(token, fileId) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
        headers: gsAuthHeaders(token)
    });
    if (!r.ok) gsApiError('Backup download failed', r.status);
    return r.json();
}

/* ------------------------------- merging --------------------------------
   Before a sync writes anything to Drive, the backup that is already there
   is downloaded and merged with the local data:

   - notes index : merged note-by-note / page-by-page (union of both sides).
                   Deletions are detected with the baseline (the state of the
                   last successful upload from THIS device), so removing a
                   note here also removes it everywhere — unless the other
                   device changed it more recently, in which case its copy
                   wins.
   - page text   : when both sides edited the same page, the newest edit wins
                   (per-key times recorded by gsMarkChange in app.js).
   ------------------------------------------------------------------------- */

function gsHash(str) {
    if (str === null || str === undefined) return null;
    const s = String(str);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h + ':' + s.length; // hash + length = cheap collision guard
}

function gsFileKey(note, page) {
    if (typeof fileKey === 'function') return fileKey(note, page); // app.js helper
    return GS_FILE_PREFIX + note + '__' + page;
}

function gsReadTimes() {
    try {
        const raw = localStorage.getItem(GS_TIMES_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
        return {};
    }
}

function gsWriteTimes(map) {
    try { localStorage.setItem(GS_TIMES_KEY, JSON.stringify(map || {})); } catch (e) { /* ignore */ }
}

function gsMergeTimes(a, b) {
    const out = {};
    [a || {}, b || {}].forEach(function(map) {
        Object.keys(map).forEach(function(k) {
            const t = Date.parse(map[k] || '') || 0;
            const cur = Date.parse(out[k] || '') || 0;
            if (t >= cur) out[k] = map[k];
        });
    });
    return out;
}

/* Called by app.js on every create / save / delete */
function gsMarkChange(key) {
    gsWriteTimes(gsMergeTimes(gsReadTimes(), { [key]: new Date().toISOString() }));
}

function gsLoadBaseline() {
    try {
        const raw = localStorage.getItem(GS_BASELINE_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return (v && typeof v === 'object' && v.hashes) ? v : null;
    } catch (e) {
        return null;
    }
}

/* Remember exactly what this device last uploaded — it is what makes
   "was this deleted here, or added there?" answerable on the next sync */
function gsSaveBaseline(payload) {
    try {
        const hashes = {};
        Object.keys(payload.files || {}).forEach(function(k) {
            hashes[k] = gsHash(payload.files[k]);
        });
        localStorage.setItem(GS_BASELINE_KEY, JSON.stringify({
            savedAt: payload.savedAt || new Date().toISOString(),
            index: payload.notes || null,
            hashes: hashes
        }));
    } catch (e) { /* ignore */ }
}

function gsParseIndex(raw) {
    if (!raw) return {};
    try {
        const v = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
        return {};
    }
}

function gsPagesOf(v) {
    return Array.isArray(v) ? v.filter(function(p) { return typeof p === 'string'; }) : [];
}

function gsOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/* Last time a device touched a key. Falls back to that device's whole-file
   timestamps when the key has no per-key time (data saved by older versions) */
function gsActivityTime(side, key, ctx) {
    const map = side === 'local' ? ctx.localTimes : ctx.remoteTimes;
    const t = Date.parse((map && map[key]) || '');
    if (t) return t;
    return side === 'local' ? ctx.localLastSync : ctx.remoteSavedAt;
}

function gsBuildContext(remote) {
    const baseline = gsLoadBaseline();
    return {
        hasBaseline: !!baseline,
        baseIndex: baseline ? (baseline.index || null) : null,
        baseHashes: (baseline && baseline.hashes) ? baseline.hashes : {},
        localTimes: gsReadTimes(),
        remoteTimes: (remote && remote.times && typeof remote.times === 'object') ? remote.times : {},
        localLastSync: Date.parse(localStorage.getItem(GS_LAST_SYNC_KEY) || '') || 0,
        remoteSavedAt: Date.parse((remote && remote.savedAt) || '') || 0
    };
}

/* Newest activity for a note on one device (a note deletion stamps the time
   of every page it removed, so deletions take part in the comparison too) */
function gsMaxActivity(side, note, pages, ctx) {
    let max = 0;
    const seen = {};
    (pages || []).forEach(function(p) {
        const key = gsFileKey(note, p);
        if (seen[key]) return;
        seen[key] = true;
        const t = gsActivityTime(side, key, ctx);
        if (t > max) max = t;
    });
    return max;
}

/* Page list of one note. basePages === null means "note is new / unknown",
   so deletions cannot be judged and everything is kept */
function gsMergePages(lPages, rPages, basePages, note, ctx) {
    const lSet = {}, rSet = {}, bSet = {};
    lPages.forEach(function(p) { lSet[p] = true; });
    rPages.forEach(function(p) { rSet[p] = true; });
    if (basePages) basePages.forEach(function(p) { bSet[p] = true; });

    const order = lPages.slice();
    rPages.forEach(function(p) { if (!lSet[p]) order.push(p); });

    const out = [];
    order.forEach(function(p) {
        const inL = !!lSet[p], inR = !!rSet[p];
        if (inL && inR) { out.push(p); return; }        // exists on both sides
        if (!basePages) { out.push(p); return; }        // new note — keep everything
        if (!bSet[p]) { out.push(p); return; }          // added by one side — keep it

        // In the last sync but missing on one side → that side deleted it.
        // The deletion only stands when it is at least as recent as the
        // other device's activity on that page.
        const key = gsFileKey(note, p);
        const deletedAt = gsActivityTime(inL ? 'remote' : 'local', key, ctx);
        const keptAt = gsActivityTime(inL ? 'local' : 'remote', key, ctx);
        if (deletedAt >= keptAt) return;
        out.push(p);
    });
    return out;
}

function gsMergeIndex(localRaw, remoteRaw, ctx) {
    const L = gsParseIndex(localRaw);
    const R = gsParseIndex(remoteRaw);
    const B = ctx.hasBaseline ? gsParseIndex(ctx.baseIndex) : null;

    const order = Object.keys(L);
    Object.keys(R).forEach(function(n) { if (!gsOwn(L, n)) order.push(n); });

    const merged = {};
    order.forEach(function(note) {
        const inL = gsOwn(L, note), inR = gsOwn(R, note);
        if (!inL && !inR) return; // gone from both sides

        const known = ctx.hasBaseline && gsOwn(B, note);
        const lPages = inL ? gsPagesOf(L[note]) : [];
        const rPages = inR ? gsPagesOf(R[note]) : [];
        const bPages = known ? gsPagesOf(B[note]) : null;

        if (known && inL !== inR) {
            // The whole note was deleted on one device. Keep it only when the
            // other device has worked on it since that deletion.
            const all = lPages.concat(rPages, bPages || []);
            const deletedAt = gsMaxActivity(inL ? 'remote' : 'local', note, all, ctx);
            const keptAt = gsMaxActivity(inL ? 'local' : 'remote', note, all, ctx);
            if (deletedAt >= keptAt) return; // deletion stands
            merged[note] = (inL ? lPages : rPages).slice();
            return;
        }

        merged[note] = gsMergePages(lPages, rPages, bPages, note, ctx);
    });
    return merged;
}

/* Pick the text of one page when both devices have it */
function gsPickValue(key, localVal, remoteVal, ctx) {
    if (localVal !== null && remoteVal !== null && String(localVal) === String(remoteVal)) return localVal;
    if (localVal === null) return remoteVal;
    if (remoteVal === null) return localVal;

    const lt = gsActivityTime('local', key, ctx);
    const rt = gsActivityTime('remote', key, ctx);
    if (lt !== rt) return lt > rt ? localVal : remoteVal; // newest edit wins

    // Same activity time → fall back to "who changed it since the last sync"
    const baseHash = ctx.baseHashes[key];
    if (baseHash !== undefined && baseHash !== null) {
        const lChanged = gsHash(localVal) !== baseHash;
        const rChanged = gsHash(remoteVal) !== baseHash;
        if (lChanged && !rChanged) return localVal;
        if (rChanged && !lChanged) return remoteVal;
    }
    return localVal;
}

function gsMergeFiles(localFiles, remoteFiles, mergedIndex, ctx) {
    // Only pages that survived the index merge keep their text
    const expected = {};
    Object.keys(mergedIndex).forEach(function(note) {
        gsPagesOf(mergedIndex[note]).forEach(function(p) {
            expected[gsFileKey(note, p)] = true;
        });
    });

    const keys = {};
    [localFiles || {}, remoteFiles || {}].forEach(function(src) {
        Object.keys(src).forEach(function(k) {
            if (k.indexOf(GS_FILE_PREFIX) === 0) keys[k] = true;
        });
    });

    const out = {};
    Object.keys(keys).forEach(function(k) {
        if (!expected[k]) return; // page no longer exists → drop its text
        const lv = gsOwn(localFiles || {}, k) ? localFiles[k] : null;
        const rv = gsOwn(remoteFiles || {}, k) ? remoteFiles[k] : null;
        const v = gsPickValue(k, lv, rv, ctx);
        if (v !== null) out[k] = v;
    });
    return out;
}

/* Both payloads must already be through gsNormalizePayload */
function gsMergePayloads(local, remote) {
    const ctx = gsBuildContext(remote);
    const mergedIndex = gsMergeIndex(local.notes, remote.notes, ctx);
    const mergedFiles = gsMergeFiles(local.files, remote.files, mergedIndex, ctx);
    return {
        notes: Object.keys(mergedIndex).length ? JSON.stringify(mergedIndex) : null,
        files: mergedFiles,
        times: gsMergeTimes(ctx.localTimes, ctx.remoteTimes)
    };
}

/* Uniform shape for local and downloaded payloads: strings only */
function gsNormalizePayload(p) {
    const files = {};
    const src = (p && p.files && typeof p.files === 'object') ? p.files : {};
    Object.keys(src).forEach(function(k) {
        if (k.indexOf(GS_FILE_PREFIX) !== 0) return;
        const v = src[k];
        files[k] = (typeof v === 'string') ? v : JSON.stringify(v);
    });
    let notes = p ? p.notes : null;
    if (notes !== null && notes !== undefined && typeof notes !== 'string') notes = JSON.stringify(notes);
    return {
        app: (p && p.app) || 'my-notepad-v2',
        version: (p && p.version) || GS_PAYLOAD_VERSION,
        savedAt: (p && p.savedAt) || new Date().toISOString(),
        notes: notes || null,
        files: files,
        times: (p && p.times && typeof p.times === 'object') ? p.times : {}
    };
}

function gsIsValidPayload(p) {
    return !!(p && typeof p === 'object' && !Array.isArray(p)) &&
        (typeof p.notes === 'string' || p.notes === null || typeof p.notes === 'object') &&
        (p.files === undefined || (p.files && typeof p.files === 'object'));
}

function gsPagesEqual(a, b) {
    const x = gsPagesOf(a), y = gsPagesOf(b);
    return x.length === y.length && x.every(function(v, i) { return v === y[i]; });
}

function gsIndexEqual(a, b) {
    const A = gsParseIndex(a), B = gsParseIndex(b);
    const ka = Object.keys(A), kb = Object.keys(B);
    if (ka.length !== kb.length) return false;
    return ka.every(function(k) { return gsOwn(B, k) && gsPagesEqual(A[k], B[k]); });
}

/* Content only — savedAt / times are metadata and always differ */
function gsSameContent(a, b) {
    if (!gsIndexEqual(a.notes, b.notes)) return false;
    const af = a.files || {}, bf = b.files || {};
    const ak = Object.keys(af), bk = Object.keys(bf);
    if (ak.length !== bk.length) return false;
    return ak.every(function(k) { return gsOwn(bf, k) && String(af[k]) === String(bf[k]); });
}

function gsResetEditor() {
    if (window.jQuery) {
        window.jQuery('#fileTitle').val('');
        window.jQuery('#fileText').val('').prop('disabled', true);
        window.jQuery('#saveNote').text('');
    }
}

/* Write the merged state into localStorage (only what actually differs) and
   re-render the sidebar / open page. Returns true when local data changed */
function gsApplyMerged(merged) {
    let indexChanged = false;
    let filesChanged = false;

    const localKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(GS_FILE_PREFIX) === 0) localKeys.push(k);
    }
    localKeys.forEach(function(k) {
        if (!gsOwn(merged.files, k)) {
            localStorage.removeItem(k);
            filesChanged = true;
        } else if (merged.files[k] !== localStorage.getItem(k)) {
            localStorage.setItem(k, merged.files[k]);
            filesChanged = true;
        }
    });
    Object.keys(merged.files).forEach(function(k) {
        if (localStorage.getItem(k) === null) {
            localStorage.setItem(k, merged.files[k]);
            filesChanged = true;
        }
    });

    const currentIndex = localStorage.getItem(GS_INDEX_KEY);
    const nextIndex = merged.notes || null;
    if ((currentIndex || null) !== nextIndex) {
        if (nextIndex) localStorage.setItem(GS_INDEX_KEY, nextIndex);
        else localStorage.removeItem(GS_INDEX_KEY);
        indexChanged = true;
    }

    gsWriteTimes(gsMergeTimes(gsReadTimes(), merged.times));

    if (!indexChanged && !filesChanged) return false;
    gsRefreshAfterMerge(indexChanged, filesChanged);
    return true;
}

function gsRefreshAfterMerge(indexChanged, filesChanged) {
    // activeNote / activePage / notes come from app.js — guard so sync still
    // works (and never throws) if app.js has not loaded
    const hasApp = typeof activeNote !== 'undefined';

    if (indexChanged) {
        if (typeof loadNotesFromStorage === 'function') notes = loadNotesFromStorage();
        if (hasApp) {
            const idx = (typeof notes === 'object' && notes) ? notes : {};
            if (activeNote && !gsOwn(idx, activeNote)) {
                activeNote = '';
                activePage = '';
                gsResetEditor();
            } else if (activeNote && activePage && gsPagesOf(idx[activeNote]).indexOf(activePage) === -1) {
                activePage = '';
                gsResetEditor();
            }
        }
        if (typeof showIndex === 'function') showIndex();
    }

    if (!filesChanged || !hasApp) return;
    const editor = document.getElementById('fileText');
    const saveBtn = document.getElementById('saveNote');
    if (!editor || !activeNote || !activePage) return;
    // Never overwrite text the user is currently typing
    if (!editor.disabled && saveBtn && saveBtn.textContent.trim() === 'Save') return;

    const data = (typeof getFileFromStorage === 'function') ? getFileFromStorage(activeNote, activePage) : {};
    if (data && typeof data === 'object' && gsOwn(data, 'text_note')) {
        editor.value = data.text_note || '';
        if (typeof viewPage === 'function') viewPage(data);
    } else {
        gsResetEditor();
    }
}

/* --------------------------- sync / restore ----------------------------- */

async function gsSyncToDrive(interactive, retried) {
    if (!gsUser) return false;
    const token = await gsEnsureToken(interactive);
    if (!token) {
        const granted = localStorage.getItem(GS_GRANTED_KEY) === '1';
        if (interactive) {
            // Don't overwrite a more specific error set during the token request
            try {
                if (!localStorage.getItem(GS_ERROR_KEY)) {
                    gsSetError('Drive permission not granted yet — a Google popup must open and be approved. If none appeared, allow popups for this site.');
                }
            } catch (e) { /* ignore */ }
            gsToast('Google permission is required to sync.', 'danger');
        } else if (!gsConsentHintShown) {
            gsConsentHintShown = true;
            gsToast(granted
                ? 'Google session expired — click "Sync now" to resume auto-sync.'
                : 'Google sync needs one-time permission — click "Sync now" in the sidebar.', 'info');
        }
        return false;
    }
    gsSetSyncing(true);
    try {
        const local = gsNormalizePayload(gsBuildPayload());
        const fileId = await gsFindBackup(token);

        /* Drive already has a backup → fetch it and merge BEFORE overwriting */
        if (fileId) {
            let remoteRaw;
            try {
                remoteRaw = await gsDownload(token, fileId);
            } catch (e) {
                // Never overwrite a backup that could not be read
                const err = new Error('Could not read the existing Google Drive backup, so nothing was overwritten — ' + (e.message || e));
                err.status = e && e.status; // keep 401 so the sync can renew + retry
                throw err;
            }
            if (!gsIsValidPayload(remoteRaw)) {
                throw new Error('The file in Google Drive is not a my-notepad backup — nothing was overwritten. Rename or delete it in Drive, then sync again.');
            }
            const remote = gsNormalizePayload(remoteRaw);
            const pulled = gsApplyMerged(gsMergePayloads(local, remote));
            const payload = gsNormalizePayload(gsBuildPayload()); // rebuilt = merged state

            if (gsSameContent(payload, remote)) {
                gsSaveBaseline(payload);
                gsMarkSynced();
                if (pulled) gsToast('Merged changes from Google Drive.', 'info');
                else if (interactive) gsToast('Already up to date with Google Drive.', 'success');
                return true;
            }

            await gsUpdateFile(token, fileId, payload);
            gsSaveBaseline(payload);
            gsMarkSynced();
            if (interactive) gsToast(pulled ? 'Merged with Google Drive and synced.' : 'Synced to Google Drive.', 'success');
            else if (pulled) gsToast('Merged changes from Google Drive.', 'info');
            return true;
        }

        /* No backup yet → first upload */
        await gsCreateFile(token, local);
        gsSaveBaseline(local);
        gsMarkSynced();
        if (interactive) gsToast('Synced to Google Drive.', 'success');
        return true;
    } catch (e) {
        // Drive rejected the token (expired / revoked despite our own clock):
        // renew it silently and run the whole sync once more
        if (e && e.status === 401 && !retried) {
            console.warn('[GS] access token rejected by Drive — refreshing it and retrying');
            gsInvalidateToken();
            return await gsSyncToDrive(interactive, true);
        }
        console.error('[GS] sync failed:', e);
        gsSetError(e.message || String(e));
        if (interactive) gsToast('Google sync failed: ' + (e.message || e), 'danger');
        return false;
    } finally {
        gsSetSyncing(false);
    }
}

function gsApplyPayload(payload) {
    // Remove every local file entry, then write the backup's entries
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.indexOf(GS_FILE_PREFIX) === 0) toRemove.push(key);
    }
    toRemove.forEach(function(k) { localStorage.removeItem(k); });

    Object.keys(payload.files || {}).forEach(function(k) {
        if (k.indexOf(GS_FILE_PREFIX) !== 0) return;
        const v = payload.files[k];
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    });

    if (payload.notes) {
        localStorage.setItem(GS_INDEX_KEY, typeof payload.notes === 'string' ? payload.notes : JSON.stringify(payload.notes));
    } else {
        localStorage.removeItem(GS_INDEX_KEY);
    }

    // Keep the newest edit time for every restored key
    gsWriteTimes(gsMergeTimes(gsReadTimes(), payload.times || {}));

    // Reset the open editor (its note/file may no longer exist) and re-render
    if (typeof loadNotesFromStorage === 'function') notes = loadNotesFromStorage();
    activeNote = '';
    activePage = '';
    if (window.jQuery) {
        window.jQuery('#fileTitle').val('');
        window.jQuery('#fileText').val('').prop('disabled', true);
        window.jQuery('#saveNote').text('');
    }
    if (typeof showIndex === 'function') showIndex();
}

async function gsRestoreFromGoogle() {
    if (!gsUser) return;
    const token = await gsEnsureToken(true);
    if (!token) {
        gsToast('Google permission is required to restore.', 'danger');
        return;
    }
    try {
        const fileId = await gsFindBackup(token);
        if (!fileId) {
            gsToast('No backup found in your Google Drive.', 'warning');
            return;
        }
        const payload = await gsDownload(token, fileId);
        const valid = payload &&
            (typeof payload.notes === 'string' || payload.notes === null || typeof payload.notes === 'object') &&
            (payload.files === undefined || typeof payload.files === 'object');
        if (!valid) throw new Error('Backup file is not valid');

        const when = payload.savedAt ? new Date(payload.savedAt).toLocaleString() : 'an unknown time';
        if (!confirm('Restore backup from ' + when + '?\n\nYour current notes will be replaced.')) return;

        gsApplyPayload(payload);
        gsToast('Backup restored from Google Drive.', 'success');
    } catch (e) {
        console.error('[GS] restore failed:', e);
        gsSetError(e.message || String(e));
        gsToast('Restore failed: ' + (e.message || e), 'danger');
    }
}

/* ------------------------------ auto sync ------------------------------- */

// Called by app.js after every successful save (debounced)
function scheduleSync() {
    if (!gsUser) return;
    clearTimeout(gsSyncTimer);
    gsSyncTimer = setTimeout(function() {
        gsSyncToDrive(false);
    }, 8000);
}

/* --------------------------------- init --------------------------------- */

function gsWhenGisReady(callback, tries) {
    if (window.google && google.accounts && google.accounts.id && google.accounts.oauth2) {
        callback();
        return;
    }
    if ((tries || 0) > 50) {
        console.error('[GS] Google Identity Services did not load. Check network / ad-blocker.');
        return;
    }
    setTimeout(function() { gsWhenGisReady(callback, (tries || 0) + 1); }, 100);
}

window.addEventListener('load', function() {
    gsUser = gsReadUser();
    if (gsUser) gsLoadToken();
    gsUpdateUserUi();
    gsRenderError();

    gsWhenGisReady(function() {
        try {
            google.accounts.id.initialize({
                client_id: GS_CONFIG.clientId,
                callback: gsHandleCredential
            });
            const btnContainer = document.getElementById('gsGoogleBtn');
            if (btnContainer) {
                google.accounts.id.renderButton(btnContainer, {
                    theme: 'outline',
                    size: 'medium',
                    text: 'signin_with'
                });
            }
            gsTokenClient = google.accounts.oauth2.initTokenClient({
                client_id: GS_CONFIG.clientId,
                scope: GS_CONFIG.scope,
                // Per-request "callback" is NOT supported by GIS — every token
                // response is delivered to this global callback only
                callback: gsDeliverToken
            });
        } catch (e) {
            console.error('[GS] Init failed — check GS_CONFIG.clientId:', e);
        }
    });

    const syncBtn = document.getElementById('gsSyncNow');
    if (syncBtn) syncBtn.addEventListener('click', function() { gsSyncToDrive(true); });

    const restoreBtn = document.getElementById('gsRestore');
    if (restoreBtn) restoreBtn.addEventListener('click', gsRestoreFromGoogle);

    const signOutBtn = document.getElementById('gsSignOut');
    if (signOutBtn) signOutBtn.addEventListener('click', gsSignOut);

    // Keep "Last synced: x ago" fresh
    setInterval(function() { if (gsUser) gsRenderLastSync(); }, 60000);
});

/* --------------------- debug handle (console use) ----------------------- */
window.myNotepadGoogle = {
    state: function() {
        return {
            signedIn: !!gsUser,
            name: gsUser ? gsUser.name : null,
            clientIdSet: GS_CONFIG.clientId.indexOf('YOUR_CLIENT_ID') !== 0,
            grantedBefore: localStorage.getItem(GS_GRANTED_KEY) === '1',
            tokenValid: !!(gsToken && Date.now() < gsTokenExpiresAt),
            tokenExpiresInSec: gsToken ? Math.max(0, Math.round((gsTokenExpiresAt - Date.now()) / 1000)) : 0,
            lastSync: localStorage.getItem(GS_LAST_SYNC_KEY),
            hasBaseline: !!gsLoadBaseline(),
            baselineAt: (gsLoadBaseline() || {}).savedAt || null,
            trackedTimes: Object.keys(gsReadTimes()).length,
            silentRenewPausedForSec: Math.max(0, Math.round((gsSilentRetryAt - Date.now()) / 1000)),
            lastError: localStorage.getItem(GS_ERROR_KEY) || null
        };
    },
    sync: function() { return gsSyncToDrive(true); },
    /* Force a token renewal — proves auto-sync can recover after expiry */
    refreshToken: function() {
        gsInvalidateToken();
        return gsEnsureToken(true).then(function(t) {
            if (!t) return 'renewal failed — check myNotepadGoogle.state().lastError';
            return 'token renewed, expires in ' + Math.max(0, Math.round((gsTokenExpiresAt - Date.now()) / 1000)) + 's';
        });
    },
    restore: function() { return gsRestoreFromGoogle(); },
    signOut: function() { gsSignOut(); },
    /* Dry-run of the merge: downloads the Drive backup and reports what a
       sync would change locally, without uploading anything */
    mergePreview: function() {
        const token = gsToken || gsLoadToken();
        if (!token) return Promise.resolve('No access token — click "Sync now" once first.');
        return gsFindBackup(token).then(function(fileId) {
            if (!fileId) return 'No backup on Drive yet — first sync just uploads the local data.';
            return gsDownload(token, fileId).then(function(remoteRaw) {
                if (!gsIsValidPayload(remoteRaw)) return { error: 'Existing Drive file is not a my-notepad backup.' };
                const local = gsNormalizePayload(gsBuildPayload());
                const remote = gsNormalizePayload(remoteRaw);
                const merged = gsMergePayloads(local, remote);
                const remoteIdx = gsParseIndex(remote.notes);
                const mergedIdx = gsParseIndex(merged.notes);
                const localIdx = gsParseIndex(local.notes);
                const added = Object.keys(mergedIdx).filter(function(n) { return !gsOwn(localIdx, n); });
                const removed = Object.keys(localIdx).filter(function(n) { return !gsOwn(mergedIdx, n); });
                const changed = Object.keys(merged.files).filter(function(k) {
                    return String(local.files[k]) !== String(merged.files[k]);
                });
                return {
                    wouldUpload: !gsSameContent(gsNormalizePayload({
                        notes: merged.notes, files: merged.files, savedAt: local.savedAt, times: merged.times
                    }), remote),
                    notesFromDrive: added,
                    notesRemovedHere: removed,
                    pagesPulledFromDrive: changed,
                    mergedNoteCount: Object.keys(mergedIdx).length,
                    remoteNoteCount: Object.keys(remoteIdx).length
                };
            });
        });
    },
    // Ask Drive directly with the current token and print the raw answer
    probe: function() {
        const token = gsToken || gsLoadToken();
        if (!token) {
            console.log('[probe] No access token yet — click "Sync now" and approve once, then re-run myNotepadGoogle.probe()');
            return Promise.resolve(null);
        }
        const url = 'https://www.googleapis.com/drive/v3/files?q=' +
            encodeURIComponent("name='" + GS_CONFIG.backupFileName + "' and trashed=false") +
            '&fields=files(id,name,modifiedTime)';
        return fetch(url, { headers: gsAuthHeaders(token) }).then(function(r) {
            console.log('[probe] HTTP', r.status, r.statusText);
            return r.text().then(function(t) {
                try { console.log('[probe] body', JSON.parse(t)); }
                catch (e) { console.log('[probe] body', t); }
                return t;
            });
        });
    }
};
