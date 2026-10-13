import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEmitter } from './emitter';

describe('createEmitter', () => {
  it('property: calls each listener subscribed and not since unsubscribed, once per emit, in the order subscribed', () => {
    fc.assert(
      fc.property(
        // Per subscription: which listener (several can share one), and whether
        // it unsubscribes before the emits
        fc.array(fc.tuple(fc.nat({ max: 3 }), fc.boolean()), {
          maxLength: 6,
        }),
        fc.nat({ max: 3 }),
        (subscriptions, emits) => {
          const emitter = createEmitter();
          const heard: number[] = [];
          const listeners = [0, 1, 2, 3].map((id) => () => {
            heard.push(id);
          });
          // A listener is in once however often it subscribes, in the order
          // it first did; an unsubscribe takes it out whichever subscription
          // it came from
          const expected = new Set<number>();
          for (const [id, unsubscribes] of subscriptions) {
            const unsubscribe = emitter.subscribe(listeners[id]);
            expected.add(id);
            if (unsubscribes) {
              expect(unsubscribe()).toBeUndefined();
              expected.delete(id);
            }
          }

          for (let i = 0; i < emits; i++) emitter.emit();

          expect(heard).toEqual(
            Array.from({ length: emits }, () => [...expected]).flat()
          );
        }
      )
    );
  });
});
