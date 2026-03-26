import {
  normalizePath,
  Platform,
  type App,
  type DataAdapter,
  type Plugin,
  type TAbstractFile,
} from 'obsidian';
import initSqlJs from 'sql.js';
import {
  applyMigrations,
  getPendingMigrations,
  getSchemaVersion,
  MigrationVerificationError,
} from '#/db/migrations';
import type { BindParams, Database, QueryExecResult } from 'sql.js';
// @ts-ignore - WASM imported as base64 string via custom esbuild plugin
import wasmBase64 from '#/db/sql-wasm.wasm';
import {
  BACKUP_DIRECTORY,
  DATA_DIRECTORY,
  LOG_DIRECTORY,
  TABLE_NAMES,
} from '#/lib/constants';
import type { RowTypes, SQLiteRepository } from '#/lib/types';
import type { Primitive } from '#/lib/utility-types';

export class SQLJSRepository implements SQLiteRepository {
  app: App;
  adapter: DataAdapter;
  db: Database;
  #dbFilePath: string;
  #schema: string;
  /**  */
  #sql: initSqlJs.SqlJsStatic;
  #pendingSaveCount: number = 0;
  #onMigrationFailure?: (error: MigrationVerificationError) => void;
  onReloadFromDisk?: () => void | Promise<void>;

  /**
   * Use .start to instantiate
   */
  protected constructor(params: {
    app: App;
    dbFilePath: string;
    schema: string;
    onMigrationFailure?: (error: MigrationVerificationError) => void;
    onReloadFromDisk?: () => void | Promise<void>;
  }) {
    this.app = params.app;
    this.adapter = params.app.vault.adapter;
    this.#dbFilePath = normalizePath(params.dbFilePath);
    this.#schema = params.schema;
    this.#onMigrationFailure = params.onMigrationFailure;
    this.onReloadFromDisk = params.onReloadFromDisk;
    this.handleFileChange = this.handleFileChange.bind(this) as (
      file: TAbstractFile
    ) => Promise<void>;
  }

  /**
   * Asynchronous factory function
   * @param plugin the plugin instance
   * @param schema the SQL schema as a string
   */
  static async start(params: {
    plugin: Plugin;
    dbFilePath: string;
    schema: string;
    onMigrationFailure?: (error: MigrationVerificationError) => void;
    onReloadFromDisk?: () => void | Promise<void>;
  }): Promise<SQLJSRepository> {
    const repo = new SQLJSRepository({ ...params, app: params.plugin.app });
    // load the database file or create it if loading fails
    // TODO: handle failed loads when the file exists
    if (repo.dbExists()) {
      const result = await repo.loadDb();
      if (result === null) {
        throw new Error(
          `Db file found at ${params.dbFilePath}, but failed to load`
        );
      }
    } else {
      await repo.initDb();
    }
    return repo;
  }

  get dbFilePath() {
    return this.#dbFilePath;
  }

  async handleFileChange(file: TAbstractFile) {
    if (file.path !== this.dbFilePath || file.deleted) {
      return;
    }
    // skip reload if the changes resulted from saving this db instance to disk
    if (this.#pendingSaveCount > 0) {
      this.#pendingSaveCount--;
      return;
    }

    try {
      await this.reloadDb();
      await this.onReloadFromDisk?.();
    } catch (error) {
      if (
        error instanceof MigrationVerificationError &&
        this.#onMigrationFailure
      ) {
        this.#onMigrationFailure(error);
      }
    }
  }

  /**
   * Execute a read query and return an array of objects corresponding to table rows
   * @param query
   * @returns an array of rows
   */
  query(query: string, params: Primitive[] = []) {
    const result = this._execSql(query, params);
    const rows = result[0];
    return rows;
  }

  /**
   * Execute a write query
   * @param query
   * @returns an empty array on success
   */
  mutate(query: string, params: Primitive[] = []) {
    const result = this._execSql(query, params);
    void this.save();
    return result as [][];
  }

