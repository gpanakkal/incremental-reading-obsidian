/**
 * What a priority input can show of `text`: its ASCII digits and its first
 * decimal point, or no point at all if `pointTaken` (the text goes into a
 * field that has one already). Everything else is dropped, as
 * `IRScheduler.adjustDisplayPriorityOnChange` drops it, so a comma is dropped
 * rather than read as a point.
 */
export function sanitizePriorityText(text: string, pointTaken = false): string {
  let hasPoint = pointTaken;
  let kept = '';
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      kept += char;
    } else if (char === '.' && !hasPoint) {
      hasPoint = true;
      kept += char;
    }
  }
  return kept;
}

/**
 * Makes `input` drop whatever a priority can't have from text typed, pasted or
 * otherwise inserted into it, before the browser inserts it, so nothing else is
 * ever shown and the caret stays where the text went.
 *
 * Insertions it can't filter this way are left to the browser: drops and
 * spelling replacements (the text lands at the drop point or on the word
 * replaced, not the input's selection), IME compositions and any edit that
 * can't be cancelled. Clean those up on `input` with
 * {@link sanitizePriorityText}.
 * @returns a function that stops the filtering
 */
export function filterPriorityInsertions(input: HTMLInputElement): () => void {
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
    const rest = value.slice(0, start) + value.slice(end);
    const kept = sanitizePriorityText(text, rest.includes('.'));
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
