// =================================================================
// GROUPS
// =================================================================
/**
 Deletes a group after user confirmation, unassigning any books that were in it back to
 the global "no group" view rather than deleting the books themselves.

 @param {number} groupId - id of the group to delete.
*/
function deleteGroup(groupId) {
  if (!confirm("Are you sure you want to delete this group? (Books inside will return to Global Library view)",)) return;
  
  const transaction = db.transaction([STORE_BOOKS, STORE_GROUPS], "readwrite");
  const booksStore = transaction.objectStore(STORE_BOOKS);
  const groupsStore = transaction.objectStore(STORE_GROUPS);

  groupsStore.delete(groupId);

  let unassignedBooks = [];
  booksStore.getAll().onsuccess = (e) => {
    const records = e.target.result;
    records.forEach((book) => {
      if (book.groupId === groupId) {
        book.groupId = null;
        book.lastModified = new Date().getTime();
        booksStore.put(book);
        unassignedBooks.push(book);
      }
    });
  };
  transaction.oncomplete = () => {
    fetchLocalLibrary();
    if (typeof deleteGroupFromCloud === "function") {
      deleteGroupFromCloud(groupId);
      unassignedBooks.forEach((book) => pushBookMetadataToCloud(book));
    }
  };
}

/**
 Filters the library view down to a single group, tinting the UI with the group's color
 and swapping the view-mode toggle for a back button.

 @param {number} groupId - id of the group to filter into.
 @param {string} groupName - Display name shown in the current-group indicator.
 @param {string|null} [colorVal=null] - Group's tint color; when omitted, the tint CSS
   variables are left unset so the library falls back to its default styling.
*/
function enterGroupView(groupId, groupName, colorVal = null) {
  activeGroupFilterId = groupId;
  activeGroupFilterColor = colorVal;
  if (colorVal) {
    document.getElementById("library-view").style.setProperty("--group-view-tint", `color-mix(in srgb, ${colorVal} 12%, var(--bg-main))`);
  } else {
    document.getElementById("library-view").style.removeProperty("--group-view-tint");
  }
  document.getElementById("current-group-indicator").innerText = `📂 [Group: ${groupName}]`;
  document.getElementById("current-group-indicator").style.display = "inline";
  document.getElementById("current-group-indicator").style.setProperty("--group-tint", colorVal || "");
  document.getElementById("btn-back-group").style.display = "inline-block";
  document.getElementById("library-view-mode").style.display = "none"; // Hide view toggle while inside a group
  renderLibraryGrid(); // Book-card tinting is applied in buildBookCardsInLayout, reading activeGroupFilterColor
}

function exitGroupView() {
  activeGroupFilterId = null;
  activeGroupFilterColor = null;
  document.getElementById("library-view").style.removeProperty("--group-view-tint");
  document.getElementById("current-group-indicator").style.display = "none";
  document.getElementById("current-group-indicator").style.removeProperty("--group-tint");
  document.getElementById("btn-back-group").style.display = "none";
  document.getElementById("library-view-mode").style.display = "inline-block"; // Restore the view mode selector
  renderLibraryGrid();
}

/**
 Moves the current book selection into the target group on a drag-drop.
 @param {number|null} groupId - id of the destination group, or null to unassign the
   selected books back to the global library.
*/
function moveSelectedBooksToGroup(groupId) {
  if (selectedBookIds.length === 0) return;
  const transaction = db.transaction([STORE_BOOKS], "readwrite");
  const store = transaction.objectStore(STORE_BOOKS);

  const movedBooks = [];
  selectedBookIds.forEach((bookId) => {
    const book = loadedBooksMemory.find((b) => b.id === bookId);
    if (book) {
      book.groupId = groupId;
      book.lastModified = new Date().getTime();
      store.put(book);
      movedBooks.push(book);
    }
  });
  transaction.oncomplete = () => {
    fetchLocalLibrary();
    if (typeof pushBookMetadataToCloud === "function") {
      movedBooks.forEach((book) => pushBookMetadataToCloud(book));
    }
  };
}

