import type { TFile, Vault } from 'obsidian';

/**
 * The only map from extension to MIME type. Everything that asks what kind of
 * file it holds goes through {@link getMimeType}, so a new format is one row
 * here plus whichever capability sets below it joins.
 *
 * A `Map` rather than an object literal, so an extension like `constructor`
 * can't resolve to something off `Object.prototype`.
 */
const MIME_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['md', 'text/markdown'],
  ['pdf', 'application/pdf'],
]);

/**
 * The bytes a binary format's content opens with. A type in the table above
 * with no entry here is text, which has no signature: its content is taken at
 * its word unless it opens with one of these.
 */
const MAGIC_BYTES: ReadonlyMap<string, readonly number[]> = new Map([
  // `%PDF-`
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
]);

/**
 * The MIME type of `file`, going by its extension alone (case-insensitive),
 * or `null` for an extension this plugin has no use for. Cheap and sync; see
 * {@link sniffMimeType} for checking the content agrees.
 */
export function getMimeType(file: Pick<TFile, 'extension'>): string | null {
  return MIME_TYPE_BY_EXTENSION.get(file.extension.toLowerCase()) ?? null;
}

/**
 * The extension of the file at `path`, for a path with no `TFile` behind it
 * any more (the old path of a rename, say): whatever follows the last dot of
 * its name, or nothing for a name without one.
 */
export function extensionOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/**
 * The MIME type of `file` once its content has been checked against what
 * {@link getMimeType} says it is, or `null` when the two disagree (a `.pdf`
 * that isn't a PDF, a `.md` that is one) or the extension is unknown.
 *
 * Reads the whole file, so this is for the moment of import, not for deciding
 * which menu entries to show.
 */
export async function sniffMimeType(
  app: { vault: Pick<Vault, 'readBinary'> },
  file: TFile
): Promise<string | null> {
  const expected = getMimeType(file);
  if (expected === null) return null;

  const bytes = new Uint8Array(await app.vault.readBinary(file));
  let found: string | null = null;
  for (const [type, magic] of MAGIC_BYTES) {
    if (magic.every((byte, i) => bytes[i] === byte)) found = type;
  }
  // A text type has no signature, so its content agrees by matching none.
  const claimed = MAGIC_BYTES.has(expected) ? expected : null;
  return found === claimed ? expected : null;
}

// #region CAPABILITIES
// Named for what a file can do, not for its format, so a caller asks the
// question it means and a new format only has to join the right sets.

/**
 * Types whose frontmatter Obsidian parses and writes: `processFrontMatter` and
 * the metadata cache handle `.md` and nothing else.
 */
export const FRONTMATTER_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/markdown',
]);

/** Types whose content is text the plugin reads, edits and offsets into. */
export const EDITABLE_TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/markdown',
]);

/**
 * Types a file can be imported from as an article. A note becomes one by the
 * id and tag written into its frontmatter; a PDF, which has none, by the row at
 * its path alone.
 */
export const IMPORTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  ...FRONTMATTER_MIME_TYPES,
  'application/pdf',
]);

/**
 * Types that can be imported as a copy in the data folder, rather than only
 * where they are. Every importable type can be today; the set stays separate
 * so a type that can only be imported in place needs no new checks.
 */
export const COPY_IMPORTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  ...FRONTMATTER_MIME_TYPES,
  'application/pdf',
]);

function hasMimeTypeIn(
  types: ReadonlySet<string>,
  file: Pick<TFile, 'extension'>
): boolean {
  const type = getMimeType(file);
  return type !== null && types.has(type);
}

/** Whether Obsidian can read and write `file`'s frontmatter. */
export function supportsFrontmatter(file: Pick<TFile, 'extension'>): boolean {
  return hasMimeTypeIn(FRONTMATTER_MIME_TYPES, file);
}

/** Whether `file` is text the plugin can read and edit in place. */
export function isEditableText(file: Pick<TFile, 'extension'>): boolean {
  return hasMimeTypeIn(EDITABLE_TEXT_MIME_TYPES, file);
}

/** Whether `file` can be imported as an article. */
export function isImportable(file: Pick<TFile, 'extension'>): boolean {
  return hasMimeTypeIn(IMPORTABLE_MIME_TYPES, file);
}

/** Whether `file` can be imported as a copy, not only in place. */
export function isCopyImportable(file: Pick<TFile, 'extension'>): boolean {
  return hasMimeTypeIn(COPY_IMPORTABLE_MIME_TYPES, file);
}

// #endregion
