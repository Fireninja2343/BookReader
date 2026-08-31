// -----------------------------------------------------------------
// LIVE READING/LISTENING SYNC
// -----------------------------------------------------------------
/*
 WIP
*/

let syncModeActive = false;
let syncTickInterval = null;
/** Raw pixel offset added on top of every synced scroll position, until changed again or cleared. */
let syncUserOffsetPx = 0;

/**
 True only while the sync tick's own programmatic scroll is being applied -
 scroll events firing during this window are guaranteed sync-caused, not
 user input, and are ignored outright rather than compared/measured. This
 avoids the race a delta-comparison approach has (a user scroll landing in
 the gap between ticks could otherwise be misread as sync drift).
*/
let syncApplyingScroll = false;

/**
 Resolves the calibrated chapter offset for a paired book, defaulting to 0
 (EPUB chapter N = audio chapter N) if calibration hasn't been run yet.
 Centralizes that default so every sync function treats "uncalibrated" the
 same way instead of each guessing independently.
 @param {Object} audiobook - Record from getAudiobookForBook().
 @returns {number}
*/
function resolveChapterOffset(audiobook) {
  return audiobook.chapterOffset ?? 0;
}

/**
 Toggles live sync on/off. Turning on requires a paired book with audio
 loaded - silently does nothing if those aren't met (the button itself
 gets proper enabled/disabled styling in Phase 6).
*/
async function toggleReadingAudioSync() {
  if (syncModeActive) {
    stopReadingAudioSync();
    return;
  }
  if (!activeBookObject || !activeAudioElement) return;
  const audiobook = await getAudiobookForBook(activeBookObject.id);
  if (!audiobook) return;

  syncModeActive = true;
  syncUserOffsetPx = 0;
  attachSyncScrollListener();
  syncTickInterval = setInterval(() => runSyncTick(audiobook), 1000);
  // Run one tick immediately rather than waiting for the first interval,
  // so turning sync on visibly does something right away.
  runSyncTick(audiobook);
}

/** Turns off live sync. Does not pause audio - per design, stopping playback
    (not toggling sync) is what ends auto-scroll; this just stops the
    reader from following along. */
function stopReadingAudioSync() {
  syncModeActive = false;
  if (syncTickInterval) {
    clearInterval(syncTickInterval);
    syncTickInterval = null;
  }
  detachSyncScrollListener();
}

/**
 One tick of the live sync loop: maps the audio's current time to an EPUB
 position and scrolls there, applying the persistent user offset. Switches
 the rendered chapter first if the audio has moved into a different mapped
 chapter than what's currently on screen.

 @param {Object} audiobook - The paired audiobook record (for chapters + chapterOffset).
*/
async function runSyncTick(audiobook) {
  if (!syncModeActive || !activeAudioElement || activeAudioElement.paused) return;

  const chapterOffset = resolveChapterOffset(audiobook);
  const chapterPos = secondsToChapterPosition(audiobook.chapters, activeAudioElement.currentTime);
  if (!chapterPos) return;
  const scrollTarget = mapChapterToScroll(chapterOffset, chapterPos.audioChapterIndex, chapterPos.percentInChapter);

  if (scrollTarget.epubSpineIndex !== activeSpinePointer) {
    if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return;
    activeSpinePointer = scrollTarget.epubSpineIndex;
    await renderActiveChapterFromZip(activeZipInstance);
  }

  applySyncedScroll(scrollTarget.innerPct);
}

