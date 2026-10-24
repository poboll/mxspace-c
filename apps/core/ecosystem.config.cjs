// mx-server pm2 配置（Caiths Safe Deploy 与服务器手动启动共用）。
// 部署布局约定：release zip 解压后 main.mjs 位于应用目录根（zip-asset 从 out/ 打包），
// 依赖与运行时变量分别来自共享 node_modules 软链与 mx-server.env.json。
const fs = require('node:fs')

const runtimeEnvPath =
  process.env.MX_SPACE_RUNTIME_ENV_FILE || '/root/mx-space/mx-server.env.json'
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
      // pm2 守护进程跑在系统 node22 上，必须写死 node26 绝对路径执行 v15 bundle。
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
        SNOWFLAKE_WORKER_ID: String(runtimeEnv.SNOWFLAKE_WORKER_ID || 1),
      },
    },
  ],
}
