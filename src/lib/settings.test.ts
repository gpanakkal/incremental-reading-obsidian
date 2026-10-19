// @vitest-environment jsdom
import type IncrementalReadingPlugin from '#/main';
import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  App,
  SettingControl as DeclaredControl,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  SettingNumberControl,
} from 'obsidian';
import type { StepUnit } from 'ts-fsrs';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The mock is what `obsidian` resolves to at runtime (see vitest.config.ts);
// imported by path for its writable `Platform`.
import { Platform, Setting, TFolder } from '#/test/__mocks__/obsidian';
import {
  AUTO_IMPORT_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  SNIPPET_TAG,
} from './constants';
import type { IRPluginData } from './plugin-data';
import {
  AUTO_IMPORT_MODE_OPTIONS,
  CONTINUED_GROUP_CLASS,
  DEFAULT_SETTINGS,
  drawResettableRows,
  FOLDER_CHIP_CLASS,
  FOLDER_CHIP_PATH_CLASS,
  FOLDER_CHIPS_CLASS,
  FOLDER_LIST_ROW_CLASS,
  formatPriority,
  formatRetention,
  formatRolloverHour,
  IRSettingTab,
  layOutGroups,
  parseSteps,
  REVIEW_TITLE_BAR_OPTIONS,
  SETTING_BOX_CLASS,
  SETTINGS_TAB_CLASS,
  SUCCESS_NOTICE_LEVEL_OPTIONS,
  WATCHED_FOLDERS_NAME,
  type IRPluginSettings,
  type SettingBox,
  type SettingGroupLayout,
} from './settings';
import { parseTagList } from './tags';
import {
  cleanFolderList,
  folderToWatchProblem,
  normalizeFolderPath,
  watchListProblem,
} from './watched-folders';

// #region HELPERS

const STEP_PATTERN = /^[1-9]\d*[mhd]$/;

/** Each review title bar choice, as stored. */
const REVIEW_TITLE_BARS = ['obsidian', 'show', 'hide'] as const;

/** Each success notice level, as stored. */
const SUCCESS_NOTICE_LEVELS = ['all', 'minimal', 'none'] as const;

