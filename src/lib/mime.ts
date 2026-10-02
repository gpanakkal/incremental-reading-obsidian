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

/** How many leading bytes it takes to tell every signature apart. */
const SIGNATURE_LENGTH = Math.max(
  ...[...MAGIC_BYTES.values()].map((magic) => magic.length)
);

/**
 * The first {@link SIGNATURE_LENGTH} bytes of the body `url` serves, asking
 * for no more than that and leaving the rest of the body unread; or `null`
 * when the response has no body to read them from or ends before them.
 */
async function fetchLeadingBytes(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    // Relies on undocumented URL serving; see readLeadingBytes for what and
    // for the fallback when it fails. A single range is a CORS-safelisted
    // header, so this needs no preflight.
    headers: { Range: `bytes=0-${SIGNATURE_LENGTH - 1}` },
  });
  if (response.status !== 200 && response.status !== 206) return null;
  if (response.body === null) return null;

  // A server that ignores the range sends the whole file with a 200; reading
  // stops once the signature is in, and cancelling drops the rest unread.
  const reader = response.body.getReader();
  const bytes = new Uint8Array(SIGNATURE_LENGTH);
  let filled = 0;
  while (filled < SIGNATURE_LENGTH) {
    const { done, value } = await reader.read();
    if (done) return null;
    const taken = value.subarray(0, SIGNATURE_LENGTH - filled);
    bytes.set(taken, filled);
    filled += taken.length;
  }
  reader.cancel().catch(() => {});
  return bytes;
}

/**
 * Up to {@link SIGNATURE_LENGTH} bytes from the start of `file`, read without
 * loading the rest of it where the platform allows.
 *
 * No public API reads part of a file: `readBinary` loads all of it, which on
 * mobile means the whole file across the Capacitor bridge, or for one of
 * 5 MiB and up a fetch of all of it. So this fetches the URL
 * `getResourcePath` gives, relying on how Obsidian serves it, which is
 * undocumented (checked against 1.12 and 1.13):
 * - desktop serves `app://` URLs from disk. Where Electron still has
 *   `registerFileProtocol`, Obsidian registers it there, and a range comes
 *   back as only those bytes under a `200`. Otherwise its own
 *   `protocol.handle` handler answers a range with a `206`, or a `416` for one
 *   past the end of the file;
 * - mobile's URL is Capacitor's `convertFileSrc` of the file, the same one
 *   Obsidian's own `readBinary` fetches for large files. Whether its server
 *   honors `Range` is unknown; a `200` is read only as far as the signature.
 *
 * Any failure on that path (a throw, another status, no body) falls back to
 * `readBinary`. So does a file too short to hold a signature, which comes up
 * short or gets a `416`; reading it whole costs next to nothing. The range
 * never goes by `stat.size`, which can lag behind the file on disk.
 */
async function readLeadingBytes(
  vault: Pick<Vault, 'readBinary' | 'getResourcePath'>,
  file: TFile
): Promise<Uint8Array> {
  try {
    const bytes = await fetchLeadingBytes(vault.getResourcePath(file));
    if (bytes !== null) return bytes;
  } catch {
    // Read the whole file instead, below
  }
  return new Uint8Array(await vault.readBinary(file));
}

/**
 * The MIME type of `file` once its content has been checked against what
 * {@link getMimeType} says it is, or `null` when the two disagree (a `.pdf`
 * that isn't a PDF, a `.md` that is one) or the extension is unknown.
 *
 * Reads only the leading bytes the signatures need, but may fall back to
 * reading the whole file, so this is for the moment of import, not for
 * deciding which menu entries to show.
 */
export async function sniffMimeType(
  app: { vault: Pick<Vault, 'readBinary' | 'getResourcePath'> },
  file: TFile
): Promise<string | null> {
  const expected = getMimeType(file);
  if (expected === null) return null;

  const bytes = await readLeadingBytes(app.vault, file);
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
