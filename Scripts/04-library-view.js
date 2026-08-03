// =================================================================
// SELECTION DRIVERS & INTERFACE LAYOUT RENDERER
// =================================================================
function renderLibraryGrid() {
  const container = document.getElementById("grid-container");
  container.innerHTML = "";
  selectedBookIds = [];
  lastSelectedBookId = null;

  // SCENARIO 1: VIEW GROUPS AND UNASSIGNED SECTIONS (DEFAULT HIERARCHY)
  if (globalLibraryViewMode === "grouped" && activeGroupFilterId === null) {
    // Render Group Folders First, ordered by sortOrder so drag-and-drop/placement-number
    // reordering (see 03-groups.js) is actually reflected on screen instead of groups
    // always appearing in raw fetch order.
    const sortedGroups = getGroupsSortedByPlacement();
    sortedGroups.forEach((group) => {
      const card = document.createElement("div");
      card.className = "group-card";
      card.style.setProperty("--card-color", group.backgroundColor);
      card.setAttribute("draggable", "true");

      card.addEventListener("dragstart", (e) => handleGroupDragStart(e, group.id));
      card.addEventListener("dragend", handleGroupDragEnd);
      // Always allow the drop regardless of drag type: book drags (moving books INTO
      // this group) and group-reorder drags both need dropping enabled on this element.
      card.addEventListener("dragover", (e) => e.preventDefault());
      card.addEventListener("drop", (e) => {
        /*
        Both "drag a book card onto a group" (existing behavior, moves the book into
        that group) and "drag a group card onto another group" (new behavior, reorders
        groups) land on this same element's drop event, distinguished by the
        dataTransfer marker each drag type sets - see 05-drag-drop.js's
        handleCardDragStart ("grouped-cards") vs 03-groups.js's handleGroupDragStart
        ("grouped-groups").
        */
        const dragType = e.dataTransfer.getData("text/plain");
        if (dragType === "grouped-groups") {
          handleGroupDrop(e, group.id);
        } else {
          e.preventDefault();
          moveSelectedBooksToGroup(group.id);
        }
      });

      card.addEventListener("click", (e) => {
        if (e.detail === 2) {
          enterGroupView(group.id, group.name, group.backgroundColor);
        }
      });

      card.innerHTML = "";
      buildGroupCardContents(card, group);
      container.appendChild(card);
    });

    // Filter rendering scope to show ONLY standalone files with no group tags attached
    const unassignedBooks = loadedBooksMemory.filter((b) => !b.groupId);
    buildBookCardsInLayout(unassignedBooks, container);

    // SCENARIO 2: INSIDE A SPECIFIC SUB-GROUP COMPONENT FOLDER MODE
  } else if (
    globalLibraryViewMode === "grouped" &&
    activeGroupFilterId !== null
  ) {
    const structuralGroupContextBooks = loadedBooksMemory.filter(
      (b) => b.groupId === activeGroupFilterId,
    );
    buildBookCardsInLayout(structuralGroupContextBooks, container);

    // SCENARIO 3: FLAT GLOBAL LISTING - ALL BOOKS DISPLAYED REGARDLESS OF GROUPS
  } else if (globalLibraryViewMode === "all") {
    buildBookCardsInLayout(getBooksInDisplayOrder(), container);
    if (document.getElementById("setting-group-ordered-sorting")?.checked
        && document.getElementById("sort-selector")?.value === "manual") {
      renderGroupBubbleOutlines(container);
    }
  }
}