/** Each way of importing a note by its trigger tag, as stored. */
const AUTO_IMPORT_MODES = ['inPlace', 'copy', 'inherit'] as const;

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
    autoImportOnTag: fc.boolean(),
    autoImportTags: fc.array(textArb()),
    autoImportMode: fc.constantFrom(...AUTO_IMPORT_MODES),
    autoImportOnFolder: fc.boolean(),
    autoImportFolders: fc.array(textArb()),
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
function makeTab(
  settings: IRPluginSettings,
  folders: Iterable<string> = [],
  vaultTags: readonly string[] = []
) {
  const folderPaths = new Set(folders);
  const data: IRPluginData = {
    settings,
    session: { deviceId: 'device-a', itemId: 'item-1' },
    warnedRefusedPaths: ['a|b.md'],
    ui: { folderImportIncludeSubfolders: true },
  };
  const saved: IRPluginData[] = [];
  const events: string[] = [];
  const plugin = {
    app: {
      vault: {
        getFolderByPath: (path: string): { path: string } | null =>
          folderPaths.has(path) ? { path } : null,
        // As Obsidian's: the root only when asked for
        getAllFolders: (includeRoot?: boolean) =>
          [...(includeRoot === true ? ['/'] : []), ...folderPaths].map((path) =>
            Object.assign(new TFolder(), {
              path,
              name: path.slice(path.lastIndexOf('/') + 1),
            })
          ),
      },
    },
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
  // Every tag in the vault, as `getTags` keys them, for the tag suggestions
  const app = {
    metadataCache: {
      getTags: () => Object.fromEntries(vaultTags.map((tag) => [tag, 1])),
    },
  } as unknown as App;
  const tab = new IRSettingTab(
    app,
    plugin as unknown as IncrementalReadingPlugin
  );
  return { tab, plugin, saved, events };
}

type RowDefinition = {
  heading: string;
  name: string;
  desc?: string | DocumentFragment;
  control?: DeclaredControl;
  /** How the tab draws the row itself, if it does. */
  render?: unknown;
};

type ControlDefinition = RowDefinition & { control: DeclaredControl };

/**
 * Each row, under the heading it shows beneath: a group with no heading of its
 * own continues the section above it. A row is a control, a row the tab draws
 * itself, or a bare name and description; fails on anything else.
 */
function declaredSettingRows(items: SettingDefinitionItem[]): RowDefinition[] {
  let heading = '';
  return items.flatMap((item) => {
    if (!('type' in item) || item.type !== 'group') {
      throw new Error(`Expected a group, got ${JSON.stringify(item)}`);
    }
    heading = item.heading ?? heading;
    return (item.items ?? []).map((definition) => {
      if ('type' in definition || definition.action) {
        throw new Error(
          `Expected a control or a bare row, got ${JSON.stringify(definition)}`
        );
      }
      return {
        heading,
        name: definition.name,
        desc: definition.desc,
        control: definition.control,
        ...(definition.render && { render: definition.render }),
      };
    });
  });
}

/** Each control definition, under the heading it shows beneath. */
const declaredRows = (items: SettingDefinitionItem[]): ControlDefinition[] =>
  declaredSettingRows(items).filter(
    (row): row is ControlDefinition => row.control !== undefined
  );

/**
 * The declarative tab's controls, which don't depend on the settings' values.
 * Read when a test runs, never at import: a suite that fails to load reports no
 * failing test, so Stryker would score a broken tab as a surviving mutant.
 */
const declaredControls = () =>
  declaredRows(
    makeTab(structuredClone(DEFAULT_SETTINGS)).tab.declareSettings()
  );

/** A tag the trigger tags field can't take, written any way it reads as. */
const blockedTagArb = fc
  .tuple(
    fc.constantFrom(SNIPPET_TAG, CARD_TAG),
    fc.constantFrom('', '#'),
    fc.boolean()
  )
  .map(([tag, hash, upper]) => hash + (upper ? tag.toUpperCase() : tag));

/** A folder's vault path, often one of a few, so typed paths name them. */
const folderArb = fc.oneof(
  fc.constantFrom(
    'Inbox',
    'Reading/Inbox',
    'a, b',
    DATA_DIRECTORY,
    `${DATA_DIRECTORY}/x`
  ),
  textArb()
);

/**
 * What might be typed into the watched folders field: a folder, padded with
 * slashes and spaces or not; the root; nothing; or anything.
 */
const typedFolderArb = fc.oneof(
  folderArb,
  fc
    .tuple(
      fc.constantFrom('', ' ', '/', ' /'),
      folderArb,
      fc.constantFrom('', '/', ' ', '/ ')
    )
    .map((parts) => parts.join('')),
  fc.constantFrom('/', '//', ' ', '', 'Inbox, Reading/Inbox'),
  textArb()
);

/**
 * Any typed trigger tags field: tags, blocked ones among them or not, between
 * any separators; nothing but separators; or anything.
 */
const typedTriggerTagsArb = fc.oneof(
  fc
    .array(
      fc.oneof(
        fc.constantFrom(AUTO_IMPORT_TAG, '#to-read', 'Clipped'),
        blockedTagArb,
        fc.stringMatching(/^[\s,#]*$/),
        textArb()
      ),
      { maxLength: 5 }
    )
    .chain((tags) =>
      fc
        .array(fc.constantFrom(',', ', ', ' ', '\n', ' , ', ''), {
          minLength: tags.length,
          maxLength: tags.length,
        })
        .map((seps) => tags.map((tag, i) => tag + seps[i]).join(''))
    ),
  fc.stringMatching(/^[\s,#]*$/),
  textArb()
);

/** Keys pressed while typing: anything but Enter, separators and `#` among them. */
const typingKeyArb = fc
  .oneof(
    fc.constantFrom(' ', ',', '#', 'a', 'Backspace', 'Tab', 'Shift', 'Escape'),
    fc.string({ minLength: 1, maxLength: 3 })
  )
  .filter((key) => key !== 'Enter');

/** Whether `text` shows the whole number `n`, not just digits inside another. */
const showsInteger = (text: string | null | undefined, n: number) =>
  (text ?? '').match(/-?\d+/g)?.includes(String(n)) ?? false;

/** The trigger tags row's name, as the tab declares it. */
const TRIGGER_TAGS = 'Trigger tags';

/**
 * A row as Obsidian's `Setting` draws a text control, named `name` (none if
 * undefined), holding `typed`, in `tab`'s container. Returns its field, whose
 * value is `typed` as the field holds it: an input drops line breaks.
 */
function addTextRow(
  tab: IRSettingTab,
  name: string | undefined,
  typed: string,
  tagName: 'input' | 'textarea' = 'input'
) {
  const row = tab.containerEl.appendChild(document.createElement('div'));
  row.className = 'setting-item';
  const info = row.appendChild(document.createElement('div'));
  info.className = 'setting-item-info';
  if (name !== undefined) {
    const nameEl = info.appendChild(document.createElement('div'));
    nameEl.className = 'setting-item-name';
    nameEl.textContent = name;
  }
  const control = row.appendChild(document.createElement('div'));
  control.className = 'setting-item-control';
  const field = control.appendChild(document.createElement(tagName));
  field.value = typed;
  return field;
}

/** Ways to be done with a field: leave it, or press Enter in it. */
type Commit = 'leave' | 'enter';
const commitArb = fc.constantFrom<Commit>('leave', 'enter');

/** Be done with `field` the way `commit` says, as the user would. */
function commitField(field: HTMLElement, commit: Commit) {
  field.focus();
  if (commit === 'leave') {
    field.blur();
  } else {
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
  }
}

/** A tab whose container is in the document, so its fields can take focus. */
function makeAttachedTab(vaultTags: readonly string[] = []) {
  const made = makeTab(structuredClone(DEFAULT_SETTINGS), [], vaultTags);
  document.body.replaceChildren(made.tab.containerEl);
  return made;
}

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

/** Any row a group can hold that isn't a box: a control, a bare row, a page. */
const groupRowArb = fc.oneof(
  fc.record({
    name: textArb(),
    control: fc.record({
      type: fc.constant('toggle' as const),
      key: textArb(),
    }),
  }),
  fc.record({ name: textArb(), desc: textArb() }),
  fc.record({ type: fc.constant('page' as const), name: textArb() })
);

/** Any toggle a row can hold. */
const toggleControlArb = fc.record({
  type: fc.constant('toggle' as const),
  key: textArb(),
});

/** Any box, with a control of its own or not, including one with no rows. */
const boxArb: fc.Arbitrary<SettingBox> = fc.record(
  {
    type: fc.constant('box' as const),
    name: textArb(),
    desc: textArb(),
    control: toggleControlArb,
    items: fc.array(fc.record({ name: textArb(), control: toggleControlArb }), {
      maxLength: 3,
    }),
  },
  { requiredKeys: ['type', 'name', 'desc', 'items'] }
);

/** Any group as the tab declares it: rows and boxes in any order, any heading. */
const groupLayoutArb: fc.Arbitrary<SettingGroupLayout> = fc.record({
  type: fc.constant('group' as const),
  heading: fc.option(textArb(), { nil: undefined }),
  items: fc.array(fc.oneof(groupRowArb, boxArb), { maxLength: 8 }),
});

const isBox = (item: SettingGroupLayout['items'][number]): item is SettingBox =>
  'type' in item && item.type === 'box';

/**
 * The rows a box shows: its name and description, with its control if it has
 * one, then its own rows.
 */
const boxRows = (box: SettingBox) => [
  box.control
    ? { name: box.name, desc: box.desc, control: box.control }
    : { name: box.name, desc: box.desc },
  ...box.items,
];

/** The classes Obsidian adds to a group's element, from its `cls`. */
const classesOf = (group: SettingDefinitionItem) =>
  ('cls' in group ? (group.cls ?? '') : '').split(' ').filter(Boolean);

/**
 * The declared rows the tab draws itself, to give them a reset button: number
 * and text controls with a default.
 */
const resettableRows = () =>
  declaredControls().filter(
    ({ control }) =>
      (control.type === 'number' || control.type === 'text') &&
      control.defaultValue !== undefined
  );

/** The default a row's field shows, as its control declares it. */
const defaultText = ({ control }: ControlDefinition) =>
  String(control.defaultValue);

/**
 * Lets every pending check and save run: each is a short chain of promises
 * that settle at once, so microtasks are enough, and far quicker than a timer.
 */
async function settle() {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

/**
 * The row named `name` as `tab` hands it to Obsidian, drawn as Obsidian draws a
 * `render` row: into a new `Setting` in the tab's container, already named.
 * Fails if the tab doesn't draw that row itself.
 */
function drawRow(tab: IRSettingTab, name: string) {
  const row = tab
    .getSettingDefinitions()
    .flatMap((item) => ('items' in item ? (item.items ?? []) : []))
    .find((item) => 'name' in item && item.name === name);
  if (!row || 'type' in row || !row.render) {
    throw new Error(`The tab doesn't draw ${name} itself`);
  }
  const setting = new Setting(tab.containerEl).setName(name);
  row.render(setting as never, {} as never);
  const field = setting.controlEl.querySelector('input');
  const reset = setting.controlEl.querySelector('.extra-setting-button');
  if (!field || !(reset instanceof HTMLElement)) {
    throw new Error(`${name} has no field or reset button`);
  }
  return { setting, field, reset };
}

/** Type `typed` into a drawn text field, as the user would. */
function typeInto(field: HTMLInputElement, typed: string) {
  field.value = typed;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Anything typed into a number field: numbers of every shape, or not. */
const typedNumberArb = fc.oneof(
  fc.integer().map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map(String),
  fc.constantFrom('', '0', '1', '2', '-3', '1.5', '36500', '1e3'),
  textArb()
);

/** What the user might type into a drawn row's field. */
const userEditArb = (control: DeclaredControl) =>
  control.type === 'number' ? typedNumberArb : typedFieldArb;

/**
 * Change a drawn row's field as the user would: type into a text field, or
 * type into a number field and leave it.
 */
function editField(
  control: DeclaredControl,
  field: HTMLInputElement,
  typed: string
) {
  if (control.type === 'number') {
    field.value = typed;
    field.dispatchEvent(new FocusEvent('blur'));
  } else {
    typeInto(field, typed);
  }
}

/**
 * `control` drawn as `drawResettableRows` hands it to Obsidian, in a row named
 * `name` in the document, bound through `host`.
 */
function drawControl(
  control: DeclaredControl,
  host: Parameters<typeof drawResettableRows>[1]
) {
  const [group] = drawResettableRows(
    [{ type: 'group', items: [{ name: 'Drawn', control }] }],
    host
  );
  const [row] = group.items ?? [];
  if ('type' in row || !row.render) throw new Error('Not drawn');
  const setting = new Setting(
    document.body.appendChild(document.createElement('div'))
  );
  row.render(setting as never, {} as never);
  const field = setting.controlEl.querySelector('input');
  if (!field) throw new Error('No field');
  return { row, setting, field };
}

/**
 * The box the tab declares whose head row is named `name`, wherever it puts
 * it among the others.
 */
const boxHeadedBy = (tab: IRSettingTab, name: string) =>
  tab
    .declareSettings()
    .filter((item) => classesOf(item).includes(SETTING_BOX_CLASS))
    .find((box) => {
      const head = 'items' in box ? box.items?.[0] : undefined;
      return head !== undefined && 'name' in head && head.name === name;
    });

/**
 * The watched folders row as `tab` hands it to Obsidian, drawn as Obsidian
 * draws a `render` row: into a new `Setting` in the tab's container, already
 * named, with the container in the document so the row's buttons take focus.
 */
function drawWatchedFolders(tab: IRSettingTab) {
  const row = tab
    .getSettingDefinitions()
    .flatMap((item) => ('items' in item ? (item.items ?? []) : []))
    .find((item) => 'name' in item && item.name === WATCHED_FOLDERS_NAME);
  if (!row || 'type' in row || !row.render) {
    throw new Error("The tab doesn't draw the watched folders itself");
  }
  if (!tab.containerEl.isConnected) document.body.append(tab.containerEl);
  const setting = new Setting(tab.containerEl).setName(WATCHED_FOLDERS_NAME);
  const cleanup = row.render(setting as never, {} as never);
  const field = setting.controlEl.querySelector('input');
  if (!field) throw new Error('The watched folders row has no field');
  const chipEls = () => [
    ...setting.settingEl.querySelectorAll<HTMLElement>(
      `.${FOLDER_CHIPS_CLASS} > .${FOLDER_CHIP_CLASS}`
    ),
  ];
  return {
    setting,
    field,
    cleanup: () => cleanup?.(),
    /** Each chip's folder, as it reads, in order. */
    chips: () =>
      chipEls().map(
        (chip) => chip.querySelector(`.${FOLDER_CHIP_PATH_CLASS}`)?.textContent
      ),
    /** Each chip's button, in order. */
    buttons: () =>
      chipEls().map((chip) => {
        const button = chip.querySelector('button');
        if (!button) throw new Error('A chip has no button');
        return button;
      }),
    /** The message the row shows, if it shows one. */
    message: () =>
      setting.settingEl.classList.contains('is-invalid')
        ? setting.errorEl?.textContent
        : undefined,
  };
}

/** Press Enter in `field`, as the user would; returns the key's event. */
function pressEnter(field: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  field.dispatchEvent(event);
  return event;
}

/** Settings watching `folders`, kept as the tab keeps them, and `watching`. */
function watchingSettings(folders: string[], watching: boolean) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    autoImportOnFolder: watching,
    autoImportFolders: cleanFolderList(folders),
  };
}

/** A watched folders list as stored: any folders, each once. */
const storedFoldersArb = fc
  .array(folderArb, { maxLength: 4 })
  .map(cleanFolderList);

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
          autoImportOnTag: tab.getControlValue('autoImportOnTag'),
          autoImportTags: tab.getControlValue('autoImportTags'),
          autoImportMode: tab.getControlValue('autoImportMode'),
          autoImportOnFolder: tab.getControlValue('autoImportOnFolder'),
          autoImportFolders: tab.getControlValue('autoImportFolders'),
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
          autoImportOnTag: settings.autoImportOnTag,
          autoImportTags: settings.autoImportTags
            .map((tag) => `#${tag}`)
            .join(' '),
          autoImportMode: settings.autoImportMode,
          autoImportOnFolder: settings.autoImportOnFolder,
          autoImportFolders: settings.autoImportFolders,
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
      ['autoImportOnTag', fc.boolean()],
      ['autoImportMode', fc.constantFrom(...AUTO_IMPORT_MODES)],
      ['autoImportOnFolder', fc.boolean()],
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

  it('stores trigger tags typed as a list as the tags in it', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        typedTriggerTagsArb,
        async (generated, typed) => {
          const settings = buildSettings(generated);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);

          await tab.setControlValue('autoImportTags', typed);

          expect(plugin.settings).toEqual({
            ...before,
            autoImportTags: parseTagList(typed),
          });
        }
      )
    );
  });

  it('stores a list of watched folders as the folders it names, each once', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.array(typedFolderArb, { maxLength: 5 }),
        async (generated, folders) => {
          const settings = buildSettings(generated);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);

          await tab.setControlValue('autoImportFolders', folders);

          expect(plugin.settings).toEqual({
            ...before,
            autoImportFolders: cleanFolderList(folders),
          });
        }
      )
    );
  });

  it('saves the whole plugin data once the edit is applied', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, editsArb(), async (generated, edits) => {
        const { tab, plugin, saved } = makeTab(buildSettings(generated));
        const rows = declaredRows(tab.declareSettings());

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
        const rows = declaredRows(tab.declareSettings());
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

  it('names every way of importing a note by tag in its dropdown', () => {
    const [control] = declaredControls()
      .map((row) => row.control)
      .filter((row) => row.key === 'autoImportMode');

    expect(control).toMatchObject({ type: 'dropdown' });
    expect(control.type === 'dropdown' && control.options).toEqual(
      AUTO_IMPORT_MODE_OPTIONS
    );
    expect(Object.keys(AUTO_IMPORT_MODE_OPTIONS)).toEqual(AUTO_IMPORT_MODES);
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
        const rows = declaredRows(tab.declareSettings());
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
      const definitions = tab.declareSettings();
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

  it('lists every setting in order, each with its control', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const validate = expect.any(Function) as unknown;
    const disabled = expect.any(Function) as unknown;
    const toggle = (key: string) => ({ type: 'toggle', key });

    expect(
      declaredSettingRows(tab.declareSettings()).map(({ control, render }) => ({
        control,
        render,
      }))
    ).toEqual([
      {
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
        control: toggle('showImportDialog'),
      },
      {
        control: toggle('copyOnImport'),
      },
      {
        control: toggle('createEmptyInCurrentFolder'),
      },
      {
        control: toggle('autoImportOnTag'),
      },
      {
        control: {
          type: 'text',
          key: 'autoImportTags',
          defaultValue: '#ir-import',
          validate,
        },
      },
      {
        control: {
          type: 'dropdown',
          key: 'autoImportMode',
          options: AUTO_IMPORT_MODE_OPTIONS,
        },
      },
      {
        control: toggle('autoImportOnFolder'),
      },
      {
        render: expect.any(Function) as unknown,
      },
      {},
      {
        control: {
          type: 'dropdown',
          key: 'successNoticesInReview',
          options: SUCCESS_NOTICE_LEVEL_OPTIONS,
        },
      },
      {
        control: {
          type: 'dropdown',
          key: 'successNoticesOutsideReview',
          options: SUCCESS_NOTICE_LEVEL_OPTIONS,
        },
      },
      {
        control: toggle('reviewReminders'),
      },
      {
        control: { ...toggle('remindDueArticles'), disabled },
      },
      {
        control: { ...toggle('remindDueSnippets'), disabled },
      },
      {
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
        control: toggle('fuzzTextReviews'),
      },
      {
        control: toggle('skipHomeScreen'),
      },
      {
        control: {
          type: 'dropdown',
          key: 'reviewTitleBar',
          options: REVIEW_TITLE_BAR_OPTIONS,
        },
      },
      {
        control: toggle('showAdvancedImportCommands'),
      },
      {
        control: toggle('showAdvancedImportMenuItems'),
      },
      {
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
        control: toggle('fsrsParams.enable_fuzz'),
      },
      {
        control: toggle('showGradeIntervals'),
      },
      {
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
        control: toggle('fsrsParams.enable_short_term'),
      },
      {
        control: {
          type: 'text',
          key: 'fsrsParams.learning_steps',
          defaultValue: '1m, 10m',
          validate,
        },
      },
      {
        control: {
          type: 'text',
          key: 'fsrsParams.relearning_steps',
          defaultValue: '10m',
          validate,
        },
      },
    ]);
  });

  it('names the data directory in the descriptions of the settings that write into it', () => {
    for (const key of ['copyOnImport', 'createEmptyInCurrentFolder']) {
      const row = declaredControls().find(({ control }) => control.key === key);
      expect(row?.desc).toContain(DATA_DIRECTORY);
    }
  });

  it('locks the reminder type toggles exactly while review reminders are off, following each change', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.array(fc.boolean(), { maxLength: 4 }),
        async (generated, flips) => {
          const { tab } = makeTab(buildSettings(generated));
          const locks = declaredRows(tab.declareSettings()).filter(
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

  it('draws importing by tag as one box: its toggle beside its description, then the trigger tags and where to import', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));

    expect(boxHeadedBy(tab, 'Auto-import notes by tag')).toStrictEqual({
      type: 'group',
      cls: `${SETTING_BOX_CLASS} ${CONTINUED_GROUP_CLASS}`,
      items: [
        {
          name: expect.any(String) as unknown,
          desc: expect.any(String) as unknown,
          control: { type: 'toggle', key: 'autoImportOnTag' },
        },
        {
          name: expect.any(String) as unknown,
          control: {
            type: 'text',
            key: 'autoImportTags',
            defaultValue: '#ir-import',
            validate: expect.any(Function) as unknown,
          },
        },
        {
          name: expect.any(String) as unknown,
          control: {
            type: 'dropdown',
            key: 'autoImportMode',
            options: AUTO_IMPORT_MODE_OPTIONS,
          },
        },
      ],
    });
  });

  it('draws watching folders as one box: its toggle beside its description, then the folders', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));

    expect(
      boxHeadedBy(tab, 'Auto-import files added to folders')
    ).toStrictEqual({
      type: 'group',
      cls: `${SETTING_BOX_CLASS} ${CONTINUED_GROUP_CLASS}`,
      items: [
        {
          name: expect.any(String) as unknown,
          desc: expect.any(String) as unknown,
          control: { type: 'toggle', key: 'autoImportOnFolder' },
        },
        {
          name: expect.any(String) as unknown,
          render: expect.any(Function) as unknown,
        },
      ],
    });
  });

  it('draws the success notices as one box: their description once, then a dropdown for each place', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));

    expect(boxHeadedBy(tab, 'Success notices')).toEqual({
      type: 'group',
      heading: expect.any(String) as unknown,
      cls: SETTING_BOX_CLASS,
      items: [
        {
          name: expect.any(String) as unknown,
          desc: expect.any(String) as unknown,
        },
        {
          name: expect.any(String) as unknown,
          control: {
            type: 'dropdown',
            key: 'successNoticesInReview',
            options: SUCCESS_NOTICE_LEVEL_OPTIONS,
          },
        },
        {
          name: expect.any(String) as unknown,
          control: {
            type: 'dropdown',
            key: 'successNoticesOutsideReview',
            options: SUCCESS_NOTICE_LEVEL_OPTIONS,
          },
        },
      ],
    });
  });

  it("saves the level picked on each line of the success notices box under that line's own key", async () => {
    const lines = declaredControls().filter(({ name }) =>
      ['Inside review', 'Outside review'].includes(name)
    );

    expect(lines.map(({ name, control }) => [name, control.key])).toEqual([
      ['Inside review', 'successNoticesInReview'],
      ['Outside review', 'successNoticesOutsideReview'],
    ]);
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.constantFrom(...lines),
        fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
        async (generated, { control }, level) => {
          const settings = buildSettings(generated);
          const after = { ...structuredClone(settings), [control.key]: level };
          const { tab, saved } = makeTab(settings);

          await tab.setControlValue(control.key, level);

          expect(tab.getControlValue(control.key)).toBe(level);
          expect(settings).toEqual(after);
          expect(saved.map((data) => data.settings)).toEqual([after]);
        }
      )
    );
  });

  it('shows each slider value in the units its description uses', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const sliders = declaredRows(tab.declareSettings())
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
    const keys = declaredRows(tab.declareSettings()).map(
      ({ control }) => control.key
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(tab.getControlValue(key)).toBeDefined();
    }
  });

  it('resets each control to the value default settings show', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const withDefaults = declaredRows(tab.declareSettings()).filter(
      ({ control }) => control.defaultValue !== undefined
    );

    expect(withDefaults.map(({ control }) => control.key)).toEqual([
      'defaultPriority',
      'autoImportTags',
      'dayRolloverOffset',
      'fsrsParams.request_retention',
      'fsrsParams.maximum_interval',
      'fsrsParams.learning_steps',
      'fsrsParams.relearning_steps',
    ]);
    for (const { control } of withDefaults) {
      expect(control.defaultValue).toBe(tab.getControlValue(control.key));
    }
  });

  it('accepts only well-formed steps', async () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const stepControls = declaredRows(tab.declareSettings())
      .map(({ control }) => control)
      .filter((control) => control.type === 'text')
      .filter((control) => control.key.startsWith('fsrsParams.'));

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

  it('accepts trigger tags unless one marks snippets or cards, or none are left while importing by tag is on', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        typedTriggerTagsArb,
        async (generated, typed) => {
          const settings = buildSettings(generated);
          const { tab } = makeTab(settings);
          const [control] = declaredRows(tab.declareSettings())
            .map((row) => row.control)
            .filter((row) => row.key === 'autoImportTags');

          const message = await control.validate?.(typed as never);

          const tags = parseTagList(typed);
          const blocked = tags.filter(
            (tag) => tag === SNIPPET_TAG || tag === CARD_TAG
          );
          if (blocked.length > 0) {
            for (const tag of blocked) expect(message).toContain(`#${tag}`);
          } else if (tags.length === 0 && settings.autoImportOnTag) {
            expect(message).toEqual(expect.stringMatching(/\S/));
          } else {
            expect(message).toBeFalsy();
          }
        }
      )
    );
  });

  it('checks for an empty list of trigger tags against the toggle as it is when the field is checked', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const { tab } = makeTab(settings);
    const [control] = declaredRows(tab.declareSettings())
      .map((row) => row.control)
      .filter((row) => row.key === 'autoImportTags');

    settings.autoImportOnTag = false;
    expect(await control.validate?.(' , ' as never)).toBeFalsy();
    settings.autoImportOnTag = true;
    expect(await control.validate?.(' , ' as never)).toEqual(
      expect.stringMatching(/\S/)
    );
    expect(await control.validate?.(AUTO_IMPORT_TAG as never)).toBeFalsy();
  });

  it('accepts only a whole number of days, at least one, as the maximum interval', async () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const [control] = declaredRows(tab.declareSettings())
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

describe('IRSettingTab reset buttons', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('draws each number and text setting with a default itself, and hands every other row to Obsidian as declared', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
    const drawn = new Set(resettableRows().map(({ name }) => name));

    expect(resettableRows().map(({ control }) => control.key)).toEqual([
      'autoImportTags',
      'fsrsParams.maximum_interval',
      'fsrsParams.learning_steps',
      'fsrsParams.relearning_steps',
    ]);
    // the same rows both times, so their functions compare equal
    const declared = tab.declareSettings();
    vi.spyOn(tab, 'declareSettings').mockReturnValue(declared);
    expect(tab.getSettingDefinitions()).toEqual(
      declared.map((group) => ({
        ...group,
        items: group.items?.map((row) => {
          if (!drawn.has(row.name) || !('control' in row)) return row;
          const { control: _control, ...rest } = row;
          return { ...rest, render: expect.any(Function) as unknown };
        }),
      }))
    );
  });

  it("puts a reset button before each drawn field, as Obsidian puts a slider's", () => {
    for (const row of resettableRows()) {
      const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));
      const { setting, field, reset } = drawRow(tab, row.name);

      expect([...setting.controlEl.children]).toEqual([reset, field]);
      expect(reset.className).toBe('clickable-icon extra-setting-button');
      expect(reset.querySelector('svg')?.classList).toContain(
        'lucide-rotate-ccw'
      );
      expect(reset.getAttribute('aria-label')).toBeTruthy();
      expect(field.type).toBe(row.control.type);
    }
  });

  it('restores a changed setting to its default, saving it once and clearing any error', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.constantFrom(...resettableRows()).chain((row) =>
          fc.record({
            row: fc.constant(row),
            typed: fc.option(userEditArb(row.control)),
          })
        ),
        async (generated, { row, typed }) => {
          const { tab, plugin } = makeTab(buildSettings(generated));
          const { setting, field, reset } = drawRow(tab, row.name);
          // as the field holds it: an input drops line breaks
          expect(field.value).toBe(
            String(tab.getControlValue(row.control.key)).replace(/[\r\n]/g, '')
          );
          if (typed !== null) editField(row.control, field, typed);
          await settle();
          fc.pre(field.value !== defaultText(row));
          plugin.saveSettings.mockClear();

          expect(reset.getAttribute('aria-disabled')).toBe('false');
          reset.click();
          await settle();

          expect(field.value).toBe(defaultText(row));
          expect(tab.getControlValue(row.control.key)).toBe(
            row.control.defaultValue
          );
          expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
          expect(setting.settingEl.classList).not.toContain('is-invalid');
          expect(reset.getAttribute('aria-disabled')).toBe('true');
        }
      )
    );
  });

  it("does nothing at the default, where its button is marked disabled as a slider's is", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom(...resettableRows())
          .chain((row) =>
            fc.record({ row: fc.constant(row), typed: typedFieldArb })
          ),
        async ({ row, typed }) => {
          const { tab, plugin } = makeTab(structuredClone(DEFAULT_SETTINGS));
          const { field, reset } = drawRow(tab, row.name);

          expect(reset.getAttribute('aria-disabled')).toBe('true');
          reset.click();
          await settle();
          expect(plugin.saveSettings).not.toHaveBeenCalled();
          expect(field.value).toBe(defaultText(row));

          // follows the field as it is typed in, before anything is saved
          field.value = typed;
          field.dispatchEvent(new Event('input'));
          expect(reset.getAttribute('aria-disabled')).toBe(
            String(field.value === defaultText(row))
          );
          field.value = defaultText(row);
          field.dispatchEvent(new Event('input'));
          expect(reset.getAttribute('aria-disabled')).toBe('true');
        }
      )
    );
  });

  it('saves a drawn text field on each keystroke, as Obsidian saves its own, unless its check fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        settingsArb,
        fc.constantFrom(
          ...resettableRows().filter(({ control }) => control.type === 'text')
        ),
        typedFieldArb,
        async (generated, row, typed) => {
          const settings = buildSettings(generated);
          const { tab, plugin } = makeTab(settings);
          const { setting, field } = drawRow(tab, row.name);
          await settle();
          const before = structuredClone(settings);
          plugin.saveSettings.mockClear();

          typeInto(field, typed);
          // as the field holds it: an input drops line breaks
          const held = field.value;
          await settle();

          // this tab's, which reads this tab's settings
          const [{ control }] = declaredRows(tab.declareSettings()).filter(
            ({ name }) => name === row.name
          );
          const problem = await control.validate?.(held as never);
          const errorEl = setting.controlEl.querySelector(
            '.setting-item-error'
          );
          if (problem) {
            expect(setting.settingEl.classList).toContain('is-invalid');
            expect(errorEl?.textContent).toBe(problem);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
            expect(settings).toEqual(before);
          } else {
            const expected = makeTab(before);
            await expected.tab.setControlValue(row.control.key, held);
            expect(setting.settingEl.classList).not.toContain('is-invalid');
            expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
            expect(settings).toEqual(expected.plugin.settings);
          }
        }
      )
    );
  });

  it('saves a drawn number field once it is entered or left, as Obsidian saves its own: blank as the default, never below the minimum', async () => {
    const [row] = resettableRows().filter(
      ({ control }) => control.type === 'number'
    );
    await fc.assert(
      fc.asyncProperty(typedNumberArb, commitArb, async (typed, commit) => {
        const { tab } = makeAttachedTab();
        const { setting, field } = drawRow(tab, row.name);
        const before = tab.getControlValue(row.control.key);

        // what the field holds of it: a number input drops what isn't a number
        field.value = typed;
        const shown = field.value;
        commitField(field, commit);
        await settle();

        const days = parseFloat(shown);
        const errorEl = setting.controlEl.querySelector('.setting-item-error');
        const belowMin = shown !== '' && days < 1;
        const problem =
          shown === '' || belowMin
            ? undefined
            : await row.control.validate?.(days as never);
        // Enter leaves the field once it is saved; Obsidian's check is no
        // part of that
        if (commit === 'enter') {
          expect(document.activeElement === field).toBe(
            shown !== '' && days < 1
          );
        }
        if (belowMin || problem) {
          // Below the minimum, only the minimum it names is logic
          if (belowMin)
            expect(showsInteger(errorEl?.textContent, 1)).toBe(true);
          else expect(errorEl?.textContent).toBe(problem);
          expect(setting.settingEl.classList).toContain('is-invalid');
          expect(tab.getControlValue(row.control.key)).toBe(before);
        } else {
          expect(setting.settingEl.classList).not.toContain('is-invalid');
          expect(tab.getControlValue(row.control.key)).toBe(
            shown === '' ? row.control.defaultValue : days
          );
        }
      })
    );
  });

  it('puts a drawn number field back as last saved on Escape, clearing its error', async () => {
    const [row] = resettableRows().filter(
      ({ control }) => control.type === 'number'
    );
    const { tab, plugin } = makeAttachedTab();
    const { setting, field, reset } = drawRow(tab, row.name);
    field.focus();
    field.value = '0.5';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(setting.settingEl.classList).toContain('is-invalid');
    expect(reset.getAttribute('aria-disabled')).toBe('false');

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();

    expect(field.value).toBe(defaultText(row));
    expect(document.activeElement).not.toBe(field);
    expect(setting.settingEl.classList).not.toContain('is-invalid');
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    expect(tab.getControlValue(row.control.key)).toBe(row.control.defaultValue);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves a drawn number field alone on any other key, and on Enter or Escape while composing', async () => {
    const [row] = resettableRows().filter(
      ({ control }) => control.type === 'number'
    );
    const { tab, plugin } = makeAttachedTab();
    const { setting, field } = drawRow(tab, row.name);
    field.focus();
    field.value = '0.5';
    field.dispatchEvent(new FocusEvent('blur'));
    await settle();
    field.focus();

    for (const init of [
      { key: 'x' },
      { key: 'Tab' },
      { key: 'Enter', isComposing: true },
      { key: 'Escape', isComposing: true },
    ]) {
      field.dispatchEvent(new KeyboardEvent('keydown', init));
    }
    await settle();

    expect(field.value).toBe('0.5');
    expect(document.activeElement).toBe(field);
    expect(setting.settingEl.classList).toContain('is-invalid');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('flags a stored value its check rejects as soon as the row is drawn', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autoImportOnTag = true;
    settings.autoImportTags = [];
    const { tab } = makeTab(settings);

    const { setting } = drawRow(tab, TRIGGER_TAGS);
    await settle();

    expect(setting.settingEl.classList).toContain('is-invalid');
  });

  it('draws a text control with the placeholder it is given, or none', () => {
    fc.assert(
      fc.property(
        fc.option(textArb({ minLength: 1 })),
        textArb(),
        (placeholder, stored) => {
          document.body.replaceChildren();
          const control: DeclaredControl = {
            type: 'text',
            key: 'typed',
            defaultValue: 'default',
            ...(placeholder !== null && { placeholder }),
          };
          const host = {
            getControlValue: () => stored,
            setControlValue: vi.fn(),
            refreshDomState: vi.fn(),
          };

          const { field } = drawControl(control, host);

          expect(field.getAttribute('placeholder')).toBe(placeholder);
          // As the field holds it: an input drops line breaks
          expect(field.value).toBe(stored.replace(/[\r\n]/g, ''));
        }
      )
    );
  });

  it('draws any number control it is given as Obsidian draws one: placeholder, limits, a value outside them refused', async () => {
    const limitsArb = fc
      .tuple(fc.option(fc.integer()), fc.option(fc.integer()))
      .map(([a, b]) =>
        a !== null && b !== null && a > b
          ? ([b, a] as const)
          : ([a, b] as const)
      );
    await fc.assert(
      fc.asyncProperty(
        limitsArb,
        fc.oneof(fc.integer(), fc.constant(Number.NaN), textArb()),
        fc.integer(),
        fc.option(textArb({ minLength: 1 })),
        async ([min, max], stored, typed, placeholder) => {
          const host = {
            getControlValue: () => stored,
            setControlValue: vi.fn(),
            refreshDomState: vi.fn(),
          };
          const control: SettingNumberControl = {
            type: 'number',
            key: 'limited',
            defaultValue: 7,
          };
          if (min !== null) control.min = min;
          if (max !== null) control.max = max;
          if (placeholder !== null) control.placeholder = placeholder;
          const [group] = drawResettableRows(
            [{ type: 'group', items: [{ name: 'Limited', control }] }],
            host
          );
          const [row] = group.items ?? [];
          if ('type' in row || !row.render) throw new Error('Not drawn');
          // in the document, so its field can take focus
          const setting = new Setting(
            document.body.appendChild(document.createElement('div'))
          );
          row.render(setting as never, {} as never);
          const field = setting.controlEl.querySelector('input');
          if (!field) throw new Error('No field');

          expect(field).toMatchObject({
            type: 'number',
            inputMode: 'decimal',
            step: 'any',
            value:
              typeof stored === 'number' && !Number.isNaN(stored)
                ? String(stored)
                : '',
          });
          expect(field.getAttribute('min')).toBe(
            min === null ? null : `${min}`
          );
          expect(field.getAttribute('max')).toBe(
            max === null ? null : `${max}`
          );
          expect(field.getAttribute('placeholder')).toBe(placeholder);
          field.value = String(typed);
          field.focus();
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
          await settle();

          const error = setting.controlEl.querySelector('.setting-item-error');
          const belowMin = min !== null && typed < min;
          const aboveMax = max !== null && typed > max;
          // Enter leaves the field only once it is saved
          expect(document.activeElement === field).toBe(belowMin || aboveMax);
          // The limit it names is logic; the words around it are not
          if (belowMin) {
            expect(showsInteger(error?.textContent, min)).toBe(true);
          } else if (aboveMax) {
            expect(showsInteger(error?.textContent, max)).toBe(true);
          }
          if (belowMin || aboveMax) {
            expect(host.setControlValue).not.toHaveBeenCalled();
          } else {
            // twice, as Obsidian's does: on Enter, then on leaving the field
            expect(host.setControlValue.mock.calls).toEqual([
              ['limited', typed],
              ['limited', typed],
            ]);
            expect(host.refreshDomState).toHaveBeenCalledTimes(2);
          }
        }
      )
    );
  });

  it('refuses a number at either limit only past it', async () => {
    const host = {
      getControlValue: () => 5,
      setControlValue: vi.fn(),
      refreshDomState: vi.fn(),
    };
    const [group] = drawResettableRows(
      [
        {
          type: 'group',
          items: [
            {
              name: 'Limited',
              control: {
                type: 'number',
                key: 'limited',
                min: 2,
                max: 9,
                defaultValue: 5,
              },
            },
          ],
        },
      ],
      host
    );
    const [row] = group.items ?? [];
    if ('type' in row || !row.render) throw new Error('Not drawn');
    const setting = new Setting(document.createElement('div'));
    row.render(setting as never, {} as never);
    const field = setting.controlEl.querySelector('input');
    if (!field) throw new Error('No field');

    for (const typed of ['2', '9']) {
      field.value = typed;
      field.dispatchEvent(new FocusEvent('blur'));
    }
    await settle();

    expect(host.setControlValue.mock.calls).toEqual([
      ['limited', 2],
      ['limited', 9],
    ]);
    expect(setting.settingEl.classList).not.toContain('is-invalid');
  });

  it('leaves a number or text control with no default, and every other control, to Obsidian', () => {
    const host = {
      getControlValue: () => undefined,
      setControlValue: vi.fn(),
      refreshDomState: vi.fn(),
    };
    const groups: SettingDefinitionGroup[] = [
      {
        type: 'group',
        items: [
          { name: 'Number', control: { type: 'number', key: 'n' } },
          { name: 'Text', control: { type: 'text', key: 't' } },
          {
            name: 'Slider',
            control: {
              type: 'slider',
              key: 's',
              min: 0,
              max: 1,
              step: 1,
              defaultValue: 0,
            },
          },
          {
            name: 'Dropdown',
            control: {
              type: 'dropdown',
              key: 'd',
              options: {},
              defaultValue: 'a',
            },
          },
          { name: 'Bare' },
        ],
      },
    ];

    expect(drawResettableRows(groups, host)).toEqual(groups);
  });

  it('marks the trigger tags reset button by what the field shows once tidied', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(AUTO_IMPORT_TAG, ` #${AUTO_IMPORT_TAG} , `),
          typedTriggerTagsArb
        ),
        commitArb,
        (typed, commit) => {
          const { tab } = makeAttachedTab();
          const { field, reset } = drawRow(tab, TRIGGER_TAGS);

          typeInto(field, typed);
          commitField(field, commit);

          expect(reset.getAttribute('aria-disabled')).toBe(
            String(field.value === `#${AUTO_IMPORT_TAG}`)
          );
        }
      )
    );
  });

  it('refreshes the other rows only once a drawn field is saved, as Obsidian does', async () => {
    let finishSave = () => {};
    const host = {
      getControlValue: () => 'a',
      setControlValue: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          })
      ),
      refreshDomState: vi.fn(),
    };
    const { field } = drawControl(
      { type: 'text', key: 't', defaultValue: 'a' },
      host
    );

    typeInto(field, 'b');
    await settle();
    expect(host.setControlValue).toHaveBeenCalledWith('t', 'b');
    expect(host.refreshDomState).not.toHaveBeenCalled();

    finishSave();
    await settle();
    expect(host.refreshDomState).toHaveBeenCalledTimes(1);
  });

  it("keeps a drawn control's lock on its row, where Obsidian reads it", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.boolean(),
          fc.boolean().map((locked) => () => locked)
        ),
        fc.constantFrom<'number' | 'text'>('number', 'text'),
        (disabled, type) => {
          const host = {
            getControlValue: () => undefined,
            setControlValue: vi.fn(),
            refreshDomState: vi.fn(),
          };
          const control: DeclaredControl =
            type === 'number'
              ? { type, key: 'k', defaultValue: 1, disabled }
              : { type, key: 'k', defaultValue: 'a', disabled };

          expect(drawControl(control, host).row).toMatchObject({ disabled });
        }
      )
    );
  });
});

