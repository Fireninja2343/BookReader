// =================================================================
// TIME TRACKING
// =================================================================
window.addEventListener("focus", startActiveReadingTimer);
window.addEventListener("blur", stopActiveReadingTimer);

// Hoisted above visibilitychange, which needs it on every hide/show pair.
const SESSION_INACTIVITY_TIMEOUT_MS = Config.Reading.SESSION_INACTIVITY_TIMEOUT_MS;
const PAUSE_SPLIT_THRESHOLD_MS = Config.Reading.PAUSE_SPLIT_THRESHOLD_MS;

// Handles tab state changes to track active reading time accurately.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopActiveReadingTimer();
        saveTimeToDB();
        // Tracks background time using the same pause accumulator if not already manually paused.
        if (currentPauseStartTime === null) currentPauseStartTime = Date.now();
    } else if (document.hasFocus()) {
        // Resolves passive background pauses using SESSION_INACTIVITY_TIMEOUT_MS unless manually paused.
        if (!pauseTracking) resolvePauseOnResume(SESSION_INACTIVITY_TIMEOUT_MS, "hidden-split");
        startActiveReadingTimer();
    }
});

// Covers closing the tab outright, which visibilitychange isn't guaranteed to catch.
window.addEventListener("beforeunload", () => {
    saveTimeToDB();
    endReadingSession("unload");
});

const IDLE_THRESHOLD_MS = Config.Sync.IDLE_THRESHOLD_MS;
const DB_UPDATE_FREQUENCY = Config.Reading.DB_UPDATE_FREQUENCY_MS / 1000;
const TRACKING_TICK_MS = Config.Reading.TRACKING_TICK_MS;

let lastActivityTime = Date.now();
let pauseTracking = false;

function recordUserActivity() {
    lastActivityTime = Date.now();
    continueOrStartReadingSession();
}
window.addEventListener("mousemove", recordUserActivity);
window.addEventListener("keydown", recordUserActivity);
document.getElementById("reader-container")?.addEventListener("scroll", recordUserActivity);
document.getElementById("reader-container")?.addEventListener("click", recordUserActivity);

/**
 Runs the reading-timer heartbeat: tracks active time and checks session inactivity.
 */
function startActiveReadingTimer() {
    if (focusedTimeTrackerHeartbeatInterval) return;
    focusedTimeTrackerHeartbeatInterval = setInterval(() => {
        const readerActive = document.getElementById("reader-view").classList.contains("active");
        const isUserActive = (Date.now() - lastActivityTime) < IDLE_THRESHOLD_MS;
        if (readerActive && activeBookObject && document.hasFocus() && !document.hidden && isUserActive && !pauseTracking) {
            if (!activeBookObject.timeSpentSeconds) activeBookObject.timeSpentSeconds = 0;
            activeBookObject.timeSpentSeconds += (TRACKING_TICK_MS / 1000);
            
            // Batches DB writes to reduce I/O.
            if (activeBookObject.timeSpentSeconds % DB_UPDATE_FREQUENCY === 0) {
                saveTimeToDB();
            }
        }
        // Skip during manual pauses to let resolvePauseOnResume handle split vs. subtract.
        if (!pauseTracking) checkSessionInactivityTimeout();
    }, TRACKING_TICK_MS);
}

function stopActiveReadingTimer() {
    clearInterval(focusedTimeTrackerHeartbeatInterval);
    focusedTimeTrackerHeartbeatInterval = null;
}

/**
 Toggles manual pause, suspending time tracking and resolving session status on resume.
 
 @param {boolean} [pause=true] - Whether to pause (`true`) or resume (`false`).
 */
function pauseActiveReadingTimer(pause = true){
    if(pause){
        document.getElementById("pause-tracking").style.display = "none";
        document.getElementById("unpause-tracking").style.display = "inline-block";
        currentPauseStartTime = Date.now();
    } else if(!pause){
        document.getElementById("pause-tracking").style.display = "inline-block";
        document.getElementById("unpause-tracking").style.display = "none";
        resolvePauseOnResume(PAUSE_SPLIT_THRESHOLD_MS, "paused-split");
    }
    pauseTracking = pause;
}

