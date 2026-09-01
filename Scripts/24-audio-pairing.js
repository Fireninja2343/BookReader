// -----------------------------------------------------------------
// AUDIOBOOK PAIRING
// -----------------------------------------------------------------
/*
 Links an EPUB book to an M4B audiobook. Uses the File System Access API
 (showOpenFilePicker) so a previously-picked file can be reopened later with
 one click instead of a full re-browse, scoped to only the most-recently-active
 paired audiobook (see setLastAudioContext() in 02-db.js). Falls back to a
 plain <input type="file"> re-upload on browsers without that API (Firefox).
*/

const supportsFileHandles = typeof window.showOpenFilePicker === "function";

/**
 Opens the native file picker restricted to M4B/M4A files and returns the
 picked File plus its handle (null on browsers without File System Access
 API support, in which case only the plain File is usable this session).

 @returns {Promise<{file: File, handle: FileSystemFileHandle|null}|null>} Null if
   the user cancels the picker.
*/
async function pickAudioFile() {
  if (supportsFileHandles) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Audiobook", accept: { "audio/mp4": [".m4b", ".m4a"] } }],
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (err) {
      // AbortError = user cancelled the picker; not a real failure.
      if (err.name !== "AbortError") console.warn("[24-audio-pairing] File picker failed:", err);
      return null;
    }
  }

  console.log("[24-audio-pairing] falling back to plain <input> - no handle will be available");
  // Fallback for browsers without showOpenFilePicker: a hidden plain input.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".m4b,.m4a,audio/*";
    input.onchange = () => {
      const file = input.files[0];
      resolve(file ? { file, handle: null } : null);
    };
    input.click();
  });
}

/**
 Pairs a freshly-picked M4B with a book: extracts metadata, saves it, stores
 the file handle (if available), and marks this book as the current
 auto-resume context. Used for first-time pairing where there's nothing to
 diff against yet - see checkAudioFileForMismatch() for re-pick handling.

 @param {number} bookId - id of the EPUB book to pair.
 @param {File} file - The picked M4B file.
 @param {FileSystemFileHandle|null} handle - Handle for one-click resume, or null on unsupported browsers.
 @returns {Promise<Object>} The extracted metadata, so the caller (pairing UI) can display it immediately.
*/
async function pairAudiobookFile(bookId, file, handle) {
  const metadata = await extractM4bMetadata(file);
  await pairAudiobook(bookId, metadata);
  if (handle) {
    await saveAudioFileHandle(bookId, handle, file.name);
  }
  await setLastAudioContext(bookId);
  return metadata;
}

/**
 Attempts one-click resume for the current auto-resume-eligible audiobook:
 re-requests permission on its stored file handle (requires a user gesture,
 e.g. a "Resume Listening" button click - browsers won't grant this silently)
 and, if granted, returns the live File ready for use.

 @returns {Promise<{bookId: number, file: File}|null>} Null if there's no
   eligible book, no stored handle (e.g. unsupported browser or never picked
   with a handle), or permission was denied.
*/
async function tryAutoResumeAudio() {
  const bookId = await getLastAudioContext();
  if (bookId == null) return null;

  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !audiobook.fileHandle) return null;

  try {
    const permission = await audiobook.fileHandle.requestPermission({ mode: "read" });
    if (permission !== "granted") return null;
    const file = await audiobook.fileHandle.getFile();
    return { bookId, file };
  } catch (err) {
    // Handle may be stale (file moved/deleted, or a permission API quirk on
    // this browser) - treat as "can't auto-resume", not a hard error.
    console.warn("[24-audio-pairing] Auto-resume failed:", err);
    return null;
  }
}

// -----------------------------------------------------------------
// METADATA MISMATCH CHECK
// -----------------------------------------------------------------
/*
 Every time a file is put in hand for a book that's already paired (whether
 auto-resumed or manually re-picked), its metadata is re-extracted and
 diffed field-by-field against what's stored. Chapters compare by count and
 by each chapter's title, since start/end times can drift by fractions of a
 second between encodes of "the same" file without being a meaningful
 mismatch worth flagging.
*/

