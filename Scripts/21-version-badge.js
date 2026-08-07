/*
  GITHUB VERSION BADGE

  Renders a "vX.Y.N" badge in the bottom-right corner (X.Y set manually, N derived from commit count).
  Shows commit details on hover, supports manual/auto cache refreshes, and displays an "(outdated)" 
  status if GitHub Pages deployment lags behind the latest branch commit.
*/

const VERSION_BADGE_REPO_OWNER = Config.VersionBadge.REPO_OWNER;
const VERSION_BADGE_REPO_NAME = Config.VersionBadge.REPO_NAME;
const VERSION_BADGE_REPO_BRANCH = Config.VersionBadge.REPO_BRANCH;
/**
  Major/minor version prefix manually set in Config.
  @type {string}
*/
const VERSION_BADGE_MAJOR_MINOR = Config.VersionBadge.MAJOR_MINOR;
/**
  LocalStorage key for persisting version badge state.
  @type {string}
*/
const VERSION_BADGE_CACHE_KEY = Config.VersionBadge.CACHE_KEY;
/**
  Interval in milliseconds to stay under GitHub's 60 req/hr rate limit.
  @type {number}
*/
const VERSION_BADGE_AUTO_REFRESH_MS = Config.VersionBadge.AUTO_REFRESH_MS;
/**
  Cache lifetime in milliseconds before data is considered stale.
  @type {number}
*/
const VERSION_BADGE_CACHE_TTL_MS = Config.VersionBadge.CACHE_TTL_MS;
/**
  Minimum cooldown duration in milliseconds between user-triggered manual refreshes.
  @type {number}
*/
const MANUAL_REFRESH_COOLDOWN = Config.VersionBadge.MANUAL_REFRESH_COOLDOWN;
/**
  Threshold in milliseconds before showing an absolute date alongside relative time.
  @type {number}
*/
const TIME_BEFORE_SHOWING_DATE = Config.VersionBadge.TIME_BEFORE_SHOWING_DATE;
/**
  Interval timer reference handle for background auto-refreshes.
  @type {number|null}
*/
let versionBadgeRefreshInterval = null;

/**
  Timestamp in milliseconds when the last network fetch occurred.
  @type {number}
*/
let refreshedAt = 0;

window.addEventListener("DOMContentLoaded", () => {
    initVersionBadge();
});

/**
  Initializes badge click listeners, renders cached state, and starts the background refresh loop.
*/
function initVersionBadge() {
    const badge = document.getElementById("app-version-badge");
    if (!badge) return;

    badge.addEventListener("click", () => refreshVersionBadge(true));

    // Render cache immediately to avoid empty state during initial fetch
    const cached = readVersionBadgeCache();
    if (cached) renderVersionBadge(cached);

    refreshVersionBadge(false);

    if (versionBadgeRefreshInterval) clearInterval(versionBadgeRefreshInterval);
    versionBadgeRefreshInterval = setInterval(() => {
        refreshVersionBadge(false);
    }, VERSION_BADGE_AUTO_REFRESH_MS);
}

