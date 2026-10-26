import test, { expect, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// The plugin's stylesheet against the markup Obsidian's preview renderer builds
// for a card embed, in browser engines other than Electron's Chromium — the
// `engines-*` projects run this file. iOS renders Obsidian with WebKit, and
// WebKit measures the flattened embed differently: see the `min-height: 1px`
// rule in styles.css. Chromium measures it wide whether that rule is there or
// not, so no Electron test can see a regression of it.
//
// Only the plugin's stylesheet is loaded, not Obsidian's. Checked against a
// capture of the whole page from the emulated phone review, with Obsidian's app
// CSS included: same widths, before and after the fix.

/**
 * The skeleton Obsidian's preview renderer makes in its constructor, as the
 * live-preview embed widget holds it: the preview element and an empty sizer.
 * The pusher and the sections only go in during the renderer's first pass, so
 * before that pass the sizer is empty. Read from Obsidian 1.13's `app.js`.
 */
const EMBED = `
  <div class="internal-embed markdown-embed inline-embed is-loaded"
       tabindex="-1" src="Card" alt="ir-hide-title" contenteditable="false">
    <div class="embed-title markdown-embed-title">Card</div>
    <div class="markdown-embed-content">
      <div class="markdown-preview-view markdown-rendered">
        <div class="markdown-preview-sizer markdown-preview-section"></div>
      </div>
    </div>
    <div class="markdown-embed-content" style="display: none"></div>
  </div>`;

/**
 * Where an embed can sit in the review editor. A `![[…]]` alone on its line is
 * a block widget straight inside `.cm-content`; one with text before it on the
 * line is inline in a `.cm-line`.
 */
const HOSTS = {
  standalone: `<div class="cm-content">${EMBED}</div>`,
  'standalone, block widget': `<div class="cm-content">${EMBED.replace(
    'contenteditable="false"',
    'contenteditable="false" style="display: block"'
  )}</div>`,
  'after text on its line': `<div class="cm-content"><div class="cm-line">Text before ${EMBED}</div></div>`,
};

let css: string;

test.beforeAll(async () => {
  css = await fs.readFile(path.resolve('styles.css'), 'utf8');
});

async function mount(page: Page, host: string) {
  await page.setContent(`<!doctype html>
    <html><head><style>${css}</style>
    <style>
      /* What Obsidian's app CSS and CodeMirror give the hosts. */
      body { margin: 0; font: 16px/1.5 sans-serif; }
      .cm-content { position: relative; width: 360px; }
      .cm-line { position: relative; }
    </style></head>
    <body class="markdown-source-view mod-cm6">${host}</body></html>`);
}

/**
 * The check Obsidian's renderer makes before each render pass, and bails on.
 * `previewEl` here is the renderer's, the `.markdown-preview-view`.
 */
const passesRenderGuard = (page: Page) =>
  page.evaluate(() => {
    const previewEl = document.querySelector<HTMLElement>(
      '.markdown-embed-content .markdown-preview-view'
    )!;
    return !!previewEl.offsetParent && previewEl.offsetWidth > 0;
  });

for (const [where, host] of Object.entries(HOSTS)) {
  test(`a card embed ${where} is wide enough for its first render pass`, async ({
    page,
  }) => {
    await mount(page, host);

    expect(await passesRenderGuard(page)).toBe(true);
  });
}

test('the floor gives way to the inline flow once the first pass has run', async ({
  page,
}) => {
  await mount(page, HOSTS.standalone);

  // What the first pass leaves behind: the min-height it writes on the sizer,
  // the pusher, and the note's text as a section.
  const layout = await page.evaluate(() => {
    const sizer = document.querySelector<HTMLElement>(
      '.markdown-preview-sizer'
    )!;
    sizer.style.minHeight = '44px';
    sizer.innerHTML =
      '<div class="markdown-preview-pusher" style="width: 1px; height: 0.1px"></div>' +
      '<div class="el-p"><p>The card text.</p></div>';
    const display = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).display;
    return {
      previewView: display('.markdown-preview-view'),
      sizer: display('.markdown-preview-sizer'),
      section: display('.el-p'),
    };
  });

  expect(layout).toEqual({
    previewView: 'inline',
    sizer: 'inline',
    section: 'inline',
  });
  expect(await passesRenderGuard(page)).toBe(true);
});

