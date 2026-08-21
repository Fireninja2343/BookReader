// -----------------------------------------------------------------
// DATABASE MANAGEMENT
// -----------------------------------------------------------------
function initIndexedDB() {
  const request = indexedDB.open(DB_NAME, 2);
  request.onupgradeneeded = (e) => {
    const database = e.target.result;
    if (!database.objectStoreNames.contains(STORE_BOOKS)) {
      database.createObjectStore(STORE_BOOKS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_GROUPS)) {
      database.createObjectStore(STORE_GROUPS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_NOTES)) {
      database.createObjectStore(STORE_NOTES, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
    if (!database.objectStoreNames.contains(STORE_NOTE_GROUPS)) {
      database.createObjectStore(STORE_NOTE_GROUPS, {
        keyPath: "id",
        autoIncrement: true,
      });
    }
  };
  request.onsuccess = (e) => {
    db = e.target.result;
    fetchLocalLibrary();
    // Guarded like pushBookMetadataToCloud() elsewhere, since 12-notes.js
    // only exists once the notes feature is loaded.
    if (typeof fetchNotesLibrary === "function") fetchNotesLibrary();
  };
  // Without this handler, a failure to open IndexedDB (blocked by private
  // browsing, storage quota, another tab holding an incompatible version
  // open, etc.) fails silently - the library just never loads.
  request.onerror = (e) => {
    console.error("Failed to open IndexedDB:", e.target.error);
    alert(
      "Could not open the local library database. Your browser may be blocking storage (e.g. private browsing mode), or another tab may need to be closed.",
    );
  };
}

function fetchLocalLibrary() {
  const transaction = db.transaction([STORE_BOOKS, STORE_GROUPS], "readonly");
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);

  let booksRequest = booksStore.getAll();
  let groupsRequest = groupsStore.getAll();

  booksRequest.onsuccess = () => {
    loadedBooksMemory = booksRequest.result;
    groupsRequest.onsuccess = () => {
      loadedGroupsMemory = groupsRequest.result;
      /* Re-sorts the in-memory library by whatever sort option the user
         currently has selected, so the UI reflects it immediately. */
      sortLibrary();
      // Fire-and-forget: backfills missing totalPages/totalWords/chapterCount
      // on older books. No-op once a book has already been migrated.
      if (typeof migrateMissingBookMetadata === "function") {
          migrateMissingBookMetadata();
      }
      // Fire-and-forget migration for missing lastModified fields on books/groups.
      // No-op once every record has a timestamp.
      if (typeof migrateMissingLastModified === "function") {
        migrateMissingLastModified();
      }
      /*
      Fire-and-forget migration for groups created before drag-and-drop
      reordering existed. Assigns dense 0-indexed sortOrder values so
      existing groups render in a stable order. See
      migrateMissingGroupSortOrder() for details.
      */
      if (typeof migrateMissingGroupSortOrder === "function") {
        migrateMissingGroupSortOrder();
      }
    };
  };
}

/**
 Creates a new book record in STORE_BOOKS and pushes it (metadata and file)
 to the cloud once saved locally.

 @param {string} title - Book title, used as the display title until edited.
 @param {string|null} coverData - Base64-encoded cover image, or null if none was found.
 @param {File|Blob} binaryData - The raw EPUB file contents, stored as fileData.
 @param {Object} [analysisMeta={}] - Word/page/chapter stats from `computeEpubWordStats()`
   (see `handleFileImport` in `08-epub-import.js`), so the stats views never reparse this file
   just to show page counts. Fields are left null if the caller didn't pass anything, in
   which case ensureBookMetadataCached() backfills them later.
 @returns {Promise<void>} Resolves once the save transaction completes (or errors), so the
   import loop can move on to the next file either way.
*/
function saveBookToDatabase(title, coverData, binaryData, analysisMeta = {}) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const entry = {
      title: title,
      cover: coverData,
      fileData: binaryData,
      sortOrder: loadedBooksMemory.length,
      currentChapter: 0,
      scrollOffset: 0,
      isRead: false,
      dateImported: new Date().getTime(),
      /** Whatever group the library is currently filtered to becomes the
         new book's group, so it lands where the user is actively looking. */
      groupId: activeGroupFilterId,
      /** Used later to decide which copy (this device's or the cloud's) is
         newer when reconciling data during a Firebase sync. */
      lastModified: new Date().getTime(),
      /** One-time EPUB analysis computed by the caller from the zip it
         already has open (see `handleFileImport` in `06-epub-reader.js`), so
         the stats views never reparse this file just to show page counts.
         Left null if the caller didn't pass anything, in which case
         ensureBookMetadataCached() backfills it later. */
      totalPages: analysisMeta.totalPages ?? null,
      totalWords: analysisMeta.totalWords ?? null,
      chapterCount: analysisMeta.chapterCount ?? null,
      /* Per-chapter word counts, used by trackReadingProgress()
         (10-reader-controls.js) to weight each chapter's share of
         whole-book progress by its actual size. Same null-until-backfilled
         treatment as the three fields above: see ensureBookMetadataCached()
         in 07-epub-parser.js. */
      chapterWordCounts: analysisMeta.chapterWordCounts ?? null,
      /* Reading-history fields, updated as the book is actually read: see
         recordReadingSessionStart() below and markBookAsRead(). */
      firstOpened: null,
      lastOpened: null,
      completedDate: null,
      totalSessions: 0,
      // Real reading-session log (see continueOrStartReadingSession() /
      // endReadingSession() in 12-context-menu.js). Tracks actual engaged
      // reading time instead of estimating from launches and total time.
      readingSessions: [],
      // Raw per-session activity log powering the reading-activity heatmap
      // (17-reading-history.js). Stores timestamps and chapter progress so
      // metrics like pages/day can be derived later without storing derived values.
      readingHistory: [],
    };
    store.add(entry).onsuccess = (e) => {
      const newId = e.target.result;
      fetchLocalLibrary();
      // Push the freshly imported book up to the cloud (no-op if not signed in)
      if (typeof pushBookMetadataToCloud === "function") {
        const savedBook = { ...entry, id: newId };
        pushBookMetadataToCloud(savedBook);
        pushBookFileToCloud(savedBook);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve(); // Resolve either way so the import loop doesn't hang
  });
}