/**
 Handles time accumulation and session splits when resuming from a manual pause or background state.

 - Short pauses (<= threshold): Appends pause duration to session and updates last interaction.
 - Long pauses (> threshold): Ends the session retroactively as of when the pause began.
 
 @param {number} splitThresholdMs - Max duration (ms) before splitting the session.
 @param {string} reason - Logged reason passed to `endReadingSession` on split.
 */
function resolvePauseOnResume(splitThresholdMs, reason) {
    if (currentPauseStartTime === null) return;
    const pauseEndedAt = Date.now();
    const pauseDurationMs = pauseEndedAt - currentPauseStartTime;

    if (currentSessionStartTime !== null && pauseDurationMs > splitThresholdMs) {
        endReadingSession(reason, currentPauseStartTime);
    } else if (currentSessionStartTime !== null) {
        currentSessionPausedMs += pauseDurationMs;
        currentSessionLastInteractionTime = pauseEndedAt;
    }

    currentPauseStartTime = null;
}

/**
 Writes timeSpentSeconds to the book's DB record and flushes the open reading-history
 segment alongside it.
 */
function saveTimeToDB() {
    if (!activeBookObject || !activeBookObject.id) return;
    const timeSpent = activeBookObject.timeSpentSeconds;
    const now = new Date().getTime();
    const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(Config.Db.STORE_BOOKS);
    store.get(activeBookObject.id).onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
            record.timeSpentSeconds = timeSpent;
            record.lastModified = now;
            store.put(record);
        }
    };

    if (typeof persistHistorySegment === "function") persistHistorySegment();

    activeBookObject.lastModified = now;
}

/*
 REAL READING-SESSION LIFECYCLE

 Separate from recordReadingSessionStart() (02-db.js), which only updates
 firstOpened/lastOpened on launch. This tracks actual engaged reading activity via
 readingSessions/totalSessions - see appendReadingSession() in 02-db.js.

 Sessions start on first interaction, continue while activity stays within the timeout
 window, and end on close, tab exit, or inactivity timeout.
*/

/**
 Starts a session on first interaction, or extends the active session's inactivity clock.
 No-op when the reader is inactive, another view is open, or no book is loaded.
 */
function continueOrStartReadingSession() {
    const readerActive = document.getElementById("reader-view")?.classList.contains("active");
    if (!readerActive || !activeBookObject) return;

    const now = Date.now();
    if (currentSessionStartTime === null) {
        currentSessionStartTime = now;
        currentSessionStartChapterPointer = activeSpinePointer;
        // Ensures the book-scale % baseline is current, not a stale/previous-book value.
        if (typeof trackReadingProgress === "function") trackReadingProgress();
        currentSessionStartBookScalePct = lastKnownBookScalePct;
        if (typeof startHistorySegment === "function") {
            startHistorySegment(activeBookObject.id, activeSpinePointer);
        }
    }
    currentSessionLastInteractionTime = now;
}

function checkSessionInactivityTimeout() {
    if (currentSessionStartTime === null) return;
    const idleFor = Date.now() - currentSessionLastInteractionTime;
    if (idleFor >= SESSION_INACTIVITY_TIMEOUT_MS) {
        endReadingSession("inactivity");
    }
}

/**
 Closes and persists the active reading session through appendReadingSession(). Safe to
 call from cleanup paths because it does nothing when no session is open.

 @param {string} reason - Why the session is ending (logged only).
 @param {number} [asOfTime=Date.now()] - Timestamp to treat as the session's end instead
   of now. Used to retroactively close a session as of when a long manual pause began,
   so the paused stretch is excluded rather than counted as reading time (see
   resolvePauseOnResume()).
 */
