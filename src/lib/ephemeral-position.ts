/**
 * The ephemeral state keys `MarkdownView.setEphemeralState` moves the note
 * for: a link's heading or block (`subpath`), a search or backlinks result
 * (`match`, `line`, `startLoc`, `propertyMatches`), and back/forward
 * (`cursor`, `scroll`). Everything else it takes — `focus`, say — leaves the
 * scroll position alone.
 */
export const POSITIONAL_ESTATE_KEYS = [
  'subpath',
  'match',
  'line',
  'startLoc',
  'propertyMatches',
  'cursor',
  'scroll',
] as const;

/** Whether opening a note with `state` puts it at a particular place. */
export function isPositionalEState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  return POSITIONAL_ESTATE_KEYS.some((key) => Object.hasOwn(state, key));
}

/**
 * Views told where to put the note they loaded since it loaded. Weak, so a
 * closed view is never kept alive by having been marked.
 */
const positioned = new WeakSet<object>();

/**
 * Record that `view` was just handed `state`, if that state positions it.
 *
 * Obsidian hands a leaf's ephemeral state to its view only once the file has
 * loaded (`WorkspaceLeaf.setViewState` awaits `setState` first), which is
 * after an editor extension built for that file has started up and before
 * anything it deferred to a later frame runs.
 */
export function markEState(view: object, state: unknown): void {
  if (isPositionalEState(state)) positioned.add(view);
}

/** Forget any mark on `view`: it has loaded a note afresh. */
export function clearPositioned(view: object): void {
  positioned.delete(view);
}

/** Whether `view` was positioned since it last loaded a note. */
export function wasPositioned(view: object): boolean {
  return positioned.has(view);
}

type EStateReceiver = { setEphemeralState: (state: unknown) => void };

/**
 * Wrap `proto.setEphemeralState` so every call is recorded with
 * {@link markEState} before the original runs. Returns the uninstaller.
 *
 * The uninstaller puts the original back only while the wrapper is still the
 * installed method. If something wrapped it again since, removing it would
 * drop that wrapper too; instead the wrapper stays and just stops recording.
 */
export function recordEphemeralState(proto: EStateReceiver): () => void {
  const original = proto.setEphemeralState;
  let active = true;
  const wrapper = function (this: object, state: unknown) {
    if (active) markEState(this, state);
    original.call(this, state);
  };
  proto.setEphemeralState = wrapper;
  return () => {
    active = false;
    if (proto.setEphemeralState === wrapper) {
      proto.setEphemeralState = original;
    }
  };
}
