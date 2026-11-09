import fc from 'fast-check';
import { type App, Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asWebViewer,
  enabledWebViewer,
  linkWebViewer,
  readWebPage,
} from './web-viewer';

// #region HELPERS
/**
 * A view shaped as Obsidian's web viewer is: its type, and the method that
 * reads the page as Markdown answering `content` (a page, if not given;
 * `undefined` given is answered as is).
 */
function makeWebViewer(...args: [content?: unknown]) {
  const content = args.length > 0 ? args[0] : { title: 'Page', md: 'Text' };
  return {
    getViewType: () => 'webviewer',
    getReaderModeContent: vi.fn(() => Promise.resolve(content)),
  };
}

/** Anything a view's members could hold: functions among them. */
const memberArb = fc.oneof(
  fc.anything(),
  fc.constant(() => undefined),
  fc.func(fc.anything())
);

/**
 * An app whose internal plugins answer `answer` for an enabled plugin, or
 * throw it when `throws`.
 */
function makeApp(answer: unknown, throws = false) {
  const getEnabledPluginById = vi.fn((_id: string) => {
    if (throws) throw answer;
    return answer;
  });
  return {
    app: { internalPlugins: { getEnabledPluginById } } as unknown as App,
    getEnabledPluginById,
  };
}
// #endregion

describe('asWebViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes a view of the web viewer's type that reads pages as itself", () => {
    const view = makeWebViewer();

    expect(asWebViewer(view)).toBe(view);
  });

  it('property: takes nothing else, whatever its members hold', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record(
            {
              getViewType: fc.oneof(
                memberArb,
                fc.string().map((type) => () => type),
                fc.constant(() => 'webviewer')
              ),
              getReaderModeContent: memberArb,
            },
            { requiredKeys: [] }
          )
        ),
        (view) => {
          const isWebViewer =
            typeof view === 'object' &&
            view !== null &&
            'getViewType' in view &&
            typeof view.getViewType === 'function' &&
            (view.getViewType as () => unknown)() === 'webviewer' &&
            'getReaderModeContent' in view &&
            typeof view.getReaderModeContent === 'function';

          expect(asWebViewer(view)).toBe(isWebViewer ? view : null);
        }
      )
    );
  });

  it('takes no view whose type cannot be read', () => {
    const view = {
      ...makeWebViewer(),
      getViewType: () => {
        throw new Error('detached');
      },
    };

    expect(asWebViewer(view)).toBeNull();
  });
});

describe('readWebPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: reads the title and Markdown of the page, with its address when it has one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        fc.anything(),
        async (title, md, extra, url) => {
          const view = {
            ...makeWebViewer({ ...extra, title, md }),
            url,
          };

          expect(await readWebPage(view)).toStrictEqual({
            title,
            markdown: md,
            url: typeof url === 'string' ? url : null,
          });
        }
      )
    );
  });

  it('property: keeps the address the page had when asked, though the view moves on while reading it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (asked, after) => {
        const view: ReturnType<typeof makeWebViewer> & { url?: unknown } = {
          ...makeWebViewer(),
          url: asked,
        };
        view.getReaderModeContent.mockImplementation(() => {
          // Navigating away while Readability runs
          view.url = after;
          return Promise.resolve({ title: 'Page', md: 'Text' });
        });

        expect((await readWebPage(view))?.url).toBe(
          typeof asked === 'string' ? asked : null
        );
      })
    );
  });

  it('reads nothing when Obsidian reads nothing, having said why itself', async () => {
    expect(await readWebPage(makeWebViewer(undefined))).toBeNull();
  });

  it('property: throws on content of any other shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.anything(),
          fc.record(
            { title: fc.anything(), md: fc.anything() },
            { requiredKeys: [] }
          ),
          // Holding the members, but no plain object
          fc.constant(Object.assign(() => undefined, { title: 'x', md: 'y' }))
        ),
        async (content) => {
          fc.pre(
            content !== undefined &&
              !(
                typeof content === 'object' &&
                content !== null &&
                'title' in content &&
                typeof content.title === 'string' &&
                'md' in content &&
                typeof content.md === 'string'
              )
          );

          await expect(readWebPage(makeWebViewer(content))).rejects.toThrow(
            'Unexpected web viewer content'
          );
        }
      )
    );
  });
});

describe('enabledWebViewer', () => {
  it("is the web viewer plugin's instance while it is on and opens pages", () => {
    const instance = { openUrl: vi.fn() };
    const { app, getEnabledPluginById } = makeApp(instance);

    expect(enabledWebViewer(app)).toBe(instance);
    expect(getEnabledPluginById).toHaveBeenCalledExactlyOnceWith('webviewer');
  });

  it('property: is nothing for any other answer, an instance that cannot open pages among them', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({ openUrl: fc.anything() }, { requiredKeys: [] })
        ),
        (answer) => {
          fc.pre(
            !(
              typeof answer === 'object' &&
              answer !== null &&
              'openUrl' in answer &&
              typeof answer.openUrl === 'function'
            )
          );

          expect(enabledWebViewer(makeApp(answer).app)).toBeNull();
        }
      )
    );
  });

  it('property: is nothing when asking for it throws', () => {
    fc.assert(
      fc.property(fc.anything(), (thrown) => {
        expect(enabledWebViewer(makeApp(thrown, true).app)).toBeNull();
      })
    );
  });

  it('is nothing when the app has no internal plugins to ask', () => {
    expect(enabledWebViewer({} as App)).toBeNull();
  });
});

describe('linkWebViewer', () => {
  afterEach(() => {
    Platform.isMobileApp = false;
  });

  it('property: is the web viewer exactly when it is on and set to open external links, never on the mobile app', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.oneof(
          fc.constant(undefined),
          fc.anything(),
          fc.record({ openExternalURLs: fc.anything() }, { requiredKeys: [] }),
          fc.record({ openExternalURLs: fc.boolean() })
        ),
        (mobileApp, enabled, options) => {
          Platform.isMobileApp = mobileApp;
          const instance = { openUrl: vi.fn(), options };
          const { app } = makeApp(enabled ? instance : null);

          const opensLinks =
            typeof options === 'object' &&
            options !== null &&
            'openExternalURLs' in options &&
            options.openExternalURLs === true;
          expect(linkWebViewer(app)).toBe(
            !mobileApp && enabled && opensLinks ? instance : null
          );
        }
      )
    );
  });

  it('is the web viewer when it is on and set to open external links, on desktop', () => {
    const instance = { openUrl: vi.fn(), options: { openExternalURLs: true } };

    expect(linkWebViewer(makeApp(instance).app)).toBe(instance);
  });
});
