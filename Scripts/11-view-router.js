// =================================================================
// VIEW ROUTER: LIBRARY <-> READER PANEL SWITCHING
// =================================================================
/**
 Switches the UI from the library panel to the reader panel.

 Purely a DOM/visibility switch - doesn't touch activeBookObject, sessions, or spine state; callers must set that up separately.
 */
function showReaderState() {
    // Switch primary panels
    document.getElementById("library-view").classList.remove("active");
    document.getElementById("library-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";
    document.getElementById("reader-view").classList.add("active");
    document.getElementById("reader-view").style.display = "flex";
    document.getElementById("stats-view").style.display = "none";

    // Hide library navbar tools
    document.getElementById("upload-label").style.display = "none";
    document.getElementById("btn-create-group").style.display = "none";
    document.getElementById("library-view-mode").style.display = "none";
    document.getElementById("sort-selector").style.display = "none";
    document.getElementById("btn-export-json").style.display = "none";
    document.getElementById("btn-import-json").style.display = "none";
    document.getElementById("btn-last-read").style.display = "none";
    document.getElementById("sign-in").style.display = "none";
    document.getElementById("app-version-badge").style.display = "none";
    document.getElementById("current-group-indicator").style.display = "none";
    document.getElementById("btn-library-settings").style.display = "none";
    const audioFloatingPanel = document.getElementById("audio-floating-panel");
    if (audioFloatingPanel) audioFloatingPanel.style.display = "flex";

    // Safety check in case the back-to-groups button was visible
    const backGroupBtn = document.getElementById("btn-back-group");
    if (backGroupBtn) backGroupBtn.style.display = "none";

    // Show reader controls and the current book title
    document.getElementById("current-book-indicator").style.display = "inline";
    const readerControls = document.getElementById("reader-controls");
    if (readerControls) readerControls.style.display = "flex";
}

/**
 Switches the UI back to the library panel and closes out the current reading session
 (final progress push, saved time, ended session, cleared activeBookObject, refreshed library grid).
 
 This is the required way to leave the reader, not just showReaderState
 in reverse, since it's what actually persists and closes the session.
 */
function showLibraryState() {
    // Switch primary panels back
    document.getElementById("reader-view").classList.remove("active");
    document.getElementById("reader-view").style.display = "none";
    document.getElementById("stats-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";
    document.getElementById("library-view").classList.add("active");
    document.getElementById("library-view").style.display = "flex";

    // Hide reader-active indicators
    document.getElementById("current-book-indicator").style.display = "none";
    document.getElementById("current-group-indicator").style.display = "none";
    const readerControls = document.getElementById("reader-controls");
    if (readerControls) readerControls.style.display = "none";
    document.querySelectorAll(".reader-sidebar").forEach(s => s.classList.remove("active"));

    // Restore library navbar tools
    document.getElementById("upload-label").style.display = "inline-block";
    document.getElementById("btn-create-group").style.display = "inline-block";
    document.getElementById("sort-selector").style.display = "inline-block";
    document.getElementById("btn-export-json").style.display = "inline-block";
    document.getElementById("btn-import-json").style.display = "inline-block";
    document.getElementById("btn-last-read").style.display = "inline-block";
    document.getElementById("sign-in").style.display = "flex";
    document.getElementById("app-version-badge").style.display = "flex";
    document.getElementById("btn-library-settings").style.display = "inline-block";
    const audioFloatingPanel = document.getElementById("audio-floating-panel");
    if (audioFloatingPanel) audioFloatingPanel.style.display = "none";

    // Restore the view mode toggle, or the group back button, depending on context
    const viewModeSelector = document.getElementById("library-view-mode");
    const backGroupBtn = document.getElementById("btn-back-group");

    if (activeGroupFilterId !== null) {
        if (viewModeSelector) viewModeSelector.style.display = "none";
        if (backGroupBtn) backGroupBtn.style.display = "inline-block";
        document.getElementById("current-group-indicator").style.display = "inline";
    } else {
        if (viewModeSelector) viewModeSelector.style.display = "inline-block";
        if (backGroupBtn) backGroupBtn.style.display = "none";
    }

    // Send the final reading position to the cloud right away - the regular progress push
    // is throttled to once per interval, so without this the last few seconds of a
    // session could be lost to the cloud (still safe locally).
    if (activeBookObject && typeof forcePushBookProgressToCloud === "function") {
        forcePushBookProgressToCloud(activeBookObject.id);
    }

    /*
    Leaving the reader ends a session, like backgrounding the tab or closing it.
    saveTimeToDB() first flushes the latest reading time, then endReadingSession() closes
    and persists the active session.
    */
    if (typeof saveTimeToDB === "function") saveTimeToDB();
    if (typeof endReadingSession === "function") endReadingSession("leftReader");
    if (typeof stopReadingAudioSync === "function") stopReadingAudioSync();
    if (typeof stopScroll === "function") stopScroll();
    
    activeBookObject = null;
    stopActiveReadingTimer();
    fetchLocalLibrary();
    
}

function setupKeyboardListeners() {
  window.addEventListener("keydown", (e) => {
    const readerActive = document.getElementById("reader-view").classList.contains("active");
    const noteActive = document.getElementById("note-editor-modal")?.open ?? false;
    if (!readerActive || noteActive) return;
    const isTyping = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (isTyping) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      stepToNextChapter();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepToPrevChapter();
    }
  });
}