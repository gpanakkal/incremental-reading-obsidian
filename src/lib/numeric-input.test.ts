// @vitest-environment jsdom
import {
  insert,
  insertedTextArb,
  insertionArb,
  isFiltered,
  selectionOf,
} from '#/test/text-insertion';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterDigitInsertions,
  filterInsertions,
  sanitizeDigitText,
} from './numeric-input';

// #region HELPERS
const ASCII_DIGITS = /[0-9]/g;

/** The ASCII digits of `text`, in order. */
const digitsOf = (text: string) => (text.match(ASCII_DIGITS) ?? []).join('');

/** What a digits-only input could hold, clean or not. */
const valueArb = fc.oneof(fc.stringMatching(/^[0-9]{0,4}$/), insertedTextArb);

function makeInput(value: string) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  // Heard where a listener delegating from an ancestor would hear them
  const heard: InputEvent[] = [];
  const parent = document.createElement('div');
  parent.appendChild(input);
  document.body.appendChild(parent);
  parent.addEventListener('input', (event) => heard.push(event as InputEvent));
  return { input, heard };
}

/**
 * Text with its line breaks dropped, as a text input drops them from its value
 * whatever puts them there.
 */
const singleLine = (text: string) => text.replaceAll(/[\r\n]/g, '');

/**
 * A stand-in for what a field keeps of inserted text: the text itself when
 * `keepsAll`, else whatever `pick` makes of the text and the rest of the field.
 */
const sanitizerArb = fc.record({
  keepsAll: fc.boolean(),
  pick: fc.func(fc.oneof(fc.constant(''), insertedTextArb.map(singleLine))),
});
// #endregion

describe('sanitizeDigitText', () => {
  it('keeps only the ASCII digits of any text, in order', () => {
    fc.assert(
      fc.property(insertedTextArb, (text) => {
        const kept = sanitizeDigitText(text);

        expect(kept).toMatch(/^[0-9]*$/);
        expect(kept).toBe(digitsOf(text));
      })
    );
  });
});

describe('filterInsertions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('puts what the field keeps of inserted text in place of the selection, caret after it, or does nothing when it keeps none', () => {
    fc.assert(
      fc.property(
        valueArb,
        insertionArb.map((insertion) => ({
          ...insertion,
          text: singleLine(insertion.text),
        })),
        sanitizerArb,
        (value, insertion, { keepsAll, pick }) => {
          fc.pre(isFiltered(insertion));
          const { input, heard } = makeInput(value);
          const before = input.value;
          const [start, end] = selectionOf(before, insertion);
          const head = before.slice(0, start);
          const tail = before.slice(end);
          const sanitize = vi.fn((text: string, rest: string) =>
            keepsAll ? text : pick(text, rest)
          );
          filterInsertions(input, sanitize);

          const proceeds = insert(input, insertion);

          const { text } = insertion;
          // Told what went in and what of the field it goes beside
          expect(sanitize).toHaveBeenCalledExactlyOnceWith(text, head + tail);
          const kept = sanitize.mock.results[0].value as string;
          // Text kept whole is the browser's to insert
          expect(proceeds).toBe(kept === text);
          if (kept === '' && text !== '') {
            // Nothing happens, as for any key the input ignores
            expect(input.value).toBe(before);
            expect([input.selectionStart, input.selectionEnd]).toEqual([
              start,
              end,
            ]);
            expect(heard).toHaveLength(0);
          } else {
            expect(input.value).toBe(head + kept + tail);
            const caret = start + kept.length;
            expect([input.selectionStart, input.selectionEnd]).toEqual([
              caret,
              caret,
            ]);
            // Anyone listening hears of the insertion, once, as what went in
            expect(heard).toHaveLength(1);
            expect(heard[0].inputType).toBe(insertion.inputType);
            if (kept !== text) expect(heard[0].data).toBe(kept);
          }
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('leaves drops, spelling replacements, compositions, deletions and edits it cannot cancel to the browser', () => {
    fc.assert(
      fc.property(
        valueArb,
        insertionArb,
        sanitizerArb,
        (value, insertion, { pick }) => {
          fc.pre(!isFiltered(insertion));
          const { input } = makeInput(value);
          const sanitize = vi.fn(pick);
          filterInsertions(input, sanitize);

          expect(insert(input, insertion)).toBe(true);
          expect(sanitize).not.toHaveBeenCalled();
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('leaves an insertion that carries no text to the browser', () => {
    fc.assert(
      fc.property(
        valueArb,
        insertionArb,
        sanitizerArb,
        (value, insertion, { pick }) => {
          const { input } = makeInput(value);
          const before = input.value;
          const sanitize = vi.fn(pick);
          filterInsertions(input, sanitize);
          const event = new InputEvent('beforeinput', {
            cancelable: true,
            inputType: insertion.inputType,
            data: null,
          });

          expect(input.dispatchEvent(event)).toBe(true);
          expect(input.value).toBe(before);
          expect(sanitize).not.toHaveBeenCalled();
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('stops filtering once detached', () => {
    const { input } = makeInput('4');
    const detach = filterInsertions(input, () => '');

    detach();
    insert(input, {
      inputType: 'insertText',
      text: 'a',
      via: 'data',
      cancelable: true,
      anchor: 1,
      head: 1,
    });

    expect(input.value).toBe('4a');
  });
});

describe('filterDigitInsertions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('puts only the digits of inserted text in place of the selection, caret after them', () => {
    fc.assert(
      fc.property(valueArb, insertionArb, (value, insertion) => {
        fc.pre(isFiltered(insertion));
        const { input } = makeInput(value);
        const before = input.value;
        const [start, end] = selectionOf(before, insertion);
        const head = before.slice(0, start);
        const tail = before.slice(end);
        filterDigitInsertions(input);

        insert(input, insertion);

        const { text } = insertion;
        const digits = digitsOf(text);
        if (digits === '' && text !== '') {
          expect(input.value).toBe(before);
          expect([input.selectionStart, input.selectionEnd]).toEqual([
            start,
            end,
          ]);
        } else {
          expect(input.value).toBe(head + digits + tail);
          const caret = start + digits.length;
          expect([input.selectionStart, input.selectionEnd]).toEqual([
            caret,
            caret,
          ]);
        }
        document.body.innerHTML = '';
      })
    );
  });

  it('leaves digits alone for the browser to insert', () => {
    fc.assert(
      fc.property(
        valueArb,
        insertionArb,
        fc.stringMatching(/^[0-9]*$/),
        (value, insertion, text) => {
          const { input } = makeInput(value);
          filterDigitInsertions(input);

          expect(insert(input, { ...insertion, text })).toBe(true);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('stops filtering once detached', () => {
    const { input } = makeInput('4');
    const detach = filterDigitInsertions(input);

    detach();
    insert(input, {
      inputType: 'insertText',
      text: 'a',
      via: 'data',
      cancelable: true,
      anchor: 1,
      head: 1,
    });

    expect(input.value).toBe('4a');
  });
});
