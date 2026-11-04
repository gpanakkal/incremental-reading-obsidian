// Where review keeps the editors it takes down, for a native undo of the typing
// done in them.
//
// WebKit, which is iOS's engine, sends its native undo of typing (shake to
// undo) to the editable element the typing went into, not to what has focus,
// and only while that element is still in the document. For one taken out it
// does nothing at all, sends no event, and offers a redo of it all the same
// (`EditCommandComposition::unapply` returns early when
// `areRootEditabledElementsConnected` is false; WebKit since 2021, iOS 15). A
// note tab keeps its editor's element for good; review builds an editor per
// item, and loses its own tab whenever a note that isn't an item opens in its
// place. So the plugin keeps those elements in the document, hidden, out of
// any tab, and hands their undo to whichever review tab shows the note again.
// Chromium drops the undo of typing in an element once it leaves the document,
// so there is nothing to keep it for anywhere else.

import { Platform, type TAbstractFile, type TFile } from 'obsidian';

/**
 * How many taken-down editors the plugin keeps. As many notes as Obsidian
 * keeps undo history for (20): an undo reaching an editor for a note past
 * those finds no history to take back anyway.
 */
export const RETIRED_EDITOR_LIMIT = 20;

/** Answers a native undo or redo of typing done in a note's editor. */
export interface RetiredEditorAnswerer {
  /**
   * Undo or redo, for `evt`, in an editor showing `file`, preventing its
   * default when it does.
   * @returns whether it did
   */
  answerRetiredHistoryInput(evt: InputEvent, file: TFile): boolean;
}

/** One kept editor's note, and its listener, to take off on letting go. */
interface Kept {
  file: TFile;
  listener: (evt: InputEvent) => void;
}

export class RetiredEditorPark {
  /** Whether editors are kept at all: only WebKit needs it. */
  enabled: boolean;
  readonly #answerers = new Set<RetiredEditorAnswerer>();
  /** Oldest first. */
  readonly #kept = new Map<HTMLElement, Kept>();
  /** The hidden element holding the kept editors, per window's document. */
  readonly #hosts = new Map<Document, HTMLElement>();

  constructor(enabled: boolean = Platform.isIosApp) {
    this.enabled = enabled;
  }

  /**
   * Have `answerer` asked about a native undo or redo sent to a kept editor,
   * after those listening already.
   * @returns what stops it being asked
   */
  listen(answerer: RetiredEditorAnswerer): () => void {
    this.#answerers.add(answerer);
    return () => {
      this.#answerers.delete(answerer);
    };
  }

  /**
   * Keep `el`, the content element of an editor review took down from `file`,
   * in its document, hidden, for the {@link RETIRED_EDITOR_LIMIT} editors
   * taken down last; a native undo or redo sent to it goes to the first
   * answerer that takes it. Nothing where {@link enabled} is off.
   *
   * WebKit's undo steps hold the element for as long as they last; its
   * listener comes off once the plugin lets go of it, so as not to hold the
   * answerers as well.
   */
  keep(el: HTMLElement, file: TFile): void {
    if (!this.enabled) return;
    const listener = (evt: InputEvent) => {
      for (const answerer of this.#answerers) {
        if (answerer.answerRetiredHistoryInput(evt, file)) return;
      }
    };
    el.addEventListener('beforeinput', listener);
    // Pages and media embedded in the note would load again once back in the
    // document, out of sight: a video's sound, an embedded page's memory. They
    // take no part in the typing WebKit would undo.
    for (const embed of Array.from(
      el.querySelectorAll('iframe, video, audio, embed, object')
    )) {
      embed.remove();
    }
    this.#hostIn(el.ownerDocument).appendChild(el);
    this.#kept.set(el, { file, listener });
    for (const [kept, { listener: keptListener }] of this.#kept) {
      if (this.#kept.size <= RETIRED_EDITOR_LIMIT) break;
      this.#letGo(kept, keptListener);
    }
  }

  /** Let go of the editors kept for `file`, a note now gone. */
  dropFile(file: TAbstractFile): void {
    for (const [el, kept] of this.#kept) {
      if (kept.file === file) this.#letGo(el, kept.listener);
    }
  }

  /** Let go of every kept editor, and of what hides them. */
  drop(): void {
    for (const [el, { listener }] of this.#kept) this.#letGo(el, listener);
    for (const host of this.#hosts.values()) host.remove();
    this.#hosts.clear();
  }

  #hostIn(doc: Document): HTMLElement {
    let host = this.#hosts.get(doc);
    if (!host) {
      host = doc.createElement('div');
      host.className = 'ir-retired-editors';
      host.hidden = true;
      doc.body.appendChild(host);
      this.#hosts.set(doc, host);
    }
    return host;
  }

  /** Out of the document, its undo with it, and unanswered from here on. */
  #letGo(el: HTMLElement, listener: Kept['listener']): void {
    el.removeEventListener('beforeinput', listener);
    el.remove();
    this.#kept.delete(el);
  }
}
