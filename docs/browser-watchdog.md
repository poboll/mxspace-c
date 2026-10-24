# Container browser watchdog

The production image runs `tini → watchdog → Node application`. The watchdog is
an independent Node process using only built-in modules. It reads `/proc` even
when the application's event loop is blocked. The application sends pool health
and a heartbeat over private parent-child IPC; it does not decide when to restart.
No Docker socket, host mount or privileged container is required.

The default entrypoint starts the supervisor after migrations. Explicit command
overrides (such as `node migrate.mjs` or a shell) bypass it. Monitoring requires
Linux, `/.dockerenv`, and PID 1 named `tini` or `docker-init`; do not use a host PID
namespace. Set `MX_BROWSER_WATCHDOG=false` to disable monitoring.

Every 30 seconds the supervisor checks:

- Browser zombies: unhealthy at 32 or more.
- Total browser processes: unhealthy at `max(128, pool capacity × 32)` or more.
- Pool health: unhealthy when every slot is quarantined.
- Application heartbeat: unhealthy after 90 seconds without a report. The first
  report has a 180-second startup allowance after migrations finish.

Three consecutive unhealthy samples trigger recovery. A healthy sample resets
the counter. Read errors are logged and reset the counter; processes disappearing
while `/proc` is read are ignored. Chromium, Chrome/crashpad and agent-browser
processes are counted in the container PID namespace. Logs contain counts and
recovery decisions, not page content or command arguments.

On recovery, the supervisor sends an IPC drain request. A responsive application
rejects new browser acquisitions, closes the pool, then exits. If the application
is blocked, the supervisor sends SIGKILL after 15 seconds and exits with status 1.
Tini then exits and the container runtime tears down remaining child processes.
A Docker/Swarm restart policy must be enabled; the supplied Compose files already
use `unless-stopped`. Ordinary Docker stop signals are forwarded to the application.

Recovery briefly interrupts API requests in the same container. The watchdog does
not delete database or queue state; abandoned fetch leases expire naturally.
Repeated recoveries require investigation or switching Open Graph to HTTP mode.
The watchdog supplements the session pool, persistent failure cooldown, tini and
core/log size limits; it does not repair the underlying Chromium failure. Host
failure or a hung supervisor still requires supervision outside the container.
