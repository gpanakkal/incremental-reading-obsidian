import type { StringKeys } from 'src/lib/utility-types';
import type { Row } from '../QueryComposer.types';
import type { SQLiteRepository } from '../../repository';
import type { TableName } from '../../types';
import Query from './Query';

export default class InsertQuery<
  T extends TableName,
  R extends Row<T> = Row<T>,
  C extends StringKeys<R> = StringKeys<R>,
> extends Query<T, R, C> {}
