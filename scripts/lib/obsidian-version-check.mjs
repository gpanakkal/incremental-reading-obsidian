// @ts-check
// Tells the developer when the Obsidian copy in `.obsidian-unpacked`, which
// the e2e suite runs against, is behind the latest desktop release. CI runs the
// latest release, so a stale local copy lets tests pass here and fail there.
// Advisory only: every failure (offline, bad manifest, no unpacked copy) ends
// in silence rather than an error, so it can never stop a run.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** How long a fetched latest version is trusted before it is looked up again. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Repo-relative path of the cached manifest answer. */
export const CACHE_PATH = '.user-data/obsidian-latest.json';
/** Repo-relative path of the unpacked app's own package.json, which names its version. */
export const UNPACKED_PACKAGE_PATH = '.obsidian-unpacked/package.json';
export const SETUP_COMMAND = 'pnpm run obsidian:setup';
/** The manifest the setup scripts' CI mode resolves `latestVersion` from. */
export const MANIFEST_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/desktop-releases.json';
const FETCH_TIMEOUT_MS = 5000;

/**
 * @typedef {object} CheckDeps
 * @property {string} root Repo root the relative paths resolve against.
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {() => number} [now]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {(file: string) => Promise<string>} [readFile]
 * @property {(file: string, data: string) => Promise<void>} [writeFile]
 */

/** @param {string} file @param {string} data */
async function writeCreatingDir(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** @param {CheckDeps} deps */
function withDefaults(deps) {
  return {
    root: deps.root,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    now: deps.now ?? Date.now,
    fetch: deps.fetch ?? globalThis.fetch,
    readFile:
      deps.readFile ?? ((/** @type {string} */ file) => readFile(file, 'utf8')),
    writeFile: deps.writeFile ?? writeCreatingDir,
  };
}

const NUMERIC_ID = /^(0|[1-9]\d*)$/;
const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @param {string} text */
function parseVersion(text) {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return {
    release: [match[1], match[2], match[3]].map(Number),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * Semver precedence of two pre-release identifier lists; an empty list is a
 * release, which outranks any pre-release of the same version.
 * @param {string[]} a @param {string[]} b
 */
function comparePreRelease(a, b) {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNumeric = NUMERIC_ID.test(x);
    const yNumeric = NUMERIC_ID.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    // Numeric identifiers rank below alphanumeric ones
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Semver comparison: negative when `a` is older than `b`, positive when newer,
 * 0 when equal (build metadata ignored). `undefined` when either is malformed.
 * @param {string} a @param {string} b
 * @returns {number | undefined}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) {
    const diff = left.release[i] - right.release[i];
    if (diff !== 0) return diff;
  }
  return comparePreRelease(left.pre, right.pre);
}

/**
 * @param {string} local @param {string} latest @param {NodeJS.Platform} platform
 */
function formatNotice(local, latest, platform) {
  // Local setup on Windows and macOS copies the installed app's own asar, which
  // in-app updates never touch (they download a newer one into the user-data
  // folder), so refreshing achieves nothing until the install itself is current.
  const install =
    platform === 'win32' || platform === 'darwin'
      ? `, after installing Obsidian ${latest} from https://obsidian.md/download (the setup copies the installed app, which in-app updates leave at its installer version)`
      : '';
  return `Warning: the e2e tests run on Obsidian ${local} (.obsidian-unpacked), but CI runs the latest release, ${latest}; run \`${SETUP_COMMAND}\` to refresh the local copy${install}.`;
}

/** @param {ReturnType<typeof withDefaults>} deps */
function disabled({ env }) {
  return env.OBSIDIAN_VERSION_CHECK === '0' || !!env.CI;
}

/** @param {string} text */
function parseJson(text) {
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * A field of parsed JSON, if it holds a well-formed version.
 * @param {unknown} value @param {string} key
 */
function versionField(value, key) {
  const field = /** @type {Record<string, unknown> | null | undefined} */ (
    value
  )?.[key];
  return typeof field === 'string' && parseVersion(field) ? field : undefined;
}

/** @param {ReturnType<typeof withDefaults>} deps */
async function readLocalVersion(deps) {
  try {
    const text = await deps.readFile(
      path.join(deps.root, UNPACKED_PACKAGE_PATH)
    );
    return versionField(parseJson(text), 'version');
  } catch {
    return undefined;
  }
}

/**
 * The cached latest version, and whether it was fetched within the TTL.
 * @param {ReturnType<typeof withDefaults>} deps
 */
async function readCache(deps) {
  try {
    const cache = parseJson(
      await deps.readFile(path.join(deps.root, CACHE_PATH))
    );
    const latestVersion = versionField(cache, 'latestVersion');
    if (latestVersion === undefined) return undefined;
    const checkedAt =
      /** @type {{ checkedAt?: unknown } | null | undefined} */ (cache)
        ?.checkedAt;
    const age = typeof checkedAt === 'number' ? deps.now() - checkedAt : NaN;
    return { latestVersion, fresh: age >= 0 && age < CACHE_TTL_MS };
  } catch {
    return undefined;
  }
}

/** @param {ReturnType<typeof withDefaults>} deps */
async function fetchLatestVersion(deps) {
  // A plain timer rather than AbortSignal.timeout, so it is cleared the moment
  // the answer is in and the fake timers in tests can drive it
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await deps.fetch(MANIFEST_URL, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const latestVersion = versionField(
      parseJson(await response.text()),
      'latestVersion'
    );
    if (latestVersion === undefined) return undefined;
    const cache = { latestVersion, checkedAt: deps.now() };
    await deps
      .writeFile(path.join(deps.root, CACHE_PATH), JSON.stringify(cache))
      .catch(() => undefined);
    return latestVersion;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {ReturnType<typeof withDefaults>} deps
 * @param {string | undefined} local @param {string | undefined} latest
 */
function noticeIfBehind(deps, local, latest) {
  if (local === undefined || latest === undefined) return undefined;
  const order = compareVersions(local, latest);
  return order !== undefined && order < 0
    ? formatNotice(local, latest, deps.platform)
    : undefined;
}

/**
 * Looks up the latest desktop release (from the cache when fresh, otherwise
 * the manifest, falling back to a stale cache) and returns a one-line notice
 * when the unpacked copy is behind it. Never throws; `undefined` whenever
 * there is nothing (reliable) to say.
 * @param {CheckDeps} options
 * @returns {Promise<string | undefined>}
 */
export async function checkObsidianVersion(options) {
  const deps = withDefaults(options);
  if (disabled(deps)) return undefined;
  const local = await readLocalVersion(deps);
  if (local === undefined) return undefined;
  const cached = await readCache(deps);
  // Releases only move forward, so a stale answer that says "behind" is still
  // true; it beats silence when the manifest cannot be reached
  const latest = cached?.fresh
    ? cached.latestVersion
    : ((await fetchLatestVersion(deps)) ?? cached?.latestVersion);
  return noticeIfBehind(deps, local, latest);
}

/**
 * The same notice, answered from the cache alone (whatever its age, as the
 * pre-run check falls back to it too), for repeating it after a run that
 * {@link checkObsidianVersion} already looked up for. Never fetches.
 * @param {CheckDeps} options
 * @returns {Promise<string | undefined>}
 */
export async function cachedNotice(options) {
  const deps = withDefaults(options);
  if (disabled(deps)) return undefined;
  const local = await readLocalVersion(deps);
  return noticeIfBehind(deps, local, (await readCache(deps))?.latestVersion);
}
