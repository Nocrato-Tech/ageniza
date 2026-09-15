import type { MaybePromise } from './types.js';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';
export type ShutdownHandler = (signal?: ShutdownSignal) => MaybePromise<void>;
export interface ShutdownFailure { name: string; error: unknown; }
export interface ShutdownResult { signal?: ShutdownSignal; failures: readonly ShutdownFailure[]; }
export interface ShutdownManager {
  add(name: string, handler: ShutdownHandler): () => void;
  run(signal?: ShutdownSignal): Promise<ShutdownResult>;
}

interface ShutdownRegistration { name: string; handler: ShutdownHandler; }

/** Creates a LIFO shutdown registry. Every registered handler runs even when one fails. */
export const createShutdownManager = (): ShutdownManager => {
  const registrations: ShutdownRegistration[] = [];
  let running: Promise<ShutdownResult> | undefined;
  return {
    add(name, handler) {
      if (running !== undefined) throw new Error('Cannot register a shutdown handler while shutdown is running');
      const registration = { name, handler };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    run(signal) {
      running ??= (async () => {
        const failures: ShutdownFailure[] = [];
        for (const registration of [...registrations].reverse()) {
          try {
            await registration.handler(signal);
          } catch (error) {
            failures.push({ name: registration.name, error });
          }
        }
        return { signal, failures };
      })();
      return running;
    }
  };
};

export interface SignalProcess {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}
export interface ShutdownSignalOptions {
  process?: SignalProcess;
  signals?: readonly ShutdownSignal[];
  onFailure?: (result: ShutdownResult) => void;
}

/** Registers signal listeners and returns an explicit unregister function. */
export const registerShutdownSignals = (manager: ShutdownManager, options: ShutdownSignalOptions = {}): (() => void) => {
  const processRef = options.process ?? process;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      void manager.run(signal).then((result) => {
        if (result.failures.length > 0) options.onFailure?.(result);
      });
    };
    processRef.on(signal, listener);
    return { signal, listener };
  });
  return () => { for (const { signal, listener } of listeners) processRef.off(signal, listener); };
};
