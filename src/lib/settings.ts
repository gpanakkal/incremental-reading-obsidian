import type IncrementalReadingPlugin from '#/main';
import {
  Platform,
  PluginSettingTab,
  setIcon,
  TextComponent,
  type App,
  type ExtraButtonComponent,
  type Setting,
  type SettingControl,
  type SettingDefinitionControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
  type SettingGroupItem,
  type SettingNumberControl,
  type SettingTextControl,
} from 'obsidian';
import {
  generatorParameters,
  type FSRSParameters,
  type StepUnit,
} from 'ts-fsrs';
import {
  AUTO_IMPORT_TAG,
  DATA_DIRECTORY,
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  IMPORT_BLOCKED_TAGS,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
} from './constants';
import IRScheduler from './IRScheduler';
import { formatTagList, parseTagList } from './tags';
import {
  cleanFolderList,
  folderToWatchProblem,
  normalizeFolderPath,
  watchListProblem,
} from './watched-folders';

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
  /** Whether a note whose frontmatter gains a trigger tag is imported by itself. */
  autoImportOnTag: boolean;
  /** The trigger tags, as {@link parseTagList} reads them. */
  autoImportTags: string[];
  /** Whether a note imported by its trigger tag is copied. */
  autoImportMode: AutoImportMode;
  /** Whether a file that arrives in a watched folder is imported by itself. */
  autoImportOnFolder: boolean;
  /** The watched folders' vault paths, as {@link cleanFolderList} keeps them. */
  autoImportFolders: string[];
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

/**
 * How a note is imported by its trigger tag: where it is, as a copy, or as
 * `copyOnImport` says. Copying moves the trigger tag to the copy (see
 * `ArticleManager.importMany`), so the original isn't imported again.
 */
export type AutoImportMode = 'inPlace' | 'copy' | 'inherit';

/** Each {@link AutoImportMode}, as the settings dropdown names it. */
export const AUTO_IMPORT_MODE_OPTIONS: Readonly<
  Record<AutoImportMode, string>
> = Object.freeze({
  inPlace: 'In place',
  copy: 'Make a copy',
  inherit: 'Same as manual imports',
});

/** Whether `value` is an {@link AutoImportMode}; see {@link isReviewTitleBar}. */
export const isAutoImportMode = (value: unknown): value is AutoImportMode =>
  typeof value === 'string' && Object.hasOwn(AUTO_IMPORT_MODE_OPTIONS, value);

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
  // Off: it changes notes in the vault without being asked each time
  autoImportOnTag: false,
  autoImportTags: [AUTO_IMPORT_TAG],
  // Not `inherit`: turning on `copyOnImport` mustn't start copying clippings
  autoImportMode: 'inPlace',
  // Off, as importing by tag is, and no folder is a given
  autoImportOnFolder: false,
  autoImportFolders: [],
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
  autoImportOnTag: topLevel('autoImportOnTag'),
  // Shown as `#`-prefixed tags separated by spaces; read however they are typed
  autoImportTags: {
    read: (settings) => formatTagList(settings.autoImportTags),
    write: (settings, value: string) => {
      settings.autoImportTags = parseTagList(value);
    },
  },
  autoImportMode: topLevel('autoImportMode'),
  autoImportOnFolder: topLevel('autoImportOnFolder'),
  // The list the watched folders row shows as chips; no declarative control
  // holds it (`drawWatchedFolders`)
  autoImportFolders: {
    read: (settings) => [...settings.autoImportFolders],
    write: (settings, value: string[]) => {
      settings.autoImportFolders = cleanFolderList(value);
    },
  },
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

/**
 * Why `typed` can't be the trigger tags, if it can't. Snippet and card tags
 * are refused because notes carrying them are never imported, so they could
 * only ever fail. An empty list is refused only while importing by tag is on,
 * where it would quietly import nothing.
 */