for (const where of ['standalone', 'after text on its line'] as const) {
  test(`a card embed of two paragraphs ${where} renders as a block once the first pass has run`, async ({
    page,
  }) => {
    await mount(page, HOSTS[where]);

    const layout = await page.evaluate(() => {
      const sizer = document.querySelector<HTMLElement>(
        '.markdown-preview-sizer'
      )!;
      sizer.style.minHeight = '88px';
      sizer.innerHTML =
        '<div class="markdown-preview-pusher" style="width: 1px; height: 0.1px"></div>' +
        '<div class="el-p"><p>The first paragraph.</p></div>' +
        '<div class="el-p"><p>The second paragraph.</p></div>';
      const display = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).display;
      const [first, second] = Array.from(document.querySelectorAll('p')).map(
        (p) => p.getBoundingClientRect()
      );
      return {
        previewView: display('.markdown-preview-view'),
        sizer: display('.markdown-preview-sizer'),
        section: display('.el-p'),
        rowsApart: second.top >= first.bottom,
      };
    });

    expect(layout).toEqual({
      previewView: 'block',
      sizer: 'block',
      section: 'block',
      rowsApart: true,
    });
    expect(await passesRenderGuard(page)).toBe(true);
  });
}

/**
 * The review tab on a phone, reading view: a card embed on its own line in an
 * article. Obsidian puts a transclusion in reading view inside the line's `<p>`.
 * `--view-top-spacing-markdown` is Obsidian's clearance under the floating
 * phone header (safe area + header + 16px): around 120px on an iPhone.
 */
const PHONE_REVIEW = `
  <div class="is-phone" style="--view-top-spacing-markdown: 123px">
    <div class="mod-root">
      <div class="workspace-leaf-content" data-type="incremental-reading-review">
        <div class="markdown-reading-view">
          <div class="markdown-preview-view markdown-rendered">
            <div class="markdown-preview-sizer markdown-preview-section">
              <div class="el-p"><p class="ir-transclusion-host"></p></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

test('a card embed of two paragraphs in the phone review tab hugs its text', async ({
  page,
}) => {
  await mount(page, PHONE_REVIEW);
  // Obsidian's app CSS drops the outer margins of a preview's first and last
  // paragraphs; the browser's default `p` margins would otherwise count here.
  await page.addStyleTag({
    content: `
      .markdown-rendered > .markdown-preview-section > .mod-ui + div:not(.mod-ui) > :first-child { margin-top: 0; }
      .markdown-rendered > .markdown-preview-section > div:last-child > :last-child { margin-bottom: 0; }`,
  });

  const slack = await page.evaluate((embed) => {
    // Through the fragment parser, so the embed's blocks stay inside the `<p>`
    // as Obsidian's DOM calls put them, where markup would close it.
    document.querySelector('.ir-transclusion-host')!.innerHTML = embed;
    const sizer = document.querySelector<HTMLElement>(
      '.internal-embed .markdown-preview-sizer'
    )!;

    // The renderer's first pass, from Obsidian 1.14's `app.js` (`onRender`,
    // `measureSection`, `updateVirtualDisplay`; undocumented): the sections go
    // in, each is measured as the distance to the next one's `offsetTop`, and
    // the sizer gets their sum as its `min-height`. A hidden section reads
    // `offsetTop` 0, so the header section measures as all the room above the
    // first paragraph.
    sizer.innerHTML =
      '<div class="markdown-preview-pusher" style="width: 1px; height: 0.1px"></div>' +
      '<div class="mod-header mod-ui"><div class="inline-title">Card</div></div>' +
      '<div class="el-p"><p>The first paragraph.</p></div>' +
      '<div class="el-p"><p>The second paragraph.</p></div>';
    const sections = Array.from(sizer.children).slice(1) as HTMLElement[];
    const total = sections
      .map((section) => {
        const next = section.nextElementSibling as HTMLElement | null;
        return next ? next.offsetTop - section.offsetTop : section.offsetHeight;
      })
      .reduce((sum, height) => sum + height, 0);
    sizer.style.minHeight = `${total - 1}px`;

    // The tinted box against the rows its text is on: what is left is its
    // own `padding-block`.
    const box = document
      .querySelector('.internal-embed')!
      .getBoundingClientRect();
    const [first, second] = Array.from(sizer.querySelectorAll('p')).map((p) =>
      p.getBoundingClientRect()
    );
    return box.height - (second.bottom - first.top);
  }, EMBED);

  expect(slack).toBeLessThan(10);
});