// =================================================================
// GROUP MODAL
// =================================================================
/**
 Opens the group create/edit modal, prefilled for editing an existing group or defaulted
 for creating a new one.

 Placement is shown to the user as 1-indexed (1 = first), matching how the book drag-drop
 reorder reads on screen, but stored internally as 0-indexed sortOrder, same convention books already use.
 Editing an existing group shows its current 1-indexed position;
 creating a new one defaults to "last" (loadedGroupsMemory.length + 1),
 matching how new books default to sortOrder = loadedBooksMemory.length.

 @param {boolean} [isEditMode=false] - True to prefill the modal for editing groupId,
   false to open it for creating a new group.
 @param {number|null} [groupId=null] - id of the group being edited; ignored when
   isEditMode is false.
 @param {string} [name=''] - Initial value for the group name field.
 @param {string} [color=Config.Miscellaneous.DEFAULT_GROUP_COLOR] - Initial value for the
   group color field.
*/
function openGroupModal(isEditMode = false, groupId = null, name = '', color = Config.Miscellaneous.DEFAULT_GROUP_COLOR) {
    const modal = document.getElementById("group-config-modal");
    document.getElementById("modal-title-text").innerText = isEditMode ? "Modify Group Settings" : "Create New Reading Group";
    document.getElementById("modal-group-id").value = isEditMode ? groupId : "";
    document.getElementById("modal-group-name").value = name;
    document.getElementById("modal-group-color").value = color;

    let placementDisplayValue;
    if (isEditMode) {
        const sortedGroups = getGroupsSortedByPlacement();
        const currentIdx = sortedGroups.findIndex((g) => g.id === groupId);
        placementDisplayValue = currentIdx !== -1 ? currentIdx + 1 : loadedGroupsMemory.length + 1;
    } else {
        placementDisplayValue = loadedGroupsMemory.length + 1;
    }
    document.getElementById("modal-group-placement").value = placementDisplayValue;
    document.getElementById("modal-group-placement").max = isEditMode ? loadedGroupsMemory.length : loadedGroupsMemory.length + 1;

    modal.showModal(); // Opens the native <dialog> with its built-in backdrop and focus trap
}

function closeGroupModal() {
    document.getElementById("group-config-modal").close();
}

/**
 Groups sorted by their current sortOrder, falling back to array position for any
 not-yet-migrated group missing that field entirely (see migrateMissingGroupSortOrder
 in 02-db.js, which backfills this in the background - this fallback only covers the
 brief window before that migration runs).

 @returns {Array<Object>} New array of groups sorted by placement; does not mutate
   loadedGroupsMemory.
*/
function getGroupsSortedByPlacement() {
    return [...loadedGroupsMemory].sort((a, b) => {
        const aOrder = a.sortOrder ?? Infinity;
        const bOrder = b.sortOrder ?? Infinity;
        return aOrder - bOrder;
    });
}

/**
 Shared re-densify step for both manual placement-number edits and drag-and-drop reorders:
 given the groups already in their intended order (movingGroupId spliced to wherever it
 belongs), writes sortOrder = 0, 1, 2, ... across all of them and persists the change.

 Reassigning every group's sortOrder (not just the moved one) is what makes "changing group
 4 into group 2" also shift the old 2 into 3 and 3 into 4, instead of creating a duplicate
 or a gap - the same approach 05-drag-drop.js uses for books.

 @param {Array<Object>} orderedGroups - Groups in their final intended order; each is
   written back with sortOrder set to its index in this array.
*/
function persistGroupOrder(orderedGroups) {
    const transaction = db.transaction([STORE_GROUPS], "readwrite");
    const store = transaction.objectStore(STORE_GROUPS);
    orderedGroups.forEach((group, idx) => {
        group.sortOrder = idx;
        group.lastModified = new Date().getTime();
        store.put(group);
    });
    transaction.oncomplete = () => {
        loadedGroupsMemory = orderedGroups;
        renderLibraryGrid();
        if (typeof pushGroupToCloud === "function") {
            orderedGroups.forEach((group) => pushGroupToCloud(group));
        }
    };
}