describe('IRSettingTab watched folders row', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('reads the watched folders as a list of its own, which edits to it leave alone', () => {
    const settings = watchingSettings(['Inbox', 'Clips'], true);
    const { tab } = makeTab(settings);

    const read = tab.getControlValue('autoImportFolders') as string[];
    read.push('Other');

    expect(settings.autoImportFolders).toEqual(['Inbox', 'Clips']);
  });

  it('shows each watched folder as a chip under an empty field, and says so if there are none while watching', () => {
    fc.assert(
      fc.property(storedFoldersArb, fc.boolean(), (folders, watching) => {
        document.body.replaceChildren();
        const { tab, plugin } = makeTab(watchingSettings(folders, watching));

        const row = drawWatchedFolders(tab);

        expect(row.setting.settingEl.classList).toContain(
          FOLDER_LIST_ROW_CLASS
        );
        expect(row.field.value).toBe('');
        expect(row.field.placeholder).toEqual(expect.stringMatching(/\S/));
        expect(row.setting.descEl.textContent).toBe('');
        expect(row.chips()).toEqual(folders);
        expect(
          row.buttons().map((button, at) => ({
            type: button.type,
            names: button.getAttribute('aria-label')?.includes(folders[at]),
            icon: button.querySelector('svg.lucide-x') !== null,
            // Obsidian's icon button, which a narrow row doesn't stretch
            iconButton: button.classList.contains('clickable-icon'),
          }))
        ).toEqual(
          folders.map(() => ({
            type: 'button',
            names: true,
            icon: true,
            iconButton: true,
          }))
        );
        expect(row.message()).toBe(watchListProblem(folders, watching));
        expect(plugin.saveSettings).not.toHaveBeenCalled();
      })
    );
  });

  it('adds the folder typed on Enter if it can be watched, and otherwise says why and keeps the text', async () => {
    await fc.assert(
      fc.asyncProperty(
        storedFoldersArb.chain((stored) =>
          fc.tuple(
            fc.constant(stored),
            fc.oneof(
              typedFolderArb,
              // Often a folder already watched, padded
              stored.length > 0
                ? fc.constantFrom(...stored).map((folder) => ` /${folder}/ `)
                : typedFolderArb
            )
          )
        ),
        fc.boolean(),
        fc.boolean(),
        fc.array(folderArb, { maxLength: 3 }),
        async ([stored, entered], watching, exists, others) => {
          document.body.replaceChildren();
          // As the field holds it: an input drops line breaks
          const typed = entered.replace(/[\r\n]/g, '');
          const folder = normalizeFolderPath(typed);
          const vault = exists ? [...others, folder] : others;
          const settings = watchingSettings(stored, watching);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings, vault);
          const row = drawWatchedFolders(tab);
          typeInto(row.field, typed);

          const event = pressEnter(row.field);
          await settle();

          expect(event.defaultPrevented).toBe(true);
          const problem = folderToWatchProblem(folder, (path) =>
            vault.includes(path)
          );
          if (typed.trim() === '') {
            expect(row.field.value).toBe(typed);
            expect(row.message()).toBe(watchListProblem(stored, watching));
            expect(plugin.settings).toEqual(before);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
          } else if (problem) {
            expect(row.field.value).toBe(typed);
            expect(row.message()).toBe(problem);
            expect(row.chips()).toEqual(stored);
            expect(plugin.settings).toEqual(before);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
          } else if (stored.includes(folder)) {
            expect(row.field.value).toBe('');
            expect(row.message()).toBeUndefined();
            expect(row.chips()).toEqual(stored);
            expect(plugin.settings).toEqual(before);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
          } else {
            expect(row.field.value).toBe('');
            expect(row.message()).toBeUndefined();
            expect(row.chips()).toEqual([...stored, folder]);
            expect(plugin.settings).toEqual({
              ...before,
              autoImportFolders: [...stored, folder],
            });
            expect(plugin.saveSettings).toHaveBeenCalledOnce();
          }
        }
      )
    );
  });

  it('adds a folder named with commas as one folder', async () => {
    const { tab, plugin } = makeTab(watchingSettings([], true), ['a, b']);
    const row = drawWatchedFolders(tab);

    typeInto(row.field, 'Inbox, a, b');
    pressEnter(row.field);
    await settle();

    expect(row.message()).toBe(
      folderToWatchProblem('Inbox, a, b', () => false)
    );
    expect(plugin.settings.autoImportFolders).toEqual([]);

    typeInto(row.field, '/a, b/');
    pressEnter(row.field);
    await settle();

    expect(row.chips()).toEqual(['a, b']);
    expect(plugin.settings.autoImportFolders).toEqual(['a, b']);
  });

  it('adds each folder entered after the last, and only once', async () => {
    const { tab, plugin, saved } = makeTab(watchingSettings([], true), [
      'Inbox',
      'Clips',
    ]);
    const row = drawWatchedFolders(tab);
    expect(row.message()).toBe(watchListProblem([], true));

    for (const typed of ['Inbox', 'Clips', 'Inbox/']) {
      typeInto(row.field, typed);
      pressEnter(row.field);
    }
    await settle();

    expect(row.chips()).toEqual(['Inbox', 'Clips']);
    expect(row.message()).toBeUndefined();
    expect(plugin.settings.autoImportFolders).toEqual(['Inbox', 'Clips']);
    expect(saved.map((data) => data.settings.autoImportFolders)).toEqual([
      ['Inbox'],
      ['Inbox', 'Clips'],
    ]);
  });

  it('does nothing on any other key, or on Enter that ends a composition', async () => {
    await fc.assert(
      fc.asyncProperty(typingKeyArb, async (key) => {
        document.body.replaceChildren();
        const { tab, plugin } = makeTab(watchingSettings([], false), ['Inbox']);
        const row = drawWatchedFolders(tab);
        typeInto(row.field, 'Inbox');

        const other = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        });
        row.field.dispatchEvent(other);
        const composing = pressEnter(row.field, { isComposing: true });
        await settle();

        expect(other.defaultPrevented).toBe(false);
        expect(composing.defaultPrevented).toBe(false);
        expect(row.field.value).toBe('Inbox');
        expect(row.chips()).toEqual([]);
        expect(plugin.saveSettings).not.toHaveBeenCalled();
      })
    );
  });

  it('saves nothing as the folder is typed, and drops the message about it once the text changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        storedFoldersArb,
        fc.boolean(),
        fc.array(typedFolderArb, { minLength: 1, maxLength: 3 }),
        async (stored, watching, edits) => {
          document.body.replaceChildren();
          const { tab, plugin } = makeTab(watchingSettings(stored, watching));
          const row = drawWatchedFolders(tab);
          typeInto(row.field, 'Missing');
          pressEnter(row.field);
          expect(row.message()).toBe(
            folderToWatchProblem('Missing', () => false)
          );

          for (const typed of edits) typeInto(row.field, typed);
          await settle();

          expect(row.message()).toBe(watchListProblem(stored, watching));
          expect(row.chips()).toEqual(stored);
          expect(plugin.saveSettings).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('stops watching the folder whose button is clicked, and says so once none are left while watching', async () => {
    await fc.assert(
      fc.asyncProperty(
        storedFoldersArb.filter((folders) => folders.length > 0),
        fc.nat(),
        fc.boolean(),
        async (stored, pick, watching) => {
          document.body.replaceChildren();
          const index = pick % stored.length;
          const settings = watchingSettings(stored, watching);
          const before = structuredClone(settings);
          const { tab, plugin } = makeTab(settings);
          const row = drawWatchedFolders(tab);

          row.buttons()[index].click();
          await settle();

          const left = stored.filter((_, at) => at !== index);
          expect(row.chips()).toEqual(left);
          expect(plugin.settings).toEqual({
            ...before,
            autoImportFolders: left,
          });
          expect(plugin.saveSettings).toHaveBeenCalledOnce();
          expect(row.message()).toBe(watchListProblem(left, watching));
        }
      )
    );
  });

  it('moves focus from a removed folder button to the one now in its place, the last one, or the field', () => {
    fc.assert(
      fc.property(
        storedFoldersArb.filter((folders) => folders.length > 0),
        fc.nat(),
        (stored, pick) => {
          document.body.replaceChildren();
          const index = pick % stored.length;
          const { tab } = makeTab(watchingSettings(stored, true));
          const row = drawWatchedFolders(tab);
          const button = row.buttons()[index];

          button.focus();
          button.click();

          const left = row.buttons();
          expect(document.activeElement).toBe(
            left.length === 0
              ? row.field
              : left[Math.min(index, left.length - 1)]
          );
        }
      )
    );
  });

  it('leaves focus alone when a removed folder button never had it, as after a tap', () => {
    const { tab } = makeTab(watchingSettings(['Inbox', 'Clips'], true));
    const row = drawWatchedFolders(tab);
    const elsewhere = document.body.appendChild(
      document.createElement('button')
    );
    elsewhere.focus();

    row.buttons()[0].click();

    expect(document.activeElement).toBe(elsewhere);
    expect(row.chips()).toEqual(['Clips']);
  });

  it('says there are no folders while watching is on, wherever the row is drawn, as watching is turned on or off', async () => {
    await fc.assert(
      fc.asyncProperty(
        storedFoldersArb,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        async (stored, toggles) => {
          document.body.replaceChildren();
          const { tab } = makeTab(watchingSettings(stored, false));
          // The tab's row, and one the settings search draws
          const rows = [drawWatchedFolders(tab), drawWatchedFolders(tab)];

          for (const watching of toggles) {
            await tab.setControlValue('autoImportOnFolder', watching);
            for (const row of rows) {
              expect(row.message()).toBe(watchListProblem(stored, watching));
            }
          }
        }
      )
    );
  });

  it('keeps the message about a folder typed when any other setting changes', async () => {
    await fc.assert(
      fc.asyncProperty(editsArb(), async (edits) => {
        document.body.replaceChildren();
        const { tab } = makeTab(watchingSettings([], true));
        const row = drawWatchedFolders(tab);
        typeInto(row.field, 'Missing');
        pressEnter(row.field);
        const typedProblem = folderToWatchProblem('Missing', () => false);
        const rows = declaredControls();

        for (const { row: at, value } of edits) {
          const { key } = rows[at].control;
          if (key === 'autoImportOnFolder') continue;
          await tab.setControlValue(key, value);
        }

        expect(row.message()).toBe(typedProblem);
      })
    );
  });

  it('stops updating a row once Obsidian cleans it up, or once it leaves the document', async () => {
    const { tab } = makeTab(watchingSettings([], false));
    const cleaned = drawWatchedFolders(tab);
    const detached = drawWatchedFolders(tab);
    const kept = drawWatchedFolders(tab);

    cleaned.cleanup();
    detached.setting.settingEl.remove();
    await tab.setControlValue('autoImportOnFolder', true);
    document.body.append(detached.setting.settingEl);
    await tab.setControlValue('autoImportOnFolder', true);

    expect(cleaned.message()).toBeUndefined();
    expect(detached.message()).toBeUndefined();
    expect(kept.message()).toBe(watchListProblem([], true));
  });

  it('keeps its chips drawn when the tab draws the row again', () => {
    const { tab } = makeTab(watchingSettings(['Inbox'], true), ['Clips']);
    const first = drawWatchedFolders(tab);
    typeInto(first.field, 'Clips');
    pressEnter(first.field);
    first.cleanup();
    first.setting.settingEl.remove();

    const again = drawWatchedFolders(tab);

    expect(again.chips()).toEqual(['Inbox', 'Clips']);
    expect(again.field.value).toBe('');
  });
});

