import { TRANSCLUSION_HIDE_TITLE_ALIAS } from '#/lib/constants';
import type IncrementalReadingPlugin from '#/main';
import {
  TRANSCLUSION_HOST_CLASS,
  TRANSCLUSION_RULE_CLASS,
} from './TransclusionHostPostProcessor';

/**
 * Stamps the shape of a title-hidden transclusion's content as classes, so
 * `styles.css` can lay it out without `:has()`.
 *
 * Which layout a card embed takes depends on what it holds: several paragraphs
 * make it a block, a code block opening or closing it lines it up with the
 * note's code around it, and so on. The stylesheet used to ask each of those
 * with `:has()` on the embed, its host and the note's sections, which had the
 * browser re-check all of them on every mutation below. The same questions
 * are cheap to answer here: once per section as it renders, and once per embed
 * whenever its content changes.
 *
 * Sections are answered from a markdown post-processor, which sees every
 * section Obsidian renders, the embed's own included, before it is attached
 * and measured. Whole-embed questions need the sections side by side, so they
 * are answered once a section has landed in its embed, and again on every
 * change to the embed's children after that.
 *
 * That is a microtask after Obsidian has measured the sections and decided
 * which of them to keep attached, and after the first layout, too late for
 * two answers:
 * - A card of several paragraphs is a block, the rest inline. An inline
 *   preview has no height, so the renderer keeps only the sections within its
 *   minimum render margin (500px) of the top, and a long card measured that
 *   way loses its tail.
 * - A card holding code drops the embed's inline padding. Laid out once with
 *   that padding, the empty line box ahead of the code block (the pusher's)
 *   gets a height, and Chrome keeps it once the padding is gone: a blank row
 *   above the code until something lays the embed out from scratch.
 * So those two are also given early, from the sizer the post-processor is
 * told the section renders into.
 */

const EMBED_SELECTOR = `.internal-embed[alt*='${TRANSCLUSION_HIDE_TITLE_ALIAS}']`;

/** On a rendered section with a direct child other than a `<p>`. */
export const SECTION_HAS_BLOCK_CLASS = 'ir-section-has-block';
/** On a rendered section with a direct `<pre>` child. */
export const SECTION_HAS_CODE_CLASS = 'ir-section-has-code';

/** Classes on the embed itself. */
export const EMBED_SHAPE_CLASSES = {
  /** The card has several paragraphs, so it renders as a block. */
  paragraphs: 'ir-embed-paragraphs',
  /** Not `paragraphs`, and some section holds a top-level code block. */
  code: 'ir-embed-code',
  /** Not `paragraphs`, and the first content section is a code block. */
  codeFirst: 'ir-embed-code-first',
  /** Not `paragraphs`, and the last content section is a code block. */
  codeLast: 'ir-embed-code-last',
} as const;

/** Classes on a reading-view host block, for the embeds directly in it. */
export const HOST_SHAPE_CLASSES = {
  /** One of its embeds is `codeFirst`, and none is `paragraphs`. */
  codeFirst: 'ir-embed-host-code-first',
  /** One of its embeds is `codeLast`, and none is `paragraphs`. */
  codeLast: 'ir-embed-host-code-last',
} as const;

/**
 * On the section of a reading-view paragraph that hosts, with the accent rule,
 * a card closing in code: the one host whose following section the stylesheet
 * has to look at.
 */
export const SECTION_HOSTS_CODE_LAST_CLASS = 'ir-embed-section-code-last';

const isUi = (el: Element) => el.classList.contains('mod-ui');
const holdsCode = (el: Element) =>
  Array.from(el.children).some((child) => child.tagName === 'PRE');
const isContentDiv = (el: Element | undefined) =>
  el?.tagName === 'DIV' && !isUi(el);
/** `p ~ p` somewhere inside `el`: a paragraph with another before it. */
const holdsParagraphRun = (el: Element) =>
  Array.from(el.getElementsByTagName('p')).some((p) => {
    for (let s = p.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === 'P') return true;
    }
    return false;
  });

/**
 * The questions the stylesheet used to ask of each `.markdown-preview-section`
 * in the embed, with the selectors it asked them with. Walked by hand: jsdom
 * has no `nth-last-child(… of S)`, and its `querySelector` misses some of
 * these matches in a nested embed.
 */
