window.addEventListener("DOMContentLoaded", () => {
    loadSavedUserInterfaceSettings();
});

// =================================================================
// READER PROGRESS BAR
// =================================================================
function renderProgressBarTicks() {
    const tickContainer = document.getElementById("chapter-ticks-container");
    const segmentContainer = document.getElementById("chapter-segments-container");
    tickContainer.innerHTML = "";
    segmentContainer.innerHTML = "";
    if (activeSpineArray.length === 0) return;

    const boundaries = computeChapterBoundaryPercents();

    for (let i = 0; i < activeSpineArray.length; i++) {
        const segment = document.createElement("div");
        segment.className = "chapter-segment";
        segment.style.left = `${boundaries[i]}%`;
        segment.style.width = `${boundaries[i + 1] - boundaries[i]}%`;

        const tooltip = document.createElement("div");
        tooltip.className = "chapter-segment-tooltip";
        tooltip.innerText = activeChapterTitles[i] || `Chapter ${i + 1}`;
        segment.appendChild(tooltip);

        segmentContainer.appendChild(segment);
    }

    if (activeSpineArray.length > 1) {
        for (let i = 1; i < activeSpineArray.length; i++) {
            const tick = document.createElement("div");
            tick.className = "chapter-tick-marker";
            tick.style.left = `${boundaries[i]}%`;
            tickContainer.appendChild(tick);
        }
    }
}

/**
 Click handler for the reader progress bar track. Maps the click's horizontal position to
 a chapter and an in-chapter scroll percentage using the same word-weighted boundaries the
 tick marks and fill bar are drawn from, then jumps the reader there.

 @param {MouseEvent} event - The originating click event on #progress-line-track.
*/
function handleProgressBarClick(event) {
    if (!activeBookObject || activeSpineArray.length === 0) return;

    const track = document.getElementById("progress-line-track");
    const rect = track.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const targetPct = Math.min(100, Math.max(0, (clickX / rect.width) * 100));

    const boundaries = computeChapterBoundaryPercents();

    let targetChapterIndex = activeSpineArray.length - 1;
    for (let i = 0; i < activeSpineArray.length; i++) {
        if (targetPct < boundaries[i + 1] || i === activeSpineArray.length - 1) {
            targetChapterIndex = i;
            break;
        }
    }

    const chapterStart = boundaries[targetChapterIndex];
    const chapterEnd = boundaries[targetChapterIndex + 1];
    const chapterInnerScrollPercentage = chapterEnd > chapterStart
        ? (targetPct - chapterStart) / (chapterEnd - chapterStart)
        : 0;

    activeSpinePointer = targetChapterIndex;

    renderActiveChapterFromZip(activeZipInstance).then(() => {
        setTimeout(() => {
            const container = document.getElementById("reader-container");
            const maxScroll = container.scrollHeight - container.clientHeight;
            container.scrollTop = maxScroll * chapterInnerScrollPercentage;
            trackReadingProgress();
        }, 180);
    });
}

