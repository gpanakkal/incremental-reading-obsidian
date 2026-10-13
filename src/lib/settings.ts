import type IncrementalReadingPlugin from '#/main';
import {
  Platform,
  PluginSettingTab,
  type App,
  type SettingDefinitionItem,
} from 'obsidian';
import {
  generatorParameters,
  type FSRSParameters,
  type StepUnit,
} from 'ts-fsrs';
import {
  DATA_DIRECTORY,
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
} from './constants';
import IRScheduler from './IRScheduler';

export interface IRPluginSettings {
  defaultPriority: number;
  showImportDialog: boolean;
  copyOnImport: boolean;
  createEmptyInCurrentFolder: boolean;
  dayRolloverOffset: number;
  showAdvancedImportCommands: boolean;
  showAdvancedImportMenuItems: boolean;
  fuzzTextReviews: boolean; // intra-day fuzzing for items except cards
  skipHomeScreen: boolean;
  reviewTitleBar: ReviewTitleBar;
  /** Whether each grade button shows the interval it would schedule. */
  showGradeIntervals: boolean;
  fsrsParams: FSRSParameters;
}

/**
 * Whether the review tab shows its title bar: as Obsidian's "Show tab title
 * bar" setting says, or always, or never. ReviewView applies it to the tab.
 */
export type ReviewTitleBar = 'obsidian' | 'show' | 'hide';

/** Each {@link ReviewTitleBar} choice, as the settings dropdown names it. */
export const REVIEW_TITLE_BAR_OPTIONS: Readonly<
  Record<ReviewTitleBar, string>
> = Object.freeze({
  obsidian: 'Follow Obsidian setting',
  show: 'Show',
  hide: 'Hide',
});

/**
 * Whether `value` is a {@link ReviewTitleBar} choice. The `typeof` check is not
 * redundant: `Object.hasOwn` turns its key into a string, so `['show']` would
 * pass without it.
 */
export const isReviewTitleBar = (value: unknown): value is ReviewTitleBar =>
  typeof value === 'string' && Object.hasOwn(REVIEW_TITLE_BAR_OPTIONS, value);

const FSRS_PARAMETER_DEFAULTS = Object.freeze(generatorParameters());

export const DEFAULT_SETTINGS: IRPluginSettings = {
  defaultPriority: DEFAULT_PRIORITY,
  showImportDialog: true,
  copyOnImport: false,
  createEmptyInCurrentFolder: true,
  dayRolloverOffset: DAY_ROLLOVER_OFFSET_HOURS.DEFAULT,
  showAdvancedImportCommands: false,
  showAdvancedImportMenuItems: false,
  fuzzTextReviews: true,
  skipHomeScreen: false,
  reviewTitleBar: 'obsidian',
  showGradeIntervals: false,
  fsrsParams: FSRS_PARAMETER_DEFAULTS,
};

const STEP_PATTERN = /^[1-9]\d*[mhd]$/;

/**
 * The steps typed into a (re)learning steps field, or null if any is malformed.
 *
 * A blank field is no steps rather than one empty step: ts-fsrs throws on `''`
 * the next time it schedules a card that is still learning.
 */
export function parseSteps(value: string): StepUnit[] | null {
  if (value.trim() === '') return [];

  const steps = value.split(',').map((step) => step.trim());
  return steps.every((step) => STEP_PATTERN.test(step))
    ? (steps as StepUnit[])
    : null;
}

/** A priority as its slider shows it, out of 5 to one decimal place: `2.5`. */
export const formatPriority = (priority: number) => priority.toFixed(1);

/**
 * An end-of-day shift, in hours from midnight, as the 12-hour clock time the
 * review day ends at: `4` is `4 AM`, `-4` is `8 PM` the evening before.
 */
export function formatRolloverHour(hours: number): string {
  const hourOfDay = ((hours % 24) + 24) % 24;
  return `${hourOfDay % 12 || 12} ${hourOfDay < 12 ? 'AM' : 'PM'}`;
}

/** A targeted retention as its slider shows it, to two decimal places: `0.90`. */
export const formatRetention = (retention: number) => retention.toFixed(2);

/** How a control reads its value out of the settings and writes an edit back. */
interface ControlBinding<V> {
  read(settings: IRPluginSettings): V;
  write(settings: IRPluginSettings, value: V): void;
}

/** A top-level setting, shown exactly as it is stored. */
function topLevel<K extends keyof IRPluginSettings>(
  key: K
): ControlBinding<IRPluginSettings[K]> {
  return {
    read: (settings) => settings[key],
    write: (settings, value) => {
      settings[key] = value;
    },
  };
}

/**
 * A scheduler parameter. Written by replacing `fsrsParams` instead of assigning
 * into it, because until the first save it is the frozen default object.
 */
