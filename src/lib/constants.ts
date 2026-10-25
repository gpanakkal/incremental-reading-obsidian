/**
 * Id of the plugin's own icon (an open book with a gear), registered with
 * Obsidian by `registerPluginIcon` at load. Every surface that stands for the
 * plugin as a whole (ribbon, review tab, menu entries) shows it.
 */
export const PLUGIN_ICON = 'incremental-reading';

/** Stroke for the dismiss and restore icons, on every bar that shows them. */
export const DISMISS_ICON_STROKE = '#f7b500';

// TODO: move to settings
export const DATA_DIRECTORY = 'incremental-reading';
export const DATABASE_FILE_PATH = `${DATA_DIRECTORY}/ir-user-data.sqlite`;
export const BACKUP_DIRECTORY = `${DATA_DIRECTORY}/.backups`;
export const LOG_DIRECTORY = `${DATA_DIRECTORY}/.logs`;
export const TEST_DATABASE_FILE_PATH = './ir-test-data.sqlite';
export const SNIPPET_DIRECTORY = `snippets`;
export const CARD_DIRECTORY = `cards`;
export const ARTICLE_DIRECTORY = `articles`;

export const SNIPPET_TAG = 'ir-text-snippet';
export const CARD_TAG = 'ir-card';
export const ARTICLE_TAG = 'ir-article';
/** Frontmatter tag that, with automatic imports on, makes a note an article. */
export const AUTO_IMPORT_TAG = 'ir-import';
/** Notes carrying one of these are snippets or cards, never imported as articles. */
export const IMPORT_BLOCKED_TAGS: ReadonlySet<string> = new Set([
  SNIPPET_TAG,
  CARD_TAG,
]);
export const SOURCE_TAG = 'ir-source';
export const SOURCE_PROPERTY_NAME = 'source';

export const NOTICE_SCALED_DURATION_PER_WORD_MS = 750;
export const NOTICE_MIN_DURATION_MS = 5000;
/**
 * How much longer than {@link NOTICE_MIN_DURATION_MS} an import's notice stays
 * up at the least. A short page title made the notice vanish before its Open
 * button could be used.
 */
export const IMPORT_NOTICE_EXTRA_MS = 2000;

/** characters that should never be permitted in note titles */
export const FORBIDDEN_TITLE_CHARS = new Set(`#^[]*"\\/<>:|?\n`.split(''));
/** The characters with char codes `from` to `to`, both included. */
const charRange = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    String.fromCharCode(from + i)
  );

/**
 * C0 controls (`\x00`–`\x1f`), DEL and C1 controls (`\x7f`–`\x9f`), and the
 * line and paragraph separators (U+2028, U+2029). Invalid or invisible in a
 * file name, or breaking it across lines: a `\r` or `\t` makes `vault.create`
 * fail on Windows and Android. Titles turn them into a space, so the words
 * around them stay apart.
 */
export const CONTROL_TITLE_CHARS = new Set([
  ...charRange(0x00, 0x1f),
  ...charRange(0x7f, 0x9f),
  ...[0x2028, 0x2029].map((code) => String.fromCharCode(code)),
]);
/**
 * LRM, RLM and ALM: marks that only move punctuation and digits at a change
 * of direction, which right-to-left text sets with them. Text taken from a PDF
 * keeps them; a title doesn't.
 */
export const DIRECTION_MARKS: ReadonlySet<string> = new Set(
  [0x200e, 0x200f, 0x061c].map((code) => String.fromCodePoint(code))
);
export const INVALID_TITLE_MESSAGE =
  `IR file names cannot contain any of these characters: ` +
  `${[...FORBIDDEN_TITLE_CHARS.keys()].join(' ')}`;
export const CONTENT_TITLE_SLICE_LENGTH = 50;
/**
 * The most UTF-8 bytes a title made from text may take, the ` - <id>.md` after
 * it aside: file systems cap a name at 255 bytes (ext4, APFS) or UTF-16 units
 * (NTFS). 50 code points take 200 bytes at most, so this holds should the
 * slice length grow.
 */
export const CONTENT_TITLE_MAX_BYTES = 200;
export const SNIPPET_SLICE_LENGTH = 30;

