// -----------------------------------------------------------------
// M4B AUDIOBOOK METADATA & CHAPTER EXTRACTION
// -----------------------------------------------------------------
/*
 Browsers can play M4B audio natively via <audio>, but expose no chapter API -
 chapter markers live inside MP4 box structures the browser doesn't surface.
 mp4box.js parses those boxes directly from an ArrayBuffer, entirely client-side.

 Two chapter tag conventions exist in the wild:
  - Nero-style: a 'chpl' box holding a flat list of {startTime, title} entries.
  - QuickTime-style: a hidden text-track (subtitle-like) where each sample's
    timed text IS the chapter title, and track duration/sample timing gives
    start/end times.
 Different encoders/tools pick one or the other. This module tries Nero first
 (simpler, more common from modern tools like m4b-tool), falls back to
 QuickTime text-track, and degrades to no-chapters (whole file as one
 unnamed chapter) if neither parses - callers should never have to
 special-case "chapters is empty".
*/

/**
 Extracts duration, chapters, cover art, title, and author from an M4B file.
 Never rejects - parse failures degrade to partial/empty results so a
 malformed or unusual file doesn't block pairing/playback entirely.

 @param {File|Blob} file - The M4B file to parse.
 @returns {Promise<{duration: number, chapters: Array<{title: string, startSec: number, endSec: number}>, coverArt: string|null, title: string|null, author: string|null}>}
*/
async function extractM4bMetadata(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = {
    duration: 0,
    chapters: [],
    coverArt: null,
    title: null,
    author: null,
  };

  const mp4boxFile = MP4Box.createFile();

  const infoPromise = new Promise((resolve) => {
    mp4boxFile.onError = (err) => {
      console.warn("[22-audio-parser] mp4box parse error:", err);
      resolve(null);
    };
    mp4boxFile.onReady = (info) => resolve(info);
  });

  // mp4box wants the buffer tagged with a byte offset so it can track how much
  // of the (possibly chunked) file it has consumed. We hand it the whole file
  // in one shot, so offset is always 0.
  arrayBuffer.fileStart = 0;
  mp4boxFile.appendBuffer(arrayBuffer);
  mp4boxFile.flush();

  const info = await infoPromise;
  if (!info) return result;

  result.duration = info.duration && info.timescale
    ? info.duration / info.timescale
    : 0;

  extractNeroChapters(mp4boxFile, result);
  if (result.chapters.length === 0) {
    extractQuickTimeChapters(mp4boxFile, info, result);
  }
  if (result.chapters.length === 0 && result.duration > 0) {
    // Degrade gracefully: one unnamed chapter spanning the whole file, so
    // downstream position-mapping code always has at least one chapter to
    // work with instead of needing a separate no-chapters code path.
    result.chapters.push({ title: null, startSec: 0, endSec: result.duration });
  }

  extractMoovMetadata(mp4boxFile, result);

  return result;
}

/**
 Attempts to read a Nero-style 'chpl' box, which mp4box exposes on the moov's
 udta.chpl if present. Populates result.chapters in place; leaves it empty
 (does not throw) if the box isn't there or isn't shaped as expected.

 @param {MP4Box} mp4boxFile - Parsed mp4box file instance.
 @param {Object} result - Result object being built by extractM4bMetadata(); mutated in place.
*/
function extractNeroChapters(mp4boxFile, result) {
  try {
    const chpl = mp4boxFile.moov?.udta?.chpl;
    const entries = chpl?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return;

    const chapters = entries.map((entry, i) => {
      // chpl start times are in 100-nanosecond units per the Nero spec.
      const startSec = entry.start_time / 10000000;
      return { title: entry.title || null, startSec, index: i };
    });
    chapters.sort((a, b) => a.startSec - b.startSec);

    result.chapters = chapters.map((ch, i) => ({
      title: ch.title,
      startSec: ch.startSec,
      endSec: i + 1 < chapters.length ? chapters[i + 1].startSec : result.duration,
    }));
  } catch (err) {
    console.warn("[22-audio-parser] Nero chpl parse failed:", err);
  }
}

