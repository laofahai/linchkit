import { describe, expect, test } from 'bun:test';
import { createSignalBus } from '../signal-bus';
import type { SensorSignal } from '../../types/life-system';

function makeSignal(value = 1): SensorSignal {
  return {
    sensor: 'test-sensor',
    source: 'api',
    timestamp: new Date(),
    value,
    baseline: 1,
    deviation: 0,
    confidence: 1,
    context: {},
  };
}

describe('SignalBus', () => {
  test('subscribe receives emitted signals', () => {
    const bus = createSignalBus();
    const received: SensorSignal[] = [];
    bus.subscribe(s => { received.push(s); });
    const sig = makeSignal(42);
    bus.emit(sig);
    expect(received).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(received[0]!.value).toBe(42);
  });

  test('unsubscribe stops receiving signals', () => {
    const bus = createSignalBus();
    const received: SensorSignal[] = [];
    const unsub = bus.subscribe(s => { received.push(s); });
    bus.emit(makeSignal(1));
    unsub();
    bus.emit(makeSignal(2));
    expect(received).toHaveLength(1);
  });

  test('multiple subscribers all receive signals', () => {
    const bus = createSignalBus();
    const a: number[] = [];
    const b: number[] = [];
    bus.subscribe(s => { a.push(s.value); });
    bus.subscribe(s => { b.push(s.value); });
    bus.emit(makeSignal(7));
    expect(a).toEqual([7]);
    expect(b).toEqual([7]);
  });
});
