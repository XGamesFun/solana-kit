// A call that must answer and not loop, for the tests of what bounds a tool's work: a scenario of a million days, or
// 95 prices that each move a lamport a sale, would hold every tool for minutes if nothing capped the walk.
import assert from 'node:assert/strict';

/**
 * What one such call may take, in milliseconds of this process's own CPU time: a second on a laptop, five on a slow CI
 * runner, and ten times as much in a run that measures coverage, whose instrumented loops are about eight times
 * slower. CPU time, not the clock on the wall, so a machine busy with other work does not fail a call that is fine.
 */
export const ROOM_MS = (process.env.CI ? 5000 : 1000) * (process.env.NODE_V8_COVERAGE ? 10 : 1);

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** Runs `run` and returns its answer, or fails when it took more than its room (`rooms` of it for a heavier call). */
export async function quick(what, run, rooms = 1) {
  const from = cpuMs();
  const out = await run();
  const took = Math.round(cpuMs() - from);
  assert.ok(took < ROOM_MS * rooms, `${what} took ${took} ms of CPU, more than the ${ROOM_MS * rooms} ms it is given`);
  return out;
}
