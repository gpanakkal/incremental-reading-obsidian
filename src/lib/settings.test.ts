// @vitest-environment jsdom
import type IncrementalReadingPlugin from '#/main';
import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  App,
  SettingControl as DeclaredControl,
  SettingDefinitionItem,
} from 'obsidian';
import type { StepUnit } from 'ts-fsrs';
import { describe, expect, it, vi } from 'vitest';
// The mock is what `obsidian` resolves to at runtime (see vitest.config.ts);
// imported by path for its writable `Platform`.
import { Platform } from '#/test/__mocks__/obsidian';
import {
  DATA_DIRECTORY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
} from './constants';
import type { IRPluginData } from './plugin-data';
import {
  DEFAULT_SETTINGS,
  formatPriority,
  formatRetention,
  formatRolloverHour,
  IRSettingTab,
  parseSteps,
  REVIEW_TITLE_BAR_OPTIONS,
  SETTINGS_TAB_CLASS,
  SUCCESS_NOTICE_LEVEL_OPTIONS,
  type IRPluginSettings,
} from './settings';

// #region HELPERS

const STEP_PATTERN = /^[1-9]\d*[mhd]$/;

/** Each review title bar choice, as stored. */
const REVIEW_TITLE_BARS = ['obsidian', 'show', 'hide'] as const;

/** Each success notice level, as stored. */
const SUCCESS_NOTICE_LEVELS = ['all', 'minimal', 'none'] as const;

/** Any text at all, not just the printable ASCII `fc.string()` defaults to. */
const textArb = (constraints: fc.StringConstraints = {}) =>
  fc.string({ unit: 'binary', ...constraints });

/** A well-formed step: a whole number of at least 1, no leading zero, then a unit. */
const stepArb = fc
  .tuple(
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.constantFrom('m', 'h', 'd')
  )
  .map(([count, unit]): StepUnit => `${count}${unit}`);

/** Whatever `String.prototype.trim` strips, which is what `\s` matches. */
const paddingArb = fc.stringMatching(/^\s{0,3}$/);

/** A comma-free field segment that is not a step, even once trimmed. */
const malformedStepArb = fc
  .oneof(
    textArb(),
    fc.constantFrom('0m', '01m', '1', 'm', '1s', '1.5h', '-1d', '1 m', '1M'),
    fc.tuple(textArb({ minLength: 1 }), stepArb).map(([a, b]) => a + b),
    fc.tuple(stepArb, textArb({ minLength: 1 })).map(([a, b]) => a + b)
  )
  .filter(
    (segment) => !segment.includes(',') && !STEP_PATTERN.test(segment.trim())
  );

/** Steps as typed into the field: any padding around each one. */
const typedStepsArb = (steps: fc.Arbitrary<string[]>) =>
  steps.chain((segments) =>
    fc
      .array(fc.tuple(paddingArb, paddingArb), {
        minLength: segments.length,
        maxLength: segments.length,
      })
      .map((pads) =>
        segments
          .map((segment, i) => pads[i][0] + segment + pads[i][1])
          .join(',')
      )
  );

/**
 * Settings as `loadSettings` can leave them. Stored values are whatever
 * `data.json` holds, so they aren't held to the ranges the controls allow, and
 * `fsrsParams` may be the frozen default a fresh install starts from.
 */
const settingsArb = fc.record({
  settings: fc.record({
    defaultPriority: fc.double(),
    showImportDialog: fc.boolean(),
    copyOnImport: fc.boolean(),
    createEmptyInCurrentFolder: fc.boolean(),
    dayRolloverOffset: fc.integer(),
    showAdvancedImportCommands: fc.boolean(),
    showAdvancedImportMenuItems: fc.boolean(),
    fuzzTextReviews: fc.boolean(),
    skipHomeScreen: fc.boolean(),
    reviewTitleBar: fc.constantFrom(...REVIEW_TITLE_BARS),
    showGradeIntervals: fc.boolean(),
    successNoticesInReview: fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
    successNoticesOutsideReview: fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
    reviewReminders: fc.boolean(),
    remindDueArticles: fc.boolean(),
    remindDueSnippets: fc.boolean(),
    fsrsParams: fc.record({
      request_retention: fc.double(),
      maximum_interval: fc.integer(),
      w: fc.array(fc.double()),
      enable_fuzz: fc.boolean(),
      enable_short_term: fc.boolean(),
      learning_steps: fc.array(stepArb),
      relearning_steps: fc.array(stepArb),
    }),
  }),
  frozenFsrsParams: fc.boolean(),
});

