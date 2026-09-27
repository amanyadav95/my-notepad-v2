var notes = {
    // "Chapter1":["c1 page1","c1 page2","c1 page3"],
    // "Chapter2":[],
}
var activeNote = "";
var activePage = "";

const NOTES_INDEX_KEY = "notes_index";
const FILE_KEY_PREFIX = "note_file_";

const sidebar = document.querySelector('.side-nev');
sidebar.addEventListener('input', function(event) {
    if (event.target && event.target.matches('input[type="text"]')) {
        const input = event.target;
        const regex = /[^a-zA-Z0-9 ]/g;
        if (regex.test(input.value)) {
            input.value = input.value.replace(regex, '');
            showToast("Please do not use special Special characters.", "danger");
        }
    }
});

function showToast(message, type = 'success') {
    const toastEl = document.getElementById('liveToast');
    const toastBody = document.getElementById('toastBody');
    toastBody.innerText = message;
    toastEl.classList.remove('text-bg-success', 'text-bg-danger', 'text-bg-warning', 'text-bg-info');
    toastEl.classList.add(`text-bg-${type}`);
    const toast = new bootstrap.Toast(toastEl, {
        delay: 2500, // 2.5 seconds
        autohide: true
    });
    toast.show();
}

/* ---------------------- localStorage helpers ---------------------- */

function fileKey(ttl, pageName) {
    return `${FILE_KEY_PREFIX}${ttl}__${pageName}`;
}

function loadNotesFromStorage() {
    try {
        const raw = localStorage.getItem(NOTES_INDEX_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error('Failed to load notes index', e);
        return {};
    }
}

function saveNotesToStorage() {
    try {
        localStorage.setItem(NOTES_INDEX_KEY, JSON.stringify(notes));
        if (typeof gsMarkChange === 'function') gsMarkChange(NOTES_INDEX_KEY); // merge: newest change wins
        if (typeof scheduleSync === 'function') scheduleSync(); // Google Drive auto-sync
        return true;
    } catch (e) {
        console.error('Failed to save notes index', e);
        return false;
    }
}

function saveFileToStorage(ttl, pageName, text) {
    try {
        localStorage.setItem(fileKey(ttl, pageName), JSON.stringify({
            note_name: ttl,
            page_name: pageName,
            text_note: text
        }));
        if (typeof gsMarkChange === 'function') gsMarkChange(fileKey(ttl, pageName)); // merge: newest edit wins
        if (typeof scheduleSync === 'function') scheduleSync(); // Google Drive auto-sync
        return true;
    } catch (e) {
        console.error('Failed to save file data', e);
        return false;
    }
}

function getFileFromStorage(ttl, pageName) {
    try {
        const raw = localStorage.getItem(fileKey(ttl, pageName));
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error('Failed to read file data', e);
        return {};
    }
}

function deleteFileFromStorage(ttl, pageName) {
    const key = fileKey(ttl, pageName);
    localStorage.removeItem(key);
    if (typeof gsMarkChange === 'function') gsMarkChange(key); // deletions are merged too
}

// Persist unsaved editor text before a PWA update reloads the page
window.addEventListener('pwa:before-reload', function() {
    try {
        const editor = document.getElementById('fileText');
        const saveBtn = document.getElementById('saveNote');
        if (!editor || editor.disabled || !saveBtn) return;
        if (saveBtn.textContent.trim() !== 'Save') return; // "Edit"/empty = nothing unsaved
        if (!activeNote || !activePage) return;
        if (editor.value) saveFileToStorage(activeNote, activePage, editor.value);
    } catch (e) {
        console.error('Failed to save before update reload', e);
    }
});

/* -------------------------------------------------------------------- */

$(document).ready(function() {
    notes = loadNotesFromStorage();
    showIndex();

    // "My-NoTeS" headings (mobile top bar + sidebar) work as a Home button
    document.querySelectorAll('.home-title').forEach(function(el) {
        el.addEventListener('click', goHome);
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                goHome();
            }
        });
    });

    // Home screen shortcut: open the sidebar on phones and start a new note
    $('#homeNewNote').on('click', function() {
        openSidebar();
        $('#newNote').trigger('click');
        $('#newNoteTitle').trigger('focus');
    });

    // Keep the home-screen hint in sync when crossing the phone/desktop breakpoint
    const phoneMq = window.matchMedia('(max-width: 767.98px)');
    if (phoneMq.addEventListener) phoneMq.addEventListener('change', updateHomeScreen);
    else if (phoneMq.addListener) phoneMq.addListener(updateHomeScreen);
});

