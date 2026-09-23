/* ==========================================================================
   Google Drive sync for my-notepad-v2
   - Sign in with Google (Identity Services button)
   - Backs up notes + files as a visible JSON file in the user's My Drive
   - Auto-syncs a few seconds after any change, plus "Sync now" / "Restore"
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

let gsUser = null;
let gsToken = null;
let gsTokenExpiresAt = 0;
let gsTokenClient = null;
let gsSyncTimer = null;
let gsConsentHintShown = false;

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
}

function gsRenderLastSync() {
    const el = document.getElementById('gsLastSync');
    if (!el) return;
    const raw = localStorage.getItem(GS_LAST_SYNC_KEY);
    el.textContent = raw ? 'Last synced: ' + gsRelativeTime(new Date(raw)) : 'Not synced yet';
}

function gsMarkSynced() {
    localStorage.setItem(GS_LAST_SYNC_KEY, new Date().toISOString());
    gsRenderLastSync();
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
    // Instruction toast doubles as the consent hint for the first sync
    gsConsentHintShown = true;
    gsToast('Signed in as ' + gsUser.name + '. Click "Sync now" to allow Drive access.', 'info');
    // If Drive access was granted before, this syncs silently right away
    gsSyncToDrive(false).then(function(ok) {
        if (ok) gsToast('Synced to Google Drive.', 'success');
    });
}

function gsRequestToken(prompt) {
    return new Promise(function(resolve) {
        if (!gsTokenClient) return resolve(null);
        try {
            gsTokenClient.requestAccessToken({
                prompt: prompt,
                callback: function(resp) {
                    if (resp && resp.access_token) {
                        gsToken = resp.access_token;
                        gsTokenExpiresAt = Date.now() + Math.max(60, (resp.expires_in || 3600) - 60) * 1000;
                        resolve(gsToken);
                    } else {
                        console.warn('[GS] no access token', resp && resp.error);
                        resolve(null);
                    }
                },
                error_callback: function(err) {
                    console.error('[GS] token request error', err);
                    resolve(null);
                }
            });
        } catch (e) {
            console.error('[GS] token request failed', e);
            resolve(null);
        }
    });
}

async function gsEnsureToken(interactive) {
    if (gsToken && Date.now() < gsTokenExpiresAt) return gsToken;
    let token = await gsRequestToken('');          // silent (already granted?)
    if (!token && interactive) {
        token = await gsRequestToken('consent');   // show the consent screen
    }
    return token;
}

function gsSignOut() {
    const token = gsToken;
    gsToken = null;
    gsTokenExpiresAt = 0;
    localStorage.removeItem(GS_USER_KEY);
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

async function gsFindBackup(token) {
    const q = "name='" + GS_CONFIG.backupFileName + "' and trashed=false";
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
                '&fields=files(id,name,modifiedTime)';
    const r = await fetch(url, { headers: gsAuthHeaders(token) });
    if (!r.ok) throw new Error('Drive list failed (' + r.status + ')');
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
        version: 1,
        savedAt: new Date().toISOString(),
        notes: localStorage.getItem(GS_INDEX_KEY),  // raw string or null
        files: files
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
    if (!r.ok) throw new Error('Drive create failed (' + r.status + ')');
}

async function gsUpdateFile(token, fileId, payload) {
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', {
        method: 'PATCH',
        headers: Object.assign(gsAuthHeaders(token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('Drive update failed (' + r.status + ')');
}

async function gsDownload(token, fileId) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
        headers: gsAuthHeaders(token)
    });
    if (!r.ok) throw new Error('Backup download failed (' + r.status + ')');
    return r.json();
}

/* --------------------------- sync / restore ----------------------------- */

async function gsSyncToDrive(interactive) {
    if (!gsUser) return false;
    const token = await gsEnsureToken(interactive);
    if (!token) {
        if (interactive) {
            gsToast('Google permission is required to sync.', 'danger');
        } else if (!gsConsentHintShown) {
            gsConsentHintShown = true;
            gsToast('Google sync needs one-time permission — click "Sync now".', 'info');
        }
        return false;
    }
    try {
        const payload = gsBuildPayload();
        const fileId = await gsFindBackup(token);
        if (fileId) await gsUpdateFile(token, fileId, payload);
        else await gsCreateFile(token, payload);
        gsMarkSynced();
        if (interactive) gsToast('Synced to Google Drive.', 'success');
        return true;
    } catch (e) {
        console.error('[GS] sync failed:', e);
        if (interactive) gsToast('Google sync failed: ' + (e.message || e), 'danger');
        return false;
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
    gsUpdateUserUi();

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
                callback: function() { /* per-request callbacks are used instead */ }
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
