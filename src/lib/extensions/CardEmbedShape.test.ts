// @vitest-environment jsdom

import {
  classifyCardEmbed,
  EMBED_SHAPE_CLASSES,
  HOST_SHAPE_CLASSES,
  markSectionShape,
  processSection,
  registerCardEmbedShapePostProcessor,
  SECTION_HAS_BLOCK_CLASS,
  SECTION_HAS_CODE_CLASS,
  SECTION_HOSTS_CODE_LAST_CLASS,
  watchCardEmbed,
} from '#/lib/extensions/CardEmbedShape';
import {
  TRANSCLUSION_HOST_CLASS,
  TRANSCLUSION_RULE_CLASS,
} from '#/lib/extensions/TransclusionHostPostProcessor';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

/**
 * The sections Obsidian's preview renderer can put in an embed's sizer, as it
 * builds them (read from Obsidian 1.13's `app.js`). `odd-code` is no section
 * Obsidian makes: a non-`<div>` holding a `<pre>`, to keep the arbitraries
 * broader than the renderer.
 */
const SECTION_KINDS = [
  'pusher',
  'header',
  'frontmatter',
  'footer',
  'paragraph',
  'code',
  'quote-of-two',
  'quote-of-one',
  'quote-split',
  'quote-list-then-one',
  'loose-list',
  'table',
  'heading',
  'odd-code',
] as const;
type SectionKind = (typeof SECTION_KINDS)[number];

const SECTION_HTML: Record<SectionKind, string> = {
  pusher: '<div class="markdown-preview-pusher"></div>',
  header:
    '<div class="mod-header mod-ui"><div class="inline-title">Card</div></div>',
  frontmatter:
    '<div class="el-pre mod-frontmatter mod-ui"><pre class="frontmatter"><code>a: 1</code></pre></div>',
  footer: '<div class="mod-footer mod-ui"></div>',
  paragraph: '<div class="el-p"><p>Text</p></div>',
  code: '<div class="el-pre"><pre><code>x</code></pre></div>',
  'quote-of-two':
    '<div class="el-blockquote"><blockquote><p>One</p><p>Two</p></blockquote></div>',
  'quote-of-one':
    '<div class="el-blockquote"><blockquote><p>One</p></blockquote></div>',
  'quote-split':
    '<div class="el-blockquote"><blockquote><p>One</p><ul><li>x</li></ul><p>Two</p></blockquote></div>',
  'quote-list-then-one':
    '<div class="el-blockquote"><blockquote><ul><li>x</li></ul><p>One</p></blockquote></div>',
  'loose-list':
    '<div class="el-ul"><ul><li><p>One</p><p>Two</p></li></ul></div>',
  table: '<div class="el-table"><table><tr><td>x</td></tr></table></div>',
  heading: '<div class="el-h2"><h2>Heading</h2></div>',
  'odd-code': '<section><pre><code>x</code></pre></section>',
};

const UI_KINDS = new Set<SectionKind>(['header', 'frontmatter', 'footer']);
const BEFORE_FIRST_CONTENT = new Set<SectionKind>(['pusher', ...UI_KINDS]);

/** What the stylesheet's old `:has()` gates answered for these sections. */
function expectedShape(kinds: readonly SectionKind[]) {
  const paragraphSections = kinds.filter((k) => k === 'paragraph').length;
  const paragraphs =
    paragraphSections >= 2 ||
    kinds.some(
      (k) => k === 'quote-of-two' || k === 'quote-split' || k === 'loose-list'
    );
  const content = kinds.filter((k) => !UI_KINDS.has(k));
  return {
    paragraphs,
    code: !paragraphs && kinds.includes('code'),
    codeFirst:
      !paragraphs &&
      kinds.some(
        (k, i) => k === 'code' && BEFORE_FIRST_CONTENT.has(kinds[i - 1])
      ),
    codeLast: !paragraphs && content[content.length - 1] === 'code',
  };
}

const sectionKinds = fc.array(fc.constantFrom(...SECTION_KINDS), {
  maxLength: 6,
});

