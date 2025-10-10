import type { getMarkdownController } from './helpers';

export interface EditCoordinates {
  x: number;
  y: number;
}

export enum EditingState {
  cancel,
  complete,
}

export type EditState = EditCoordinates | EditingState;

export type MarkdownController = ReturnType<typeof getMarkdownController>;