type GeneratedSettings =
  typeof settingsArb extends fc.Arbitrary<infer T> ? T : never;

/** A private copy of a generated case, which tests are free to write to. */
function buildSettings({
  settings,
  frozenFsrsParams,
}: GeneratedSettings): IRPluginSettings {
  const copy = structuredClone(settings);
  if (frozenFsrsParams) Object.freeze(copy.fsrsParams);
  return copy;
}

/**
 * A plugin holding `settings` as its half of `data.json`, recording a snapshot
 * of that whole file on each save and each extra-hotkeys toggle it is asked for.
 */
function makeTab(settings: IRPluginSettings) {
  const data: IRPluginData = {
    settings,
    session: { deviceId: 'device-a', itemId: 'item-1' },
    warnedRefusedPaths: ['a|b.md'],
  };
  const saved: IRPluginData[] = [];
  const events: string[] = [];
  const plugin = {
    data,
    settings,
    saveSettings: vi.fn(() => {
      saved.push(structuredClone(data));
      events.push('save');
      return Promise.resolve();
    }),
    toggleAdvancedCommands: vi.fn((enable: boolean) => {
      events.push(`toggle:${enable}`);
    }),
    syncReviewTitleBars: vi.fn(() => {
      events.push(`title-bars:${settings.reviewTitleBar}`);
    }),
  };
  const tab = new IRSettingTab(
    {} as App,
    plugin as unknown as IncrementalReadingPlugin
  );
  return { tab, plugin, saved, events };
}

type ControlDefinition = {
  heading: string;
  name: string;
  desc?: string | DocumentFragment;
  control: DeclaredControl;
};

/** Each control definition, under its group's heading. Fails on anything else. */
function declaredRows(items: SettingDefinitionItem[]): ControlDefinition[] {
  return items.flatMap((item) => {
    if (!('type' in item) || item.type !== 'group') {
      throw new Error(`Expected a group, got ${JSON.stringify(item)}`);
    }
    return (item.items ?? []).map((definition) => {
      if (!('control' in definition) || !definition.control) {
        throw new Error(
          `Expected a control, got ${JSON.stringify(definition)}`
        );
      }
      return {
        heading: item.heading ?? '',
        name: definition.name,
        desc: definition.desc,
        control: definition.control,
      };
    });
  });
}

/**
 * The declarative tab's controls, which don't depend on the settings' values.
 * Read when a test runs, never at import: a suite that fails to load reports no
 * failing test, so Stryker would score a broken tab as a surviving mutant.
 */
const declaredControls = () =>
  declaredRows(
    makeTab(structuredClone(DEFAULT_SETTINGS)).tab.getSettingDefinitions()
  );

/** Any typed steps field: well-formed, with a malformed step, or anything. */
const typedFieldArb = fc.oneof(
  typedStepsArb(fc.array(stepArb)),
  typedStepsArb(
    fc
      .tuple(fc.array(stepArb), malformedStepArb, fc.array(stepArb))
      .map(([before, bad, after]) => [...before, bad, ...after])
  ),
  textArb()
);

/** One user edit to the setting in row `row`, as the value its control hands over. */
function editArb(
  rows: ControlDefinition[],
  row: number
): fc.Arbitrary<{ row: number; value: unknown }> {
  const { control } = rows[row];
  const edit = (arb: fc.Arbitrary<unknown>) =>
    arb.map((value) => ({ row, value }));

  switch (control.type) {
    case 'toggle':
      return edit(fc.boolean());
    case 'slider':
      return edit(
        fc.double({ min: control.min, max: control.max, noNaN: true })
      );
    case 'number':
      return edit(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }));
    case 'text':
      return edit(typedFieldArb);
    case 'dropdown':
      return edit(fc.constantFrom(...Object.keys(control.options)));
    default:
      throw new Error(`No edits generated for ${control.type} controls`);
  }
}

/** A run of edits to any of the declarative tab's settings. */
function editsArb() {
  const rows = declaredControls();
  return fc.array(
    fc.nat({ max: rows.length - 1 }).chain((row) => editArb(rows, row)),
    { maxLength: 8 }
  );
}

/** Keys no control uses, including ones every object inherits. */
const unboundKeyArb = fc
  .oneof(
    textArb(),
    fc.constantFrom('toString', 'constructor', '__proto__', 'hasOwnProperty'),
    fc.constantFrom('fsrsParams', 'fsrsParams.w', 'data', 'session')
  )
  .filter(
    (key) => !declaredControls().some(({ control }) => control.key === key)
  );

// #endregion

