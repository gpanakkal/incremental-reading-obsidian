import { createSlice, configureStore, createAction } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { isReviewCard, type ReviewItem } from './types';
import type { EditState } from '#/components/types';
import { EditingState } from '#/components/types';
import { enableMapSet } from 'immer';

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
    setShowAnswer: (state, action: PayloadAction<boolean>) => {
      if (state === null || !isReviewCard(state)) {
        console.error(`Current item "${state?.data.reference}" is not a card`);
        return;
      }
      state.data.showAnswer = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => null);
  },
});

export const { setCurrentItem, setDismissed, setShowAnswer } =
  currentItemSlice.actions;

// TODO: use instead of ReviewView.seenIds
const seenIdsSlice = createSlice({
  name: 'seenIds',
  initialState: new Set<string>(),
  reducers: {
    addId: (state, action: PayloadAction<string>) => {
      state.add(action.payload);
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => new Set<string>());
  },
});

export const { addId } = seenIdsSlice.actions;

const editStateSlice = createSlice({
  name: 'editState',
  initialState: EditingState.cancel as EditState,
  reducers: {
    setEditState: (_state, action: PayloadAction<EditState>) => action.payload,
  },
});

export const { setEditState } = editStateSlice.actions;

export const store = configureStore({
  reducer: {
    currentItem: currentItemSlice.reducer,
    seenIds: seenIdsSlice.reducer,
    editState: editStateSlice.reducer,
  },
});

export type IRPluginState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
