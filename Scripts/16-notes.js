/*
 NOTES MODULE
 A note comes from text selected while reading (bookId/bookTitle recorded so it stays traceable even if
 the book is later deleted) or is created manually from the Notes page with an optional book link.

 Organized by TAGS rather than a single group: a note can carry any number of manual tags (note.tagIds,
 referencing STORE_NOTE_GROUPS rows - schema name unchanged, just user-facing "tags" now instead of
 "group"). Any note linked to a book also gets a derived "book tag" (never stored, computed at render
 time from bookId/bookTitle + that book's group color).

 IndexedDB is the source of truth; notes/tags mirror to Firebase the same way books/groups do.
*/

let loadedNotesMemory = [];
let loadedNoteTagsMemory = [];

/**
 Keys of tag sections collapsed on the Notes page. Empty = everything expanded (inverse of an "expanded"
 set, so new tags start expanded with no bookkeeping). "none" = untagged bucket, "all" = All Notes
 section, `book:<bookId>` = a book auto-tag. Persisted to localStorage so layout survives reloads.
*/
const COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY = Config.Db.COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY;

function loadCollapsedNoteTagKeys() {
  return new Set(loadJsonArrayFromLocalStorage(COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY));
}

function saveCollapsedNoteTagKeys() {
  saveJsonArrayToLocalStorage(COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY, Array.from(collapsedNoteTagKeys));
}

let collapsedNoteTagKeys = loadCollapsedNoteTagKeys();

let noteSelectionButton = null;

/**
 Matches touch-primary devices (phones/tablets) as opposed to a mouse-driven desktop. Used to decide
 which side of the selection the "Add Note" button renders on. A live MediaQueryList rather than a
 one-time boolean so a device switching input modes (e.g. a touch laptop with a mouse plugged in) is
 reflected without a reload.
*/
const NOTE_SELECTION_BUTTON_TOUCH_MEDIA_QUERY = window.matchMedia("(hover: none) and (pointer: coarse)");

const NOTE_SELECTION_BUTTON_TOUCH_OFFSET_PX = Config.Miscellaneous.NOTE_SELECTION_BUTTON_TOUCH_OFFSET_PX;
let noteEditorBookContext = { bookId: null, bookTitle: null };
let noteEditorEditingNoteId = null; // null while creating; set to a note id while editing that note
let noteTagPickerNoteId = null; // which note "Move Note (Tag)" is currently acting on

const LAST_NOTE_TAGS_STORAGE_KEY = Config.Db.LAST_NOTE_TAGS_STORAGE_KEY;

// -----------------------------------------------------------------
// DATABASE LOAD / REFRESH
// -----------------------------------------------------------------
/** Reloads notes and note tags from IndexedDB into memory and re-renders any currently open views. */
async function fetchNotesLibrary() {
  if (!db) return;
  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readonly");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const noteTagsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  const [notes, tags] = await Promise.all([
    getAllFromStore(notesStore),
    getAllFromStore(noteTagsStore),
  ]);
  loadedNotesMemory = notes;
  loadedNoteTagsMemory = tags;

  renderNotesPageIfOpen();
  // Fire-and-forget backfill for notes/note tags created before lastModified was stamped at write
  // time - a no-op once every record already has one, so safe to call on every fetch.
  if (typeof migrateMissingNoteLastModified === "function") {
    migrateMissingNoteLastModified();
  }
}

/**
 Backfills a lastModified onto any note or note tag that predates that field. dateCreated is the best
 available "when was this actually touched" signal for a note (there's no equivalent of a book's
 lastOpened for notes), so it's used as the backfilled value rather than an arbitrary "right now" that
 would make an old, untouched note look freshly edited.
*/
function migrateMissingNoteLastModified() {
  backfillMissingField(
    STORE_NOTES,
    (note) => !note.lastModified,
    (note) => note.dateCreated || Date.now(),
    "lastModified",
    typeof pushNoteToCloud === "function" ? pushNoteToCloud : null,
  );
  backfillMissingField(
    STORE_NOTE_GROUPS,
    (tag) => !tag.lastModified,
    () => Date.now(),
    "lastModified",
    typeof pushNoteTagToCloud === "function" ? pushNoteTagToCloud : null,
  );
}