function updateIndex(type) {
    const ok = saveNotesToStorage();
    if (ok) {
        let msg = (type == 'note') ? 'New Note created.' : 'New File created.';
        showToast(msg, 'success');
    }else{
        showToast('Something went wrong.', 'danger');
    }
}

$('#newNote').click(function() {
    $('#newNoteTitle, #newNoteAdd').show();
});

$('#newNoteTitle').on('blur', function() {
    let newNote = ($('#newNoteTitle').val()).replaceAll(" ", "-");
    if (newNote != '') {
        if (notes[newNote] == undefined) {
            notes = { [newNote]: [], ...notes }; // new note appears on top of the list
            updateIndex('note');
            showIndex();
        }else {
            showToast('Note title already exist.', 'danger');
        }
        $('#newNoteTitle').val('');
    }
    $('#newNoteTitle, #newNoteAdd').hide();
});

// Pressing Enter in the "new note" / "new file" inputs creates it,
// doing exactly the same work as the blur handlers below
$(document).on('keydown', '#newNoteTitle, .new-file-input', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        this.blur(); // fires the existing onblur / jQuery blur logic
    }
});

// "Add" button next to the input does the same work as blur / Enter
$('#newNoteAdd').on('click', function() {
    $('#newNoteTitle').trigger('blur');
});

function showIndex() {
    let html = ``;
    $.each(notes, function(titles, pages) {
        let pagelist = `<button type="button" onclick="showNewFileInput('${titles}')" id="newFile-${titles}" class="btn btn-outline-primary btn-sm ${titles} m-1">+ file</button>
                        <div class="input-group input-group-sm">
                            <input onblur="createFile('${titles}')" id="newFileTitle-${titles}" type="text" class="form-control input-group-sm hide ${titles} new-file-input" placeholder="File Name" maxlength="60">
                            <button type="button" id="newFileAdd-${titles}" class="btn btn-sm btn-outline-primary hide" onclick="createFile('${titles}')">Add</button>
                        </div>`;
        $.each(pages, function(key, pageName) {
            pagelist += `<button onclick="selectFile('${titles}','${key}')" id="${titles}-${key}" type="button" class="${(pageName == activePage && titles == activeNote) ? 'active-file' : ''} select-file list-group-item list-group-item-action btn-sm border-0">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-file-earmark-text me-1" viewBox="0 0 16 16">
                                <path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5"/>
                                <path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>
                            </svg>
                            ${pageName.replaceAll("-", " ")}
                            <span onclick="deleteFile(event, '${titles}','${key}')" class="delete-file-btn float-end text-danger" title="Delete file">&times;</span>
                        </button>`;
        })
        html += `<div class="list-group mb-1">
                    <button onclick="selectNotee('${titles}')" id="${titles}-btn" type="button" class="${(titles == activeNote) ? 'active-note-btn' : ''} select-note-btn list-group-item list-group-item-action btn-sm" aria-current="true">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-journals" viewBox="0 0 16 16">
                            <path d="M5 0h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2 2 2 0 0 1-2 2H3a2 2 0 0 1-2-2h1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1H1a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1H3a2 2 0 0 1 2-2"/>
                            <path d="M1 6v-.5a.5.5 0 0 1 1 0V6h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V9h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 2.5v.5H.5a.5.5 0 0 0 0 1h2a.5.5 0 0 0 0-1H2v-.5a.5.5 0 0 0-1 0"/>
                        </svg>
                        ${titles.replaceAll("-", " ")}
                        <span onclick="deleteNote(event, '${titles}')" class="delete-note-btn float-end text-danger" title="Delete note">&times;</span>
                    </button>
                    <div class=" ${activeNote == titles ? 'active-note-div' : 'hide'} page-list-div border-l-b" id="${titles}">${pagelist}</div>
                </div>`;
    })
    $("#indexListing").html(html);
    updateHomeScreen();
}

