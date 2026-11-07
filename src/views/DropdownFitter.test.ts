// @vitest-environment jsdom
import { DropdownComponent } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { DropdownComponent as ObsidianDropdown } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropdownFitter } from './DropdownFitter';

// #region HELPERS

const FITTED_WIDTH = '--dropdown-fitted-width';
const NODE_INSERT_EVENT = 'node-insert-event';

interface Option {
  value: string;
  text: string;
}

/** What a scenario's dropdown holds, and whether it's in the document. */
interface DropdownSpec {
  options: Option[];
  connected: boolean;
}

/** The width a dropdown out of the document measures any text at. */
const DETACHED_WIDTH = '0px';

/**
 * A dropdown built as Obsidian builds one (read from obsidian.asar 1.14.5):
 * its select marked to be fitted again once first drawn, and a `setValue`
 * that selects the first option holding the value, or none, and, if one is
 * selected, measures that option's text and sets the width it measured as
 * `--dropdown-fitted-width` on the select. `fitsWidth` false stands for a
 * build without that variable, which measures nothing. `measure` gives the
 * width of a text at the moment it's measured in the document; out of it,
 * nothing is laid out, so every text measures {@link DETACHED_WIDTH}.
 * `insert` puts it in the document, where a dropdown still marked is fitted
 * again and unmarked, as once drawn.
 */
function makeDropdown(
  { options, connected }: DropdownSpec,
  fitsWidth: boolean,
  measure: (text: string) => string
) {
  const container = document.createElement('div');
  if (connected) document.body.append(container);
  const dropdown = new DropdownComponent(container);
  const { selectEl } = dropdown;
  selectEl.classList.add(NODE_INSERT_EVENT);
  for (const { value, text } of options) dropdown.addOption(value, text);
  const counts = { setValue: 0, measures: 0 };
  const resizeToFit = () => {
    const selected = selectEl.options[selectEl.selectedIndex];
    if (!selected || !fitsWidth) return;
    counts.measures++;
    selectEl.style.setProperty(
      FITTED_WIDTH,
      selectEl.isConnected ? measure(selected.text) : DETACHED_WIDTH
    );
  };
  vi.spyOn(dropdown, 'setValue').mockImplementation((value) => {
    counts.setValue++;
    selectEl.value = value;
    resizeToFit();
    return dropdown;
  });
  const insert = () => {
    if (container.isConnected) return;
    document.body.append(container);
    if (!selectEl.classList.contains(NODE_INSERT_EVENT)) return;
    selectEl.classList.remove(NODE_INSERT_EVENT);
    resizeToFit();
  };
  return {
    dropdown: dropdown as unknown as ObsidianDropdown,
    selectEl,
    counts,
    insert,
  };
}

/**
 * One thing done to the dropdowns: a show, a zoom, putting one in the
 * document, or a batch of steps.
 */
type Step =
  | { kind: 'show'; dropdown: number; value: string }
  | { kind: 'zoom'; by: number }
  | { kind: 'insert'; dropdown: number }
  | { kind: 'batch'; steps: Step[] };

/** A value to show: often one of a dropdown's own options, else any text. */
const valueArb = (options: readonly Option[]) =>
  options.length > 0
    ? fc.oneof(
        fc.constantFrom(...options.map(({ value }) => value)),
        fc.string()
      )
    : fc.string();

const optionArb: fc.Arbitrary<Option> = fc.record({
  value: fc.oneof(fc.constantFrom('', 'a', 'b'), fc.string()),
  text: fc.oneof(fc.constantFrom('', 'A', 'B', ' A '), fc.string()),
});

const dropdownSpecArb: fc.Arbitrary<DropdownSpec> = fc.record({
  options: fc.array(optionArb, { maxLength: 4 }),
  connected: fc.boolean(),
});

