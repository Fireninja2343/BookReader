// =================================================================
// LIBRARY GRID RENDERING
// =================================================================
function renderLibraryGrid() {
  const container = document.getElementById("grid-container");
  container.innerHTML = "";
  selectedBookIds = [];
  lastSelectedBookId = null;

  // Grouped view, showing group folders + unassigned books
  if (globalLibraryViewMode === "grouped" && activeGroupFilterId === null) {
    // Ordered by sortOrder so drag-and-drop/placement-number reordering (03-groups.js)
    // is reflected on screen instead of groups appearing in raw fetch order.
    const sortedGroups = getGroupsSortedByPlacement();
    sortedGroups.forEach((group) => {
      const card = document.createElement("div");
      card.className = "group-card";
      card.style.setProperty("--card-color", group.backgroundColor);
      card.setAttribute("draggable", "true");

      card.addEventListener("dragstart", (e) => handleGroupDragStart(e, group.id));
      card.addEventListener("dragend", handleGroupDragEnd);
      // Drop is always enabled here: book drags (move INTO this group) and group-reorder drags both need it.
      card.addEventListener("dragover", (e) => e.preventDefault());
      card.addEventListener("drop", (e) => {
        /*
        A book card dropped here (moves the book into this group) and a group card
        dropped here (reorders groups) both land on this same drop event, distinguished
        by the dataTransfer marker each drag type sets - see 05-drag-drop.js's
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

    // Standalone books with no group
    const unassignedBooks = loadedBooksMemory.filter((b) => !b.groupId);
    buildBookCardsInLayout(unassignedBooks, container);

    // Inside a single group's folder
  } else if (globalLibraryViewMode === "grouped" && activeGroupFilterId !== null) {
    const groupBooks = loadedBooksMemory.filter((b) => b.groupId === activeGroupFilterId);
    buildBookCardsInLayout(groupBooks, container);

    // Flat "All Books" view, ignoring groups
  } else if (globalLibraryViewMode === "all") {
    buildBookCardsInLayout(getBooksInDisplayOrder(), container);
    if (document.getElementById("setting-group-ordered-sorting")?.checked
        && document.getElementById("sort-selector")?.value === "manual") {
      //renderGroupBubbleOutlines(container); Remove for now
    }
  }
}

/**
 Populates a group card's DOM with a preview grid of up to 4 book covers, plus a title and
 Edit/Delete action buttons.

 @param {HTMLElement} card - The group card element to populate.
 @param {Object} group - Group record backing this card.
*/
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

/**
 Draws a rounded "bubble" outline around each group's cluster of book cards in the flat
 "All Books" view, shown only while Sort Books by Group Order is active in Manual sort
 mode (see getBooksInDisplayOrder()). Purely visual - it doesn't change card layout or
 DOM structure, just measures where each group's cards landed after the grid laid them
 out and draws a positioned outline behind them.

 A group's cards can wrap across multiple rows in arbitrary shapes
 (e.g. 3 full rows plus a half row, or an L-shape if other groups' cards interleave)
 so a single rectangular bounding box is wrong - it would cover unrelated cards. Instead this clusters the
 group's cards into rows by their rendered top position, builds one rect per row,
 then stitches the rows into a single "staircase" polygon (rows extended to meet exactly at
 the midpoint of any gap between them) and rounds every vertex of that polygon.
 This is the same technique browsers use to draw a rounded highlight behind multi-line text.

 @param {HTMLElement} container - Grid container the book cards are already rendered
   into; outlines are measured against its bounding rect and inserted as its first child.
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

  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("group-bubble-outline");
  svg.setAttribute("width", containerRect.width);
  svg.setAttribute("height", containerRect.height);
  svg.setAttribute("viewBox", `0 0 ${containerRect.width} ${containerRect.height}`);

  const padding = 10;
  const cornerRadius = 24;

  getGroupsSortedByPlacement().forEach((group) => {
    const groupBookIds = loadedBooksMemory
      .filter((b) => b.groupId === group.id)
      .map((b) => b.id);
    if (groupBookIds.length === 0) return;

    const cardRects = groupBookIds
      .map((bookId) => container.querySelector(`.book-card[data-book-id='${bookId}']`))
      .filter(Boolean)
      .map((card) => {
        const r = card.getBoundingClientRect();
        return {
          left: r.left - containerRect.left,
          right: r.right - containerRect.left,
          top: r.top - containerRect.top,
          bottom: r.bottom - containerRect.top,
        };
      });
    if (cardRects.length === 0) return; // None of this group's cards actually rendered

    const rows = clusterCardsIntoRows(cardRects, padding);
    const pathData = buildRowStaircasePath(rows, cornerRadius);
    if (!pathData) return;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", `color-mix(in srgb, ${group.backgroundColor} 8%, transparent)`);
    path.setAttribute("stroke", group.backgroundColor);
    path.setAttribute("stroke-width", "2");
    svg.appendChild(path);
  });

  // Inserted as the FIRST child (not appended) so plain DOM paint order puts it behind
  // every book card, without relying on z-index/stacking-context tricks that can fail
  // depending on the container's own stacking context.
  container.insertBefore(svg, container.firstChild);
}

/**
 Groups a flat list of card rects into visual rows (cards whose tops are close together),
 then pads each row and stretches adjacent rows to meet exactly at the midpoint of any
 gap between them, so the rows form one seamless vertical stack with no visual gaps.

 @param {Array<{left: number, right: number, top: number, bottom: number}>} cardRects -
   Card bounding rects, relative to the outline container.
 @param {number} padding - Pixels to expand each row's rect by on every side before rows
   are stretched to meet.
 @returns {Array<{left: number, right: number, top: number, bottom: number}>} Row rects,
   sorted top to bottom, with no vertical gaps between consecutive rows.
*/
function clusterCardsIntoRows(cardRects, padding) {
  const ROW_TOLERANCE_PX = 10; // cards in the same visual row should have nearly-identical tops
  const sorted = [...cardRects].sort((a, b) => a.top - b.top);
  const rows = [];
  sorted.forEach((r) => {
    let row = rows.find((row) => Math.abs(row.top - r.top) < ROW_TOLERANCE_PX);
    if (!row) {
      row = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      rows.push(row);
    } else {
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
      row.left = Math.min(row.left, r.left);
      row.right = Math.max(row.right, r.right);
    }
  });
  rows.sort((a, b) => a.top - b.top);

  rows.forEach((row) => {
    row.left -= padding;
    row.right += padding;
    row.top -= padding;
    row.bottom += padding;
  });
  for (let i = 0; i < rows.length - 1; i++) {
    const boundary = (rows[i].bottom + rows[i + 1].top) / 2;
    rows[i].bottom = boundary;
    rows[i + 1].top = boundary;
  }
  return rows;
}

/**
 Builds an SVG path tracing the outline of a vertically-stacked set of row rects (each
 row possibly a different width), producing a "staircase" polygon rather than a single
 bounding rectangle, with every corner (convex or concave) rounded.

 @param {Array<{left: number, right: number, top: number, bottom: number}>} rows - Row
   rects from clusterCardsIntoRows(), sorted top to bottom.
 @param {number} radius - Corner rounding radius passed through to roundedPolygonPath().
 @returns {string} SVG path `d` attribute value, or an empty string if rows is empty.
*/
function buildRowStaircasePath(rows, radius) {
  if (rows.length === 0) return "";

  const rightPts = [];
  rows.forEach((row) => {
    rightPts.push({ x: row.right, y: row.top });
    rightPts.push({ x: row.right, y: row.bottom });
  });
  const leftPts = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    leftPts.push({ x: row.left, y: row.bottom });
    leftPts.push({ x: row.left, y: row.top });
  }

  return roundedPolygonPath([...rightPts, ...leftPts], radius);
}

/**
 Generic rounded-corner polygon path builder: given an ordered, closed list of vertices,
 cuts each corner in by min(radius, half the shorter adjacent edge) and rounds it with a
 quadratic curve through the original vertex. Works uniformly for convex and concave
 corners, which is what lets the staircase shape above look like one soft continuous
 bubble instead of a jagged outline.

 @param {Array<{x: number, y: number}>} points - Ordered, closed polygon vertices
   (consecutive duplicates are deduped internally).
 @param {number} radius - Maximum corner rounding radius; shrunk per-corner when an
   adjacent edge is too short to support it.
 @returns {string} SVG path `d` attribute value, or an empty string if fewer than 3
   distinct vertices remain after deduping.
*/
function roundedPolygonPath(points, radius) {
  const deduped = points.filter((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length];
    return !(p.x === prev.x && p.y === prev.y);
  });
  const n = deduped.length;
  if (n < 3) return "";

  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n];
    const curr = deduped[i];
    const next = deduped[(i + 1) % n];

    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y };
    const toNext = { x: next.x - curr.x, y: next.y - curr.y };
    const lenPrev = Math.hypot(toPrev.x, toPrev.y);
    const lenNext = Math.hypot(toNext.x, toNext.y);
    const r = Math.min(radius, lenPrev / 2, lenNext / 2);

    const startPt = { x: curr.x + (toPrev.x / lenPrev) * r, y: curr.y + (toPrev.y / lenPrev) * r };
    const endPt = { x: curr.x + (toNext.x / lenNext) * r, y: curr.y + (toNext.y / lenNext) * r };

    d += (i === 0 ? `M ${startPt.x} ${startPt.y} ` : `L ${startPt.x} ${startPt.y} `);
    d += `Q ${curr.x} ${curr.y} ${endPt.x} ${endPt.y} `;
  }
  return d + "Z";
}

/**
 Packs book cards into the grid DOM for the given list of books.

 @param {Array<Object>} booksScopingContextArray - Books to render, in display order;
   also passed through to click handling so multi-select ranges (shift-click) are scoped
   to this same list rather than the full library.
 @param {HTMLElement} targetDOMContainer - Container to append the generated card
   elements to.
*/
function buildBookCardsInLayout(booksScopingContextArray, targetDOMContainer) {
  booksScopingContextArray.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-card";
    card.setAttribute("draggable", "true");
    card.dataset.bookId = book.id;

    // Tint book cards while browsing inside a group folder
    if (activeGroupFilterId !== null && activeGroupFilterColor) {
      card.style.setProperty(
        "--group-tint",
        `color-mix(in srgb, ${activeGroupFilterColor} 75%, var(--bg-card))`,
      );
    } else if (globalLibraryViewMode === "all" && book.groupId) {
      // Flat "All Books" view has no single active group to borrow a color from
      // (books from every group are mixed together), so look up each card's own
      // group color individually.
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

/**
 Stamps a book as opened just now, persists it, then launches the reader.

 @param {Object} book - Book record to open; mutated in place with a fresh lastOpenedDate.
*/
function openBookAndTrackLastRead(book) {
  book.lastOpenedDate = Date.now();

  if (db) {
    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    transaction.objectStore(STORE_BOOKS).put(book);
  }

  launchEpubReader(book);
}

/**
 Opens the currently selected book from grid selection, separate from the
 double-click shortcut. Used by #btn-open-book, which appears only when
 exactly one book is selected (see handleGridCardClick).
*/
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

/**
 Click handler for a .book-card element, covering single-select, shift-click range select,
 and the double-click open shortcut.

 @param {MouseEvent} event - The originating click event; event.detail distinguishes
   single vs double clicks, and event.shiftKey triggers range selection.
 @param {number} bookId - id of the book card that was clicked.
 @param {Array<Object>} scopingArrayContext - The book list currently on screen (e.g. a
   single group's books, or the full library), used both to resolve bookId to a record and
   to scope shift-click range selection to only the cards actually visible.
*/
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

/**
 Books in the order the library/stats views should display, accounting for the "Sort
 Books by Group Order" setting (see applyLibraryInterfaceSettings()).

 Alphabetical/Date Imported sort modes always override group ordering, since those are
 explicit whole-library sorts the user picked - group order only applies in Manual mode,
 and only when the setting is on. When both hold, books are listed group-by-group
 (following each group's own sortOrder), each group's books in their own manual order,
 with ungrouped books appended last in their own manual order.

 @returns {Array<Object>} Books in display order. Returns loadedBooksMemory itself (not a
   copy) whenever grouping isn't applied, since callers only read from the result.
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
    renderLibraryGrid();
}