/** Re-renders the Notes page and/or tag-management list only if they're actually visible right now. */
function renderNotesPageIfOpen() {
  const notesView = document.getElementById("notes-view");
  if (notesView && notesView.style.display === "flex") {
    renderNotesPage();
  }
  const manageModal = document.getElementById("note-tag-manage-modal");
  if (manageModal && manageModal.open) {
    renderNoteTagManageList();
  }
}

// -----------------------------------------------------------------
// VIEW ROUTING
// -----------------------------------------------------------------
function showNotesViewState() {
  document.getElementById("library-view").style.display = "none";
  document.getElementById("reader-view").style.display = "none";
  document.getElementById("stats-view").style.display = "none";
  document.getElementById("notes-view").style.display = "flex";
  renderNotesPage();
}

// -----------------------------------------------------------------
// ADD NOTE FROM SELECTED TEXT
// -----------------------------------------------------------------
document.getElementById("reader-container").addEventListener("mouseup", handlePossibleTextSelectionForNote);
document.getElementById("reader-container").addEventListener("touchend", handlePossibleTextSelectionForNote);
// The button's position is only valid for the scroll offset it was drawn
// at, so treat any scroll inside the reading pane as reason to drop it.
document.getElementById("reader-container").addEventListener("scroll", removeNoteSelectionButton);

function handlePossibleTextSelectionForNote() {
  // A tiny delay lets the browser finish updating window.getSelection()
  // before this reads it - reading it synchronously on mouseup/touchend can
  // still reflect the previous selection on some browsers.
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";
    const container = document.getElementById("reader-container");

    if (!text || !activeBookObject || selection.rangeCount === 0 || !container.contains(selection.anchorNode)) {
      removeNoteSelectionButton();
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    showNoteSelectionButton(rect, text);
  }, 10);
}

function showNoteSelectionButton(rect, selectedText) {
  removeNoteSelectionButton();

  const btn = document.createElement("button");
  btn.id = "note-selection-trigger-btn";
  btn.className = "note-selection-trigger-btn";
  btn.innerText = "📝 Add Note";

  /*
   On touch devices the OS draws its own selection toolbar (copy/cut/paste) directly above the selection
   rect, the same spot this button used to claim, so the two would overlap and the OS toolbar always won
   out. Placing the button below the selection instead leaves that native toolbar untouched and still
   puts the button somewhere the user is already looking. Desktop mouse selections have no such
   competing toolbar, so this keeps the original above-selection placement there, which reads more
   naturally next to a cursor.
  */
  if (NOTE_SELECTION_BUTTON_TOUCH_MEDIA_QUERY.matches) {
    btn.style.top = `${rect.bottom + NOTE_SELECTION_BUTTON_TOUCH_OFFSET_PX}px`;
  } else {
    btn.style.top = `${Math.max(8, rect.top - 38)}px`;
  }
  btn.style.left = `${rect.left}px`;

  // Without this, the mousedown that precedes the click collapses the
  // text selection before the click handler below ever gets to read it.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    openNoteEditorModal({
      selectedText,
      bookId: activeBookObject.id,
      bookTitle: activeBookObject.title,
    });
    removeNoteSelectionButton();
  });

  document.body.appendChild(btn);
  noteSelectionButton = btn;
}

function removeNoteSelectionButton() {
  if (noteSelectionButton) {
    noteSelectionButton.remove();
    noteSelectionButton = null;
  }
}

// Dismiss the floating button on any click elsewhere, but not on the mousedown
// that's actually targeting the button itself (see the preventDefault above).
document.addEventListener("mousedown", (e) => {
  if (noteSelectionButton && e.target !== noteSelectionButton) {
    removeNoteSelectionButton();
  }
});

// -----------------------------------------------------------------
// NOTE EDITOR MODAL (shared by the selection flow, manual creation, and
// editing an existing note)
// -----------------------------------------------------------------
/** Opens the note editor for a brand new manually-created note, with no book or tags preselected. */
function openManualNoteCreationModal() {
  // Manual creation always defaults to no book and no tags, regardless of whatever was last used
  // from the in-reader selection flow.
  openNoteEditorModal({ selectedText: "", bookId: null, bookTitle: null, tagIds: [] });
}

