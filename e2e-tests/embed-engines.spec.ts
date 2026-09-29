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