function triggerTagsProblem(
  typed: string,
  importingByTag: boolean
): string | undefined {
  const tags = parseTagList(typed);
  const blocked = tags.filter((tag) => IMPORT_BLOCKED_TAGS.has(tag));
  if (blocked.length > 0) {
    return `Snippet and card tags can't be trigger tags: ${formatTagList(blocked)}`;
  }
  if (importingByTag && tags.length === 0) {
    return 'Enter at least one tag, or turn off importing notes by tag.';
  }
  return undefined;
}

/** The trigger tags row's name, by which its field is also found in the tab. */
const TRIGGER_TAGS_NAME = 'Trigger tags';

/**
 * `target` if it is the trigger tags field: an input in the row named
 * {@link TRIGGER_TAGS_NAME}. Found through Obsidian's `setting-item` classes,
 * since the declarative tab hands out no element for a control.
 */
function triggerTagsInput(target: Element): HTMLInputElement | undefined {
  // Not `instanceof HTMLInputElement`: settings open in a window of their
  // own, whose element classes are not this one's.
  if (!target.matches('input')) return undefined;
  const name = target
    .closest('.setting-item')
    ?.querySelector('.setting-item-name')?.textContent;
  return name === TRIGGER_TAGS_NAME ? (target as HTMLInputElement) : undefined;
}

/**
 * Rewrites the trigger tags field, if `event` is on it, as its tags read: each
 * after a `#`, separated by single spaces.
 *
 * Only once the user is done with it. Obsidian's text control saves on every
 * keystroke, and rewriting then would eat the space typed before a new tag.
 * Assigning `value` fires no `input` event, so nothing is saved or checked
 * again; nothing needs to be, since the text reads as the same tags.
 */
function tidyTriggerTags(event: Event) {
  // An element: the listeners are on one, so only elements reach them
  const input = triggerTagsInput(event.target as Element);
  if (input) input.value = formatTagList(parseTagList(input.value));
}

/** The watched folders row's name. */
export const WATCHED_FOLDERS_NAME = 'Watched folders';

/**
 * The watched folders field's example: a folder's path, cased as its names
 * are, which isn't a sentence for sentence case to apply to.
 */
const FOLDER_PLACEHOLDER = 'Reading/Inbox';

/** Marks the watched folders row, whose control holds its chips too. */
export const FOLDER_LIST_ROW_CLASS = 'ir-folder-list-row';

/** Marks the list of watched folders under the row's field. */
export const FOLDER_CHIPS_CLASS = 'ir-folder-chips';

/** Marks one watched folder in that list. */
export const FOLDER_CHIP_CLASS = 'ir-folder-chip';

/** Marks a watched folder's path in its chip. */
export const FOLDER_CHIP_PATH_CLASS = 'ir-folder-chip-path';

/** Marks the button that stops watching a folder. */
export const FOLDER_CHIP_REMOVE_CLASS = 'ir-folder-chip-remove';

/** What the watched folders row needs of the tab. */
interface WatchedFoldersHost {
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): void | Promise<void>;
  /** Whether importing files added to folders is on now. */
  watching: () => boolean;
  /** Whether the vault holds a folder at `path` now. */
  isFolder: (path: string) => boolean;
}

/**
 * Draws the watched folders row into `setting`: a field above the folders
 * already watched, each a chip with a button that stops watching it. Enter in
 * the field adds the folder it names, if it can be watched, and clears it;
 * otherwise the row says why and keeps the text. Each change saves the whole
 * list through the tab's `autoImportFolders` binding.
 *
 * A row the tab draws, since no declarative control holds a list: Obsidian
 * (1.13.7) calls this each time it draws the row, in the tab or in the
 * settings search, so the chips go wherever the row does. Returns what puts
 * the row's message right for the list as it is now, which the tab calls when
 * watching is turned on or off.
 */
