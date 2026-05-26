export const PLACEHOLDER_PLUGIN_ICON = 'book-open-text';

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
export const SOURCE_TAG = 'ir-source';
export const SOURCE_PROPERTY_NAME = 'source';

export const ERROR_NOTICE_DURATION_MS = 8000;
export const SUCCESS_NOTICE_DURATION_MS = 5000;

/** characters that should never be permitted in note titles */
export const FORBIDDEN_TITLE_CHARS = new Set(`#^[]|*"\\/<>:?\n`.split(''));
export const INVALID_TITLE_MESSAGE =
  `Titles cannot contain any of the following: ` +
  `${[...FORBIDDEN_TITLE_CHARS.keys()].join(', ')}`;
export const CONTENT_TITLE_SLICE_LENGTH = 50;
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

export const FRONTMATTER_PATTERN = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;
export const TRANSCLUSION_HIDE_TITLE_ALIAS = 'ir-hide-title';

export const QUERY_STALE_TIME = MS_PER_MINUTE;
export const CURRENT_ITEM_REFETCH_TIME = 1000 * 5;

export const MAX_SQL_QUERY_PARAMS = 999;