/* Home screen vs. editor: the feature overview is shown whenever no file is
   open, so the empty title/textarea is never seen on the home screen */
function updateHomeScreen() {
    const home = !activePage;
    $('#homeScreen').css('display', home ? 'flex' : 'none');
    $('#editorInputs').css('display', home ? 'none' : 'flex');

    const hint = document.getElementById('homeHint');
    if (hint) {
        const phone = window.matchMedia('(max-width: 767.98px)').matches;
        if (home && activeNote) {
            const name = activeNote.replaceAll('-', ' ');
            hint.textContent = phone
                ? 'Tap ☰ and pick a file inside "' + name + '",\nor tap + file to add one.'
                : 'Select a file inside "' + name + '",\nor add a new one.';
        } else {
            hint.textContent = phone
                ? 'Tap ☰ to see your notes,\nor start a new note.'
                : 'Select a file to open it,\nor start a new note.';
        }
    }

    renderRecents();
}

/* ---------------------- recent files (home screen) ----------------------
   The 5 files opened or saved most recently, newest first. Stored locally
   as [{n: noteKey, p: pageName, t: savedAt}]; entries whose note/file no
   longer exists are dropped when the list is rendered. */
const RECENT_FILES_KEY = 'recent_files';
const RECENT_FILES_MAX = 5;

function getRecents() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function recordRecent(noteKey, pageName) {
    if (!noteKey || !pageName) return;
    const list = getRecents().filter(function(r) {
        if (!r || !notes[r.n] || notes[r.n].indexOf(r.p) < 0) return false; // drop deleted files
        return !(r.n === noteKey && r.p === pageName);
    });
    list.unshift({ n: noteKey, p: pageName, t: Date.now() });
    try {
        localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list.slice(0, RECENT_FILES_MAX)));
    } catch (e) { /* storage full/blocked — recents are optional */ }
}

/* Document glyph for the recent rows (same icon the sidebar uses) */
const FILE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" class="bi bi-file-earmark-text" viewBox="0 0 16 16">'
    + '<path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5"/>'
    + '<path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>'
    + '</svg>';

/* "just now" / "6h ago" / "2d ago" / "12 Sep" label on the right of a row */
function relTime(ts) {
    if (!ts) return '';
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    const days = Math.floor(secs / 86400);
    if (days < 7) return days + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderRecents() {
    const wrap = document.getElementById('recentWrap');
    const box = document.getElementById('recentFiles');
    if (!wrap || !box) return;

    const phone = window.matchMedia('(max-width: 767.98px)').matches;
    const items = getRecents().filter(function(r) {
        return r && notes[r.n] && notes[r.n].indexOf(r.p) >= 0;
    }).slice(0, RECENT_FILES_MAX);

    box.innerHTML = '';
    items.forEach(function(r) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'recent-row';
        row.title = 'Open "' + r.p.replaceAll('-', ' ') + '"';

        const icon = document.createElement('span');
        icon.className = 'rr-icon';
        icon.innerHTML = FILE_ICON_SVG; // fixed markup, contains no user data

        const body = document.createElement('span');
        body.className = 'rr-body';
        const file = document.createElement('span');
        file.className = 'rr-name';
        file.textContent = r.p.replaceAll('-', ' ');
        const note = document.createElement('span');
        note.className = 'rr-note';
        note.textContent = 'in ' + r.n.replaceAll('-', ' ');
        body.appendChild(file);
        body.appendChild(note);

        const time = document.createElement('span');
        time.className = 'rr-time';
        time.textContent = relTime(r.t);

        row.appendChild(icon);
        row.appendChild(body);
        row.appendChild(time);
        row.addEventListener('click', function() { openRecent(r.n, r.p); });
        box.appendChild(row);
    });

    // Keep the section when it has rows, or on phones (it holds the "New note" row)
    wrap.style.display = (items.length || phone) ? '' : 'none';
}