function drawWatchedFolders(
  setting: Setting,
  host: WatchedFoldersHost
): () => void {
  setting.setClass(FOLDER_LIST_ROW_CLASS);
  const folders = () => host.getControlValue('autoImportFolders') as string[];

  let input!: HTMLInputElement;
  setting.addText((text) => {
    text.setPlaceholder(FOLDER_PLACEHOLDER);
    input = text.inputEl;
  });
  // Under the whole row, not in the control: the chips take the row's full
  // width, below the name and the field (styles.css wraps the row)
  const list = setting.settingEl.createDiv({ cls: FOLDER_CHIPS_CLASS });

  /** Shows the list's problem, if it has one, in place of any other. */
  const checkList = () => {
    setting.setErrorMessage(
      watchListProblem(folders(), host.watching()) ?? null
    );
  };

  /** Saves `next` as the watched folders, and shows them. */
  const save = async (next: string[]) => {
    // Written before the save is awaited, so the chips show the new list
    const saving = host.setControlValue('autoImportFolders', next);
    drawChips();
    checkList();
    await saving;
  };

  const drawChips = () => {
    list.replaceChildren();
    for (const folder of folders()) {
      const chip = list.createDiv({ cls: FOLDER_CHIP_CLASS });
      chip.createSpan({ cls: FOLDER_CHIP_PATH_CLASS, text: folder });
      // `clickable-icon`, Obsidian's icon button, also keeps a narrow row's
      // rule from stretching every button in the control across it
      const remove = chip.createEl('button', {
        cls: ['clickable-icon', FOLDER_CHIP_REMOVE_CLASS],
        attr: { type: 'button', 'aria-label': `Remove ${folder}` },
      });
      setIcon(remove, 'lucide-x');
      remove.addEventListener('click', () => {
        const index = folders().indexOf(folder);
        // Only from a button that had focus, as a key press or a desktop
        // click gives it: focusing the field after a tap would open a
        // phone's keyboard
        const focused = remove.ownerDocument.activeElement === remove;
        void save(folders().filter((watched) => watched !== folder));
        if (!focused) return;
        const buttons = list.querySelectorAll<HTMLElement>(
          `.${FOLDER_CHIP_REMOVE_CLASS}`
        );
        (buttons[Math.min(index, buttons.length - 1)] ?? input).focus();
      });
    }
  };

  /** Adds the folder the field names, or says why it can't. */
  const add = () => {
    if (input.value.trim() === '') return;
    const folder = normalizeFolderPath(input.value);
    const problem = folderToWatchProblem(folder, host.isFolder);
    if (problem) {
      setting.setErrorMessage(problem);
      return;
    }
    input.value = '';
    if (folders().includes(folder)) {
      checkList();
      return;
    }
    void save([...folders(), folder]);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    add();
  });
  // The field's message is about what was typed, so it goes once that changes
  input.addEventListener('input', checkList);

  drawChips();
  checkList();
  return checkList;
}

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
 * named for its scope alone. With a `control` of its own, the head row holds
 * it, and the rows beneath are the setting's details.
 */
