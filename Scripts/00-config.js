const Config = {
  Db: {
    DB_NAME: "LocalEpubReaderDB_v2",
    STORE_BOOKS: "books",
    STORE_GROUPS: "groups",
    STORE_NOTES: "notes",
    STORE_NOTE_GROUPS: "noteGroups",
    COLLAPSED_NOTE_TAG_KEYS_STORAGE_KEY: "EpubReader_CollapsedNoteTagKeys_v1",
    LAST_NOTE_TAGS_STORAGE_KEY: "EpubReader_LastNoteTagIds_v1",
    USER_CONFIG_STORAGE_KEY: "EpubReader_UserConfig_v1",
  },
  AutoScroller: {
    AUTOSCROLL_DEBUG: false,
    MIN_STEP_PX: 20,
    MAX_STEP_PX: 500,
    FALLBACK_STEP_PX: 100,
    TARGET_WORDS_PER_TICK: 50,
  },
  Sync: {
    FILE_CHUNK_SIZE: 700000,
    CLOUD_PROGRESS_PUSH_INTERVAL_MS: 20000,
    IDLE_THRESHOLD_MS: 20000,
    FORCE_PUSH_MIN_GAP_MS : 2000,
    PUSH_RETRY_IMMEDIATE_ATTEMPTS: 2,
    PUSH_RETRY_IMMEDIATE_DELAY_MS: 1500,
    PUSH_RETRY_QUEUE_DRAIN_INTERVAL_MS: 30000,
  },
  Reading: {
    SESSION_INACTIVITY_TIMEOUT_MS: 5 * 60 * 1000, //mins * 60(from min->s) * 1000(from s->ms)
    MAX_STORED_SESSIONS_PER_BOOK: 50,
    MAX_STORED_HISTORY_ENTRIES_PER_BOOK: 365,
    PAUSED_INACTIVITY_THRESHOLD_MS: 7 * 24 * 60 * 60 * 1000, // Days (*24 -> h *60 -> min *60 -> s *1000 ->ms)
    MIN_MEANINGFUL_TRACKED_SECONDS: 30,
    TRACKING_TICK_MS: 2000,
    /*
     Nominal word-count floor for chapters that parse to 0 words (cover pages, pure-image chapters, etc.)
     when building chapterWordCounts in computeEpubWordStats().
     Without this floor, a 0-word chapter would have zero weight in the per-chapter-weighted progress calculation in trackReadingProgress(),
     meaning scrolling through it wouldn't move the whole-book progress percentage at all.
     Only affects the weighting array; totalWords/totalPages (used for page-count estimates)
     still accumulate the true, unfloored per-chapter counts.
    */
    ZERO_WORD_CHAPTER_FLOOR: 1,
    /*
     Pages-per-hour bounds used by appendReadingSession() (02-db.js) to
     tell a real reading session apart from noise. Sessions implying a rate
     above MAX are almost certainly a progress-bar jump rather than actual
     reading; sessions implying a rate below MIN indicate negligible/no
     real progress despite the tab being open (idle tab, stalled
     autoscroll, etc.), as opposed to genuinely slow reading, which still
     clears this floor. Only applied to sessions that already clear the
     60-second minimum duration - see the comment in appendReadingSession()
     for why very short sessions skip the rate check entirely.
    */
    MAX_PLAUSIBLE_PAGES_PER_HOUR: 500,
    MIN_PLAUSIBLE_PAGES_PER_HOUR: 10,
  },
  firebaseConfig: {
    apiKey: "AIzaSyB-lHa5mHi-iMdgGaTe5ehFZE1Xf2T8TkQ",
    authDomain: "epubreader-fire2343.firebaseapp.com",
    projectId: "epubreader-fire2343",
    storageBucket: "epubreader-fire2343.firebasestorage.app",
    messagingSenderId: "171569428425",
    appId: "1:171569428425:web:7e43e4deb49ab408cdda18",
    measurementId: "G-QB21V0K0KP",
  },
  Miscellaneous: {
    DEFAULT_GROUP_COLOR: '#252538',
    READING_STATUS: {
      COMPLETED: "completed",
      IN_PROGRESS: "inProgress",
      PAUSED: "paused",
      NOT_STARTED: "notStarted",
    },
    READER_BUTTON_ELEMENT_MAP: {
      toc: "btn-toggle-toc",
      prev: "btn-prev-chapter",
      next: "btn-next-chapter",
      stats: "btn-global-stats",
      notes: "btn-global-notes",
      themes: "theme-selector",
      sort: "sort-selector",
      viewMode: "library-view-mode",
      openSelected: "btn-open-book",
      lastRead: "btn-last-read",
      hardReload: "btn-hard-reload",
      clearLocalData: "btn-clear-local-data",
      hardPull: "btn-hard-pull",
      hardPush: "btn-hard-push",
      softPull: "btn-soft-pull",
      softPush: "btn-soft-push",
    },
    APPROX_AVERAGE_CUTOFF_MIN_PERCENT: 1,
    APPROX_AVERAGE_CUTOFF_MAX_PERCENT: 8,
    APPROX_AVERAGE_CUTOFF_SCALE: 2.5,
    VERY_HIGH_THRESHOLD_PERCENT: 75,
    NOTE_SELECTION_BUTTON_TOUCH_OFFSET_PX: 10,
  },
  Timelines: {
    GANTT_SCROLL_PX_PER_DAY: 48,
    HEATMAP_MAX_WEEKS : 106,
    HEATMAP_MIN_WEEKS : 8,
    HEATMAP_CELL_PX : 12,
    HEATMAP_GAP_PX : 3,
    HEATMAP_LEVEL_THRESHOLDS : [0, 0.15, 0.4, 0.7, 1],
    HEATMAP_REFERENCE_PERCENTILE: 0.9,
    HEATMAP_MIN_DAYS_FOR_PERCENTILE_REFERENCE: 5,
  },
  VersionBadge: {
    REPO_OWNER: "Fireninja2343",
    REPO_NAME: "EpubReader",
    REPO_BRANCH: "Notes&Firebase-sync",
    // 1.0 - First Release
    // 1.1 - Firebase Sync
    // 1.2 - Notes
    // 1.3+ - Future
    MAJOR_MINOR: "1.2",
    CACHE_KEY: "EpubReader_VersionBadgeCache_v1",
    AUTO_REFRESH_MS: 15 * 60 * 1000,
    CACHE_TTL_MS: 5 * 60 * 1000,
    MANUAL_REFRESH_COOLDOWN: 10 * 1000,
    TIME_BEFORE_SHOWING_DATE: 1000 * 60 * 60 * 24 * 30 * 1, // *1000 -> s, *60 -> min, *60 -> h, *24 -> days, *30 -> months, *1 -> month amount
  },
};