/*
 Firestore has a limited daily write quota, so pushing every scroll update
 would exhaust it during normal reading. IndexedDB still updates
 immediately; only Firestore writes are throttled, so each book syncs at
 most once per CLOUD_PROGRESS_PUSH_INTERVAL_MS window.
*/
let lastCloudProgressPush = {};
// Reuses the single source of truth in Config instead of a second hardcoded
// copy that could drift out of sync with it.
const CLOUD_PROGRESS_PUSH_INTERVAL_MS = Config.Sync.CLOUD_PROGRESS_PUSH_INTERVAL_MS;

/**
 Persists the reader's current position for a book to IndexedDB, and mirrors it to the
 cloud subject to the CLOUD_PROGRESS_PUSH_INTERVAL_MS throttle below.

 @param {number} bookId - id of the book being updated.
 @param {number} spinePointer - Index into the book's spine array for the current chapter.
 @param {number} scrollPosition - Scroll position within the current chapter, stored as a
   fraction (0-1) of the chapter's scrollable height. See `trackReadingProgress()` (10-reader-controls.js) and
   `launchEpubReader()` (09-epub-reader.js) for where this is computed and restored.
 @param {boolean} [forceImmediateCloudPush=false] - Bypasses the throttle for important
   updates such as chapter changes; still resets the throttle window afterward instead of
   creating extra queued writes.
*/
function updateBookProgressInDB(bookId, spinePointer, scrollPosition, forceImmediateCloudPush = false) {
  if (!bookId) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      record.currentChapter = spinePointer;
      record.scrollOffset = scrollPosition;
      record.lastModified = new Date().getTime();
      store.put(record);
      if (typeof pushBookMetadataToCloud === "function") {
        const now = Date.now();
        const last = lastCloudProgressPush[bookId] || 0;
        /*
        forceImmediateCloudPush lets callers bypass the normal throttle for
        important updates, such as chapter changes.

        The timestamp still updates after the push, so forced pushes also
        reset the throttle window instead of creating extra queued writes.
        */
        if (forceImmediateCloudPush || now - last >= CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
          lastCloudProgressPush[bookId] = now;
          pushBookMetadataToCloud(record);
        }
      }
    }
  };
}
/**
 Marks a book as read and syncs the change locally and to the cloud.
 Called on reaching the end of the last chapter,
 so books don't stay "In Progress" after being completed through reading.

 @param {number} bookId - id of the book to mark as read.
*/
function markBookAsRead(bookId) {
  if (!bookId || !db) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record && !record.isRead) {
      record.isRead = true;
      record.completedDate = new Date().getTime();
      record.lastModified = new Date().getTime();
      store.put(record);
      if (activeBookObject && activeBookObject.id === bookId) {
        activeBookObject.isRead = true;
        activeBookObject.completedDate = record.completedDate;
      }
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(record);
      }
    }
  };
}

