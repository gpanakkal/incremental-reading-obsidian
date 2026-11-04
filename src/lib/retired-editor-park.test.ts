// @vitest-environment jsdom

import {
  RETIRED_EDITOR_LIMIT,
  RetiredEditorPark,
  type RetiredEditorAnswerer,
} from '#/lib/retired-editor-park';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

/** An editor's content element as review takes it down: editable, detached. */
function makeRetiredEditor(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  return el;
}

const NOTE = { path: 'Notes/typed in.md' } as TFile;
const OTHER_NOTE = { path: 'Notes/other.md' } as TFile;

/** A `beforeinput` of `inputType`, as a native undo or redo sends it. */
function makeHistoryInput(inputType = 'historyUndo') {
  return new InputEvent('beforeinput', {
    inputType,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Something that answers for typing in `answersFor`, as a review tab whose
 * editor shows that note does: it prevents the event's default when it takes
 * it.
 */
function makeAnswerer(answersFor: TFile | null = NOTE) {
  const answered: [string, TFile][] = [];
  const asked = vi.fn((evt: InputEvent, file: TFile) => {
    if (file !== answersFor) return false;
    evt.preventDefault();
    answered.push([evt.inputType, file]);
    return true;
  });
  const answerer: RetiredEditorAnswerer = { answerRetiredHistoryInput: asked };
  return { answerer, answered, asked };
}

// #endregion

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('RetiredEditorPark.keep', () => {
  it('keeps a taken-down editor in its document, hidden, and hands a native undo or redo sent to it to whoever answers for its note', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('historyUndo', 'historyRedo'),
        fc.constantFrom('the same note', 'another note'),
        (inputType, typedIn) => {
          document.body.replaceChildren();
          const park = new RetiredEditorPark(true);
          const { answerer, answered } = makeAnswerer();
          park.listen(answerer);
          const el = makeRetiredEditor();
          const file = typedIn === 'the same note' ? NOTE : OTHER_NOTE;

          park.keep(el, file);
          const evt = makeHistoryInput(inputType);
          el.dispatchEvent(evt);

          expect(el.isConnected).toBe(true);
          expect(el.closest('[hidden]')).not.toBeNull();
          const taken = typedIn === 'the same note';
          expect(evt.defaultPrevented).toBe(taken);
          expect(answered).toEqual(taken ? [[inputType, NOTE]] : []);
        }
      )
    );
  });

  it('keeps nothing where the engine drops the undo of typing in removed elements', () => {
    const park = new RetiredEditorPark(false);
    const { answerer, asked } = makeAnswerer();
    park.listen(answerer);
    const el = makeRetiredEditor();

    park.keep(el, NOTE);
    el.dispatchEvent(makeHistoryInput());

    expect(el.isConnected).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks each answerer in turn until one takes it, and asks no answerer that stopped listening', () => {
    const park = new RetiredEditorPark(true);
    const closed = makeAnswerer();
    const elsewhere = makeAnswerer(OTHER_NOTE);
    const open = makeAnswerer();
    const after = makeAnswerer();
    const stop = park.listen(closed.answerer);
    park.listen(elsewhere.answerer);
    park.listen(open.answerer);
    park.listen(after.answerer);
    stop();
    const el = makeRetiredEditor();
    park.keep(el, NOTE);

    el.dispatchEvent(makeHistoryInput());

    expect(closed.asked).not.toHaveBeenCalled();
    expect(elsewhere.asked).toHaveBeenCalledOnce();
    expect(open.answered).toHaveLength(1);
    expect(after.asked).not.toHaveBeenCalled();
  });

  it(`keeps only the ${RETIRED_EDITOR_LIMIT} editors taken down last, and answers only theirs`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: RETIRED_EDITOR_LIMIT * 2 + 1 }),
        (count) => {
          const park = new RetiredEditorPark(true);
          const { answerer, answered } = makeAnswerer();
          park.listen(answerer);
          try {
            const retired = Array.from({ length: count }, makeRetiredEditor);
            for (const el of retired) park.keep(el, NOTE);
            const kept = retired.slice(-RETIRED_EDITOR_LIMIT);

            expect(retired.filter((el) => el.isConnected)).toEqual(kept);
            for (const el of retired) el.dispatchEvent(makeHistoryInput());
            expect(answered).toHaveLength(kept.length);
          } finally {
            park.drop();
          }
        }
      )
    );
  });

  it('keeps a taken-down editor without the pages and media embedded in it, which would load again out of sight', () => {
    const park = new RetiredEditorPark(true);
    const el = makeRetiredEditor();
    const embeds = ['iframe', 'video', 'audio', 'embed', 'object'];
    const line = el.appendChild(document.createElement('div'));
    line.append('typed', ...embeds.map((tag) => document.createElement(tag)));

    park.keep(el, NOTE);

    expect(el.isConnected).toBe(true);
    expect(el.querySelector(embeds.join(', '))).toBeNull();
    expect(line.textContent).toBe('typed');
  });

  it("keeps an editor in its own window's document", () => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const doc = frame.contentDocument;
    if (!doc) throw new Error('No document in the frame');
    const park = new RetiredEditorPark(true);
    const el = doc.createElement('div');

    park.keep(el, NOTE);

    expect(el.ownerDocument).toBe(doc);
    expect(doc.body.contains(el)).toBe(true);
  });
});

describe('RetiredEditorPark.dropFile', () => {
  it("lets go of the editors kept for a deleted note, and keeps the others'", () => {
    const park = new RetiredEditorPark(true);
    const { answerer, asked } = makeAnswerer();
    park.listen(answerer);
    const deleted = makeRetiredEditor();
    const other = makeRetiredEditor();
    park.keep(deleted, NOTE);
    park.keep(other, OTHER_NOTE);

    park.dropFile(NOTE);
    deleted.dispatchEvent(makeHistoryInput());

    expect(deleted.isConnected).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    expect(other.isConnected).toBe(true);
  });
});

describe('RetiredEditorPark.drop', () => {
  it('lets go of every kept editor and its hiding place, answering none of them after', () => {
    const park = new RetiredEditorPark(true);
    const { answerer, asked } = makeAnswerer();
    park.listen(answerer);
    const kept = [makeRetiredEditor(), makeRetiredEditor()];
    for (const el of kept) park.keep(el, NOTE);
    const host = kept[0].parentElement;

    park.drop();
    for (const el of kept) el.dispatchEvent(makeHistoryInput());

    expect(kept.map((el) => el.isConnected)).toEqual([false, false]);
    expect(host?.isConnected).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });

  it('keeps editors again after a drop', () => {
    const park = new RetiredEditorPark(true);
    park.keep(makeRetiredEditor(), NOTE);
    park.drop();
    const el = makeRetiredEditor();

    park.keep(el, NOTE);

    expect(el.isConnected).toBe(true);
    expect(el.closest('[hidden]')).not.toBeNull();
  });
});