/**
 Diffs freshly-extracted metadata against a book's stored audiobook record.
 @param {Object} storedRecord - Existing STORE_AUDIOBOOKS record for this book.
 @param {Object} freshMetadata - Result of extractM4bMetadata() on the file now in hand.
 @returns {Array<{field: string, stored: string, fresh: string}>} One entry per
   mismatched field; empty array if everything matches.
*/
function diffAudiobookMetadata(storedRecord, freshMetadata) {
  const mismatches = [];

  const addIfDifferent = (field, storedVal, freshVal) => {
    if (storedVal !== freshVal) {
      mismatches.push({ field, stored: storedVal ?? "(none)", fresh: freshVal ?? "(none)" });
    }
  };

  addIfDifferent("Title", storedRecord.title, freshMetadata.title);
  addIfDifferent("Author", storedRecord.author, freshMetadata.author);

  // Duration compared to the nearest second - encodes of "the same" audio
  // can differ by sub-second container overhead without being a real mismatch.
  const storedDurationRounded = Math.round(storedRecord.duration ?? 0);
  const freshDurationRounded = Math.round(freshMetadata.duration ?? 0);
  addIfDifferent(
    "Duration",
    `${storedDurationRounded}s`,
    storedDurationRounded === freshDurationRounded ? `${storedDurationRounded}s` : `${freshDurationRounded}s`,
  );

  const storedChapters = storedRecord.chapters ?? [];
  const freshChapters = freshMetadata.chapters ?? [];
  addIfDifferent("Chapter count", storedChapters.length, freshChapters.length);

  // Only compare titles up to the shorter list's length, so a count
  // mismatch (already flagged above) doesn't also spam one row per extra
  // chapter on the longer side.
  const compareLength = Math.min(storedChapters.length, freshChapters.length);
  for (let i = 0; i < compareLength; i++) {
    addIfDifferent(`Chapter ${i + 1} title`, storedChapters[i].title, freshChapters[i].title);
  }

  return mismatches;
}

/**
 Full re-pick/resume verification flow: extracts metadata from the file now
 in hand, diffs it against the stored record, and returns both so the
 calling UI can decide what to show (silent proceed if no mismatches, or
 the mismatch table if any exist).

 @param {number} bookId - id of the book being verified.
 @param {File} file - The file now in hand (from resume or manual re-pick).
 @returns {Promise<{metadata: Object, mismatches: Array}>}
*/
async function verifyAudioFileAgainstStored(bookId, file) {
  const storedRecord = await getAudiobookForBook(bookId);
  const metadata = await extractM4bMetadata(file);
  const mismatches = storedRecord ? diffAudiobookMetadata(storedRecord, metadata) : [];
  return { metadata, mismatches };
}

// -----------------------------------------------------------------
// PAIRING UI
// -----------------------------------------------------------------
/*
 Entry points wired to the pairing panel/modal in index.html. Handles both
 first-time pairing (no stored record - no diff needed) and re-pick/resume
 (diff against stored metadata, show a mismatch table if anything differs).
*/

/** Book currently targeted by the pairing panel, set when it's opened. */
let audioPairingTargetBookId = null;

/**
 Opens the pairing panel for a given book and shows its current pairing
 state (paired/unpaired) if any.
 @param {number} bookId - id of the book to pair/manage audio for.
*/
async function openAudioPairingPanel(bookId) {
  audioPairingTargetBookId = bookId;
  const panel = document.getElementById("audio-pairing-panel");
  const statusEl = document.getElementById("audio-pairing-status");
  panel.style.display = "flex";

  // Reset transport visibility unless audio is already loaded (e.g. reopening the panel mid-listen).
  document.getElementById("audio-pairing-transport").style.display =
    activeAudioElement ? "flex" : "none";

  const existing = await getAudiobookForBook(bookId);
  statusEl.textContent = existing
    ? `Paired: ${existing.title ?? existing.lastPickedFileName ?? "(untitled)"}`
    : "No audiobook paired yet.";

  if (activeAudioElement && existing) {
    await promptSyncAudioToReading(bookId);
  }
}

function closeAudioPairingPanel() {
  document.getElementById("audio-pairing-panel").style.display = "none";
  audioPairingTargetBookId = null;
}

