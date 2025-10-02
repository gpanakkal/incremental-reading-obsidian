import { normalizePath, type App, type DataAdapter } from 'obsidian';
import type { BindParams, Database, QueryExecResult } from 'sql.js';
import initSqlJs from 'sql.js';
import { DATA_DIRECTORY, WASM_FILE_NAME } from '../lib/constants';
import type { Primitive } from '../lib/utility-types';
import type { RowTypes } from './types';

export class SQLiteRepository {
  app: App;
  adapter: DataAdapter;
  db: Database;
  #dbFilePath: string;
  #schemaFilePath: string;
  #pluginDir: string;

  /**
   * Use .start to initialize instead
   */
  private constructor(
    app: App,
    dbFilePath: string,
    schemaFilePath: string,
    pluginDir: string
  ) {
    this.app = app;
    this.adapter = app.vault.adapter;
    this.#dbFilePath = dbFilePath;
    this.#schemaFilePath = schemaFilePath;
    this.#pluginDir = pluginDir;
  }

  /**
   * Asynchronous factory function
   * @param dbFilePath the path of the database file relative to the plugin root
   * @param schemaFilePath the path of the schema.sql file relative to the plugin root
   * @param pluginDir the plugin's installation directory (from this.manifest.dir)
   */
  static async start(
    app: App,
    dbFilePath: string,
    schemaFilePath: string,
    pluginDir: string
  ): Promise<SQLiteRepository> {
    const repo = new SQLiteRepository(
      app,
      dbFilePath,
      schemaFilePath,
      pluginDir
    );
    // load the database file or create it if loading fails
    // TODO: handle failed loads when the file exists
    if (repo.dbExists()) {
      await repo.loadDb();
    } else {
      await repo.initDb();
    }
    // (await repo.loadDb()) ?? (await repo.initDb()); // TODO: uncomment to persist data between starts
    // await repo.initDb(); // TODO: remove for production
    return repo;
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
        case 'object':
          return param;
      }
    });
  }

  /**
   * Execute one or more queries and return an array of objects corresponding to table rows.
   * Use `query` or `mutation` methods above instead where possible.
   *
   *  TODO:
   * - verify this works on all tables, with inner and outer JOINs, etc
   * - handle errors better?
   * @param query
   * @returns an array where each top-level element is the result of a query
   */
  async execSql(query: string, params: Primitive[] = []) {
    const results = this.db.exec(query, this.coerceParams(params));
    if (!results || !results.length) return [[]];

    // in SQL.js, selected rows are returned in form [{ columns: string[], values: Array<SQLValue[]> }]
    const formatted = results.map(this.formatResult);
    return formatted;
  }

  /**
   * Format the result of a single query
   * TODO: convert snake_case properties to camelCase
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
  async save() {
    if (!this.db) throw new Error('Database was not initialized on repository');
    const data = this.db.export().buffer;
    try {
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
      const schema = await this.adapter.read(this.getSchemaPath());
      this.db.exec(schema);
      await this.save();
      console.log('Incremental Reading database initialized');
      return this.db;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  async getSchema(tableName: string) {
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

  /**
   * Check if the database file exists
   */
  private dbExists() {
    try {
      const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
      if (!dataDir) {
        return false;
      }
      return !!this.app.vault.getAbstractFileByPath(
        normalizePath(this.#dbFilePath)
      );
    } catch (e) {
      // TODO: properly handle errors
      console.error(e);
      return false;
    }
  }

  /**
   * Attempt to load a pre-existing database from disk
   * @returns a Database or null if the file is invalid or not found
   */
  private async loadDb() {
    try {
      const sql = await this.loadWasm();
      // const dataDir = this.app.vault.getFolderByPath(DATA_DIRECTORY);
      // if (!dataDir) {
      //   await this.app.vault.createFolder(DATA_DIRECTORY);
      // }
      const dbArrayBuffer = await this.app.vault.adapter.readBinary(
        normalizePath(this.#dbFilePath)
      );
      this.db = new sql.Database(Buffer.from(dbArrayBuffer));
      console.log('Incremental Reading database loaded');
      return this.db;
    } catch (e) {
      // TODO: properly handle errors
      // console.error(e);
      return null;
    }
  }

  private async loadWasm() {
    const relativePath = normalizePath(`${this.#pluginDir}/${WASM_FILE_NAME}`);
    const wasmPath = this.adapter.getFullRealPath(relativePath);

    const sql = await initSqlJs({
      // TODO: handle throws
      locateFile: (_file) => wasmPath,
    });

    return sql;
  }

  private getSchemaPath() {
    return normalizePath(`${this.#pluginDir}/${this.#schemaFilePath}`);
  }
}
