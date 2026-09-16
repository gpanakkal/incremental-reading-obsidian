// @vitest-environment jsdom
import fc from 'fast-check';
import type { WorkspaceLeaf } from 'obsidian';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLeafHistory } from './useLeafHistory';

// #region HELPERS

type Stack = 'backHistory' | 'forwardHistory';

type EventRef = { name: string; callback: () => void };

/**
 * Stand-in for a leaf: the two history stacks, mutated in place as Obsidian's
 * are, and an event hub keyed by event name. Keyed rather than hearing every
 * event, so a subscription to anything but `history-change` shows up as one
 * that is never told history changed.
 */
function makeLeaf({ back = 0, forward = 0 } = {}) {
  const handlers = new Map<string, Set<() => void>>();
  const refs: EventRef[] = [];
  const on = vi.fn((name: string, callback: () => void): EventRef => {
    const named = handlers.get(name) ?? new Set();
    handlers.set(name, named);
    named.add(callback);
    const ref = { name, callback };
    refs.push(ref);
    return ref;
  });
  const offref = vi.fn((ref: EventRef) => {
    handlers.get(ref.name)?.delete(ref.callback);
  });
  return {
    history: {
      backHistory: Array.from({ length: back }, () => ({})),
      forwardHistory: Array.from({ length: forward }, () => ({})),
    },
    on,
    offref,
    refs,
    trigger: (name: string) => {
      [...(handlers.get(name) ?? [])].forEach((callback) => callback());
    },
    /** Subscriptions still held, across every event name. */
    listenerCount: () =>
      [...handlers.values()].reduce((sum, named) => sum + named.size, 0),
  };
}

type FakeLeaf = ReturnType<typeof makeLeaf>;

/** Renders the hook's flags where a test can read them. */
function Probe({ leaf }: { leaf: FakeLeaf }) {
  const { canGoBack, canGoForward } = useLeafHistory(
    leaf as unknown as WorkspaceLeaf
  );
  return (
    <output data-back={String(canGoBack)} data-forward={String(canGoForward)} />
  );
}

function mount(leaf: FakeLeaf): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(<Probe leaf={leaf} />, container);
  return container;
}

function unmount(container: HTMLElement): void {
  render(null, container);
  container.remove();
}

function flags(container: HTMLElement) {
  const output = container.querySelector('output');
  if (!output) throw new Error('probe not rendered');
  return {
    canGoBack: output.dataset.back === 'true',
    canGoForward: output.dataset.forward === 'true',
  };
}

function expected(leaf: FakeLeaf) {
  return {
    canGoBack: leaf.history.backHistory.length > 0,
    canGoForward: leaf.history.forwardHistory.length > 0,
  };
}

/**
 * Let preact catch up: long enough for the deferred effect that subscribes
 * (preact falls back to a 100ms timeout when no frame is painted), and awaited
 * so a re-render an event schedules lands before the next assertion.
 */
async function settle() {
  await vi.advanceTimersByTimeAsync(200);
}

const lengthArb = fc.nat({ max: 6 });

/** A change to one stack, made in place the way Obsidian makes its own. */
const editArb = fc.record({
  stack: fc.constantFrom<Stack>('backHistory', 'forwardHistory'),
  kind: fc.constantFrom<'push' | 'pop' | 'clear'>('push', 'pop', 'clear'),
});

function applyEdit(
  leaf: FakeLeaf,
  { stack, kind }: { stack: Stack; kind: 'push' | 'pop' | 'clear' }
): void {
  const entries = leaf.history[stack];
  if (kind === 'push') entries.push({});
  else if (kind === 'pop') entries.pop();
  else entries.length = 0;
}
// #endregion

describe('useLeafHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports whether each stack has an entry to move to', async () => {
    await fc.assert(
      fc.asyncProperty(lengthArb, lengthArb, async (back, forward) => {
        const leaf = makeLeaf({ back, forward });

        const container = mount(leaf);
        try {
          expect(flags(container)).toEqual({
            canGoBack: back > 0,
            canGoForward: forward > 0,
          });
          await settle();
          expect(flags(container)).toEqual({
            canGoBack: back > 0,
            canGoForward: forward > 0,
          });
        } finally {
          unmount(container);
        }
      }),
      { numRuns: 40 }
    );
  });

  it('follows stacks changed in place as history-change reports them', async () => {
    // Nothing re-renders the component from outside: the only thing that can
    // bring it up to date is the event.
    await fc.assert(
      fc.asyncProperty(
        lengthArb,
        lengthArb,
        fc.array(editArb, { minLength: 1, maxLength: 6 }),
        async (back, forward, edits) => {
          const leaf = makeLeaf({ back, forward });
          const { backHistory, forwardHistory } = leaf.history;
          const container = mount(leaf);
          try {
            await settle();
            for (const edit of edits) {
              applyEdit(leaf, edit);
              leaf.trigger('history-change');
              await settle();

              expect(flags(container)).toEqual(expected(leaf));
            }
            // Still the arrays the leaf started with.
            expect(leaf.history.backHistory).toBe(backHistory);
            expect(leaf.history.forwardHistory).toBe(forwardHistory);
          } finally {
            unmount(container);
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  it('listens for history-change and nothing else', async () => {
    const leaf = makeLeaf();
    const container = mount(leaf);
    await settle();

    expect(leaf.on).toHaveBeenCalled();
    for (const [name] of leaf.on.mock.calls) {
      expect(name).toBe('history-change');
    }
    unmount(container);
  });

  it('lets go of every subscription when unmounted', async () => {
    const leaf = makeLeaf();
    const container = mount(leaf);
    await settle();
    expect(leaf.listenerCount()).toBeGreaterThan(0);

    unmount(container);
    await settle();

    expect(leaf.listenerCount()).toBe(0);
    for (const ref of leaf.refs) {
      expect(leaf.offref).toHaveBeenCalledWith(ref);
    }
  });

  it('moves to a new leaf: its stacks, its events, and none of the old', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(lengthArb, lengthArb),
        fc.tuple(lengthArb, lengthArb),
        editArb,
        async ([backA, forwardA], [backB, forwardB], edit) => {
          const first = makeLeaf({ back: backA, forward: forwardA });
          const second = makeLeaf({ back: backB, forward: forwardB });
          const container = mount(first);
          try {
            await settle();

            render(<Probe leaf={second} />, container);
            await settle();

            expect(flags(container)).toEqual(expected(second));
            expect(first.listenerCount()).toBe(0);
            expect(second.listenerCount()).toBeGreaterThan(0);

            applyEdit(second, edit);
            second.trigger('history-change');
            await settle();

            expect(flags(container)).toEqual(expected(second));
          } finally {
            unmount(container);
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});