/**
 Word-weighted chapter boundary percentages (0-100), with a minimum enforced gap between
 adjacent boundaries so clusters of tiny front/back-matter chapters don't collapse into a
 single unreadable, unclickable point.

 boundaries[0] is always 0, boundaries[n] is always 100; boundaries[i] for 0 < i < n is the
 tick position between chapter i-1 and chapter i.

 This is the single source of truth for the fill bar, the tick marks, AND click-to-chapter
 mapping - all three must read from the exact same boundaries or they'll visually disagree
 with each other.

 @returns {number[]} Array of length activeSpineArray.length + 1 with the boundary
   percentages described above.
*/
function computeChapterBoundaryPercents() {
    const n = activeSpineArray.length;
    const boundaries = new Array(n + 1).fill(0);
    boundaries[n] = 100;
    if (n === 0) return boundaries;

    const chapterWordCounts = activeBookObject ? activeBookObject.chapterWordCounts : null;
    const useWeighted = Array.isArray(chapterWordCounts) && chapterWordCounts.length === n;

    // Raw, word-weighted gap (% of the whole bar) per chapter. Falls back to uniform gaps
    // whenever chapterWordCounts is missing or its length doesn't match the spine.
    let rawGaps;
    if (useWeighted) {
        const totalWords = chapterWordCounts.reduce((sum, w) => sum + w, 0);
        rawGaps = totalWords > 0
            ? chapterWordCounts.map((w) => (w / totalWords) * 100)
            : new Array(n).fill(100 / n);
    } else {
        rawGaps = new Array(n).fill(100 / n);
    }

    // Minimum visual gap, derived from the actual rendered bar width so it stays correct
    // across screen sizes instead of being a fixed % guess.
    const track = document.getElementById("progress-line-track");
    const trackWidthPx = track ? track.getBoundingClientRect().width : 0;
    const MIN_GAP_PX = Config.Miscellaneous.MIN_CHAPTER_TICK_GAP_PX || 4; // ~2x a thin tick marker
    const minGapPct = trackWidthPx > 0 ? (MIN_GAP_PX / trackWidthPx) * 100 : 0;

    /*
    Boosts any gap below the minimum up to the minimum, then shrinks every gap ABOVE the
    minimum proportionally to its own headroom above the minimum, to absorb exactly what
    was added.
    */
    const flooredIdx = [];
    const headroomIdx = [];
    let excess = 0;
    let shrinkPool = 0;
    rawGaps.forEach((g, i) => {
        if (g < minGapPct) {
            flooredIdx.push(i);
            excess += minGapPct - g;
        } else {
            headroomIdx.push(i);
            shrinkPool += g - minGapPct;
        }
    });

    const adjustedGaps = rawGaps.slice();
    flooredIdx.forEach((i) => { adjustedGaps[i] = minGapPct; });

    if (excess > 0) {
        if (shrinkPool >= excess) {
            headroomIdx.forEach((i) => {
                const share = (rawGaps[i] - minGapPct) / shrinkPool;
                adjustedGaps[i] = rawGaps[i] - excess * share;
            });
        } else {
            /*
            Pathological case: even zeroing every non-floored chapter down to the minimum
            wouldn't free enough room (minimum gap unreasonably large relative to chapter
            count / bar width). Falls back to plain uniform spacing rather than producing
            a distorted layout.
            */
            for (let i = 0; i <= n; i++) boundaries[i] = (100 / n) * i;
            return boundaries;
        }
    }

    let cumulative = 0;
    for (let i = 0; i < n; i++) {
        boundaries[i] = cumulative;
        cumulative += adjustedGaps[i];
    }
    boundaries[n] = 100;
    return boundaries;
}

function trackReadingProgress() {
    // If a book failed to parse (or hasn't loaded yet) activeSpineArray can be empty,
    // which would otherwise make chapterWeight = 100 / 0 = Infinity and turn the progress
    // displays into "NaN%" below.
    if (activeSpineArray.length === 0) return;

    const container = document.getElementById("reader-container");
    const top = container.scrollTop;

    /*
    The end-of-chapter banner increases scrollHeight after the user reaches the bottom,
    causing maxScroll to grow and preventing 100% progress. Subtracting the banner height
    keeps the denominator based on actual chapter content instead of the added UI element.
    */
    const banner = document.getElementById("chapter-end-action-banner");
    const bannerHeight = banner ? banner.offsetHeight : 0;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight - bannerHeight);

    // 1. Chapter-local progress
    const innerPct = maxScroll > 0 ? Math.min(1, top / maxScroll) : 1;
    const chapterProgressPercentage = Math.round(innerPct * 100);

    const chapterPctDisplay = document.getElementById("chapter-percentage-display");
    if (chapterPctDisplay) {
        chapterPctDisplay.innerText = `${chapterProgressPercentage}%`;
    }

    /*
    2. Whole-book progress
    bookScalePct comes from the same boundary positions the progress bar's ticks and click
    handling use (computeChapterBoundaryPercents(), further down this file), instead of
    recomputing word-weighting independently here. 
    */
    const chapterBoundaries = computeChapterBoundaryPercents();
    const bookScalePct = chapterBoundaries[activeSpinePointer] + innerPct * (chapterBoundaries[activeSpinePointer + 1] - chapterBoundaries[activeSpinePointer]);

    const totalPctDisplay = document.getElementById("percentage-display");
    const progressFillBar = document.getElementById("progress-indicator-bar");

    if (totalPctDisplay) totalPctDisplay.innerText = `${Math.round(bookScalePct)}%`;
    if (progressFillBar) progressFillBar.style.width = `${Math.round(bookScalePct)}%`;

    lastKnownBookScalePct = bookScalePct;

    // 3. Background maintenance
    if (top < maxScroll - 10) {
        overscrollCounter = 0;
    }

    // Show the end-of-chapter banner once scrolled past 95%
    if (innerPct >= 0.95 && !document.getElementById("chapter-end-action-banner")) {
        injectChapterEndBanner();
    }

    // Once the reader has genuinely scrolled to the bottom of the last chapter (innerPct
    // can now actually reach 1 since the banner is excluded above), mark the book as
    // finished so stats/library views stop showing it as in-progress.
    const isLastChapter = activeSpinePointer >= activeSpineArray.length - 1;
    if (isLastChapter && innerPct >= 1 && activeBookObject && !activeBookObject.isRead) {
        markBookAsRead(activeBookObject.id);
    }

    // Persist current position to IndexedDB
    if (activeBookObject) {
    /*
    Normally cloud pushes are throttled to avoid Firestore writes from scroll-driven
    updates. Chapter changes bypass the throttle because they are rarer and more
    important to preserve immediately. Without this, closing the tab before the next
    throttle window could lose a meaningful chapter progress update.
    */
        const chapterHasChangedSinceLastPush = lastPushedChapterIndex !== activeSpinePointer;
        updateBookProgressInDB(activeBookObject.id, activeSpinePointer, top, chapterHasChangedSinceLastPush);
        if (chapterHasChangedSinceLastPush) {
            lastPushedChapterIndex = activeSpinePointer;
            /*
             A chapter change is one of the moments the reading-history calendar (see
             13-reading-history.js) wants flushed right away: it both widens the open
             segment's chapterStart/chapterEnd range to include the newly-reached
             chapter, and persists that segment immediately rather than waiting for
             the next periodic save.
            */
            if (typeof recordHistoryChapterVisited === "function") {
                recordHistoryChapterVisited(activeSpinePointer);
                if (typeof persistHistorySegment === "function") persistHistorySegment();
            }
        }
    }
}
/*
document.getElementById("reader-container").addEventListener("wheel", (e) => {
  const container = e.currentTarget;
  const isAtBottom = container.scrollTop >= container.scrollHeight - container.clientHeight - 2;
  if (isAtBottom && e.deltaY > 0) {
    overscrollCounter++;
    if (overscrollCounter >= 3) {
      overscrollCounter = 0;
      stepToNextChapter();
    }
  }
});
*/
async function stepToNextChapter() {
    if (activeSpinePointer < activeSpineArray.length - 1) {
        activeSpinePointer++;
        await renderActiveChapterFromZip(activeZipInstance);
        saveAndApplyUserStyles();
    }
}