/** A title-hidden embed as Obsidian builds it, holding `kinds` once loaded. */
function makeEmbed(
  kinds: readonly SectionKind[] = [],
  alt = 'ir-hide-title'
): { embed: HTMLElement; sizer: HTMLElement } {
  const embed = document.createElement('span');
  embed.className = 'internal-embed markdown-embed inline-embed is-loaded';
  embed.setAttribute('alt', alt);
  embed.innerHTML =
    '<div class="markdown-embed-content"><div class="markdown-preview-view markdown-rendered">' +
    '<div class="markdown-preview-sizer markdown-preview-section"></div></div></div>';
  const sizer = embed.querySelector<HTMLElement>('.markdown-preview-sizer')!;
  fill(sizer, kinds);
  return { embed, sizer };
}

function fill(sizer: HTMLElement, kinds: readonly SectionKind[]): void {
  sizer.innerHTML = kinds.map((kind) => SECTION_HTML[kind]).join('');
}

function shapeOf(embed: HTMLElement) {
  const has = (cls: string) => embed.classList.contains(cls);
  return {
    paragraphs: has(EMBED_SHAPE_CLASSES.paragraphs),
    code: has(EMBED_SHAPE_CLASSES.code),
    codeFirst: has(EMBED_SHAPE_CLASSES.codeFirst),
    codeLast: has(EMBED_SHAPE_CLASSES.codeLast),
  };
}

/**
 * A reading-view section holding one host `<p>` (or `tag`) with `embeds`, the
 * host marked as TransclusionHostPostProcessor marks it.
 */
