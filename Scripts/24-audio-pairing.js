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

  // Reset transport visibility unless audio is already loaded (e.g. reopening
  // the panel mid-listen). Simple presence check - Phase 1 doesn't track
  // which book's audio is loaded, just whether anything is.
  document.getElementById("audio-pairing-transport").style.display =
    activeAudioElement ? "flex" : "none";

  const existing = await getAudiobookForBook(bookId);
  statusEl.textContent = existing
    ? `Paired: ${existing.title ?? existing.lastPickedFileName ?? "(untitled)"}`
    : "No audiobook paired yet.";
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
    document.getElementById("audio-pairing-transport").style.display = "flex";
    return;
  }

  const { mismatches } = await verifyAudioFileAgainstStored(audioPairingTargetBookId, picked.file);
  if (mismatches.length === 0) {
    const metadata = await pairAudiobookFile(audioPairingTargetBookId, picked.file, picked.handle);
    document.getElementById("audio-pairing-status").textContent = `Paired: ${metadata.title ?? picked.file.name}`;
    loadM4bAudio(picked.file);
    document.getElementById("audio-pairing-transport").style.display = "flex";
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
    document.getElementById("audio-pairing-transport").style.display = "flex";
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
}

/** "Choose Different File" - discards this pick, re-opens the file picker. */
async function handleMismatchChooseDifferent() {
  closeMismatchModal();
  await handlePairAudiobookClick();
}