describe('IRSettingTab watched folders suggestions', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  /** What the suggestions popup lists, top to bottom. */
  const suggested = () =>
    [
      ...document.querySelectorAll('.suggestion-container .suggestion-item'),
    ].map((item) => item.textContent);

  /** Focus `field` and type `typed` into it, as the user would. */
  async function typeFocused(field: HTMLInputElement, typed: string) {
    field.focus();
    typeInto(field, typed);
    await settle();
  }

  it('suggests each folder whose path holds all the text typed, any case, but the root, the data folder and those watched', async () => {
    await fc.assert(
      fc.asyncProperty(
        storedFoldersArb,
        fc.array(folderArb, { maxLength: 5 }),
        fc.oneof(
          typedFolderArb,
          fc.mixedCase(fc.constantFrom('inbox', 'a, b', 'reading/'))
        ),
        async (stored, others, typed) => {
          document.body.replaceChildren();
          const vault = [...new Set([...stored, ...others])];
          const { tab } = makeTab(watchingSettings(stored, true), vault);
          const row = drawWatchedFolders(tab);

          await typeFocused(row.field, typed);

          const needle = typed.trim().toLowerCase();
          const wanted = vault.filter(
            (path) =>
              path.toLowerCase().includes(needle) &&
              path !== DATA_DIRECTORY &&
              !path.startsWith(`${DATA_DIRECTORY}/`) &&
              !row.chips().includes(path)
          );
          expect([...suggested()].sort()).toEqual([...wanted].sort());
          expect(suggested()).not.toContain('/');
        }
      )
    );
  });

  it('fills the field with the folder picked, adding it only on Enter, as typed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('Inbox', 'Reading/Inbox', 'a, b'),
        fc.boolean(),
        async (folder, watching) => {
          document.body.replaceChildren();
          const { tab, plugin } = makeTab(watchingSettings([], watching), [
            'Inbox',
            'Reading/Inbox',
            'a, b',
          ]);
          const row = drawWatchedFolders(tab);
          await typeFocused(row.field, folder.slice(0, 3));
          // What was typed is no folder, which the row says until the pick
          pressEnter(row.field);
          expect(row.message()).toEqual(expect.stringMatching(/\S/));
          const item = [
            ...document.querySelectorAll<HTMLElement>('.suggestion-item'),
          ].find((el) => el.textContent === folder)!;

          item.click();
          await settle();

          expect(row.field.value).toBe(folder);
          expect(suggested()).toEqual([]);
          expect(row.chips()).toEqual([]);
          expect(plugin.saveSettings).not.toHaveBeenCalled();
          expect(row.message()).toBe(watchListProblem([], watching));

          pressEnter(row.field);
          await settle();

          expect(row.chips()).toEqual([folder]);
          expect(row.field.value).toBe('');
          expect(plugin.saveSettings).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it('no longer suggests a folder once it is watched', async () => {
    const { tab } = makeTab(watchingSettings([], true), ['Inbox', 'Inbox/Sub']);
    const row = drawWatchedFolders(tab);
    typeInto(row.field, 'Inbox');
    pressEnter(row.field);
    await settle();

    await typeFocused(row.field, 'inbox');

    expect(suggested()).toEqual(['Inbox/Sub']);
  });
});

describe('IRSettingTab trigger tags field', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** The suggestions showing, as their text. */
  const shownSuggestions = () =>
    [...document.querySelectorAll('.suggestion-item')].map(
      (item) => item.textContent
    );

  /** Focus `field` and type `typed`, letting the suggestions show. */
  async function typeSuggesting(
    field: HTMLInputElement | HTMLTextAreaElement,
    typed: string
  ) {
    field.focus();
    typeInto(field as HTMLInputElement, typed);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const VAULT_TAGS = [
    '#read',
    '#Reading',
    '#ir-article',
    '#IR-Card',
    '#ir-text-snippet/x',
    '#ir-import',
    '#later',
  ];

  it("suggests the vault's tags for the tag being typed, after the last space, but item-type tags and those in the field", async () => {
    const { tab } = makeAttachedTab(VAULT_TAGS);
    const field = addTextRow(tab, TRIGGER_TAGS, '');

    await typeSuggesting(field, '#read #');

    expect(shownSuggestions()).toEqual(['#ir-import', '#later', '#Reading']);

    await typeSuggesting(field, '#later RE');

    expect(shownSuggestions()).toEqual(['#read', '#Reading']);
  });

  it('puts a pick in place of the tag being typed, keeping the rest, and saves it, tidying only once done', async () => {
    const { tab } = makeAttachedTab(VAULT_TAGS);
    const field = addTextRow(tab, TRIGGER_TAGS, '');
    const inputs = vi.fn();
    await typeSuggesting(field, '#read, lat');
    field.addEventListener('input', inputs);

    const item = [
      ...document.querySelectorAll<HTMLElement>('.suggestion-item'),
    ].find((el) => el.textContent === '#later')!;
    item.click();

    expect(field.value).toBe('#read, #later ');
    // Obsidian's text control saves on `input`
    expect(inputs).toHaveBeenCalledOnce();

    commitField(field, 'leave');

    expect(field.value).toBe('#read #later');
  });

  it('suggests once per field however often it is focused', async () => {
    const { tab } = makeAttachedTab(VAULT_TAGS);
    const field = addTextRow(tab, TRIGGER_TAGS, '');
    field.focus();
    field.blur();

    await typeSuggesting(field, 'lat');

    expect(shownSuggestions()).toEqual(['#later']);
  });

  it('suggests nothing in a field of another row', async () => {
    const { tab } = makeAttachedTab(VAULT_TAGS);
    const field = addTextRow(tab, 'Watched folders', '');

    await typeSuggesting(field, 'lat');

    expect(shownSuggestions()).toEqual([]);
  });

  it('shows what was typed as the tags it reads as, each after a #, one space apart, once left or entered', () => {
    fc.assert(
      fc.property(typedTriggerTagsArb, commitArb, (typed, commit) => {
        const { tab } = makeAttachedTab();
        const field = addTextRow(tab, TRIGGER_TAGS, typed);
        const shown = field.value;

        commitField(field, commit);

        expect(field.value).toBe(
          parseTagList(shown)
            .map((tag) => `#${tag}`)
            .join(' ')
        );
      })
    );
  });

  it('puts one space between tags typed with none between them, once left or entered, in the box it sits in', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-zA-Z0-9_\-/]{1,10}$/),
            fc.integer({ min: 1, max: 2 }),
            fc.constantFrom('', '', ' ', ',')
          ),
          { minLength: 1, maxLength: 5 }
        ),
        commitArb,
        (entries, commit) => {
          const typed = entries
            .map(([tag, hashes, sep]) => '#'.repeat(hashes) + tag + sep)
            .join('');
          const { tab } = makeAttachedTab();
          const field = addTextRow(tab, TRIGGER_TAGS, typed);
          // Inside a box, as Obsidian draws the trigger tags
          const box = tab.containerEl.appendChild(
            document.createElement('div')
          );
          box.className = `setting-group ${SETTING_BOX_CLASS}`;
          box.appendChild(field.closest('.setting-item')!);

          commitField(field, commit);

          expect(field.value).toBe(
            [...new Set(entries.map(([tag]) => tag.toLowerCase()))]
              .map((tag) => `#${tag}`)
              .join(' ')
          );
        }
      )
    );
    const { tab } = makeAttachedTab();
    const field = addTextRow(tab, TRIGGER_TAGS, '#ir-import#clippings');
    commitField(field, 'leave');
    expect(field.value).toBe('#ir-import #clippings');
  });

  it('shows the same tags it saved', async () => {
    await fc.assert(
      fc.asyncProperty(
        typedTriggerTagsArb,
        commitArb,
        async (typed, commit) => {
          const { tab } = makeAttachedTab();
          const field = addTextRow(tab, TRIGGER_TAGS, typed);

          await tab.setControlValue('autoImportTags', field.value);
          commitField(field, commit);

          expect(field.value).toBe(tab.getControlValue('autoImportTags'));
        }
      )
    );
  });

  it('leaves the field as typed while typing', () => {
    fc.assert(
      fc.property(
        typedTriggerTagsArb,
        fc.array(typingKeyArb, { maxLength: 5 }),
        (typed, keys) => {
          const { tab } = makeAttachedTab();
          const field = addTextRow(tab, TRIGGER_TAGS, typed);
          const shown = field.value;
          field.focus();

          for (const key of keys) {
            field.dispatchEvent(
              new KeyboardEvent('keydown', { key, bubbles: true })
            );
            field.dispatchEvent(new Event('input', { bubbles: true }));
          }
          // Enter that ends composing a character, not the field
          field.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              isComposing: true,
              bubbles: true,
            })
          );

          expect(field.value).toBe(shown);
        }
      )
    );
  });

  it('leaves every other field as typed, however it is done with', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({
            name: fc.option(
              fc.oneof(
                textArb(),
                fc.constantFrom(
                  'Learning steps',
                  'trigger tags',
                  ' Trigger tags'
                )
              ),
              { nil: undefined }
            ),
            tagName: fc.constant<'input' | 'textarea'>('input'),
          }),
          fc.record({
            name: fc.constant<string | undefined>(TRIGGER_TAGS),
            tagName: fc.constant<'input' | 'textarea'>('textarea'),
          })
        ),
        typedTriggerTagsArb,
        commitArb,
        ({ name, tagName }, typed, commit) => {
          fc.pre(name !== TRIGGER_TAGS || tagName !== 'input');
          const { tab } = makeAttachedTab();
          const field = addTextRow(tab, name, typed, tagName);
          const shown = field.value;

          commitField(field, commit);

          expect(field.value).toBe(shown);
        }
      )
    );
  });

  it('leaves a field outside any setting row as typed', () => {
    fc.assert(
      fc.property(typedTriggerTagsArb, commitArb, (typed, commit) => {
        const { tab } = makeAttachedTab();
        const field = tab.containerEl.appendChild(
          document.createElement('input')
        );
        field.value = typed;
        const shown = field.value;

        commitField(field, commit);

        expect(field.value).toBe(shown);
      })
    );
  });
});

