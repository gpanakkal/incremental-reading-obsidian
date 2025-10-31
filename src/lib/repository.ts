import type { TAbstractFile } from 'obsidian';
import {
  normalizePath,
  type App,
  type DataAdapter,
  type Plugin,
} from 'obsidian';
import type { BindParams, Database, QueryExecResult } from 'sql.js';
import initSqlJs from 'sql.js';
import { DATA_DIRECTORY } from '../lib/constants';
import type { Primitive } from '../lib/utility-types';
import type { RowTypes } from '../lib/types';
// @ts-ignore - WASM imported as base64 string via custom esbuild plugin
import wasmBase64 from '../db/sql-wasm.wasm';

export class SQLiteRepository {
  app: App;
  adapter: DataAdapter;
  db: Database;
  #dbFilePath: string;
  #schema: string;
  /**  */
  #sql: initSqlJs.SqlJsStatic;
  #isSaving: boolean = false;

  /**
   * Use .start to instantiate
   */
  private constructor(app: App, dbFilePath: string, schema: string) {
    this.app = app;
    this.adapter = app.vault.adapter;
    this.#dbFilePath = normalizePath(dbFilePath);
    this.#schema = schema;
    this.handleFileChange = this.handleFileChange.bind(this);
  }

  /**
   * Asynchronous factory function
   * @param plugin the plugin instance (used for registering and cleaning up event handlers)
   * @param dbFilePath the path of the database file relative to the vault root
   * @param schema the SQL schema as a string
   */
  static async start(
    plugin: Plugin,
    dbFilePath: string,
    schema: string
  ): Promise<SQLiteRepository> {
    const repo = new SQLiteRepository(plugin.app, dbFilePath, schema);
    // load the database file, or create it if it doesn't exist
    if (repo.dbExists()) {
      const result = await repo.loadDb();
      if (result === null) {
        throw new Error(`Db file found at ${dbFilePath}, but failed to load`);
      }
    } else {
      await repo.initDb();
    }
    // listen for sync updates to the database and re-read the file
    plugin.registerEvent(repo.app.vault.on('modify', repo.handleFileChange));
    return repo;
  }

  get dbFilePath() {
    return this.#dbFilePath;
  }

  async handleFileChange(file: TAbstractFile) {
    if (file.path !== this.dbFilePath || file.deleted) {
      return;
    }
    // skip reload if the changes occurred locally
    if (this.#isSaving) {
      this.#isSaving = false;
      return;
    }

    await this.reloadDb();
  }

  /**
   * Execute a read query and return an array of objects corresponding to table rows
   *  TODO:
   * - handle errors better?
   * @param query
   * @returns an array of rows
   */
  async query(query: string, params: Primitive[] = []) {
    const result = await this.execSql(query, params);
    const rows = result[0];
    return rows;
  }

  /**
   * Execute a write query
   *  TODO:
   * - handle errors better?
   * @param query
   * @returns an empty array on success
   */
  async mutate(query: string, params: Primitive[] = []) {
    const result = await this.execSql(query, params);
    await this.save();
    return result;
  }

  /**
   * Converts params to SQLite-appropriate types
   */
  coerceParams(params: Primitive[]): BindParams {
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
   * Execute one or more queries and return an array of objects corresponding to table rows.
   * Use `query` or `mutate` methods above instead where possible.
   *
   *  TODO:
   * - handle errors better?
   * @param query
   * @returns an array where each top-level element is the result of a query
   */
  async execSql(query: string, params: Primitive[] = []) {
    try {
      const results = this.db.exec(query, this.coerceParams(params));
      if (!results || !results.length) return [[]];

      // in SQL.js, selected rows are returned in form [{ columns: string[], values: Array<SQLValue[]> }]
      const formatted = results.map(this.formatResult);
      return formatted;
    } catch (error) {
      console.error(error);
      return [[]];
    }
  }

  /**
   * Format the result of a single query
   * TODO: convert snake_case properties to camelCase?
   */
  formatResult<T extends RowTypes>(result: QueryExecResult): T[] {
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
  async save(creating: boolean = false) {
    if (!this.db) throw new Error('Database was not initialized on repository');
    try {
      this.#isSaving = true;
      const data = this.db.export().buffer;
      if (!creating && !this.dbExists()) {
        await this.initDb();
      }
      const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
      if (!dataDir) {
        await this.app.vault.createFolder(DATA_DIRECTORY);
      }
      return this.app.vault.adapter.writeBinary(
        normalizePath(this.#dbFilePath),
        data as ArrayBuffer
      );
    } catch (error) {
      console.error('Failed to save database to disk:' + error);
    }
  }

  /**
   * Initialize the database, assuming the file doesn't exist
   * @returns a Database, or null if an error is thrown
   */
  async initDb() {
    try {
      const sql = await this.loadWasm();
      this.db = new sql.Database();
      this.db.exec(this.#schema);
      await this.save(true);
      console.log('Incremental Reading database initialized');
      return this.db;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /** Print database schema in the console */
  async _getSchema(tableName: string) {
    if (!this.db) throw new Error('Database was not initialized on repository');
    const result = this.db.exec(
      'SELECT sql from sqlite_schema WHERE name = $1',
      [tableName]
    );
    if (!result) {
      console.warn(`No schema found for table ${tableName}`);
      return;
    }

    const schemaString = result[0].values[0][0];
    if (!schemaString) {
      console.warn('No schema returned');
      return;
    }
    const segments = schemaString.toString().split('\n');
    segments.forEach(console.log);
  }

  private async updateSchema() {
    this.db.exec(this.#schema);
    await this.save();
  }

  /**
   * Check if the database file exists
   */
  private dbExists() {
    const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
    if (!dataDir) return false;

    return !!this.app.vault.getAbstractFileByPath(
      normalizePath(this.#dbFilePath)
    );
  }

  /**
   * Attempt to load a pre-existing database from disk
   * @returns a Database, or `null` if the file is invalid or not found
   */
  private async loadDb() {
    try {
      const result = await this.reloadDb();
      if (!result) return null;
      await this.updateSchema();
      console.log('Incremental Reading database loaded');
      return result;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /**
   * Attempt to reload a pre-existing database from disk
   * @returns a Database, or `null` if the file is invalid or not found
   */
  private async reloadDb() {
    try {
      this.#sql ||= await this.loadWasm();
      const dbArrayBuffer = await this.app.vault.adapter.readBinary(
        normalizePath(this.#dbFilePath)
      );
      this.db = new this.#sql.Database(Buffer.from(dbArrayBuffer));
      return this.db;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  private async loadWasm() {
    // Decode base64 WASM to binary
    const buffer = Buffer.from(wasmBase64, 'base64');

    // Convert Buffer to Uint8Array for better compatibility with Emscripten
    const wasmBinary = new Uint8Array(buffer);

    try {
      const sql = await initSqlJs({
        wasmBinary: wasmBinary as unknown as ArrayBuffer,
      });

      return sql;
    } catch (error) {
      console.error('Failed to initialize WASM:', error);
      throw error;
    }
  }
}
