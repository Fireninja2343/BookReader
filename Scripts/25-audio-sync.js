// -----------------------------------------------------------------
// LIVE READING/LISTENING SYNC
// -----------------------------------------------------------------
/*
 Bridges 23-audio-player.js (playback) and the EPUB reader (10-reader-
 controls.js / 09-epub-reader.js) using the pure mapping functions from
 24-audio-pairing.js. Owns no state those files already own - just reads
 activeAudioElement/activeSpinePointer/etc. and drives them.

 The live scroll loop runs through startScroll()/stopScroll() in
 26-auto-scroll.js - the same delta-based (scrollBy) tick engine the
 word-density autoscroll uses, just with different step/cooldown/color
 params. Each tick computes a fresh scroll delta from the audio's current
 time rather than tracking an absolute target, so a missed or delayed tick
 self-corrects on the next one instead of compounding drift.

 Three things happen here:
  1. The live sync loop: while "Sync Reading to Audio" is on AND audio is
     playing, each tick maps activeAudioElement.currentTime to an EPUB
     scroll position and scrollBy()s the difference, applying the
     persistent user offset. See the manual-offset section for how user
     scrolling during sync is handled.
  2. Mode-switch prompts: when opening the reader or loading audio for a
     paired book, if the *other* mode has a newer recorded position, ask
     the user whether to jump to it. One-shot, not continuous, and not
     forced - declining leaves the current position untouched.
  3. Uncalibrated books default to offset 0 (EPUB chapter N = audio chapter
     N) rather than blocking sync outright - calibration refines this,
     it isn't a prerequisite for a rough first pass.
*/

let syncModeActive = false;
/** Raw pixel offset added on top of every synced scroll target, until changed again or cleared. */
let syncUserOffsetPx = 0;
/** How often the sync loop ticks. Fixed, not user-configurable.
 this is following real playback time, not an artificial reading pace. */
const SYNC_TICK_MS = 2500;

/**
 True only while a sync tick's own scrollBy() is being applied - scroll
 events firing during this window are guaranteed sync-caused, not user
 input, and are ignored outright rather than compared/measured. This
 avoids the race a delta-comparison approach has (a user scroll landing in
 the gap between ticks could otherwise be misread as sync drift).
*/
let syncApplyingScroll = false;

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

  // Require a sync mode to be selected
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

  if (scrollTarget.epubSpineIndex !== activeSpinePointer) {
    if (scrollTarget.epubSpineIndex < 0 || scrollTarget.epubSpineIndex >= activeSpineArray.length) return 0;
    activeSpinePointer = scrollTarget.epubSpineIndex;
    renderActiveChapterFromZip(activeZipInstance);
    syncUserOffsetPx = 0;
    return 0;
  }

  const container = document.getElementById("reader-container");
  const maxScroll = container.scrollHeight - container.clientHeight;
  const targetScrollTop = Math.max(0, Math.min(maxScroll, scrollTarget.innerPct * maxScroll + syncUserOffsetPx));

  syncApplyingScroll = true;
  setTimeout(() => { syncApplyingScroll = false; }, 0);

  console.log("[sync] currentTime:", activeAudioElement.currentTime);
  console.log("[sync] chapterPos:", chapterPos);
  console.log("[sync] scrollTarget:", scrollTarget);
  console.log("[sync] current scrollTop:", container.scrollTop);
  console.log("[sync] targetScrollTop:", targetScrollTop);
  console.log("[sync] delta:", targetScrollTop - container.scrollTop);
  console.log("[sync] mapChapterToScroll inputs:", {
    mode: audiobook.syncMode,
    chapterOffset: resolveChapterOffset(audiobook),
    audioChapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
    audiobook: audiobook,
    chapterWordCounts: activeBookObject?.chapterWordCounts,
    totalWords: activeBookObject?.totalWords,
    wholeBookOffset: audiobook.wholeBookOffset || 0,
  });

  return targetScrollTop - container.scrollTop;
}

// -----------------------------------------------------------------
// MANUAL-SCROLL OFFSET DETECTION
// -----------------------------------------------------------------

let syncLastKnownScrollTop = null;

function attachSyncScrollListener() {
  syncLastKnownScrollTop = document.getElementById("reader-container").scrollTop;
  document.getElementById("reader-container").addEventListener("scroll", handleSyncScrollEvent);
}

function detachSyncScrollListener() {
  document.getElementById("reader-container").removeEventListener("scroll", handleSyncScrollEvent);
  syncLastKnownScrollTop = null;
}

function handleSyncScrollEvent() {
  if (!syncModeActive || syncApplyingScroll) return;
  const container = document.getElementById("reader-container");
  if (syncLastKnownScrollTop != null) {
    syncUserOffsetPx += container.scrollTop - syncLastKnownScrollTop;
  }
  syncLastKnownScrollTop = container.scrollTop;
}

// -----------------------------------------------------------------
// MODE-SWITCH PROMPTS
// -----------------------------------------------------------------

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