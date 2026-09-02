// =================================================================
// PER-BOOK "DELTA FROM AVERAGE" COMPARISONS
// =================================================================
/**
 Computes the mean and "≈ average" cutoff for each of the four comparable metrics.
 @param {Array<Object>} groupMetrics - perBookMetrics-shaped entries to average.
 @returns {Object} Means plus per-metric cutoffs; null for metrics with no valid entries.
*/
function computeStatAveragesForGroup(groupMetrics) {
    const timeSpentValues = groupMetrics.filter(m => m.mins > 0).map(m => m.mins);
    const pagesPerHourValues = groupMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
    const completionDurationValues = groupMetrics.filter(m => m.completionDurationMs !== null).map(m => m.completionDurationMs);
    const pagesPerDayValues = groupMetrics.filter(m => m.pagesPerDay !== null).map(m => m.pagesPerDay);

    const mean = (arr) => arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;

    return {
        timeSpentMins: mean(timeSpentValues),
        pagesPerHour: mean(pagesPerHourValues),
        completionDurationMs: mean(completionDurationValues),
        pagesPerDay: mean(pagesPerDayValues),
        cutoffs: {
            timeSpentMins: computeApproxAverageCutoffPercent(timeSpentValues),
            pagesPerHour: computeApproxAverageCutoffPercent(pagesPerHourValues),
            completionDurationMs: computeApproxAverageCutoffPercent(completionDurationValues),
            pagesPerDay: computeApproxAverageCutoffPercent(pagesPerDayValues),
        },
    };
}
// Statuses compared as their own "delta from average" group; Not Started is excluded.
const DELTA_COMPARISON_STATUSES = [
    Config.Miscellaneous.READING_STATUS.COMPLETED,
    Config.Miscellaneous.READING_STATUS.IN_PROGRESS,
    Config.Miscellaneous.READING_STATUS.PAUSED,
];
// Key statAveragesByStatus stores the combined all-statuses average under - used as the
// baseline for a collapsed group whose books don't all share one status.
const ALL_STATUSES_AVERAGE_KEY = "all";
/**
 Computes averages/cutoffs per status in DELTA_COMPARISON_STATUSES, plus one combined
 average across all comparison-eligible statuses (ALL_STATUSES_AVERAGE_KEY).
 @param {Array<Object>} perBookMetrics - All books' metric entries to split by status.
 @returns {Object} Result keyed by status plus result[ALL_STATUSES_AVERAGE_KEY].
*/
function computeStatAveragesByStatus(perBookMetrics) {
    const result = {};
    for (const status of DELTA_COMPARISON_STATUSES) {
        const groupMetrics = perBookMetrics.filter(m => m.status === status);
        result[status] = computeStatAveragesForGroup(groupMetrics);
    }
    const allComparableMetrics = perBookMetrics.filter(m => DELTA_COMPARISON_STATUSES.includes(m.status));
    result[ALL_STATUSES_AVERAGE_KEY] = computeStatAveragesForGroup(allComparableMetrics);
    return result;
}

const APPROX_AVERAGE_CUTOFF_MIN_PERCENT = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_MIN_PERCENT;
const APPROX_AVERAGE_CUTOFF_MAX_PERCENT = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_MAX_PERCENT;
const APPROX_AVERAGE_CUTOFF_SCALE = Config.Miscellaneous.APPROX_AVERAGE_CUTOFF_SCALE; // scales CV-per-sample into a percent
/**
 Computes a dynamic "≈ average" cutoff from coefficient of variation, instead of a fixed
 percentage - shrinks for small/tightly-clustered samples so small differences stay visible.
 @param {number[]} values - Sample values.
 @returns {number} Cutoff percent, clamped to [MIN, MAX].
*/
function computeApproxAverageCutoffPercent(values) {
    if (values.length < 2) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT; // can't measure spread

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (!mean) return APPROX_AVERAGE_CUTOFF_MIN_PERCENT;

    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / Math.abs(mean); // relative spread

    // Divide by sample count so smaller datasets use a stricter cutoff.
    const cvPerSample = coefficientOfVariation / values.length;

    const cutoff = cvPerSample * 100 * APPROX_AVERAGE_CUTOFF_SCALE;
    return Math.max(APPROX_AVERAGE_CUTOFF_MIN_PERCENT, Math.min(APPROX_AVERAGE_CUTOFF_MAX_PERCENT, cutoff));
}

/**
 Builds the "↑/↓ X than average (+Y%)" line beneath a stat, or "" if no valid comparison.
 @param {number|null} value - This book's value for the metric.
 @param {number|null} average - Comparison-group average.
 @param {function(number): string} formatFn - Formats the absolute difference.
 @param {string} higherLabel - Label when above average.
 @param {string} lowerLabel - Label when below average.
 @param {boolean} higherIsBetter - Which direction counts as an improvement.
 @param {number} [approxCutoffPercent=5] - Below this percent, treated as "≈ average".
 @returns {string} HTML for the delta row, or "".
*/
function buildStatDeltaHtml(value, average, formatFn, higherLabel, lowerLabel, higherIsBetter, approxCutoffPercent) {
    if (value === null || value === undefined || average === null || average === undefined || average === 0) {
        return "";
    }

    const absoluteDiff = value - average;
    const percentDiff = (absoluteDiff / average) * 100;
    const absPercent = Math.abs(percentDiff);

    const cutoff = typeof approxCutoffPercent === "number" ? approxCutoffPercent : 5;
    if (absPercent < cutoff) {
        return `<div class="stat-delta-row stat-delta-neutral">≈ average</div>`;
    }

    const isAboveAverage = absoluteDiff > 0;
    const isGood = isAboveAverage === higherIsBetter;
    const arrow = isAboveAverage ? "↑" : "↓";
    const directionLabel = isAboveAverage ? higherLabel : lowerLabel;
    const formattedAbsDiff = formatFn(Math.round(Math.abs(absoluteDiff)*10)/10);
    const sign = isAboveAverage ? "+" : "-";

    // Saturation scales continuously with |percentDiff| so magnitude stays visually
    // obvious; alpha clamped to keep text legible against every theme.
    const alpha = Math.min(0.95, 0.35 + (absPercent / 100) * 0.6);
    const colorVar = isGood ? "--stat-good-rgb" : "--stat-bad-rgb";
    const color = `rgba(var(${colorVar}), ${alpha.toFixed(2)})`;

    // Very large deltas get a slightly bigger, glowing percentage figure so
    // an extreme outlier catches the eye without needing another color.
    const VERY_HIGH_THRESHOLD_PERCENT = Config.Miscellaneous.VERY_HIGH_THRESHOLD_PERCENT;
    const emphasisClass = absPercent >= VERY_HIGH_THRESHOLD_PERCENT ? "stat-delta-emphasis" : "";

    return `
        <div class="stat-delta-row" style="color:${color};">
            ${arrow} ${escapeHtml(formattedAbsDiff)} ${escapeHtml(directionLabel)}
            (<span class="${emphasisClass}">${sign}${absPercent.toFixed(1)}%</span>)
        </div>
    `;
}

