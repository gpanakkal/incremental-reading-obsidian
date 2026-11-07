import type { DropdownComponent } from 'obsidian';

/**
 * The variable Obsidian's `DropdownComponent` sizes its select by, set inline
 * on it each time it measures (undocumented, read from obsidian.asar 1.14.5;
 * see styles.css).
 */
const FITTED_WIDTH = '--dropdown-fitted-width';

/**
 * The class by which Obsidian hears of an element first being drawn: an
 * animation it starts calls back once (`HTMLElement.onNodeInserted`), and
 * then it leaves (undocumented, read from obsidian.asar 1.14.5).
 */
const NODE_INSERT_EVENT = 'node-insert-event';

/**
 * Shows values in `DropdownComponent`s without the layouts their own
 * `setValue` forces. Obsidian's `setValue` fits the select to the option it
 * shows by writing that option's text into a hidden twin select and reading
 * the twin's width back, which lays the page out anew whenever anything
 * changed since the last layout; and each dropdown fits itself again, the
 * same way, once it is first drawn. Over a list built or updated a line at a
 * time, that is a layout or two per line.
 *
 * So a dropdown already showing the value is left alone, and one shown while
 * in the document is not fitted again once drawn, as its width is already
 * right. In a {@link batch}, each option text is measured once, the width set
 * on every other dropdown showing the same text: the dropdowns shown in a
 * batch must be laid out alike, as one list's are. A text not yet measured
 * is measured along with every other text its dropdown holds, as each
 * measure lays out the list as built so far, which is shortest then: fit for
 * dropdowns of a few options each.
 */
export class DropdownFitter {
  /** The dropdowns shown so far, which hold a width fitted to their value. */
  readonly #shown = new WeakSet<DropdownComponent>();
  /** Within a batch, the width measured for each option text. */
  #widths: Map<string, string> | null = null;

  /**
   * Show `value` in `dropdown`, fitted to it as its `setValue` would, unless
   * it already shows that value.
   */
  show(dropdown: DropdownComponent, value: string): void {
    const { selectEl } = dropdown;
    if (
      this.#shown.has(dropdown) &&
      selectEl.selectedIndex !== -1 &&
      selectEl.value === value
    ) {
      return;
    }
    this.#shown.add(dropdown);
    // Measured in the document, its width holds once it's drawn. Dropped
    // before the measuring below lays anything out, or the animation would
    // already have begun. Out of it, nothing is laid out, so it measures 0
    // and is fitted again once drawn; a batch neither lends it a width nor
    // takes that 0 from it
    const connected = selectEl.isConnected;
    if (connected) selectEl.classList.remove(NODE_INSERT_EVENT);
    const widths = connected ? this.#widths : null;
    const text = Array.from(selectEl.options).find(
      (option) => option.value === value
    )?.text;
    if (text === undefined) {
      dropdown.setValue(value);
      return;
    }
    if (widths && !widths.has(text)) measureAll(dropdown, widths);
    const width = widths?.get(text);
    if (width) {
      selectEl.value = value;
      selectEl.style.setProperty(FITTED_WIDTH, width);
      return;
    }
    dropdown.setValue(value);
  }

  /**
   * Run `build`, which shows values through {@link show} in dropdowns laid
   * out alike, measuring each option text once; answers what it does. A
   * batch run inside another is part of it.
   */
  batch<T>(build: () => T): T {
    const outer = this.#widths;
    this.#widths ??= new Map();
    try {
      return build();
    } finally {
      this.#widths = outer;
    }
  }
}

/**
 * Measure each text `dropdown` can show that `widths` lacks, by its own
 * `setValue`, into `widths`. A text no width is read back for is kept as
 * `''`, so it isn't measured again, and its dropdowns fall back on their own
 * `setValue`.
 */
function measureAll(
  dropdown: DropdownComponent,
  widths: Map<string, string>
): void {
  const { selectEl } = dropdown;
  /** The values met so far: only the first option holding one can show. */
  const values = new Set<string>();
  for (const option of Array.from(selectEl.options)) {
    if (values.has(option.value)) continue;
    values.add(option.value);
    if (widths.has(option.text)) continue;
    // Or a build that fits later, or not at all, would leave the width the
    // last text measured, to be read back as this one's
    selectEl.style.removeProperty(FITTED_WIDTH);
    dropdown.setValue(option.value);
    widths.set(option.text, selectEl.style.getPropertyValue(FITTED_WIDTH));
  }
}