  /**
   * Execute one or more queries and return an array of objects corresponding to table rows.
   * Use `query` or `mutate` methods above instead where possible.
   *
   *  TODO:
   * - handle errors better?
   * @param query
   * @returns an array where each top-level element is the result of a query
   */
  _execSql(query: string, params: Primitive[] = []) {
    // console.log({ query, params });
    try {
      const results = this.db.exec(query, this.coerceParams(params));
      if (!results || !results.length) return [[]];

      // in SQL.js, selected rows are returned in form [{ columns: string[], values: Array<SQLValue[]> }]
      const formatted = results.map((result) => this.formatResult(result));
      return formatted;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Incremental Reading - Database query failed:', {
          error: error?.message || error,
          query: query.slice(0, 100) + (query.length > 100 ? '...' : ''),
          platform: Platform.isMobile ? 'mobile' : 'desktop',
        });
      }
      return [[]];
    }
  }

  /**
   * Converts params to SQLite-appropriate types
   */
  protected coerceParams(params: Primitive[]): BindParams {
    return params.map((param) => {
      switch (typeof param) {
        case 'boolean':
          return Number(param);
        case 'symbol':
          return param.toString();
        case 'undefined':
          return null;
        case 'string':
        case 'number':
        case 'object': // typeof null
          return param;
      }
    });
  }

  /**
   * Format the result of a single query
   * TODO: convert snake_case properties to camelCase?
   */
  protected formatResult<T extends RowTypes>(result: QueryExecResult): T[] {
    const { columns, values } = result;
    const formattedEntries = values.map((row) => {
      const output = row.reduce(
        (acc, cell, i) => Object.assign(acc, { [columns[i]]: cell }),
        {}
      );

      return output;
    });

    return formattedEntries as T[];
  }

  /**
   * Overwrite or create the database file
   */
  protected async save() {
    if (!this.db) throw new Error('Database was not initialized on repository');
    try {
      this.#pendingSaveCount++;
      const data = this.db.export().buffer;
      const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
      if (!dataDir) {
        await this.app.vault.createFolder(DATA_DIRECTORY);
      }
      return await this.app.vault.adapter.writeBinary(
        normalizePath(this.#dbFilePath),
        data as ArrayBuffer
      );
    } catch (error) {
      this.#pendingSaveCount--;
      if (error instanceof Error) {
        console.error('Incremental Reading - Failed to save database:', {
          error: 'message' in error ? error.message : error,
          platform: Platform,
          dbPath: this.#dbFilePath,
        });
        throw error; // Re-throw to surface critical save failures
      }
    }
  }

  /**
   * Initialize the in-memory database.
   * If a database file exists, use `loadDb()` instead
   * @returns a Database, or null if an error is thrown
   */
  protected async initDb() {
    try {
      const sql = await this.loadWasm();
      this.db = new sql.Database();
      this.db.exec(this.#schema);
      return this.db;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /**
   * Check if the database file exists
   */
  protected dbExists() {
    const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
    if (!dataDir) return false;

    return !!this.app.vault.getAbstractFileByPath(
      normalizePath(this.#dbFilePath)
    );
  }

  /**
   * Attempt to load a pre-existing database from disk
   * @returns a Database, or `null` if the file is invalid or not found
   * @throws {MigrationVerificationError} if post-migration verification fails
   */
  protected async loadDb() {
    try {
      const result = await this.reloadDb();
      if (!result) {
        console.error('Incremental Reading - Failed to load database');
        return null;
      }
      return result;
    } catch (error) {
      if (error instanceof MigrationVerificationError) throw error;
      console.error(error);
      return null;
    }
  }

  /**
   * Attempt to reload a pre-existing database from disk.
   * If migrations are pending, backs up the database first and verifies
   * data integrity after applying them.
   * @returns a Database, or `null` if the file is invalid or not found
   * @throws {MigrationVerificationError} if post-migration verification fails
   */
  protected async reloadDb() {
    try {
      this.#sql ||= await this.loadWasm();
      const dbArrayBuffer = await this.app.vault.adapter.readBinary(
        normalizePath(this.#dbFilePath)
      );
      // Use browser-compatible Uint8Array instead of Node.js Buffer
      // for mobile compatibility
      this.db = new this.#sql.Database(new Uint8Array(dbArrayBuffer));

      const pending = getPendingMigrations(this.db);
      if (pending.length > 0) {
        const previousVersion = getSchemaVersion(this.db);
        await this.backupDatabase(previousVersion);

        const preRowCounts = this.snapshotRowCounts();
        const preFkIssues = this.foreignKeyCheck();

        // Aggregate expected row count changes across all pending migrations
        const expectedChanges: Record<string, number> = {};
        for (const migration of pending) {
          if (migration.expectedRowCountChanges) {
            for (const [table, delta] of Object.entries(
              migration.expectedRowCountChanges
            )) {
              expectedChanges[table] = (expectedChanges[table] ?? 0) + delta;
            }
          }
        }

        const updated = applyMigrations(this.db);

        if (updated) {
          const verification = this.verifyMigration(
            preRowCounts,
            preFkIssues,
            Object.keys(expectedChanges).length > 0
              ? expectedChanges
              : undefined
          );

          if (!verification.passed) {
            const newVersion = getSchemaVersion(this.db);
            const logPath = await this.writeErrorLog(verification.errors, {
              previousVersion,
              targetVersion: newVersion,
            });

            console.error(
              'Incremental Reading - Migration verification failed:',
              verification.errors
            );

            throw new MigrationVerificationError(
              `Migration verification failed (v${previousVersion} -> v${newVersion}). See log: ${logPath}`,
              verification.errors,
              logPath
            );
          }

          await this.save();
        }
      }

      return this.db;
    } catch (error) {
      if (error instanceof MigrationVerificationError) throw error;
      if (error instanceof Error) {
        console.error('Incremental Reading - Failed to reload database:', {
          error: error?.message || error,
          platform: Platform.isMobile ? 'mobile' : 'desktop',
          dbPath: this.#dbFilePath,
        });
      }
      return null;
    }
  }

  /**
   * Back up the database file before applying migrations.
   * Verifies backup integrity via SHA-256 checksum comparison.
   */
  protected async backupDatabase(currentVersion: number): Promise<string> {
    const dirExists = await this.adapter.exists(
      normalizePath(BACKUP_DIRECTORY)
    );
    if (!dirExists) {
      await this.adapter.mkdir(normalizePath(BACKUP_DIRECTORY));
    }

    const originalData = await this.adapter.readBinary(
      normalizePath(this.#dbFilePath)
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `ir-user-data_v${currentVersion}_${timestamp}.sqlite`;
    const backupPath = normalizePath(`${BACKUP_DIRECTORY}/${backupFileName}`);

    await this.adapter.writeBinary(backupPath, originalData);

    // Verify backup integrity via SHA-256 checksum
    const backupData = await this.adapter.readBinary(backupPath);
    const [originalHash, backupHash] = await Promise.all([
      this.sha256(originalData),
      this.sha256(backupData),
    ]);

    if (originalHash !== backupHash) {
      throw new Error(
        `Backup verification failed: checksum mismatch for ${backupPath}`
      );
    }

    console.debug(`Incremental Reading - Database backed up to ${backupPath}`);
    return backupPath;
  }

  protected async sha256(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  protected snapshotRowCounts(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const table of TABLE_NAMES) {
      try {
        const result = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
        snapshot[table] = (result[0]?.values[0]?.[0] as number) ?? 0;
      } catch {
        snapshot[table] = -1; // table may not exist yet
      }
    }
    return snapshot;
  }

  protected foreignKeyCheck(): string | null {
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      const fkResult = this.db.exec('PRAGMA foreign_key_check');
      if (fkResult.length > 0 && fkResult[0].values.length > 0) {
        return `foreign_key_check found ${fkResult[0].values.length} violation(s): ${JSON.stringify(fkResult[0].values.slice(0, 5))}`;
      }
      return null;
    } catch (e) {
      return `foreign_key_check threw: ${e}`;
    }
  }

  protected verifyMigration(
    preRowCounts: Record<string, number>,
    preFkIssues: string | null,
    expectedRowCountChanges?: Record<string, number>
  ): { passed: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. Structural integrity
    try {
      const result = this.db.exec('PRAGMA integrity_check');
      const status = result[0]?.values[0]?.[0] as string;
      if (status !== 'ok') {
        errors.push(`integrity_check failed: ${status}`);
      }
    } catch (e) {
      errors.push(`integrity_check threw: ${e}`);
    }

    // 2. Foreign key integrity — only flag new issues introduced by the migration
    const postFkIssues = this.foreignKeyCheck();
    if (postFkIssues !== null && postFkIssues !== preFkIssues) {
      errors.push(postFkIssues);
    }

    // 3. Row count comparison
    const postRowCounts = this.snapshotRowCounts();
    for (const table of TABLE_NAMES) {
      const pre = preRowCounts[table];
      const post = postRowCounts[table];
      if (pre === -1) continue; // table didn't exist before migration
      const expectedDelta = expectedRowCountChanges?.[table] ?? 0;
      const actualDelta = post - pre;
      if (actualDelta !== expectedDelta) {
        errors.push(
          `Row count mismatch for "${table}": expected delta ${expectedDelta}, got ${actualDelta} (was ${pre}, now ${post})`
        );
      }
    }

    // 4. CHECK constraint spot-checks
    const checkQueries = [
      {
        sql: `SELECT COUNT(*) FROM article WHERE priority < 10 OR priority > 50`,
        desc: 'article priority out of range',
      },
      {
        sql: `SELECT COUNT(*) FROM article WHERE dismissed NOT IN (0, 1)`,
        desc: 'article dismissed invalid',
      },
      {
        sql: `SELECT COUNT(*) FROM snippet WHERE priority < 10 OR priority > 50`,
        desc: 'snippet priority out of range',
      },
      {
        sql: `SELECT COUNT(*) FROM srs_card WHERE state < 0 OR state > 3`,
        desc: 'srs_card state out of range',
      },
    ];
    for (const check of checkQueries) {
      try {
        const result = this.db.exec(check.sql);
        const count = (result[0]?.values[0]?.[0] as number) ?? 0;
        if (count > 0) {
          errors.push(`CHECK violation: ${check.desc} (${count} rows)`);
        }
      } catch (e) {
        errors.push(`CHECK validation threw for "${check.desc}": ${e}`);
      }
    }

    return { passed: errors.length === 0, errors };
  }

  protected async writeErrorLog(
    errors: string[],
    context: { previousVersion: number; targetVersion: number }
  ): Promise<string> {
    const dirExists = await this.adapter.exists(normalizePath(LOG_DIRECTORY));
    if (!dirExists) {
      await this.adapter.mkdir(normalizePath(LOG_DIRECTORY));
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFileName = `migration-error_v${context.previousVersion}-to-v${context.targetVersion}_${timestamp}.log`;
    const logPath = normalizePath(`${LOG_DIRECTORY}/${logFileName}`);

    const content = [
      `Incremental Reading Plugin - Migration Verification Failure`,
      `Timestamp: ${new Date().toISOString()}`,
      `Migration: v${context.previousVersion} -> v${context.targetVersion}`,
      ``,
      `Errors:`,
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    ].join('\n');

    await this.adapter.write(logPath, content);
    return logPath;
  }

  protected async loadWasm() {
    // Decode base64 WASM to binary using browser-compatible API (instead of Node.js Buffer)
    // This ensures compatibility with mobile devices (iOS/Android WebView)
    const binaryString = atob(wasmBase64 as string);
    const wasmBinary = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      wasmBinary[i] = binaryString.charCodeAt(i);
    }

    try {
      const sql = await initSqlJs({
        wasmBinary: wasmBinary as unknown as ArrayBuffer,
      });
      // console.log('Incremental Reading - WASM initialized successfully');
      return sql;
    } catch (error) {
      console.error('Incremental Reading - Failed to initialize WASM:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error?.name,
          message: error?.message,
          stack: error?.stack,
        });
      }
      throw error;
    }
  }
}