/**
  Reads and parses stored version badge data from LocalStorage.

  @returns {Object|null} Cached version object or null if unavailable/corrupt.
*/
function readVersionBadgeCache() {
    try {
        const raw = localStorage.getItem(VERSION_BADGE_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/**
  Writes version badge data to LocalStorage.

  @param {Object} data - Version payload object to cache.
*/
function writeVersionBadgeCache(data) {
    try {
        localStorage.setItem(VERSION_BADGE_CACHE_KEY, JSON.stringify(data));
    } catch (e) {}
}

/** 
  Fetches updated version data, handles caching logic, and updates the UI.

  @param {boolean} forceRefresh - True (manual click) bypasses cache TTL and shows toasts. False respects TTL silently.
  @returns {Promise<void>}
*/
async function refreshVersionBadge(forceRefresh) {
    const cached = readVersionBadgeCache();
    const cacheIsFresh = cached && (Date.now() - cached.fetchedAt) < VERSION_BADGE_CACHE_TTL_MS;

    if (forceRefresh && Date.now() - refreshedAt < MANUAL_REFRESH_COOLDOWN) {
        showVersionToast("Refreshing too fast, slow down.", true);
        return;
    }

    if (!forceRefresh && cacheIsFresh) return;
    refreshedAt = Date.now();
    if (forceRefresh) showVersionToast("Version updating…", false);

    try {
        const [commitInfo, commitCount, deployStatus] = await Promise.all([
            fetchLatestCommitInfo(),
            fetchCommitCount(),
            fetchDeployStatus(),
        ]);

        const previousCount = cached ? cached.commitCount : null;

        // Requires exact SHA match and successful deployment status
        const isDeployed = deployStatus.sha === commitInfo.sha && deployStatus.state === "success";

        const data = {
            commitCount,
            sha: commitInfo.sha,
            message: commitInfo.message,
            date: commitInfo.date,
            isDeployed,
            fetchedAt: Date.now(),
        };

        writeVersionBadgeCache(data);
        renderVersionBadge(data);

        if (forceRefresh) {
            const changed = previousCount !== null && previousCount !== commitCount;
            showVersionToast(changed ? "Version updated" : "Already up to date", true);
        }
    } catch (e) {
        console.warn("[VersionBadge] Failed to check for updates:", e);
        if (forceRefresh) showVersionToast("Couldn't check for updates", true);
    }
}

/**
  Fetches the most recent commit metadata for the target branch from the GitHub API.

  @returns {Promise<{sha: string, message: string, date: string|null}>} Latest commit SHA, message title, and ISO date.
  @throws {Error} If GitHub API returns a non-OK status or an empty array.
*/
async function fetchLatestCommitInfo() {
    const url = `https://api.github.com/repos/${VERSION_BADGE_REPO_OWNER}/${VERSION_BADGE_REPO_NAME}/commits?sha=${encodeURIComponent(VERSION_BADGE_REPO_BRANCH)}&per_page=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const commits = await res.json();
    if (!Array.isArray(commits) || commits.length === 0) throw new Error("No commits returned");

    const commit = commits[0];
    return {
        sha: commit.sha || "",
        message: (commit.commit?.message || "").split("\n")[0],
        date: commit.commit?.committer?.date || commit.commit?.author?.date || null,
    };
}

/**
  Calculates total branch commit count using GitHub's Link header pagination trick (`rel="last"` page number).

  @returns {Promise<number>} Total commit count on the target branch.
  @throws {Error} If GitHub API request fails.
*/
async function fetchCommitCount() {
    const url = `https://api.github.com/repos/${VERSION_BADGE_REPO_OWNER}/${VERSION_BADGE_REPO_NAME}/commits?sha=${encodeURIComponent(VERSION_BADGE_REPO_BRANCH)}&per_page=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

    const linkHeader = res.headers.get("Link");
    if (!linkHeader) return 1;

    const lastLinkMatch = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    return lastLinkMatch ? parseInt(lastLinkMatch[1], 10) : 1;
}

/**
  Checks if the live GitHub Pages site is updated and deployed on the branch's newest commit.

  @returns {Promise<{sha: string|null, state: string}>} Deployment SHA and status state.
  @throws {Error} If API requests fail.
*/
async function fetchDeployStatus() {
    const deploymentsUrl = `https://api.github.com/repos/${VERSION_BADGE_REPO_OWNER}/${VERSION_BADGE_REPO_NAME}/deployments?environment=github-pages&per_page=1`;
    const deploymentsRes = await fetch(deploymentsUrl);
    if (!deploymentsRes.ok) throw new Error(`GitHub API error: ${deploymentsRes.status}`);
    const deployments = await deploymentsRes.json();
    if (!Array.isArray(deployments) || deployments.length === 0) {
        return { sha: null, state: "unknown" };
    }

    const latestDeployment = deployments[0];

    const statusesRes = await fetch(latestDeployment.statuses_url);
    if (!statusesRes.ok) throw new Error(`GitHub API error: ${statusesRes.status}`);
    const statuses = await statusesRes.json();

    const latestState = Array.isArray(statuses) && statuses.length > 0 ? statuses[0].state : "unknown";

    return { sha: latestDeployment.sha, state: latestState };
}

/**
  Renders the version text, tooltip message, and outdated state indicator in the DOM.

  @param {Object} data - Version payload object.
  @param {number} data.commitCount - Total commit count.
  @param {string} data.message - Commit message.
  @param {string|null} data.date - ISO date string of latest commit.
  @param {boolean} data.isDeployed - Whether latest commit is live on GitHub Pages.
*/
function renderVersionBadge(data) {
    const textEl = document.getElementById("app-version-badge-text");
    const badgeEl = document.getElementById("app-version-badge");
    if (!textEl || !badgeEl) return;

    if (data.isDeployed === false) {
        textEl.innerText = `v${VERSION_BADGE_MAJOR_MINOR}.${data.commitCount} (outdated)`;
    } else {
        textEl.innerText = `v${VERSION_BADGE_MAJOR_MINOR}.${data.commitCount}`;
    }

    let relativeTime = "unknown time";
    if (data.date) {
        const pastDate = new Date(data.date);
        relativeTime = formatVersionBadgeRelativeTime(pastDate);

        const diffMs = (Date.now() - pastDate.getTime());
        if (diffMs >= TIME_BEFORE_SHOWING_DATE && typeof formatDateOnly === "function") {
            relativeTime += ` (${formatDateOnly(pastDate.getTime())})`;
        }
    }

    let title = `Updated ${relativeTime}${data.message ? `\n"${data.message}"` : ""}`;
    if (data.isDeployed === false) {
        title += `\nSite hasn't finished deploying this version yet`;
    }
    badgeEl.title = title;
}

/** 
  Formats a historical Date object into a relative time string (e.g., "5min ago", "2d ago").

  @param {Date} pastDate - The historical date to compare against current time.
  @returns {string} Formatted relative time string.
*/
function formatVersionBadgeRelativeTime(pastDate) {
    const diffMs = Date.now() - pastDate.getTime();
    const diffSeconds = Math.max(0, diffMs / 1000);

    if (diffSeconds < 60) return `${Math.round(diffSeconds)}s ago`;

    const diffMinutes = diffSeconds / 60;
    if (diffMinutes < 60) return `${roundTo(diffMinutes, 1)}min ago`;

    const diffHours = diffMinutes / 60;
    if (diffHours < 24) return `${roundTo(diffHours, 1)}h ago`;

    const diffDays = diffHours / 24;
    if (diffDays < 30) return `${roundTo(diffDays, 1)}d ago`;

    const diffMonths = diffDays / 30;
    if (diffMonths < 12) return `${roundTo(diffMonths, 1)}mo ago`;

    const diffYears = diffMonths / 12;
    return `${roundTo(diffYears, 1)}y ago`;
}

/**
  Rounds a numeric value to a specified number of decimal places.

  @param {number} value - The numeric value to round.
  @param {number} decimalPlaces - Target count of decimal places.
  @returns {number} Value rounded to requested decimal places.
*/
function roundTo(value, decimalPlaces) {
    const scale = Math.pow(10, decimalPlaces);
    return Math.round(value * scale) / scale;
}

let versionToastHideTimeout = null;

/**
  Displays a temporary toast notification above the footer UI element.

  @param {string} text - Message content to display in the toast.
  @param {boolean} autoHide - Whether the toast auto-fades out after a timeout.
*/
function showVersionToast(text, autoHide) {
    const toast = document.getElementById("version-toast");
    if (!toast) return;

    toast.innerText = text;
    toast.classList.remove("hidden");
    void toast.offsetWidth; // Force reflow to re-trigger CSS transition
    toast.classList.add("visible");

    if (versionToastHideTimeout) clearTimeout(versionToastHideTimeout);
    if (autoHide) {
        versionToastHideTimeout = setTimeout(() => {
            toast.classList.remove("visible");
        }, 2500);
    }
}