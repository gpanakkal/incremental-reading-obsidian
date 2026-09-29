import {
  type EditCoordinates,
  type EditState,
  EditingState,
} from '#/components/types';
import {
  type PayloadAction,
  configureStore,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';
import { NOTE_TYPES, type NoteType } from './types';

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

export type ReviewPage = 'home' | 'review';

export const pageSlice = createSlice({
  name: 'page',
  initialState: 'home' as ReviewPage,
  reducers: {
    setPage: (_state, action: PayloadAction<ReviewPage>) => action.payload,
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => 'home');
  },
});

export const { setPage } = pageSlice.actions;

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

// Derived from NOTE_TYPES rather than spelled out, so a fourth item type is
// reviewable the moment it exists.
const defaultTypesToReview = Object.freeze(
  Object.fromEntries(NOTE_TYPES.map((type) => [type, true]))
) as Partial<Record<NoteType, true>>;

export const typesToReviewSlice = createSlice({
  name: 'typesToReview',
  initialState: defaultTypesToReview,
  reducers: {
    setTypesToReview: (_, action: PayloadAction<readonly NoteType[]>) =>
      action.payload.reduce(
        (acc, el) => Object.assign(acc, { [el]: true }),
        {} as Partial<Record<NoteType, true>>
      ),
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => defaultTypesToReview);
  },
  selectors: {
    // Whether cards are the only item type selected for review.
    cardsOnly: (state): boolean =>
      Object.keys(state).length === 1 && 'card' in state,
  },
});

export const { setTypesToReview } = typesToReviewSlice.actions;
export const { cardsOnly } = typesToReviewSlice.selectors;

/**
 * What an expired day-scoped record reads as. One shared object rather than a
 * fresh `{}` per read: `useSelector` re-renders whenever its selector hands back
 * a new reference, so a literal here would wake every subscriber on every
 * store change once the day rolls over.
 */
const EXPIRED_RECORD = Object.freeze({});

type SeenIdsState = {
  ids: Record<string, true>;
  resetTime: number;
};

// Track which items have been skipped since last plugin launch
const seenIdsSlice = createSlice({
  name: 'seenIds',
  initialState: { ids: {}, resetTime: 0 } as SeenIdsState,
  reducers: {
    addSeenId: (
      state,
      action: PayloadAction<{ id: string; resetTime: number }>
    ) => {
      const { id, resetTime } = action.payload;
      if (Date.now() >= state.resetTime) {
        return { ids: { [id]: true }, resetTime };
      }
      state.ids[id] = true;
    },
    removeSeenId: (state, action: PayloadAction<{ id: string }>) => {
      const { id } = action.payload;
      delete state.ids[id];
    },
    resetSeenIds: (_state, action: PayloadAction<number>) => ({
      ids: {},
      resetTime: action.payload,
    }),
  },
  selectors: {
    // Returns the ids, treating them as empty if the reset time has passed.
    // Actual state reset happens lazily on the next addSeenId dispatch.
    getSeenIds: (state: SeenIdsState): Record<string, true> =>
      Date.now() >= state.resetTime ? EXPIRED_RECORD : state.ids,
  },
});

export const { addSeenId, removeSeenId, resetSeenIds } = seenIdsSlice.actions;
export const { getSeenIds } = seenIdsSlice.selectors;

type CompletedReviewsState = {
  /** The type of item each review was of, keyed by the review's database id. */
  reviews: Record<string, NoteType>;
  resetTime: number;
};

/**
 * Track the reviews finished during a session, for the summary review shows
 * once the queue runs out. Scoped like {@link getSeenIds} — reset on leaving
 * review and at rollover — so the summary's counts and its skipped list always
 * describe the same stretch of reviewing.
 *
 * Keyed by review id rather than counted, so undo can take back exactly the
 * review it reverses: a card graded "Again" comes back the same day and is
 * reviewed twice, and a count alone could not say which of the two went.
 */
