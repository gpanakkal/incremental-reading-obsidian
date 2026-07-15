interface QueuePaginationProps {
  /** 0-based index of the displayed page. */
  pageNumber: number;
  pageCount: number;
  onPageChange: (pageNumber: number) => void;
}

export function QueuePagination({
  pageNumber,
  pageCount,
  onPageChange,
}: QueuePaginationProps) {
  return (
    <div className="ir-queue-pagination">
      <button
        type="button"
        className="ir-review-button"
        disabled={pageNumber <= 0}
        onClick={() => onPageChange(pageNumber - 1)}
      >
        {'<'}
      </button>
      <span className="ir-queue-pagination-indicator">
        {pageNumber + 1} of {pageCount}
      </span>
      <button
        type="button"
        className="ir-review-button"
        disabled={pageNumber >= pageCount - 1}
        onClick={() => onPageChange(pageNumber + 1)}
      >
        {'>'}
      </button>
    </div>
  );
}
