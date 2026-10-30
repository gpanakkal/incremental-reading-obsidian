// @vitest-environment jsdom
import {
  insert,
  insertedTextArb,
  insertionArb,
  isFiltered,
  selectionOf,
} from '#/test/text-insertion';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterPriorityInsertions,
  sanitizePriorityText,
} from './priority-input';

// #region HELPERS
/** Text made of ASCII digits and at most one decimal point. */
const PRIORITY_TEXT = /^[0-9]*\.?[0-9]*$/;

const ASCII_DIGITS = /[0-9]/g;
const ASCII_DIGIT = /[0-9]/;

/**
 * Checks that `kept` is what a priority input keeps of `text`: its ASCII
 * digits in order, and its first point where it fell among them unless a point
 * is `pointTaken` already, and nothing else.
 */
function expectKeptOf(text: string, kept: string, pointTaken: boolean) {
  expect(kept).toMatch(PRIORITY_TEXT);
  expect(kept.replace('.', '')).toBe((text.match(ASCII_DIGITS) ?? []).join(''));
  const point = text.indexOf('.');
  if (pointTaken || point === -1) {
    expect(kept).not.toContain('.');
  } else {
    const digitsBefore = (text.slice(0, point).match(ASCII_DIGITS) ?? [])
      .length;
    expect(kept.indexOf('.')).toBe(digitsBefore);
  }
}

/** What a priority input could hold, clean or not. */
const valueArb = fc.oneof(
  fc.stringMatching(/^[0-9]{0,3}(\.[0-9]{0,2})?$/),
  insertedTextArb
);

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
// #endregion

describe('sanitizePriorityText', () => {
  it('keeps only the ASCII digits of any text and its first decimal point', () => {
    fc.assert(
      fc.property(insertedTextArb, (text) => {
        expectKeptOf(text, sanitizePriorityText(text), false);
      })
    );
  });

  it('keeps the first of several decimal points and drops the rest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[0-9]{0,2}$/), {
          minLength: 3,
          maxLength: 5,
        }),
        ([whole, ...fractions]) => {
          const text = [whole, ...fractions].join('.');

          expect(sanitizePriorityText(text)).toBe(
            `${whole}.${fractions.join('')}`
          );
        }
      )
    );
  });

  it('keeps no decimal point when the text goes where one is already', () => {
    fc.assert(
      fc.property(insertedTextArb, (text) => {
        expectKeptOf(text, sanitizePriorityText(text, true), true);
      })
    );
  });
});

describe('filterPriorityInsertions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('puts only what a priority can have of inserted text in place of the selection, caret after it', () => {
    fc.assert(
      fc.property(valueArb, insertionArb, (value, insertion) => {
        fc.pre(isFiltered(insertion));
        const { input, heard } = makeInput(value);
        const before = input.value;
        const [start, end] = selectionOf(before, insertion);
        const head = before.slice(0, start);
        const tail = before.slice(end);
        filterPriorityInsertions(input);

        insert(input, insertion);

        const pointTaken = (head + tail).includes('.');
        const { text } = insertion;
        const nothingKept =
          text !== '' &&
          !ASCII_DIGIT.test(text) &&
          (pointTaken || !text.includes('.'));
        if (nothingKept) {
          // Nothing happens, as for any key the input ignores
          expect(input.value).toBe(before);
          expect([input.selectionStart, input.selectionEnd]).toEqual([
            start,
            end,
          ]);
          expect(heard).toHaveLength(0);
        } else {
          const after = input.value;
          expect(after.startsWith(head)).toBe(true);
          expect(after.endsWith(tail)).toBe(true);
          const kept = after.slice(start, after.length - tail.length);
          expectKeptOf(text, kept, pointTaken);
          const caret = start + kept.length;
          expect([input.selectionStart, input.selectionEnd]).toEqual([
            caret,
            caret,
          ]);
          // Anyone listening hears of the insertion, once, as what went in
          expect(heard).toHaveLength(1);
          if (kept !== text) {
            expect([heard[0].inputType, heard[0].data]).toEqual([
              insertion.inputType,
              kept,
            ]);
          }
        }
        document.body.innerHTML = '';
      })
    );
  });

  it('lets a point in that replaces the only one in the field', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9]{0,3}$/),
        fc.stringMatching(/^[0-9]{0,3}$/),
        fc.stringMatching(/^[^0-9]{0,3}\.[0-9]{0,2}$/),
        fc.constantFrom('insertText', 'insertFromPaste'),
        (whole, tenths, text, inputType) => {
          fc.pre(/[^0-9.]/.test(text));
          const { input } = makeInput(`${whole}.${tenths}`);
          filterPriorityInsertions(input);

          insert(input, {
            inputType,
            text,
            via: 'data',
            cancelable: true,
            anchor: whole.length,
            head: whole.length + 1,
          });

          expect(input.value).toBe(whole + sanitizePriorityText(text) + tenths);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('leaves text with nothing to drop to the browser to insert', () => {
    fc.assert(
      fc.property(
        valueArb,
        insertionArb,
        fc.stringMatching(/^[0-9]*\.?[0-9]*$/),
        (value, insertion, text) => {
          const { input } = makeInput(value);
          const [start, end] = selectionOf(input.value, insertion);
          const rest = input.value.slice(0, start) + input.value.slice(end);
          fc.pre(!(rest.includes('.') && text.includes('.')));
          filterPriorityInsertions(input);

          expect(insert(input, { ...insertion, text })).toBe(true);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('leaves drops, spelling replacements, compositions, deletions and edits it cannot cancel to the browser', () => {
    fc.assert(
      fc.property(valueArb, insertionArb, (value, insertion) => {
        fc.pre(!isFiltered(insertion));
        const { input } = makeInput(value);
        filterPriorityInsertions(input);

        expect(insert(input, insertion)).toBe(true);
        document.body.innerHTML = '';
      })
    );
  });

  it('leaves an insertion that carries no text to the browser', () => {
    fc.assert(
      fc.property(valueArb, insertionArb, (value, insertion) => {
        const { input } = makeInput(value);
        const before = input.value;
        filterPriorityInsertions(input);
        const event = new InputEvent('beforeinput', {
          cancelable: true,
          inputType: insertion.inputType,
          data: null,
        });

        expect(input.dispatchEvent(event)).toBe(true);
        expect(input.value).toBe(before);
        document.body.innerHTML = '';
      })
    );
  });

  it('stops filtering once detached', () => {
    const { input } = makeInput('4');
    const detach = filterPriorityInsertions(input);

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