// Single source of truth for the four comparable per-book metrics. Formatters use arrow
// wrappers (e.g. `(v) => formatMinutes(v)`) so the lookup defers until formatting runs.
const FOUR_METRIC_DEFINITIONS = [
    {
        key: "timeSpent",
        label: "Time Spent",
        averageKey: "timeSpentMins",
        cutoffKey: "timeSpentMins",
        getValue: (m) => (m.mins > 0 ? m.mins : null),
        format: (v) => formatMinutes(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerHour",
        label: "Pages per Hour",
        averageKey: "pagesPerHour",
        cutoffKey: "pagesPerHour",
        getValue: (m) => m.pagesPerHour,
        format: (v) => `${v.toFixed(1)} p/h`,
        higherIsBetter: true,
    },
    {
        key: "completionDuration",
        label: "Completion Duration",
        averageKey: "completionDurationMs",
        cutoffKey: "completionDurationMs",
        getValue: (m) => m.completionDurationMs,
        format: (v) => formatCompletionDuration(v),
        higherIsBetter: false,
    },
    {
        key: "pagesPerDay",
        label: "Pages per Day",
        averageKey: "pagesPerDay",
        cutoffKey: "pagesPerDay",
        getValue: (m) => m.pagesPerDay,
        format: (v) => `${v.toFixed(1)} pages/day`,
        higherIsBetter: true,
    },
];

/**
 Computes the four "delta from average" HTML snippets for a metric entry, comparing
 against its own status group in statAveragesByStatus. Shared by buildStatsRowHtml and
 renderReadingSpeedProgression().
 @param {Object} m - A perBookMetrics-shaped entry.
 @param {Object} statAveragesByStatus - Averages/cutoffs keyed by status.
 @returns {Object} Delta HTML strings keyed by metric (timeSpent, pagesPerHour,
   completionDuration, pagesPerDay).
*/
function buildFourMetricDeltas(m, statAveragesByStatus) {
    const groupAverages = statAveragesByStatus[m.status];
    const result = {};
    for (const def of FOUR_METRIC_DEFINITIONS) {
        result[def.key] = groupAverages
            ? buildStatDeltaHtml(
                def.getValue(m), groupAverages[def.averageKey],
                def.format, "", "", def.higherIsBetter, groupAverages.cutoffs[def.cutoffKey],
            )
            : "";
    }
    return result;
}

function getGroupTintStyle(book) {
    if (!book.groupId) return "";
    const ownGroup = loadedGroupsMemory.find((g) => g.id === book.groupId);
    if (!ownGroup || !ownGroup.backgroundColor) return "";
    const tint = `color-mix(in srgb, ${ownGroup.backgroundColor} 50%, var(--bg-card))`;
    return `--group-tint:${tint}; background-color:var(--group-tint);`;
}

function getGroupSummaryTintStyle(group) {
    if (!group || !group.backgroundColor) return "";
    const tint = `color-mix(in srgb, ${group.backgroundColor} 75%, var(--bg-card))`;
    return `--group-tint-strong:${tint}; background-color:var(--group-tint-strong);`;
}

/**
 Builds one <tr> for the per-book stats table, with a delta line under each metric cell.
 @param {Object} m - perBookMetrics entry for the row.
 @param {Object} statAveragesByStatus - Averages/cutoffs keyed by status.
 @param {Object} [options={}]
 @param {boolean} [options.grouped=false] - Adds .stats-row-grouped.
 @param {boolean} [options.showCollapseArrow=false] - Shows the ▾ toggle (first row of an
   expanded group); other rows still reserve the gutter width for alignment.
 @param {number|null} [options.groupId=null] - Group id the arrow toggles.
 @param {boolean} [options.disableCollapseArrow=false] - Disables the arrow while a column
   sort is active, since collapsing mid-sort would leave a stale order.
 @returns {string} HTML for the `<tr>` row.
*/
function buildStatsRowHtml(m, statAveragesByStatus, options = {}) {
    const { grouped = false, showCollapseArrow = false, groupId = null, disableCollapseArrow = false } = options;
    const pagesPerHourDisplay = m.pagesPerHour !== null ? `${m.pagesPerHour.toFixed(1)} p/h` : "—";
    const deltas = buildFourMetricDeltas(m, statAveragesByStatus);
    const tintStyle = getGroupTintStyle(m.book);
    const rowClass = grouped ? "stats-row-grouped" : "";
    const gutterArrowHtml = showCollapseArrow
        ? disableCollapseArrow
            ? `<span class="stats-collapse-arrow stats-collapse-arrow-disabled">▾</span>`
            : `<span class="stats-collapse-arrow" onclick="event.stopPropagation(); toggleStatsGroupCollapse(${groupId});">▾</span>`
        : "";
    return `
        <tr class="${rowClass}" style="border-bottom: 1px solid var(--border); ${tintStyle}">
            <td><span class="stats-collapse-gutter">${gutterArrowHtml}</span>${escapeHtml(m.book.title)}</td>
            <td style="color:var(--accent);">${READING_STATUS_LABELS[m.status]}</td>
            <td>${m.pagesRead} / ${m.totalPages || "—"} pages</td>
            <td>${formatMinutes(m.mins)}${deltas.timeSpent}</td>
            <td>${pagesPerHourDisplay}${deltas.pagesPerHour}</td>
            <td>${formatCompletionDuration(m.completionDurationMs)}${deltas.completionDuration}</td>
            <td>${m.pagesPerDay !== null ? `${m.pagesPerDay.toFixed(1)} p/day` : "—"}${deltas.pagesPerDay}</td>
        </tr>
    `;
}

/**
 Baseline status a collapsed group compares against: that status if every book in the
 group shares one, otherwise ALL_STATUSES_AVERAGE_KEY.
 @param {Array<Object>} groupMetrics - perBookMetrics entries in one group.
 @returns {string}
*/
function resolveGroupDeltaBaselineStatus(groupMetrics) {
    const statusesInGroup = new Set(groupMetrics.map((m) => m.status));
    if (statusesInGroup.size === 1) {
        const [onlyStatus] = statusesInGroup;
        if (DELTA_COMPARISON_STATUSES.includes(onlyStatus)) return onlyStatus;
    }
    return ALL_STATUSES_AVERAGE_KEY;
}

/**
 Builds the summary <tr> for a collapsed group: name, a completed/in-progress/paused
 counts line, and the group's own averages/deltas.
 @param {number} groupId
 @param {Array<Object>} groupMetrics - perBookMetrics entries in this group.
 @param {Object} statAveragesByStatus - Delta comparison baseline.
 @returns {string} HTML for the summary `<tr>`.
*/
function buildGroupSummaryRowHtml(groupId, groupMetrics, statAveragesByStatus) {
    const group = loadedGroupsMemory.find((g) => g.id === groupId);
    const groupName = group ? group.name : "Unknown Group";
    const tintStyle = getGroupSummaryTintStyle(group);

    let completedCount = 0, inProgressCount = 0, pausedCount = 0;
    groupMetrics.forEach((m) => {
        if (m.status === READING_STATUS.COMPLETED) completedCount++;
        else if (m.status === READING_STATUS.IN_PROGRESS) inProgressCount++;
        else if (m.status === READING_STATUS.PAUSED) pausedCount++;
    });
    const bookCountLabel = `${groupMetrics.length} book${groupMetrics.length === 1 ? "" : "s"}`;
    const countsLine = `${bookCountLabel}, ${completedCount} completed / ${inProgressCount} in progress / ${pausedCount} paused`;

    const gutterArrowHtml = `<span class="stats-collapse-arrow" onclick="event.stopPropagation(); toggleStatsGroupCollapse(${groupId});">▸</span>`;

    const groupOwnAverages = computeStatAveragesForGroup(groupMetrics);
    const groupAsMetric = {
        status: resolveGroupDeltaBaselineStatus(groupMetrics),
        mins: groupOwnAverages.timeSpentMins,
        pagesPerHour: groupOwnAverages.pagesPerHour,
        completionDurationMs: groupOwnAverages.completionDurationMs,
        pagesPerDay: groupOwnAverages.pagesPerDay,
    };
    const deltas = buildFourMetricDeltas(groupAsMetric, statAveragesByStatus);
    const metricCellsHtml = FOUR_METRIC_DEFINITIONS.map((def) => {
        const value = def.getValue(groupAsMetric);
        const display = value === null || value === undefined ? "—" : def.format(value);
        return `<td>${display}${deltas[def.key]}</td>`;
    }).join("");

    return `
        <tr class="stats-row-group-summary" style="border-bottom: 1px solid var(--border); ${tintStyle}">
            <td><span class="stats-collapse-gutter">${gutterArrowHtml}</span>${escapeHtml(groupName)}</td>
            <td class="stats-group-summary-counts">${escapeHtml(countsLine)}</td>
            <td>—</td>
            ${metricCellsHtml}
        </tr>
    `;
}

/**
 A group is collapsible only when all its books form one unbroken run in display order.
 Recomputed every render since order can change from sorting or drag-and-drop.
 @param {Array<Object>} orderedMetrics - perBookMetrics entries in display order.
 @returns {Set<number>} Group ids that qualify as contiguous.
*/
function computeContiguousGroupIds(orderedMetrics) {
    const groupIdToIndices = new Map();
    orderedMetrics.forEach((m, idx) => {
        const groupId = m.book.groupId;
        if (!groupId) return;
        if (!groupIdToIndices.has(groupId)) groupIdToIndices.set(groupId, []);
        groupIdToIndices.get(groupId).push(idx);
    });

    const contiguousGroupIds = new Set();
    groupIdToIndices.forEach((indices, groupId) => {
        const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
        if (isContiguous) contiguousGroupIds.add(groupId);
    });
    return contiguousGroupIds;
}

const COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY = "collapsedStatsGroupIds";

function getCollapsedStatsGroupIds() {
    const config = getUserConfig();
    return new Set(Array.isArray(config[COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY]) ? config[COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY] : []);
}

function setCollapsedStatsGroupIds(collapsedGroupIdsSet) {
    saveUserConfig({ [COLLAPSED_STATS_GROUP_IDS_CONFIG_KEY]: Array.from(collapsedGroupIdsSet) });
}

let cachedPerBookMetrics = null;
let cachedStatAveragesByStatus = null;

function toggleStatsGroupCollapse(groupId) {
    const collapsedGroupIds = getCollapsedStatsGroupIds();
    if (collapsedGroupIds.has(groupId)) {
        collapsedGroupIds.delete(groupId);
    } else {
        collapsedGroupIds.add(groupId);
    }
    setCollapsedStatsGroupIds(collapsedGroupIds);
    renderStatsTableBody();
}

function collapseAllStatsGroups() {
    if (!cachedPerBookMetrics) return;
    const allGroupIds = new Set(cachedPerBookMetrics.map((m) => m.book.groupId).filter(Boolean));
    setCollapsedStatsGroupIds(allGroupIds);
    renderStatsTableBody();
}

function expandAllStatsGroups() {
    setCollapsedStatsGroupIds(new Set());
    renderStatsTableBody();
}

/**
 Splits perBookMetrics into row-ordering units based on group contiguity
 (see computeContiguousGroupIds()) and collapsed state:
 - Non-contiguous group: books fall through individually, like ungrouped books.
 - Collapsed: one "collapsedGroup" unit.
 - Expanded, not sorting: one "expandedGroup" unit (renders as a block).
 - Expanded, sorting: individual "book" units, so they scatter into the global sort.

 @param {Array<Object>} perBookMetrics - Books' metric entries in display order.
 @param {boolean} isSorting - True while a column sort is active.
 @returns {Array<Object>} Units: { type: "book", metric } | { type: "collapsedGroup" |
   "expandedGroup", groupId, groupMetrics }.
*/
function computeStatsTableUnits(perBookMetrics, isSorting) {
    const contiguousGroupIds = computeContiguousGroupIds(perBookMetrics);
    const collapsedGroupIds = getCollapsedStatsGroupIds();

    const units = [];
    let i = 0;
    while (i < perBookMetrics.length) {
        const m = perBookMetrics[i];
        const groupId = m.book.groupId;

        if (groupId && contiguousGroupIds.has(groupId)) {
            let runEnd = i;
            while (runEnd < perBookMetrics.length && perBookMetrics[runEnd].book.groupId === groupId) {
                runEnd++;
            }
            const runMetrics = perBookMetrics.slice(i, runEnd);
            if (collapsedGroupIds.has(groupId)) {
                units.push({ type: "collapsedGroup", groupId, groupMetrics: runMetrics });
            } else if (isSorting) {
                runMetrics.forEach((rm) => units.push({ type: "book", metric: rm }));
            } else {
                units.push({ type: "expandedGroup", groupId, groupMetrics: runMetrics });
            }
            i = runEnd;
        } else {
            units.push({ type: "book", metric: m });
            i++;
        }
    }
    return units;
}

/**
 Resolves the value a unit sorts by, or null if not comparable (sorted to the end).
 A group unit sorts by its aggregate average, so it ranks the same expanded or collapsed.
 @param {Object} unit - A unit from computeStatsTableUnits().
 @param {Object} def - The active FOUR_METRIC_DEFINITIONS entry.
 @returns {number|null}
*/
function getStatsUnitSortValue(unit, def) {
    if (unit.type === "book") return def.getValue(unit.metric);
    const groupAverages = computeStatAveragesForGroup(unit.groupMetrics);
    const value = groupAverages[def.averageKey];
    return value === null || value === undefined ? null : value;
}

/**
 Orders units by the active sort column; units without a comparable value go last.
 @param {Array<Object>} units - Units from computeStatsTableUnits().
 @returns {Array<Object>}
*/
function sortStatsTableUnits(units) {
    const { columnKey, direction } = statsSortState;
    if (!columnKey || !direction) return units;

    const def = FOUR_METRIC_DEFINITIONS.find((d) => d.key === columnKey);
    if (!def) return units;

    const withValue = [];
    const withoutValue = [];
    units.forEach((unit) => {
        const value = getStatsUnitSortValue(unit, def);
        (value === null ? withoutValue : withValue).push(unit);
    });

    withValue.sort((a, b) => {
        const diff = getStatsUnitSortValue(a, def) - getStatsUnitSortValue(b, def);
        return direction === "desc" ? -diff : diff;
    });

    return [...withValue, ...withoutValue];
}

/**
 Builds the full #stats-books-table-body HTML from perBookMetrics: splits into units
 (computeStatsTableUnits), sorts if a column is active, then renders each unit.
 @param {Array<Object>} perBookMetrics - Books' metric entries in display order.
 @param {Object} statAveragesByStatus - Averages/cutoffs keyed by status.
 @returns {string} HTML for all `<tr>` rows.
*/
function buildStatsTableRowsHtml(perBookMetrics, statAveragesByStatus) {
    const isSorting = !!(statsSortState.columnKey && statsSortState.direction);
    const units = sortStatsTableUnits(computeStatsTableUnits(perBookMetrics, isSorting));

    return units
        .map((unit) => {
            if (unit.type === "collapsedGroup") {
                return buildGroupSummaryRowHtml(unit.groupId, unit.groupMetrics, statAveragesByStatus);
            }
            if (unit.type === "expandedGroup") {
                return unit.groupMetrics
                    .map((rm, idx) => buildStatsRowHtml(rm, statAveragesByStatus, {
                        grouped: true,
                        showCollapseArrow: idx === 0,
                        groupId: unit.groupId,
                        disableCollapseArrow: isSorting,
                    }))
                    .join("");
            }
            return buildStatsRowHtml(unit.metric, statAveragesByStatus, { grouped: !!unit.metric.book.groupId });
        })
        .join("");
}

// Column sort state for the per-book table headers. Not persisted - resetStatsSortState()
// runs each time the stats view opens. direction cycles null -> "desc" -> "asc" -> null.
let statsSortState = { columnKey: null, direction: null };

function resetStatsSortState() {
    statsSortState = { columnKey: null, direction: null };
}

/**
 Click handler for a sortable column header. Cycles dormant -> desc -> asc -> dormant;
 a different column always starts fresh at descending.
 @param {string} columnKey - FOUR_METRIC_DEFINITIONS key of the clicked header.
*/
function handleStatsSortHeaderClick(columnKey) {
    if (statsSortState.columnKey !== columnKey) {
        statsSortState = { columnKey, direction: "desc" };
    } else if (statsSortState.direction === "desc") {
        statsSortState.direction = "asc";
    } else {
        statsSortState = { columnKey: null, direction: null };
    }
    updateStatsSortHeaderUI();
    renderStatsTableBody();
}

function updateStatsSortHeaderUI() {
    FOUR_METRIC_DEFINITIONS.forEach((def) => {
        const header = document.getElementById(`stats-sort-header-${def.key}`);
        if (!header) return;
        header.querySelectorAll(".stats-sort-arrow").forEach((arrow) => {
            const isActive = statsSortState.columnKey === def.key && arrow.dataset.direction === statsSortState.direction;
            arrow.classList.toggle("active", isActive);
        });
    });
}

// Re-renders just the table body from the cached last-computed metrics -
// used by every collapse/expand/sort action above so toggling never
// re-runs the full showStatsViewState() pass.
function renderStatsTableBody() {
    const tbody = document.getElementById("stats-books-table-body");
    if (!tbody || !cachedPerBookMetrics) return;
    tbody.innerHTML = buildStatsTableRowsHtml(cachedPerBookMetrics, cachedStatAveragesByStatus);
}


// =================================================================
// LIBRARY DISTRIBUTION - DYNAMIC BUCKETING ENGINE
// =================================================================
/**
 Builds equal-width numeric buckets from the data's IQR-fenced range instead of fixed
 cutoffs, so outliers don't stretch every bucket. Falls back to staticBuckets when there's
 too little data or a degenerate range.
 @param {number[]} values - Raw values to bucket.
 @param {Array<{min,max,label}>} staticBuckets - Fallback buckets.
 @param {number} bucketCount - Number of dynamic buckets to build.
 @param {string} unitLabel - Unit suffix for generated labels (e.g. "pages", "p/h").
 @returns {Array<{min,max,label}>} Buckets; first/last use -Infinity/Infinity.
*/
const MIN_VALUES_FOR_DYNAMIC_BUCKETS = 5;
const IQR_FENCE_MULTIPLIER = 1.5; // Tukey's fence multiplier for mild-outlier trimming

// Linear-interpolation percentile over a sorted array.
function percentile(sortedValues, p) {
    const idx = p * (sortedValues.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sortedValues[lower];
    const frac = idx - lower;
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * frac;
}

function buildDynamicBuckets(values, staticBuckets, bucketCount, unitLabel) {
    if (values.length < MIN_VALUES_FOR_DYNAMIC_BUCKETS) return staticBuckets;

    const sorted = [...values].sort((a, b) => a - b);

    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const fenceMin = q1 - IQR_FENCE_MULTIPLIER * iqr;
    const fenceMax = q3 + IQR_FENCE_MULTIPLIER * iqr;
    const trimmedMin = Math.max(sorted[0], fenceMin);
    const trimmedMax = Math.min(sorted[sorted.length - 1], fenceMax);
    if (!(trimmedMax > trimmedMin)) return staticBuckets; // degenerate trimmed range

    const width = (trimmedMax - trimmedMin) / bucketCount;
    const edgeAt = (i) => trimmedMin + i * width;

    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
        const isFirst = i === 0;
        const isLast = i === bucketCount - 1;
        // First/last use -Infinity/Infinity so outliers still land in an end bucket.
        const min = isFirst ? -Infinity : edgeAt(i);
        const max = isLast ? Infinity : edgeAt(i + 1);
        const label = isLast
            ? `${Math.round(edgeAt(i))}+ ${unitLabel}`
            : `${Math.round(edgeAt(i))}\u2013${Math.round(edgeAt(i + 1))} ${unitLabel}`;
        buckets.push({ min, max, label });
    }
    return buckets;
}

/**
 Places values into their matching bucket's count.
 @param {number[]} values
 @param {Array<{min,max,label}>} buckets
 @returns {Array<{label,count}>}
*/
function tallyIntoBuckets(values, buckets) {
    const counts = buckets.map(() => 0);
    for (const value of values) {
        for (let i = 0; i < buckets.length; i++) {
            if (value >= buckets[i].min && (value < buckets[i].max || buckets[i].max === Infinity)) {
                counts[i]++;
                break;
            }
        }
    }
    return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
}

/**
 Computes the three Library Distribution breakdowns from perBookMetrics.
 @param {Array<Object>} perBookMetrics
 @returns {{bookLength, readingStatus, readingSpeed}} Each is { entries: [{label,
   count}], eligibleCount } - eligibleCount is the percentage denominator, which differs
   per chart (all books for Length/Status, only books with a valid pages/hour for Speed).
*/
const BOOK_LENGTH_STATIC_BUCKETS = [
    { min: 0, max: 300, label: "0\u2013299 pages" },
    { min: 300, max: 500, label: "300\u2013499 pages" },
    { min: 500, max: 700, label: "500\u2013699 pages" },
    { min: 700, max: 900, label: "700\u2013899 pages" },
    { min: 900, max: Infinity, label: "900+ pages" },
];

const READING_SPEED_STATIC_BUCKETS = [
    { min: 0, max: 50, label: "<50 p/h" },
    { min: 50, max: 60, label: "50\u201360 p/h" },
    { min: 60, max: 70, label: "60\u201370 p/h" },
    { min: 70, max: 80, label: "70\u201380 p/h" },
    { min: 80, max: 100, label: "80\u2013100 p/h" },
    { min: 100, max: Infinity, label: "100+ p/h" },
];

function computeLibraryDistributions(perBookMetrics) {
    // 1. Book Length - every book with a known page count qualifies, read or not.
    const pageCounts = perBookMetrics.filter(m => m.totalPages > 0).map(m => m.totalPages);
    const lengthBuckets = buildDynamicBuckets(pageCounts, BOOK_LENGTH_STATIC_BUCKETS, 5, "pages");
    const bookLength = {
        entries: tallyIntoBuckets(pageCounts, lengthBuckets),
        eligibleCount: pageCounts.length,
    };

    // 2. Reading Status - fixed, mutually-exclusive buckets.
    let completedCount = 0, inProgressCount = 0, notStartedCount = 0;
    for (const m of perBookMetrics) {
        if (m.isRead) completedCount++;
        else if (m.isStarted) inProgressCount++;
        else notStartedCount++;
    }
    const readingStatus = {
        entries: [
            { label: "Completed", count: completedCount },
            { label: "In Progress", count: inProgressCount },
            { label: "Not Started", count: notStartedCount },
        ],
        eligibleCount: perBookMetrics.length,
    };

    // 3. Reading Speed - only books with a meaningful pages/hour figure qualify.
    const speeds = perBookMetrics.filter(m => m.pagesPerHour !== null).map(m => m.pagesPerHour);
    const speedBuckets = buildDynamicBuckets(speeds, READING_SPEED_STATIC_BUCKETS, 5, "p/h");
    const readingSpeed = {
        entries: tallyIntoBuckets(speeds, speedBuckets),
        eligibleCount: speeds.length,
    };

    return { bookLength, readingStatus, readingSpeed };
}

/**
 Renders a distribution bar chart. Bar height matches the same percent shown in the
 label, so bars and labels never disagree.
 @param {string} containerId
 @param {{entries: Array<{label,count}>, eligibleCount: number}} distribution
*/
function renderDistributionBarChart(containerId, distribution) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { entries, eligibleCount } = distribution;
    if (!eligibleCount || entries.every(e => e.count === 0)) {
        container.innerHTML = `<div style="color:var(--text-muted)">Not enough data yet.</div>`;
        return;
    }

    const bars = entries.map(e => {
        const percent = eligibleCount ? (e.count / eligibleCount) * 100 : 0;
        const heightPercent = e.count > 0 ? Math.max(4, percent) : 0; // floor so non-zero bars stay visible
        return `
            <div class="dist-bar-column">
                <div class="dist-bar-track">
                    <div class="dist-bar-fill" style="height:${heightPercent}%;"></div>
                </div>
                <div class="dist-bar-count">${e.count} book${e.count === 1 ? "" : "s"} (${percent.toFixed(0)}%)</div>
                <div class="dist-bar-label">${escapeHtml(e.label)}</div>
            </div>
        `;
    }).join("");

    container.innerHTML = `<div class="dist-bar-chart">${bars}</div>`;
}