/** Several dropdowns, each with its options, and steps on them. */
const scenarioArb = fc
  .array(dropdownSpecArb, { minLength: 1, maxLength: 4 })
  .chain((dropdowns) => {
    const show = fc
      .nat({ max: dropdowns.length - 1 })
      .chain((dropdown) =>
        valueArb(dropdowns[dropdown].options).map(
          (value): Step => ({ kind: 'show', dropdown, value })
        )
      );
    const zoom = fc
      .integer({ min: 1, max: 5 })
      .map((by): Step => ({ kind: 'zoom', by }));
    const insert = fc
      .nat({ max: dropdowns.length - 1 })
      .map((dropdown): Step => ({ kind: 'insert', dropdown }));
    // Synchronous, so nothing zooms or is drawn during a batch
    const inner = fc.array(show, { maxLength: 6 });
    const nested = fc.array(
      fc.oneof(
        show,
        inner.map((steps): Step => ({ kind: 'batch', steps }))
      ),
      { maxLength: 6 }
    );
    const batch = nested.map((steps): Step => ({ kind: 'batch', steps }));
    return fc.record({
      dropdowns: fc.constant(dropdowns),
      fitsWidth: fc.boolean(),
      steps: fc.array(fc.oneof(show, zoom, insert, batch), { maxLength: 12 }),
    });
  });

/**
 * What each dropdown is meant to show. A value it already shows (an option
 * selected, holding it) is left as it is once it was shown once; any other
 * selects the first option holding it, or none, and is fitted at the width
 * that option's text measures where the dropdown is, or keeps the width it
 * had if none is selected or the build fits no width. In a batch, nested
 * ones included, each text is measured once in the document, a text not
 * yet measured along with every other its dropdown can show; out of the
 * document, every time. A dropdown shown in the document is no longer marked to be
 * fitted again once drawn; one still marked is, once put in the document.
 */
class Model {
  readonly selected: number[];
  readonly widths: string[];
  readonly shown: boolean[];
  readonly marked: boolean[];
  readonly connected: boolean[];
  measures = 0;
  zoom = 1;
  #measured: Set<string> | null = null;

  constructor(
    readonly dropdowns: readonly DropdownSpec[],
    readonly fitsWidth: boolean,
    /** Each option's text as the select reads it, whitespace collapsed. */
    readonly texts: readonly (readonly string[])[]
  ) {
    this.selected = dropdowns.map(({ options }) =>
      options.length > 0 ? 0 : -1
    );
    this.widths = dropdowns.map(() => '');
    this.shown = dropdowns.map(() => false);
    this.marked = dropdowns.map(() => true);
    this.connected = dropdowns.map(({ connected }) => connected);
  }

  measure = (text: string) => `${text.length * 7 + this.zoom}px`;

  show(d: number, value: string) {
    const { options } = this.dropdowns[d];
    const current = this.selected[d];
    if (this.shown[d] && current !== -1 && options[current].value === value)
      return;
    this.shown[d] = true;
    if (this.connected[d]) this.marked[d] = false;
    this.selected[d] = options.findIndex((option) => option.value === value);
    const index = this.selected[d];
    if (index === -1 || !this.fitsWidth) return;
    if (!this.connected[d]) {
      this.widths[d] = DETACHED_WIDTH;
      this.measures++;
      return;
    }
    const text = this.texts[d][index];
    this.widths[d] = this.measure(text);
    const measured = this.#measured;
    if (!measured) {
      this.measures++;
      return;
    }
    if (measured.has(text)) return;
    // Every text the dropdown can show, each by the first option holding
    // its value
    const values = new Set<string>();
    options.forEach((option, i) => {
      if (values.has(option.value)) return;
      values.add(option.value);
      if (measured.has(this.texts[d][i])) return;
      measured.add(this.texts[d][i]);
      this.measures++;
    });
  }

  insert(d: number) {
    if (this.connected[d]) return;
    this.connected[d] = true;
    if (!this.marked[d]) return;
    this.marked[d] = false;
    const index = this.selected[d];
    if (index === -1 || !this.fitsWidth) return;
    this.widths[d] = this.measure(this.texts[d][index]);
    this.measures++;
  }

