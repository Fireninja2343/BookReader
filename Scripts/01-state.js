// =================================================================
// GLOBAL STATE
// =================================================================
let db = null;
const DB_NAME = Config.Db.DB_NAME;
const STORE_BOOKS = Config.Db.STORE_BOOKS;
const STORE_GROUPS = Config.Db.STORE_GROUPS;
const STORE_NOTES = Config.Db.STORE_NOTES;
const STORE_NOTE_GROUPS = Config.Db.STORE_NOTE_GROUPS;

let focusedTimeTrackerHeartbeatInterval = null;
let currentActiveContextBookIndexId = null; // Row targeted by the 3-dots panel trigger

let currentSessionStartTime = null;
let currentSessionLastInteractionTime = null;
let currentSessionStartChapterPointer = null;
/**  Whole-book % at session start, for in-chapter-aware pagesRead */
let currentSessionStartBookScalePct = null;
/** Latest whole-book % from `trackReadingProgress()` (`10-reader-controls.js`) */
let lastKnownBookScalePct = 0;

let currentPauseStartTime = null;
let currentSessionPausedMs = 0;

let loadedBooksMemory = [];
let loadedGroupsMemory = [];
let selectedBookIds = [];
let activeBookObject = null;
let activeZipInstance = null;
let activeSpineArray = [];
let activeSpinePointer = 0;
/** Parallel to activeSpineArray, filled in by parseAndRenderTOC() */
let activeChapterTitles = []; 
/** Last chapter index pushed to the cloud */
let lastPushedChapterIndex = null; 
let lastSelectedBookId = null;
let overscrollCounter = 0;
/** null = Global View */
let activeGroupFilterId = null; 
/** backgroundColor of the group currently being viewed */
let activeGroupFilterColor = null; 

let globalLibraryViewMode = "grouped";

window.addEventListener("DOMContentLoaded", () => {
  initIndexedDB();
  setupKeyboardListeners();
});

/**
Switches the library view mode (e.g. "grouped" vs "all") and re-renders.
Switching to "all" also exits any active group drill-down.
@param {string} modeValue - New value for globalLibraryViewMode.
*/
function changeLibraryViewMode(modeValue) {
  globalLibraryViewMode = modeValue;
  // Exit any group drill-down when switching view modes
  if (globalLibraryViewMode === "all") {
    exitGroupView();
  } else {
    renderLibraryGrid();
  }
}

/**
 Hard-reloads the app: unregisters the Service Worker, clears Cache Storage, then
 forces a fresh network fetch via a cache-busting query param.

 Mirrors Ctrl+Shift+R, mainly for mobile where that shortcut doesn't exist.
*/
async function hardReloadApp() {
  const btn = document.getElementById("btn-hard-reload");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "🧹 Reloading...";
  }

  // Unregister the Service Worker so a fresh one (and fresh precache) loads next time
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }
  } catch (err) {
    console.warn("[HardReload] Could not unregister Service Worker:", err);
  }

  // Drop every Cache Storage bucket (precache + any runtime caches)
  try {
    if (window.caches && caches.keys) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
    }
  } catch (err) {
    console.warn("[HardReload] Could not clear Cache Storage:", err);
  }

  // location.reload() alone can still hit the browser's HTTP cache, so a
  // cache-busting query param forces a genuine network re-fetch.
  const url = new URL(window.location.href);
  url.searchParams.set("_hardReload", Date.now().toString());
  window.location.replace(url.toString());
}