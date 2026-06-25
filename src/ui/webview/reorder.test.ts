import { describe, expect, it } from 'vitest';

import { moveItem } from './reorder.js';

describe('moveItem', () => {
  it('moves an item down when the target index is later', () => {
    // Given: three ordered fallback model identifiers.
    const fallbacks = ['primary-fallback', 'second-fallback', 'third-fallback'];

    // When: the first fallback is moved into the third slot.
    const result = moveItem(fallbacks, 0, 2);

    // Then: the moved item occupies the requested slot.
    expect(result).toEqual(['second-fallback', 'third-fallback', 'primary-fallback']);
  });

  it('moves an item up when the target index is earlier', () => {
    // Given: three ordered fallback model identifiers.
    const fallbacks = ['primary-fallback', 'second-fallback', 'third-fallback'];

    // When: the last fallback is moved into the first slot.
    const result = moveItem(fallbacks, 2, 0);

    // Then: the moved item occupies the requested slot.
    expect(result).toEqual(['third-fallback', 'primary-fallback', 'second-fallback']);
  });

  it('returns the original order when the indexes match', () => {
    // Given: fallback model identifiers in a stable order.
    const fallbacks = ['primary-fallback', 'second-fallback'];

    // When: a fallback is moved to its current index.
    const result = moveItem(fallbacks, 1, 1);

    // Then: the order is unchanged.
    expect(result).toEqual(fallbacks);
  });

  it('returns the original order when indexes are out of bounds', () => {
    // Given: fallback model identifiers in a stable order.
    const fallbacks = ['primary-fallback', 'second-fallback'];

    // When: the source or target index is outside the array.
    const negativeSource = moveItem(fallbacks, -1, 1);
    const targetBeyondEnd = moveItem(fallbacks, 0, 2);

    // Then: both moves leave the order unchanged.
    expect(negativeSource).toEqual(fallbacks);
    expect(targetBeyondEnd).toEqual(fallbacks);
  });

  it('does not mutate the source array', () => {
    // Given: fallback model identifiers in a stable order.
    const fallbacks = ['primary-fallback', 'second-fallback', 'third-fallback'];

    // When: one fallback is moved.
    const result = moveItem(fallbacks, 0, 1);

    // Then: the returned array changes while the source array keeps its order.
    expect(result).toEqual(['second-fallback', 'primary-fallback', 'third-fallback']);
    expect(fallbacks).toEqual(['primary-fallback', 'second-fallback', 'third-fallback']);
  });

  it('returns the original order when indexes are invalid or null', () => {
    // Given: fallback model identifiers in a stable order.
    const fallbacks = ['primary-fallback', 'second-fallback'];

    // When: the source or target index cannot identify an array slot.
    const nullSource = moveItem(fallbacks, null, 1);
    const invalidTarget = moveItem(fallbacks, 0, Number.NaN);

    // Then: both moves leave the order unchanged.
    expect(nullSource).toEqual(fallbacks);
    expect(invalidTarget).toEqual(fallbacks);
  });
});
