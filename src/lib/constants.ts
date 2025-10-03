export const PLACEHOLDER_PLUGIN_ICON = 'book-open-text';

// TODO: move to settings
export const WASM_FILE_PATH = 'src/db/sql-wasm.wasm';
export const SCHEMA_FILE_PATH = 'src/db/schema.sql';
export const DATA_DIRECTORY = 'incremental-reading';
export const DATABASE_FILE_PATH = `${DATA_DIRECTORY}/ir-user-data.sqlite`;
export const TEST_DATABASE_FILE_PATH = './ir-test-data.sqlite';
export const SNIPPET_DIRECTORY = `${DATA_DIRECTORY}/snippets`;
export const CARD_DIRECTORY = `${DATA_DIRECTORY}/cards`;

export const SNIPPET_TAG = 'ir-text-snippet';
export const CARD_TAG = 'ir-card';
export const SOURCE_PROPERTY_NAME = 'ir-source';

export const ERROR_NOTICE_DURATION_MS = 8000;
export const SUCCESS_NOTICE_DURATION_MS = 4000;

/** characters that should never be permitted in note titles */
export const FORBIDDEN_TITLE_CHARS = new Set(`#^[]|*"\\/<>:?\n`.split(''));
export const CONTENT_TITLE_SLICE_LENGTH = 25;
export const SNIPPET_SLICE_LENGTH = 30;

export const MS_PER_MINUTE = 1000 * 60;
export const MS_PER_DAY = 1000 * 86_400;
/** Local time to roll over to a new day. Defaults to 0400 (4 AM). Must be positive */
export const DAY_ROLLOVER_OFFSET_HOURS = 4;

export const TABLE_NAMES = Object.freeze([
  'snippet',
  'snippet_review',
  'srs_card',
  'srs_card_review',
] as const);

export const SNIPPET_BASE_REVIEW_INTERVAL = MS_PER_DAY * 1;
export const SNIPPET_REVIEW_MULTIPLIER_BASE = 1.01;
export const SNIPPET_REVIEW_MULTIPLIER_STEP = 0.015;
export const SNIPPET_DEFAULT_PRIORITY = 25;
export const SNIPPET_REVIEW_INTERVALS = {
  AGAIN: 1,
  TOMORROW: MS_PER_DAY,
  THREE_DAYS: 3 * MS_PER_DAY,
  ONE_WEEK: 7 * MS_PER_DAY,
};

/** Number of rows to fetch at a time when reviewing */
export const REVIEW_FETCH_COUNT = 50;

export const CLOZE_DELIMITERS = ['{{', '}}'];

export const CLOZE_DELIMITER_PATTERN = new RegExp(
  `${CLOZE_DELIMITERS[0]}([\\s\\S]*?)${CLOZE_DELIMITERS[1]}`,
  'g'
);

export const CARD_ANSWER_REPLACEMENT = `<mark class="ir-hidden-answer">\\\_\\\_\\\_\\\_\\\_\\\_</mark>`;

export const FRONTMATTER_PATTERN = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;
export const TRANSCLUSION_HIDE_TITLE_ALIAS = 'ir-hide-title';
export const CSS_CLASS_PREFIX = 'ir';
