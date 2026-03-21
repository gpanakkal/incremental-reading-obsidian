import { configureStore, createAction, createSlice } from '@reduxjs/toolkit';
import type { EditCoordinates, EditState } from '#/components/types';
import { EditingState } from '#/components/types';
import type { PayloadAction } from '@reduxjs/toolkit';

export const resetSession = createAction('resetSession');
export const resetCurrentItem = createAction('resetCurrentItem');

const currentItemIdSlice = createSlice({
  name: 'currentItemId',
  initialState: null as string | null,
  reducers: {
    setCurrentItemId: (_state, action: PayloadAction<string | null>) =>
      action.payload,
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => null);
    builder.addCase(resetCurrentItem, () => null);
  },
});

export const { setCurrentItemId } = currentItemIdSlice.actions;

export const showAnswerSlice = createSlice({
  name: 'showAnswer',
  initialState: false,
  reducers: {
    setShowAnswer: (_, action: PayloadAction<boolean>) => action.payload,
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => false);
    builder.addCase(resetCurrentItem, () => false);
  },
});

export const { setShowAnswer } = showAnswerSlice.actions;

// Track which items have been skipped
const seenIdsSlice = createSlice({
  name: 'seenIds',
  initialState: {} as Record<string, true>,
  reducers: {
    addSeenId: (state, action: PayloadAction<string>) => {
      Object.assign(state, { [action.payload]: true });
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => ({}));
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
    // could this cause a problem if resetSession() is called while reviewView is saving?
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
  extraReducers: (builder) => {
    builder.addCase(resetCurrentItem, () => EditingState.cancel);
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
    currentItemId: currentItemIdSlice.reducer,
    showAnswer: showAnswerSlice.reducer,
    seenIds: seenIdsSlice.reducer,
    isReviewViewSaving: isReviewViewSavingSlice.reducer,
    editState: editStateSlice.reducer,
  },
});

export type IRPluginState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