/**
 Attempts to read a QuickTime-style hidden text track, where each sample's
 text payload is a chapter title and sample timing gives start/end. Populates
 result.chapters in place; leaves it empty (does not throw) if no suitable
 text track is found.

 @param {MP4Box} mp4boxFile - Parsed mp4box file instance.
 @param {Object} info - The onReady info object from mp4box, used to find candidate tracks.
 @param {Object} result - Result object being built by extractM4bMetadata(); mutated in place.
*/
function extractQuickTimeChapters(mp4boxFile, info, result) {
  try {
    // QuickTime chapter tracks are typically an audio track's chapter
    // reference (tref 'chap') pointing at a text/subtitle track. mp4box
    // surfaces text tracks with codec starting "text" for this style.
    const textTrack = (info.tracks || []).find((t) => t.codec?.startsWith("text"));
    if (!textTrack) return;

    const samples = [];
    mp4boxFile.setExtractionOptions(textTrack.id, null, { nbSamples: 10000 });
    mp4boxFile.onSamples = (trackId, ref, trackSamples) => {
      if (trackId === textTrack.id) samples.push(...trackSamples);
    };
    mp4boxFile.start();

    if (samples.length === 0) return;

    const timescale = textTrack.timescale;
    const parsed = samples.map((s) => {
      const startSec = s.cts / timescale;
      // Text-track samples store the title as a length-prefixed string in
      // the first two bytes, per the QuickTime text sample format.
      const bytes = new Uint8Array(s.data);
      const textLen = (bytes[0] << 8) | bytes[1];
      const title = new TextDecoder().decode(bytes.slice(2, 2 + textLen)) || null;
      return { title, startSec };
    });
    parsed.sort((a, b) => a.startSec - b.startSec);

    result.chapters = parsed.map((ch, i) => ({
      title: ch.title,
      startSec: ch.startSec,
      endSec: i + 1 < parsed.length ? parsed[i + 1].startSec : result.duration,
    }));
  } catch (err) {
    console.warn("[22-audio-parser] QuickTime text-track chapter parse failed:", err);
  }
}

/**
 Best-effort extraction of title/author/cover art from standard moov
 metadata (ilst atoms). Populates result fields in place; leaves them null
 if metadata is absent or unrecognized, since M4Bs from different sources
 vary widely in what they include.

 @param {MP4Box} mp4boxFile - Parsed mp4box file instance.
 @param {Object} result - Result object being built by extractM4bMetadata(); mutated in place.
*/
/**
 mp4box doesn't parse ilst's child atoms (title/author/cover) into objects -
 it leaves them as a raw byte blob on ilst.data (confirmed via testing: the
 box comes back with has_unparsed_data: true). This walks that blob by hand.

 Each entry is: [4-byte size][4-byte type, e.g. "\xa9nam"][nested "data" atom:
 4-byte size]["data"][4-byte type flag][4-byte locale][payload bytes]. Text
 entries decode as UTF-8; the cover entry ("covr") is raw image bytes.

 @param {Uint8Array} bytes - Raw bytes from the ilst box's .data property.
 @returns {Object<string, Uint8Array>} Map of 4-char atom type (e.g. "©nam") to its raw payload bytes.
*/
function parseIlstEntries(bytes) {
  const entries = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    const entrySize = view.getUint32(offset);
    if (entrySize < 8 || offset + entrySize > bytes.length) break;
    const entryType = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));

    // Nested "data" atom starts right after the entry's own 8-byte header.
    const dataAtomOffset = offset + 8;
    if (dataAtomOffset + 16 <= offset + entrySize) {
      const dataSize = view.getUint32(dataAtomOffset);
      const dataType = new TextDecoder().decode(bytes.slice(dataAtomOffset + 4, dataAtomOffset + 8));
      if (dataType === "data" && dataAtomOffset + dataSize <= offset + entrySize) {
        // Payload starts after: 4-byte size + "data" + 4-byte type flag + 4-byte locale.
        const payloadStart = dataAtomOffset + 16;
        const payloadEnd = dataAtomOffset + dataSize;
        entries[entryType] = bytes.slice(payloadStart, payloadEnd);
      }
    }

    offset += entrySize;
  }

  return entries;
}

function extractMoovMetadata(mp4boxFile, result) {
  try {
    const ilst = mp4boxFile.moov?.udta?.meta?.ilst;
    if (!ilst || !ilst.data) return;

    const entries = parseIlstEntries(ilst.data);
    const decoder = new TextDecoder();

    if (entries["\u00a9nam"]) result.title = decoder.decode(entries["\u00a9nam"]);
    if (entries["\u00a9ART"]) result.author = decoder.decode(entries["\u00a9ART"]);
    else if (entries.aART) result.author = decoder.decode(entries.aART);

    if (entries.covr) {
      // First two bytes of a JPEG are 0xFFD8; PNG starts 0x89 0x50 ("\x89P").
      const isPng = entries.covr[0] === 0x89 && entries.covr[1] === 0x50;
      const mime = isPng ? "image/png" : "image/jpeg";
      const base64 = arrayBufferToBase64(entries.covr);
      result.coverArt = `data:${mime};base64,${base64}`;
    }
  } catch (err) {
    console.warn("[22-audio-parser] moov metadata extraction failed:", err);
  }
}

/**
 Converts a raw ArrayBuffer/TypedArray to a base64 string, chunked to avoid
 call-stack limits on String.fromCharCode.apply() for large cover images.

 @param {ArrayBuffer|Uint8Array} buffer - Raw bytes to encode.
 @returns {string} Base64-encoded string.
*/
function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}