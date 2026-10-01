// @vitest-environment jsdom
import { queryClient } from '#/lib/query-client';
import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import { Notice } from '#/test/__mocks__/obsidian';
import { readFileSync } from 'fs';
import type { App, TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { RelinkModal, openRelinkPicker } from './RelinkModal';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8');

let SQL: SqlJsStatic;

class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}
}

function insertArticle(
  repo: TestRepository,
  id: string,
  reference: string,
  deleted = false
) {
  repo.mutate(
    `INSERT INTO article (id, reference, deleted, due, interval, priority)
     VALUES ($1, $2, $3, 1700000000000, 86400000, 30)`,
    [id, reference, deleted]
  );
}

function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path,
    name,
    basename: name.replace(/\.[^.]*$/, ''),
    extension: name.slice(name.lastIndexOf('.') + 1),
  } as TFile;
}

function makePlugin(
  repo: TestRepository,
  files: TFile[],
  frontmatter: Record<string, Record<string, unknown>> = {}
) {
  return {
    app: {
      vault: {
        getFiles: vi.fn(() => files),
        getFileByPath: vi.fn(
          (path: string) => files.find((file) => file.path === path) ?? null
        ),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) =>
          file.path in frontmatter
            ? { frontmatter: frontmatter[file.path] }
            : null
        ),
      },
      fileManager: { processFrontMatter: vi.fn(async () => {}) },
      workspace: { trigger: vi.fn() },
    },
    reviewManager: {
      repo,
      snippets: { offsetTracker: { renameFile: vi.fn() } },
    },
  };
}

function referenceOf(repo: TestRepository, id: string) {
  return repo.db?.exec('SELECT reference FROM article WHERE id = $1', {
    $1: id,
  })[0]?.values[0]?.[0];
}

// #endregion

describe('openRelinkPicker', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists only unclaimed files of the item’s type, by path', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.pdf');
    insertArticle(repo, 'other', 'held.pdf');
    insertArticle(repo, 'tomb', 'freed.pdf', true);
    const files = [
      'held.pdf',
      'free.PDF',
      'note.md',
      'freed.pdf',
      'd/x.pdf',
    ].map(makeFile);
    const plugin = makePlugin(repo, files);
    const open = vi.spyOn(RelinkModal.prototype, 'open');
    const setPlaceholder = vi.spyOn(RelinkModal.prototype, 'setPlaceholder');

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
    });

    expect(modal?.getItems().map((file) => file.path)).toEqual([
      'free.PDF',
      'freed.pdf',
      'd/x.pdf',
    ]);
    expect(modal?.getItemText(files[3])).toBe('freed.pdf');
    expect(setPlaceholder).toHaveBeenCalledWith('Relink "gone.pdf" to…');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves out notes that carry another live item’s ir-id', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.md');
    insertArticle(repo, 'other', 'o.md');
    const files = ['copy.md', 'mine.md', 'plain.md'].map(makeFile);
    const plugin = makePlugin(repo, files, {
      'copy.md': { 'ir-id': 'other' },
      'mine.md': { 'ir-id': 'i' },
    });

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.md',
    });

    expect(modal?.getItems().map((file) => file.path)).toEqual([
      'mine.md',
      'plain.md',
    ]);
  });

  it('leaves out notes tagged as another kind of item', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.md');
    const files = ['snippet.md', 'article.md', 'plain.md'].map(makeFile);
    const plugin = makePlugin(repo, files, {
      'snippet.md': { tags: ['ir-text-snippet'] },
      'article.md': { tags: ['ir-article'] },
    });

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.md',
    });

    expect(modal?.getItems().map((file) => file.path)).toEqual([
      'article.md',
      'plain.md',
    ]);
  });

  it('says so, and refreshes nothing, when relinking fails outright', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.pdf');
    const target = makeFile('found.pdf');
    const plugin = makePlugin(repo, [target]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
    });
    vi.spyOn(repo, 'transaction').mockRejectedValue(new Error('disk full'));
    modal?.onChooseItem(target);

    await vi.waitFor(() =>
      expect(Notice.messages).toEqual(['Failed to relink to "found.pdf"'])
    );
    expect(error).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('says so and opens nothing when no file qualifies', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.pdf');
    const plugin = makePlugin(repo, [makeFile('note.md')]);
    const open = vi.spyOn(RelinkModal.prototype, 'open');

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
    });

    expect(modal).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([
      'No unlinked files of this type to relink to',
    ]);
  });

  it('relinks the item to the picked file and refreshes it', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.pdf');
    const target = makeFile('found.pdf');
    const plugin = makePlugin(repo, [target]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
    });
    modal?.onChooseItem(target);

    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(referenceOf(repo, 'i')).toBe('found.pdf');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['item', 'i'] });
  });

  it('refreshes nothing when the relink is refused', async () => {
    const repo = TestRepository.create();
    insertArticle(repo, 'i', 'gone.pdf');
    const target = makeFile('found.pdf');
    const plugin = makePlugin(repo, [target]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const modal = await openRelinkPicker(plugin as never, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
    });
    // Taken by another item after the picker listed it
    insertArticle(repo, 'late', 'found.pdf');
    modal?.onChooseItem(target);

    await vi.waitFor(() =>
      expect(Notice.messages).toEqual([
        '"found.pdf" already belongs to another item',
      ])
    );
    expect(referenceOf(repo, 'i')).toBe('gone.pdf');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
