import type { SQLiteRepository } from '../repository';
import type { TableName } from '../types';
import type {
  NullishToOptional,
  StringKeys,
  StringRecord,
} from '../../lib/utility-types';
import type {
  BaseQueryFactory,
  Conjunction,
  DeleteQueryFactory,
  InsertQueryFactory,
  UpdateProps,
  QueryComparator,
  QueryCondition,
  Row,
  SelectQueryFactory,
  UpdateQueryFactory,
  WhereConditions,
  InsertProps,
} from './QueryComposer.types';
import { selectQueryFactory } from './selectQueryFactory';

/**
 * ORM-like query builder
 */
export default class QueryComposer {
  repo?: SQLiteRepository;
  constructor(repo?: SQLiteRepository) {
    this.repo = repo;
  }

  select<T extends TableName>(table: T) {
    return queryFactory(table, 'SELECT', this.repo);
  }

  insert<T extends TableName>(table: T) {
    return queryFactory(table, 'INSERT', this.repo);
  }

  update<T extends TableName>(table: T) {
    return queryFactory(table, 'UPDATE', this.repo);
  }

  delete<T extends TableName>(table: T) {
    return queryFactory(table, 'DELETE', this.repo);
  }
}

// export const eq: QueryCondition = (column: string, compareValue: unknown) => {
//   return { clause: `${column} = $`, compareValue };
// };

// export const gt: QueryCondition = (column: string, compareValue: unknown) => {
//   return { clause: `${column} > $`, compareValue };
// };

// export const gte: QueryCondition = (column: string, compareValue: unknown) => {
//   return { clause: `${column} >= $`, compareValue };
// };

// export const lt: QueryCondition = (column: string, compareValue: unknown) => {
//   return { clause: `${column} < $`, compareValue };
// };

const createCondition = <
  T extends TableName,
  R extends Row<T>,
  C extends StringKeys<R>,
  F extends
    | SelectQueryFactory<T, R, C>
    | UpdateQueryFactory<T, R, C>
    | DeleteQueryFactory<T, R, C>,
>(
  factory: F,
  column: C,
  conjunction: Conjunction,
  params: R[keyof R][],
  conditions: [string, ...[Conjunction, string][]] | null,
  comparator: QueryComparator,
  compareValue: R[C]
) => {
  const condition = `${column} ${comparator} $${params.length + 1}`;
  if (conjunction === 'WHERE') {
    if (conditions)
      throw new Error(`WHERE should not be called multiple times in one query`);
    conditions = [condition];
  } else {
    if (!conditions)
      throw new Error(
        `AND or OR called without a preexisting WHERE; this shouldn't happen.`
      );
    conditions.push([conjunction, condition]);
  }
  params.push(compareValue);
  return {
    ...factory,
    and: (column: C) =>
      createConditions(factory, column, 'AND', params, conditions),
    or: (column: C) =>
      createConditions(factory, column, 'OR', params, conditions),
  };
};

// Create conditions factory
export const createConditions = <
  T extends TableName,
  R extends Row<T>,
  C extends StringKeys<R>,
  F extends
    | SelectQueryFactory<T, R, C>
    | UpdateQueryFactory<T, R, C>
    | DeleteQueryFactory<T, R, C>,
>(
  factory: F,
  column: C,
  conjunction: Conjunction,
  params: R[keyof R][],
  conditions: [string, ...[Conjunction, string][]] | null
): WhereConditions<T, R, C, F> => {
  const createComparatorCondition =
    (comparator: QueryComparator) => (compareValue: R[C]) =>
      createCondition(
        factory,
        column,
        conjunction,
        params,
        conditions,
        comparator,
        compareValue
      );
  return {
    eq: createComparatorCondition('='),
    neq: createComparatorCondition('<>'),
    lt: createComparatorCondition('<'),
    lte: createComparatorCondition('<='),
    gt: createComparatorCondition('>'),
    gte: createComparatorCondition('>='),
    in: createComparatorCondition('IN'),
  };
};

const operationFuncs = {
  SELECT: (formattedTables: string, formattedColumns: string) => {
    return `SELECT ${formattedColumns} FROM ${formattedTables}`;
  },
  INSERT: (formattedTables: string, formattedColumns: string) => {
    return `INSERT INTO ${formattedTables} ${formattedColumns} VALUES`;
  },
  UPDATE: (table: string, formattedColumnUpdates: string) => {
    return `UPDATE ${table} SET ${formattedColumnUpdates}`;
  },
  DELETE: (formattedTables: string, _: string) => {
    return `DELETE FROM ${formattedTables}`;
  },
};