/**
 Applies a chapter-relative percent to the reader's actual scrollTop,
 adding the persistent user offset on top. Wrapped in the syncApplyingScroll
 lock so the resulting scroll event is recognized as programmatic, not user
 input - see the manual-offset section below.

 @param {number} innerPct - 0-1 target position within the current chapter.
*/
function applySyncedScroll(innerPct) {
  const container = document.getElementById("reader-container");
  const maxScroll = container.scrollHeight - container.clientHeight;
  const target = Math.max(0, Math.min(maxScroll, innerPct * maxScroll + syncUserOffsetPx));

  syncApplyingScroll = true;
  container.scrollTop = target;
  // scrollTop assignment fires 'scroll' synchronously in some browsers and
  // asynchronously (next microtask/frame) in others - releasing the lock on
  // a timeout rather than immediately after the assignment covers both,
  // at the cost of a short window where a genuine user scroll landing in
  // that same handful of milliseconds would also be ignored. Given ticks
  // are 1s apart, this window is a small fraction of the gap between them.
  setTimeout(() => {
    syncApplyingScroll = false;
  }, 50);
}

// -----------------------------------------------------------------
// MANUAL-SCROLL OFFSET DETECTION
// -----------------------------------------------------------------
/*
 A capturing-phase listener runs alongside the existing
 onscroll="trackReadingProgress()" HTML binding rather than replacing it -
 both fire independently, trackReadingProgress() keeps saving normal
 reading position regardless of sync state.

 Any scroll event that fires while syncApplyingScroll is false is
 unambiguously user-caused (wheel, drag, keyboard) - the reader's actual
 scrollTop, compared against what the last sync tick targeted, becomes the
 new persistent offset. This does NOT fight the user: sync keeps running on
 the next tick, just from the new offset going forward, per the design.
*/

let syncLastTickTargetScrollTop = null;

function attachSyncScrollListener() {
  document.getElementById("reader-container").addEventListener("scroll", handleSyncScrollEvent);
}

function detachSyncScrollListener() {
  document.getElementById("reader-container").removeEventListener("scroll", handleSyncScrollEvent);
  syncLastTickTargetScrollTop = null;
}

function handleSyncScrollEvent() {
  if (!syncModeActive || syncApplyingScroll) return;
  const container = document.getElementById("reader-container");
  if (syncLastTickTargetScrollTop != null) {
    syncUserOffsetPx += container.scrollTop - syncLastTickTargetScrollTop;
  }
  syncLastTickTargetScrollTop = container.scrollTop;
}

// -----------------------------------------------------------------
// MODE-SWITCH PROMPTS
// -----------------------------------------------------------------
/*
 Triggered right when a file loads successfully (fresh pair, resume, or
 opening the reader) - the earliest natural moment, and consistent with
 where chapter calibration already auto-opens. Declining leaves the
 current position untouched; this never forces a jump.
*/

/**
 Call after the reader opens for a paired book. If a listening session is
 recorded as more recent than the reader's own last-known position, offers
 to jump the reader to that spot.
 @param {number} bookId - id of the book just opened in the reader.
*/
async function maybePromptSyncReadingToAudio(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "listening") return;

  const confirmed = confirm("Continue reading from your last listening session?");
  if (!confirmed) return;

  const chapterOffset = resolveChapterOffset(audiobook);
  const scrollTarget = mapChapterToScroll(chapterOffset, position.chapterIndex, position.percentInChapter);
  if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return;

  activeSpinePointer = scrollTarget.epubSpineIndex;
  await renderActiveChapterFromZip(activeZipInstance);
  const container = document.getElementById("reader-container");
  const maxScroll = container.scrollHeight - container.clientHeight;
  container.scrollTop = scrollTarget.innerPct * maxScroll;
}

/**
 Call after audio finishes loading (pair, resume) for a paired book. If a
 reading session is recorded as more recent than the audio's own position,
 offers to seek audio to that spot.
 @param {number} bookId - id of the book whose audio just loaded.
*/
async function maybePromptSyncAudioToReading(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !activeAudioElement) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "reading") return;

  const confirmed = confirm("Jump audio to your last reading session?");
  if (!confirmed) return;

  const chapterOffset = resolveChapterOffset(audiobook);
  const chapterPos = mapScrollToChapter(chapterOffset, position.chapterIndex, position.percentInChapter);
  const seconds = chapterPositionToSeconds(audiobook.chapters, chapterPos.audioChapterIndex, chapterPos.percentInChapter);
  if (seconds != null) seekAudio(seconds);
}