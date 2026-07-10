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
    $("#newNoteTitle").show();
});

$('#newNoteTitle').on('blur', function() {
    let newNote = ($('#newNoteTitle').val()).replaceAll(" ", "-");
    if (newNote != '') {
        if (notes[newNote] == undefined) {
            notes[newNote] = [];
            updateIndex('note');
            showIndex();
        }else {
            showToast('Note title already exist.', 'danger');
        }
        $('#newNoteTitle').val('');
    }
    $("#newNoteTitle").hide();
});

function showIndex() {
    let html = ``;
    $.each(notes, function(titles, pages) {
        let pagelist = `<button type="button" onclick="showNewFileInput('${titles}')" id="newFile-${titles}" class="btn btn-outline-primary btn-sm ${titles} m-1">+ file</button>
                        <div class="input-group input-group-sm">
                            <input onblur="createFile('${titles}')" id="newFileTitle-${titles}" type="text" class="form-control input-group-sm hide ${titles} new-file-input" placeholder="File Name" maxlength="60">
                        </div>`;
        $.each(pages, function(key, pageName) {
            pagelist += `<button onclick="selectFile('${titles}','${key}')" id="${titles}-${key}" type="button" class="${(pageName == activePage && titles == activeNote) ? 'active-file' : ''} select-file list-group-item list-group-item-action btn-sm border-0">${pageName.replaceAll("-", " ")}
                            <span onclick="deleteFile(event, '${titles}','${key}')" class="delete-file-btn float-end text-danger" title="Delete file">&times;</span>
                        </button>`;
        })
        html += `<div class="list-group mb-1">
                    <button onclick="selectNotee('${titles}')" id="${titles}-btn" type="button" class="${(titles == activeNote) ? 'active-note-btn' : ''} select-note-btn list-group-item list-group-item-action btn-sm" aria-current="true">
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
    $(`#newFileTitle-${ttl}`).show();
}

function createFile(ttl) {
    let newFileInput = $(`#newFileTitle-${ttl}`);
    if (newFileInput.val() != '') {
        let fileName = (newFileInput.val()).replaceAll(" ", "-");
        if (notes[ttl].includes(fileName)) {
            showToast('File with this name already exist.', 'danger');
        }else{
            notes[ttl].push(fileName);
            updateIndex('file');
            showIndex();
        }
    }
    newFileInput.hide();
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