  batch(run: () => void) {
    const outer = this.#measured;
    this.#measured ??= new Set();
    try {
      run();
    } finally {
      this.#measured = outer;
    }
  }
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('DropdownFitter', () => {
  it('leaves each dropdown showing the value last shown, fitted to it as Obsidian would, measuring each text once per batch, all a dropdown holds at its first unmeasured one', () => {
    fc.assert(
      fc.property(scenarioArb, ({ dropdowns, fitsWidth, steps }) => {
        document.body.replaceChildren();
        // `measure` reads the model's zoom, which zoom steps change
        let model: Model | null = null;
        const made = dropdowns.map((spec) =>
          makeDropdown(spec, fitsWidth, (text) => model!.measure(text))
        );
        model = new Model(
          dropdowns,
          fitsWidth,
          made.map(({ selectEl }) =>
            Array.from(selectEl.options, (option) => option.text)
          )
        );
        const fitter = new DropdownFitter();
        const run = (step: Step) => {
          if (step.kind === 'zoom') {
            model.zoom += step.by;
          } else if (step.kind === 'insert') {
            made[step.dropdown].insert();
            model.insert(step.dropdown);
          } else if (step.kind === 'batch') {
            fitter.batch(() =>
              model.batch(() => {
                for (const inner of step.steps) run(inner);
              })
            );
          } else {
            fitter.show(made[step.dropdown].dropdown, step.value);
            model.show(step.dropdown, step.value);
          }
          made.forEach(({ selectEl }, d) => {
            expect(selectEl.selectedIndex).toBe(model.selected[d]);
            expect(selectEl.style.getPropertyValue(FITTED_WIDTH)).toBe(
              model.widths[d]
            );
            expect(selectEl.classList.contains(NODE_INSERT_EVENT)).toBe(
              model.marked[d]
            );
          });
          expect(
            made.reduce((sum, { counts }) => sum + counts.measures, 0)
          ).toBe(model.measures);
        };
        for (const step of steps) run(step);
      })
    );
  });

  it('never calls setValue to show the value a dropdown already shows', () => {
    fc.assert(
      fc.property(
        dropdownSpecArb.filter(({ options }) => options.length > 0),
        fc.boolean(),
        fc.nat(),
        fc.boolean(),
        (spec, fitsWidth, pick, inBatch) => {
          const { dropdown, counts } = makeDropdown(
            spec,
            fitsWidth,
            () => '10px'
          );
          const { value } = spec.options[pick % spec.options.length];
          const fitter = new DropdownFitter();
          fitter.show(dropdown, value);
          const before = counts.setValue;
          if (inBatch) fitter.batch(() => fitter.show(dropdown, value));
          else fitter.show(dropdown, value);
          expect(counts.setValue).toBe(before);
        }
      )
    );
  });

  it("answers what the batch's build returns", () => {
    fc.assert(
      fc.property(fc.anything(), (result) => {
        expect(new DropdownFitter().batch(() => result)).toBe(result);
      })
    );
  });

  it('measures a text afresh in the document after a batch measured it out of the document', () => {
    const options = [{ value: 'a', text: 'A' }];
    const detached = makeDropdown(
      { options, connected: false },
      true,
      () => '10px'
    );
    const attached = makeDropdown(
      { options, connected: true },
      true,
      () => '10px'
    );
    const fitter = new DropdownFitter();
    fitter.batch(() => {
      fitter.show(detached.dropdown, 'a');
      fitter.show(attached.dropdown, 'a');
    });
    expect(attached.selectEl.style.getPropertyValue(FITTED_WIDTH)).toBe('10px');
    expect(attached.counts.measures).toBe(1);
  });

  it('forgets the widths a batch measured once its build throws', () => {
    const options = [
      { value: 'a', text: 'A' },
      { value: 'b', text: 'B' },
    ];
    const first = makeDropdown(
      { options, connected: true },
      true,
      () => '10px'
    );
    const second = makeDropdown(
      { options, connected: true },
      true,
      () => '20px'
    );
    const fitter = new DropdownFitter();
    const error = new Error('build failed');
    expect(() =>
      fitter.batch(() => {
        fitter.show(first.dropdown, 'b');
        throw error;
      })
    ).toThrow(error);
    fitter.show(second.dropdown, 'b');
    expect(second.selectEl.style.getPropertyValue(FITTED_WIDTH)).toBe('20px');
    expect(second.counts.measures).toBe(1);
  });
});