/**
 "Pair Audiobook" button handler. Picks a file and either pairs it directly
 (no stored record yet) or runs the mismatch check first (re-pairing over
 an existing record).
*/
async function handlePairAudiobookClick() {
  if (audioPairingTargetBookId == null) return;
  const picked = await pickAudioFile();
  if (!picked) return;

  const existing = await getAudiobookForBook(audioPairingTargetBookId);
  if (!existing) {
    const metadata = await pairAudiobookFile(audioPairingTargetBookId, picked.file, picked.handle);
    document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? picked.file.name}`;
    loadM4bAudio(picked.file);
    attachAudioPositionDisplay(audioPairingTargetBookId);
    document.getElementById("audio-pairing-transport").style.display = "flex";
    openCalibrationModal(audioPairingTargetBookId);
    promptSyncAudioToReading(audioPairingTargetBookId);
    refreshActiveBookAudioPairingCache(audioPairingTargetBookId);
    return;
  }

  const { mismatches } = await verifyAudioFileAgainstStored(audioPairingTargetBookId, picked.file);
  if (mismatches.length === 0) {
    const metadata = await pairAudiobookFile(audioPairingTargetBookId, picked.file, picked.handle);
    document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? picked.file.name}`;
    loadM4bAudio(picked.file);
    attachAudioPositionDisplay(audioPairingTargetBookId);
    document.getElementById("audio-pairing-transport").style.display = "flex";
    openCalibrationModal(audioPairingTargetBookId);
    promptSyncAudioToReading(audioPairingTargetBookId);
    refreshActiveBookAudioPairingCache(audioPairingTargetBookId);
  } else {
    showMismatchTable(mismatches, picked);
  }
}

/**
 "Resume Listening" button handler - the one user-gesture click required to
 re-request permission on a stored file handle. Runs the same mismatch
 check as a manual re-pick, since the file on disk could have changed since
 it was last paired.
*/
async function handleResumeListeningClick() {
  const resumed = await tryAutoResumeAudio();
  if (!resumed) {
    document.getElementById("audio-pairing-status").textContent =
      "Couldn't auto-resume - please re-select the file.";
    return;
  }

  const { mismatches } = await verifyAudioFileAgainstStored(resumed.bookId, resumed.file);
  if (mismatches.length === 0) {
    document.getElementById("audio-pairing-status").textContent = "Resumed, metadata matches.";
    loadM4bAudio(resumed.file);
    attachAudioPositionDisplay(resumed.bookId);
    document.getElementById("audio-pairing-transport").style.display = "flex";
    await restoreOwnListeningPosition(resumed.bookId);
    promptSyncAudioToReading(resumed.bookId);
  } else {
    showMismatchTable(mismatches, { file: resumed.file, handle: null });
  }
}

/** Pending re-pick file info, held while the mismatch table is showing a decision. */
let pendingMismatchFile = null;