function buildGroupCardContents(card, group) {
  const groupBooks = loadedBooksMemory
    .filter((book) => book.groupId === group.id)
    .slice(0, 4);

  const previewGrid = document.createElement("div");
  previewGrid.className = "group-cover-grid";

  groupBooks.forEach((book) => {
    const coverTile = document.createElement("div");
    coverTile.className = "group-cover-tile";

    if (book.cover) {
      const coverImage = document.createElement("img");
      coverImage.src = book.cover;
      coverImage.alt = book.title || "Book cover";
      coverTile.appendChild(coverImage);
    } else {
      coverTile.classList.add("group-cover-tile-empty");
      coverTile.textContent = (book.title || "?").trim().charAt(0).toUpperCase();
    }

    previewGrid.appendChild(coverTile);
  });

  const metaContainer = document.createElement("div");
  metaContainer.className = "group-meta-container";

  const groupTitle = document.createElement("strong");
  groupTitle.className = "group-title";
  groupTitle.textContent = group.name;

  const actionRow = document.createElement("div");
  actionRow.className = "group-action-row";

  const editButton = document.createElement("button");
  editButton.className = "group-mini-btn";
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openGroupModal(true, group.id, group.name, group.backgroundColor);
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "group-mini-btn";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteGroup(group.id);
  });

  actionRow.appendChild(editButton);
  actionRow.appendChild(deleteButton);
  metaContainer.appendChild(groupTitle);
  metaContainer.appendChild(actionRow);

  card.appendChild(previewGrid);
  card.appendChild(metaContainer);
}

/*
 Draws a rounded "bubble" outline around each group's cluster of book cards in the flat
 "All Books" view, only shown while Sort Books by Group Order is active in Manual sort mode
 (see getBooksInDisplayOrder()). Purely visual - it doesn't change card layout or DOM
 structure, just measures where each group's first/last card actually landed after the grid
 laid them out and draws a positioned outline behind them, so it works with whatever
 grid/flex layout the container uses without needing to restructure it into per-group
 wrapper elements.

 Uses the min/max bounding box across all of a group's cards, so a group whose cards wrap
 across multiple grid rows still gets one continuous outline covering the whole block,
 rather than one outline per row.
*/
function renderGroupBubbleOutlines(container) {
  document.querySelectorAll(".group-bubble-outline").forEach((el) => el.remove());

  const containerRect = container.getBoundingClientRect();
  const groupedBookIds = new Set();
  loadedGroupsMemory.forEach((group) => {
    loadedBooksMemory.forEach((book) => {
      if (book.groupId === group.id) groupedBookIds.add(book.id);
    });
  });
  if (groupedBookIds.size === 0) return;

  getGroupsSortedByPlacement().forEach((group) => {
    const groupBookIds = loadedBooksMemory
      .filter((b) => b.groupId === group.id)
      .map((b) => b.id);
    if (groupBookIds.length === 0) return;

    let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
    groupBookIds.forEach((bookId) => {
      const card = container.querySelector(`.book-card[data-book-id='${bookId}']`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    });
    if (minLeft === Infinity) return; // None of this group's cards actually rendered

    const outline = document.createElement("div");
    outline.className = "group-bubble-outline";
    const padding = 10;
    outline.style.position = "absolute";
    outline.style.left = `${minLeft - containerRect.left - padding}px`;
    outline.style.top = `${minTop - containerRect.top - padding}px`;
    outline.style.width = `${(maxRight - minLeft) + padding * 2}px`;
    outline.style.height = `${(maxBottom - minTop) + padding * 2}px`;
    outline.style.pointerEvents = "none";
    // Outlines are appended after all the cards already in the DOM, which would normally
    // paint them on top; a negative z-index (paired with position: relative on the cards
    // themselves, set below) keeps them behind the cards instead.
    outline.style.zIndex = "-1";
    // Bubble-letter-style rounding: a large border-radius relative to the outline's own
    // size reads as soft/modular rather than a plain rectangle, without needing an SVG.
    outline.style.borderRadius = "24px";
    outline.style.border = `2px solid ${group.backgroundColor}`;
    outline.style.setProperty(
      "background-color",
      `color-mix(in srgb, ${group.backgroundColor} 8%, transparent)`,
    );
    container.appendChild(outline);
  });

  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  // A negative-z-index sibling only renders behind elements that establish their own
  // stacking context; without position set on the cards, they'd fall back to the
  // container's stacking context and could still end up behind the (also-a-sibling)
  // outline in some browsers. Forcing position: relative on each card guarantees it
  // paints above the outline regardless.
  container.querySelectorAll(".book-card").forEach((card) => {
    if (getComputedStyle(card).position === "static") {
      card.style.position = "relative";
    }
  });
}

// Sub-routine utility helper to pack structural card wrappers on the grid DOM
function buildBookCardsInLayout(booksScopingContextArray, targetDOMContainer) {
  booksScopingContextArray.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-card";
    card.setAttribute("draggable", "true");

    // REAL ID instead of index
    card.dataset.bookId = book.id;

    // Tint book cards while browsing inside a group folder
    if (activeGroupFilterId !== null && activeGroupFilterColor) {
      card.style.setProperty(
        "--group-tint",
        `color-mix(in srgb, ${activeGroupFilterColor} 75%, var(--bg-card))`,
      );
    } else if (globalLibraryViewMode === "all" && book.groupId) {
      // In the flat "All Books" view there's no single active group to
      // borrow a color from (books from every group are mixed together),
      // so look up each card's own group color individually.
      const ownGroup = loadedGroupsMemory.find((g) => g.id === book.groupId);
      if (ownGroup && ownGroup.backgroundColor) {
        card.style.setProperty(
          "--group-tint",
          `color-mix(in srgb, ${ownGroup.backgroundColor} 50%, var(--bg-card))`,
        );
      }
    }

    const dotsTrigger = document.createElement("div");
    dotsTrigger.className = "book-action-trigger-dots";
    dotsTrigger.innerText = "⋮";

    dotsTrigger.onclick = (e) => {
      toggleBookContextMenuFlyout(e, book.id);
    };

    card.appendChild(dotsTrigger);

    card.addEventListener("dragstart", handleCardDragStart);
    card.addEventListener("dragend", handleCardDragEnd);
    card.addEventListener("dragover", handleCardDragOver);
    card.addEventListener("drop", handleCardDrop);

    card.addEventListener("click", (e) =>
      handleGridCardClick(e, book.id, booksScopingContextArray),
    );

    const coverWrap = document.createElement("div");
    coverWrap.className = "cover-container";

    if (book.cover) {
      const img = document.createElement("img");
      img.src = book.cover;
      img.alt = book.title || "Book cover";
      coverWrap.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "cover-placeholder";
      placeholder.innerText = "📖";
      coverWrap.appendChild(placeholder);
    }

    const title = document.createElement("div");
    title.className = "book-title";
    title.innerText = book.title;

    card.appendChild(coverWrap);
    card.appendChild(title);
    targetDOMContainer.appendChild(card);
  });
}