export interface SettingBox<K extends string = string> {
  type: 'box';
  name: string;
  desc: string;
  control?: SettingDefinitionControl<K>['control'];
  items: (SettingDefinitionControl<K> | SettingDefinitionRender)[];
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
      const { name, desc, control } = item;
      groups.push({
        type: 'group',
        cls: SETTING_BOX_CLASS,
        items: [
          control ? { name, desc, control } : { name, desc },
          ...item.items,
        ],
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

/** A control's default: the default setting, as the control shows it. */
const shownDefault = <K extends ControlKey>(
  key: K
): ReturnType<(typeof CONTROL_BINDINGS)[K]['read']> =>
  CONTROL_BINDINGS[key].read(DEFAULT_SETTINGS) as ReturnType<
    (typeof CONTROL_BINDINGS)[K]['read']
  >;

/**
 * A number or text control with a default. Obsidian (1.13.7) draws a reset
 * button for a slider or colour control with a `defaultValue`, but never for
 * these, so the tab draws them itself: see {@link drawResettableRows}.
 */
type ResettableControl<K extends string> =
  | (SettingNumberControl<K> & { defaultValue: number })
  | (SettingTextControl<K> & { defaultValue: string });

const isResettable = <K extends string>(
  control: SettingControl<K>
): control is ResettableControl<K> =>
  (control.type === 'number' || control.type === 'text') &&
  control.defaultValue !== undefined;

/** What a row the tab draws itself needs of the tab: Obsidian's binding. */
interface ControlHost {
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): void | Promise<void>;
  refreshDomState(): void;
}

/**
 * `groups` with each number and text control that has a default turned into a
 * row the tab draws itself ({@link drawResettable}), so it can carry the reset
 * button Obsidian gives a slider. Every other row is left to Obsidian.
 */
export function drawResettableRows<K extends string>(
  groups: SettingDefinitionGroup<K>[],
  host: ControlHost
): SettingDefinitionGroup<K>[] {
  return groups.map((group) => ({
    ...group,
    items: group.items?.map((item): SettingGroupItem<K> => {
      if ('type' in item || !item.control || !isResettable(item.control)) {
        return item;
      }
      const { control, ...row } = item;
      return {
        ...row,
        // Undocumented: a `render` row has no `disabled` in obsidian.d.ts, but
        // `refreshDomState` reads one off any row (obsidian.asar 1.13.7)
        ...(control.disabled !== undefined && { disabled: control.disabled }),
        render: (setting) => drawResettable(setting, control, host),
      };
    }),
  }));
}

/**
 * Draws `control` into `setting` as Obsidian (1.13.7) draws its declarative
 * control, behind a reset button drawn as Obsidian draws a slider's: the same
 * icon and tooltip, added before the control, and `aria-disabled` while the
 * field shows the default. A click while it does is a no-op, as the slider's
 * `setValue` is; otherwise it puts the default in the field and saves it as an
 * edit would, which clears any error. Undocumented: ported from the
 * declarative renderer in obsidian.asar.
 */
function drawResettable<K extends string>(
  setting: Setting,
  control: ResettableControl<K>,
  host: ControlHost
) {
  const { key, validate } = control;
  // Only ever handed the type of value its own control holds
  const check = (value: unknown) => validate?.(value as never);
  /** Shows the problem with `value`, or saves it, as Obsidian's control does. */
  const apply = async (value: string | number) => {
    const problem = await check(value);
    if (problem) {
      setting.setErrorMessage(problem);
      return;
    }
    setting.setErrorMessage(null);
    await host.setControlValue(key, value);
    host.refreshDomState();
  };
  const value = host.getControlValue(key) ?? control.defaultValue;
  void (async () => {
    const problem = await check(value);
    if (problem) setting.setErrorMessage(problem);
  })();

  const defaultText = String(control.defaultValue);
  let reset!: ExtraButtonComponent;
  setting.addExtraButton((button) => {
    reset = button
      .setIcon('lucide-rotate-ccw')
      .setTooltip('Restore default')
      .onClick(() => {
        if (field.inputEl.value === defaultText) return;
        field.inputEl.value = defaultText;
        markDefault();
        field.commit();
      });
  });
  // Once the field exists, as this follows it
  const shown = () => markDefault();
  const field =
    control.type === 'number'
      ? drawNumberField(setting, control, value, apply, shown)
      : drawTextField(setting, control, value, apply);
  const markDefault = () =>
    reset.extraSettingsEl.setAttribute(
      'aria-disabled',
      String(field.inputEl.value === defaultText)
    );
  // On leaving and keys too: the tab may tidy the field then, firing no
  // `input` (`tidyTriggerTags`)
  for (const type of ['input', 'focusout', 'keydown']) {
    field.inputEl.addEventListener(type, markDefault);
  }
  markDefault();
}

/** A field drawn by {@link drawResettable}, and how it saves what it shows. */
interface DrawnField {
  inputEl: HTMLInputElement;
  /** Saves what the field shows, as finishing an edit in it would. */
  commit: () => void;
}

/** Obsidian's text control: saves on each keystroke. */
function drawTextField(
  setting: Setting,
  control: SettingTextControl,
  value: unknown,
  apply: (value: string) => Promise<void>
): DrawnField {
  let inputEl!: HTMLInputElement;
  setting.addText((text) => {
    if (control.placeholder) text.setPlaceholder(control.placeholder);
    text.setValue(String(value)).onChange((typed) => {
      void apply(typed);
    });
    inputEl = text.inputEl;
  });
  return { inputEl, commit: () => void apply(inputEl.value) };
}

/**
 * Obsidian's number control: saves once entered or left, a blank field as the
 * default, and puts back what was last saved on Escape. Its own messages, in
 * English, as this plugin is.
 */
function drawNumberField(
  setting: Setting,
  control: SettingNumberControl & { defaultValue: number },
  value: unknown,
  apply: (value: number) => Promise<void>,
  /** Called after the field changes what it shows by itself. */
  shown: () => void
): DrawnField {
  // Obsidian's number input is a text component typed `number`; `addText`
  // would also blur it on Enter without a physical keyboard, as on a phone.
  let input!: TextComponent;
  setting.addComponent((el) => (input = new TextComponent(el)));
  const { inputEl } = input;
  inputEl.type = 'number';
  inputEl.inputMode = 'decimal';
  if (control.placeholder) input.setPlaceholder(control.placeholder);
  if (control.min !== undefined) inputEl.min = String(control.min);
  if (control.max !== undefined) inputEl.max = String(control.max);
  inputEl.step = String(control.step ?? 'any');

  let saved = typeof value === 'number' && !Number.isNaN(value) ? value : null;
  const show = (number: number | null) => {
    inputEl.value = number === null ? '' : String(number);
  };
  show(saved);

  /** Saves what the field shows, if it can be; says whether it was. */
  const commit = () => {
    if (inputEl.value === '') {
      saved = control.defaultValue;
      show(saved);
      shown();
    } else {
      // Never NaN, where Obsidian checks: a number input holds '' for
      // anything typed that isn't a number.
      const typed = parseFloat(inputEl.value);
      if (control.min !== undefined && typed < control.min) {
        setting.setErrorMessage(`Value must be at least ${control.min}`);
        return false;
      }
      if (control.max !== undefined && typed > control.max) {
        setting.setErrorMessage(`Value must be at most ${control.max}`);
        return false;
      }
      saved = typed;
    }
    void apply(saved);
    return true;
  };
  inputEl.addEventListener('blur', commit);
  inputEl.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commit()) inputEl.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      show(saved);
      shown();
      setting.setErrorMessage(null);
      inputEl.blur();
    }
  });
  return { inputEl, commit };
}