async function stepToPrevChapter() {
    if (activeSpinePointer > 0) {
        activeSpinePointer--;
        await renderActiveChapterFromZip(activeZipInstance);
        saveAndApplyUserStyles();
    }
}

// =================================================================
// SAVED SETTINGS
// =================================================================
function loadSavedUserInterfaceSettings() {
    const config = getUserConfig();
    if (Object.keys(config).length === 0) return;

    try {
        // Hydrate DOM element states from persistence parameters
        if (config.fontFamily) document.getElementById("setting-font-family").value = config.fontFamily;
        if (config.fontSize) document.getElementById("setting-font-size").value = config.fontSize;
        if (config.lineSpacing) document.getElementById("setting-line-spacing").value = config.lineSpacing;
        if (config.margins) document.getElementById("setting-margins").value = config.margins;
        if (config.paragraphSpacing) document.getElementById("setting-paragraph-spacing").value = config.paragraphSpacing;
        if (config.scrollSpeed) document.getElementById("setting-scroll-delay").value = config.scrollSpeed;

        // Handle explicit initialization properties for text overrides
        const overrideCheckbox = document.getElementById("setting-enable-color-override");
        if (overrideCheckbox) {
            overrideCheckbox.checked = !!config.colorOverrideEnabled;
            if (config.fontColor) document.getElementById("setting-font-color").value = config.fontColor;
            handleColorOverrideToggle(false); // Update wrapper opacity without re-applying styles
        }

        // Sync card size if saved
        if (config.cardSize) {
            const cardSizeInput = document.getElementById("setting-card-size");
            if (cardSizeInput) {
                cardSizeInput.value = config.cardSize;
                applyLibraryInterfaceSettings();
            }
        }

        // Restore the Sort Books by Group Order checkbox. Only sets the checkbox state here
        // loadedBooksMemory/loadedGroupsMemory aren't populated yet at this point in startup
        // (fetchLocalLibrary() hasn't resolved), so the setting takes visible effect the first time renderLibraryGrid()/showStatsViewState()
        // run once data actually loads, not here.
        const groupOrderedSortingCheckbox = document.getElementById("setting-group-ordered-sorting");
        if (groupOrderedSortingCheckbox) {
            groupOrderedSortingCheckbox.checked = !!config.groupOrderedSorting;
        }

        // Hydrate which optional reader header buttons the user has hidden
        if (config.hiddenReaderButtons) {
            Object.keys(READER_BUTTON_ELEMENT_MAP).forEach((key) => {
                const isHidden = !!config.hiddenReaderButtons[key];
                const checkbox = document.getElementById(`toggle-btn-${key}`);
                if (checkbox) checkbox.checked = !isHidden;
                applyReaderButtonVisibility(key, isHidden);
            });
        }
    } catch (e) {
        console.warn("Failed to load saved interface settings", e);
    }
}

