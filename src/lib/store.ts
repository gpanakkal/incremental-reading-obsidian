import type { EditCoordinates, EditState } from '#/components/types';
import { EditingState } from '#/components/types';
import type { PayloadAction } from '@reduxjs/toolkit';
import { configureStore, createAction, createSlice } from '@reduxjs/toolkit';

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

type SeenIdsState = {
  ids: Record<string, true>;
  resetTime: number;
};

// Track which items have been skipped during a session, resetting at rollover
const seenIdsSlice = createSlice({
  name: 'seenIds',
  initialState: { ids: {}, resetTime: 0 } as SeenIdsState,
  reducers: {
    addSeenId: (state, action: PayloadAction<{ id: string; resetTime: number }>) => {
      const { id, resetTime } = action.payload;
      if (Date.now() >= state.resetTime) {
        return { ids: { [id]: true }, resetTime };
      }
      state.ids[id] = true;
    },
    resetSeenIds: (_state, action: PayloadAction<number>) => ({
      ids: {},
      resetTime: action.payload,
    }),
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, (state) => ({ ids: {}, resetTime: state.resetTime }));
  },
  selectors: {
    // Returns the ids, treating them as empty if the reset time has passed.
    // Actual state reset happens lazily on the next addSeenId dispatch.
    getSeenIds: (state: SeenIdsState): Record<string, true> =>
      Date.now() >= state.resetTime ? {} : state.ids,
  },
});

export const { addSeenId, resetSeenIds } = seenIdsSlice.actions;
export const { getSeenIds } = seenIdsSlice.selectors;

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
