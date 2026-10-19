import type { ExplorerComparator } from '#/lib/explorer-order';
import { matchAnyTags } from '#/lib/tags';
import type { Vault } from 'obsidian';
import type { CandidateChecks } from './candidates';
import { listSource } from './list-source';
import type { CandidateSource } from './types';

/**
 * `tags`, as `parseTagList` reads them, written out for the user as a list
 * they could type back in: each after a `#`, separated by commas.
 */
export function tagListText(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(', ');
}

/**
 * The notes carrying any of `tags`, as Obsidian's tag search finds them (see
 * `matchAnyTags`: frontmatter or body, nested tags under the tags they are
 * nested in), offered for import as {@link listSource} offers a list: under
 * their folders, from the vault root, those already items left out. Only
 * notes, since nothing else carries tags. The notes are found once, now.
 *
 * Titled with the tags, as {@link tagListText} writes them.
 */
export function tagSource(
  tags: readonly string[],
  vault: Pick<Vault, 'getMarkdownFiles'>,
  checks: CandidateChecks,
  compare: ExplorerComparator
): CandidateSource {
  const { metadataCache } = checks.app;
  const matches = vault
    .getMarkdownFiles()
    .filter(
      (file) => matchAnyTags(metadataCache.getFileCache(file), tags).length > 0
    );
  return listSource(matches, checks, compare, tagListText(tags));
}