/**
 Picks the best available completedDate estimate for books marked isRead
 that have no completedDate recorded.

 Uses fields in trust order: lastOpened, lastModified, firstOpened, then
 the current time only if no better timestamp exists.

 @param {Object} book - Book record to estimate a completion date for.
 @returns {number} Epoch-millisecond timestamp to use as the estimated completedDate.
*/
function estimateCompletionDate(book) {
  return book.lastOpened || book.lastModified || book.firstOpened || new Date().getTime();
}

/**
 GENERIC FIELD-BACKFILL MIGRATION PRIMITIVE

 Reusable field backfilling for synced records that need missing values,
 such as lastModified timestamps required for conflict resolution.

 Only touches missing fields, so repeated runs are safe without migration flags.

 @param {string} storeName - IndexedDB object store to scan and update.
 @param {function(Object): boolean} isMissing - Returns true if a record needs backfilling.
 @param {function(Object): *} computeValue - Computes the value to write for a record that
   needs it.
 @param {string} fieldName - Name of the field to set on each backfilled record.
 @param {function(Object): void} [pushFn] - Optional cloud-push callback invoked once per
   updated record after the transaction completes, so future migrations can reuse this
   primitive instead of duplicating loops.
 @returns {Promise<number>} Resolves with the number of updated records.
*/
function backfillMissingField(storeName, isMissing, computeValue, fieldName, pushFn) {
  return new Promise((resolve) => {
    if (!db) {
      resolve(0);
      return;
    }
    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    const updatedRecords = [];
    request.onsuccess = () => {
      const allRecords = request.result;
      for (const record of allRecords) {
        if (isMissing(record)) {
          record[fieldName] = computeValue(record);
          store.put(record);
          updatedRecords.push(record);
        }
      }
    };
    transaction.oncomplete = () => {
      if (typeof pushFn === "function") {
        updatedRecords.forEach((r) => pushFn(r));
      }
      resolve(updatedRecords.length);
    };
    transaction.onerror = () => resolve(0);
  });
}

/*
 Runs lastModified backfill for synced local data: books and groups.
 Notes/tags use their own migration from 12-notes.js.

 Adding another synced store only needs another backfillMissingField() call here, not a new migration function.

 The fallback value generator uses the best available timestamp signal instead of "now",
 avoiding false recent edits during sync conflict resolution.
*/
function migrateMissingLastModified() {
  backfillMissingField(
    STORE_BOOKS,
    (book) => !book.lastModified,
    (book) => book.lastOpened || book.dateImported || Date.now(),
    "lastModified",
    typeof pushBookMetadataToCloud === "function" ? pushBookMetadataToCloud : null,
  );
  backfillMissingField(
    STORE_GROUPS,
    (group) => !group.lastModified,
    () => Date.now(),
    "lastModified",
    typeof pushGroupToCloud === "function" ? pushGroupToCloud : null,
  );
}

/**
 Backfills sortOrder on groups that don't have one yet. Assigns dense 0-indexed values
 (0, 1, 2, ...) based on each group's current position in loadedGroupsMemory, giving
 manual drag-and-drop reordering (05-drag-drop.js) a stable starting order to work from.

 Skipped once every group already has a sortOrder. Mirrors
 migrateMissingLastModified()'s shape: single transaction, Promise-wrapped,
 pushes each touched record to the cloud on completion.

 @returns {Promise<number>} Resolves with the number of groups updated.
*/
function migrateMissingGroupSortOrder() {
  return new Promise((resolve) => {
    if (!db) {
      resolve(0);
      return;
    }
    const groupsMissingSortOrder = loadedGroupsMemory.filter((g) => g.sortOrder == null);
    if (groupsMissingSortOrder.length === 0) {
      resolve(0);
      return;
    }
    const transaction = db.transaction([STORE_GROUPS], "readwrite");
    const store = transaction.objectStore(STORE_GROUPS);
    const updatedRecords = [];
    loadedGroupsMemory.forEach((group, idx) => {
      if (group.sortOrder == null) {
        group.sortOrder = idx;
        group.lastModified = new Date().getTime();
        store.put(group);
        updatedRecords.push(group);
      }
    });
    transaction.oncomplete = () => {
      if (typeof pushGroupToCloud === "function") {
        updatedRecords.forEach((g) => pushGroupToCloud(g));
      }
      resolve(updatedRecords.length);
    };
    transaction.onerror = () => resolve(0);
  });
}