// =================================================================
// OPTIONAL READER HEADER BUTTONS (Settings > Reader UI Buttons)
// =================================================================
/*
 Only buttons that aren't required for core functionality are toggleable here
 (chapter navigation, contents, stats, notes, themes)
 things like the Library button or Toggle Scroll aren't included
 since hiding them would strand the user with no way back to their
 library or no way to use a core reading feature.
*/
const READER_BUTTON_ELEMENT_MAP = Config.Miscellaneous.READER_BUTTON_ELEMENT_MAP;

/**
 Change handler for a reader header button's visibility checkbox in Settings. Applies the
 visibility change immediately and persists it for future sessions.

 @param {string} key - Key into READER_BUTTON_ELEMENT_MAP identifying which reader button
   this checkbox controls.
 @param {boolean} isChecked - Current checkbox state; checked means visible.
*/
function handleReaderButtonToggle(key, isChecked) {
    const shouldHide = !isChecked;
    applyReaderButtonVisibility(key, shouldHide);
    persistReaderButtonVisibilitySetting(key, shouldHide);
}

/**
 Shows or hides a single optional reader header button in the DOM.

 @param {string} key - Key into READER_BUTTON_ELEMENT_MAP identifying which reader button
   to toggle.
 @param {boolean} shouldHide - True to hide the button, false to show it.
*/
function applyReaderButtonVisibility(key, shouldHide) {
    const elementId = READER_BUTTON_ELEMENT_MAP[key];
    const el = elementId ? document.getElementById(elementId) : null;
    if (!el) return;
    el.classList.toggle("ui-btn-hidden", shouldHide);
}

/**
 Persists a single reader button's hidden/visible state into the saved user config, merging
 into the existing hiddenReaderButtons map rather than replacing it.

 @param {string} key - Key into READER_BUTTON_ELEMENT_MAP identifying which reader button
   this setting applies to.
 @param {boolean} isHidden - True if the button should be hidden on future loads.
*/
function persistReaderButtonVisibilitySetting(key, isHidden) {
    const config = getUserConfig();
    if (!config.hiddenReaderButtons) config.hiddenReaderButtons = {};
    config.hiddenReaderButtons[key] = isHidden;
    saveUserConfig(config);
}

function saveAndApplyUserStyles() {
    const font = document.getElementById("setting-font-family").value;
    const size = document.getElementById("setting-font-size").value;
    const lineSpacing = document.getElementById("setting-line-spacing").value;
    const margin = document.getElementById("setting-margins").value;
    const paragraphSpacing = document.getElementById("setting-paragraph-spacing").value;
    const colorOverrideEnabled = document.getElementById("setting-enable-color-override").checked;
    const color = document.getElementById("setting-font-color").value;
    const scrollSpeed = document.getElementById("setting-scroll-delay").value;
    const cardSize = document.getElementById("setting-card-size")?.value || "160";

    // Merges into whatever config is already saved (rather than replacing it outright),
    // so unrelated saved settings - like cardSize or the hiddenReaderButtons toggles
    // below - don't get silently wiped out every time a font/style control changes.
    saveUserConfig({
        fontFamily: font,
        fontSize: size,
        lineSpacing: lineSpacing,
        margins: margin,
        paragraphSpacing: paragraphSpacing,
        colorOverrideEnabled: colorOverrideEnabled,
        fontColor: color,
        scrollSpeed: scrollSpeed,
        cardSize: cardSize
    });

    document.getElementById("lbl-font-size").innerText = size;
    document.getElementById("lbl-line-spacing").innerText = lineSpacing;
    document.getElementById("lbl-margins").innerText = margin;
    document.getElementById("lbl-paragraph-spacing").innerText = paragraphSpacing;
    document.getElementById("lbl-scroll-speed").innerText = scrollSpeed;

    const frame = document.getElementById("text-render-frame");
    const container = document.getElementById("reader-container");

    container.style.padding = `40px ${margin}%`;
    frame.style.fontSize = `${size}px`;
    frame.style.lineHeight = lineSpacing;

    // Paragraph spacing: inject bottom margin into paragraphs, skipping the end banner
    frame.querySelectorAll("p, div:not(#chapter-end-action-banner), blockquote").forEach(el => {
        if (el.closest("#chapter-end-action-banner")) return;

        if (el.textContent.trim().length > 0) {
            el.style.marginBottom = `${paragraphSpacing}em`;
            el.style.marginTop = "0px";
        }
    });

    // Color override: target every element except the chapter end banner and its contents
    const targetElements = frame.querySelectorAll("*:not(#chapter-end-action-banner):not(#chapter-end-action-banner *)");

    if (colorOverrideEnabled) {
        frame.style.color = color;
        targetElements.forEach(el => el.style.color = "inherit");
    } else {
        frame.style.removeProperty("color");
        targetElements.forEach(el => el.style.removeProperty("color"));
    }

    if (font === "publisher") {
        frame.style.fontFamily = "initial";
    } else {
        frame.style.fontFamily = font;
        targetElements.forEach(el => el.style.fontFamily = "inherit");
    }
}

