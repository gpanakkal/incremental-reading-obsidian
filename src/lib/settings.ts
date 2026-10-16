import type IncrementalReadingPlugin from '#/main';
import {
  Platform,
  PluginSettingTab,
  type App,
  type SettingDefinitionControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingGroupItem,
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
  successNoticesInReview: SuccessNoticeLevel;
  successNoticesOutsideReview: SuccessNoticeLevel;
  /** Whether the status bar says when items are ready for review. */
  reviewReminders: boolean;
  /** Whether due articles light that reminder. Due cards always do. */
  remindDueArticles: boolean;
  /** Whether due snippets light that reminder. */
  remindDueSnippets: boolean;
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

/**
 * Which success notices show: every one, only those for an undo or an import,
 * or none. Errors and other notices always show.
 */
export type SuccessNoticeLevel = 'all' | 'minimal' | 'none';

/** Each {@link SuccessNoticeLevel}, as the settings dropdowns name it. */
export const SUCCESS_NOTICE_LEVEL_OPTIONS: Readonly<
  Record<SuccessNoticeLevel, string>
> = Object.freeze({
  all: 'All',
  minimal: 'Minimal',
  none: 'None',
});

/** Whether `value` is a {@link SuccessNoticeLevel}; see {@link isReviewTitleBar}. */
export const isSuccessNoticeLevel = (
  value: unknown
): value is SuccessNoticeLevel =>
  typeof value === 'string' &&
  Object.hasOwn(SUCCESS_NOTICE_LEVEL_OPTIONS, value);

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
  successNoticesInReview: 'all',
  successNoticesOutsideReview: 'all',
  reviewReminders: true,
  remindDueArticles: true,
  remindDueSnippets: true,
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
  successNoticesInReview: topLevel('successNoticesInReview'),
  successNoticesOutsideReview: topLevel('successNoticesOutsideReview'),
  reviewReminders: topLevel('reviewReminders'),
  remindDueArticles: topLevel('remindDueArticles'),
  remindDueSnippets: topLevel('remindDueSnippets'),
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

/** Marks a group drawn as a box: its first row heads the indented rest. */
export const SETTING_BOX_CLASS = 'ir-setting-box';

/** Marks a group that continues the section of the one before it. */
export const CONTINUED_GROUP_CLASS = 'ir-setting-group-continued';

/**
 * One setting whose controls sit on their own rows beneath its name and
 * description, drawn as one box. For a setting with several scopes, like
 * inside and outside review: the description is said once, and each row is
 * named for its scope alone.
 */
export interface SettingBox<K extends string = string> {
  type: 'box';
  name: string;
  desc: string;
  items: SettingDefinitionControl<K>[];
}

/** A group of settings as this tab declares it: Obsidian's, plus boxes. */
export interface SettingGroupLayout<K extends string = string> {
  type: 'group';
  heading?: string;
  items: (SettingGroupItem<K> | SettingBox<K>)[];
}

const isSettingBox = <K extends string>(
  item: SettingGroupItem<K> | SettingBox<K>
): item is SettingBox<K> => 'type' in item && item.type === 'box';

/**
 * Obsidian's groups for each declared group, with every box in a group of its
 * own.
 *
 * Obsidian (1.13) has no setting with sub-rows: a group's items render as flat
 * rows, it drops a group nested among them, and a row can't carry a class. Only
 * a group can (`cls`), so a box becomes its own group, whose rows stay
 * declarative controls Obsidian binds itself; styles.css draws it as one block.
 * The rows either side of a box form groups of their own, marked as continuing
 * the section so they sit with it, and the heading goes over the first. A run
 * with no rows makes no group.
 */
export function layOutGroups<K extends string>(
  layouts: SettingGroupLayout<K>[]
): SettingDefinitionGroup<K>[] {
  return layouts.flatMap(({ heading, items }) => {
    const groups: SettingDefinitionGroup<K>[] = [];
    let rows: SettingGroupItem<K>[] = [];
    const endRun = () => {
      if (rows.length > 0) groups.push({ type: 'group', items: rows });
      rows = [];
    };
    for (const item of items) {
      if (!isSettingBox(item)) {
        rows.push(item);
        continue;
      }
      endRun();
      groups.push({
        type: 'group',
        cls: SETTING_BOX_CLASS,
        items: [{ name: item.name, desc: item.desc }, ...item.items],
      });
    }
    endRun();

    return groups.map((group, index) =>
      index === 0
        ? { ...group, heading }
        : {
            ...group,
            cls: [group.cls, CONTINUED_GROUP_CLASS].filter(Boolean).join(' '),
          }
    );
  });
}

/**
 * The plugin's settings tab, described declaratively by
 * {@link getSettingDefinitions}. Obsidian (1.13.1+, which `minAppVersion` covers) renders
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
    // Obsidian re-evaluates this after every control change (it calls
    // `refreshDomState`, which runs `Setting.setDisabled`), so the lock follows
    // the reminders toggle without a re-render. Undocumented: obsidian.d.ts
    // says to call `update()`; read from `getControlBinding` in obsidian.asar
    // (1.13.7).
    const remindersOff = () => !this.plugin.settings.reviewReminders;
    return layOutGroups<ControlKey>([
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
        heading: 'Notifications and reminders',
        items: [
          {
            type: 'box',
            name: 'Success notices',
            desc:
              'Which confirmations to show for successful actions.' +
              ' Minimal shows only undos and imports' +
              ' Error notices are always shown.',
            items: [
              {
                name: 'Inside review',
                control: {
                  type: 'dropdown',
                  key: 'successNoticesInReview',
                  options: SUCCESS_NOTICE_LEVEL_OPTIONS,
                },
              },
              {
                name: 'Outside review',
                control: {
                  type: 'dropdown',
                  key: 'successNoticesOutsideReview',
                  options: SUCCESS_NOTICE_LEVEL_OPTIONS,
                },
              },
            ],
          },
          {
            name: 'Show review reminders in status bar',
            desc: 'Desktop only.',
            control: { type: 'toggle', key: 'reviewReminders' },
          },
          {
            name: 'Remind for due articles',
            control: {
              type: 'toggle',
              key: 'remindDueArticles',
              disabled: remindersOff,
            },
          },
          {
            name: 'Remind for due snippets',
            control: {
              type: 'toggle',
              key: 'remindDueSnippets',
              disabled: remindersOff,
            },
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
    ]);
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