export const completedReviewsSlice = createSlice({
  name: 'completedReviews',
  initialState: { reviews: {}, resetTime: 0 } as CompletedReviewsState,
  reducers: {
    addCompletedReview: (
      state,
      action: PayloadAction<{
        reviewId: string;
        type: NoteType;
        resetTime: number;
      }>
    ) => {
      const { reviewId, type, resetTime } = action.payload;
      if (Date.now() >= state.resetTime) {
        return { reviews: { [reviewId]: type }, resetTime };
      }
      // A computed key rather than assigning into the draft, which would run an
      // id of "__proto__" through the prototype setter and drop the review.
      return { ...state, reviews: { ...state.reviews, [reviewId]: type } };
    },
    removeCompletedReview: (
      state,
      action: PayloadAction<{ reviewId: string }>
    ) => {
      delete state.reviews[action.payload.reviewId];
    },
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, (state) => ({
      reviews: {},
      resetTime: state.resetTime,
    }));
  },
  selectors: {
    // Treats the reviews as empty once the reset time has passed. Actual state
    // reset happens lazily on the next addCompletedReview dispatch.
    getCompletedReviews: (
      state: CompletedReviewsState
    ): Record<string, NoteType> =>
      Date.now() >= state.resetTime ? EXPIRED_RECORD : state.reviews,
  },
});

export const { addCompletedReview, removeCompletedReview } =
  completedReviewsSlice.actions;
export const { getCompletedReviews } = completedReviewsSlice.selectors;

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

/** What a selection made in selection mode is extracted into. */
export type SelectionKind = 'snippet' | 'card';

/**
 * Selection mode: the create snippet or create card button was pressed with
 * nothing selected, so review is waiting for the user to select the text and
 * confirm. Holds which of the two it will make, or `null` outside the mode.
 *
 * Belongs to the item on screen and nothing else. Anything that takes review
 * off it — advancing, leaving for the home screen, back and forward, which go
 * through the same actions, closing the tab — ends the mode, so coming back to
 * the item finds it in the standard mode. So does revealing a card's answer,
 * which swaps the rendered question for an editor the mode was never applied
 * to.
 */
export const selectionModeSlice = createSlice({
  name: 'selectionMode',
  initialState: null as SelectionKind | null,
  reducers: {
    setSelectionMode: (_state, action: PayloadAction<SelectionKind | null>) =>
      action.payload,
  },
  extraReducers: (builder) => {
    builder.addCase(resetSession, () => null);
    builder.addCase(resetCurrentItem, () => null);
    builder.addCase(setPage, () => null);
    builder.addCase(setShowAnswer, () => null);
  },
});

export const { setSelectionMode } = selectionModeSlice.actions;

/**
 * Whether the review editor holds a non-empty selection: the one
 * `Actions.confirmSelection` reads, so the Confirm button can ask for text to
 * be selected while confirming would only say that none is.
 *
 * A mirror of the editor, which `IREditor` writes as the selection goes from
 * empty to not and back, and clears on unmounting. Nothing else resets it —
 * not even the mode ending — since the selection outlives all of that in the
 * editor, and a reset would contradict it until the next change.
 */
export const hasSelectionSlice = createSlice({
  name: 'hasSelection',
  initialState: false,
  reducers: {
    setHasSelection: (_state, action: PayloadAction<boolean>) => action.payload,
  },
});

export const { setHasSelection } = hasSelectionSlice.actions;

export const store = configureStore({
  reducer: {
    currentItemId: currentItemIdSlice.reducer,
    page: pageSlice.reducer,
    showAnswer: showAnswerSlice.reducer,
    typesToReview: typesToReviewSlice.reducer,
    seenIds: seenIdsSlice.reducer,
    completedReviews: completedReviewsSlice.reducer,
    isReviewViewSaving: isReviewViewSavingSlice.reducer,
    editState: editStateSlice.reducer,
    selectionMode: selectionModeSlice.reducer,
    hasSelection: hasSelectionSlice.reducer,
  },
});

export type IRPluginState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