// =================================================================
// GLOBAL READING STATS VIEW LAYOUT ROUTER CONTROLLER
// =================================================================
async function showStatsViewState() {
    document.getElementById("library-view").style.display = "none";
    document.getElementById("reader-view").style.display = "none";
    const notesViewEl = document.getElementById("notes-view");
    if (notesViewEl) notesViewEl.style.display = "none";

    const statsPanel = document.getElementById("stats-view");
    statsPanel.style.display = "flex";

    // Sort state is never persisted - every fresh open of the stats view
    // starts all four sortable headers dormant, regardless of how they
    // were left last time.
    resetStatsSortState();
    updateStatsSortHeaderUI();

    const tbody = document.getElementById("stats-books-table-body");
    tbody.innerHTML = `<tr><td colspan="7" style="padding:12px; text-align:center; color:var(--text-muted)">Loading book metadata...</td></tr>`;

    /*
     Backfills totalPages/totalWords/chapterCount on any book that predates
     those cached fields (see 07-epub-parser.js, 08-epub-import.js, or 09-epub-reader.js). Books that already have
     them resolve instantly without touching their EPUB file, so awaiting
     this on every stats-view open is cheap after the first pass.
    */
    await migrateMissingBookMetadata();

    let totalBooksCount = loadedBooksMemory.length;
    let readBooksCount = 0;
    let combinedSecondsTracked = 0;
    let sessionTime = 0; // fallback accumulator, only used for books with no real session records yet

    // Core calculation metrics
    let globalTotalPagesRead = 0;
    let globalTotalWordsRead = 0;
    let timedPagesRead = 0;

    let longestBook = null;
    let shortestBook = null;
    const completedBooks = [];
    const completionsByMonth = {}; // "YYYY-MM" -> completed count
    let totalReadingSessions = 0; // sum of totalSessions, fallback denominator for avg session length
    /*
    Completion Duration is calendar time between firstOpened and completedDate,
    not reading time (timeSpentSeconds). It is calculated separately using
    the same running min/max approach used by the other book stats.
    */
    let completionDurationSumMs = 0;
    let completionDurationCount = 0;
    let fastestCompletion = null; // {book, durationMs}
    let slowestCompletion = null;

    /*
    Pages/day is based on calendar days between firstOpened and completedDate,
    unlike pages/hour which uses reading time. It uses the same completed-book
    requirements and running min/max tracking as Completion Duration.
    */
    let pagesPerDaySum = 0;
    let pagesPerDayCount = 0;
    let fastestPagesPerDay = null; // {book, pagesPerDay}
    let slowestPagesPerDay = null;

    /*
    "Reading Speed Over Lifetime" stores per-completed-book pages/hour entries
    as a list because the data must later be sorted by completedDate and
    displayed individually rather than reduced into one aggregate value.
    */
    const speedProgressionEntries = []; // {book, completedDate, pagesPerHour}

    /*
    Stores raw per-book metrics collected during the first pass. Averages are
    only available after all books are processed, so delta comparisons and row
    HTML are generated afterward using these already-calculated values.
    */
    const perBookMetrics = [];

    /*
     Iterates the library's actual display order (getBooksInDisplayOrder(),
     04-library-view.js) instead of raw loadedBooksMemory, so the table
     respects "Sort Books by Group Order" the same way the library grid's
     "All Books" view already does - and so this order is what
     buildStatsTableRowsHtml() below finds its contiguous group runs in.
     All numbers below come straight off each book's cached fields, no
     EPUB is opened here.
    */
    for (const book of getBooksInDisplayOrder()) {
        combinedSecondsTracked += getMeaningfulTrackedSeconds(book.timeSpentSeconds);
        totalReadingSessions += (book.totalSessions || 0);

        if (book.totalSessions > 0) {
            sessionTime += getMeaningfulTrackedMinutes(book.timeSpentSeconds);
        }

        const totalPages = book.totalPages || 0;
        const totalWords = book.totalWords || 0;
        const chapterCount = book.chapterCount || 0;

        if (totalPages > 0) {
            if (!longestBook || totalPages > (longestBook.totalPages || 0)) longestBook = book;
            if (!shortestBook || totalPages < (shortestBook.totalPages || 0)) shortestBook = book;
        }

        const isRead = !!book.isRead;
        // Counts toward "BOOKS FULLY READ" and feeds completionsByMonth for any book
        // marked read with a recorded completedDate.
        if (isRead) {
            readBooksCount++;
            completedBooks.push(book);
            if (book.completedDate) {
                const d = new Date(book.completedDate);
                const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                completionsByMonth[monthKey] = (completionsByMonth[monthKey] || 0) + 1;
            }
        }

        /*
        Only books with both fields qualify. A book may have a completedDate
        without firstOpened, such as older records or manually edited completions.

        Uses the existing completionDurationMs value instead of recalculating it,
        and additionally requires isRead because Pages/day only applies to
        completed books. Calendar days are floored at 1 to avoid near-zero
        same-day completion divisions.
        */
        let completionDurationMs = null;
        let pagesPerDay = null;
        if (book.firstOpened && book.completedDate) {
            completionDurationMs = book.completedDate - book.firstOpened;
            completionDurationSumMs += completionDurationMs;
            completionDurationCount++;
            if (!fastestCompletion || completionDurationMs < fastestCompletion.durationMs) {
                fastestCompletion = { book, durationMs: completionDurationMs };
            }
            if (!slowestCompletion || completionDurationMs > slowestCompletion.durationMs) {
                slowestCompletion = { book, durationMs: completionDurationMs };
            }

            if (isRead && totalPages > 0) {
                const calendarDays = Math.max(1, completionDurationMs / (1000 * 60 * 60 * 24));
                pagesPerDay = totalPages / calendarDays;
                pagesPerDaySum += pagesPerDay;
                pagesPerDayCount++;
                if (!fastestPagesPerDay || pagesPerDay > fastestPagesPerDay.pagesPerDay) {
                    fastestPagesPerDay = { book, pagesPerDay };
                }
                if (!slowestPagesPerDay || pagesPerDay < slowestPagesPerDay.pagesPerDay) {
                    slowestPagesPerDay = { book, pagesPerDay };
                }
            }
        }

        let pagesRead, wordsRead;
        if (isRead) {
            pagesRead = totalPages;
            wordsRead = totalWords;
        } else if (book.currentChapter > 0 || book.scrollOffset > 100) {
            const chapterWordCounts = book.chapterWordCounts;
            let progress;
            if (Array.isArray(chapterWordCounts) && chapterWordCounts.length === chapterCount && totalWords > 0) {
                let wordsBefore = 0;
                for (let i = 0; i < book.currentChapter && i < chapterWordCounts.length; i++) wordsBefore += chapterWordCounts[i];
                progress = wordsBefore / totalWords;
            } else {
                progress = book.currentChapter / Math.max(1, chapterCount);
            }
            pagesRead = Math.round(progress * totalPages);
            wordsRead = Math.round(progress * totalWords);
        } else {
            pagesRead = 0;
            wordsRead = 0;
        }

        globalTotalPagesRead += pagesRead;
        globalTotalWordsRead += wordsRead;

        const meaningfulTrackedSeconds = getMeaningfulTrackedSeconds(book.timeSpentSeconds);
        const mins = getMeaningfulTrackedMinutes(book.timeSpentSeconds);
        if (mins > 0) timedPagesRead += pagesRead;
        /*
        Reading Speed Over Lifetime uses completed books with a completedDate and
        meaningful tracked reading time. A raw timeSpentSeconds > 0 check allowed
        tiny values to create unrealistic pages/hour results.

        Uses getMeaningfulTrackedSeconds() as the shared validation gate, matching
        the main per-book table and preventing inconsistent calculations.
        */
        if (isRead && book.completedDate && totalPages > 0 && meaningfulTrackedSeconds > 0) {
            const trackedReadingHours = meaningfulTrackedSeconds / 3600;
            speedProgressionEntries.push({
                book,
                // Every entry here is a completed book by construction 
                // (see the isRead && book.completedDate gate above), so stamp the status explicitly
                // for buildFourMetricDeltas() to use the Completed averages group.
                status: READING_STATUS.COMPLETED,
                completedDate: book.completedDate,
                pagesPerHour: totalPages / trackedReadingHours,
                mins: getMeaningfulTrackedMinutes(book.timeSpentSeconds),
                completionDurationMs,
                pagesPerDay,
            });
        }

        // Stash this book's raw metric values instead of building its row string immediately - see perBookMetrics comment above.
        perBookMetrics.push({
            book,
            isRead,
            // Same "has the user actually opened/progressed this book" check used
            // above for pagesRead, reused for the Reading Status distribution split.
            isStarted: book.currentChapter > 0 || book.scrollOffset > 100,
            // Adds "Paused" detection on top of Completed/In Progress/Not Started.
            // Uses getBookReadingStatus() as the shared source for status logic.
            status: getBookReadingStatus(book),
            pagesRead,
            totalPages,
            mins,
            pagesPerHour: mins > 0 ? (pagesRead / mins * 60) : null, // numeric value, formatted for display where rendered
            completionDurationMs,
            pagesPerDay,
        });
    }
        /*
        Computes per-status averages for the per-book delta comparisons:
        Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

        Each book is compared only against others with the same status
        (Completed/In Progress/Paused). Uses perBookMetrics so the same metric
        validity rules from the main loop are reused instead of being duplicated.

        See computeStatAveragesByStatus().
        */
        const statAveragesByStatus = computeStatAveragesByStatus(perBookMetrics);

    // Cache this pass's metrics so collapse/expand toggles (see
    // renderStatsTableBody()) can re-render the table without re-running
    // everything above.
    cachedPerBookMetrics = perBookMetrics;
    cachedStatAveragesByStatus = statAveragesByStatus;

    // Flush table rows inside dashboard
    renderStatsTableBody();

   /*
    Library Distribution charts (Book Length, Reading Status, and Reading
    Speed) reuse perBookMetrics instead of performing another pass over
    loadedBooksMemory, matching the approach used by statAveragesByStatus.
    */
    const libraryDistributions = computeLibraryDistributions(perBookMetrics);
    renderDistributionBarChart("dist-book-length", libraryDistributions.bookLength);
    renderDistributionBarChart("dist-reading-status", libraryDistributions.readingStatus);
    renderDistributionBarChart("dist-reading-speed", libraryDistributions.readingSpeed);

    // --- MATH COMPILATIONS & UI UPDATES ---
    const totalMins = Math.round(combinedSecondsTracked / 60);
    const booksWithTime = loadedBooksMemory.filter(b => getMeaningfulTrackedSeconds(b.timeSpentSeconds) > 0).length;
    const avgMins = booksWithTime ? Math.round(totalMins / booksWithTime) : 0;
    const avgPagesPerHour = totalMins ? (timedPagesRead / totalMins * 60).toFixed(1): "—";

    const booksWithPages = loadedBooksMemory.filter(b => (b.totalPages || 0) > 0);
    const avgBookLengthPages = booksWithPages.length
        ? Math.round(booksWithPages.reduce((sum, b) => sum + b.totalPages, 0) / booksWithPages.length)
        : 0;
    const avgCompletedLengthPages = completedBooks.length
        ? Math.round(completedBooks.reduce((sum, b) => sum + (b.totalPages || 0), 0) / completedBooks.length)
        : 0;

    const avgSessionMins = totalReadingSessions ? Math.round(sessionTime / totalReadingSessions) : 0;
    // Update standard interface element outputs values
    document.getElementById("stat-total-books").innerText = totalBooksCount;
    document.getElementById("stat-read-books").innerText = readBooksCount;
    document.getElementById("stat-total-time").innerText = formatMinutes(totalMins);
    document.getElementById("stat-avg-time").innerText = formatMinutes(avgMins);
    document.getElementById("stat-avg-pages-per-hour").innerText = avgPagesPerHour === "—" ? "—" : `${avgPagesPerHour} p/h`;

    const globalPagesElement = document.getElementById("stat-global-pages");
    if (globalPagesElement) {
        globalPagesElement.innerText = globalTotalPagesRead;
    }

    /*
     The stat elements below are new. Each is looked up defensively the
     same way stat-global-pages already was above, so this keeps working
     whether or not the matching element has been added to index.html yet.
    */
    const avgLengthElement = document.getElementById("stat-avg-book-length");
    if (avgLengthElement) 
        avgLengthElement.innerText = avgBookLengthPages ? `${avgBookLengthPages} pages` : "—";

    const avgCompletedLengthElement = document.getElementById("stat-avg-completed-length");
    if (avgCompletedLengthElement)
        avgCompletedLengthElement.innerText = avgCompletedLengthPages ? `${avgCompletedLengthPages} pages` : "—";

    const longestBookElement = document.getElementById("stat-longest-book");
    if (longestBookElement) 
        longestBookElement.innerHTML = longestBook ? `${escapeHtml(longestBook.title)} (${longestBook.totalPages} pages)` : "—";

    const shortestBookElement = document.getElementById("stat-shortest-book");
    if (shortestBookElement) 
        shortestBookElement.innerHTML = shortestBook ? `${escapeHtml(shortestBook.title)} (${shortestBook.totalPages} pages)` : "—";

    const totalWordsElement = document.getElementById("stat-total-words-read");
    if (totalWordsElement) 
        totalWordsElement.innerText = globalTotalWordsRead.toLocaleString();

    const avgSessionElement = document.getElementById("stat-avg-session-length");
    if (avgSessionElement) 
        avgSessionElement.innerText = avgSessionMins ? formatMinutes(avgSessionMins) : "—";

    /*
     Completion Duration stats - calendar time, not reading time (see the
     comment above completionDurationSumMs earlier in this function).
    */
    const avgCompletionDurationElement = document.getElementById("stat-avg-completion-duration");
    if (avgCompletionDurationElement) {
        avgCompletionDurationElement.innerText = completionDurationCount
            ? formatCompletionDuration(completionDurationSumMs / completionDurationCount)
            : "—";
    }

    const fastestCompletionElement = document.getElementById("stat-fastest-completion");
    if (fastestCompletionElement) {
        fastestCompletionElement.innerHTML = fastestCompletion
            ? `${escapeHtml(fastestCompletion.book.title)} (${formatCompletionDuration(fastestCompletion.durationMs)})`
            : "—";
    }

    const slowestCompletionElement = document.getElementById("stat-slowest-completion");
    if (slowestCompletionElement) {
        slowestCompletionElement.innerHTML = slowestCompletion
            ? `${escapeHtml(slowestCompletion.book.title)} (${formatCompletionDuration(slowestCompletion.durationMs)})`
            : "—";
    }

    const avgPagesPerDayElement = document.getElementById("stat-avg-pages-per-day");
    if (avgPagesPerDayElement) {
        avgPagesPerDayElement.innerText = pagesPerDayCount
            ? `${(pagesPerDaySum / pagesPerDayCount).toFixed(1)} p/day`
            : "—";
    }

    const fastestPagesPerDayElement = document.getElementById("stat-fastest-pages-per-day");
    if (fastestPagesPerDayElement) {
        fastestPagesPerDayElement.innerHTML = fastestPagesPerDay
            ? `${escapeHtml(fastestPagesPerDay.book.title)} (${fastestPagesPerDay.pagesPerDay.toFixed(1)} p/day)`
            : "—";
    }

    const slowestPagesPerDayElement = document.getElementById("stat-slowest-pages-per-day");
    if (slowestPagesPerDayElement) {
        slowestPagesPerDayElement.InnerHtml = slowestPagesPerDay
            ? `${escapeHtml(slowestPagesPerDay.book.title)} (${slowestPagesPerDay.pagesPerDay.toFixed(1)} p/day)`
            : "—";
    }

   /*
    Completion Timeline is handled by 18-timeline.js as a modular
    multi-mode system through buildCompletionTimelineData().

    completionsByMonth still feeds the per-book stats table unchanged. The
    timeline data is stored on window so mode buttons and tooltip handlers can
    reuse it without rebuilding the data.
    */
    window.__completionTimelineData = buildCompletionTimelineData(loadedBooksMemory);
    renderCompletionTimeline(window.__completionTimelineData);
    renderReadingSpeedProgression(speedProgressionEntries, statAveragesByStatus);

    // See 17-reading-history.js. Guarded like other optional stats components,
    // so this still works if the script or container is not present.
    if (typeof renderReadingActivityCalendar === "function") {
        renderReadingActivityCalendar();
    }
}