/* Open a file from the home-screen recent list: select its note first so the
   sidebar state (highlights, page list) stays consistent, then open the file */
function openRecent(noteKey, pageName) {
    if (!notes[noteKey]) {
        showToast('That note no longer exists.', 'danger');
        return;
    }
    const idx = notes[noteKey].indexOf(pageName);
    if (idx < 0) {
        showToast('That file no longer exists.', 'danger');
        return;
    }
    selectNotee(noteKey);
    selectFile(noteKey, idx);
}

/* Home screen: deselect the note and the file, collapse the page lists and
   clear the editor. Bound to the "My-NoTeS" headings (top bar + sidebar) */
function goHome() {
    activeNote = '';
    activePage = '';
    $('#fileTitle').val('').prop('disabled', true);
    $('#fileText').val('').prop('disabled', true);
    $('#saveNote').text('');
    showIndex();
}

function selectNotee(ttl) {
    $('.select-note-btn').removeClass('active-note-btn');
    $('.page-list-div').removeClass('active-note-div').hide();
    $(`#${ttl}-btn`).addClass('active-note-btn');
    $(`#${ttl}`).addClass('active-note-div');
    activeNote = ttl;
    activePage = '';
    $('#fileTitle').val('');
    $('#fileText').val('').prop('disabled', true);
    $("#saveNote").text('');
    $(`#${ttl}`).show();
    updateHomeScreen(); // no file open yet → show the feature overview
}

function showNewFileInput(ttl) {
    $(`#newFileTitle-${ttl}, #newFileAdd-${ttl}`).show();
}

function createFile(ttl) {
    let newFileInput = $(`#newFileTitle-${ttl}`);
    if (newFileInput.val() != '') {
        let fileName = (newFileInput.val()).replaceAll(" ", "-");
        if (notes[ttl].includes(fileName)) {
            showToast('File with this name already exist.', 'danger');
        }else{
            notes[ttl].unshift(fileName); // new file appears on top of the list
            updateIndex('file');
            showIndex();
        }
    }
    $(`#newFileTitle-${ttl}, #newFileAdd-${ttl}`).hide();
}

function selectFile(ttl, pgs) {
    activePage = notes[ttl][pgs];
    activeNote = ttl;
    $('#fileTitle').val(activePage);
    $('#fileText').val('').prop('disabled', false);
    $('.select-file').removeClass('active-file');
    $(`#${ttl}-${pgs}`).addClass('active-file');
    let file = getFileFromStorage(ttl, activePage);
    viewPage(file);
    recordRecent(ttl, activePage);   // keeps the home-screen "Recent files" list fresh
    updateHomeScreen(); // file open → hide the feature overview
    closeSidebarOnMobile();
}

$(`#saveNote`).on('click', function() {
    let text = $('#fileText').val();
    let title = $('#fileTitle').val();

    if (text != '' && $("#saveNote").text() == 'Save') {
        let file = {'note_name': activeNote, 'page_name': activePage, 'text_note': text};
        const ok = saveFileToStorage(activeNote, activePage, text);
        if (ok) {
            recordRecent(activeNote, activePage); // a save counts as a recent hit too
            let msg = 'File save succesfuly.';
            showToast(msg, 'success');
            viewPage(file);
        }else{
            showToast('Something went wrong.', 'danger');
        }
    }else if ($("#saveNote").text() == 'Edit') {
        $('#fileText').prop('disabled', false);
        $("#saveNote").text('Save');
    }
});

function viewPage(pageData) {
    if (Object.keys(pageData).length === 0) {
        $("#saveNote").text('Save');
    }else{
        $('#fileText').val(pageData.text_note);
        $("#saveNote").text('Edit');
        $('#fileText').prop('disabled', true);
    }
}