describe('parseSteps', () => {
  it('reads well-formed steps in order, ignoring padding around each', () => {
    fc.assert(
      fc.property(
        fc
          .array(stepArb, { minLength: 1 })
          .chain((steps) =>
            typedStepsArb(fc.constant(steps)).map((typed) => ({ steps, typed }))
          ),
        ({ steps, typed }) => {
          expect(parseSteps(typed)).toEqual(steps);
        }
      )
    );
  });

  it('reads a blank field as no steps', () => {
    fc.assert(
      fc.property(paddingArb, (typed) => {
        expect(parseSteps(typed)).toEqual([]);
      })
    );
  });

  it('rejects a field with any malformed step', () => {
    fc.assert(
      fc.property(
        typedStepsArb(
          fc
            .tuple(fc.array(stepArb), malformedStepArb, fc.array(stepArb))
            .map(([before, bad, after]) => [...before, bad, ...after])
        ).filter((typed) => typed.trim() !== ''),
        (typed) => {
          expect(parseSteps(typed)).toBeNull();
        }
      )
    );
  });
});

describe('formatRolloverHour', () => {
  const CLOCK_TIME = /^(1[0-2]|[1-9]) (AM|PM)$/;

  it('shows every shift the slider allows as a 12-hour clock time', () => {
    fc.assert(
      fc.property(fc.integer({ min: -12, max: 12 }), (hours) => {
        expect(formatRolloverHour(hours)).toMatch(CLOCK_TIME);
      })
    );
  });

  it('shows a shift back from midnight as the same hour, half a day apart', () => {
    fc.assert(
      fc.property(fc.integer({ min: -12, max: 0 }), (hours) => {
        const [, earlier, earlierHalf] =
          CLOCK_TIME.exec(formatRolloverHour(hours)) ?? [];
        const [, later, laterHalf] =
          CLOCK_TIME.exec(formatRolloverHour(hours + 12)) ?? [];

        expect(earlier).toBe(later);
        expect(new Set([earlierHalf, laterHalf])).toEqual(
          new Set(['AM', 'PM'])
        );
      })
    );
  });

  it('shows the same clock time a whole day later', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (hours, days) => {
          expect(formatRolloverHour(hours + 24 * days)).toBe(
            formatRolloverHour(hours)
          );
        }
      )
    );
  });

  it.each([
    [0, '12 AM'],
    [1, '1 AM'],
    [4, '4 AM'],
    [11, '11 AM'],
    [12, '12 PM'],
    [-1, '11 PM'],
    [-4, '8 PM'],
    [-11, '1 PM'],
    [-12, '12 PM'],
  ])('shows a shift of %i hours as %s', (hours, shown) => {
    expect(formatRolloverHour(hours)).toBe(shown);
  });
});

describe('formatPriority', () => {
  it('shows each priority step to one decimal place', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 50 }), (tenths) => {
        const shown = `${Math.floor(tenths / 10)}.${tenths % 10}`;

        expect(formatPriority(tenths / 10)).toBe(shown);
        // a step reached by adding 0.1s carries float noise, e.g. 2.6000000000000001
        expect(formatPriority(1 + (tenths - 10) * 0.1)).toBe(shown);
      })
    );
  });

  it('shows any priority on the slider rounded to one decimal place', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 5, noNaN: true }), (priority) => {
        const shown = formatPriority(priority);

        expect(shown).toMatch(/^[1-5]\.\d$/);
        expect(Math.abs(Number(shown) - priority)).toBeLessThanOrEqual(0.05);
      })
    );
  });
});

describe('formatRetention', () => {
  it('shows each retention step to two decimal places', () => {
    fc.assert(
      fc.property(fc.integer({ min: 80, max: 95 }), (hundredths) => {
        const shown = `0.${hundredths}`;

        expect(formatRetention(hundredths / 100)).toBe(shown);
        expect(formatRetention(0.8 + (hundredths - 80) * 0.01)).toBe(shown);
      })
    );
  });

  it('shows any retention on the slider rounded to two decimal places', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.8, max: 0.95, noNaN: true }),
        (retention) => {
          const shown = formatRetention(retention);

          expect(shown).toMatch(/^0\.\d\d$/);
          expect(Math.abs(Number(shown) - retention)).toBeLessThanOrEqual(
            0.005
          );
        }
      )
    );
  });
});

