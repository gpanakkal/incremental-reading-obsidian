import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_TIMEOUT_MS, yieldToHost } from './pacing';

describe('yieldToHost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const settled = async (promise: Promise<void>) => {
    let done = false;
    void promise.then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it('waits for an idle period, or the idle timeout, where the host has them', async () => {
    const idle = vi.fn<(cb: () => void, options: object) => number>();
    vi.stubGlobal('window', { requestIdleCallback: idle });

    const yielded = yieldToHost();

    expect(await settled(yielded)).toBe(false);
    expect(idle).toHaveBeenCalledWith(expect.any(Function), {
      timeout: IDLE_TIMEOUT_MS,
    });
    idle.mock.calls[0][0]();
    expect(await settled(yielded)).toBe(true);
  });

  it('falls back to the next macrotask where the host has no idle callbacks', async () => {
    vi.useFakeTimers();
    // Node, like WebKit, has no requestIdleCallback
    vi.stubGlobal('window', globalThis);

    const yielded = yieldToHost();

    expect(await settled(yielded)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled(yielded)).toBe(true);
  });
});
