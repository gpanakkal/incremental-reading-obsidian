import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import type { Primitive } from '#/lib/utility-types';
import { readFileSync } from 'fs';
import type { App, TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { vi } from 'vitest';
import { makeLinkVault } from './link-vault';

const SCHEMA = readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8');

let sql: Promise<SqlJsStatic> | null = null;

/**
 * A repository over a real in-memory sql.js database, as the plugin runs it,
 * with only the write of its file stubbed. Writes can be refused as saving
 * paused refuses them, through {@link refuseWrites}.
 */
export class TestRepository extends SQLJSRepository {
  static async create(): Promise<TestRepository> {
    sql ??= initSqlJs();
    const SQL = await sql;
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    // As `initDb` turns them on, until the first `export` turns them off
    repo.db.exec('PRAGMA foreign_keys = ON');
    repo.registerUpdateHook();
    return repo;
  }

  /** Refuse writes, as a changed file on disk that won't load does. */
  refuseWrites(error = new Error('Saving is paused.')) {
    this.blockWrites(error);
  }

  /**
   * Make the write whose SQL `matches` throw, as a statement SQLite rejects
   * does, while every other write runs.
   */
  failWrite(matches: (query: string) => boolean) {
    const mutate: SQLJSRepository['mutate'] = (query, params) =>
      SQLJSRepository.prototype.mutate.call(this, query, params) as [][];
    return vi
      .spyOn(this as SQLJSRepository, 'mutate')
      .mockImplementation((query: string, params?: Primitive[]) => {
        if (matches(query)) throw new Error(`Write failed: ${query}`);
        return mutate(query, params);
      });
  }

  /** The rows of `table`, as plain objects. */
  rows(table: string): Record<string, unknown>[] {
    return this.query(`SELECT * FROM ${table}`) as unknown as Record<
      string,
      unknown
    >[];
  }

  protected override async save() {}
}

/** What a vault operation of an {@link makeItemVault} can be made to fail at. */
export type VaultOp = 'create' | 'append' | 'frontmatter' | 'copy' | 'trash';

/**
 * A {@link makeLinkVault} that files can be made in, copied and trashed, as
 * an item is made. Notes created start empty; `append` keeps their bodies.
 * Links are written as `[[path<subpath>|alias]]`. Any operation can be made to
 * fail on a path with {@link fail}, as a write the disk refuses.
 */
export function makeItemVault(
  notes: Record<string, Record<string, unknown> | null> = {}
) {
  const base = makeLinkVault(notes);
  const { app, files } = base;
  const folders = new Set<string>();
  const bodies = new Map<string, string>();
  const trashed: string[] = [];
  const faults: ((op: VaultOp, path: string) => boolean)[] = [];
  const check = (op: VaultOp, path: string) => {
    if (faults.some((fault) => fault(op, path))) {
      throw new Error(`${op} failed at ${path}`);
    }
  };

  const frontmatterEdit = base.processFrontMatter.getMockImplementation()!;
  base.processFrontMatter.mockImplementation(async (file, edit) => {
    check('frontmatter', file.path);
    if (!files.has(file.path)) throw new Error(`No file at ${file.path}`);
    return frontmatterEdit(file, edit);
  });

  const vault = Object.assign(app.vault, {
    getAbstractFileByPath: (path: string) =>
      files.get(path) ?? (folders.has(path) ? { path } : null),
    getAbstractFileByPathInsensitive: (path: string) =>
      [...files.values()].find(
        (file) => file.path.toLowerCase() === path.toLowerCase()
      ) ?? null,
    getFolderByPath: (path: string) => (folders.has(path) ? { path } : null),
    createFolder: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    create: vi.fn(async (path: string, data: string) => {
      check('create', path);
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      bodies.set(path, data);
      return base.add(path);
    }),
    append: vi.fn(async (file: TFile, data: string) => {
      check('append', file.path);
      bodies.set(file.path, (bodies.get(file.path) ?? '') + data);
    }),
    copy: vi.fn(async (file: TFile, path: string) => {
      check('copy', path);
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      return base.add(path);
    }),
    // A PDF reads as one by its signature; anything else as its body
    getResourcePath: () => {
      throw new Error('No resource paths here');
    },
    readBinary: vi.fn(
      async (file: TFile) =>
        new TextEncoder().encode(
          file.extension === 'pdf' ? '%PDF-1.7' : (bodies.get(file.path) ?? '')
        ).buffer
    ),
    getMarkdownFiles: () =>
      [...files.values()].filter((file) => file.extension === 'md'),
  });
  const fileManager = Object.assign(app.fileManager, {
    trashFile: vi.fn(async (file: TFile) => {
      check('trash', file.path);
      trashed.push(file.path);
      files.delete(file.path);
    }),
    generateMarkdownLink: (
      file: TFile,
      _sourcePath: string,
      subpath = '',
      alias = ''
    ) => `[[${file.path}${subpath}|${alias}]]`,
  });

  return {
    ...base,
    app: { ...app, vault, fileManager } as typeof app & {
      vault: typeof vault;
      fileManager: typeof fileManager;
    },
    trashed,
    /** The frontmatter of the note at `path`, or null when it has none. */
    frontmatterOf: (path: string) => {
      const file = files.get(path);
      return file
        ? (app.metadataCache.getFileCache(file)?.frontmatter ?? null)
        : null;
    },
    /** The body written to the note at `path`, or null when none was. */
    bodyOf: (path: string) => bodies.get(path) ?? null,
    /** Paths of every file in the vault. */
    paths: () => [...files.keys()].sort(),
    /** Make `op` fail on every path `matches` accepts. */
    fail: (op: VaultOp, matches: (path: string) => boolean = () => true) => {
      faults.push((failing, path) => failing === op && matches(path));
    },
  };
}