describe('IRSettingTab.getControlValue', () => {
  it('reads each setting as its control shows it', () => {
    fc.assert(
      fc.property(settingsArb, (generated) => {
        const settings = buildSettings(generated);
        const { tab } = makeTab(settings);
        const { fsrsParams } = settings;

        expect({
          defaultPriority: tab.getControlValue('defaultPriority'),
          showImportDialog: tab.getControlValue('showImportDialog'),
          copyOnImport: tab.getControlValue('copyOnImport'),
          createEmptyInCurrentFolder: tab.getControlValue(
            'createEmptyInCurrentFolder'
          ),
          dayRolloverOffset: tab.getControlValue('dayRolloverOffset'),
          fuzzTextReviews: tab.getControlValue('fuzzTextReviews'),
          skipHomeScreen: tab.getControlValue('skipHomeScreen'),
          reviewTitleBar: tab.getControlValue('reviewTitleBar'),
          showAdvancedImportCommands: tab.getControlValue(
            'showAdvancedImportCommands'
          ),
          showAdvancedImportMenuItems: tab.getControlValue(
            'showAdvancedImportMenuItems'
          ),
          retention: tab.getControlValue('fsrsParams.request_retention'),
          fuzz: tab.getControlValue('fsrsParams.enable_fuzz'),
          showGradeIntervals: tab.getControlValue('showGradeIntervals'),
          successNoticesInReview: tab.getControlValue('successNoticesInReview'),
          successNoticesOutsideReview: tab.getControlValue(
            'successNoticesOutsideReview'
          ),
          reviewReminders: tab.getControlValue('reviewReminders'),
          remindDueArticles: tab.getControlValue('remindDueArticles'),
          remindDueSnippets: tab.getControlValue('remindDueSnippets'),
          maximumInterval: tab.getControlValue('fsrsParams.maximum_interval'),
          shortTerm: tab.getControlValue('fsrsParams.enable_short_term'),
          learningSteps: tab.getControlValue('fsrsParams.learning_steps'),
          relearningSteps: tab.getControlValue('fsrsParams.relearning_steps'),
        }).toEqual({
          defaultPriority: settings.defaultPriority / 10,
          showImportDialog: settings.showImportDialog,
          copyOnImport: settings.copyOnImport,
          createEmptyInCurrentFolder: settings.createEmptyInCurrentFolder,
          dayRolloverOffset: settings.dayRolloverOffset,
          fuzzTextReviews: settings.fuzzTextReviews,
          skipHomeScreen: settings.skipHomeScreen,
          reviewTitleBar: settings.reviewTitleBar,
          showAdvancedImportCommands: settings.showAdvancedImportCommands,
          showAdvancedImportMenuItems: settings.showAdvancedImportMenuItems,
          retention: fsrsParams.request_retention,
          fuzz: fsrsParams.enable_fuzz,
          showGradeIntervals: settings.showGradeIntervals,
          successNoticesInReview: settings.successNoticesInReview,
          successNoticesOutsideReview: settings.successNoticesOutsideReview,
          reviewReminders: settings.reviewReminders,
          remindDueArticles: settings.remindDueArticles,
          remindDueSnippets: settings.remindDueSnippets,
          maximumInterval: fsrsParams.maximum_interval,
          shortTerm: fsrsParams.enable_short_term,
          learningSteps: fsrsParams.learning_steps.join(', '),
          relearningSteps: fsrsParams.relearning_steps.join(', '),
        });
      })
    );
  });

  it('reads nothing for a key no control uses', () => {
    fc.assert(
      fc.property(settingsArb, unboundKeyArb, (generated, key) => {
        const { tab } = makeTab(buildSettings(generated));

        expect(tab.getControlValue(key)).toBeUndefined();
      })
    );
  });
});