function endReadingSession(reason, asOfTime = Date.now()) {
    if (typeof closeHistorySegment === "function") closeHistorySegment(asOfTime);

    if (currentSessionStartTime === null || !activeBookObject || !activeBookObject.id) {
        currentSessionStartTime = null;
        currentSessionLastInteractionTime = null;
        currentSessionStartChapterPointer = null;
        currentSessionStartBookScalePct = null;
        currentSessionPausedMs = 0;
        return;
    }

    const endTime = asOfTime;
    // Subtracts accumulated short-pause dead time (see resolvePauseOnResume())
    const durationSeconds = Math.max(0, Math.round((endTime - currentSessionStartTime - currentSessionPausedMs) / 1000));

    // Sessions under a few seconds are noise (accidental open/close, or a double-fire),
    // not meaningful reading sessions.
    if (durationSeconds < 3) {
        currentSessionStartTime = null;
        currentSessionLastInteractionTime = null;
        currentSessionStartChapterPointer = null;
        currentSessionStartBookScalePct = null;
        currentSessionPausedMs = 0;
        return;
    }

    // Approximates pages read from the whole-book scroll % delta, scaled against the
    // book's cached page count.
    const totalPages = activeBookObject.totalPages || 0;
    let pagesRead = 0;
    if (totalPages > 0 && currentSessionStartBookScalePct !== null && lastKnownBookScalePct !== null) {
        const pctAdvanced = Math.max(0, lastKnownBookScalePct - currentSessionStartBookScalePct);
        pagesRead = Math.round((pctAdvanced / 100) * totalPages);
    } else {
        // Fallback: chapters-crossed estimate, used when book-scale % isn't available
        const chapterCount = activeBookObject.chapterCount || 0;
        if (chapterCount > 0 && totalPages > 0 && currentSessionStartChapterPointer !== null) {
            const chaptersAdvanced = Math.max(0, activeSpinePointer - currentSessionStartChapterPointer);
            pagesRead = Math.round((chaptersAdvanced / chapterCount) * totalPages);
        }
    }

    const sessionRecord = {
        start: currentSessionStartTime,
        end: endTime,
        durationSeconds: durationSeconds,
        pagesRead: pagesRead,
        timestamp: endTime,
    };

    const bookId = activeBookObject.id;
    currentSessionStartTime = null;
    currentSessionLastInteractionTime = null;
    currentSessionStartChapterPointer = null;
    currentSessionStartBookScalePct = null;
    currentSessionPausedMs = 0;

    appendReadingSession(bookId, sessionRecord);
}

// =================================================================
// BOOK CONTEXT MENU (3-DOTS FLYOUT)
// =================================================================
/**
 Opens the 3-dots flyout for a book card and positions it near the trigger event.
 @param {MouseEvent} event - Click event on the 3-dots trigger.
 @param {number} bookIndexId - id of the book this menu is for.
 */
