// -----------------------------------------------------------------
// LIVE READING/LISTENING SYNC
// -----------------------------------------------------------------
/*
 Bridges 23-audio-player.js (playback) and the EPUB reader (10-reader-
 controls.js / 09-epub-reader.js) using the pure mapping functions from
 24-audio-pairing.js. Owns no state those files already own - just reads
 activeAudioElement/activeSpinePointer/etc. and drives them.

 The live scroll loop uses the shared engine (26-auto-scroll.js) with a
 step function that maps audio time to a scroll delta each tick. The
 step function arms a consume‑once lock just before scrollBy() is called;
 the scroll event handler consumes the lock and ignores sync‑caused
 scrolls. This prevents the sync's own movement from being misread as
 user input, which previously caused runaway offset accumulation.
*/

let syncModeActive = false;
/** Raw pixel offset added on top of every synced scroll target, until changed again or cleared. */
let syncUserOffsetPx = 0;
/** How often the sync loop ticks. Fixed, not user-configurable.
 this is following real playback time, not an artificial reading pace. */
const SYNC_TICK_MS = 2500;

/**
 True between a sync tick arming its scrollBy() and the resulting scroll
 event being consumed by handleSyncScrollEvent() - events in this window are
 sync-caused, not user input. The handler CONSUMES the lock; there is
 deliberately no timer-based release: scroll events fire during the next
 rendering update, which is not guaranteed to happen before a setTimeout(0)
 callback, so a timed release races the event and loses, letting this
 tick's own scroll be misread as user input (which compounded into
 syncUserOffsetPx and made the reader accelerate away from the audio).
*/
let syncApplyingScroll = false;

/** Flip to true to re-enable per-tick sync logs. */
const SYNC_DEBUG = false;

/**
 Resolves the calibrated chapter offset for a paired book, defaulting to 0
 (EPUB chapter N = audio chapter N) if calibration hasn't been run yet.
 @param {Object} audiobook - Record from getAudiobookForBook().
 @returns {number}
*/
function resolveChapterOffset(audiobook) {
  return audiobook.chapterOffset ?? 0;
}

/**
 Toggles live sync on/off. Turning on requires a paired book with audio
 loaded - silently does nothing if those aren't met.
*/
async function toggleReadingAudioSync() {
  if (syncModeActive) {
    stopReadingAudioSync();
    return;
  }
  if (!activeBookObject || !activeAudioElement) return;
  const audiobook = await getAudiobookForBook(activeBookObject.id);
  if (!audiobook) return;

  if (!audiobook.syncMode) {
    alert("Please select a sync mode (Chapter or Whole) in the pairing panel first.");
    return;
  }

  syncModeActive = true;
  syncUserOffsetPx = 0;
  attachSyncScrollListener();
  startScroll({
    getStepPx: () => computeSyncStepPx(audiobook),
    getCooldownMs: () => SYNC_TICK_MS,
    colorVar: "--audio-accent",
    glowVar: "--audio-glow",
    // Force instant per tick regardless of any CSS scroll-behavior: smooth on
    // #reader-container - an animated scrollBy fires MANY scroll events, which
    // would defeat the consume-once lock (only the first would be consumed).
    scrollBehavior: "instant",
  });
}

/**
 Turns off live sync. Does not pause audio - per design, stopping playback
 (not toggling sync) is what ends auto-scroll; this just stops the reader
 from following along.
*/
function stopReadingAudioSync() {
  syncModeActive = false;
  stopScroll();
  detachSyncScrollListener();
}

