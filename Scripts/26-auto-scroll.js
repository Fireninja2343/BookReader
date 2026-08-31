// =================================================================
// ADAPTIVE AUTO-SCROLLER
// =================================================================
let enabled = false;
const AUTOSCROLL_DEBUG = Config.AutoScroller.AUTOSCROLL_DEBUG;

// MIN/MAX_STEP_PX bound computeAdaptiveStepPx() below so an all-image
// screen (0 measurable words) or one giant word can't produce a step
// that's far too small or large.
const MIN_STEP_PX = Config.AutoScroller.MIN_STEP_PX;
const MAX_STEP_PX = Config.AutoScroller.MAX_STEP_PX;
const FALLBACK_STEP_PX = Config.AutoScroller.FALLBACK_STEP_PX; // used if no visible words can be measured

// Roughly how many words should scroll past per tick at default speed.
// The speed slider only changes the delay between ticks (getCooldownMs).
const TARGET_WORDS_PER_TICK = Config.AutoScroller.TARGET_WORDS_PER_TICK;

function getCooldownMs() {
  return Number(document.getElementById("setting-scroll-delay").value) *1000;
}
/**
 Counts the number of visible words inside the reader viewport by walking text nodes.
 @returns {number}
 */
function countVisibleWords() {
  const container = document.getElementById("reader-container");
  const frame = document.getElementById("text-render-frame");
  if (!container || !frame) return 0;

  const containerRect = container.getBoundingClientRect();
  const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  let words = 0;
  let node;

  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text.trim()) continue;

    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();

    const isVisible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
    if (isVisible) {
      words += text.trim().split(/\s+/).filter(Boolean).length;
    }
  }

  return words;
}

/**
 Converts visible-word density into a per-tick pixel step.
 pixelsPerWord shrinks on dense pages (small text/ tight spacing) and grows on sparse ones,
 so scrolling `TARGET_WORDS_PER_TICK` worth of words always takes about the same reading time regardless of layout.
 @returns {number}
 */
function computeAdaptiveStepPx() {
  const container = document.getElementById("reader-container");
  if (!container) return FALLBACK_STEP_PX;

  const visibleHeight = container.clientHeight;
  const visibleWords = countVisibleWords();

  if (!visibleWords || !visibleHeight) {
    if (AUTOSCROLL_DEBUG) {
      console.log(`[AutoScroll] no visible words detected (visibleWords=${visibleWords},
         visibleHeight=${visibleHeight}) — using fallback step of ${FALLBACK_STEP_PX}px`);
    }
    return FALLBACK_STEP_PX;
  }

  const wordsPerPixel = visibleWords / visibleHeight;
  const pixelsPerWord = 1 / wordsPerPixel;
  const idealStep = TARGET_WORDS_PER_TICK * pixelsPerWord;
  const clampedStep = Math.min(MAX_STEP_PX, Math.max(MIN_STEP_PX, idealStep));

  if (AUTOSCROLL_DEBUG) {
    console.log(
      `[AutoScroll] visible words=${visibleWords} in ${visibleHeight}px ` +
      `→ ${pixelsPerWord.toFixed(2)}px/word ` +
      `→ ideal step=${idealStep.toFixed(1)}px ` +
      (clampedStep !== idealStep ? `→ CLAMPED to ${clampedStep.toFixed(1)}px` : `→ using ${clampedStep.toFixed(1)}px`)
    );
  }

  return clampedStep;
}

let lastScrollTime = 0;
let interval = null;
const fill = document.getElementById("fill");
/**
 Re-initializes autoscroll with updated speed or delay settings when input changes.
 */
function applySpeedChange() {
  if (!enabled) return;
  clearInterval(interval);
  toggleScroll();
  toggleScroll();
}
document.getElementById("setting-scroll-delay").addEventListener("input", applySpeedChange);

/**
 Starts autoscroll timer loop, advances reader container, and initializes progress bar animation.
 */
function startScroll() {
  lastScrollTime = Date.now();
  fill.style.width = "100%";
  interval = setInterval(() => {
    document.getElementById("reader-container").scrollBy(0, computeAdaptiveStepPx());

    lastScrollTime = Date.now();
  }, getCooldownMs());
  fill.style.boxShadow = "0 0 3px 5px var(--accent)";
  requestAnimationFrame(updateBar);
}

/**
 Stops autoscroll, clears interval timer, and resets progress bar visual styling.
 */
function stopScroll() {
  clearInterval(interval);
  fill.style.boxShadow = "none";
  fill.style.width = "100%";
  interval = null;
  enabled = false;
}

/**
 Toggles autoscroll state between active and inactive.
 */
function toggleScroll() {
  enabled = !enabled;

  if (enabled) startScroll();
  else stopScroll();
}

/**
 Updates progress bar width via requestAnimationFrame to show time remaining until next scroll tick.
 */
function updateBar() {
  if (!enabled) return;

  const now = Date.now();
  const remaining = Math.max(0, getCooldownMs() - (now - lastScrollTime));
  const pct = remaining / getCooldownMs();

  fill.style.width = (pct * 100) + "%";

  requestAnimationFrame(updateBar);
}

/** Toggles autoscroll when Ctrl+D shortcut is pressed. */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "d") {
    e.preventDefault();
    toggleScroll();
  }
});

/** Stops autoscroll on general keyboard interaction (excluding arrow keys and Ctrl+D). */
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    return;
  }
  if (e.ctrlKey && e.key === "d") {
    return; // Already handled above — avoids immediately re-toggling
  }

  stopScroll();
});