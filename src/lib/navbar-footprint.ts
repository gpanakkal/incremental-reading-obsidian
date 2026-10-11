/**
 * Keep the mobile navbar's footprint — its height plus its bottom margin, the
 * distance it takes up above the bottom edge, never below 0 — on <body> as
 * `--ir-mobile-toolbar-height`, for styles.css to clear it by.
 *
 * Returns a function that stops following the navbar and takes the property
 * back off <body>.
 */
export function trackNavbarFootprint(navbar: HTMLElement): () => void {
  const body = navbar.ownerDocument.body;
  // Declared in here rather than at module level so that Stryker's mutants of
  // it are switched per test run instead of once at import.
  const prop = '--ir-mobile-toolbar-height';
  const measure = () => {
    const { height } = navbar.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(navbar).marginBottom) || 0;
    // A keyboard can pull the floating navbar's margin far below zero (its
    // margin subtracts `--keyboard-height`), which would read as a navbar
    // taking up less than no room and drag the bars off the bottom of the view.
    body.style.setProperty(prop, `${Math.max(0, height + margin)}px`);
  };

  const observer = new ResizeObserver(measure);
  observer.observe(navbar);
  // Obsidian animates the navbar's bottom margin (`.mobile-navbar` transitions
  // `margin-bottom`), and switching floating navigation on moves it from 0 to
  // above the safe area while the navbar shrinks. The resize is reported
  // mid-animation, with the margin still on its way, and the margin settling
  // resizes nothing — so the end of each transition is measured again too.
  navbar.addEventListener('transitionend', measure);
  measure();

  return function stopTrackingNavbarFootprint() {
    observer.disconnect();
    navbar.removeEventListener('transitionend', measure);
    body.style.removeProperty(prop);
  };
}
