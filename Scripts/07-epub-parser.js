// =================================================================
// EPUB METADATA ANALYSIS & CACHING
// =================================================================
/*
 Core word/page/chapter counting logic, kept in one place instead of being
 duplicated across import, diagnostics, and global stats code.

 Takes an already-open zip and parsed OPF document so callers can reuse
 existing data instead of unzipping and parsing the same EPUB again.
*/
async function computeEpubWordStats(zip, opfDoc, opfPath) {
  const spineElements = opfDoc.querySelectorAll("spine > itemref");
  const manifestItems = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    manifestItems[item.getAttribute("id")] = item.getAttribute("href");
  });
  const baseDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  let totalWords = 0;
  // Per-chapter word counts, used by trackReadingProgress() (10-reader-controls.js)
  // to weight each chapter's contribution to whole-book scroll percentage by its actual size,
  // instead of treating every chapter as an equal 1/chapterCount share of the book 
  // (which badly distorts progress for books with several short front-matter/cover chapters before the real content starts).
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
    Cover/image-only chapters parse to 0 words. Left as a literal 0 here,
    that chapter would carry zero weight in the progress-percentage
    calculation, meaning scrolling through it wouldn't move whole-book
    progress at all. The floor gives it a small nominal weight instead, so
    it still counts as a (tiny) sliver of the book. Only the weighting
    array uses the floor - totalWords (used for the page-count estimate
    below) keeps the true, unfloored count.
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

/*
 Opens an EPUB from scratch and runs computeEpubWordStats() on it. This is
 the version the migration pass reaches for, since it only has fileData
 sitting in IndexedDB, not an already-open zip/OPF the way handleFileImport
 and launchEpubReader do.
*/
async function analyzeEpubFile(fileData) {
  const zip = await JSZip.loadAsync(fileData);
  const { opfDoc, opfPath } = await openEpubContainer(zip);
  return computeEpubWordStats(zip, opfDoc, opfPath);
}

/*
 Backfills totalPages, totalWords, and chapterCount for older books missing
 those fields.
 Does nothing for already-migrated books, so repeated calls during library
 loads or stats views have no cost after the first update. Updates IndexedDB,
 memory, and cloud sync like any other metadata change.
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

/*
 Runs ensureBookMetadataCached() across the library.
 Processes books sequentially instead of in parallel to avoid memory spikes
 from unzipping multiple large EPUBs at once. metadataMigrationInProgress
 prevents overlapping runs from repeated triggers during library loads or
 stats view opening.
*/
let metadataMigrationInProgress = false;
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