// Function overloads for proper type inference
function queryFactory<T extends TableName, R extends Row<T> = Row<T>>(
  tableName: T,
  operation: 'SELECT',
  repo?: SQLiteRepository
): SelectQueryFactory<T, R>;
function queryFactory<T extends TableName, R extends Row<T> = Row<T>>(
  tableName: T,
  operation: 'INSERT',
  repo?: SQLiteRepository
): InsertQueryFactory<T, R>;
function queryFactory<T extends TableName, R extends Row<T> = Row<T>>(
  tableName: T,
  operation: 'UPDATE',
  repo?: SQLiteRepository
): UpdateQueryFactory<T, R>;
function queryFactory<T extends TableName, R extends Row<T> = Row<T>>(
  tableName: T,
  operation: 'DELETE',
  repo?: SQLiteRepository
): DeleteQueryFactory<T, R>;
function queryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
>(
  tableName: T,
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE',
  repo?: SQLiteRepository
) {
  const tables: TableName[] = [tableName];
  let cols: C[] | null = null;
  let conditions: [string, ...[Conjunction, string][]] | null = null;
  const sortings: string[] = [];
  const limitCount: number | null = null;
  const params: R[keyof R][] = [];

  let built: { query: string; queryParams: typeof params } | null = null;

  const formatTables = () =>
    tables.length > 1 ? tables.join(' JOIN ') : tableName;

  // Base factory methods available to all operations
  const baseFactory = {
    columns(...columns: C[]) {
      if (!columns.length) {
        throw new Error(
          `At least one column must be specified if calling .columns()`
        );
      }
      cols = columns;
      return this;
    },
    toString() {
      const formattedColumns = Array.isArray(cols)
        ? `(${cols.join(', ')})`
        : '*';
      let query = operationFuncs[operation](formatTables(), formattedColumns);
      if (conditions) {
        query +=
          ' WHERE ' +
          conditions
            .map((condition) =>
              Array.isArray(condition) ? condition.join(' ') : condition
            )
            .join(' ');
      }
      if (sortings.length) query += sortings.join(', ');
      if (limitCount) query += `LIMIT ${limitCount}`;
      return query;
    },
    build() {
      built ||= {
        query: this.toString(),
        queryParams: params,
      };
      return built;
    },
    async execute() {
      if (!repo) {
        console.warn(`No SQLiteRepository instance provided`);
        return;
      }
      const { query, queryParams } = this.build();
      // TODO: query and param validation
      try {
        const result = await repo.execSql(query, queryParams);
        await repo.save();
        return result[0];
      } catch (error) {
        console.error(error);
        console.error({ query, queryParams });
      }
    },
  };

  // Build the factory based on operation type
  let factory: any;

  if (operation === 'SELECT') {
    return selectQueryFactory(tableName, createConditions, baseFactory, repo);
  } else if (operation === 'INSERT') {
    const rowIds = null;
    let insertCols: C[] | null = null;
    let insertValues:
      | NullishToOptional<R>[keyof NullishToOptional<R>][][]
      | null = null;
    const { execute } = baseFactory;
    // TODO: return w/o build/toString methods until columns and values are called in sequence

    const insertToString = () => {
      // TODO: disable for incomplete queries
      if (insertValues === null) {
        throw new Error(`Can't build without any values to insert.`);
      }
      if (insertCols === null)
        throw new Error(`Columns should be set before toString() is available`);
      const formattedColumns = `(${insertCols.join(', ')})`;
      let query = operationFuncs['INSERT'](formatTables(), formattedColumns);
      if (!insertCols)
        throw new TypeError(`Insert queries must specify columns`);
      query +=
        ' ' +
        insertValues
          .map((_) => `(${insertCols!.map((_, i) => `$${i + 1}`).join(', ')})`)
          .join(', ');
      return query;
    };

    const insertBuild = () => {
      // TODO: disable for incomplete queries
      if (insertValues === null) {
        throw new Error(`Can't build without any values to insert.`);
      }
      built ||= {
        query: insertToString(),
        queryParams: insertValues!.flat(1) as R[keyof R][], // TODO: remove assertion,
      };
      return built;
    };

    const insertValuesFunc = (...values: InsertProps<T, R, C>[]) => {
      if (!insertCols) {
        throw new Error(`Columns must be specified before inserting values`);
      }
      // turn objects into arrays of parameters sorted the same way as `insertCols`
      insertValues = values.map((row) => {
        return insertCols!.map((col) => row[col]);
      });
      return {
        toString: insertToString,
        build: insertBuild,
        execute,
      };
    };
    factory = {
      columns(...columns: C[]) {
        if (!columns.length) {
          throw new Error(
            `At least one column must be specified if calling .columns()`
          );
        }
        insertCols = columns;
        return {
          values: insertValuesFunc,
        };
      },
    };
  } else if (operation === 'UPDATE') {
  } else {
    // UPDATE or DELETE
    factory = {
      ...baseFactory,
      where: <K extends StringKeys<R>>(column: K) =>
        createConditions(factory, column, 'WHERE', params, conditions),
    };
  }

  return factory;
}
