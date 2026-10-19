import { isItemTypeTag, parseTagList } from '#/lib/tags';
import { AbstractInputSuggest } from 'obsidian';

/** What ends a tag in a typed list: a comma or whitespace. */
const LAST_SEPARATOR = /[\s,](?=[^\s,]*$)/;

/**
 * `raw`, a typed list of tags, split where its last tag starts: what comes
 * before it, separators included, and the tag being typed.
 */
function splitLast(raw: string): { before: string; typing: string } {
  const at = raw.search(LAST_SEPARATOR) + 1;
  return { before: raw.slice(0, at), typing: raw.slice(at) };
}

/** `raw`, a typed list of tags, with the tag being typed made `tag`. */
export function withSuggestion(raw: string, tag: string): string {
  return splitLast(raw).before + tag;
}

/**
 * Suggestions of the vault's tags under a text input holding a list of them,
 * for the tag being typed, the list's last: each tag whose name holds what
 * is typed of it, any case, `#` optional, not in the list already and not
 * one the plugin marks items with (`isItemTypeTag`), in name order. Each is a tag as Obsidian lists it, `#` first.
 *
 * Picking one only calls the `onSelect` callback, as Obsidian's popup does:
 * filling the input ({@link withSuggestion}) and closing the popup is the
 * caller's to do.
 */
export class TagSuggest extends AbstractInputSuggest<string> {
  getSuggestions(query: string): string[] {
    const { before, typing } = splitLast(query);
    const needle = typing.replace(/^#+/, '').toLowerCase();
    const listed = new Set(parseTagList(before));
    const { metadataCache } = this.app;
    // Undocumented (typed in obsidian-typings; read from Obsidian 1.13.7's
    // obsidian.asar): every tag in the vault, `#` first, nested ones and each
    // tag they are nested in, mapped to how many notes carry it. Nothing to
    // suggest should a later version drop it.
    const tags =
      typeof metadataCache.getTags === 'function'
        ? Object.keys(metadataCache.getTags())
        : [];
    return tags
      .filter((tag) => {
        const name = tag.slice(1).toLowerCase();
        return (
          name.includes(needle) && !listed.has(name) && !isItemTypeTag(name)
        );
      })
      .sort((a, b) => a.localeCompare(b));
  }

  renderSuggestion(tag: string, el: HTMLElement): void {
    el.textContent = tag;
  }
}