/** Opens the shared note editor modal, populated for either a new note or an existing one to edit. */
function openNoteEditorModal({
  selectedText = "",
  comment = "",
  bookId = null,
  bookTitle = null,
  tagIds,
  editingNoteId = null,
} = {}) {
  noteEditorEditingNoteId = editingNoteId;
  noteEditorBookContext = { bookId, bookTitle };

  document.getElementById("note-editor-modal-heading").innerText = editingNoteId ? "Edit Note" : "Add Note";

  document.getElementById("note-editor-text-input").value = selectedText;
  document.getElementById("note-editor-comment-input").value = comment;

  const bookSelect = document.getElementById("note-editor-book-select");
  populateNoteEditorBookSelect(bookSelect, bookId);

  const resolvedTagIds = tagIds !== undefined ? tagIds : loadLastUsedNoteTagIds();
  const tagContainer = document.getElementById("note-editor-tags-container");
  populateNoteEditorTagCheckboxes(tagContainer, resolvedTagIds || []);

  document.getElementById("note-editor-modal").showModal();
}

// Lists every book in the library so a manually-created note can be linked to one (or left as "None").
// Book-originated notes get the originating book preselected here too, but the field stays editable.
function populateNoteEditorBookSelect(selectEl, selectedBookId) {
  selectEl.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.innerText = "None";
  selectEl.appendChild(noneOption);

  loadedBooksMemory.forEach((book) => {
    const opt = document.createElement("option");
    opt.value = String(book.id);
    opt.innerText = book.title;
    selectEl.appendChild(opt);
  });

  selectEl.value = selectedBookId != null ? String(selectedBookId) : "";
}

/** Multi-select checkbox list of the real (non-book) tags, so a note can carry any number at once instead of being limited to one.
 @param containerEl The <div> that will hold the checkboxes
 @param selectedTagIds An array of tag ids that should be pre-checked
*/
function populateNoteEditorTagCheckboxes(containerEl, selectedTagIds) {
  containerEl.innerHTML = "";

  if (loadedNoteTagsMemory.length === 0) {
    containerEl.innerHTML = `<div class="hint-text">No tags yet - create one from "🏷️ Manage Tags".</div>`;
    return;
  }

  const selectedSet = new Set((selectedTagIds || []).map(Number));

  loadedNoteTagsMemory.forEach((tag) => {
    const item = document.createElement("label");
    item.className = "note-editor-tag-checkbox-item";
    item.style.setProperty("--tag-tint", tag.color || "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(tag.id);
    checkbox.checked = selectedSet.has(tag.id);

    const span = document.createElement("span");
    span.innerText = tag.name;

    item.appendChild(checkbox);
    item.appendChild(span);
    containerEl.appendChild(item);
  });
}

/**
 Reads the IDs of the checked tag checkboxes from the container.
 @param containerEl The <div> containing the tag checkboxes
 @returns An array of checked tag IDs
 */
function readCheckedTagIdsFrom(containerEl) {
  return Array.from(containerEl.querySelectorAll("input[type='checkbox']:checked")).map((cb) =>
    parseInt(cb.value, 10),
  );
}

function closeNoteEditorModal() {
  document.getElementById("note-editor-modal").close();
}

/** Reads the note editor form and either updates the note being edited or creates a new one. */
function submitNoteEditorForm() {
  const text = document.getElementById("note-editor-text-input").value.trim();
  if (!text) {
    alert("Please enter some text for the note.");
    return;
  }

  const comment = document.getElementById("note-editor-comment-input").value.trim();

  const bookSelectValue = document.getElementById("note-editor-book-select").value;
  const bookId = bookSelectValue ? parseInt(bookSelectValue, 10) : null;
  const linkedBook = bookId != null ? loadedBooksMemory.find((b) => b.id === bookId) : null;
  // Falls back to whatever book title the note already carried (e.g. when editing a book-originated
  // note whose book has since been deleted and so no longer appears in the <select>) rather than
  // wiping it out.
  const bookTitle = linkedBook ? linkedBook.title : (bookId != null ? noteEditorBookContext.bookTitle : null);

  const tagIds = readCheckedTagIdsFrom(document.getElementById("note-editor-tags-container"));

  if (noteEditorEditingNoteId != null) {
    updateNoteFields(noteEditorEditingNoteId, {
      selectedText: text,
      comment,
      bookId,
      bookTitle,
      tagIds,
    });
    saveLastUsedNoteTagIds(tagIds);
    closeNoteEditorModal();
    return;
  }

  const entry = {
    selectedText: text,
    comment: comment,
    tagIds: tagIds,
    bookId: bookId,
    bookTitle: bookTitle,
    dateCreated: Date.now(),
    // Stamped at creation for the same reason edits stamp it - see updateNoteFields() below.
    lastModified: Date.now(),
  };

  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).add(entry).onsuccess = (e) => {
    entry.id = e.target.result;
  };
  transaction.oncomplete = () => {
    saveLastUsedNoteTagIds(tagIds);
    closeNoteEditorModal();
    fetchNotesLibrary();
    if (typeof pushNoteToCloud === "function") pushNoteToCloud(entry);
  };
}