export const MS_PER_MINUTE = 1000 * 60;
export const MS_PER_DAY = 1000 * 86_400;
export const MS_PER_YEAR = MS_PER_DAY * 365;
export const MAX_VALID_TIMESTAMP_DATE = 8.64e15;

/** When to roll over to a new review day relative to midnight.
 * Default is 4 (4 AM)
 */
export const DAY_ROLLOVER_OFFSET_HOURS = {
  DEFAULT: 4,
  MIN: -12,
  MAX: 12,
};

/**
 * How long, in seconds, the action bar and review commands ignore presses after
 * the item on screen changes (see `ActionCooldown`). 0 turns the guard off.
 */
export const ACTION_COOLDOWN_SECONDS = {
  DEFAULT: 0.4,
  MIN: 0,
  MAX: 2,
  STEP: 0.1,
};

export const TABLE_NAMES = Object.freeze([
  'article',
  'article_review',
  'snippet',
  'snippet_review',
  'srs_card',
  'srs_card_review',
] as const);

export const MINIMUM_PRIORITY = 10;
export const MAXIMUM_PRIORITY = 50;
export const DEFAULT_PRIORITY = 30;

export const MINIMUM_FIXED_REVIEW_INTERVAL = 1;
export const MAXIMUM_FIXED_REVIEW_INTERVAL = 30;

/**
 * The number of reviews to use to calculate a descendant's priority based on
 * the parent's fixed review interval
 */
export const REVIEW_COUNT_FOR_PRIORITY_SCALING = 4;

export const MAX_TESTED_REVIEW_COUNT = 50;

export const TEXT_BASE_REVIEW_INTERVAL = MS_PER_DAY * 1;
/** Might change in the future */
export const TEXT_MINIMUM_REVIEW_INTERVAL = TEXT_BASE_REVIEW_INTERVAL;

export const TEXT_REVIEW_MULTIPLIER_BASE = 1.01;
export const TEXT_REVIEW_MULTIPLIER_STEP = 0.015;
export const TEXT_REVIEW_INTERVALS = {
  AGAIN: 1,
  TOMORROW: MS_PER_DAY,
  THREE_DAYS: 3 * MS_PER_DAY,
  ONE_WEEK: 7 * MS_PER_DAY,
};

/** Number of rows to fetch at a time for queue */
export const REVIEW_FETCH_COUNT = 50;

export const LEGACY_CLOZE_DELIMITERS: [string, string] = ['{{', '}}'];

export const CLOZE_DELIMITERS: [string, string] = ['(}', '{)'];

export const VALID_DELIMITER_PATTERN = /^[^\w\s].*[^\w\s]$/;

/** Escapes characters in the input for literal regex interpretation */
export const literal = (pattern: string) =>
  pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CLOZE_PATTERN_BASE = `${literal(CLOZE_DELIMITERS[0])}([\\s\\S]*?)${literal(CLOZE_DELIMITERS[1])}`;

export const CLOZE_DELIMITER_PATTERN = new RegExp(CLOZE_PATTERN_BASE, 'g');

export const CLOZE_GROUPS_PATTERN = new RegExp(
  `([\\s\\S]*)` + CLOZE_PATTERN_BASE + `([\\s\\S]*)`
);

// eslint-disable-next-line no-useless-escape -- this string is parsed twice
export const CARD_ANSWER_REPLACEMENT = `<mark class="ir-hidden-answer">\\\_\\\_\\\_\\\_\\\_\\\_</mark>`;
/** The hidden answer's stand-in in code, where markup shows as it is. */
export const CARD_ANSWER_REPLACEMENT_IN_CODE = '______';
/** The hidden answer's stand-in in math, which MathJax renders. */
export const CARD_ANSWER_REPLACEMENT_IN_MATH = String.raw`\underline{\qquad}`;

export const FRONTMATTER_PATTERN = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;
export const TRANSCLUSION_HIDE_TITLE_ALIAS = 'ir-hide-title';

export const QUERY_STALE_TIME = MS_PER_MINUTE;
export const CURRENT_ITEM_REFETCH_TIME = 1000 * 5;
/**
 * How long a parentless snippet's row waits for the metadata cache to index
 * its note's source link before it is saved anyway: see
 * `SnippetManager.createFromPdf`.
 */