/**
 Handler for the "Backfill Completion Dates" button.

 Runs the bulk migration, refreshes IndexedDB data, re-renders stats, and
 reports how many books received completion dates.
*/
async function handleBackfillCompletionDatesClick() {
    const button = document.getElementById("btn-backfill-completion-dates");
    if (button) {
        button.disabled = true;
        button.innerText = "Backfilling...";
    }
    try {
        const updatedCount = await migrateMissingCompletionDates();
        fetchLocalLibrary();
        await showStatsViewState();
        alert(
            updatedCount > 0
                ? `Backfilled completion dates for ${updatedCount} book${updatedCount === 1 ? "" : "s"}.`
                : "No books needed a completion date backfill.",
        );
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = "🕓 Backfill Completion Dates";
        }
    }
}

/**
 Renders `#stats-reading-speed-progression` with the four per-book metrics:
 Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

 Shows completed books individually, grouped by completion month and sorted
 chronologically, so reading pace changes can be seen book by book instead
 of being hidden by monthly averages.

 Reuses `buildFourMetricDeltas()` from the per-book table instead of
 duplicating delta logic. Entries contain the same metric fields and always
 belong to the Completed averages group.

 @param {Array<Object>} entries - Completed-book speed entries collected in
   showStatsViewState() ({book, completedDate, pagesPerHour, ...}).
 @param {Object} statAveragesByStatus - Averages/cutoffs keyed by status, used as the
   delta comparison baseline for each entry and for the footer's Completed averages.
*/
function renderReadingSpeedProgression(entries, statAveragesByStatus) {
    const container = document.getElementById("stats-reading-speed-progression");
    if (!container) return;

    if (entries.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted)">No completed books with tracked reading time yet.</div>`;
        return;
    }

    const sorted = [...entries].sort((a, b) => a.completedDate - b.completedDate);

    // Group into "YYYY-MM" buckets, same key format as completionsByMonth,
    // while preserving chronological order within (and across) months.
    const byMonth = {};
    const monthOrder = [];
    for (const entry of sorted) {
        const d = new Date(entry.completedDate);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[monthKey]) {
            byMonth[monthKey] = [];
            monthOrder.push(monthKey);
        }
        byMonth[monthKey].push(entry);
    }

    const monthSections = monthOrder.map((monthKey) => {
        const [year, month] = monthKey.split("-");
        const label = new Date(Number(year), Number(month) - 1, 1)
            .toLocaleDateString(undefined, { month: "long", year: "numeric" });

        const rows = byMonth[monthKey]
            .map((entry) => {
                const deltas = buildFourMetricDeltas(entry, statAveragesByStatus);
                return `
                    <div style="padding:6px 0 10px 16px; border-bottom:1px dashed var(--border);">
                        <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(entry.book.title)}</div>
                        <div class="speed-progression-metrics-grid">
                            <div>
                                <div class="speed-progression-metric-label">Time Spent</div>
                                <div class="speed-progression-metric-value-row"><span>${formatMinutes(entry.mins)}</span>${deltas.timeSpent}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Hour</div>
                                <div class="speed-progression-metric-value-row"><span>${entry.pagesPerHour.toFixed(1)} p/h</span>${deltas.pagesPerHour}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Completion Duration</div>
                                <div class="speed-progression-metric-value-row"><span>${formatCompletionDuration(entry.completionDurationMs)}</span>${deltas.completionDuration}</div>
                            </div>
                            <div>
                                <div class="speed-progression-metric-label">Pages per Day</div>
                                <div class="speed-progression-metric-value-row"><span>${entry.pagesPerDay !== null ? `${entry.pagesPerDay.toFixed(1)} p/day` : "—"}</span>${deltas.pagesPerDay}</div>
                            </div>
                        </div>
                    </div>
                `;
            })
            .join("");

        return `
            <div style="padding:6px 0;">
                <div style="font-weight:600; padding:4px 0;">${escapeHtml(label)}</div>
                ${rows}
            </div>
        `;
    });

    /*
    "Average" footer shows one line per comparable metric:
    Time Spent, Pages per Hour, Completion Duration, and Pages per Day.

    Reads averages from the Completed group in statAveragesByStatus instead
    of recalculating them, since every entry here is a completed book.
    Loops over FOUR_METRIC_DEFINITIONS so future metrics are included
    automatically.

    Uses each metric's own format() function, keeping footer units consistent
    with individual book values. Metrics without qualifying books are skipped
    instead of showing an invalid zero-book average.
    */
    const completedAverages = statAveragesByStatus[READING_STATUS.COMPLETED];
    const averageRows = FOUR_METRIC_DEFINITIONS
        .map((def) => {
            const average = completedAverages[def.averageKey];
            if (average === null || average === undefined) return "";
            return `
                <div class="speed-progression-average-row">
                    <span class="speed-progression-average-label">${escapeHtml(def.label)}</span>
                    <span class="speed-progression-average-value">${escapeHtml(def.format(average))}</span>
                </div>
            `;
        })
        .join("");

    container.innerHTML = `
        ${monthSections.join("")}
        <div class="speed-progression-average-block">
            <div class="speed-progression-average-heading">Average</div>
            ${averageRows}
        </div>
    `;
}