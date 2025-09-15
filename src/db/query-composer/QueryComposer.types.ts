import type {
  Resolve,
  StringKeys,
  NullishToOptional,
  SafeOmit,
} from 'src/lib/utility-types';
import type { TableName, TableNameToRowType } from '../types';

export type QueryComparator = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'IN';

export type Row<T extends TableName> = Resolve<TableNameToRowType[T]>;

/**
 * Make nullish props optional
 */
export type InsertProps<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> = NullishToOptional<Pick<R, C>>;

/**
 * Make nullish props optional and exclude `id`
 */
export type UpdateProps<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> = NullishToOptional<Pick<R, Exclude<C, 'id'>>>;

export interface BaseQueryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> {
  columns: (...columns: C[]) => this;
  build: () => { query: string; queryParams: R[keyof R][] };
  toString: () => string;
}

// Conditional interfaces based on operation
export interface SelectQueryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> extends BaseQueryFactory<T, R> {
  where: (column: C) => WhereConditions<T, R, C, SelectQueryFactory<T, R>>;
  join: <S extends Exclude<TableName, T>>(secondTable: S) => JoinBuilder<T, S>;
  sort: (orderings: [column: string, direction?: 'ASC' | 'DESC'][]) => this;
  limit: (limit: number) => this;
  execute: () => Promise<R[]>;
}

export interface UpdateQueryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> extends BaseQueryFactory<T, R> {
  where: (column: C) => WhereConditions<T, R, C, UpdateQueryFactory<T, R>>;
  execute: () => Promise<R[]>;
}

export interface DeleteQueryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> extends BaseQueryFactory<T, R> {
  where: (column: C) => WhereConditions<T, R, C, DeleteQueryFactory<T, R>>;
  execute: () => Promise<R[]>;
}

export interface InsertQueryFactory<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> extends BaseQueryFactory<T, R> {
  // INSERT doesn't have where clause
  columns: (...columns: C[]) => this;
  values: (
    ...values: InsertProps<T, R, C>[]
  ) => SafeOmit<InsertQueryFactory<T, R>, 'values'>;
  execute: () => Promise<R[]>;
}

export type Conjunction = 'WHERE' | 'AND' | 'OR';

interface CompoundConditions<
  T extends TableName,
  R extends Row<T>,
  C extends StringKeys<R>,
  F extends
    | SelectQueryFactory<T, R>
    | UpdateQueryFactory<T, R>
    | DeleteQueryFactory<T, R>,
> {
  and: (column: C) => WhereConditions<T, R, C, F>;
  or: (column: C) => WhereConditions<T, R, C, F>;
}

// type FactoryWithCondition<
//   T extends TableName,
//   R extends Row<T>,
//   F extends
//     | SelectQueryFactory<T, R>
//     | UpdateQueryFactory<T, R>
//     | DeleteQueryFactory<T, R>,
// > = SafeOmit<F, 'where'> & CompoundConditions<T, R, F>;

export interface WhereConditions<
  T extends TableName,
  R extends Row<T>,
  C extends StringKeys<R>,
  F extends
    | SelectQueryFactory<T, R, C>
    | UpdateQueryFactory<T, R, C>
    | DeleteQueryFactory<T, R, C>,
> {
  eq: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  neq: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  lt: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  lte: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  gt: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  gte: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
  in: (compareValue: R[C]) => CompoundConditions<T, R, C, F>;
}

// export type WhereConditions<
//   T extends TableName,
//   R extends Row<T>,
//   C extends StringKeys<R>,
//   F extends
//     | SelectQueryFactory<T, R>
//     | UpdateQueryFactory<T, R>
//     | DeleteQueryFactory<T, R>,
// > = Record<
//   QueryComparator,
//   (compareValue: R[C]) => CompoundConditions<T, R, F>
// >;

interface JoinBuilder<
  T extends TableName,
  S extends Exclude<TableName, T>,
  R extends Row<T> = Row<T>,
  K extends StringKeys<R> = StringKeys<R>,
  SKeys extends StringKeys<TableNameToRowType[S]> = StringKeys<
    TableNameToRowType[S]
  >,
  F extends BaseQueryFactory<T, R> = BaseQueryFactory<T, R>,
> {
  on: (firstTableColumn: `${T}.${K}`, secondTableColumn: `${S}.${SKeys}`) => F;
}

export type QueryCondition<T = unknown> = (
  column: string,
  compareValue: T
) => { clause: string; compareValue: T };