/**
 Renders the mismatch table modal with Cancel / Continue / Choose Different
 File actions.
 @param {Array} mismatches - Result of diffAudiobookMetadata().
 @param {{file: File, handle: FileSystemFileHandle|null}} picked - The file under review.
*/
function showMismatchTable(mismatches, picked) {
  pendingMismatchFile = picked;
  const modal = document.getElementById("audio-mismatch-modal");
  const tbody = document.getElementById("audio-mismatch-tbody");
  tbody.innerHTML = "";

  mismatches.forEach((m) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${m.field}</td><td>${m.stored}</td><td>${m.fresh}</td>`;
    tbody.appendChild(row);
  });

  modal.style.display = "flex";
}

function closeMismatchModal() {
  document.getElementById("audio-mismatch-modal").style.display = "none";
  pendingMismatchFile = null;
}

/** "Continue" - accepts the fresh file/metadata as the new paired truth. */
async function handleMismatchContinue() {
  if (!pendingMismatchFile || audioPairingTargetBookId == null) return;
  const metadata = await pairAudiobookFile(
    audioPairingTargetBookId,
    pendingMismatchFile.file,
    pendingMismatchFile.handle,
  );
  document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? pendingMismatchFile.file.name}`;
  closeMismatchModal();
  openCalibrationModal(audioPairingTargetBookId);
  promptSyncAudioToReading(audioPairingTargetBookId);
    refreshActiveBookAudioPairingCache(audioPairingTargetBookId);
}

/** "Choose Different File" - discards this pick, re-opens the file picker. */
async function handleMismatchChooseDifferent() {
  closeMismatchModal();
  await handlePairAudiobookClick();
}

// -----------------------------------------------------------------
// POSITION MAPPING (EPUB spine <-> audio chapter)
// -----------------------------------------------------------------
/*
 Pure functions, no DOM/DB access - easy to reason about and reuse from both
 the live sync loop (audio -> scroll) and trackReadingProgress() (scroll ->
 audio position write). EPUB and M4B chapters are assumed to correspond via
 a single constant integer offset, set by chapter calibration: EPUB spine
 index N corresponds to audio chapter (N - chapterOffset). This is the
 "roughly line up" assumption from the original design doc - not a full
 per-chapter manual mapping.

 percentInChapter means the same thing on both sides: how far through the
 *current* chapter, 0-1. For EPUB this is exactly innerPct as already
 computed by trackReadingProgress() (10-reader-controls.js); for audio it's
 (currentTime - chapterStartSec) / (chapterEndSec - chapterStartSec).
*/

/**
 Converts an audio chapter position into the corresponding EPUB spine
 position.

 @param {number} chapterOffset - epubSpineIndex - audioChapterIndex, from calibration.
 @param {number} audioChapterIndex - 0-indexed chapter in the M4B's chapters array.
 @param {number} percentInChapter - 0-1, how far through that audio chapter.
 @returns {{epubSpineIndex: number, innerPct: number}}
*/
function mapChapterToScroll(chapterOffset, audioChapterIndex, percentInChapter) {
  return {
    epubSpineIndex: audioChapterIndex + chapterOffset,
    innerPct: Math.min(1, Math.max(0, percentInChapter)),
  };
}

/**
 Converts an EPUB spine position into the corresponding audio chapter
 position. Inverse of mapChapterToScroll().

 @param {number} chapterOffset - epubSpineIndex - audioChapterIndex, from calibration.
 @param {number} epubSpineIndex - 0-indexed chapter in activeSpineArray.
 @param {number} innerPct - 0-1, how far through that EPUB chapter (i.e. innerPct
   as already computed by trackReadingProgress()).
 @returns {{audioChapterIndex: number, percentInChapter: number}}
*/
function mapScrollToChapter(chapterOffset, epubSpineIndex, innerPct) {
  return {
    audioChapterIndex: epubSpineIndex - chapterOffset,
    percentInChapter: Math.min(1, Math.max(0, innerPct)),
  };
}

/**
 Resolves an audio chapter position to an absolute seek time in seconds,
 using the audiobook's actual chapter boundaries (not just the offset math -
 this is where percentInChapter gets multiplied out against a real chapter's
 duration).

 @param {Array<{startSec: number, endSec: number}>} chapters - Audiobook chapters array.
 @param {number} audioChapterIndex - 0-indexed chapter to resolve.
 @param {number} percentInChapter - 0-1, how far through that chapter.
 @returns {number|null} Absolute seconds to seek to, or null if audioChapterIndex is out of range.
*/
function chapterPositionToSeconds(chapters, audioChapterIndex, percentInChapter) {
  const chapter = chapters?.[audioChapterIndex];
  if (!chapter) return null;
  const duration = chapter.endSec - chapter.startSec;
  return chapter.startSec + percentInChapter * duration;
}

/**
 Resolves an absolute audio playback time to its chapter index + percent
 within that chapter. Inverse of chapterPositionToSeconds(). Scans linearly -
 chapter counts are small (tens, not thousands), so this is cheap enough to
 call on every sync-loop tick without needing a smarter lookup.

 @param {Array<{startSec: number, endSec: number}>} chapters - Audiobook chapters array.
 @param {number} currentTimeSec - Absolute playback position in seconds.
 @returns {{audioChapterIndex: number, percentInChapter: number}|null} Null if
   currentTimeSec falls outside every chapter (e.g. empty chapters array).
*/
function secondsToChapterPosition(chapters, currentTimeSec) {
  if (!chapters || chapters.length === 0) return null;
  const idx = chapters.findIndex((ch) => currentTimeSec >= ch.startSec && currentTimeSec < ch.endSec);
  // Falls through to the last chapter if currentTimeSec is at/past the very
  // end of the book (findIndex misses because endSec is an exclusive bound).
  const resolvedIdx = idx !== -1 ? idx : chapters.length - 1;
  const chapter = chapters[resolvedIdx];
  const duration = chapter.endSec - chapter.startSec;
  const percentInChapter = duration > 0 ? (currentTimeSec - chapter.startSec) / duration : 0;
  return { audioChapterIndex: resolvedIdx, percentInChapter: Math.min(1, Math.max(0, percentInChapter)) };
}

// -----------------------------------------------------------------
// CHAPTER CALIBRATION
// -----------------------------------------------------------------
/*
 Two-pane picker: click one EPUB chapter, click one audio chapter, save. The
 difference between their indices becomes chapterOffset. Requires the book
 to actually be open in the reader (activeSpineArray/activeChapterTitles
 populated) since that's the only place EPUB chapter titles are available -
 calibrating a book that isn't currently open just shows a message asking
 the user to open it first, rather than trying to load it separately here.
*/

let calibrationSelectedEpubIndex = null;
let calibrationSelectedAudioIndex = null;
let calibrationTargetBookId = null;

/**
 Opens the calibration modal for a book, populating both chapter lists.
 @param {number} bookId - id of the book to calibrate.
*/
async function openCalibrationModal(bookId) {
  if (bookId == null) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  calibrationTargetBookId = bookId;
  calibrationSelectedEpubIndex = null;
  calibrationSelectedAudioIndex = null;

  const epubList = document.getElementById("calibration-epub-list");
  const audioList = document.getElementById("calibration-audio-list");
  const statusEl = document.getElementById("calibration-status");

  if (!activeBookObject || activeBookObject.id !== bookId || activeSpineArray.length === 0) {
    epubList.innerHTML = "<p>Open this book in the reader first to calibrate.</p>";
    audioList.innerHTML = "";
    statusEl.textContent = "";
    document.getElementById("audio-calibration-modal").style.display = "flex";
    return;
  }

  epubList.innerHTML = "";
  activeSpineArray.forEach((_, idx) => {
    const row = document.createElement("div");
    row.textContent = `${idx + 1}. ${activeChapterTitles[idx] ?? `Chapter ${idx + 1}`}`;
    row.style.cursor = "pointer";
    row.onclick = () => selectCalibrationEpubChapter(idx, row);
    epubList.appendChild(row);
  });

  audioList.innerHTML = "";
  audiobook.chapters.forEach((ch, idx) => {
    const row = document.createElement("div");
    row.textContent = `${idx + 1}. ${ch.title ?? `Chapter ${idx + 1}`}`;
    row.style.cursor = "pointer";
    row.onclick = () => selectCalibrationAudioChapter(idx, row);
    audioList.appendChild(row);
  });

  statusEl.textContent = "Select one chapter from each side.";
  document.getElementById("audio-calibration-modal").style.display = "flex";
}

/**
 Marks an EPUB chapter row as selected (visually and in state). Deselects
 any previously-selected row in the same list first, so only one can be
 active at a time.
 @param {number} idx - 0-indexed spine position clicked.
 @param {HTMLElement} rowEl - The clicked row, for highlight styling.
*/
function selectCalibrationEpubChapter(idx, rowEl) {
  document.querySelectorAll("#calibration-epub-list > div").forEach((el) => (el.style.fontWeight = "normal"));
  rowEl.style.fontWeight = "bold";
  calibrationSelectedEpubIndex = idx;
  updateCalibrationStatus();
}

/**
 Marks an audio chapter row as selected. Same single-selection behavior as
 selectCalibrationEpubChapter().
 @param {number} idx - 0-indexed audio chapter clicked.
 @param {HTMLElement} rowEl - The clicked row, for highlight styling.
*/
function selectCalibrationAudioChapter(idx, rowEl) {
  document.querySelectorAll("#calibration-audio-list > div").forEach((el) => (el.style.fontWeight = "normal"));
  rowEl.style.fontWeight = "bold";
  calibrationSelectedAudioIndex = idx;
  updateCalibrationStatus();
}

function updateCalibrationStatus() {
  const statusEl = document.getElementById("calibration-status");
  if (calibrationSelectedEpubIndex == null || calibrationSelectedAudioIndex == null) {
    statusEl.textContent = "Select one chapter from each side.";
  } else {
    statusEl.textContent = `EPUB chapter ${calibrationSelectedEpubIndex + 1} = Audio chapter ${calibrationSelectedAudioIndex + 1}`;
  }
}

function closeCalibrationModal() {
  document.getElementById("audio-calibration-modal").style.display = "none";
  calibrationTargetBookId = null;
}

/**
 Saves the calibration: computes chapterOffset from the two selected
 indices and persists it via setAudiobookChapterOffset().
*/
async function submitCalibration() {
  if (calibrationSelectedEpubIndex == null || calibrationSelectedAudioIndex == null) return;
  const offset = calibrationSelectedEpubIndex - calibrationSelectedAudioIndex;
  await setAudiobookChapterOffset(calibrationTargetBookId, offset);
  closeCalibrationModal();
}

// -----------------------------------------------------------------
// LISTENING POSITION SNAPSHOT
// -----------------------------------------------------------------
/*
 Writes a listening-side position into STORE_AUDIO_SYNC_POSITION, the same
 store trackReadingProgress() (10-reader-controls.js) writes the reading
 side into - see updateAudioSyncPosition() (02-db.js). Without this, the
 mode-switch prompts have nothing to ever compare against, since the store
 stays permanently empty.

 Phase 2 scope only: a snapshot taken on pause/seek, not continuous tracking
 (that's Phase 3's live sync loop, which will replace/extend this with a
 write on every tick instead of only these discrete moments).
*/

/**
 Snapshots the current audio position for a paired book. Silently does
 nothing if the book isn't paired or nothing is loaded - callers don't need
 to check first.
 @param {number} bookId - id of the book whose audio position to record.
*/
async function recordListeningPosition(bookId) {
  if (bookId == null || !activeAudioElement) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  const chapterPos = secondsToChapterPosition(audiobook.chapters, activeAudioElement.currentTime);
  if (!chapterPos) return;

  await updateAudioSyncPosition(bookId, {
    chapterIndex: chapterPos.audioChapterIndex,
    percentInChapter: chapterPos.percentInChapter,
    lastMode: "listening",
  });
}

// -----------------------------------------------------------------
// ACTIVE BOOK PAIRING CACHE
// -----------------------------------------------------------------
/*
 In-memory only (never persisted) - lets trackReadingProgress()
 (10-reader-controls.js), which fires on every scroll event, skip the
 STORE_AUDIO_SYNC_POSITION write for unpaired books without an async DB
 read on every tick. No second source of truth to keep in sync: this is
 just a cache of what STORE_AUDIOBOOKS already says, refreshed whenever a
 book opens or its pairing changes, never written to independently.
*/

/** bookId of the currently open book if it's audio-paired, else null. Read by trackReadingProgress(). */
let activeBookAudioPairingCache = null;

/**
 Refreshes the cache for the book currently open in the reader. Call
 whenever a book opens (launchEpubReader()) or whenever pairing state for
 the active book might have changed (after a fresh pair, mismatch-continue,
 or resume - anywhere pairAudiobookFile() runs for the active book).
 @param {number} bookId - id of the book to check.
*/
async function refreshActiveBookAudioPairingCache(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  activeBookAudioPairingCache = audiobook ? bookId : null;
}

/**
 Restores the audio to its own last recorded listening position (not a
 cross-mode sync - just "continue where this file itself left off"). Called
 right after any successful load, before the cross-mode prompt, so
 resuming a listening session picks up mid-chapter rather than always
 restarting at 0:00. No-op (and no prompt) if no listening position was
 ever recorded, or if the most recent record was actually a reading-mode
 write (that case is what promptSyncAudioToReading() handles instead).

 @param {number} bookId - id of the book whose audio just loaded.
*/
async function restoreOwnListeningPosition(bookId) {
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook || !activeAudioElement) return;
  const position = await getAudioSyncPosition(bookId);
  if (!position || position.lastMode !== "listening") return;

  const seconds = chapterPositionToSeconds(audiobook.chapters, position.chapterIndex, position.percentInChapter);
  if (seconds != null) seekAudio(seconds);
}

