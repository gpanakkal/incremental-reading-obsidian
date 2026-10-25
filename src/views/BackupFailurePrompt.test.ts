// @vitest-environment jsdom
import { DATA_DIRECTORY } from '#/lib/constants';
import * as notices from '#/lib/notices';
import { Modal, Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupFailureCause,
  createBackupFailurePrompt,
} from './BackupFailurePrompt';
import type { ConfirmModal } from './ConfirmModal';

// #region HELPERS

const APP = {} as App;

/** An error with Node's `code`, as the desktop adapter throws. */
function coded(code: string, message = 'write failed'): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Raise notices as Obsidian does, inside a `.notice-container` in the
 * document, so the element has a parent to leave.
 */
function noticesInDocument() {
  const container = document.body.createDiv('notice-container');
  vi.spyOn(notices, 'notify').mockImplementation((message, options) => {
    const notice = new Notice(message, options?.persist ? 0 : 4000);
    container.appendChild(notice.containerEl);
    return notice as never;
  });
  return container;
}

/** Open and close modals as Obsidian does (see `ConfirmModal.test.ts`). */
function wireModalLifecycle() {
  const open = vi.spyOn(Modal.prototype, 'open').mockImplementation(function (
    this: Modal
  ) {
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    document.body.appendChild(this.containerEl);
    (this as unknown as ConfirmModal).onOpen();
  });
  const close = vi.spyOn(Modal.prototype, 'close').mockImplementation(function (
    this: Modal
  ) {
    this.containerEl.remove();
    (this as unknown as ConfirmModal).onClose();
  });
  return { open, close };
}

/** The open confirmation's Cancel and confirm buttons. */
function modalButtons() {
  const [cancel, confirm] = document.querySelectorAll<HTMLButtonElement>(
    '.modal-button-container > button'
  );
  return { cancel, confirm };
}

/** The latest notice and its buttons. */
function latest() {
  const notice = Notice.instances[Notice.instances.length - 1];
  const [retry, proceed] =
    notice.containerEl.querySelectorAll<HTMLButtonElement>('button');
  return { notice, retry, proceed };
}

/** What `promise` settled with, or `'pending'` after a macrotask. */
function outcome<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'))),
  ]);
}

// #endregion

describe('backupFailureCause', () => {
  it.each([
    ['code', coded('ENOSPC')],
    ['message', new Error('ENOSPC: no space left on device, write')],
    [
      'message on iOS',
      new Error(
        'The file “x” couldn’t be saved because there isn’t enough space.'
      ),
    ],
  ])('calls a full disk by its %s', (_, error) => {
    expect(backupFailureCause(error)).toMatch(/full/);
  });

  it.each([
    ['EACCES code', coded('EACCES')],
    ['EPERM code', coded('EPERM')],
    ['EACCES message', new Error("EACCES: permission denied, open 'x'")],
    ['EPERM message', new Error('EPERM: operation not permitted')],
    [
      'message on iOS',
      new Error(
        'You don’t have permission to save the file “x” in the folder “y”.'
      ),
    ],
  ])('names the data directory for a refused write, by its %s', (_, error) => {
    expect(backupFailureCause(error)).toContain(DATA_DIRECTORY);
  });

  it('property: gives any other error by its first line that says anything', () => {
    const line = fc
      .string({ minLength: 1 })
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(
        (s) =>
          s.length > 0 &&
          !/ENOSPC|no space left|enough space|EACCES|EPERM|permission|not permitted/i.test(
            s
          )
      );
    const blank = fc.constantFrom('', ' ', '\t', '  ');
    // A rejection may be an `Error`, any object with a message, or a string
    const shape = fc.constantFrom('error', 'object', 'string');
    fc.assert(
      fc.property(
        fc.array(blank, { maxLength: 3 }),
        line,
        fc.string(),
        shape,
        (blanks, first, rest, as) => {
          const message = [...blanks, first, rest].join('\n');
          const error =
            as === 'error'
              ? new Error(message)
              : as === 'object'
                ? { message }
                : message;
          expect(backupFailureCause(error)).toBe(first);
        }
      )
    );
  });

  it('never gives an empty cause', () => {
    expect(backupFailureCause(new Error(' \n\t'))).toMatch(/\S/);
  });
});

describe('createBackupFailurePrompt', () => {
  beforeEach(() => {
    Notice.reset();
    document.body.replaceChildren();
    noticesInDocument();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one notice that stays up, saying why, and keeps it up when clicked', async () => {
    const prompt = createBackupFailurePrompt(APP);

    const answer = prompt.ask(coded('ENOSPC'));
    latest().notice.messageEl.click();
    latest().notice.containerEl.click();

    expect(Notice.instances).toHaveLength(1);
    const { notice, proceed } = latest();
    expect(notice.duration).toBe(0);
    expect(notice.messageEl.textContent).toMatch(/full/);
    expect(proceed.classList).toContain('mod-warning');
    expect(notice.hides).toBe(0);
    expect(await outcome(answer)).toBe('pending');
  });

  it('answers retry, rewriting the same notice when the retry fails too', async () => {
    const prompt = createBackupFailurePrompt(APP);

    const first = prompt.ask(coded('ENOSPC'));
    latest().retry.click();
    expect(await outcome(first)).toBe('retry');
    expect(latest().notice.hides).toBe(0);
    expect(latest().retry.disabled).toBe(true);

    const second = prompt.ask(coded('EACCES'));
    const { notice, retry, proceed } = latest();
    expect(Notice.instances).toHaveLength(1);
    expect(notice.messageEl.textContent).toContain(DATA_DIRECTORY);
    expect([retry.disabled, proceed.disabled]).toEqual([false, false]);
    expect(await outcome(second)).toBe('pending');
  });

  it('asks again in a modal before answering proceed, and Cancel goes back to the notice', async () => {
    const { open } = wireModalLifecycle();
    const prompt = createBackupFailurePrompt(APP);
    const answer = prompt.ask(coded('ENOSPC'));

    latest().proceed.click();
    expect(open).toHaveBeenCalledOnce();
    modalButtons().cancel.click();
    expect(await outcome(answer)).toBe('pending');
    expect(latest().notice.hides).toBe(0);

    latest().proceed.click();
    const { confirm } = modalButtons();
    expect(confirm.classList).toContain('mod-destructive');
    confirm.click();
    expect(await outcome(answer)).toBe('proceed');
  });

  it('takes the notice and an open modal down when closed', () => {
    const { close } = wireModalLifecycle();
    const prompt = createBackupFailurePrompt(APP);
    void prompt.ask(coded('ENOSPC'));
    latest().proceed.click();

    prompt.close();

    expect(latest().notice.hides).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('raises nothing again once closed, whatever then takes the notice away', async () => {
    const prompt = createBackupFailurePrompt(APP);
    void prompt.ask(coded('ENOSPC'));

    prompt.close();
    latest().notice.containerEl.remove(); // Obsidian's hide, done animating
    await new Promise((resolve) => setTimeout(resolve));

    expect(Notice.instances).toHaveLength(1);
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('raises the notice again when something else dismisses it', async () => {
    const prompt = createBackupFailurePrompt(APP);
    const answer = prompt.ask(coded('ENOSPC'));

    latest().notice.containerEl.remove(); // a swipe, on a phone
    await vi.waitFor(() => expect(Notice.instances).toHaveLength(2));

    const { notice, retry } = latest();
    expect(notice.containerEl.isConnected).toBe(true);
    expect(notice.messageEl.textContent).toMatch(/full/);
    retry.click();
    expect(await outcome(answer)).toBe('retry');
  });
});