function sectionsShape(sectionsEl: Element) {
  return childrenShape(Array.from(sectionsEl.children));
}

function childrenShape(children: Element[]) {
  const content = children.filter((el) => !isUi(el));
  const last = content[content.length - 1];
  return {
    // `> .el-p ~ .el-p`, `> div:not(.mod-ui) p ~ p`
    paragraphs:
      children.filter((el) => el.classList.contains('el-p')).length > 1 ||
      children.some((el) => isContentDiv(el) && holdsParagraphRun(el)),
    // `> div:not(.mod-ui) > pre`
    code: children.some((el) => isContentDiv(el) && holdsCode(el)),
    // `> :is(.markdown-preview-pusher, .mod-ui) + div:not(.mod-ui) > pre`
    codeFirst: children.some((el, i) => {
      const before = children[i - 1];
      return (
        isContentDiv(el) &&
        holdsCode(el) &&
        before !== undefined &&
        (isUi(before) || before.classList.contains('markdown-preview-pusher'))
      );
    }),
    // `> div:not(.mod-ui):nth-last-child(1 of :not(.mod-ui)) > pre`
    codeLast: isContentDiv(last) && holdsCode(last),
  };
}

/** Stamp what a rendered section directly holds. */
export function markSectionShape(section: HTMLElement): void {
  const children = Array.from(section.children);
  section.classList.toggle(
    SECTION_HAS_BLOCK_CLASS,
    children.some((child) => child.tagName !== 'P')
  );
  section.classList.toggle(SECTION_HAS_CODE_CLASS, holdsCode(section));
}

/**
 * Stamp `embed`'s shape on it and, in reading view, on its host block and the
 * host's section.
 *
 * The host is only touched when it carries {@link TRANSCLUSION_HOST_CLASS},
 * which only reading view's post-processor sets. In Live Preview the parent is
 * a `.cm-line` or `.cm-content`, which CodeMirror owns.
 */
export function classifyCardEmbed(embed: HTMLElement): void {
  // Every sizer in the embed, a nested card's too, as the descendant
  // selectors did
  const shapes = Array.from(
    embed.getElementsByClassName('markdown-preview-section'),
    sectionsShape
  );
  const any = (key: keyof ReturnType<typeof sectionsShape>) =>
    shapes.some((shape) => shape[key]);
  const paragraphs = any('paragraphs');
  const shape = {
    paragraphs,
    code: !paragraphs && any('code'),
    codeFirst: !paragraphs && any('codeFirst'),
    codeLast: !paragraphs && any('codeLast'),
  };
  for (const key of Object.keys(EMBED_SHAPE_CLASSES) as Array<
    keyof typeof EMBED_SHAPE_CLASSES
  >) {
    embed.classList.toggle(EMBED_SHAPE_CLASSES[key], shape[key]);
  }

  const host = embed.parentElement;
  if (host?.classList.contains(TRANSCLUSION_HOST_CLASS)) classifyHost(host);
}

function classifyHost(host: HTMLElement): void {
  const embeds = Array.from(host.children).filter((child) =>
    child.matches(EMBED_SELECTOR)
  );
  const any = (cls: string) =>
    embeds.some((embed) => embed.classList.contains(cls));
  const blocked = any(EMBED_SHAPE_CLASSES.paragraphs);
  host.classList.toggle(
    HOST_SHAPE_CLASSES.codeFirst,
    !blocked && any(EMBED_SHAPE_CLASSES.codeFirst)
  );
  host.classList.toggle(
    HOST_SHAPE_CLASSES.codeLast,
    !blocked && any(EMBED_SHAPE_CLASSES.codeLast)
  );

  const section = host.parentElement;
  if (host.tagName !== 'P' || !section) return;
  section.classList.toggle(
    SECTION_HOSTS_CODE_LAST_CLASS,
    Array.from(section.children).some(
      (child) =>
        child.classList.contains(TRANSCLUSION_RULE_CLASS) &&
        child.classList.contains(HOST_SHAPE_CLASSES.codeLast)
    )
  );
}

/**
 * The sections post-processed into each sizer in the render pass under way,
 * which Obsidian attaches only once the pass has rendered them all.
 */
const pendingSections = new WeakMap<Element, Element[]>();

