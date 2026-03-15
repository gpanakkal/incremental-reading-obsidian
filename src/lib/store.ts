import type { EditCoordinates, EditState } from '#/components/types';
import { EditingState } from '#/components/types';
import type { PayloadAction } from '@reduxjs/toolkit';
import { configureStore, createAction, createSlice } from '@reduxjs/toolkit';
import { enableMapSet } from 'immer';
import { type ReviewItem } from './types';

enableMapSet(); // needed to use sets with immer
export const resetSession = createAction('resetSession');

const currentItemSlice = createSlice({
  name: 'currentItem',
  initialState: null as ReviewItem | null,
  reducers: {
    setCurrentItem: (_state, action: PayloadAction<ReviewItem | null>) =>
      action.payload,
    setDismissed: (state, action: PayloadAction<boolean>) => {
      if (state === null) {
        console.error(
          `Attempted to update currentItem, but currentItem is null`
        );
        return;
      }
      state.data.dismissed = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => null);
  },
});

export const { setCurrentItem, setDismissed } = currentItemSlice.actions;

export const showAnswerSlice = createSlice({
  name: 'showAnswer',
  initialState: false,
  reducers: {
    setShowAnswer: (_, action: PayloadAction<boolean>) => action.payload,
  },
});

export const { setShowAnswer } = showAnswerSlice.actions;

// TODO: use instead of ReviewView.seenIds
const seenIdsSlice = createSlice({
  name: 'seenIds',
  initialState: new Set<string>(),
  reducers: {
    addSeenId: (state, action: PayloadAction<string>) => {
      state.add(action.payload);
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => new Set<string>());
  },
});

export const { addSeenId } = seenIdsSlice.actions;

/**
 * Flag to track when the review view is saving a file.
 * Used to prevent cache invalidation for internal modifications.
 */
const isReviewViewSavingSlice = createSlice({
  name: 'isReviewViewSaving',
  initialState: false,
  reducers: {
    setReviewViewSaving: (_state, action: PayloadAction<boolean>) =>
      action.payload,
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => false);
  },
});

export const { setReviewViewSaving } = isReviewViewSavingSlice.actions;

const editStateSlice = createSlice({
  name: 'editState',
  initialState: EditingState.cancel as EditState,
  reducers: {
    setEditState: (_state, action: PayloadAction<EditState>) => action.payload,
  },
  selectors: {
    isEditing: (editState): editState is EditCoordinates => {
      if (!editState) return false;
      if (typeof editState === 'number') return false;
      return true;
    },
  },
});

export const { setEditState } = editStateSlice.actions;
export const { isEditing } = editStateSlice.selectors;

export const store = configureStore({
  reducer: {
    currentItem: currentItemSlice.reducer,
    showAnswer: showAnswerSlice.reducer,
    seenIds: seenIdsSlice.reducer,
    isReviewViewSaving: isReviewViewSavingSlice.reducer,
    editState: editStateSlice.reducer,
  },
});

export type IRPluginState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