export const SOURCE_INDEX_TIMEOUT_MS = 2000;
/**
 * How long `AutoImportWatcher` waits for more notes after the last one queued.
 * It batches the notes that arrive together, from a Sync burst or a script,
 * into one import and one notice. It does not wait for typing to settle: the
 * metadata cache already sits behind Obsidian's own 2 s editor save debounce,
 * so this adds nothing for a typed tag, and it has to stay short for a tag set
 * in the properties widget, which writes the file at once.
 */
export const AUTO_IMPORT_DEBOUNCE_MS = 500;
/**
 * The longest a note waits for `AutoImportWatcher`, however often it or the
 * notes queued with it change. A stream with no pause in it, such as Sync
 * pulling down a folder over half a minute, would otherwise put the import
 * off until it ended.
 */
export const AUTO_IMPORT_MAX_WAIT_MS = 5000;
/**
 * How far before the moment it is written `AutoImportWatcher` dates the
 * moment it last saw every change. A note's change reaches the watcher only
 * once the metadata cache has read it, a moment after the file was written,
 * and while Obsidian is starting up, many seconds after. A note written just
 * before the watcher stops may be read too late; dated this far back, the
 * next startup looks at it again. Looking at a note too many costs nothing:
 * one already imported is passed over.
 */
export const AUTO_IMPORT_WATERMARK_SLACK_MS = 60_000;
/**
 * How often `AutoImportWatcher` looks at Obsidian Sync again while it holds
 * its imports back for Sync, besides each `'status-change'` Sync raises (see
 * `subscribeSyncStatus`): for what raises none, such as Sync turned off, and
 * for {@link AUTO_IMPORT_SYNC_PATIENCE_MS} running out.
 */
export const AUTO_IMPORT_SYNC_POLL_MS = 5000;
/**
 * How long `AutoImportWatcher` waits on Sync that keeps saying it is syncing
 * before it counts its imports as stuck behind it and offers to import them
 * anyway, as it does at once for Sync paused, offline or failing. Long enough
 * for a large first sync of a new device, which brings the very rows and
 * stripped notes the wait is for.
 */
export const AUTO_IMPORT_SYNC_PATIENCE_MS = 5 * 60_000;

export const MAX_SQL_QUERY_PARAMS = 999;
/**
 * How long `SQLiteRepository.bulkMutate` spends writing before committing a
 * chunk and handing the thread back. Each chunk costs one full database export
 * and file write, and each yield costs a frame or more, so a longer slice saves
 * and waits fewer times; a shorter one keeps each transaction brief and lets
 * other work run sooner. Measured in time rather than statements because a
 * statement costs a small fraction of a millisecond: a chunk of a fixed few
 * would spend the run waiting rather than writing.
 */
export const BATCHED_MUTATION_SLICE_MS = 8;

export const QUEUE_TABLE_DEFAULT_ENTRIES_PER_PAGE = 20;
/**
 * The sections Obsidian's view header builds its `more-options` menu from, in
 * render order, copied from `ItemView.onMoreOptions`.
 *
 * `Menu.sort` walks this list and emits each section's items in the order they
 * were added, so a section — not the order `addItem` was called in — is what
 * decides where an entry lands. `pane` is second, ahead of the `open` section
 * holding Split right and Split down, which is where a view's own actions
 * belong and why Kanban's board actions sit at the top of its menu.
 *
 * Needed because {@link ReviewView.showMoreOptionsMenu} builds the menu itself
 * for the action bar's ⋮, which stands in for the view header's while the "Show
 * tab title bar" setting hides it.
 */
export const MORE_OPTIONS_SECTIONS: string[] = [
  'close',
  'pane',
  'open',
  'action',
  'find',
  'info',
  'info.copy',
  'view',
  'view.linked',
  'system',
  '',
  'danger',
];

/**
 * Tooltip and accessible name of the review bar's button that opens the
 * scheduling modal, and the name of the command that does the same; kept here
 * so e2e specs can find it without importing the component (and Obsidian with
 * it).
 */
export const SCHEDULING_BUTTON_LABEL = 'Manage scheduling';