/**
 Finds books marked read but missing completedDate, and fills it via
 estimateCompletionDate(). Never overwrites existing dates.

 @returns {Promise<number>} Resolves with the number of updated books so callers can
   report the migration result.
*/
function migrateMissingCompletionDates() {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const request = store.getAll();
    const updatedRecords = [];
    request.onsuccess = () => {
      const allBooks = request.result;
      for (const record of allBooks) {
        if (record.isRead && !record.completedDate) {
          record.completedDate = estimateCompletionDate(record);
          record.lastModified = new Date().getTime();
          store.put(record);
          updatedRecords.push(record);
        }
      }
    };
    transaction.oncomplete = () => {
      // Mirror each backfilled record to the cloud, same as every other write path here
      if (typeof pushBookMetadataToCloud === "function") {
        updatedRecords.forEach((r) => pushBookMetadataToCloud(r));
      }
      resolve(updatedRecords.length);
    };
    transaction.onerror = () => resolve(0);
  });
}

/**
 Single-book counterpart to migrateMissingCompletionDates() above,
 for the per-book "Backfill Completion Date" context menu action.

 @param {number} bookId - id of the book to backfill a completedDate for.
 @returns {Promise<boolean>} True if the book was updated, false if it didn't need it
   (already has a date, isn't marked read, or wasn't found).
*/
function migrateSingleBookCompletionDate(bookId) {
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record && record.isRead && !record.completedDate) {
        record.completedDate = estimateCompletionDate(record);
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

/**
 Directly sets or clears a book's completedDate for manual edits.
 Unlike migration functions, this can overwrite existing dates or clear
 them entirely, since manual changes are not limited by migration rules.

 @param {number} bookId - id of the book to update.
 @param {number|null} completedDateValue - New completedDate value, or null to clear it.
 @returns {Promise<boolean>} True if the book was found and updated.
*/
function setBookCompletionDate(bookId, completedDateValue) {
  return updateBookRecord(bookId, (record) => {
    record.completedDate = completedDateValue;
  }).then((record) => !!record);
}

/**
 Directly sets or clears a book's firstOpened date for manual edits.

 @param {number} bookId - id of the book to update.
 @param {number|null} firstOpenedValue - New firstOpened value, or null to clear it.
 @returns {Promise<boolean>} True if the book was found and updated.
*/
function setBookStartDate(bookId, firstOpenedValue) {
    return updateBookRecord(bookId, (record) => {
        record.firstOpened = firstOpenedValue;
    }).then((record) => !!record);
}

/**
 Called once per reader launch - each visit opens a new potential session.

 firstOpened is set only once; lastOpened updates on every open.
 totalSessions is NOT touched here - it only increments once a session is judged real by appendReadingSession() below,
 so a quick peek that never becomes a real session doesn't inflate the count.

 @param {number} bookId - id of the book being opened.
*/
function recordReadingSessionStart(bookId) {
  if (!bookId || !db) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      const now = new Date().getTime();
      if (!record.firstOpened) record.firstOpened = now;
      record.lastOpened = now;
      record.lastModified = now;
      store.put(record);
      if (activeBookObject && activeBookObject.id === bookId) {
        activeBookObject.firstOpened = record.firstOpened;
        activeBookObject.lastOpened = record.lastOpened;
      }
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(record);
      }
    }
  };
}

