import fc from 'fast-check';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_PATH,
  CACHE_TTL_MS,
  cachedNotice,
  checkObsidianVersion,
  compareVersions,
  SETUP_COMMAND,
  UNPACKED_PACKAGE_PATH,
} from './obsidian-version-check.mjs';

// #region HELPERS
const ROOT = path.join('repo-root');
const NOW = Date.UTC(2026, 10, 4, 12);
const unpackedPath = path.join(ROOT, UNPACKED_PACKAGE_PATH);
const cachePath = path.join(ROOT, CACHE_PATH);

/** In-memory stand-in for the two files the check touches. */
function makeFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: vi.fn(async (file: string) => {
      const text = files.get(file);
      if (text === undefined) throw new Error(`ENOENT: ${file}`);
      return text;
    }),
    writeFile: vi.fn(async (file: string, data: string) => {
      files.set(file, data);
    }),
  };
}

function unpacked(version: string) {
  return { [unpackedPath]: JSON.stringify({ name: 'obsidian', version }) };
}

function cache(latestVersion: string, checkedAt: number) {
  return { [cachePath]: JSON.stringify({ latestVersion, checkedAt }) };
}

function manifestFetch(body: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body))
  );
}

type FetchMock = ReturnType<typeof manifestFetch>;

function makeDeps(
  overrides: {
    files?: Record<string, string>;
    fetch?: FetchMock;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {}
) {
  const fs = makeFiles(overrides.files ?? unpacked('1.14.5'));
  const fetch = overrides.fetch ?? manifestFetch({ latestVersion: '1.15.0' });
  return {
    fs,
    fetch,
    deps: {
      root: ROOT,
      env: overrides.env ?? {},
      platform: overrides.platform ?? 'linux',
      now: (): number => NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
      readFile: fs.readFile as (file: string) => Promise<string>,
      writeFile: fs.writeFile as (file: string, data: string) => Promise<void>,
    },
  };
}

const sign = (n: number | undefined) => (n === undefined ? n : Math.sign(n));

const triple = fc.tuple(fc.nat(12), fc.nat(12), fc.nat(12));
const preId = fc.oneof(
  fc.nat(20).map(String),
  fc.constantFrom('alpha', 'beta', 'rc', 'insider', 'x-1')
);
const preIds = fc.array(preId, { minLength: 1, maxLength: 3 });
const version = fc
  .tuple(triple, fc.option(preIds, { nil: undefined }))
  .map(([[a, b, c], pre]) => ({
    triple: [a, b, c] as const,
    text: `${a}.${b}.${c}${pre ? `-${pre.join('.')}` : ''}`,
  }));

function compareTriples(a: readonly number[], b: readonly number[]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
// #endregion

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('compareVersions', () => {
  it('orders differing release triples numerically, whatever the suffixes', () => {
    fc.assert(
      fc.property(version, version, (a, b) => {
        fc.pre(compareTriples(a.triple, b.triple) !== 0);
        expect(sign(compareVersions(a.text, b.text))).toBe(
          compareTriples(a.triple, b.triple)
        );
      })
    );
  });

  it('ranks a release above any pre-release of the same triple', () => {
    fc.assert(
      fc.property(triple, preIds, (t, pre) => {
        const release = t.join('.');
        const preRelease = `${release}-${pre.join('.')}`;
        expect(sign(compareVersions(preRelease, release))).toBe(-1);
        expect(sign(compareVersions(release, preRelease))).toBe(1);
      })
    );
  });

  it('is reflexive and antisymmetric', () => {
    fc.assert(
      fc.property(version, version, (a, b) => {
        expect(sign(compareVersions(a.text, a.text))).toBe(0);
        const forward = sign(compareVersions(a.text, b.text))!;
        const backward = sign(compareVersions(b.text, a.text))!;
        expect(forward + backward).toBe(0);
      })
    );
  });

  it('follows the precedence chain from the semver spec', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.9.0',
      '1.10.0',
      '2.0.0',
    ];
    chain.forEach((lower, i) =>
      chain.slice(i + 1).forEach((higher) => {
        expect(
          sign(compareVersions(lower, higher)),
          `${lower} < ${higher}`
        ).toBe(-1);
      })
    );
  });

  it('ranks numeric identifiers below alphanumeric ones, whatever the characters', () => {
    expect(sign(compareVersions('1.0.0-999', '1.0.0--'))).toBe(-1);
    expect(sign(compareVersions('1.0.0--', '1.0.0-999'))).toBe(1);
  });

  it('orders numeric pre-release identifiers by value, not by digits', () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), (a, b) => {
        expect(sign(compareVersions(`1.0.0-rc.${a}`, `1.0.0-rc.${b}`))).toBe(
          Math.sign(a - b)
        );
      })
    );
  });

  it('orders pre-releases of one release antisymmetrically and transitively', () => {
    const sameRelease = fc
      .array(preIds, { minLength: 3, maxLength: 3 })
      .map((ids) => ids.map((pre) => `1.2.3-${pre.join('.')}`));
    fc.assert(
      fc.property(sameRelease, ([a, b, c]) => {
        const ab = sign(compareVersions(a, b))!;
        expect(ab + sign(compareVersions(b, a))!).toBe(0);
        if (ab < 0 && sign(compareVersions(b, c))! < 0) {
          expect(sign(compareVersions(a, c))).toBe(-1);
        }
      })
    );
  });

  it('ignores build metadata, surrounding space and a leading v', () => {
    expect(sign(compareVersions(' v1.2.3+build.7\n', '1.2.3'))).toBe(0);
  });

  it.each([
    '',
    '1.2',
    '1.2.3.4',
    'latest',
    '1.2.x',
    '1.2.3-',
    '1.2.3-a..b',
    'x1.2.3',
  ])('gives no answer for the malformed version %j', (bad) => {
    expect(compareVersions(bad, '1.2.3')).toBeUndefined();
    expect(compareVersions('1.2.3', bad)).toBeUndefined();
  });
});