/**
 * The plugin's settings tab, described declaratively by
 * {@link getSettingDefinitions}. Obsidian (1.13.1+, which `minAppVersion` covers) renders
 * the rows, runs each control's `validate` and shows its message inline, and
 * reads and writes values through {@link getControlValue} and
 * {@link setControlValue}. The rows that carry a reset button Obsidian doesn't
 * draw are drawn by the tab instead, the same way: see {@link drawResettableRows}.
 */
export class IRSettingTab extends PluginSettingTab {
  plugin: IncrementalReadingPlugin;
  /**
   * Each drawn watched folders row, by its element, and what puts its message
   * right, for when watching is turned on or off: its toggle is a row of its
   * own. There may be more than one, as the settings search draws rows too.
   */
  readonly #watchListChecks = new Map<HTMLElement, () => void>();

  constructor(app: App, plugin: IncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Obsidian gives the tab's container no per-tab class, and it is the
    // element shown in the settings window, so this scopes styles.css's
    // settings rules to this tab alone.
    this.containerEl.classList.add(SETTINGS_TAB_CLASS);
    // On the container, which outlives each render of the rows. `focusout`
    // bubbles where `blur` doesn't. Capturing, so the field's own listeners,
    // its reset button's mark among them, see the tidied text.
    this.containerEl.addEventListener('focusout', tidyTriggerTags, true);
    this.containerEl.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter' && !event.isComposing) tidyTriggerTags(event);
      },
      true
    );
  }

  getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
    return drawResettableRows(this.declareSettings(), this);
  }

  /**
   * The tab as declared, every row a declarative control. Obsidian draws them,
   * but for those {@link drawResettableRows} draws instead.
   */
  declareSettings(): SettingDefinitionGroup<ControlKey>[] {
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
          {
            type: 'box',
            name: 'Auto-import notes by tag',
            desc:
              'Automatically import any note when one of the trigger ' +
              'tags is added to frontmatter. Tags in the note body are ignored. Does not affect notes that already have a matching tag.',
            control: { type: 'toggle', key: 'autoImportOnTag' },
            items: [
              {
                name: TRIGGER_TAGS_NAME,
                control: {
                  type: 'text',
                  key: 'autoImportTags',
                  defaultValue: shownDefault('autoImportTags'),
                  // Read when checked, so the toggle as it is now decides
                  validate: (typed) =>
                    triggerTagsProblem(
                      typed,
                      this.plugin.settings.autoImportOnTag
                    ),
                },
              },
              {
                name: 'Where to import tagged notes',
                control: {
                  type: 'dropdown',
                  key: 'autoImportMode',
                  options: AUTO_IMPORT_MODE_OPTIONS,
                },
              },
            ],
          },
          {
            type: 'box',
            name: 'Auto-import files added to folders',
            desc:
              'Automatically import any note or PDF when it is added to a ' +
              'watched folder or its subfolders: created there, moved in, or ' +
              'synced from another device. Files already there are not ' +
              'imported, nor are notes un-imported while there. Use "Import ' +
              'from folder…" for those. "Where to import tagged notes" ' +
              'applies here too.',
            control: { type: 'toggle', key: 'autoImportOnFolder' },
            items: [
              {
                name: WATCHED_FOLDERS_NAME,
                render: (setting) => {
                  const checkList = drawWatchedFolders(setting, {
                    getControlValue: (key) => this.getControlValue(key),
                    setControlValue: (key, value) =>
                      this.setControlValue(key, value),
                    // Read when checked, so the toggle and the vault as they
                    // are now decide
                    watching: () => this.plugin.settings.autoImportOnFolder,
                    isFolder: (path) =>
                      this.plugin.app.vault.getFolderByPath(path) !== null,
                  });
                  this.#watchListChecks.set(setting.settingEl, checkList);
                  return () => {
                    this.#watchListChecks.delete(setting.settingEl);
                  };
                },
              },
            ],
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
              ' Minimal shows only undos and imports.' +
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
              'Adjust the end time of the review day.' +
              ' Set this to the time you are most likely to be asleep.',
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
            desc: `Ceiling on the number of days between card reviews.`,
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
            desc: `FSRS learning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas.`,
            control: {
              type: 'text',
              key: 'fsrsParams.learning_steps',
              defaultValue: shownDefault('fsrsParams.learning_steps'),
              validate: validateSteps,
            },
          },
          {
            name: 'Relearning steps',
            desc: `FSRS relearning steps, formatted like "3m"/"2h"/"1d". Separate steps with commas.`,
            control: {
              type: 'text',
              key: 'fsrsParams.relearning_steps',
              defaultValue: shownDefault('fsrsParams.relearning_steps'),
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
    if (key === 'autoImportOnFolder') {
      for (const [row, checkList] of this.#watchListChecks) {
        // Obsidian may not clean up a row whose window closed
        if (row.isConnected) checkList();
        else this.#watchListChecks.delete(row);
      }
    }
    await this.plugin.saveSettings();

    if (key === 'showAdvancedImportCommands') {
      this.plugin.toggleAdvancedCommands(
        this.plugin.settings.showAdvancedImportCommands
      );
    }
  }
}