function toggleBookContextMenuFlyout(event, bookIndexId) {
    event.preventDefault();
    event.stopPropagation();

    currentActiveContextBookIndexId = bookIndexId;
    const menu = document.getElementById("book-context-menu");

    // "Estimate Completion Date" only applies to read books missing a completedDate.
    // "Clear Completion Date" is shown whenever a date exists, regardless of read status.
    const targetBookObj = loadedBooksMemory.find((b) => b.id === bookIndexId);
    const backfillRow = document.getElementById("context-item-backfill-completion");
    if (backfillRow) {
        const needsBackfill = !!(targetBookObj && targetBookObj.isRead && !targetBookObj.completedDate);
        backfillRow.style.display = needsBackfill ? "" : "none";
    }
    const clearRow = document.getElementById("context-item-clear-completion");
    if (clearRow) {
        const hasDate = !!(targetBookObj && targetBookObj.completedDate);
        clearRow.style.display = hasDate ? "" : "none";
    }

    positionFlyoutMenu(menu, event);

    document.addEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

function closeBookContextMenuFlyoutOnceOutside() {
    document.getElementById("book-context-menu").style.display = "none";
    document.removeEventListener("click", closeBookContextMenuFlyoutOnceOutside);
}

/**
 Dispatches a context-menu action for the book targeted by currentActiveContextBookIndexId.
 @param {string} actionKey - Which action to run; see the switch cases for valid values.
 */
function triggerContextAction(actionKey) {
    const targetBookObj = loadedBooksMemory.find(b => b.id === currentActiveContextBookIndexId);
    if (!targetBookObj) return;

    switch (actionKey) {
        case "delete":
            if (confirm(`Remove "${targetBookObj.title}" from library completely?`)) {
                const transaction = db.transaction([Config.Db.STORE_BOOKS], "readwrite");
                transaction.objectStore(Config.Db.STORE_BOOKS).delete(targetBookObj.id);
                transaction.oncomplete = () => {
                    fetchLocalLibrary();
                    if (typeof deleteBookFromCloud === "function") deleteBookFromCloud(targetBookObj.id);
                };
            }
            break;
        case "toggleRead":
            updateBookRecord(targetBookObj.id, (r) => {
                r.isRead = !r.isRead;
                r.completedDate = r.isRead ? (r.completedDate || new Date().getTime()) : null;
            }).then(() => fetchLocalLibrary());
            break;
        case "backfillCompletionDate":
            migrateSingleBookCompletionDate(targetBookObj.id).then((wasUpdated) => {
                if (wasUpdated) {
                    refreshLibraryAndVisibleStats();
                } else {
                    alert("This book doesn't need a completion date backfill (already has one, or isn't marked read).");
                }
            });
            break;
        case "editStartDate":
            openStartDateModal(targetBookObj);
            break;
        case "editCompletionDate":
            openCompletionDateModal(targetBookObj);
            break;
        case "clearCompletionDate":
            setBookCompletionDate(targetBookObj.id, null).then((wasUpdated) => {
                if (wasUpdated) refreshLibraryAndVisibleStats();
            });
            break;
        case "editRawData":
            openEditRawDataModal(targetBookObj);
            break;
        case "pairAudiobook":
            openAudioPairingPanel(targetBookObj.id);
            break;
        case "metadata":
        case "stats":
            openBookDiagnosticsModal(targetBookObj, actionKey);
            break;
        case "group": {
            if (loadedGroupsMemory.length === 0) {
                alert("No groups exist yet. Create one first with \"📁 New Group\".");
                return;
            }
            const optionsList = loadedGroupsMemory
                .map((g) => `${g.id}: ${g.name}`)
                .join("\n");

            const groupIdInput = prompt(
                `Enter a group ID to move "${targetBookObj.title}" into, or leave blank to remove it from its group:\n\n${optionsList}`,
            );
            if (groupIdInput === null) return;
            let newGroupId = null;
            if (groupIdInput.trim() !== "") {
                const parsed = parseInt(groupIdInput, 10);
                const matchesRealGroup = loadedGroupsMemory.some((g) => g.id === parsed);
                if (!matchesRealGroup) {
                    alert("That's not a valid group ID.");
                    return;
                }
                newGroupId = parsed;
            }
            updateBookRecord(targetBookObj.id, (r) => {
                r.groupId = newGroupId;
            }).then(() => fetchLocalLibrary());
            break;
        }
        default:
            console.warn(`Unknown context action: ${actionKey}`);
    }
}
/**
 Shared refresh path for completion-date actions. Reloads loadedBooksMemory and
 refreshes the open stats view if needed.
 @param {boolean} [goToStats=true] - Whether to also refresh the stats view if it's open.
 */
function refreshLibraryAndVisibleStats(goToStats = true) {
    fetchLocalLibrary();
    const statsPanel = document.getElementById("stats-view");
    if (statsPanel && statsPanel.style.display !== "none" && goToStats) {
        showStatsViewState();
    }
}

// =================================================================
// MANUAL DATE EDIT MODAL
// =================================================================

function openStartDateModal(bookObj) {
    const dialog = document.getElementById("start-date-modal");
    const idField = document.getElementById("start-date-book-id");
    const dateInput = document.getElementById("start-date-input");

    idField.value = bookObj.id;
    dateInput.value = bookObj.firstOpened
        ? toDateInputValue(new Date(bookObj.firstOpened))
        : "";

    dialog.showModal();
}

function closeStartDateModal() {
    document.getElementById("start-date-modal").close();
}

function submitStartDateModalForm() {
    const bookId = parseInt(document.getElementById("start-date-book-id").value, 10);
    const dateInput = document.getElementById("start-date-input");

    if (!dateInput.value) {
        alert("Pick a date first, or clear the start date manually.");
        return;
    }

    const [year, month, day] = dateInput.value.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day).getTime();

    setBookStartDate(bookId, selectedDate).then((wasUpdated) => {
        if (wasUpdated) {
            closeStartDateModal();
            refreshLibraryAndVisibleStats(false);
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}


function openCompletionDateModal(bookObj) {
    const dialog = document.getElementById("completion-date-modal");
    const idField = document.getElementById("completion-date-book-id");
    const dateInput = document.getElementById("completion-date-input");

    idField.value = bookObj.id;
    dateInput.value = bookObj.completedDate
        ? toDateInputValue(new Date(bookObj.completedDate))
        : "";

    dialog.showModal();
}

function closeCompletionDateModal() {
    document.getElementById("completion-date-modal").close();
}

function submitCompletionDateModalForm() {
    const bookId = parseInt(document.getElementById("completion-date-book-id").value, 10);
    const dateInput = document.getElementById("completion-date-input");

    if (!dateInput.value) {
        alert("Pick a date first, or use \"Clear Completion Date\" from the book's menu instead.");
        return;
    }

    const [year, month, day] = dateInput.value.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day).getTime();

    setBookCompletionDate(bookId, selectedDate).then((wasUpdated) => {
        if (wasUpdated) {
            closeCompletionDateModal();
            refreshLibraryAndVisibleStats(false);
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}

// =================================================================
// EDIT RAW DATA MODAL
// Direct edit access to a book's stored IndexedDB fields for manual corrections that
// don't have their own dedicated UI.
// =================================================================
function openEditRawDataModal(bookObj) {
    document.getElementById("edit-raw-data-book-id").value = bookObj.id;
    document.getElementById("edit-raw-data-title").value = bookObj.title || "";
    // Stored as seconds; edited as whole minutes for a friendlier input.
    document.getElementById("edit-raw-data-time-spent").value =
        Math.round((bookObj.timeSpentSeconds || 0) / 60);
    document.getElementById("edit-raw-data-total-sessions").value = bookObj.totalSessions || 0;
    document.getElementById("edit-raw-data-current-chapter").value = bookObj.currentChapter || 0;
    document.getElementById("edit-raw-data-scroll-offset").value = bookObj.scrollOffset || 0;
    document.getElementById("edit-raw-data-total-pages").value = bookObj.totalPages ?? "";
    document.getElementById("edit-raw-data-total-words").value = bookObj.totalWords ?? "";
    document.getElementById("edit-raw-data-chapter-count").value = bookObj.chapterCount ?? "";
    document.getElementById("edit-raw-data-is-read").checked = !!bookObj.isRead;

    document.getElementById("edit-raw-data-modal").showModal();
}

function closeEditRawDataModal() {
    document.getElementById("edit-raw-data-modal").close();
}

function submitEditRawDataModalForm() {
    const bookId = parseInt(document.getElementById("edit-raw-data-book-id").value, 10);

    const titleInput = document.getElementById("edit-raw-data-title").value.trim();
    if (!titleInput) {
        alert("Title can't be empty.");
        return;
    }

    // Falls back to 0 for blank/invalid entries rather than writing NaN.
    const parseIntFieldOrZero = (elementId) => {
        const raw = document.getElementById(elementId).value;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    // Same, but preserves null for optional fields left blank instead of coercing to 0.
    const parseIntFieldOrNull = (elementId) => {
        const raw = document.getElementById(elementId).value;
        if (raw === "") return null;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const timeSpentMinutes = parseIntFieldOrZero("edit-raw-data-time-spent");
    const totalSessions = parseIntFieldOrZero("edit-raw-data-total-sessions");
    const currentChapter = parseIntFieldOrZero("edit-raw-data-current-chapter");
    const scrollOffset = parseIntFieldOrZero("edit-raw-data-scroll-offset");
    const totalPages = parseIntFieldOrNull("edit-raw-data-total-pages");
    const totalWords = parseIntFieldOrNull("edit-raw-data-total-words");
    const chapterCount = parseIntFieldOrNull("edit-raw-data-chapter-count");
    const isReadChecked = document.getElementById("edit-raw-data-is-read").checked;

    updateBookRecord(bookId, (record) => {
        record.title = titleInput;
        record.timeSpentSeconds = timeSpentMinutes * 60;
        record.totalSessions = totalSessions;
        record.currentChapter = currentChapter;
        record.scrollOffset = scrollOffset;
        record.totalPages = totalPages;
        record.totalWords = totalWords;
        record.chapterCount = chapterCount;
        record.isRead = isReadChecked;
        // Clears completedDate when un-marked as read, mirroring "Toggle Read Status".
        if (!isReadChecked) {
            record.completedDate = null;
        } else if (!record.completedDate) {
            record.completedDate = new Date().getTime();
        }
    }).then((updatedRecord) => {
        if (updatedRecord) {
            // Keep activeBookObject in sync if this is the book currently open in the reader.
            if (activeBookObject && activeBookObject.id === bookId) {
                Object.assign(activeBookObject, updatedRecord);
            }
            closeEditRawDataModal();
            refreshLibraryAndVisibleStats(false);
        } else {
            alert("Couldn't find that book to update.");
        }
    });
}

/**
 Formats a Date as YYYY-MM-DD in local time, for <input type="date">.
 @param {Date} dateObj
 @returns {string}
 */
function toDateInputValue(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}
// =================================================================
// PER-BOOK DIAGNOSTICS MODAL
// =================================================================
/**
 Opens the book diagnostics modal in metadata mode (parses the EPUB for
 title/creator/language) or stats mode (reads cached word/page/chapter/time metrics).
 @param {object} bookObj - Book record to inspect.
 @param {"metadata"|"stats"} modeType - Which panel to show.
 */
async function openBookDiagnosticsModal(bookObj, modeType) {
    const dialog = document.getElementById("book-metrics-modal");
    const title = document.getElementById("metrics-modal-title");
    const body = document.getElementById("metrics-modal-body");

    body.innerHTML = "Parsing structures...";
    title.innerText = modeType === 'metadata' ? "Epub Metadata Explorer" : "Book Performance Metrics";
    dialog.showModal();

    if (modeType === 'metadata') {
        // Title/creator/language aren't cached on the book record, so this opens the zip.
        try {
            const zip = await JSZip.loadAsync(bookObj.fileData);
            const { opfDoc } = await openEpubContainer(zip);

            const metaTitle = opfDoc.querySelector("title")?.textContent || "Unknown Title";
            const creator = opfDoc.querySelector("creator")?.textContent || "Unknown Publisher Author";
            const language = opfDoc.querySelector("language")?.textContent || "en";

            body.innerHTML = `
                <div><strong>System Core Index:</strong> ${escapeHtml(bookObj.id)}</div>
                <div><strong>Standard Manifest Title:</strong> ${escapeHtml(metaTitle)}</div>
                <div><strong>Creator/Author Authority:</strong> ${escapeHtml(creator)}</div>
                <div><strong>Language Code Element:</strong> ${escapeHtml(language)}</div>
                <div><strong>Date Indexed Locally:</strong> ${escapeHtml(new Date(bookObj.dateImported).toLocaleString())}</div>
            `;
        } catch (e) {
            body.innerHTML = `<span style="color:red">Failed extraction profiles.</span>`;
        }
        return;
    }

    // Stats mode: reads cached numbers instead of reparsing the EPUB each time.
    // ensureBookMetadataCached() is a no-op if this book already has cached numbers.
    try {
        const freshBook = await ensureBookMetadataCached(bookObj);
        const computedMinutes = getMeaningfulTrackedMinutes(freshBook.timeSpentSeconds);
        const chapterCount = freshBook.chapterCount ?? "—";
        const estimatedPagesCount = freshBook.totalPages ?? "—";

        body.innerHTML = `
            <div><strong>Total Compiled Chapters:</strong> ${chapterCount} Items</div>
            <div><strong>Calculated Page Volume Count:</strong> ~${estimatedPagesCount} pages</div>
            <div><strong>Active Time Spent Tracker:</strong> ${computedMinutes} continuous minutes</div>
        `;
    } catch (e) {
        body.innerHTML = `<span style="color:red">Failed extraction profiles.</span>`;
    }
}