describe('layOutGroups', () => {
  it("keeps every row in order, with each box's name and description heading its own rows", () => {
    fc.assert(
      fc.property(groupLayoutArb, (layout) => {
        const groups = layOutGroups([layout]);

        expect(groups.flatMap((group) => group.items ?? [])).toStrictEqual(
          layout.items.flatMap((item) => (isBox(item) ? boxRows(item) : [item]))
        );
      })
    );
  });

  it('puts each box in a group of its own, and each run of rows between boxes in one group', () => {
    fc.assert(
      fc.property(groupLayoutArb, (layout) => {
        const groups = layOutGroups([layout]);
        const boxed = groups.filter((group) =>
          classesOf(group).includes(SETTING_BOX_CLASS)
        );
        const plain = groups.filter(
          (group) => !classesOf(group).includes(SETTING_BOX_CLASS)
        );
        const runs = layout.items.filter(
          (item, index) =>
            !isBox(item) && (index === 0 || isBox(layout.items[index - 1]))
        );

        expect(groups.every((group) => group.type === 'group')).toBe(true);
        expect(boxed.map((group) => group.items)).toStrictEqual(
          layout.items.filter(isBox).map(boxRows)
        );
        expect(plain).toHaveLength(runs.length);
        expect(plain.every((group) => (group.items ?? []).length > 0)).toBe(
          true
        );
      })
    );
  });

  it('shows the heading once, over the first group, and marks each later group as continuing its section', () => {
    fc.assert(
      fc.property(groupLayoutArb, (layout) => {
        const [first, ...rest] = layOutGroups([layout]);

        if (first) {
          expect(first.heading).toBe(layout.heading);
          expect(classesOf(first)).not.toContain(CONTINUED_GROUP_CLASS);
        }
        for (const group of rest) {
          expect(group.heading).toBeUndefined();
          expect(classesOf(group)).toContain(CONTINUED_GROUP_CLASS);
        }
        for (const group of [first, ...rest].filter(Boolean)) {
          expect(
            classesOf(group).every((cls) =>
              [SETTING_BOX_CLASS, CONTINUED_GROUP_CLASS].includes(cls)
            )
          ).toBe(true);
          if (group.cls !== undefined) {
            expect(group.cls).toBe(classesOf(group).join(' '));
          }
        }
      })
    );
  });

  it('lays out each group on its own, in order', () => {
    fc.assert(
      fc.property(fc.array(groupLayoutArb, { maxLength: 4 }), (layouts) => {
        expect(layOutGroups(layouts)).toEqual(
          layouts.flatMap((layout) => layOutGroups([layout]))
        );
      })
    );
  });
});

