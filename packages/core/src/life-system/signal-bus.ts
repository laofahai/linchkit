import type { SensorSignal, SignalBus } from '../types/life-system';

export function createSignalBus(): SignalBus {
  const listeners: Array<(signal: SensorSignal) => void> = [];

  return {
    emit(signal: SensorSignal): void {
      for (const listener of listeners) {
        listener(signal);
      }
    },
    subscribe(listener: (signal: SensorSignal) => void): () => void {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
  };
}
