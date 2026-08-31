// =================================================================
// READER LAUNCH & CHAPTER RENDERING
// =================================================================
/**
 Opens the reader view for the given book: loads its EPUB data, builds the spine/TOC,
 renders the last-read chapter, and starts session/progress tracking. Sets the
 activeBookObject/activeZipInstance/activeSpineArray/activeSpinePointer globals the
 rest of the reader depends on - the required entry point for opening any book.
 @param {object} bookObject - Book record (must include fileData) to open.
 */
async function launchEpubReader(bookObject) {
  if (typeof endReadingSession === "function") endReadingSession("newBookLaunched");

  activeBookObject = bookObject;
  document.getElementById("current-book-indicator").innerText =
    bookObject.title;
  document.getElementById("current-book-indicator").style.display = "inline";
  document.getElementById("reader-controls").style.display = "flex";

  /*
   Every call to launchEpubReader() is, by definition, a new reading session for this book
   - so firstOpened/lastOpened/totalSessions are updated here rather than anywhere progress
   happens to be saved. See recordReadingSessionStart() in 02-db.js.
  */
  if (typeof recordReadingSessionStart === "function") {
    recordReadingSessionStart(bookObject.id);
  }

  try {
    activeZipInstance = await JSZip.loadAsync(bookObject.fileData);
    const { opfDoc, baseDir } = await openEpubContainer(activeZipInstance);

    const manifestItems = {};
    opfDoc.querySelectorAll("manifest > item").forEach((item) => {
      manifestItems[item.getAttribute("id")] = normalizePath(
        baseDir + item.getAttribute("href"),
      );
    });

    activeSpineArray = [];
    opfDoc.querySelectorAll("spine > itemref").forEach((ref) => {
      const idref = ref.getAttribute("idref");
      if (manifestItems[idref]) activeSpineArray.push(manifestItems[idref]);
    });

    activeSpinePointer = bookObject.currentChapter || 0;
    /*
    Records the current chapter as the last pushed baseline when opening a book. Without
    this, the first progress update could look like a chapter change from the previous
    book and trigger an unnecessary cloud push.
    */
    lastPushedChapterIndex = activeSpinePointer;

    await parseAndRenderTOC(activeZipInstance, opfDoc, baseDir);
    showReaderState();
    // Draw the tick marks along the progress bar, one per chapter boundary
    renderProgressBarTicks();
    await renderActiveChapterFromZip(activeZipInstance);
    saveAndApplyUserStyles();
    startActiveReadingTimer();

    setTimeout(() => {
      const container = document.getElementById("reader-container");
      /*
      scrollOffset is stored as a fraction (0-1) of the chapter's scrollable height, not raw pixels.
      Multiplying back out against this device's own maxScroll is what makes the restored position land at
      the same reading spot regardless of font size, viewport width, or margins.
      */
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTop = (bookObject.scrollOffset || 0) * maxScroll;
      trackReadingProgress();

      // If this book is paired with an audiobook and a listening session is
      // newer than this reading position, offer to jump there instead. Runs
      // after the normal restore above so declining leaves that restore intact.
      if (typeof maybePromptSyncReadingToAudio === "function") {
        maybePromptSyncReadingToAudio(bookObject.id);
      }
      // Caches whether this book is audio-paired, so trackReadingProgress()
      // (fired on every scroll event) can skip the position write for
      // unpaired books without an async DB call on every tick.
      if (typeof refreshActiveBookAudioPairingCache === "function") {
        refreshActiveBookAudioPairingCache(bookObject.id);
      }
    }, 200);
  } catch (err) {
    console.error(err);
  }
}

/**
 Renders the chapter at activeSpinePointer into the reader frame, inlining images as
 base64 data URIs. Requires activeSpineArray/activeSpinePointer to already be set (see
 launchEpubReader()) - call this to (re)draw after changing activeSpinePointer.
 @param {JSZip} zipInstance - Open zip for the active book (normally activeZipInstance).
 */