function makeReadingSection(
  embeds: HTMLElement[],
  { tag = 'p', host = true, rule = true } = {}
): { section: HTMLElement; hostEl: HTMLElement } {
  const section = document.createElement('div');
  section.className = 'el-p';
  const hostEl = document.createElement(tag);
  if (host) hostEl.classList.add(TRANSCLUSION_HOST_CLASS);
  if (rule) hostEl.classList.add(TRANSCLUSION_RULE_CLASS);
  hostEl.append('Text ', ...embeds);
  section.appendChild(hostEl);
  return { section, hostEl };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('markSectionShape', () => {
  const tags = fc.array(
    fc.constantFrom('p', 'pre', 'ul', 'div', 'table', 'h1', 'blockquote'),
    { maxLength: 4 }
  );

  it('marks a section by the direct children it holds, dropping stale marks', () => {
    fc.assert(
      fc.property(tags, tags, (before, after) => {
        const section = document.createElement('div');
        for (const tags of [before, after]) {
          section.replaceChildren(
            ...tags.map((tag) => document.createElement(tag))
          );
          markSectionShape(section);
        }
        expect(section.classList.contains(SECTION_HAS_BLOCK_CLASS)).toBe(
          after.some((tag) => tag !== 'p')
        );
        expect(section.classList.contains(SECTION_HAS_CODE_CLASS)).toBe(
          after.includes('pre')
        );
      })
    );
  });

  it('looks only at direct children', () => {
    const section = document.createElement('div');
    section.innerHTML = '<p><code>x</code></p>';
    section.querySelector('p')!.appendChild(document.createElement('pre'));

    markSectionShape(section);

    expect(section.classList.contains(SECTION_HAS_BLOCK_CLASS)).toBe(false);
    expect(section.classList.contains(SECTION_HAS_CODE_CLASS)).toBe(false);
  });
});

describe('classifyCardEmbed', () => {
  it('stamps the shape of the sections the embed holds now', () => {
    fc.assert(
      fc.property(sectionKinds, sectionKinds, (before, after) => {
        const { embed, sizer } = makeEmbed(before);
        classifyCardEmbed(embed);
        fill(sizer, after);

        classifyCardEmbed(embed);

        expect(shapeOf(embed)).toEqual(expectedShape(after));
      })
    );
  });

  it('counts the sections of a card nested in the card', () => {
    const { embed: inner } = makeEmbed(['pusher', 'paragraph', 'paragraph']);
    const { embed: outer, sizer } = makeEmbed(['pusher', 'paragraph']);
    sizer.querySelector('p')!.appendChild(inner);

    classifyCardEmbed(outer);

    expect(shapeOf(outer).paragraphs).toBe(true);
  });

  it('marks a reading-view host by all the embeds directly in it', () => {
    fc.assert(
      fc.property(
        fc.array(sectionKinds, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        (contents, rule) => {
          const embeds = contents.map((kinds) => makeEmbed(kinds).embed);
          const { section, hostEl } = makeReadingSection(embeds, { rule });

          for (const embed of embeds) classifyCardEmbed(embed);

          const shapes = contents.map(expectedShape);
          const blocked = shapes.some((shape) => shape.paragraphs);
          const codeLast = !blocked && shapes.some((shape) => shape.codeLast);
          expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeFirst)).toBe(
            !blocked && shapes.some((shape) => shape.codeFirst)
          );
          expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeLast)).toBe(
            codeLast
          );
          expect(
            section.classList.contains(SECTION_HOSTS_CODE_LAST_CLASS)
          ).toBe(rule && codeLast);
        }
      )
    );
  });

  it('drops the host and section marks once the card no longer earns them', () => {
    const { embed, sizer } = makeEmbed(['pusher', 'code']);
    const { section, hostEl } = makeReadingSection([embed]);
    classifyCardEmbed(embed);
    fill(sizer, ['pusher', 'paragraph']);

    classifyCardEmbed(embed);

    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeFirst)).toBe(false);
    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeLast)).toBe(false);
    expect(section.classList.contains(SECTION_HOSTS_CODE_LAST_CLASS)).toBe(
      false
    );
  });

  it('ignores embeds in the host that are not title-hidden', () => {
    const { embed: card } = makeEmbed(['pusher', 'code']);
    const { embed: plain } = makeEmbed(
      ['pusher', 'paragraph', 'paragraph'],
      'x'
    );
    plain.classList.add(EMBED_SHAPE_CLASSES.paragraphs);
    const { hostEl } = makeReadingSection([card, plain]);

    classifyCardEmbed(card);

    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeFirst)).toBe(true);
  });

  it('leaves a parent that is not a marked host alone, as a Live Preview line', () => {
    const { embed } = makeEmbed(['pusher', 'code']);
    const { section, hostEl } = makeReadingSection([embed], {
      host: false,
    });
    const before = [hostEl.className, section.className];

    classifyCardEmbed(embed);

    expect([hostEl.className, section.className]).toEqual(before);
  });

  it('marks the section of a paragraph host only', () => {
    const { embed } = makeEmbed(['pusher', 'code']);
    const { section, hostEl } = makeReadingSection([embed], { tag: 'li' });

    classifyCardEmbed(embed);

    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeLast)).toBe(true);
    expect(section.classList.contains(SECTION_HOSTS_CODE_LAST_CLASS)).toBe(
      false
    );
  });

  it('marks the section when one of its blocks hosts such a card', () => {
    const { embed } = makeEmbed(['pusher', 'code']);
    const { section } = makeReadingSection([embed]);
    section.appendChild(document.createElement('p'));

    classifyCardEmbed(embed);

    expect(section.classList.contains(SECTION_HOSTS_CODE_LAST_CLASS)).toBe(
      true
    );
  });

  it('classifies a host without a parent', () => {
    const { embed } = makeEmbed(['pusher', 'code']);
    const hostEl = document.createElement('p');
    hostEl.classList.add(TRANSCLUSION_HOST_CLASS);
    hostEl.appendChild(embed);

    classifyCardEmbed(embed);

    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeLast)).toBe(true);
  });
});

