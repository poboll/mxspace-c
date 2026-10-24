export const AGENT_BROWSER_DEFAULT_EXECUTABLE =
  process.env.AGENT_BROWSER_BIN || 'agent-browser'

export const AGENT_BROWSER_DEFAULT_MAX_SIZE = Number(
  process.env.AGENT_BROWSER_MAX_CONCURRENT ?? '2',
)

export const AGENT_BROWSER_DEFAULT_IDLE_MS = Number(
  process.env.AGENT_BROWSER_IDLE_MS ?? '60000',
)

export const AGENT_BROWSER_DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

export const AGENT_BROWSER_DEFAULT_ACCEPT_LANGUAGE =
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'

export const AGENT_BROWSER_DEFAULT_LAUNCH_ARGS =
  '--disable-blink-features=AutomationControlled'

export const AGENT_BROWSER_DEFAULT_NETWORKIDLE_MS = 10_000

export const AGENT_BROWSER_CLOSE_TIMEOUT_MS = 5_000

/** execFile errors embed command arguments and stderr; do not log them verbatim. */
export function describeAgentBrowserError(error: unknown): string {
  const err = error as { code?: unknown; signal?: unknown; killed?: unknown }
  const token = (value: unknown) =>
    String(value ?? 'unknown')
      .replaceAll(/[^\w-]/g, '')
      .slice(0, 32)
  return `code=${token(err?.code)} signal=${token(err?.signal)} killed=${err?.killed === true}`
}