/**
 Change handler for the "Override Text Color" setting checkbox. Updates the color picker's
 enabled/disabled appearance and, by default, reapplies reader styles immediately.
 @param {boolean} [shouldTriggerReapply=true] - Pass false to update only the wrapper's
   enabled/disabled appearance without re-running saveAndApplyUserStyles() - used during
   initial settings hydration, before styles are meant to apply yet.
*/
function handleColorOverrideToggle(shouldTriggerReapply = true) {
    const isEnabled = document.getElementById("setting-enable-color-override").checked;
    const wrapper = document.getElementById("color-picker-wrapper");

    if (wrapper) {
        wrapper.style.opacity = isEnabled ? "1" : "0.5";
        wrapper.style.pointerEvents = isEnabled ? "auto" : "none";
    }

    if (shouldTriggerReapply) {
        saveAndApplyUserStyles();
    }
}

/**
 Opens the given reader sidebar, closing any other open sidebar first since only one
 sidebar panel is meant to be visible at a time. Closes it instead if it's already open.
 @param {string} id - Element id of the sidebar to toggle (e.g. "settings-sidebar",
   "toc-sidebar").
*/
function toggleSidebar(id) {
    const bar = document.getElementById(id);
    const isOpen = bar.classList.contains("active");
    document
        .querySelectorAll(".reader-sidebar")
        .forEach((s) => s.classList.remove("active"));
    if (!isOpen) bar.classList.add("active");
}

/**
 Settings is accessible from both library and reader views because it lives outside
 #reader-view. The content stays identical; only section ordering changes so reader
 settings are prioritized while reading and placed after library settings from the library view.
 @param {string} context - "reader" to show reader settings first, anything else to show
   library settings first (the default library-view ordering).
*/
function openSettingsPanel(context) {
    const sidebar = document.getElementById("settings-sidebar");
    const librarySection = document.getElementById("library-settings-section");
    const readerSection = document.getElementById("reader-settings-section");

    if (sidebar && librarySection && readerSection) {
        if (context === "reader") {
            sidebar.insertBefore(readerSection, librarySection);
        } else {
            sidebar.appendChild(readerSection);
        }
    }

    toggleSidebar("settings-sidebar");
}

/**
 Applies a reader/library color theme by setting the document's data-theme attribute,
 which the CSS theme rules key off of.
 @param {string} themeKey - Theme identifier matching a `[data-theme="..."]` CSS ruleset.
*/
function changeActiveTheme(themeKey) {
    document.documentElement.setAttribute("data-theme", themeKey);
}

/** 
End-Of-Chapter "Next Chapter" Banner
Triggered by trackReadingProgress() once scrolled past 95% of a chapter.
*/
function injectChapterEndBanner() {
    const frame = document.getElementById("text-render-frame");
    if (!frame || document.getElementById("chapter-end-action-banner")) return;

    const isLastChapter = activeSpinePointer >= activeSpineArray.length - 1;

    const banner = document.createElement("div");
    banner.id = "chapter-end-action-banner";
    banner.className = "chapter-end-banner";

    const label = document.createElement("span");
    label.innerText = isLastChapter
        ? "You've reached the end of the book."
        : "End of chapter.";
    banner.appendChild(label);

    if (!isLastChapter) {
        const nextBtn = document.createElement("button");
        nextBtn.className = "btn-next-chapter-action";
        nextBtn.innerText = "Next Chapter ⏭️";
        nextBtn.onclick = () => stepToNextChapter();
        banner.appendChild(nextBtn);
    }

    frame.appendChild(banner);
}