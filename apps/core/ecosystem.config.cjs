const fs = require('node:fs')
const { execSync } = require('node:child_process')

const nodePath = execSync('npm root --quiet -g', {
  encoding: 'utf-8',
}).split('\n')[0]
const runtimeEnvPath =
  process.env.MX_SPACE_RUNTIME_ENV_FILE ||
  '/root/mx-space/mx-server.env.json'

if (!fs.existsSync(runtimeEnvPath)) {
  throw new Error(`MX Space runtime env is missing: ${runtimeEnvPath}`)
}

const runtimeEnv = JSON.parse(fs.readFileSync(runtimeEnvPath, 'utf8'))
const requiredEnv = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_DATABASE',
  'PORT',
  'MX_ENCRYPT_KEY',
]

for (const key of requiredEnv) {
  if (!runtimeEnv[key]) {
    throw new Error(`MX Space runtime env is missing key: ${key}`)
  }
}

module.exports = {
  apps: [
    {
      name: 'mx-server',
      // Execute Node directly so main.mjs remains process.argv[1]. The MX Space
      // release intentionally skips startMain() when it is only imported by a
      // process-manager wrapper.
      script: '/usr/local/node26/bin/node',
      interpreter: 'none',
      cwd: '/root/mx-space/core-v15',
      autorestart: true,
      exec_mode: 'fork',
      watch: false,
      instances: 1,
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      kill_timeout: 10000,
      max_memory_restart: '450M',
      args: [
        '--max-old-space-size=320',
        './main.mjs',
        '--color',
        '--encrypt_enable',
        '--snowflake_worker_id',
        String(runtimeEnv.SNOWFLAKE_WORKER_ID || 1),
      ],
      out_file: '/root/.mx-space/log/pm2-out.log',
      error_file: '/root/.mx-space/log/pm2-error.log',
      merge_logs: true,
      time: true,
      env: {
        ...runtimeEnv,
        NODE_ENV: 'production',
        NODE_PATH: nodePath,
        SNOWFLAKE_WORKER_ID: String(runtimeEnv.SNOWFLAKE_WORKER_ID || 1),
      },
    },
  ],
}