// Stamps a book as opened just now, persists it, then launches the reader
function openBookAndTrackLastRead(book) {
  book.lastOpenedDate = Date.now();

  if (db) {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    transaction.objectStore(STORE_BOOKS).put(book);
  }

  launchEpubReader(book);
}

// Opens the currently selected book from grid selection, separate from the
// double-click shortcut. Used by #btn-open-book, which appears only when
// exactly one book is selected (see handleGridCardClick).
function openSelectedBook() {
  if (selectedBookIds.length !== 1) return;
  const book = loadedBooksMemory.find((b) => b.id === selectedBookIds[0]);
  if (book) openBookAndTrackLastRead(book);
}

// Jumps straight into whichever book was most recently opened
function openLastReadBook() {
  const candidate = loadedBooksMemory
    .filter((b) => b.lastOpenedDate)
    .sort((a, b) => b.lastOpenedDate - a.lastOpenedDate)[0];

  if (!candidate) {
    alert("No books have been opened yet.");
    return;
  }

  openBookAndTrackLastRead(candidate);
}

function handleGridCardClick(event, bookId, scopingArrayContext) {
  event.stopPropagation();

  const cards = document.querySelectorAll(".book-card");
  const openBtn = document.getElementById("btn-open-book");

  const book = scopingArrayContext.find(b => b.id === bookId);
  if (!book) return;

  if (event.detail === 2) {
    openBookAndTrackLastRead(book);
    return;
  }

  if (event.shiftKey && lastSelectedBookId !== null) {
    selectedBookIds = [];

    let foundStart = false;

    cards.forEach((c) => {
      const id = Number(c.dataset.bookId);

      if (id === lastSelectedBookId || id === bookId) {
        foundStart = !foundStart;
        selectedBookIds.push(id);
        c.classList.add("selected");
      } else if (foundStart) {
        selectedBookIds.push(id);
        c.classList.add("selected");
      } else {
        c.classList.remove("selected");
      }
    });

  } else {
    selectedBookIds = [bookId];
    lastSelectedBookId = bookId;

    cards.forEach((c) => {
      c.classList.toggle(
        "selected",
        Number(c.dataset.bookId) === bookId
      );
    });
  }

  if (openBtn) {
    openBtn.style.display =
      selectedBookIds.length === 1 ? "inline-block" : "none";
  }
}