/**
 Computes this tick's scroll delta: maps the audio's current time to a
 target EPUB scroll position (chapter + percent, converted to pixels, plus
 the persistent user offset) and returns target - current scrollTop.
 Called by startScroll()'s interval via getStepPx() - see 26-auto-scroll.js.
 Switches the rendered chapter first if the audio has moved into a
 different mapped chapter than what's currently on screen.

 Wrapped in the syncApplyingScroll lock (set true here, released after the
 scrollBy() this return value feeds into) so the resulting scroll event is
 recognized as programmatic, not user input.

 @param {Object} audiobook - The paired audiobook record.
 @returns {number} Pixel delta for startScroll()'s scrollBy() call. 0 if audio is paused/unavailable or nothing should move yet.
*/
function computeSyncStepPx(audiobook) {
  if (!syncModeActive || !activeAudioElement || activeAudioElement.paused) return 0;

  const container = document.getElementById("reader-container");
  if (!container) return 0;

  const chapterPos = secondsToChapterPosition(audiobook.chapters, activeAudioElement.currentTime);
  if (!chapterPos) return 0;

  const scrollTarget = mapChapterToScroll({
    mode: audiobook.syncMode,
    chapterOffset: resolveChapterOffset(audiobook),
    audioChapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject?.chapterWordCounts || [],
    totalWords: activeBookObject?.totalWords || 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

  // Audio moved into a different chapter than what's on screen: switch the
  // rendered chapter and sit this tick out. The next tick computes against
  // the new chapter's DOM.
  if (scrollTarget.epubSpineIndex !== activeSpinePointer) {
    if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return 0;
    activeSpinePointer = scrollTarget.epubSpineIndex;
    renderActiveChapterFromZip(activeZipInstance);
    syncUserOffsetPx = 0;
    return 0;
  }

  const maxScroll = container.scrollHeight - container.clientHeight;
  const targetScrollTop = Math.max(0, Math.min(maxScroll, scrollTarget.innerPct * maxScroll + syncUserOffsetPx));
  const delta = targetScrollTop - container.scrollTop;

  if (SYNC_DEBUG) {
    console.log("[sync] t:", activeAudioElement.currentTime, "chapterPos:", chapterPos,
      "target:", targetScrollTop, "current:", container.scrollTop, "delta:", delta);
  }

  // Arm the lock ONLY if scrollBy() will actually move the container. No
  // movement means no scroll event, so nothing would ever consume the lock
  // and the next genuine user scroll would be swallowed. (<1px dead-zone:
  // skipped sub-pixel deltas self-correct on the next tick because every
  // tick targets an absolute position, not a running total.)
  if (Math.abs(delta) < 1) return 0;

  // Released by handleSyncScrollEvent() when the scroll event lands - NOT by
  // a timer. See the declaration comment for why the timed release was wrong.
  syncApplyingScroll = true;
  return delta;
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

let syncLastKnownScrollTop = null;

function attachSyncScrollListener() {
  const container = document.getElementById("reader-container");
  syncApplyingScroll = false; // never inherit a stale lock from a previous session
  syncLastKnownScrollTop = container.scrollTop;
  container.addEventListener("scroll", handleSyncScrollEvent);
}

function detachSyncScrollListener() {
  document.getElementById("reader-container").removeEventListener("scroll", handleSyncScrollEvent);
  syncLastKnownScrollTop = null;
  syncApplyingScroll = false;
}

function handleSyncScrollEvent() {
  if (!syncModeActive) return;
  const container = document.getElementById("reader-container");

  // Sync-caused scroll: consume the lock, re-baseline, and do NOT touch
  // syncUserOffsetPx. Falling through would fold this tick's own delta back
  // into the offset; since the offset feeds the next tick's target
  // (delta_n = audioProgress + delta_{n-1}), the reader would accelerate
  // away from the audio.
  if (syncApplyingScroll) {
    syncApplyingScroll = false;
    syncLastKnownScrollTop = container.scrollTop;
    return;
  }

  // User scroll: fold movement since the last event into the offset.
  // lastKnown is re-baselined on BOTH paths, or a user scroll's delta would
  // also absorb the preceding sync scroll's displacement.
  if (syncLastKnownScrollTop != null) {
    syncUserOffsetPx += container.scrollTop - syncLastKnownScrollTop;
  }
  syncLastKnownScrollTop = container.scrollTop;
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
async function promptSyncReadingToAudio(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "listening") return;

  const confirmed = confirm("Continue reading from your last listening session?");
  if (!confirmed) return;

  const scrollTarget = mapChapterToScroll({
    mode: audiobook.syncMode,
    chapterOffset: resolveChapterOffset(audiobook),
    audioChapterIndex: position.chapterIndex,
    percentInChapter: position.percentInChapter,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject?.chapterWordCounts || [],
    totalWords: activeBookObject?.totalWords || 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

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
async function promptSyncAudioToReading(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !activeAudioElement) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "reading") return;

  const confirmed = confirm("Jump audio to your last reading session?");
  if (!confirmed) return;

  const chapterPos = mapScrollToChapter({
    mode: audiobook.syncMode,
    chapterOffset: resolveChapterOffset(audiobook),
    epubSpineIndex: position.chapterIndex,
    innerPct: position.percentInChapter,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject?.chapterWordCounts || [],
    totalWords: activeBookObject?.totalWords || 0,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

  const seconds = chapterPositionToSeconds(audiobook.chapters, chapterPos.audioChapterIndex, chapterPos.percentInChapter);
  if (seconds != null) seekAudio(seconds);
}