describe('watchCardEmbed', () => {
  it('classifies the embed at once and again whenever its content changes', async () => {
    const { embed, sizer } = makeEmbed(['pusher', 'code']);

    watchCardEmbed(embed);
    expect(shapeOf(embed)).toEqual(expectedShape(['pusher', 'code']));

    // Deep inside the embed: a section's own children re-rendered
    sizer.lastElementChild!.replaceChildren(document.createElement('p'));
    await flushMicrotasks();
    expect(shapeOf(embed).code).toBe(false);

    fill(sizer, ['pusher', 'paragraph', 'paragraph']);
    await flushMicrotasks();
    expect(shapeOf(embed).paragraphs).toBe(true);
  });

  it('watches an embed once, however often it is handed over', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { embed } = makeEmbed();

    watchCardEmbed(embed);
    watchCardEmbed(embed);

    expect(observe).toHaveBeenCalledOnce();
  });
});

describe('processSection', () => {
  it('stamps the section it is handed', () => {
    const section = document.createElement('div');
    section.innerHTML = '<pre></pre>';

    processSection(section);

    expect(section.classList.contains(SECTION_HAS_CODE_CLASS)).toBe(true);
  });

  it('watches the card embeds a reading-view section holds', async () => {
    const { embed, sizer } = makeEmbed();
    const { section, hostEl } = makeReadingSection([embed]);

    processSection(section);
    // Obsidian loads the embed's content after post-processing the section
    fill(sizer, ['pusher', 'code']);
    await flushMicrotasks();

    expect(shapeOf(embed).codeFirst).toBe(true);
    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeFirst)).toBe(true);
  });

  it('marks the new host and section of a watched card moved into them', () => {
    const { embed } = makeEmbed(['pusher', 'code']);
    makeReadingSection([embed]);
    watchCardEmbed(embed);
    // Obsidian's embed recycler moves a loaded embed into the section that
    // replaces the one it was in, before that section is post-processed
    const { section, hostEl } = makeReadingSection([embed]);

    processSection(section);

    expect(hostEl.classList.contains(HOST_SHAPE_CLASSES.codeLast)).toBe(true);
    expect(section.classList.contains(SECTION_HOSTS_CODE_LAST_CLASS)).toBe(
      true
    );
  });

  it('watches the card embed a section lands in, and the cards around it', async () => {
    const { embed: outer, sizer: outerSizer } = makeEmbed(['pusher']);
    const { embed: inner, sizer } = makeEmbed(['pusher', 'paragraph']);
    const host = document.createElement('div');
    host.className = 'el-p';
    host.appendChild(document.createElement('p')).appendChild(inner);
    outerSizer.appendChild(host);
    // Post-processed while detached, then attached in the same task
    const section = document.createElement('div');
    section.className = 'el-p';
    section.innerHTML = '<p>Two</p>';

    processSection(section);
    sizer.appendChild(section);
    await flushMicrotasks();

    expect(shapeOf(inner).paragraphs).toBe(true);
    expect(shapeOf(outer).paragraphs).toBe(true);
  });

  it('stamps a card of several paragraphs before its sections are attached', () => {
    fc.assert(
      fc.property(sectionKinds, sectionKinds, (attached, incoming) => {
        const { embed, sizer } = makeEmbed(attached);
        embed.classList.add(...Object.values(EMBED_SHAPE_CLASSES));
        const sections = makeEmbed(incoming).sizer.children;
        const { embed: outer, sizer: outerSizer } = makeEmbed(['pusher']);
        outerSizer.appendChild(embed);

        // Obsidian post-processes each section detached, then attaches them
        // all and measures them in the same task: no microtask in between
        for (const section of Array.from(sections) as HTMLElement[]) {
          processSection(section, sizer);
        }

        const many =
          incoming.length > 0 &&
          expectedShape([...attached, ...incoming]).paragraphs;
        for (const card of [embed, outer]) {
          expect(shapeOf(card).paragraphs).toBe(
            many || card === embed // stamped above, left for the observer
          );
          if (many) {
            expect(shapeOf(card)).toEqual({
              paragraphs: true,
              code: false,
              codeFirst: false,
              codeLast: false,
            });
          }
        }
      })
    );
  });

  it('stamps a card holding code before its sections are attached', () => {
    fc.assert(
      fc.property(sectionKinds, sectionKinds, (attached, incoming) => {
        const { embed, sizer } = makeEmbed(attached);
        const { embed: outer, sizer: outerSizer } = makeEmbed(['pusher']);
        outerSizer.appendChild(embed);
        const sections = makeEmbed(incoming).sizer.children;

        // Chrome keeps the blank line box an inline padding opened on the
        // first layout after the padding is gone, so the class the padding
        // goes with has to be there before that layout
        for (const section of Array.from(sections) as HTMLElement[]) {
          processSection(section, sizer);
        }

        const code =
          incoming.length > 0 && expectedShape([...attached, ...incoming]).code;
        expect(shapeOf(embed).code).toBe(code);
        expect(shapeOf(outer).code).toBe(code);
      })
    );
  });

  it('leaves a card stamped as several paragraphs without the code mark', () => {
    const { embed, sizer } = makeEmbed(['pusher']);
    const { embed: outer, sizer: outerSizer } = makeEmbed(['pusher']);
    outerSizer.appendChild(embed);
    outer.classList.add(EMBED_SHAPE_CLASSES.paragraphs);

    processSection(
      makeEmbed(['code']).sizer.firstElementChild as HTMLElement,
      sizer
    );

    expect(shapeOf(embed).code).toBe(true);
    expect(shapeOf(outer).code).toBe(false);
  });

  it('counts only the sections of the pass in progress', async () => {
    const { embed, sizer } = makeEmbed(['pusher']);
    processSection(
      makeEmbed(['paragraph']).sizer.firstElementChild as HTMLElement,
      sizer
    );
    await flushMicrotasks();
    embed.classList.remove(EMBED_SHAPE_CLASSES.paragraphs);

    processSection(
      makeEmbed(['paragraph']).sizer.firstElementChild as HTMLElement,
      sizer
    );

    expect(shapeOf(embed).paragraphs).toBe(false);
  });

  it('stamps nothing early for a sizer outside any card embed', () => {
    const { embed, sizer } = makeEmbed(['paragraph'], 'plain');
    const sections = makeEmbed(['paragraph', 'paragraph']).sizer.children;

    for (const section of Array.from(sections) as HTMLElement[]) {
      processSection(section, sizer);
    }

    expect(embed.className).not.toContain('ir-embed');
  });

  it('watches nothing for a section outside any card embed', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const section = document.createElement('div');
    document.body.appendChild(section);

    processSection(section);
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });

  it('watches nothing for a section in an embed that is not title-hidden', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { sizer } = makeEmbed([], 'plain');
    const section = document.createElement('div');

    processSection(section);
    sizer.appendChild(section);
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });
});

describe('registerCardEmbedShapePostProcessor', () => {
  it('hands the post-processor the sizer the section renders into', () => {
    const plugin = { registerMarkdownPostProcessor: vi.fn() };
    registerCardEmbedShapePostProcessor(plugin as never);
    const processor = plugin.registerMarkdownPostProcessor.mock.calls[0][0] as (
      el: HTMLElement,
      ctx: unknown
    ) => void;
    const { embed, sizer } = makeEmbed(['pusher', 'paragraph']);
    const section = makeEmbed(['paragraph']).sizer
      .firstElementChild as HTMLElement;

    processor(section, { containerEl: sizer });

    expect(shapeOf(embed).paragraphs).toBe(true);
  });

  it('processes each section the registered post-processor receives', () => {
    const plugin = { registerMarkdownPostProcessor: vi.fn() };
    registerCardEmbedShapePostProcessor(plugin as never);
    const processor = plugin.registerMarkdownPostProcessor.mock.calls[0][0] as (
      el: HTMLElement
    ) => void;
    const section = document.createElement('div');
    section.innerHTML = '<ul></ul>';

    processor(section);

    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledOnce();
    expect(section.classList.contains(SECTION_HAS_BLOCK_CLASS)).toBe(true);
  });
});
