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
    localStorage.removeItem(fileKey(ttl, pageName));
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
            pagelist += `<button onclick="selectFile('${titles}','${key}')" id="${titles}-${key}" type="button" class="${(pageName == activePage && titles == activeNote) ? 'active-file' : ''} select-file list-group-item list-group-item-action btn-sm border-0">${pageName.replaceAll("-", " ")}
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-file-earmark-text" viewBox="0 0 16 16">
                                <path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5"/>
                                <path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>
                            </svg>
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
    closeSidebarOnMobile();
}

$(`#saveNote`).on('click', function() {
    let text = $('#fileText').val();
    let title = $('#fileTitle').val();

    if (text != '' && $("#saveNote").text() == 'Save') {
        let file = {'note_name': activeNote, 'page_name': activePage, 'text_note': text};
        const ok = saveFileToStorage(activeNote, activePage, text);
        if (ok) {
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
    if (!confirm(`Delete note "${ttl.replaceAll("-", " ")}" and all its files? This cannot be undone.`)) {
        return;
    }

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
    }else{
        showToast('Something went wrong.', 'danger');
    }
}

function deleteFile(event, ttl, pgs) {
    event.stopPropagation();
    const pageName = notes[ttl][pgs];
    if (!confirm(`Delete file "${pageName.replaceAll("-", " ")}"? This cannot be undone.`)) {
        return;
    }

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
    }else{
        showToast('Something went wrong.', 'danger');
    }
}

/* ---------------------- mobile sidebar drawer ---------------------- */

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