/* ---------------------- delete functionality ---------------------- */

function deleteNote(event, ttl) {
    event.stopPropagation();
    showConfirmToast(`Delete note "${ttl.replaceAll("-", " ")}" and all its files? This cannot be undone.`, function(confirmed) {
        // User confirmed - proceed with deletion
        if (!confirmed) return;
        (notes[ttl] || []).forEach(function(pageName) {
            deleteFileFromStorage(ttl, pageName);
        });

        delete notes[ttl];
        const ok = saveNotesToStorage();

        if (ok) {
            if (activeNote === ttl) {
                activeNote = '';
                activePage = '';
                $('#fileTitle').val('');
                $('#fileText').val('').prop('disabled', true);
                $("#saveNote").text('');
            }
            showToast('Note deleted.', 'success');
            showIndex();
        } else {
            showToast('Something went wrong.', 'danger');
        }
    });
}

function deleteFile(event, ttl, pgs) {
    event.stopPropagation();
    const pageName = notes[ttl][pgs];
    showConfirmToast(
        `Delete file "${pageName.replaceAll("-", " ")}"? This cannot be undone.`,
        function(confirmed) {
            // User confirmed - proceed with deletion
            if (!confirmed) return;
            deleteFileFromStorage(ttl, pageName);
            notes[ttl].splice(pgs, 1);
            const ok = saveNotesToStorage();

            if (ok) {
                if (activeNote === ttl && activePage === pageName) {
                    activePage = '';
                    $('#fileTitle').val('');
                    $('#fileText').val('').prop('disabled', true);
                    $("#saveNote").text('');
                }
                showToast('File deleted.', 'success');
                showIndex();
                if (activeNote === ttl) {
                    selectNotee(ttl);
                }
            } else {
                showToast('Something went wrong.', 'danger');
            }
        }
    );
}

/**
 * Show a toast-based confirmation dialog.
 * The toast stays open until the user clicks a button.
 * @param {string} message - The confirmation message
 * @param {Function} onConfirmed - Called with true when "Take action" clicked, false when "Close" clicked
 */
function showConfirmToast(message, onConfirmed) {
    const toastEl = document.getElementById('confirmToast');
    const toastBody = document.getElementById('confirmToastBody');
    const toastTakeAction = document.getElementById('toastTakeAction');
    const toastCloseBtn = document.getElementById('toastCloseBtn');

    if (!toastEl || !toastBody) {
        // Fallback: element missing (e.g. stale cached page) — fall back to browser confirm
        onConfirmed(confirm(message));
        return;
    }

    toastBody.innerText = message;

    // Reuse the existing Bootstrap Toast instance if one exists on this element
    let bsToast = bootstrap.Toast.getInstance ? bootstrap.Toast.getInstance(toastEl) : null;
    if (!bsToast) {
        bsToast = new bootstrap.Toast(toastEl, { autohide: true, delay: 8000 });
    }

    // "Take action" — confirm and close
    toastTakeAction.onclick = function() {
        bsToast.hide();
        onConfirmed(true);
    };

    // "Close" — cancel and close
    if (toastCloseBtn) {
        toastCloseBtn.onclick = function() {
            bsToast.hide();
            onConfirmed(false);
        };
    }

    bsToast.show();
}

/* ---------------------- mobile sidebar drawer ---------------------- */

function openSidebar() {
    $('#sideNevCol').addClass('open');
    $('#sidebarOverlay').addClass('show');
}

function toggleSidebar() {
    $('#sideNevCol').toggleClass('open');
    $('#sidebarOverlay').toggleClass('show');
}

function closeSidebar() {
    $('#sideNevCol').removeClass('open');
    $('#sidebarOverlay').removeClass('show');
}

function closeSidebarOnMobile() {
    if (window.matchMedia('(max-width: 767.98px)').matches) {
        closeSidebar();
    }
}