import { tagListText } from '#/lib/bulk-import/tag-source';
import type { CandidateSource } from '#/lib/bulk-import/types';
import { parseTagList } from '#/lib/tags';
import type { App } from 'obsidian';
import { useLayoutEffect, useRef } from 'react';
import type { FilterRowProps, FilterSegment } from './BulkImportFilterBar';
import { TagSuggest, withSuggestion } from './TagSuggest';

/** How long typing in the tag field pauses before what it lists changes. */
export const TAG_FILTER_DEBOUNCE_MS = 300;

/**
 * The tag filter: a text input taking one or more tags, separated by commas
 * (or spaces), suggesting the vault's tags for the one being typed. It lists
 * what `makeSource` makes of the tags typed once typing pauses, or of a tag
 * picked at once, and nothing for none; the same tags again change nothing.
 * It starts out holding `initialTags`, listing them at once.
 */
export function tagFilter(
  app: App,
  makeSource: (tags: readonly string[]) => CandidateSource,
  initialTags: readonly string[] = []
): FilterSegment {
  return {
    id: 'tag',
    label: 'Tags',
    row: ({ onSource }) => (
      <TagRow
        app={app}
        makeSource={makeSource}
        initialTags={initialTags}
        onSource={onSource}
      />
    ),
  };
}

function TagRow({
  app,
  makeSource,
  initialTags,
  onSource,
}: Pick<FilterRowProps, 'onSource'> & {
  app: App;
  makeSource: (tags: readonly string[]) => CandidateSource;
  initialTags: readonly string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The latest of what the row was handed, for the suggest and timer set up once
  const latestRef = useRef({ makeSource, onSource });
  useLayoutEffect(() => {
    latestRef.current = { makeSource, onSource };
  });
  // The tags listed, as one key; none to start with, as the bar starts
  const listedRef = useRef('');
  const timerRef = useRef<number | undefined>(undefined);
  // What the field starts out holding, read once
  const firstTagsRef = useRef(initialTags);

  // Once per row: Obsidian's suggest listens on the input for good, with no
  // way to stop it
  useLayoutEffect(() => {
    const input = inputRef.current!;
    const list = () => {
      window.clearTimeout(timerRef.current);
      const tags = parseTagList(input.value);
      // A tag holds no comma, so the key tells lists apart
      const key = tags.join(',');
      if (key === listedRef.current) return;
      listedRef.current = key;
      const { makeSource, onSource } = latestRef.current;
      onSource(tags.length === 0 ? null : makeSource(tags));
    };
    const onInput = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(list, TAG_FILTER_DEBOUNCE_MS);
    };
    input.value = tagListText(firstTagsRef.current);
    input.addEventListener('input', onInput);
    const suggest = new TagSuggest(app, input);
    suggest.onSelect((tag) => {
      suggest.setValue(withSuggestion(input.value, tag));
      suggest.close();
      list();
    });
    list();
    return () => {
      window.clearTimeout(timerRef.current);
      input.removeEventListener('input', onInput);
      suggest.close();
    };
  }, [app]);

  return (
    <div className="ir-bulk-import-filter-row">
      <input
        ref={inputRef}
        type="text"
        className="ir-bulk-import-tag-input"
        placeholder="#tag, #another"
      />
    </div>
  );
}
