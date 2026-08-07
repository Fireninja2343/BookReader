// =================================================================
// DRAG-AND-DROP BOOK REORDERING
// =================================================================
let draggedIndicesGroup = [];

/**
 Drag-start handler for a .book-card element. Must be wired as `ondragstart` so `this`
 refers to the dragged card. Stashes the selected card ids in draggedIndicesGroup for
 handleCardDrop() to read on drop.
 */
function handleCardDragStart(e) {
  const currentBookId = Number(this.dataset.bookId);

  if (!selectedBookIds.includes(currentBookId)) {
    selectedBookIds = [currentBookId];

    document.querySelectorAll(".book-card").forEach((c) => {
      c.classList.toggle(
        "selected",
        Number(c.dataset.bookId) === currentBookId
      );
    });
  }

  draggedIndicesGroup = [...selectedBookIds];

  draggedIndicesGroup.forEach((id) => {
    const card = document.querySelector(
      `.book-card[data-book-id='${id}']`
    );
    if (card) card.classList.add("dragging");
  });

  e.dataTransfer.setData("text/plain", "grouped-cards");
}

function handleCardDragEnd() {
  document
    .querySelectorAll(".book-card")
    .forEach((c) => c.classList.remove("dragging"));
}

function handleCardDragOver(e) {
  e.preventDefault();
}

function allowGridDrop(e) {
  e.preventDefault();
}

/**
 Drop handler for a .book-card element - must be wired as `ondrop` so `this` refers to
 the drop-target card. Moves the cards in draggedIndicesGroup next to the target.
 If "Sort Books by Group Order" is on with manual sort active, dropping onto another
 group's card confirms and reassigns groupId; otherwise this only reorders sortOrder.
 */
function handleCardDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const targetBookId = Number(this.dataset.bookId);

  if (draggedIndicesGroup.includes(targetBookId)) return;

  const itemsMoving = draggedIndicesGroup
    .map(id => loadedBooksMemory.find(b => b.id === id))
    .filter(Boolean);

  const targetBook = loadedBooksMemory.find(b => b.id === targetBookId);
  if (!targetBook) return;

  // Cross-group drops only prompt while Sort Books by Group Order is active in Manual sort
  // mode - that's the only situation where books are visually clustered into per-group blocks
  // (see getBooksInDisplayOrder()/renderGroupBubbleOutlines() in 04-library-view.js), so it's
  // the only situation where dragging a book into a different block has an obvious, expected
  // meaning (move it into that group). With the setting off, or any other sort mode, dragging
  // in "All Books" keeps its original behavior: reorder only, never touches groupId, matching
  // how it worked before this feature existed.
  const groupOrderedSorting = !!document.getElementById("setting-group-ordered-sorting")?.checked;
  const sortMode = document.getElementById("sort-selector")?.value;
  const isCrossGroupDrop = groupOrderedSorting && sortMode === "manual"
    && itemsMoving.some((book) => book.groupId !== targetBook.groupId);

  if (isCrossGroupDrop) {
    const targetGroup = loadedGroupsMemory.find((g) => g.id === targetBook.groupId);
    const destinationLabel = targetGroup ? `the "${targetGroup.name}" group` : "no group (unassigned)";
    const bookLabel = itemsMoving.length === 1 ? `"${itemsMoving[0].title}"` : `these ${itemsMoving.length} books`;
    const confirmed = confirm(`Move ${bookLabel} into ${destinationLabel}?`);
    if (!confirmed) return; // Nothing was persisted yet, so declining just leaves everything as it was

    // Places the moved books at the end of the destination group's existing manual order,
    // rather than leaving them at whatever sortOrder they happened to have in their old
    // group (which would place them at an arbitrary, likely-wrong spot in the new one).
    const destinationGroupBooks = loadedBooksMemory.filter(
      (b) => b.groupId === targetBook.groupId && !draggedIndicesGroup.includes(b.id)
    );
    let nextSortOrder = destinationGroupBooks.length;

    const transaction = db.transaction([STORE_BOOKS], "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const movedBooks = [];
    itemsMoving.forEach((book) => {
      book.groupId = targetBook.groupId;
      book.sortOrder = nextSortOrder++;
      book.lastModified = new Date().getTime();
      store.put(book);
      movedBooks.push(book);
    });
    transaction.oncomplete = () => {
      renderLibraryGrid();
      if (typeof pushBookMetadataToCloud === "function") {
        movedBooks.forEach((book) => pushBookMetadataToCloud(book));
      }
    };
    return;
  }

  let filteredLibrary = loadedBooksMemory.filter(
    (b) => !draggedIndicesGroup.includes(b.id)
  );

  let adjustedTargetIdx = filteredLibrary.indexOf(targetBook);

  if (adjustedTargetIdx === -1) adjustedTargetIdx = filteredLibrary.length;

  filteredLibrary.splice(adjustedTargetIdx, 0, ...itemsMoving);

  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);

  // Uses filteredLibrary (the new order), not loadedBooksMemory
  filteredLibrary.forEach((book, idx) => {
    book.sortOrder = idx;
    store.put(book);
  });

  transaction.oncomplete = () => {
    loadedBooksMemory = filteredLibrary; // Keep UI in sync
    renderLibraryGrid();
  };
}