describe('checkObsidianVersion', () => {
  it('names both versions and the setup command when the unpacked copy is behind', async () => {
    const { deps } = makeDeps();
    const notice = await checkObsidianVersion(deps);
    expect(notice).toContain('1.14.5');
    expect(notice).toContain('1.15.0');
    expect(notice).toContain(SETUP_COMMAND);
  });

  it('warns exactly when the unpacked copy is behind the latest release', async () => {
    await fc.assert(
      fc.asyncProperty(version, version, async (local, latest) => {
        const { deps } = makeDeps({
          files: unpacked(local.text),
          fetch: manifestFetch({ latestVersion: latest.text }),
        });
        const notice = await checkObsidianVersion(deps);
        const behind = sign(compareVersions(local.text, latest.text)) === -1;
        expect(notice !== undefined).toBe(behind);
      })
    );
  });

  it.each(['1.15.0', '1.15.1', '1.16.0-beta.1', '2.0.0'])(
    'stays silent when the unpacked copy is %s and the latest is 1.15.0',
    async (local) => {
      const { deps } = makeDeps({ files: unpacked(local) });
      expect(await checkObsidianVersion(deps)).toBeUndefined();
    }
  );

  it('warns about a pre-release of the latest version', async () => {
    const { deps } = makeDeps({ files: unpacked('1.15.0-beta.2') });
    expect(await checkObsidianVersion(deps)).toContain('1.15.0-beta.2');
  });

  it.each<NodeJS.Platform>(['win32', 'darwin'])(
    'on %s, also asks for the installed app to be updated, since local setup copies it',
    async (platform) => {
      const desktop = await checkObsidianVersion(makeDeps({ platform }).deps);
      const linux = await checkObsidianVersion(
        makeDeps({ platform: 'linux' }).deps
      );
      expect(desktop).toMatch(/install/i);
      expect(linux).not.toMatch(/install/i);
      // The desktop notice is the Linux one with the install step added
      expect(desktop!.startsWith(linux!.replace(/\.$/, ''))).toBe(true);
    }
  );

  it.each([
    ['missing', {}],
    ['not JSON', { [unpackedPath]: '{' }],
    ['without a version', { [unpackedPath]: '{"name":"obsidian"}' }],
    ['null', { [unpackedPath]: 'null' }],
    ['carrying a malformed version', unpacked('1.15')],
  ])(
    'stays silent, without fetching, when the unpacked package is %s',
    async (_, files) => {
      const { deps, fetch } = makeDeps({ files });
      expect(await checkObsidianVersion(deps)).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'the request rejects',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    ],
    [
      'the response is an error',
      vi.fn(
        async () => new Response('{"latestVersion":"9.9.9"}', { status: 429 })
      ),
    ],
    ['the body is not JSON', vi.fn(async () => new Response('<html>'))],
    ['latestVersion is missing', manifestFetch({ versions: [] })],
    ['latestVersion is not a string', manifestFetch({ latestVersion: 1.15 })],
    ['latestVersion is malformed', manifestFetch({ latestVersion: 'soon' })],
    ['the body is null', manifestFetch(null)],
  ])('stays silent and caches nothing when %s', async (_, fetch) => {
    const { deps, fs } = makeDeps({ fetch: fetch });
    expect(await checkObsidianVersion(deps)).toBeUndefined();
    expect(fs.files.has(cachePath)).toBe(false);
  });

  it('fetches the desktop manifest with a timeout', async () => {
    const { deps, fetch } = makeDeps();
    await checkObsidianVersion(deps);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/obsidianmd\/obsidian-releases\/HEAD\/desktop-releases\.json$/
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives up on a manifest request still pending after 5 seconds', async () => {
    vi.useFakeTimers();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    const { deps } = makeDeps({ fetch: hang as unknown as FetchMock });
    let settled = false;
    const result = checkObsidianVersion(deps).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toBeUndefined();
  });

  it('leaves no timer behind to hold the process open once answered', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    expect(await checkObsidianVersion(deps)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still answers when the cache cannot be written', async () => {
    const { deps } = makeDeps();
    deps.writeFile = vi.fn(async () => Promise.reject(new Error('EACCES')));
    expect(await checkObsidianVersion(deps)).toContain('1.15.0');
  });

  it.each([
    ['OBSIDIAN_VERSION_CHECK=0', { OBSIDIAN_VERSION_CHECK: '0' }],
    ['CI', { CI: 'true' }],
  ])('does nothing under %s', async (_, env) => {
    const { deps, fetch, fs } = makeDeps({ env });
    expect(await checkObsidianVersion(deps)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('runs when OBSIDIAN_VERSION_CHECK is anything but 0 and CI is empty', async () => {
    const { deps } = makeDeps({ env: { OBSIDIAN_VERSION_CHECK: '1', CI: '' } });
    expect(await checkObsidianVersion(deps)).toContain('1.15.0');
  });

  describe('cache', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    /** Leaves `now` to the default clock, which the fake timers drive. */
    function timerDeps(files: Record<string, string>) {
      const made = makeDeps({ files: { ...unpacked('1.14.5'), ...files } });
      const { now: _, ...deps } = made.deps;
      return { ...made, deps };
    }

    it.each([0, CACHE_TTL_MS - 1])(
      'answers from a cache %ims old without fetching',
      async (age) => {
        const { deps, fetch } = timerDeps(cache('1.16.2', NOW));
        vi.advanceTimersByTime(age);
        expect(await checkObsidianVersion(deps)).toContain('1.16.2');
        expect(fetch).not.toHaveBeenCalled();
      }
    );

    it('refetches once the cache is stale, and rewrites it', async () => {
      const { deps, fetch, fs } = timerDeps(cache('1.16.2', NOW));
      vi.advanceTimersByTime(CACHE_TTL_MS);
      expect(await checkObsidianVersion(deps)).toContain('1.15.0');
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(fs.files.get(cachePath)!)).toEqual({
        latestVersion: '1.15.0',
        checkedAt: NOW + CACHE_TTL_MS,
      });
    });

    it('serves the fetched answer from the cache on the next run', async () => {
      const { deps, fetch } = timerDeps({});
      await checkObsidianVersion(deps);
      vi.advanceTimersByTime(CACHE_TTL_MS - 1);
      expect(await checkObsidianVersion(deps)).toContain('1.15.0');
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('falls back to a stale cache when the manifest cannot be fetched', async () => {
      const { deps, fs } = timerDeps(cache('1.16.2', NOW));
      deps.fetch = vi.fn(async () =>
        Promise.reject(new TypeError('fetch failed'))
      ) as unknown as typeof globalThis.fetch;
      vi.advanceTimersByTime(CACHE_TTL_MS * 10);
      expect(await checkObsidianVersion(deps)).toContain('1.16.2');
      // Still stale, so the next run tries the manifest again
      expect(
        (JSON.parse(fs.files.get(cachePath)!) as { checkedAt: number })
          .checkedAt
      ).toBe(NOW);
    });

    it.each([
      ['dated in the future', cache('1.16.2', NOW + 1)],
      ['not JSON', { [cachePath]: '{' }],
      ['null', { [cachePath]: 'null' }],
      ['holding a malformed version', cache('soon', NOW)],
      ['without a timestamp', { [cachePath]: '{"latestVersion":"1.16.2"}' }],
      [
        'timestamped with a string',
        {
          [cachePath]: JSON.stringify({
            latestVersion: '1.16.2',
            checkedAt: String(NOW),
          }),
        },
      ],
    ])('refetches when the cache is %s', async (_, files) => {
      const { deps, fetch } = timerDeps(files);
      expect(await checkObsidianVersion(deps)).toContain('1.15.0');
      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  it('creates and then rewrites a real cache file under the root by default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obsidian-version-check-'));
    try {
      await mkdir(path.join(root, '.obsidian-unpacked'));
      await writeFile(
        path.join(root, UNPACKED_PACKAGE_PATH),
        JSON.stringify({ version: '1.0.0' })
      );
      const fetch = manifestFetch({ latestVersion: '1.15.0' });
      const run = (now: number) =>
        checkObsidianVersion({
          root,
          env: {},
          now: () => now,
          fetch: fetch as unknown as typeof globalThis.fetch,
        });
      const readCache = async () =>
        JSON.parse(await readFile(path.join(root, CACHE_PATH), 'utf8')) as {
          checkedAt: number;
        };
      expect(await run(NOW)).toContain('1.0.0');
      expect(await readCache()).toEqual({
        latestVersion: '1.15.0',
        checkedAt: NOW,
      });
      // Second write lands in the .user-data folder the first one created
      await run(NOW + CACHE_TTL_MS);
      expect((await readCache()).checkedAt).toBe(NOW + CACHE_TTL_MS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cachedNotice', () => {
  it('repeats the pre-run notice from the cache, without fetching', async () => {
    const { deps, fetch } = makeDeps();
    const before = await checkObsidianVersion(deps);
    expect(before).toBeDefined();
    expect(await cachedNotice(deps)).toBe(before);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('repeats the stale answer the pre-run check fell back to when offline', async () => {
    const { deps } = makeDeps({
      files: { ...unpacked('1.14.5'), ...cache('1.16.2', NOW - CACHE_TTL_MS) },
      fetch: vi.fn(async () =>
        Promise.reject(new TypeError('fetch failed'))
      ) as unknown as FetchMock,
    });
    const before = await checkObsidianVersion(deps);
    expect(before).toContain('1.16.2');
    expect(await cachedNotice(deps)).toBe(before);
  });

  it.each([
    ['there is no cache', {}],
    ['the cache matches the unpacked copy', cache('1.14.5', NOW)],
  ])('stays silent when %s', async (_, files) => {
    const { deps, fetch } = makeDeps({
      files: { ...unpacked('1.14.5'), ...files },
    });
    expect(await cachedNotice(deps)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['OBSIDIAN_VERSION_CHECK=0', { OBSIDIAN_VERSION_CHECK: '0' }],
    ['CI', { CI: '1' }],
  ])('stays silent under %s', async (_, env) => {
    const { deps } = makeDeps({
      files: { ...unpacked('1.14.5'), ...cache('1.15.0', NOW) },
      env,
    });
    expect(await cachedNotice(deps)).toBeUndefined();
  });

  it('stays silent when the unpacked package is unreadable', async () => {
    const { deps } = makeDeps({ files: cache('1.15.0', NOW) });
    expect(await cachedNotice(deps)).toBeUndefined();
  });
});