/**
 * Stamp the cards `sizer` is in as cards of several paragraphs, or as cards
 * holding code, if they are once `section` joins it, before Obsidian attaches
 * and lays out the pass. Only ever adds a mark: what the pass replaces is
 * still in the sizer, and the observer gives the exact answer a microtask
 * later, before any paint.
 */
function markShapeEarly(section: Element, sizer: Element): void {
  let embed: HTMLElement | null | undefined =
    sizer.closest<HTMLElement>(EMBED_SELECTOR);
  if (!embed) return;
  let pending = pendingSections.get(sizer);
  if (!pending) {
    pending = [];
    pendingSections.set(sizer, pending);
    queueMicrotask(() => pendingSections.delete(sizer));
  }
  pending.push(section);
  const shape = childrenShape([...Array.from(sizer.children), ...pending]);
  // A nested card's shape is every card around it's too, as the descendant
  // selectors had it
  for (
    ;
    embed;
    embed = embed.parentElement?.closest<HTMLElement>(EMBED_SELECTOR)
  ) {
    if (shape.paragraphs) {
      embed.classList.add(EMBED_SHAPE_CLASSES.paragraphs);
      embed.classList.remove(
        EMBED_SHAPE_CLASSES.code,
        EMBED_SHAPE_CLASSES.codeFirst,
        EMBED_SHAPE_CLASSES.codeLast
      );
    } else if (
      shape.code &&
      !embed.classList.contains(EMBED_SHAPE_CLASSES.paragraphs)
    ) {
      embed.classList.add(EMBED_SHAPE_CLASSES.code);
    }
  }
}

const watched = new WeakSet<HTMLElement>();

/**
 * Classify `embed` now and whenever its children change: Obsidian fills it in
 * after creating it, and renders it again when the transcluded note changes.
 * Calling it again for the same embed does nothing.
 *
 * The observer needs no disconnecting: it is held by the embed it observes,
 * so it goes when the embed does.
 */
export function watchCardEmbed(embed: HTMLElement): void {
  if (watched.has(embed)) return;
  watched.add(embed);
  // `childList` only: the classes written are attribute changes, so they never
  // feed back into another classification.
  new MutationObserver(() => {
    classifyCardEmbed(embed);
  }).observe(embed, { childList: true, subtree: true });
  classifyCardEmbed(embed);
}

/**
 * Stamp `section` and watch every card embed it is in or holds. `sizer` is
 * the renderer's section container the section is about to join, if known.
 *
 * The embeds a section holds (reading view's own transclusions) are watched at
 * once. The embeds it is in are only found once it is attached: Obsidian
 * post-processes a section while it is still detached, then attaches it in
 * the same task, so a microtask later it is in place.
 */
export function processSection(
  section: HTMLElement,
  sizer?: Element | null
): void {
  markSectionShape(section);
  if (sizer) markShapeEarly(section, sizer);
  for (const embed of Array.from(
    section.querySelectorAll<HTMLElement>(EMBED_SELECTOR)
  )) {
    // One already watched was moved here from the section this one replaces
    // (the renderer recycles loaded embeds): same content, so no mutation to
    // observe, but a new host and section to mark.
    if (watched.has(embed)) classifyCardEmbed(embed);
    else watchCardEmbed(embed);
  }
  queueMicrotask(() => {
    // Nested cards change their outer card's shape too
    let embed = section.parentElement?.closest<HTMLElement>(EMBED_SELECTOR);
    while (embed) {
      watchCardEmbed(embed);
      embed = embed.parentElement?.closest<HTMLElement>(EMBED_SELECTOR);
    }
  });
}

/**
 * Registers the post-processor that stamps sections and watches card embeds.
 * Registered after TransclusionHostPostProcessor's, so a reading-view host is
 * marked by the time its embeds are first classified.
 */
export function registerCardEmbedShapePostProcessor(
  plugin: IncrementalReadingPlugin
): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    // Undocumented: Obsidian's context also carries `containerEl`, the
    // renderer's sizer (read from 1.13's `app.js`). Without it the early mark
    // is skipped and the observer still classifies the card.
    const containerEl = (ctx as { containerEl?: unknown } | undefined)
      ?.containerEl;
    processSection(
      el,
      containerEl instanceof Element ? containerEl : undefined
    );
  });
}