/*
 Books in the order the library/stats views should actually display, accounting for the
 "Sort Books by Group Order" setting (see applyLibraryInterfaceSettings()).

 Alphabetical/Date Imported sort modes always override group ordering per user preference,
 since those are explicit whole-library sorts the user picked - group order only applies
 in Manual mode, and only when the setting is on. When both conditions hold, books are
 listed group-by-group (following each group's own sortOrder), each group's books kept in
 their own manual order, with ungrouped books appended last in their own manual order.

 Returns loadedBooksMemory itself (not a copy) whenever grouping isn't applied, since
 callers only read from the result - they don't need copy-on-read semantics here.
*/
function getBooksInDisplayOrder() {
    const sortMode = document.getElementById("sort-selector")?.value;
    const groupOrderedSorting = !!document.getElementById("setting-group-ordered-sorting")?.checked;

    if (sortMode !== "manual" || !groupOrderedSorting) {
        return loadedBooksMemory;
    }

    const sortedGroups = getGroupsSortedByPlacement();
    const ordered = [];
    sortedGroups.forEach((group) => {
        const groupBooks = loadedBooksMemory
            .filter((b) => b.groupId === group.id)
            .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        ordered.push(...groupBooks);
    });
    const ungroupedBooks = loadedBooksMemory
        .filter((b) => !b.groupId)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    ordered.push(...ungroupedBooks);
    return ordered;
}

// Tracks sorting criteria options modifications
function sortLibrary() {
  const mode = document.getElementById("sort-selector").value;
  if (mode === "alpha") {
    loadedBooksMemory.sort((a, b) => a.title.localeCompare(b.title));
  } else if (mode === "date") {
    loadedBooksMemory.sort(
      (a, b) => (b.dateImported || 0) - (a.dateImported || 0),
    );
  } else if (mode === "manual") {
    loadedBooksMemory.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }
  renderLibraryGrid();
}

function applyLibraryInterfaceSettings() {
    const size = document.getElementById("setting-card-size").value;
    const lbl = document.getElementById("lbl-card-size");
    if (lbl) lbl.innerText = size;
    document.documentElement.style.setProperty('--card-dimension-width', `${size}px`);

    const groupOrderedSorting = !!document.getElementById("setting-group-ordered-sorting")?.checked;
    saveUserConfig({ cardSize: size, groupOrderedSorting });

    // Re-render whichever view is currently on screen, since neither the library grid nor
    // the stats table re-reads this setting on their own - without this, toggling it would
    // only take visible effect after switching views away and back.
    const statsPanel = document.getElementById("stats-view");
    if (statsPanel && statsPanel.style.display !== "none") {
        if (typeof showStatsViewState === "function") showStatsViewState();
    } else {
        renderLibraryGrid();
    }
}