function fsrsParam<K extends keyof FSRSParameters>(
  key: K
): ControlBinding<FSRSParameters[K]> {
  return {
    read: (settings) => settings.fsrsParams[key],
    write: (settings, value) => {
      settings.fsrsParams = { ...settings.fsrsParams, [key]: value };
    },
  };
}

/** (Re)learning steps, edited as comma-separated text. Malformed text is dropped. */
function stepsParam(
  key: 'learning_steps' | 'relearning_steps'
): ControlBinding<string> {
  const param = fsrsParam(key);
  return {
    read: (settings) => param.read(settings).join(', '),
    write: (settings, value) => {
      const steps = parseSteps(value);
      if (steps) param.write(settings, steps);
    },
  };
}

/**
 * Every control key the settings tab uses, and where each lives in
 * {@link IRPluginSettings}.
 *
 * Obsidian's own binding is `plugin.settings[key]`, saved with
 * `saveData(plugin.settings)`. That can't reach into `fsrsParams`, stores values
 * exactly as their controls show them, and would overwrite `data.json` with its
 * settings half alone.
 */
const CONTROL_BINDINGS = {
  defaultPriority: {
    // shown out of 5, stored out of 50
    read: (settings) => settings.defaultPriority / 10,
    write: (settings, value: number) => {
      settings.defaultPriority = IRScheduler.transformPriority(value);
    },
  },
  showImportDialog: topLevel('showImportDialog'),
  copyOnImport: topLevel('copyOnImport'),
  createEmptyInCurrentFolder: topLevel('createEmptyInCurrentFolder'),
  dayRolloverOffset: topLevel('dayRolloverOffset'),
  fuzzTextReviews: topLevel('fuzzTextReviews'),
  skipHomeScreen: topLevel('skipHomeScreen'),
  reviewTitleBar: topLevel('reviewTitleBar'),
  showAdvancedImportCommands: topLevel('showAdvancedImportCommands'),
  showAdvancedImportMenuItems: topLevel('showAdvancedImportMenuItems'),
  showGradeIntervals: topLevel('showGradeIntervals'),
  'fsrsParams.request_retention': fsrsParam('request_retention'),
  'fsrsParams.enable_fuzz': fsrsParam('enable_fuzz'),
  'fsrsParams.maximum_interval': fsrsParam('maximum_interval'),
  'fsrsParams.enable_short_term': fsrsParam('enable_short_term'),
  'fsrsParams.learning_steps': stepsParam('learning_steps'),
  'fsrsParams.relearning_steps': stepsParam('relearning_steps'),
} satisfies Record<string, ControlBinding<unknown>>;

type ControlKey = keyof typeof CONTROL_BINDINGS;

const isControlKey = (key: string): key is ControlKey =>
  Object.hasOwn(CONTROL_BINDINGS, key);

const validateSteps = (value: string) =>
  parseSteps(value)
    ? undefined
    : 'Write each step like "3m", "2h" or "1d", separated by commas.';

/** Marks this plugin's settings tab for the rules in styles.css. */
export const SETTINGS_TAB_CLASS = 'ir-settings-tab';

/**
 * The plugin's settings tab, described declaratively by
 * {@link getSettingDefinitions}. Obsidian (1.13.1+, the `minAppVersion`) renders
 * the rows, runs each control's `validate` and shows its message inline, and
 * reads and writes values through {@link getControlValue} and
 * {@link setControlValue}.
 */
export class IRSettingTab extends PluginSettingTab {
  plugin: IncrementalReadingPlugin;

  constructor(app: App, plugin: IncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Obsidian gives the tab's container no per-tab class, and it is the
    // element shown in the settings window, so this scopes styles.css's
    // settings rules to this tab alone.
    this.containerEl.classList.add(SETTINGS_TAB_CLASS);
  }

  getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
    return [
      {
        type: 'group',
        heading: 'Imports',
        items: [
          {
            name: 'Default article priority',
            desc: 'Priority for new imports. Does not affect existing articles.',
            control: {
              type: 'slider',
              key: 'defaultPriority',
              min: MINIMUM_PRIORITY / 10,
              max: MAXIMUM_PRIORITY / 10,
              step: 0.1,
              defaultValue: DEFAULT_PRIORITY / 10,
              displayFormat: formatPriority,
            },
          },
          {
            name: 'Show article import dialog',
            desc: 'Show a dialog when importing that allows customization.',
            control: { type: 'toggle', key: 'showImportDialog' },
          },
          {
            name: 'Copy articles when importing',
            desc:
              `Copy notes into the data directory (${DATA_DIRECTORY}/) when importing` +
              ' and leave the original note untouched.' +
              ' Disable to import notes in-place.',
            control: { type: 'toggle', key: 'copyOnImport' },
          },
          {
            name: 'Create empty articles in the current folder',
            desc: `If disabled, empty articles will be created in "${DATA_DIRECTORY}/"`,
            control: { type: 'toggle', key: 'createEmptyInCurrentFolder' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Reviews',
        items: [
          {
            name: 'End-of-day shift',
            desc:
              'Adjust the end time of the review day, in hours from midnight.' +
              ' Set this to the time you are most likely to be asleep.' +
              ' Default: 4 AM.',
            control: {
              type: 'slider',
              key: 'dayRolloverOffset',
              min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
              max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
              step: 1,
              defaultValue: DAY_ROLLOVER_OFFSET_HOURS.DEFAULT,
              displayFormat: formatRolloverHour,
            },
          },
          {
            name: 'Fuzz review ordering',
            desc: `Partially shuffle article and snippet reviews within the same day. Cards are not affected.`,
            control: { type: 'toggle', key: 'fuzzTextReviews' },
          },
          {
            name: 'Skip home screen',
            desc: 'Jump to the first due item when opening review.',
            control: { type: 'toggle', key: 'skipHomeScreen' },
          },
          {
            name: 'Show review tab title bar',
            desc: 'Show the title bar above the review tab, or leave it to the "Show tab title bar" appearance setting.',
            control: {
              type: 'dropdown',
              key: 'reviewTitleBar',
              options: REVIEW_TITLE_BAR_OPTIONS,
            },
            // Hidden where Obsidian hides its own "Show tab title bar": a phone
            // always shows the header, and styles.css ignores this setting
            // there too. A function, so each render reads `isPhone` afresh —
            // Obsidian recomputes it as the window resizes.
            visible: () => !Platform.isPhone,
          },
        ],
      },
      {
        type: 'group',
        heading: 'Shortcuts',
        items: [
          {
            name: 'Enable extra import hotkeys',
            desc: `Shortcuts to open or bypass the import modal, import a copy, or import in-place.`,
            control: { type: 'toggle', key: 'showAdvancedImportCommands' },
          },
          {
            name: 'Show extra file menu entries for importing',
            desc: `Entries to open or bypass the import modal, import a copy, or import in-place.`,
            control: { type: 'toggle', key: 'showAdvancedImportMenuItems' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Spaced repetition',
        items: [
          {
            name: 'Targeted retention',
            desc: `The card recall score (out of 1) to aim for. Card reviews will be scheduled to target this score. 0.9 is optimal in most cases.`,
            control: {
              type: 'slider',
              key: 'fsrsParams.request_retention',
              min: 0.8,
              max: 0.95,
              step: 0.01,
              defaultValue: FSRS_PARAMETER_DEFAULTS.request_retention,
              displayFormat: formatRetention,
            },
          },
          {
            name: 'Fuzz review intervals',
            desc: `Add controlled randomness to subsequent card reviews. Does not affect articles or snippets.`,
            control: { type: 'toggle', key: 'fsrsParams.enable_fuzz' },
          },
          {
            name: 'Show intervals on grade buttons',
            desc: "Show when the card's next review would be for each grade. A ~ marks an interval that fuzzing can change.",
            control: { type: 'toggle', key: 'showGradeIntervals' },
          },
          {
            name: 'Maximum review interval',
            desc: `Soft ceiling on the time between card reviews. Fuzzing can exceed this limit slightly. Default: 36,500 days.`,
            control: {
              type: 'number',
              key: 'fsrsParams.maximum_interval',
              min: 1,
              step: 1,
              defaultValue: FSRS_PARAMETER_DEFAULTS.maximum_interval,
              validate: (value) =>
                Number.isInteger(value)
                  ? undefined
                  : 'Enter a whole number of days.',
            },
          },
          {
            name: 'Enable short-term card scheduling',
            desc: `Schedule cards for next review in a few minutes in some cases where the user chooses a review grade below easy.`,
            control: { type: 'toggle', key: 'fsrsParams.enable_short_term' },
          },
          {
            name: 'Learning steps',
            desc: `FSRS learning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas. Default: 1m, 10m`,
            control: {
              type: 'text',
              key: 'fsrsParams.learning_steps',
              validate: validateSteps,
            },
          },
          {
            name: 'Relearning steps',
            desc: `FSRS relearning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas. Default: 10m`,
            control: {
              type: 'text',
              key: 'fsrsParams.relearning_steps',
              validate: validateSteps,
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (!isControlKey(key)) return undefined;
    return CONTROL_BINDINGS[key].read(this.plugin.settings);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!isControlKey(key)) return;

    // Obsidian hands each key the value of the control declared for it, which
    // is the type that key's binding reads and writes.
    (CONTROL_BINDINGS[key] as ControlBinding<unknown>).write(
      this.plugin.settings,
      value
    );
    // Before the save, which the tabs don't depend on: they read the setting
    // from memory, and a failed write must not leave the open ones behind the
    // ones opened after it.
    if (key === 'reviewTitleBar') this.plugin.syncReviewTitleBars();
    await this.plugin.saveSettings();

    if (key === 'showAdvancedImportCommands') {
      this.plugin.toggleAdvancedCommands(
        this.plugin.settings.showAdvancedImportCommands
      );
    }
  }
}
