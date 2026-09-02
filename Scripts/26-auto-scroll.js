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
/** Params the currently-running scroll loop was started with - read by stopScroll()/updateBar() so they don't need their own parameters. */
let activeScrollParams = null;

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

const toggleScrollBtn = document.getElementById("btn-toggle-scroll");
/**
 Starts the autoscroll timer loop, advancing the reader container by a
 caller-supplied step on each tick and animating the progress bar fill.
 Generic engine shared by the word-density autoscroll (toggleScroll(),
 default params below) and audio-sync auto-scroll (25-audio-sync.js,
 which calls this directly with its own step/cooldown/color) - both are
 delta-based (scrollBy), just driven by different step logic.

 @param {Object} [params] - Overrides for this run. Omit entirely for the
   default word-density behavior.
 @param {() => number} [params.getStepPx] - Returns the pixel delta to scrollBy() each tick. Defaults to computeAdaptiveStepPx().
 @param {() => number} [params.getCooldownMs] - Returns ms between ticks. Defaults to the existing #setting-scroll-delay-based getCooldownMs().
 @param {string} [params.colorVar] - CSS var for the fill's glow color. Defaults to "--accent".
 @param {string} [params.glowVar] - CSS var for the fill's box-shadow color. Defaults to "--glow".
*/
function startScroll(params) {
  activeScrollParams = {
    getStepPx: params?.getStepPx ?? computeAdaptiveStepPx,
    getCooldownMs: params?.getCooldownMs ?? getCooldownMs,
    colorVar: params?.colorVar ?? "--accent",
    glowVar: params?.glowVar ?? "--glow",
  };
  toggleScrollBtn.classList.add("active");
  lastScrollTime = Date.now();
  fill.style.width = "100%";
  interval = setInterval(() => {
    if (!activeScrollParams) {
        // Params were cleared (e.g., stopScroll called) but interval still running – clean up.
        clearInterval(interval);
        interval = null;
        return;
    }
    document.getElementById("reader-container").scrollBy(0, activeScrollParams.getStepPx());
    lastScrollTime = Date.now();
  }, activeScrollParams.getCooldownMs());
  fill.style.background = `var(${activeScrollParams.colorVar})`;
  fill.style.boxShadow = `0 0 3px 5px var(${activeScrollParams.glowVar})`;
  requestAnimationFrame(updateBar);
}

/**
 Stops the currently-running scroll loop: clears the interval timer and
 resets the progress bar's visual styling. Does NOT touch `enabled` -
 callers own their own state flag (this file's toggleScroll() sets enabled
 itself around its calls; 25-audio-sync.js keeps its own separate flag) so
 stopping one loop can never accidentally flip the other caller's state.
*/
function stopScroll() {
  clearInterval(interval);
  fill.style.boxShadow = "none";
  fill.style.background = "";
  fill.style.width = "100%";
  interval = null;
  activeScrollParams = null;
  toggleScrollBtn.classList.remove("active");
}

/**
 Toggles autoscroll state between active and inactive. Always uses the
 default word-density params - audio-sync starts/stops its own loop
 directly via startScroll()/stopScroll() rather than through this toggle,
 since it has its own enable condition (audio playing + paired) instead of
 a simple on/off.
 */
function toggleScroll() {
  enabled = !enabled;

  if (enabled) startScroll();
  else stopScroll();
}

/**
 Updates progress bar width via requestAnimationFrame to show time remaining
 until next scroll tick. Driven by the shared mechanical state (interval/
 activeScrollParams), not the word-density enabled flag, so this keeps
 running correctly whichever caller (word-density or audio-sync) started
 the loop.
*/
function updateBar() {
  if (!interval || !activeScrollParams) return;

  const now = Date.now();
  const cooldownMs = activeScrollParams.getCooldownMs();
  const remaining = Math.max(0, cooldownMs - (now - lastScrollTime));
  const pct = remaining / cooldownMs;

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

/** Stops word-density autoscroll on general keyboard interaction (excluding
    arrow keys and Ctrl+D). Guarded by enabled - audio-sync auto-scroll
    (25-audio-sync.js) runs through this same startScroll()/stopScroll()
    engine but keeps its own separate enable state, and per design only
    stopping audio playback (not keyboard input) should end that one. */
document.addEventListener("keydown", (e) => {
  if (!enabled) return;
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    return;
  }
  if (e.ctrlKey && e.key === "d") {
    return; // Already handled above — avoids immediately re-toggling
  }

  stopScroll();
});