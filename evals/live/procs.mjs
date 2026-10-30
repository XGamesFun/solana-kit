// Processes a run starts, and stopping all of them: the approval server, the app the person started, and any server
// the agent left running in the project. `npx` starts its command as a child of its own, so stopping only the process
// spawned leaves the server running; each is started as the head of its own process group and stopped with it.
import { spawn } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';

/** Spawns `command` at the head of its own process group. */
export const spawnGroup = (bin, args, options) => spawn(bin, args, { ...options, detached: true });

/** Stops a process spawned with `spawnGroup` and everything it started. */
export function stopGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Stops every process whose working folder is in `dir` (Linux; elsewhere it does nothing). Returns how many. */
export function stopWithin(dir) {
  let stopped = 0;
  let pids;
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  } catch {
    return 0;
  }
  for (const pid of pids) {
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
    } catch {
      continue;
    }
    if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue;
    try {
      process.kill(Number(pid), 'SIGTERM');
      stopped++;
    } catch {
      // Already gone.
    }
  }
  return stopped;
}
