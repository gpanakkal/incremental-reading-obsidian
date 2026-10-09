import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TITLE_CHARS, INVALID_TITLE_MESSAGE } from './constants';

describe('INVALID_TITLE_MESSAGE', () => {
  it('lists every forbidden title character, each set apart from the next', () => {
    const list = INVALID_TITLE_MESSAGE.slice(
      INVALID_TITLE_MESSAGE.indexOf(': ') + ': '.length
    );
    expect(list.split(' ')).toEqual([...FORBIDDEN_TITLE_CHARS]);
  });

  it('says it is about the names of IR files', () => {
    expect(INVALID_TITLE_MESSAGE).toMatch(/^IR file names cannot contain/);
  });
});
