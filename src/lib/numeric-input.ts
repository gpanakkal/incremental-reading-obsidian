/**
 * What a digits-only input can show of `text`: its ASCII digits, in order.
 * Everything else is dropped, including digits of other scripts.
 */
export function sanitizeDigitText(text: string): string {
  let kept = '';
  for (const char of text) {
    if (char >= '0' && char <= '9') kept += char;
  }
  return kept;
}

/**
 * Makes `input` drop whatever it can't hold from text typed, pasted or
 * otherwise inserted into it, before the browser inserts it, so nothing else is
 * ever shown and the caret stays where the text went. `sanitize` gets the
 * inserted text and the rest of the field (its text outside the selection the
 * insertion replaces) and returns what of the text to keep.
 *
 * Insertions it can't filter this way are left to the browser: drops and
 * spelling replacements (the text lands at the drop point or on the word
 * replaced, not the input's selection), IME compositions and any edit that
 * can't be cancelled. Clean those up on `input`.
 * @returns a function that stops the filtering
 */
export function filterInsertions(
  input: HTMLInputElement,
  sanitize: (text: string, rest: string) => string
): () => void {
  const onBeforeInput = (event: InputEvent) => {
    const { inputType } = event;
    if (
      !event.cancelable ||
      !inputType.startsWith('insert') ||
      inputType === 'insertFromDrop' ||
      inputType === 'insertReplacementText' ||
      inputType === 'insertCompositionText'
    ) {
      return;
    }
    // Pastes into an input carry their text as `data` in Chromium and Firefox,
    // but may carry it as `dataTransfer` instead, as rich text editors get it
    const text = event.data ?? event.dataTransfer?.getData('text/plain');
    if (text === undefined) return;

    const { value } = input;
    // Only inputs without text selection (number, date...) have none, and
    // setRangeText throws on those anyway
    const start = input.selectionStart!;
    const end = input.selectionEnd!;
    const kept = sanitize(text, value.slice(0, start) + value.slice(end));
    if (kept === text) return;

    event.preventDefault();
    if (kept === '') return;
    input.setRangeText(kept, start, end, 'end');
    // setRangeText fires no input event of its own
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType, data: kept })
    );
  };

  input.addEventListener('beforeinput', onBeforeInput);
  return () => input.removeEventListener('beforeinput', onBeforeInput);
}

/**
 * {@link filterInsertions} for an input that holds ASCII digits only; clean up
 * what it leaves to the browser with {@link sanitizeDigitText}.
 */
export function filterDigitInsertions(input: HTMLInputElement): () => void {
  return filterInsertions(input, sanitizeDigitText);
}