function loadLastUsedNoteTagIds() {
  return loadJsonArrayFromLocalStorage(LAST_NOTE_TAGS_STORAGE_KEY).filter((n) => Number.isInteger(n));
}

function saveLastUsedNoteTagIds(tagIds) {
  saveJsonArrayToLocalStorage(LAST_NOTE_TAGS_STORAGE_KEY, tagIds || []);
}

// -----------------------------------------------------------------
// NOTES PAGE: TAG FILTER CHIPS + TAG-SECTIONED NOTE LIST
// -----------------------------------------------------------------
function renderNotesPage() {
  renderNotesList();
}

/** Every distinct book referenced by any current note gets its own (derived, not stored) auto-tag descriptor: {key, name, color}.*/
function collectBookAutoTags() {
  const byKey = new Map();
  loadedNotesMemory.forEach((note) => {
    if (note.bookId == null) return;
    const key = `book:${note.bookId}`;
    if (byKey.has(key)) return;
    const liveBook = loadedBooksMemory.find((b) => b.id === note.bookId);
    const liveGroup = liveBook && liveBook.groupId != null
      ? loadedGroupsMemory.find((g) => g.id === liveBook.groupId)
      : null;
    byKey.set(key, {
      key,
      name: (liveBook && liveBook.title) || note.bookTitle || "Unknown Book",
      color: liveGroup ? liveGroup.backgroundColor : null,
      isBookTag: true,
    });
  });
  return Array.from(byKey.values());
}

/**
 Returns every tag key a note belongs to: its manual tagIds plus a derived book auto-tag key if linked to a book.
 A note with neither falls into the "none" (untagged) bucket.
 @param note The note object to compute keys for
 @returns An array of tag keys (strings)
*/
function keysForNote(note) {
  const keys = (note.tagIds || []).slice();
  if (note.bookId != null) keys.push(`book:${note.bookId}`);
  return keys.length ? keys : ["none"];
}