/**
 Appends a completed real reading session to readingSessions and persists
 it, incrementing totalSessions alongside it. Used when a session actually
 ends, unlike recordReadingSessionStart() which only marks a launch's start.

 Sessions under 60 seconds are always discarded as noise, since the rate
 check below isn't meaningful at that scale (a couple pages turned in a few
 seconds can imply an implausible rate even during genuine reading).
 Sessions at or above 60 seconds are judged on implied pages-per-hour
 instead: too high implies a progress-bar jump, too low implies a
 stalled/idle tab. See MAX_PLAUSIBLE_PAGES_PER_HOUR/MIN_PLAUSIBLE_PAGES_PER_HOUR
 in 00-config.js.

 Trims stored sessions to MAX_STORED_SESSIONS_PER_BOOK and defaults missing
 arrays to [] so older books need no migration.

 @param {number} bookId - id of the book the session belongs to.
 @param {Object} sessionRecord - Session data to append; expects durationSeconds and
   pagesRead fields for the noise check above.
 @returns {Promise<boolean>} True if the session was accepted and persisted, false if it
   was discarded as noise or the book wasn't found.
*/
function appendReadingSession(bookId, sessionRecord) {
  if (!bookId || !db || !sessionRecord) return Promise.resolve(false);
  const duration = sessionRecord.durationSeconds || 0;
  const pages = sessionRecord.pagesRead || 0;
  const impliedPagesPerHour = duration > 0 ? (pages / (duration / 3600)) : 0;
  const isNoise = duration < 60
    || impliedPagesPerHour > Config.Reading.MAX_PLAUSIBLE_PAGES_PER_HOUR
    || impliedPagesPerHour < Config.Reading.MIN_PLAUSIBLE_PAGES_PER_HOUR;
  if (isNoise) {
    console.log(`[02-db] Discarded noise session (${duration}s, ${pages} pages read, ${impliedPagesPerHour.toFixed(1)} p/h)`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        if (!Array.isArray(record.readingSessions)) record.readingSessions = [];
        record.readingSessions.push(sessionRecord);
        const cap = Config.Reading.MAX_STORED_SESSIONS_PER_BOOK;
        if (record.readingSessions.length > cap) {
          record.readingSessions = record.readingSessions.slice(-cap);
        }
        record.totalSessions = (record.totalSessions || 0) + 1;
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.readingSessions = record.readingSessions;
          activeBookObject.totalSessions = record.totalSessions;
        }
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

/**
 Inserts or updates a single readingHistory entry, keyed by startTimestamp -
 an existing entry with the same startTimestamp is replaced in place,
 so a still-open session's entry can be updated repeatedly instead of duplicated.

 Trims stored entries to MAX_STORED_HISTORY_ENTRIES_PER_BOOK and defaults a
 missing array to [] so older books need no migration.

 @param {number} bookId - id of the book the entry belongs to.
 @param {Object} entry - Reading-activity entry to insert or update; matched against
   existing entries by its startTimestamp field.
 @returns {Promise<boolean>} True if the entry was written, false if the book wasn't found.
*/
function upsertReadingHistoryEntry(bookId, entry) {
  if (!bookId || !db || !entry) return Promise.resolve(false);
  return new Promise((resolve) => {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let updatedRecord = null;
    store.get(bookId).onsuccess = (e) => {
      const record = e.target.result;
      if (record) {
        if (!Array.isArray(record.readingHistory)) record.readingHistory = [];
        const existingIdx = record.readingHistory.findIndex(
          (h) => h.startTimestamp === entry.startTimestamp
        );
        if (existingIdx !== -1) {
          record.readingHistory[existingIdx] = entry;
        } else {
          record.readingHistory.push(entry);
          const cap = Config.Reading.MAX_STORED_HISTORY_ENTRIES_PER_BOOK;
          if (record.readingHistory.length > cap) {
            record.readingHistory = record.readingHistory.slice(-cap);
          }
        }
        record.lastModified = new Date().getTime();
        store.put(record);
        updatedRecord = record;
        if (activeBookObject && activeBookObject.id === bookId) {
          activeBookObject.readingHistory = record.readingHistory;
        }
      }
    };
    transaction.oncomplete = () => {
      if (updatedRecord && typeof pushBookMetadataToCloud === "function") {
        const now = Date.now();
        const last = lastCloudProgressPush[bookId] || 0;
        if (now - last >= CLOUD_PROGRESS_PUSH_INTERVAL_MS) {
          lastCloudProgressPush[bookId] = now;
          pushBookMetadataToCloud(updatedRecord);
        }
      }
      resolve(!!updatedRecord);
    };
    transaction.onerror = () => resolve(false);
  });
}

const FORCE_PUSH_MIN_GAP_MS = Config.Sync.FORCE_PUSH_MIN_GAP_MS;
let lastForcedCloudProgressPush = {};
/**
 Immediately pushes a book's current record to the cloud, bypassing the regular
 throttled progress push in updateBookProgressInDB(). Rate-limited per book by
 FORCE_PUSH_MIN_GAP_MS to prevent rapid repeat calls (e.g. quick library switches)
 from flooding Firestore with writes.

 @param {number} bookId - id of the book to push.
*/
function forcePushBookProgressToCloud(bookId) {
  if (!bookId || typeof pushBookMetadataToCloud !== "function") return;
  const now = Date.now();
  const lastForced = lastForcedCloudProgressPush[bookId] || 0;
  if (now - lastForced < FORCE_PUSH_MIN_GAP_MS) return;
  lastForcedCloudProgressPush[bookId] = now;

  const transaction = db.transaction([STORE_BOOKS], "readonly");
  const store = transaction.objectStore(STORE_BOOKS);
  store.get(bookId).onsuccess = (e) => {
    const record = e.target.result;
    if (record) {
      lastCloudProgressPush[bookId] = now;
      pushBookMetadataToCloud(record);
    }
  };
}