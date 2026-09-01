// @vitest-environment jsdom

import {
  markTransclusionHosts,
  registerTransclusionHostPostProcessor,
  TRANSCLUSION_HOST_CLASS,
  TRANSCLUSION_RULE_CLASS,
} from '#/lib/extensions/TransclusionHostPostProcessor';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

const HOST_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];

/** A `<span class="internal-embed">` as Obsidian builds it for `![[x|alias]]`. */
function makeEmbed(alt = 'ir-hide-title'): HTMLElement {
  const embed = document.createElement('span');
  embed.className = 'internal-embed';
  embed.setAttribute('alt', alt);
  return embed;
}

/**
 * Build the section root a post-processor receives, containing one host block
 * of `tag` whose children are produced from `children`.
 *
 * `'embed'` and `'own-line-embed'` stand for a title-hidden transclusion, the
 * latter preceded by the `<br>` that pushes it onto its own line.
 */
function makeSection(
  tag: string,
  children: ('embed' | 'own-line-embed' | 'text' | 'other-embed')[]
): { root: HTMLElement; host: HTMLElement } {
  const root = document.createElement('div');
  const host = document.createElement(tag);
  for (const child of children) {
    switch (child) {
      case 'own-line-embed':
        host.appendChild(document.createElement('br'));
        host.appendChild(makeEmbed());
        break;
      case 'embed':
        host.appendChild(makeEmbed());
        break;
      case 'other-embed':
        host.appendChild(makeEmbed('Some Note'));
        break;
      case 'text':
        host.appendChild(document.createTextNode('prose'));
        break;
    }
  }
  root.appendChild(host);
  return { root, host };
}

function makePlugin() {
  return { registerMarkdownPostProcessor: vi.fn() };
}

// #endregion

describe('markTransclusionHosts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(HOST_TAGS)('marks a <%s> holding an inline transclusion', (tag) => {
    const { root, host } = makeSection(tag, ['text', 'embed']);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
    expect(host.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(true);
  });

  it('withholds the rule class when a <br> starts the transclusion', () => {
    const { root, host } = makeSection('p', ['text', 'own-line-embed']);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
    expect(host.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(false);
  });

  it('withholds the rule class when any transclusion starts its own line', () => {
    // Reproduces `:not(:has(> br + .internal-embed))`, which suppressed the
    // host rule for the whole block rather than per transclusion.
    const { root, host } = makeSection('p', ['embed', 'own-line-embed']);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
    expect(host.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(false);
  });

  it('ignores transclusions without the hide-title alias', () => {
    const { root, host } = makeSection('p', ['other-embed']);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(false);
    expect(host.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(false);
  });

  it('ignores blocks that are not a supported host tag', () => {
    const { root, host } = makeSection('blockquote', ['embed']);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(false);
  });

  it('marks only the direct parent, not ancestors', () => {
    // A transclusion nested inside a <strong> has no host block of its own:
    // the accent rule would land on the wrong box.
    const root = document.createElement('div');
    const host = document.createElement('p');
    const strong = document.createElement('strong');
    strong.appendChild(makeEmbed());
    host.appendChild(strong);
    root.appendChild(host);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(false);
  });

  it('marks every qualifying host in a section independently', () => {
    const root = document.createElement('div');
    const inline = document.createElement('li');
    inline.appendChild(makeEmbed());
    const ownLine = document.createElement('li');
    ownLine.appendChild(document.createElement('br'));
    ownLine.appendChild(makeEmbed());
    root.append(inline, ownLine);

    markTransclusionHosts(root);

    expect(inline.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(true);
    expect(ownLine.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(false);
    expect(ownLine.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
  });

  it('leaves a section without transclusions untouched', () => {
    const { root, host } = makeSection('p', ['text']);

    markTransclusionHosts(root);

    expect(host.className).toBe('');
  });

  it('matches an alias embedded in a longer alt attribute', () => {
    // The selector uses a substring match because Obsidian can compose the alt
    // from the display text and the alias.
    const root = document.createElement('div');
    const host = document.createElement('p');
    host.appendChild(makeEmbed('Card abc123 > ir-hide-title'));
    root.appendChild(host);

    markTransclusionHosts(root);

    expect(host.classList.contains(TRANSCLUSION_RULE_CLASS)).toBe(true);
  });

  it('is idempotent across repeated post-processor passes', () => {
    const { root, host } = makeSection('p', ['embed']);

    markTransclusionHosts(root);
    const afterFirst = host.className;
    markTransclusionHosts(root);

    expect(host.className).toBe(afterFirst);
  });

  it('preserves classes Obsidian already put on the host', () => {
    const { root, host } = makeSection('li', ['embed']);
    host.className = 'task-list-item';

    markTransclusionHosts(root);

    expect(host.classList.contains('task-list-item')).toBe(true);
    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
  });

  it('gives the rule class only to hosts it gives the host class', () => {
    // The rule class is a strict refinement: styles.css relies on the host
    // class being present wherever the rule class is, since the accent bar
    // needs `position: relative` to resolve against.
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_TAGS),
        fc.array(
          fc.constantFrom(
            'embed' as const,
            'own-line-embed' as const,
            'text' as const,
            'other-embed' as const
          ),
          { maxLength: 6 }
        ),
        (tag, children) => {
          const { root, host } = makeSection(tag, children);

          markTransclusionHosts(root);

          if (host.classList.contains(TRANSCLUSION_RULE_CLASS)) {
            expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
          }
        }
      )
    );
  });

  it('marks a host iff it directly contains a hide-title transclusion', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_TAGS),
        fc.array(
          fc.constantFrom(
            'embed' as const,
            'own-line-embed' as const,
            'text' as const,
            'other-embed' as const
          ),
          { maxLength: 6 }
        ),
        (tag, children) => {
          const { root, host } = makeSection(tag, children);
          const hasTransclusion = children.some(
            (c) => c === 'embed' || c === 'own-line-embed'
          );

          markTransclusionHosts(root);

          expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(
            hasTransclusion
          );
        }
      )
    );
  });
});

describe('registerTransclusionHostPostProcessor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers exactly one post-processor', () => {
    const plugin = makePlugin();

    registerTransclusionHostPostProcessor(plugin as never);

    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledOnce();
  });

  it('marks hosts in the element the registered processor receives', () => {
    const plugin = makePlugin();
    registerTransclusionHostPostProcessor(plugin as never);
    const processor = plugin.registerMarkdownPostProcessor.mock
      .calls[0][0] as (el: HTMLElement) => void;
    const { root, host } = makeSection('p', ['embed']);

    processor(root);

    expect(host.classList.contains(TRANSCLUSION_HOST_CLASS)).toBe(true);
  });
});