function renderNotesList() {
  const container = document.getElementById("notes-list-container");
  container.innerHTML = "";

  if (loadedNotesMemory.length === 0) {
    container.innerHTML = `<div class="notes-empty-state">No notes yet. Select text while reading, or add one manually above.</div>`;
    return;
  }

  // "All Notes" is a pinned catch-all shown first, containing every note
  // regardless of tag - unlike the sections below it, it's never populated
  // by keysForNote() and always holds the full library of notes.
  const sections = [{ key: "all", name: "All Notes", color: null, notes: loadedNotesMemory.slice() }];

  // One section per real tag, one per distinct book auto-tag, plus a
  // trailing "Untagged" catch-all. A note with several tags appears in
  // every section it belongs to.
  loadedNoteTagsMemory.forEach((t) => {
    sections.push({ key: t.id, name: t.name, color: t.color, notes: [] });
  });
  collectBookAutoTags().forEach((bookTag) => {
    sections.push({ key: bookTag.key, name: `📖 ${bookTag.name}`, color: bookTag.color, notes: [] });
  });
  sections.push({ key: "none", name: "Untagged", color: null, notes: [] });

  loadedNotesMemory.forEach((note) => {
    keysForNote(note).forEach((key) => {
      const section = sections.find((s) => s.key === key);
      if (section) section.notes.push(note);
    });
  });

  sections.forEach((section) => {
    if (section.notes.length === 0) return;
    container.appendChild(buildNoteTagSection(section));
  });
}
/** Builds a section for a group of notes with the same tag. 
 * @param section An object with {key, name, color, notes} describing the tag and its notes
 * @returns {HTMLDivElement} A DOM element representing the section, ready to be appended to the notes list container
*/
function buildNoteTagSection(section) {
  const isCollapsed = collapsedNoteTagKeys.has(section.key);

  const wrapper = document.createElement("div");
  wrapper.className = "note-tag-section" + (isCollapsed ? " collapsed" : "");
  if (section.color) wrapper.style.setProperty("--tag-tint", section.color);

  const heading = document.createElement("div");
  heading.className = "note-tag-section-heading";

  /*
   This checkbox is the section's only control, doubling as both the
   visual "is this expanded" indicator and the click target - no separate
   button is layered on top of it. Checked means expanded (mirrors the
   ▼ Show More / ▲ Show Less convention used on note cards elsewhere in
   this file), so a brand new tag with no stored preference starts
   expanded by default with zero extra bookkeeping.
  */
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "note-tag-collapse-toggle";
  checkbox.checked = !isCollapsed;
  checkbox.title = isCollapsed ? "Expand section" : "Collapse section";
  checkbox.onchange = () => {
    if (checkbox.checked) {
      collapsedNoteTagKeys.delete(section.key);
    } else {
      collapsedNoteTagKeys.add(section.key);
    }
    saveCollapsedNoteTagKeys();
    renderNotesList();
  };

  const title = document.createElement("span");
  title.className = "note-tag-section-title";
  title.innerText = section.name;

  heading.appendChild(checkbox);
  heading.appendChild(title);
  wrapper.appendChild(heading);

  // While collapsed the section is just its colored line + heading -
  // the notes grid isn't rendered at all (rather than rendered and
  // hidden via CSS), so a collapsed section with hundreds of notes costs
  // nothing to keep around.
  if (!isCollapsed) {
    const grid = document.createElement("div");
    grid.className = "notes-grid";
    section.notes
      .slice()
      .sort((a, b) => (b.dateCreated || 0) - (a.dateCreated || 0))
      .forEach((note) => grid.appendChild(buildNoteCard(note)));

    wrapper.appendChild(grid);
  }

  return wrapper;
}
/** Builds a card for a single note.
 * @param note The note object to build a card for
 * @returns {HTMLDivElement} A DOM element representing the note card, ready to be appended to the notes list container
 */
function buildNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";

  const actionsTrigger = document.createElement("button");
  actionsTrigger.className = "note-card-actions-trigger";
  actionsTrigger.innerText = "⋮";
  actionsTrigger.title = "Note actions";
  actionsTrigger.onclick = (e) => toggleNoteContextMenuFlyout(e, note.id);
  card.appendChild(actionsTrigger);

  const hasBookTag = note.bookId != null;
  const hasManualTags = (note.tagIds || []).length > 0;

  if (hasBookTag || hasManualTags) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "note-card-tags-row";

    if (hasBookTag) {
      const liveBook = loadedBooksMemory.find((b) => b.id === note.bookId);
      const liveGroup = liveBook && liveBook.groupId != null
        ? loadedGroupsMemory.find((g) => g.id === liveBook.groupId)
        : null;
      const bookPill = document.createElement("span");
      bookPill.className = "note-card-tag-pill note-card-book-tag";
      if (liveGroup) bookPill.style.setProperty("--tag-tint", liveGroup.backgroundColor);
      bookPill.innerText = `📖 ${(liveBook && liveBook.title) || note.bookTitle}`;
      tagsRow.appendChild(bookPill);
    }

    (note.tagIds || []).forEach((tagId) => {
      const tag = loadedNoteTagsMemory.find((t) => t.id === tagId);
      if (!tag) return;
      const pill = document.createElement("span");
      pill.className = "note-card-tag-pill";
      pill.style.setProperty("--tag-tint", tag.color || "");
      pill.innerText = tag.name;
      tagsRow.appendChild(pill);
    });

    card.appendChild(tagsRow);
  }

  // innerText (not innerHTML) throughout this card, same reasoning as
  // escapeHtml() elsewhere in the app - note text and comments can contain
  // anything the user typed or selected from a book, and none of it should
  // ever be interpreted as markup.
  const quote = document.createElement("blockquote");
  quote.className = "note-card-quote collapsed";
  quote.innerText = note.selectedText;
  card.appendChild(quote);

  const toggleButton = document.createElement("button");
  toggleButton.className = "note-card-expand-btn";
  toggleButton.innerText = "▼ Show More";
  toggleButton.onclick = () => toggleNoteCard(quote, toggleButton);
  card.appendChild(toggleButton);

  // Hide the button if the note isn't actually overflowing.
  requestAnimationFrame(() => {
      if (quote.scrollHeight <= quote.clientHeight + 1) {
          toggleButton.style.display = "none";
      }
  });

  if (note.comment) {
    const comment = document.createElement("div");
    comment.className = "note-card-comment";
    /*
     innerHTML + renderLightweightMarkdown() (10-utils.js) instead of the
     plain innerText this used to be - the raw note.comment string itself
     is never touched (still stored, and still loaded verbatim into the
     editor's plain <textarea> - see triggerNoteContextAction() above),
     only how it's *displayed* here changes. renderLightweightMarkdown()
     escapes all HTML before applying any formatting, so this stays exactly
     as safe against injected markup as innerText was - a comment containing
     literal "<img onerror=...>" renders as inert text, not a live tag.
    */
    comment.innerHTML = renderLightweightMarkdown(note.comment);
    card.appendChild(comment);
  }

  return card;
}