// -----------------------------------------------------------------
// PAIRING PANEL & FLOATING PANEL POSITION DISPLAY
// -----------------------------------------------------------------
/*
 Live chapter/time readout, driven by the <audio> element's native
 'timeupdate' event (fires ~4x/sec during playback) rather than a separate
 polling loop - cheap, and exactly what the event exists for.

 Two display targets share one update: the pairing panel's readout and the
 reader's floating panel (index.html). Writing both from a single fetch/calc
 pass avoids duplicating the chapter-lookup logic - each target is just a
 set of element IDs, written to only if those elements actually exist, so
 whichever panel isn't currently in the DOM/visible is silently skipped
 rather than erroring. Phase 6's fuller player replaces the pairing-panel
 target entirely; the floating-panel target is expected to stay.
*/

/**
 Attaches the position-display update to the currently loaded audio
 element. Call once per load (after loadM4bAudio()) - safe to call
 repeatedly since a fresh load means a fresh element to attach to anyway.
 @param {number} bookId - id of the book whose audio is loaded, for chapter lookups.
*/
function attachAudioPositionDisplay(bookId) {
  if (!activeAudioElement) return;
  activeAudioElement.addEventListener("timeupdate", () => updateAudioPositionDisplay(bookId));
}

/**
 Writes a computed chapter/time readout into one set of display elements.
 Each id is optional - missing elements (the panel isn't in the DOM, or
 this target doesn't show all three fields) are silently skipped.
 @param {Object} ids - {chapterId, chapterTimeId, totalTimeId}, each an element id or omitted.
 @param {Object|null} chapterPos - {audioChapterIndex, percentInChapter} from secondsToChapterPosition(), or null.
 @param {Object} audiobook - The paired audiobook record.
 @param {number} currentTime - Current playback position in seconds.
*/
function writeAudioPositionDisplay(ids, chapterPos, audiobook, currentTime) {
  const chapterDisplay = ids.chapterId && document.getElementById(ids.chapterId);
  const chapterTimeDisplay = ids.chapterTimeId && document.getElementById(ids.chapterTimeId);
  const totalTimeDisplay = ids.totalTimeId && document.getElementById(ids.totalTimeId);

  if (chapterPos) {
    const chapter = audiobook.chapters[chapterPos.audioChapterIndex];
    const timeIntoChapter = currentTime - chapter.startSec;
    const chapterDuration = chapter.endSec - chapter.startSec;
    if (chapterDisplay) chapterDisplay.textContent = `${chapterPos.audioChapterIndex + 1}/${audiobook.chapters.length}`;
    if (chapterTimeDisplay) chapterTimeDisplay.textContent = `${formatTime(timeIntoChapter)}/${formatTime(chapterDuration)}`;
  }
  if (totalTimeDisplay) totalTimeDisplay.textContent = `${formatTime(currentTime)}/${formatTime(audiobook.duration)}`;
}

/**
 One-shot refresh of every known position display, called on every
 'timeupdate' tick. Looks up chapters fresh each time rather than caching
 them, since that's a cheap in-memory read (getAudiobookForBook still
 touches IndexedDB, so this trades a small async cost for never risking a
 stale chapters array after a recalibration or re-pair).
 @param {number} bookId
*/
async function updateAudioPositionDisplay(bookId) {
  if (!activeAudioElement) return;
  const audiobook = await getAudiobookForBook(bookId);
  if (!audiobook) return;

  const currentTime = activeAudioElement.currentTime;
  const chapterPos = secondsToChapterPosition(audiobook.chapters, currentTime);

  writeAudioPositionDisplay(
    { chapterId: "audio-pairing-chapter-display", chapterTimeId: "audio-pairing-chapter-time-display", totalTimeId: "audio-pairing-total-time-display" },
    chapterPos, audiobook, currentTime,
  );
  writeAudioPositionDisplay(
    { chapterId: "audio-floating-chapter-display", chapterTimeId: "audio-floating-chapter-time-display", totalTimeId: "audio-floating-total-time-display" },
    chapterPos, audiobook, currentTime,
  );
}