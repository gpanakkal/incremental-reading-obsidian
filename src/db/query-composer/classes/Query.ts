import type { StringKeys } from 'src/lib/utility-types';
import type { Conjunction, DeleteQueryFactory, QueryComparator, Row, SelectQueryFactory, UpdateQueryFactory, WhereConditions } from '../QueryComposer.types';
import type { SQLiteRepository } from '../../repository';
import type { TableName } from '../../types';

export default class Query<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> {
  tableName: T;
  repo?: SQLiteRepository;
  constructor(tableName: T, repo?: SQLiteRepository) {
    this.tableName = tableName;
    this.repo = repo;
  }

  protected createCondition(
    column: C,
    conjunction: Conjunction,
    params: R[keyof R][],
    conditions: [string, ...[Conjunction, string][]] | null,
    comparator: QueryComparator,
    compareValue: R[C]
  ) {
    const condition = `${column} ${comparator} $${params.length + 1}`;
    if (conjunction === 'WHERE') {
      if (conditions)
        throw new Error(
          `WHERE should not be called multiple times in one query`
        );
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
      and: (column: C) => this.createConditions(column, 'AND', params, conditions),
      or: (column: C) => this.createConditions(column, 'OR', params, conditions),
    };
  }

  protected createConditions = <
    T extends TableName,
    R extends Row<T>,
    F extends
      | SelectQueryFactory<T, R, C>
      | UpdateQueryFactory<T, R, C>
      | DeleteQueryFactory<T, R, C>,
  >(
    column: C,
    conjunction: Conjunction,
    params: R[keyof R][],
    conditions: [string, ...[Conjunction, string][]] | null
  ): WhereConditions<T, R, C, F> => {
    const createComparatorCondition =
      (comparator: QueryComparator) => (compareValue: R[C]) =>
        this.createCondition(
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
  
}