describe('IRSettingTab container', () => {
  /** Selectors of the styles.css rules that react to Obsidian's `is-invalid`. */
  const selectorsWith = (needle: string) =>
    [
      ...readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/([^{}]+)\{/g),
    ]
      .flatMap(([, selectors]) => selectors.split(/,(?![^(]*\))/))
      .map((selector) => selector.replace(/\s+/g, ' ').trim())
      .filter((selector) => selector.includes(needle));
  const invalidRowSelectors = () => selectorsWith('.is-invalid');

  it('carries the class that scopes styles.css to this tab', () => {
    const { tab } = makeTab(structuredClone(DEFAULT_SETTINGS));

    expect(tab.containerEl.classList.contains(SETTINGS_TAB_CLASS)).toBe(true);
  });

  it('is what the styles.css rules for boxes and continued groups are scoped to', () => {
    for (const cls of [SETTING_BOX_CLASS, CONTINUED_GROUP_CLASS]) {
      const selectors = selectorsWith(`.${cls}`);

      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        expect(selector.startsWith(`.${SETTINGS_TAB_CLASS} `)).toBe(true);
      }
    }
  });

  it('is what every styles.css rule for invalid rows is scoped to', () => {
    const selectors = invalidRowSelectors();

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(`.${SETTINGS_TAB_CLASS} `)).toBe(true);
    }
  });
});
