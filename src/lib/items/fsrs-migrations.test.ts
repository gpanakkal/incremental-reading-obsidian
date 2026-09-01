import { fsrs, generatorParameters } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

const FSRS_5_DEFAULT_WEIGHTS = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898,
]);

describe('FSRS-5 to 6 weight migrations', () => {
  // see https://github.com/open-spaced-repetition/ts-fsrs/issues/485#issuecomment-5447972074
  it.fails('clamp w[19] to 0.01 when short-term scheduling is on', () => {
    const converted = generatorParameters({
      w: FSRS_5_DEFAULT_WEIGHTS,
    });

    const convertedShortTerm = generatorParameters({
      enable_short_term: true,
      w: FSRS_5_DEFAULT_WEIGHTS,
    });

    const reconverted = generatorParameters(convertedShortTerm);

    const fromFsrs = fsrs({
      enable_short_term: true,
      w: FSRS_5_DEFAULT_WEIGHTS,
    });

    console.log({
      converted,
      convertedShortTerm,
      reconverted,
      fromFsrs: fromFsrs.parameters.w,
    });

    expect(converted.w[19]).toBe(0);
    expect(convertedShortTerm.w[19]).not.toBe(0);
  });

  it.fails('reset w[19] to 0 when short-term scheduling is turned off', () => {
    const convertedShortTerm = fsrs(
      generatorParameters({
        enable_short_term: true,
        w: FSRS_5_DEFAULT_WEIGHTS,
      })
    ).parameters;

    const reconverted = fsrs({
      ...convertedShortTerm,
      enable_short_term: false,
    }).parameters;

    console.log({
      convertedShortTerm,
      reconverted,
    });

    expect(reconverted.w[19]).toBe(0);
  });
});
