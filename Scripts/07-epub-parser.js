// =================================================================
// EPUB METADATA ANALYSIS & CACHING
// =================================================================
/**
 Core word/page/chapter counting logic, shared by import, diagnostics, and stats code.
 Takes an already-open zip and parsed OPF document so callers can reuse existing data.
 @param {JSZip} zip - Already-loaded EPUB zip.
 @param {Document} opfDoc - Parsed OPF (package) document from the zip.
 @param {string} opfPath - Path to the OPF file within the zip, used to resolve manifest hrefs relative to it.
 @returns {Promise<{totalWords: number, totalPages: number, chapterCount: number, chapterWordCounts: number[]}>}
 */
async function computeEpubWordStats(zip, opfDoc, opfPath) {
  const spineElements = opfDoc.querySelectorAll("spine > itemref");
  const manifestItems = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    manifestItems[item.getAttribute("id")] = item.getAttribute("href");
  });
  const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  let totalWords = 0;
  // Per-chapter word counts, used by trackReadingProgress() (10-reader-controls.js) to
  // weight each chapter's contribution to whole-book scroll percentage by its actual size,
  // instead of treating every chapter as an equal 1/chapterCount share of the book (which
  // badly distorts progress for books with several short front-matter/cover chapters
  // before the real content starts).
  const chapterWordCounts = [];
  for (const spine of spineElements) {
    const id = spine.getAttribute("idref");
    const href = manifestItems[id];
    if (!href) {
      chapterWordCounts.push(Config.Reading.ZERO_WORD_CHAPTER_FLOOR);
      continue;
    }

    const file = zip.file(normalizePath(baseDir + href));
    if (!file) {
      chapterWordCounts.push(Config.Reading.ZERO_WORD_CHAPTER_FLOOR);
      continue;
    }

    const html = await file.async("string");
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const chapterWordCount = text ? text.split(/\s+/).length : 0;
    totalWords += chapterWordCount;
    /*
    Cover/image-only chapters parse to 0 words. Left as a literal 0 here, that chapter
    would carry zero weight in the progress-percentage calculation, meaning scrolling
    through it wouldn't move whole-book progress at all. The floor gives it a small
    nominal weight instead, so it still counts as a (tiny) sliver of the book. Only the
    weighting array uses the floor - totalWords (used for the page-count estimate below)
    keeps the true, unfloored count.
    */
    chapterWordCounts.push(chapterWordCount > 0 ? chapterWordCount : Config.Reading.ZERO_WORD_CHAPTER_FLOOR);
  }

  return {
    totalWords,
    totalPages: Math.round(totalWords / 300),
    chapterCount: spineElements.length,
    chapterWordCounts,
  };
}

/**
 Opens an EPUB from scratch and runs computeEpubWordStats() on it. Used by the
 migration pass, which only has fileData from IndexedDB, not an already-open zip/OPF.
 @param {Blob|File|ArrayBuffer} fileData - Raw EPUB file data as stored on the book record.
 @returns {Promise<{totalWords: number, totalPages: number, chapterCount: number, chapterWordCounts: number[]}>}
 */
async function analyzeEpubFile(fileData) {
  const zip = await JSZip.loadAsync(fileData);
  const { opfDoc, opfPath } = await openEpubContainer(zip);
  return computeEpubWordStats(zip, opfDoc, opfPath);
}

/**
 Backfills totalPages, totalWords, chapterCount, and chapterWordCounts for older books
 missing those fields. No-op for already-migrated books. Updates IndexedDB,
 loadedBooksMemory, and cloud sync.
 @param {object} book - Book record (must have fileData) to check/backfill.
 @returns {Promise<object>} The updated record, or the original if nothing changed.
 */
async function ensureBookMetadataCached(book) {
  if (!book || !book.fileData) return book;
  const missingMetadata =
    book.totalPages == null || book.totalWords == null || book.chapterCount == null
    || book.chapterWordCounts == null;
  if (!missingMetadata) return book;

  try {
    const { totalWords, totalPages, chapterCount, chapterWordCounts } = await analyzeEpubFile(book.fileData);
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const updatedRecord = await new Promise((resolve) => {
      store.get(book.id).onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
          record.totalPages = totalPages;
          record.totalWords = totalWords;
          record.chapterCount = chapterCount;
          record.chapterWordCounts = chapterWordCounts;
          store.put(record);
        }
        resolve(record);
      };
    });

    if (updatedRecord) {
      const idx = loadedBooksMemory.findIndex((b) => b.id === book.id);
      if (idx !== -1) loadedBooksMemory[idx] = updatedRecord;
      if (typeof pushBookMetadataToCloud === "function") {
        pushBookMetadataToCloud(updatedRecord);
      }
      return updatedRecord;
    }
  } catch (err) {
    console.warn(`Could not compute cached metadata for book ${book.id}:`, err);
  }
  return book;
}

let metadataMigrationInProgress = false;
/**
 Runs ensureBookMetadataCached() across the whole library, sequentially to avoid memory
 spikes. The metadataMigrationInProgress guard prevents overlapping runs, so it's safe
 to call this liberally.
 */
async function migrateMissingBookMetadata() {
  if (metadataMigrationInProgress) return;
  metadataMigrationInProgress = true;
  try {
    for (const book of [...loadedBooksMemory]) {
      await ensureBookMetadataCached(book);
    }
  } finally {
    metadataMigrationInProgress = false;
  }
}