describe('IRSettingTab.setControlValue', () => {
  it('stores a priority shown out of 5 as a whole number out of 50', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.double({ noNaN: true }),
        async (generated, shown) => {
          const { tab, plugin } = makeTab(buildSettings(generated));

          await tab.setControlValue('defaultPriority', shown);

          const clamped = Math.min(
            Math.max(shown, MINIMUM_PRIORITY / 10),
            MAXIMUM_PRIORITY / 10
          );
          expect(plugin.settings.defaultPriority).toBe(
            Math.round(clamped * 10)
          );
        }
      )
    );
  });

  it('stores each other setting as its control gives it', async () => {
    const plainKeys = [
      ['showImportDialog', fc.boolean()],
      ['copyOnImport', fc.boolean()],
      ['createEmptyInCurrentFolder', fc.boolean()],
      ['dayRolloverOffset', fc.integer()],
      ['fuzzTextReviews', fc.boolean()],
      ['skipHomeScreen', fc.boolean()],
      ['reviewTitleBar', fc.constantFrom(...REVIEW_TITLE_BARS)],
      ['showAdvancedImportCommands', fc.boolean()],
      ['showAdvancedImportMenuItems', fc.boolean()],
      ['showGradeIntervals', fc.boolean()],
      ['successNoticesInReview', fc.constantFrom(...SUCCESS_NOTICE_LEVELS)],
      [
        'successNoticesOutsideReview',
        fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
      ],
      ['reviewReminders', fc.boolean()],
      ['remindDueArticles', fc.boolean()],
      ['remindDueSnippets', fc.boolean()],
    ] as const;
    const fsrsKeys = [
      ['request_retention', fc.double()],
      ['enable_fuzz', fc.boolean()],
      ['maximum_interval', fc.integer()],
      ['enable_short_term', fc.boolean()],
    ] as const;

    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.oneof(
          ...plainKeys.map(([key, arb]) =>
            (arb as fc.Arbitrary<unknown>).map((value) => ({
              key,
              value,
              expect: (before: IRPluginSettings) => ({
                ...before,
                [key]: value,
              }),
            }))
          ),
          ...fsrsKeys.map(([key, arb]) =>
            (arb as fc.Arbitrary<unknown>).map((value) => ({
              key: `fsrsParams.${key}`,
              value,
              expect: (before: IRPluginSettings) => ({
                ...before,
                fsrsParams: { ...before.fsrsParams, [key]: value },
              }),
            }))
          )
        ),
        async (generated, edit) => {
          const settings = buildSettings(generated);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);

          await tab.setControlValue(edit.key, edit.value);

          expect(plugin.settings).toBe(settings);
          expect(plugin.settings).toEqual(edit.expect(before));
        }
      )
    );
  });

  it('stores well-formed steps as a list and ignores malformed ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.constantFrom('learning_steps', 'relearning_steps'),
        typedFieldArb,
        async (generated, key, typed) => {
          const settings = buildSettings(generated);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);

          await tab.setControlValue(`fsrsParams.${key}`, typed);

          const steps = parseSteps(typed);
          expect(plugin.settings).toEqual(
            steps
              ? {
                  ...before,
                  fsrsParams: { ...before.fsrsParams, [key]: steps },
                }
              : before
          );
        }
      )
    );
  });

  it('saves the whole plugin data once the edit is applied', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, editsArb(), async (generated, edits) => {
        const { tab, plugin, saved } = makeTab(buildSettings(generated));
        const rows = declaredRows(tab.getSettingDefinitions());

        for (const [i, edit] of edits.entries()) {
          await tab.setControlValue(rows[edit.row].control.key, edit.value);

          expect(saved).toHaveLength(i + 1);
          expect(saved[i]).toEqual(plugin.data);
        }
      })
    );
  });

  it('turns the extra import hotkeys on or off to match, after saving', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, fc.boolean(), async (generated, enable) => {
        const { tab, events } = makeTab(buildSettings(generated));

        await tab.setControlValue('showAdvancedImportCommands', enable);

        expect(events).toEqual(['save', `toggle:${enable}`]);
      })
    );
  });

  it('updates the open review tabs to a new title bar choice without waiting on the save', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.constantFrom(...REVIEW_TITLE_BARS),
        async (generated, choice) => {
          const { tab, events } = makeTab(buildSettings(generated));

          await tab.setControlValue('reviewTitleBar', choice);

          expect(events).toEqual([`title-bars:${choice}`, 'save']);
        }
      )
    );
  });

  it('leaves the review tabs alone when another setting changes', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, editsArb(), async (generated, edits) => {
        const { tab, plugin } = makeTab(buildSettings(generated));
        const rows = declaredRows(tab.getSettingDefinitions());
        const others = edits.filter(
          (edit) => rows[edit.row].control.key !== 'reviewTitleBar'
        );

        for (const edit of others) {
          await tab.setControlValue(rows[edit.row].control.key, edit.value);
        }

        expect(plugin.syncReviewTitleBars).not.toHaveBeenCalled();
      })
    );
  });

  it('names every review title bar choice in its dropdown', () => {
    const [control] = declaredControls()
      .map((row) => row.control)
      .filter((row) => row.key === 'reviewTitleBar');

    expect(control).toMatchObject({ type: 'dropdown' });
    expect(control.type === 'dropdown' && control.options).toEqual(
      REVIEW_TITLE_BAR_OPTIONS
    );
    expect(Object.keys(REVIEW_TITLE_BAR_OPTIONS)).toEqual(REVIEW_TITLE_BARS);
  });

  it('names every success notice level in both of its dropdowns', () => {
    const controls = declaredControls()
      .map((row) => row.control)
      .filter((row) => row.key.startsWith('successNotices'));

    expect(controls.map((control) => control.key)).toEqual([
      'successNoticesInReview',
      'successNoticesOutsideReview',
    ]);
    for (const control of controls) {
      expect(control).toMatchObject({ type: 'dropdown' });
      expect(control.type === 'dropdown' && control.options).toEqual(
        SUCCESS_NOTICE_LEVEL_OPTIONS
      );
    }
    expect(Object.keys(SUCCESS_NOTICE_LEVEL_OPTIONS)).toEqual(
      SUCCESS_NOTICE_LEVELS
    );
  });

  it('leaves the extra import hotkeys alone when another setting changes', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, editsArb(), async (generated, edits) => {
        const { tab, plugin } = makeTab(buildSettings(generated));
        const rows = declaredRows(tab.getSettingDefinitions());
        const others = edits.filter(
          (edit) => rows[edit.row].control.key !== 'showAdvancedImportCommands'
        );

        for (const edit of others) {
          await tab.setControlValue(rows[edit.row].control.key, edit.value);
        }

        expect(plugin.toggleAdvancedCommands).not.toHaveBeenCalled();
      })
    );
  });

  it('neither writes nor saves a key no control uses', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        unboundKeyArb,
        fc.anything(),
        async (generated, key, value) => {
          const settings = buildSettings(generated);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);

          await tab.setControlValue(key, value);

          expect(plugin.settings).toEqual(before);
          expect(plugin.saveSettings).not.toHaveBeenCalled();
          expect(plugin.toggleAdvancedCommands).not.toHaveBeenCalled();
          expect(plugin.syncReviewTitleBars).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('IRSettingTab.getSettingDefinitions', () => {
  it('offers the review title bar choice wherever Obsidian offers its own, which is everywhere but a phone', () => {
    const before = { ...Platform };
    // Every platform Obsidian reports: desktop, a tablet, or a phone, whose
    // two flags it recomputes as the window resizes.
    const platforms = [
      { isMobile: false, isPhone: false, isTablet: false },
      { isMobile: true, isPhone: false, isTablet: true },
      { isMobile: true, isPhone: true, isTablet: false },
    ];
    try {
      const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
      const definitions = tab.getSettingDefinitions();
      for (const platform of platforms) {
        Object.assign(Platform, platform, { isDesktop: !platform.isMobile });
        const visible = definitions.flatMap((group) =>
          'items' in group && group.items
            ? group.items.flatMap((item) => {
                if (!('control' in item) || !item.control) return [];
                const shown =
                  typeof item.visible === 'function'
                    ? item.visible()
                    : (item.visible ?? true);
                return shown ? [item.control.key] : [];
              })
            : []
        );

        expect(visible.includes('reviewTitleBar')).toBe(!platform.isPhone);
        expect(visible.filter((key) => key !== 'reviewTitleBar')).toEqual(
          declaredControls()
            .map(({ control }) => control.key)
            .filter((key) => key !== 'reviewTitleBar')
        );
      }
    } finally {
      Object.assign(Platform, before);
    }
  });

  it('lists every setting under its heading, with its description and control', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const validate = expect.any(Function) as unknown;
    const disabled = expect.any(Function) as unknown;
    const toggle = (key: string) => ({ type: 'toggle', key });

    expect(declaredRows(tab.getSettingDefinitions())).toEqual([
      {
        heading: 'Imports',
        name: 'Default article priority',
        desc: 'Priority for new imports. Does not affect existing articles.',
        control: {
          type: 'slider',
          key: 'defaultPriority',
          min: 1,
          max: 5,
          step: 0.1,
          defaultValue: 3,
          displayFormat: formatPriority,
        },
      },
      {
        heading: 'Imports',
        name: 'Show article import dialog',
        desc: 'Show a dialog when importing that allows customization.',
        control: toggle('showImportDialog'),
      },
      {
        heading: 'Imports',
        name: 'Copy articles when importing',
        desc: `Copy notes into the data directory (${DATA_DIRECTORY}/) when importing and leave the original note untouched. Disable to import notes in-place.`,
        control: toggle('copyOnImport'),
      },
      {
        heading: 'Imports',
        name: 'Create empty articles in the current folder',
        desc: `If disabled, empty articles will be created in "${DATA_DIRECTORY}/"`,
        control: toggle('createEmptyInCurrentFolder'),
      },
      {
        heading: 'Notifications and reminders',
        name: 'Success notices inside review',
        desc: 'Which confirmations to show for actions taken in the review tab. Minimal shows only undos and imports. Errors always show.',
        control: {
          type: 'dropdown',
          key: 'successNoticesInReview',
          options: {
            all: 'All',
            minimal: 'Minimal',
            none: 'None',
          },
        },
      },
      {
        heading: 'Notifications and reminders',
        name: 'Success notices outside review',
        desc: 'Which confirmations to show for actions taken anywhere else. Minimal shows only undos and imports. Errors always show.',
        control: {
          type: 'dropdown',
          key: 'successNoticesOutsideReview',
          options: {
            all: 'All',
            minimal: 'Minimal',
            none: 'None',
          },
        },
      },
      {
        heading: 'Notifications and reminders',
        name: 'Show review reminders',
        desc: 'Show "Ready for review" in the status bar while anything is due. Desktop only.',
        control: toggle('reviewReminders'),
      },
      {
        heading: 'Notifications and reminders',
        name: 'Remind for due articles',
        desc: 'Count due articles toward review reminders. Due cards always count.',
        control: { ...toggle('remindDueArticles'), disabled },
      },
      {
        heading: 'Notifications and reminders',
        name: 'Remind for due snippets',
        desc: 'Count due snippets toward review reminders. Due cards always count.',
        control: { ...toggle('remindDueSnippets'), disabled },
      },
      {
        heading: 'Reviews',
        name: 'End-of-day shift',
        desc: 'Adjust the end time of the review day, in hours from midnight. Set this to the time you are most likely to be asleep. Default: 4 AM.',
        control: {
          type: 'slider',
          key: 'dayRolloverOffset',
          min: -12,
          max: 12,
          step: 1,
          defaultValue: 4,
          displayFormat: formatRolloverHour,
        },
      },
      {
        heading: 'Reviews',
        name: 'Fuzz review ordering',
        desc: 'Partially shuffle article and snippet reviews within the same day. Cards are not affected.',
        control: toggle('fuzzTextReviews'),
      },
      {
        heading: 'Reviews',
        name: 'Skip home screen',
        desc: 'Jump to the first due item when opening review.',
        control: toggle('skipHomeScreen'),
      },
      {
        heading: 'Reviews',
        name: 'Show review tab title bar',
        desc: 'Show the title bar above the review tab, or leave it to the "Show tab title bar" appearance setting.',
        control: {
          type: 'dropdown',
          key: 'reviewTitleBar',
          options: {
            obsidian: 'Follow Obsidian setting',
            show: 'Show',
            hide: 'Hide',
          },
        },
      },
      {
        heading: 'Shortcuts',
        name: 'Enable extra import hotkeys',
        desc: 'Shortcuts to open or bypass the import modal, import a copy, or import in-place.',
        control: toggle('showAdvancedImportCommands'),
      },
      {
        heading: 'Shortcuts',
        name: 'Show extra file menu entries for importing',
        desc: 'Entries to open or bypass the import modal, import a copy, or import in-place.',
        control: toggle('showAdvancedImportMenuItems'),
      },
      {
        heading: 'Spaced repetition',
        name: 'Targeted retention',
        desc: 'The card recall score (out of 1) to aim for. Card reviews will be scheduled to target this score. 0.9 is optimal in most cases.',
        control: {
          type: 'slider',
          key: 'fsrsParams.request_retention',
          min: 0.8,
          max: 0.95,
          step: 0.01,
          defaultValue: 0.9,
          displayFormat: formatRetention,
        },
      },
      {
        heading: 'Spaced repetition',
        name: 'Fuzz review intervals',
        desc: 'Add controlled randomness to subsequent card reviews. Does not affect articles or snippets.',
        control: toggle('fsrsParams.enable_fuzz'),
      },
      {
        heading: 'Spaced repetition',
        name: 'Show intervals on grade buttons',
        desc: "Show when the card's next review would be for each grade. A ~ marks an interval that fuzzing can change.",
        control: toggle('showGradeIntervals'),
      },
      {
        heading: 'Spaced repetition',
        name: 'Maximum review interval',
        desc: 'Soft ceiling on the time between card reviews. Fuzzing can exceed this limit slightly. Default: 36,500 days.',
        control: {
          type: 'number',
          key: 'fsrsParams.maximum_interval',
          min: 1,
          step: 1,
          defaultValue: 36500,
          validate,
        },
      },
      {
        heading: 'Spaced repetition',
        name: 'Enable short-term card scheduling',
        desc: 'Schedule cards for next review in a few minutes in some cases where the user chooses a review grade below easy.',
        control: toggle('fsrsParams.enable_short_term'),
      },
      {
        heading: 'Spaced repetition',
        name: 'Learning steps',
        desc: 'FSRS learning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas. Default: 1m, 10m',
        control: { type: 'text', key: 'fsrsParams.learning_steps', validate },
      },
      {
        heading: 'Spaced repetition',
        name: 'Relearning steps',
        desc: 'FSRS relearning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas. Default: 10m',
        control: {
          type: 'text',
          key: 'fsrsParams.relearning_steps',
          validate,
        },
      },
    ]);
  });

  it('locks the reminder type toggles exactly while review reminders are off, following each change', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.array(fc.boolean(), { maxLength: 4 }),
        async (generated, flips) => {
          const { tab } = makeTab(buildSettings(generated));
          const locks = declaredRows(tab.getSettingDefinitions()).filter(
            ({ control }) => control.disabled !== undefined
          );
          const lockedNow = () =>
            locks.map(({ control }) =>
              typeof control.disabled === 'function'
                ? control.disabled()
                : control.disabled
            );

          expect(locks.map(({ control }) => control.key)).toEqual([
            'remindDueArticles',
            'remindDueSnippets',
          ]);
          expect(lockedNow()).toEqual(
            Array(2).fill(!generated.settings.reviewReminders)
          );
          for (const on of flips) {
            await tab.setControlValue('reviewReminders', on);
            expect(lockedNow()).toEqual([!on, !on]);
          }
        }
      )
    );
  });

  it('shows each slider value in the units its description uses', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const sliders = declaredRows(tab.getSettingDefinitions())
      .map(({ control }) => control)
      .filter((control) => control.type === 'slider');

    expect(
      sliders.map((control) => [control.key, control.displayFormat])
    ).toEqual([
      ['defaultPriority', formatPriority],
      ['dayRolloverOffset', formatRolloverHour],
      ['fsrsParams.request_retention', formatRetention],
    ]);
  });

  it('gives each setting its own control', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const keys = declaredRows(tab.getSettingDefinitions()).map(
      ({ control }) => control.key
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(tab.getControlValue(key)).toBeDefined();
    }
  });

  it('resets each control to the value default settings show', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const withDefaults = declaredRows(tab.getSettingDefinitions()).filter(
      ({ control }) => control.defaultValue !== undefined
    );

    expect(withDefaults.map(({ control }) => control.key)).toEqual([
      'defaultPriority',
      'dayRolloverOffset',
      'fsrsParams.request_retention',
      'fsrsParams.maximum_interval',
    ]);
    for (const { control } of withDefaults) {
      expect(control.defaultValue).toBe(tab.getControlValue(control.key));
    }
  });

  it('accepts only well-formed steps', async () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const stepControls = declaredRows(tab.getSettingDefinitions())
      .map(({ control }) => control)
      .filter((control) => control.type === 'text');

    expect(stepControls.map((control) => control.key)).toEqual([
      'fsrsParams.learning_steps',
      'fsrsParams.relearning_steps',
    ]);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...stepControls),
        typedFieldArb,
        async (control, typed) => {
          const message = await control.validate?.(typed);

          if (parseSteps(typed)) {
            expect(message).toBeFalsy();
          } else {
            expect(message).toEqual(expect.stringMatching(/\S/));
          }
        }
      )
    );
  });

  it('accepts only a whole number of days, at least one, as the maximum interval', async () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const [control] = declaredRows(tab.getSettingDefinitions())
      .map((row) => row.control)
      .filter((row) => row.type === 'number');

    expect(control).toMatchObject({
      key: 'fsrsParams.maximum_interval',
      min: 1,
      step: 1,
    });
    await fc.assert(
      fc.asyncProperty(fc.double(), async (days) => {
        const message = await control.validate?.(days as never);

        if (Number.isInteger(days)) {
          expect(message).toBeFalsy();
        } else {
          expect(message).toEqual(expect.stringMatching(/\S/));
        }
      })
    );
  });
});

describe('IRSettingTab container', () => {
  /** Selectors of the styles.css rules that react to Obsidian's `is-invalid`. */
  const invalidRowSelectors = () =>
    [
      ...readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/([^{}]+)\{/g),
    ]
      .flatMap(([, selectors]) => selectors.split(/,(?![^(]*\))/))
      .map((selector) => selector.replace(/\s+/g, ' ').trim())
      .filter((selector) => selector.includes('.is-invalid'));

  it('carries the class that scopes styles.css to this tab', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));

    expect(tab.containerEl.classList.contains(SETTINGS_TAB_CLASS)).toBe(true);
  });

  it('is what every styles.css rule for invalid rows is scoped to', () => {
    const selectors = invalidRowSelectors();

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(`.${SETTINGS_TAB_CLASS} `)).toBe(true);
    }
  });
});
