import fc from 'fast-check';

/** An edit that puts text into an input, as its `beforeinput` event says. */
export interface Insertion {
  inputType: string;
  text: string;
  /**
   * Where the event carries the text: `data` for typing and, in Chromium and
   * Firefox, pastes into an input; `dataTransfer` where it holds rich data
   */
  via: 'data' | 'dataTransfer';
  cancelable: boolean;
  /** Where the replaced selection starts and ends, before clamping */
  anchor: number;
  head: number;
}

/** Any text, weighted towards digits, decimal separators and their neighbours. */
export const insertedTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  {
    weight: 4,
    arbitrary: fc.string({
      unit: fc.constantFrom(
        ...'0123456789..,,ae+- \t\n\r'.split(''),
        // Full-width and Arabic-Indic digits: digits, but not ASCII ones
        '\uFF11',
        '\u0663',
        // Full-width stop and Arabic decimal separator: points, but not ASCII
        '\uFF0E',
        '\u066B',
        // A combining mark, a surrogate pair, and each half of one alone
        '\u0301',
        '\u{1F600}',
        '\uD83D',
        '\uDE00'
      ),
      maxLength: 8,
    }),
  }
);

/** Every kind of edit an input reports, and one made up. */
const inputTypeArb = fc.constantFrom(
  'insertText',
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertReplacementText',
  'insertFromYank',
  'insertCompositionText',
  'insertLineBreak',
  'deleteContentBackward',
  'deleteByCut',
  'historyUndo',
  ''
);

export const insertionArb: fc.Arbitrary<Insertion> = fc.record({
  inputType: inputTypeArb,
  text: insertedTextArb,
  via: fc.constantFrom('data', 'dataTransfer'),
  cancelable: fc.boolean(),
  anchor: fc.nat(),
  head: fc.nat(),
});

/** The selection an insertion replaces in `value`. */
export function selectionOf(
  value: string,
  { anchor, head }: Pick<Insertion, 'anchor' | 'head'>
): [start: number, end: number] {
  const a = anchor % (value.length + 1);
  const b = head % (value.length + 1);
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * Puts `insertion` into `input` as a browser would: selects the range it
 * replaces, fires `beforeinput`, and unless a listener cancels it, replaces the
 * selection with the text and fires `input`.
 * @returns whether the browser's own insertion ran
 */
export function insert(input: HTMLInputElement, insertion: Insertion): boolean {
  const { inputType, text, via, cancelable } = insertion;
  const [start, end] = selectionOf(input.value, insertion);
  input.setSelectionRange(start, end);
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable,
    inputType,
    data: via === 'data' ? text : null,
  });
  if (via === 'dataTransfer') {
    // jsdom's InputEvent has no dataTransfer
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? text : ''),
      },
    });
  }
  const proceeds = input.dispatchEvent(event);
  if (proceeds) {
    input.setRangeText(text, start, end, 'end');
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType, data: event.data })
    );
  }
  return proceeds;
}

/** Whether the field filters `insertion` itself, in place of the browser. */
export function isFiltered({
  inputType,
  cancelable,
}: Pick<Insertion, 'inputType' | 'cancelable'>): boolean {
  return (
    cancelable &&
    inputType.startsWith('insert') &&
    inputType !== 'insertFromDrop' &&
    inputType !== 'insertReplacementText' &&
    inputType !== 'insertCompositionText'
  );
}
