/**
 * Raises a TS error if any of the passed keys aren't on T
 */
export type SafeOmit<T, Keys extends keyof T> = {
  [P in keyof T as P extends Keys ? never : P]: T[P];
};

export type Primitive = string | number | boolean | symbol | undefined | null;

export type SQLitePrimitive = string | number | null;

export type StringRecord<T> = Record<string, T>;

export type StringKeys<T extends Record<string | number | symbol, unknown>> =
  Extract<keyof T, string>;

export type NullishToOptional<T> = {
  [P in keyof T as T[P] extends null | undefined ? never : P]: T[P];
} & {
  [P in keyof T as T[P] extends null | undefined ? P : never]?: T[P];
};

/**
 * Improves hints for types generated via helpers
 */
export type Resolve<T> = T extends (...args: never) => unknown
  ? T
  : { [P in keyof T]: T[P] };