function toggleNoteCard(quoteElement, buttonElement) {
    quoteElement.classList.toggle("collapsed");

    buttonElement.innerText = quoteElement.classList.contains("collapsed")
        ? "▼ Show More"
        : "▲ Show Less";
}

function deleteNote(noteId) {
  if (!confirm("Delete this note? This cannot be undone.")) return;
  const transaction = db.transaction([STORE_NOTES], "readwrite");
  transaction.objectStore(STORE_NOTES).delete(noteId);
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof deleteNoteFromCloud === "function") deleteNoteFromCloud(noteId);
  };
}

// -----------------------------------------------------------------
// PER-NOTE 3-DOTS ACTIONS FLYOUT
// Mirrors the book-context-menu pattern elsewhere in the app: one shared floating menu, positioned
// relative to whichever trigger button was clicked (auto-flipping to stay within the viewport), that
// acts on whichever note's trigger was last clicked.
// -----------------------------------------------------------------
let currentActiveContextNoteId = null;

function toggleNoteContextMenuFlyout(event, noteId) {
  event.preventDefault();
  event.stopPropagation();

  currentActiveContextNoteId = noteId;
  const menu = document.getElementById("note-context-menu");

  positionFlyoutMenu(menu, event);

  document.addEventListener("click", closeNoteContextMenuFlyoutOnceOutside);
}

function closeNoteContextMenuFlyoutOnceOutside() {
  document.getElementById("note-context-menu").style.display = "none";
  document.removeEventListener("click", closeNoteContextMenuFlyoutOnceOutside);
}

// Route the clicked menu item to the note it was opened for
function triggerNoteContextAction(actionKey) {
  const targetNote = loadedNotesMemory.find((n) => n.id === currentActiveContextNoteId);
  if (!targetNote) return;

  if (actionKey === "delete") {
    deleteNote(targetNote.id);
  } else if (actionKey === "edit") {
    openNoteEditorModal({
      selectedText: targetNote.selectedText,
      comment: targetNote.comment || "",
      bookId: targetNote.bookId,
      bookTitle: targetNote.bookTitle,
      tagIds: targetNote.tagIds || [],
      editingNoteId: targetNote.id,
    });
  } else if (actionKey === "moveTags") {
    openNoteTagPickerModal(targetNote);
  }
}

/** Shared write-path for note field edits. Stamps lastModified at the moment of the local edit. */
function updateNoteFields(noteId, changes) {
  updateRecordInStore(
    STORE_NOTES,
    noteId,
    (record) => Object.assign(record, changes),
    typeof pushNoteToCloud === "function" ? pushNoteToCloud : null,
  ).then(() => fetchNotesLibrary());
}

// -----------------------------------------------------------------
// "MOVE NOTE (TAG)" - lightweight tag-only picker
// A quicker path than the full editor for the common case of just re-tagging a note; only touches
// note.tagIds and never the automatic book tag, which is never user-editable directly.
// -----------------------------------------------------------------
function openNoteTagPickerModal(note) {
  noteTagPickerNoteId = note.id;
  const container = document.getElementById("note-tag-picker-container");
  populateNoteEditorTagCheckboxes(container, note.tagIds || []);
  document.getElementById("note-tag-picker-modal").showModal();
}

function closeNoteTagPickerModal() {
  document.getElementById("note-tag-picker-modal").close();
}

