import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function countBrowserProcesses(stats) {
  const counts = { total: 0, zombies: 0 }
  for (const stat of stats) {
    const end = stat.lastIndexOf(')')
    const name = stat.slice(stat.indexOf('(') + 1, end)
    if (!/^(?:chromium|chrome|agent-browser)/.test(name)) continue
    counts.total++
    if (stat.slice(end + 2).startsWith('Z ')) counts.zombies++
  }
  return counts
}

export async function readCounts() {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name))
  const counts = { total: 0, zombies: 0 }
  for (let i = 0; i < pids.length; i += 32) {
    const stats = await Promise.all(
      pids.slice(i, i + 32).map(async (pid) => {
        try {
          return await readFile(`/proc/${pid}/stat`, 'utf8')
        } catch (error) {
          if (error.code === 'ENOENT') return ''
          throw error
        }
      }),
    )
    const chunk = countBrowserProcesses(stats)
    counts.total += chunk.total
    counts.zombies += chunk.zombies
  }
  return counts
}

export function evaluate(counts, health, stale, previous) {
  const limit = Math.max(128, (health?.capacity ?? 2) * 32)
  const unhealthy =
    counts.zombies >= 32 ||
    counts.total >= limit ||
    (health && health.quarantined >= health.capacity) ||
    stale
  const consecutive = unhealthy ? previous + 1 : 0
  return { consecutive, recover: consecutive >= 3, limit }
}

async function containerScope() {
  if (process.platform !== 'linux') return false
  try {
    await readFile('/.dockerenv')
    return ['tini', 'docker-init'].includes(
      (await readFile('/proc/1/comm', 'utf8')).trim(),
    )
  } catch {
    return false
  }
}

export async function supervise(args) {
  if (!args.length) throw new Error('Application entrypoint required')
  const enabled =
    process.env.MX_BROWSER_WATCHDOG !== 'false' && (await containerScope())
  const child = spawn(process.execPath, args, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, MX_BROWSER_WATCHDOG_IPC: enabled ? '1' : '0' },
  })
  let timer
  let deadline
  let stopping = false
  let checking = false
  let failed = false
  let health
  let lastHeartbeat = Date.now()
  let consecutive = 0
  const log = (message) => console.error(`[browser-watchdog] ${message}`)
  const stop = (recovery, signal = 'SIGTERM') => {
    if (stopping) return
    stopping = true
    failed = recovery
    clearInterval(timer)
    if (recovery) {
      log('Persistent failure: draining browser pool and restarting container')
      if (child.connected) child.send({ type: 'mx-browser-shutdown' }, () => {})
    } else child.kill(signal)
    deadline = setTimeout(() => {
      log('Shutdown deadline exceeded; killing application')
      child.kill('SIGKILL')
      // Exiting PID 1's child also tears down remaining container processes.
      process.exit(1)
    }, 15_000)
  }
  process.on('SIGTERM', () => stop(false))
  process.on('SIGINT', () => stop(false, 'SIGINT'))
  child.on('error', (error) => {
    log(`Application spawn failed: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    clearInterval(timer)
    clearTimeout(deadline)
    process.exit(failed ? 1 : (code ?? (signal ? 1 : 0)))
  })
  child.on('message', (message) => {
    if (
      message?.type !== 'mx-browser-health' ||
      !Number.isSafeInteger(message.capacity) ||
      message.capacity < 1 ||
      !Number.isSafeInteger(message.quarantined) ||
      message.quarantined < 0
    )
      return
    health = { capacity: message.capacity, quarantined: message.quarantined }
    lastHeartbeat = Date.now()
  })
  if (!enabled) {
    log('Monitoring disabled (opt-out or unsupported container PID 1)')
    return
  }
  log(
    'Enabled: independent process, 30s samples, 3 consecutive failures, 15s shutdown deadline',
  )
  timer = setInterval(async () => {
    if (checking || stopping) return
    checking = true
    try {
      const stale = Date.now() - lastHeartbeat > (health ? 90_000 : 180_000)
      const counts = await readCounts()
      if (stopping) return
      const decision = evaluate(counts, health, stale, consecutive)
      consecutive = decision.consecutive
      if (consecutive)
        log(
          `processes=${counts.total}/${decision.limit} zombies=${counts.zombies}/32 quarantined=${health?.quarantined ?? 0}/${health?.capacity ?? 2} heartbeatStale=${stale} consecutive=${consecutive}/3`,
        )
      if (decision.recover) stop(true)
    } catch (error) {
      consecutive = 0
      log(`Sampling failed: ${error.message}`)
    } finally {
      checking = false
    }
  }, 30_000)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await supervise(process.argv.slice(2))
}
