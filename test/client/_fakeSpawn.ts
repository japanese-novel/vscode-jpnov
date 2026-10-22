/**
 * A stand-in for `node:child_process.spawn` that scripts each launch's outcome: `enoent`
 * emits an error, a number exits with that code, null never exits. Unscripted commands take
 * `fallback`. Register it with `mock.module('node:child_process', { exports: { spawn } })`.
 */
import { EventEmitter } from 'node:events';

export type SpawnOutcome = 'enoent' | number | null;

export interface FakeSpawn {
  readonly spawn: (command: string, args: string[]) => EventEmitter & { unref(): void };
  /** Every spawn so far: the command and its arguments. */
  readonly spawned: { command: string; args: string[] }[];
  /** Outcome per command. */
  readonly script: Map<string, SpawnOutcome>;
  /** Outcome of a command not in `script`. */
  fallback: SpawnOutcome;
  /** How many children were `unref()`ed. */
  unrefs: number;
  /** Forgets the spawns, the script and the count; `fallback` stays. */
  reset(): void;
}

export function createFakeSpawn(fallback: SpawnOutcome = 'enoent'): FakeSpawn {
  const fake: FakeSpawn = {
    spawned: [],
    script: new Map(),
    fallback,
    unrefs: 0,
    reset() {
      fake.spawned.length = 0;
      fake.script.clear();
      fake.unrefs = 0;
    },
    spawn: (command, args) => {
      fake.spawned.push({ command, args });
      const child = Object.assign(new EventEmitter(), {
        unref: () => {
          fake.unrefs += 1;
        },
      });
      const outcome = fake.script.has(command) ? fake.script.get(command) : fake.fallback;
      queueMicrotask(() => {
        if (outcome === 'enoent') {
          child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
        } else if (typeof outcome === 'number') {
          child.emit('exit', outcome, null);
        }
      });
      return child;
    },
  };
  return fake;
}
