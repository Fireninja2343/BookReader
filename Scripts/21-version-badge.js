/*
 GITHUB VERSION BADGE

 Shows a small "vX.Y.N" label (X.Y set manually below, N auto-derived from
 the repo's total commit count on the deployed branch) in the bottom-right
 corner, above #sign-in. Hovering shows a native tooltip with how long ago
 the latest commit landed and its message. Clicking the badge text forces
 an immediate re-check (bypassing the cache) and shows a small popup toast
 just above the footer while it does.

 Also checks whether the live GitHub Pages site is actually running that
 latest commit yet (deploys can lag 20s-1min+ behind the push) - if the
 site is still on an older commit, or the deploy is in progress/failed,
 the badge shows a plain "Outdated" / "Deploying..." state instead of
 pretending everything's current.

 To point this at a different repo/branch later (e.g. after a branch
 switch), only Config.VersionBadge in 00-config.js needs to change.
*/
const VERSION_BADGE_REPO_OWNER = Config.VersionBadge.REPO_OWNER;
const VERSION_BADGE_REPO_NAME = Config.VersionBadge.REPO_NAME;
const VERSION_BADGE_REPO_BRANCH = Config.VersionBadge.REPO_BRANCH;

// The "big version" set by hand in Config.
// Only that needs bumping for a deliberate version milestone
// the trailing commit-count number below takes care of the rest on its own.
const VERSION_BADGE_MAJOR_MINOR = Config.VersionBadge.MAJOR_MINOR;

const VERSION_BADGE_CACHE_KEY = Config.VersionBadge.CACHE_KEY;
// 15 min by default (see Config.VersionBadge.AUTO_REFRESH_MS) - about 4
// checks/hour on its own, leaving plenty of headroom under GitHub's 60/hour
// unauthenticated limit even with the manual button and multiple
// tabs/devices sharing the same network.
const VERSION_BADGE_AUTO_REFRESH_MS = Config.VersionBadge.AUTO_REFRESH_MS;
const VERSION_BADGE_CACHE_TTL_MS = Config.VersionBadge.CACHE_TTL_MS;
const MANUAL_REFRESH_COOLDOWN = Config.VersionBadge.MANUAL_REFRESH_COOLDOWN;
const TIME_BEFORE_SHOWING_DATE = Config.VersionBadge.TIME_BEFORE_SHOWING_DATE;

let versionBadgeRefreshInterval = null;
let refreshedAt = 0;

window.addEventListener("DOMContentLoaded", () => {
    initVersionBadge();
});

function initVersionBadge() {
    const badge = document.getElementById("app-version-badge");
    if (!badge) return;

    badge.addEventListener("click", () => refreshVersionBadge(true));

    // Show whatever's cached immediately (even if stale) so the badge
    // isn't blank while the first real fetch is in flight.
    const cached = readVersionBadgeCache();
    if (cached) renderVersionBadge(cached);

    refreshVersionBadge(false);

    if (versionBadgeRefreshInterval) clearInterval(versionBadgeRefreshInterval);
    versionBadgeRefreshInterval = setInterval(() => {
        refreshVersionBadge(false);
    }, VERSION_BADGE_AUTO_REFRESH_MS);
}

function readVersionBadgeCache() {
    try {
        const raw = localStorage.getItem(VERSION_BADGE_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function writeVersionBadgeCache(data) {
    try {
        localStorage.setItem(VERSION_BADGE_CACHE_KEY, JSON.stringify(data));
    } catch (e) {
        // Storage full or unavailable - badge just won't persist across reloads, non-fatal
    }
}

/*
 forceRefresh=true (the manual click path) always hits the network and
 shows the toast popup. forceRefresh=false (initial load / the auto-refresh
 interval) respects the cache TTL and stays silent.
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

        // "Deployed" only counts as true if the newest deployment's sha
        // actually matches the branch's newest commit AND that deployment's
        // last status was a success - a deployment record existing at all
        // just means one was attempted, not that it's live or that it succeeded.
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

/*
 GitHub doesn't expose a direct "total commit count" field, so this uses
 the well-known Link-header trick: requesting 1 commit per page and reading
 the page number of the "last" rel link gives the total commit count
 without paging through the whole history.
*/
async function fetchCommitCount() {
    const url = `https://api.github.com/repos/${VERSION_BADGE_REPO_OWNER}/${VERSION_BADGE_REPO_NAME}/commits?sha=${encodeURIComponent(VERSION_BADGE_REPO_BRANCH)}&per_page=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

    const linkHeader = res.headers.get("Link");
    if (!linkHeader) {
        // No Link header means there's only one page of results - i.e. exactly one commit
        return 1;
    }

    const lastLinkMatch = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (lastLinkMatch) return parseInt(lastLinkMatch[1], 10);

    return 1;
}

/*
 Checks whether the live GitHub Pages site is actually caught up to the
 branch's latest commit. A deployment record merely existing only means
 GitHub attempted a deploy for that sha at some point - it says nothing
 about whether that deploy actually finished successfully, so the
 newest deployment's status has to be checked too (its most recent
 status entry's "state" field, e.g. "success"/"failure"/"in_progress").
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

    // Statuses are returned newest-first.
    const latestState = Array.isArray(statuses) && statuses.length > 0 ? statuses[0].state : "unknown";

    return { sha: latestDeployment.sha, state: latestState };
}

function renderVersionBadge(data) {
    const textEl = document.getElementById("app-version-badge-text");
    const badgeEl = document.getElementById("app-version-badge");
    if (!textEl || !badgeEl) return;

    if (data.isDeployed === false) {
        // Distinguish "a deploy is actively running" from "nothing has been
        // triggered yet / it failed" isn't reliable from state alone in every
        // case, so this keeps the message intentionally generic rather than
        // guessing - either way, the site isn't caught up to the latest commit yet.
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

// Small self-contained relative-time formatter (not reused from elsewhere
// in the codebase, since this module has no dependency on load order
// beyond the DOM/config already present at DOMContentLoaded).
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

// Rounds to a given number of decimal places. Math.round() has no
// decimal-places argument, so this is the standard scale-round-unscale approach.
function roundTo(value, decimalPlaces) {
    const scale = Math.pow(10, decimalPlaces);
    return Math.round(value * scale) / scale;
}

let versionToastHideTimeout = null;
function showVersionToast(text, autoHide) {
    const toast = document.getElementById("version-toast");
    if (!toast) return;

    toast.innerText = text;
    toast.classList.remove("hidden");
    // Force a reflow so the "visible" class transition actually plays when
    // re-triggered back-to-back (e.g. "updating..." immediately followed by "updated")
    void toast.offsetWidth;
    toast.classList.add("visible");

    if (versionToastHideTimeout) clearTimeout(versionToastHideTimeout);
    if (autoHide) {
        versionToastHideTimeout = setTimeout(() => {
            toast.classList.remove("visible");
        }, 2500);
    }
}