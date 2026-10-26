import { DATA_DIRECTORY } from '#/lib/constants';
import { notify } from '#/lib/notices';
import type { BackupFailurePrompt } from '#/lib/repository/SQLJSRepository';
import type { App, Notice } from 'obsidian';
import { ConfirmModal } from './ConfirmModal';

type Choice = 'retry' | 'proceed';

/**
 * Why a backup failed, in plain words: a full disk and a refused write by
 * their error codes, read from `code` (desktop: Node's) or the message
 * (mobile's adapter has no Node `code`: Android words it as Java's
 * `IOException` does, errno included, iOS as `NSError` does, without one);
 * otherwise the error's first line that says anything.
 */
export function backupFailureCause(error: unknown): string {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' ? raw : '';
  // Not only an `Error`: a rejection may be any object with a message
  const said = (error as { message?: unknown } | null)?.message;
  const message = typeof said === 'string' ? said : String(error);
  const says = (pattern: RegExp) => pattern.test(code) || pattern.test(message);
  if (says(/\bENOSPC\b|no space left|enough space/i)) return 'the disk is full';
  if (says(/\bE(?:ACCES|PERM)\b|permission|not permitted/i)) {
    return `there's no permission to write in ${DATA_DIRECTORY}`;
  }
  const line = message
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? 'an unknown error';
}

/** What the notice says about a backup that failed with `error`. */
export function backupFailureMessage(error: unknown): string {
  return (
    `Incremental reading: backing up the database before migrating it ` +
    `failed (${backupFailureCause(error)}). The plugin won't start until ` +
    `the backup works or you go ahead without it.`
  );
}

/**
 * The {@link BackupFailurePrompt} startup asks (0217): a notice that stays
 * up, saying why the backup failed, with Retry and a red "Proceed anyway",
 * which asks again in a confirmation modal before migrating without the
 * backup. A retry that fails again rewrites the notice in place.
 */
export function createBackupFailurePrompt(app: App): BackupFailurePrompt {
  let message = '';
  let answer: ((choice: Choice) => void) | null = null;
  let shown: {
    notice: Notice;
    buttons: HTMLButtonElement[];
    /** Stop watching for the notice going away. */
    release: () => void;
  } | null = null;
  let modal: ConfirmModal | null = null;

  const choose = (choice: Choice) => {
    const answered = answer;
    if (!answered) return;
    answer = null;
    // Until the next failure asks again, or the prompt closes
    for (const button of shown?.buttons ?? []) button.disabled = true;
    answered(choice);
  };

  const takeDown = () => {
    const was = shown;
    shown = null;
    was?.release();
    was?.notice.hide();
  };

  const raise = () => {
    const notice = notify(message, { kind: 'error', persist: true });
    const el = notice.containerEl;
    el.classList.add('ir-backup-failure-notice');
    // Obsidian's notice hides on any click on it (undocumented: its
    // constructor listens for `click` on `containerEl`). This one waits on
    // an answer, so only its buttons answer a click; theirs stop it below
    el.addEventListener(
      'click',
      (evt) => {
        if (!(evt.target as Element | null)?.closest('button')) {
          evt.stopImmediatePropagation();
        }
      },
      { capture: true }
    );
    const row = el.createDiv('notice-button-container');
    const button = (text: string, cls: string, onClick: () => void) => {
      const el = row.createEl('button', { text, cls });
      el.addEventListener('click', (evt) => {
        evt.stopPropagation();
        onClick();
      });
      return el;
    };
    const buttons = [
      button('Retry', 'ir-backup-retry', () => choose('retry')),
      button('Proceed anyway', 'mod-warning', () => confirmProceed()),
    ];
    // Gone with nothing answered would leave startup waiting with nothing to
    // answer: it comes back
    const comeBack = () => {
      if (shown?.notice !== notice) return;
      shown.release();
      shown = null;
      raise();
    };
    // A swipe still dismisses it on a phone (undocumented: Obsidian detaches
    // the element itself)
    const parent = el.parentElement;
    const observer = parent
      ? new MutationObserver(() => {
          if (!el.isConnected) comeBack();
        })
      : null;
    observer?.observe(parent!, { childList: true });
    // Obsidian puts a notice on `activeWindow` (undocumented: `Notice`'s
    // constructor reads it), which is the settings window while that is open
    // (1.13+), as when the plugin is enabled or updated from there. Closing
    // that window takes the notice with it, unseen by the observer. Deferred
    // on this window's clock, past Obsidian's own `pagehide` handler, which
    // hands `activeWindow` back to the main window
    const host = el.ownerDocument.defaultView;
    const onHostGone = () => window.setTimeout(comeBack);
    const away = host !== null && host !== window;
    if (away) host.addEventListener('pagehide', onHostGone);
    const release = () => {
      observer?.disconnect();
      if (away) host.removeEventListener('pagehide', onHostGone);
    };
    shown = { notice, buttons, release };
  };

  const confirmProceed = () => {
    if (modal || !answer) return;
    modal = new ConfirmModal(
      app,
      {
        title: 'Migrate without a backup?',
        paragraphs: [
          'The database will be migrated without a backup of it as it is now.',
          'If saving the migrated database then fails, or the file ends up ' +
            'damaged, the only copy of it from before the migration is the ' +
            'file on disk as it is now, and for a copy restored in place of ' +
            "a missing file, there's none. Obsidian Sync's version history " +
            'for the file may hold an earlier copy.',
        ],
        confirmText: 'Migrate anyway',
        destructive: true,
      },
      (confirmed) => {
        modal = null;
        if (confirmed) choose('proceed');
      }
    );
    modal.open();
  };

  return {
    ask(error) {
      message = backupFailureMessage(error);
      return new Promise<Choice>((resolve) => {
        answer = resolve;
        if (!shown) {
          raise();
          return;
        }
        shown.notice.setMessage(message);
        for (const button of shown.buttons) button.disabled = false;
      });
    },
    close() {
      answer = null;
      takeDown();
      modal?.close();
    },
  };
}