async function renderActiveChapterFromZip(zipInstance) {
  if (activeSpineArray.length === 0) return;
  const targetPath = activeSpineArray[activeSpinePointer];
  const frame = document.getElementById("text-render-frame");
  const container = document.getElementById("reader-container");
  try {
    let chapterRawHTML = await zipInstance.file(targetPath).async("string");
    const parser = new DOMParser();
    const doc = parser.parseFromString(chapterRawHTML, "text/html");
    const baseDir = targetPath.substring(0, targetPath.lastIndexOf("/")) + "/";
    const images = doc.querySelectorAll("img, image");
    for (let img of images) {
      let attributeName =
        img.tagName.toLowerCase() === "image" ? "xlink:href" : "src";
      let srcVal = img.getAttribute(attributeName);
      if (srcVal && !srcVal.startsWith("data:")) {
        let absoluteImgPath = normalizePath(baseDir + srcVal);
        let imgZipFile = zipInstance.file(absoluteImgPath);
        if (imgZipFile) {
          let imgBlob = await imgZipFile.async("blob");
          let mimeType = "image/png";
          if (typeof guessImageMimeType === "function") mimeType = guessImageMimeType(absoluteImgPath);
          imgBlob = new Blob([imgBlob], { type: mimeType });
          let b64 = await convertBlobToBase64(imgBlob);
          img.setAttribute(attributeName, b64);
          if (img.tagName.toLowerCase() === "image")
            img.setAttribute("src", b64);
        }
      }
    }
    const cleanBody = doc.body
      ? doc.body.innerHTML
      : doc.documentElement.innerHTML;
    frame.classList.add("fade-out");
    setTimeout(() => {
      frame.innerHTML = cleanBody;
      container.style.scrollBehavior = "auto";
      container.scrollTop = 0;
      container.style.scrollBehavior = "smooth";
      document.getElementById("chapter-index-display").innerText =
        `${activeSpinePointer + 1} / ${activeSpineArray.length}`;
      trackReadingProgress();
      saveAndApplyUserStyles();
      frame.classList.remove("fade-out");
    }, 150);
  } catch (err) {
    frame.innerHTML = `<p class="text-error-centered">Failed loading chapter element.</p>`;
  }
}

/**
 Parses the EPUB's TOC and renders it into the sidebar, and populates
 activeChapterTitles for the progress-bar tooltips. Must run after activeSpineArray is
 populated, since it maps TOC entries onto spine indices.
 @param {JSZip} zip - Open zip for the active book.
 @param {Document} opfDoc - Parsed OPF document, used to locate the TOC manifest item.
 @param {string} baseDir - Base directory of the OPF file, for resolving the TOC's path.
 */
async function parseAndRenderTOC(zip, opfDoc, baseDir) {
  const tocList = document.getElementById("toc-render-list");
  tocList.innerHTML = "";

  // Default chapters to "Chapter N" first. Some spine entries lack matching TOC nav points,
  // so this ensures every progress tooltip has a usable label even when the EPUB's TOC does
  // not cover that entry.
  activeChapterTitles = activeSpineArray.map((_, idx) => `Chapter ${idx + 1}`);

  let tocItem =
    opfDoc.querySelector("item[media-type='application/x-dtbncx+xml']") ||
    opfDoc.querySelector("item[properties='nav']");
  if (!tocItem) return;
  try {
    const tocPath = normalizePath(baseDir + tocItem.getAttribute("href"));
    const tocFileStr = await zip.file(tocPath).async("string");
    const tocDoc = new DOMParser().parseFromString(tocFileStr, "text/xml");
    const navPoints = tocDoc.querySelectorAll("navPoint, li");
    navPoints.forEach((node) => {
      const labelNode = node.querySelector("navLabel > text, a, span");
      const contentNode = node.querySelector("content, a");
      if (!labelNode || !contentNode) return;
      const text = labelNode.textContent.trim();
      let href =
        contentNode.getAttribute("src") || contentNode.getAttribute("href");
      if (!href) return;
      href = href.split("#")[0];
      const absoluteChapterPath = normalizePath(baseDir + href);
      const matchedSpineIdx = activeSpineArray.indexOf(absoluteChapterPath);
      // Use this TOC entry's real label for its matching chapter's progress bar tooltip
      if (matchedSpineIdx !== -1) {
        activeChapterTitles[matchedSpineIdx] = text;
      }
      const row = document.createElement("div");
      row.className = "toc-list-item";
      row.innerText = text;
      row.onclick = () => {
        if (matchedSpineIdx !== -1) {
          activeSpinePointer = matchedSpineIdx;
          renderActiveChapterFromZip(activeZipInstance);
        }
      };
      tocList.appendChild(row);
    });
  } catch (e) {
    console.warn(e);
  }
}
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