function submitNoteTagPickerForm() {
  if (noteTagPickerNoteId == null) return;
  const tagIds = readCheckedTagIdsFrom(document.getElementById("note-tag-picker-container"));
  updateNoteFields(noteTagPickerNoteId, { tagIds });
  saveLastUsedNoteTagIds(tagIds);
  closeNoteTagPickerModal();
}

// -----------------------------------------------------------------
// NOTE TAG MANAGEMENT
// -----------------------------------------------------------------
function openNoteTagManageModal() {
  renderNoteTagManageList();
  document.getElementById("note-tag-manage-modal").showModal();
}

function closeNoteTagManageModal() {
  document.getElementById("note-tag-manage-modal").close();
  // Reflect any renames, recolors, or deletions on the page underneath immediately.
  renderNotesPage();
}

function renderNoteTagManageList() {
  const list = document.getElementById("note-tag-manage-list");
  list.innerHTML = "";

  if (loadedNoteTagsMemory.length === 0) {
    list.innerHTML = `<div class="notes-empty-state">No tags yet.</div>`;
  }

  loadedNoteTagsMemory.forEach((tag) => {
    const row = document.createElement("div");
    row.className = "note-tag-manage-row";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "color-swatch-input";
    colorInput.value = tag.color || "#808080";
    colorInput.onchange = () => updateNoteTag(tag.id, { color: colorInput.value });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "full-width-input";
    nameInput.value = tag.name;
    nameInput.onchange = () => {
      const trimmed = nameInput.value.trim();
      if (!trimmed) {
        alert("Tag name can't be empty.");
        nameInput.value = tag.name;
        return;
      }
      updateNoteTag(tag.id, { name: trimmed });
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "group-mini-btn note-tag-manage-delete-btn";
    deleteBtn.innerText = "-";
    deleteBtn.title = "Delete tag";
    deleteBtn.onclick = () => deleteNoteTag(tag.id);

    row.appendChild(colorInput);
    row.appendChild(nameInput);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  });
}

function updateNoteTag(tagId, changes) {
  updateRecordInStore(
    STORE_NOTE_GROUPS,
    tagId,
    (record) => Object.assign(record, changes),
    typeof pushNoteTagToCloud === "function" ? pushNoteTagToCloud : null,
  ).then(() => fetchNotesLibrary());
}

/** Creates a new note tag with a placeholder name and random color, ready to edit inline. */
function createNoteTag() {
  /*
   New tags are inserted immediately with a placeholder name and a random color rather than through
   a separate two-step creation form - the name and color inputs in the management list are then
   right there to edit, matching how the rest of this app's settings auto-save the moment they
   change instead of needing an explicit "create" step.
  */
  const randomColor = `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;

  const newTag = { name: "New Tag", color: randomColor, lastModified: Date.now() };
  const transaction = db.transaction([STORE_NOTE_GROUPS], "readwrite");
  transaction.objectStore(STORE_NOTE_GROUPS).add(newTag).onsuccess = (e) => {
    newTag.id = e.target.result;
  };
  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof pushNoteTagToCloud === "function") pushNoteTagToCloud(newTag);
  };
}

function deleteNoteTag(tagId) {
  if (!confirm('Delete this tag? Notes carrying it will simply lose that tag rather than being deleted.')) return;

  const transaction = db.transaction([STORE_NOTES, STORE_NOTE_GROUPS], "readwrite");
  const notesStore = transaction.objectStore(STORE_NOTES);
  const tagsStore = transaction.objectStore(STORE_NOTE_GROUPS);

  tagsStore.delete(tagId);

  const notesToRepush = [];
  notesStore.getAll().onsuccess = (e) => {
    e.target.result.forEach((note) => {
      if (note.tagIds && note.tagIds.includes(tagId)) {
        note.tagIds = note.tagIds.filter((id) => id !== tagId);
        note.lastModified = Date.now();
        notesStore.put(note);
        notesToRepush.push(note);
      }
    });
  };

  transaction.oncomplete = () => {
    fetchNotesLibrary();
    if (typeof deleteNoteTagFromCloud === "function") deleteNoteTagFromCloud(tagId);
    if (typeof pushNoteToCloud === "function") {
      notesToRepush.forEach((note) => pushNoteToCloud(note));
    }
  };
}