function submitGroupModalForm() {
    const idVal = document.getElementById("modal-group-id").value;
    const nameVal = document.getElementById("modal-group-name").value.trim();
    const colorVal = document.getElementById("modal-group-color").value;
    // User-facing placement is 1-indexed; -1 converts it to the 0-indexed sortOrder convention
    // used internally, matching books.
    const placementVal = parseInt(document.getElementById("modal-group-placement").value, 10) - 1;

    if (!nameVal) {
        alert("Please enter a valid group title.");
        return;
    }

    if (idVal) {
        // Edit existing group
        const transaction = db.transaction([STORE_GROUPS], "readwrite");
        const store = transaction.objectStore(STORE_GROUPS);
        let updatedRecord = null;
        store.get(parseInt(idVal)).onsuccess = (e) => {
            const record = e.target.result;
            if (record) {
                record.name = nameVal;
                record.backgroundColor = colorVal;
                /*
                Stamped during the actual local edit rather than only after a successful cloud
                push. stampLocalGroupLastModified() remains as a fallback for other push paths, such as Hard Push or Soft Sync.
                Without this local timestamp, offline edits or in-flight pushes would leave pullInitialSyncFromCloud()
                without a reliable value for conflict checks until the push succeeds.
                */
                record.lastModified = new Date().getTime();
                store.put(record);
                updatedRecord = record;
            }
        };
        transaction.oncomplete = () => {
            closeGroupModal();
            if (updatedRecord) {
                // Only reorder if the placement actually changed - avoids an unnecessary second
                // write pass when the user left it at its current position.
                const sortedGroups = getGroupsSortedByPlacement();
                const currentIdx = sortedGroups.findIndex((g) => g.id === updatedRecord.id);
                if (currentIdx !== -1 && currentIdx !== placementVal) {
                    const withoutMoved = sortedGroups.filter((g) => g.id !== updatedRecord.id);
                    const clampedIdx = Math.max(0, Math.min(placementVal, withoutMoved.length));
                    withoutMoved.splice(clampedIdx, 0, updatedRecord);
                    persistGroupOrder(withoutMoved);
                } else {
                    fetchLocalLibrary();
                }
            } else {
                fetchLocalLibrary();
            }
            if (updatedRecord && typeof pushGroupToCloud === "function") {
                pushGroupToCloud(updatedRecord);
            }
        };
    } else {
        // Create new group
        const transaction = db.transaction([STORE_GROUPS], "readwrite");
        const store = transaction.objectStore(STORE_GROUPS);
        let newGroupId = null;
        // Stamped at creation time for the same reason as the edit branch above -
        // see that comment for the full rationale.
        const createdAt = new Date().getTime();
        store.add({ name: nameVal, backgroundColor: colorVal, lastModified: createdAt }).onsuccess = (e) => {
            newGroupId = e.target.result;
        };
        transaction.oncomplete = () => {
            closeGroupModal();
            const newGroup = { id: newGroupId, name: nameVal, backgroundColor: colorVal, lastModified: createdAt };
            // newGroup isn't in loadedGroupsMemory yet (it was just created via store.add, not through a fetch),
            // so it's inserted directly into the existing sorted list rather than filtered out of one it was never part of.
            const existingSorted = getGroupsSortedByPlacement();
            const clampedIdx = Math.max(0, Math.min(placementVal, existingSorted.length));
            existingSorted.splice(clampedIdx, 0, newGroup);
            persistGroupOrder(existingSorted);
            if (typeof pushGroupToCloud === "function") {
                pushGroupToCloud(newGroup);
            }
        };
    }
}

// =================================================================
// GROUP DRAG-AND-DROP REORDERING
// Mirrors 05-drag-drop.js's book reordering, but only ever moves a single group at a time
// (unlike books, groups have no multi-select), and uses a distinct dataTransfer marker
// ("grouped-groups" vs books' "grouped-cards") so a group card's existing drop handler
// (moving books INTO a group) and this new reorder-drop handler don't misfire on each other's drags.
// =================================================================
let draggedGroupId = null;

/**
 Drag-start handler for a group card. Records which group is being dragged and marks the
 dataTransfer payload as "grouped-groups" so drop handlers can distinguish this from a
 book-card drag ("grouped-cards", see 05-drag-drop.js).

 @param {DragEvent} e - The originating dragstart event.
 @param {number} groupId - id of the group card being dragged.
*/
function handleGroupDragStart(e, groupId) {
    draggedGroupId = groupId;
    e.dataTransfer.setData("text/plain", "grouped-groups");
    e.currentTarget.classList.add("dragging");
}

/**
 Drag-end handler for a group card. Clears dragging state regardless of whether the drop
 succeeded, so a cancelled drag doesn't leave the card visually stuck mid-drag.

 @param {DragEvent} e - The originating dragend event.
*/
function handleGroupDragEnd(e) {
    e.currentTarget.classList.remove("dragging");
    draggedGroupId = null;
}

/**
 Drop handler for reordering group cards via drag-and-drop.

 Book cards dropped onto a group card are handled by the existing "drop" listener in
 04-library-view.js's group-card setup (moveSelectedBooksToGroup); this only runs the
 reorder when a group card itself was what got dragged.

 @param {DragEvent} e - The originating drop event.
 @param {number} targetGroupId - id of the group card the drag was dropped onto.
*/
function handleGroupDrop(e, targetGroupId) {
    // Book cards dropped onto a group card are handled by the existing "drop" listener in
    // 04-library-view.js's group-card setup (moveSelectedBooksToGroup); this only runs the
    // reorder when a group card itself was what got dragged.
    if (draggedGroupId === null || draggedGroupId === targetGroupId) return;
    e.preventDefault();
    e.stopPropagation();

    const sortedGroups = getGroupsSortedByPlacement();
    const movingGroup = sortedGroups.find((g) => g.id === draggedGroupId);
    if (!movingGroup) return;

    const withoutMoved = sortedGroups.filter((g) => g.id !== draggedGroupId);
    const targetIdx = withoutMoved.findIndex((g) => g.id === targetGroupId);
    const insertIdx = targetIdx === -1 ? withoutMoved.length : targetIdx;
    withoutMoved.splice(insertIdx, 0, movingGroup);
    persistGroupOrder(withoutMoved);
}