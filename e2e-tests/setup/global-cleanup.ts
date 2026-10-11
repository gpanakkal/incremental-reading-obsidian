import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Kills Electron processes that earlier e2e runs left behind.
 *
 * Electron exits by itself once the worker that launched it dies (see
 * `exitWhenOwnerDies` in ./helpers.ts), but only once that watchdog is in. A
 * worker killed while Electron is still booting, or an Electron whose main
 * process is wedged, still leaks one: an Obsidian with no window on screen that
 * holds its vault and checkout open until someone kills it, which blocks
 * deleting the worktree it ran in.
 *
 * Runs as both global setup and global teardown. Only orphans are touched — an
 * Electron whose launching worker is still alive belongs to a run in progress,
 * possibly another agent's in the same checkout — so this is safe to run at any
 * time. Matches test vaults in any checkout, not just this one, since the
 * leftovers that matter most are the ones in worktrees nobody is running.
 */
export default function globalCleanup() {
  const orphans = findOrphanedElectrons();
  if (orphans.length === 0) return;
  for (const orphan of orphans) killTree(orphan.pid);
  console.log(
    `[e2e] Killed ${orphans.length} orphaned Electron process(es) left by an ` +
      `earlier run: ${orphans.map((o) => o.pid).join(', ')}`
  );
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  /** Start time in an arbitrary monotonic unit; 0 where the OS won't say. */
  started: number;
  args: string;
}

/** Every test launch passes `--user-data-dir` inside its vault copy. */
const VAULTS_SEGMENT = path.join('e2e-tests', 'test-vaults');

export function findOrphanedElectrons() {
  const processes = listProcesses();
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return processes.filter(
    (p) => isTestElectronMain(p) && !hasLiveOwner(p, byPid)
  );
}

function isTestElectronMain({ args }: ProcessInfo) {
  const haystack = process.platform === 'win32' ? args.toLowerCase() : args;
  const needle =
    process.platform === 'win32'
      ? VAULTS_SEGMENT.toLowerCase()
      : VAULTS_SEGMENT;
  // Renderer, GPU, and utility children carry the same `--user-data-dir` but
  // also `--type=`; the tree kill on the main process takes them down.
  return (
    haystack.includes('--user-data-dir=') &&
    haystack.includes(needle) &&
    !haystack.includes('--type=')
  );
}

/**
 * Whether the Node process that launched this Electron is still running.
 *
 * On Windows Playwright launches through `cmd.exe`, so the owner is the shell's
 * parent. A parent that started after its child is a stranger that inherited a
 * recycled PID, not the owner.
 */
function hasLiveOwner(child: ProcessInfo, byPid: Map<number, ProcessInfo>) {
  let current = child;
  let owner = byPid.get(current.ppid);
  if (owner && isOlder(owner, current) && /^cmd(\.exe)?$/i.test(owner.name)) {
    current = owner;
    owner = byPid.get(current.ppid);
  }
  return (
    !!owner && isOlder(owner, current) && /^node(\.exe)?$/i.test(owner.name)
  );
}

function isOlder(parent: ProcessInfo, child: ProcessInfo) {
  return !parent.started || !child.started || parent.started <= child.started;
}

function listProcesses(): ProcessInfo[] {
  return process.platform === 'win32'
    ? listWindowsProcesses()
    : listPosixProcesses();
}

function listWindowsProcesses(): ProcessInfo[] {
  // Command lines only for candidates: the full set runs to megabytes.
  const script = `
    Get-CimInstance Win32_Process | ForEach-Object {
      [pscustomobject]@{
        pid = $_.ProcessId
        ppid = $_.ParentProcessId
        name = $_.Name
        started = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
        args = if ($_.CommandLine -like '*test-vaults*') { $_.CommandLine } else { '' }
      }
    } | ConvertTo-Json -Compress`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  try {
    return [JSON.parse(result.stdout) as ProcessInfo | ProcessInfo[]].flat();
  } catch {
    // Not worth failing a run over; the next one tries again.
    return [];
  }
}

function listPosixProcesses(): ProcessInfo[] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (result.stdout ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const [, pid, ppid, args] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    const executable = args.split(' ')[0] ?? '';
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        name: path.basename(executable),
        started: 0,
        args,
      },
    ];
  });
}

function killTree(pid: number) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // Playwright spawns Electron detached on POSIX, making it a group leader.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Already gone.
  }
}
