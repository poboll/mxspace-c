// Deployment-only recovery helper. Child output and credentials never leave this process.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

const [action, appDirectory, recoveryDirectory] = process.argv.slice(2)
if (!['prepare', 'rollback', 'migrate'].includes(action) || !path.isAbsolute(appDirectory || '') || !path.isAbsolute(recoveryDirectory || '')) throw new Error('absolute app and recovery paths required')
process.umask(0o077)
const cfg = createRequire(import.meta.url)(path.join(appDirectory, action === 'rollback' ? 'recovery-connection.cjs' : 'ecosystem.config.cjs'))
const app = cfg.apps.find(x => x.name === (process.env.MX_SPACE_PM2_APP_NAME || 'mx-server'))
if (!app?.env) throw new Error('runtime environment unavailable')
const e = Object.fromEntries(Object.entries(app.env).map(([k, v]) => [k, String(v)]))
if (e.PG_URL || e.PG_CONNECTION_STRING || e.MX_MIGRATE_SECRETS === '1' || /^(1|true)$/i.test(e.MX_SECRET_STORAGE_V2 || '')) throw new Error('connection URL / v2 secret migration requires separate reviewed recovery plan')
const database = e.PG_DATABASE
if (!database || !e.PG_USER || !e.PG_PASSWORD) throw new Error('explicit PG database/user/password required')
const base = ['-h', e.PG_HOST || '127.0.0.1', '-p', e.PG_PORT || '5432', '-U', e.PG_USER]
const env = { ...process.env, ...e, PGPASSWORD: e.PG_PASSWORD, PGCONNECT_TIMEOUT: '10' }
const qi = s => '"' + s.replaceAll('"', '""') + '"'
const ql = s => "'" + s.replaceAll("'", "''") + "'"
const run = (cmd, args, extra = {}) => execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra })
const sql = (db, query) => run('psql', [...base, '-d', db, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim()
// Keep the application role unprivileged: DB creation/switching is root's local
// postgres peer-auth task, never a permanent CREATEDB grant to the CMS role.
const admin = query => {
  if (!['127.0.0.1', 'localhost'].includes(e.PG_HOST || '127.0.0.1')) throw new Error('local PostgreSQL required for peer recovery')
  return run('runuser', ['-u', 'postgres', '--', 'psql', '-p', e.PG_PORT || '5432', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim()
}
const dump = path.join(recoveryDirectory, 'database.dump')
const manifestPath = path.join(recoveryDirectory, 'database-recovery.json')
const digest = () => createHash('sha256').update(fs.readFileSync(dump)).digest('hex')
const counts = db => JSON.parse(sql(db, "SELECT json_build_object('posts',(SELECT count(*) FROM posts),'notes',(SELECT count(*) FROM notes),'pages',(SELECT count(*) FROM pages),'agentConversations',(SELECT count(*) FROM ai_agent_conversations))"))
try {
  if (action === 'migrate') {
    const fd = fs.openSync(path.join(recoveryDirectory, 'migration.log'), 'wx', 0o600)
    try {
      run(process.execPath, ['migrate.mjs'], { cwd: appDirectory, env: { ...env, MIGRATIONS_DIR: path.join(appDirectory, 'src/database/migrations') }, stdio: ['ignore', fd, fd] })
    } finally { fs.closeSync(fd) }
    console.log('migration_completed')
  } else if (action === 'prepare') {
    if (fs.existsSync(dump) || fs.existsSync(manifestPath)) throw new Error('recovery materials already exist')
    const meta = JSON.parse(sql(database, "SELECT json_build_object('owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'user',current_user) FROM pg_database WHERE datname=current_database()"))
    if (meta.provider !== 'c' || meta.owner !== meta.user) throw new Error('unsupported locale provider or non-owner connection')
    const before = counts(database)
    if (before.agentConversations !== 0) throw new Error('nonempty legacy conversations: destructive migration refused')
    fs.writeFileSync(path.join(recoveryDirectory, 'runtime-env.snapshot.json'), JSON.stringify(e), { mode: 0o600, flag: 'wx' })
    fs.writeFileSync(path.join(recoveryDirectory, 'recovery-connection.cjs'), "module.exports={apps:[{name:" + JSON.stringify(app.name) + ",env:require('./runtime-env.snapshot.json')}]};\n", { mode: 0o600, flag: 'wx' })
    run('pg_dump', [...base, '-d', database, '-Fc', '-f', dump])
    fs.chmodSync(dump, 0o600)
    run('pg_restore', ['--list', dump])
    const suffix = randomBytes(6).toString('hex')
    const restoreDatabase = database.slice(0, 30) + '_restore_' + suffix
    const failedDatabase = database.slice(0, 30) + '_failed_' + suffix
    admin(`CREATE DATABASE ${qi(restoreDatabase)} WITH TEMPLATE template0 OWNER ${qi(meta.owner)} ENCODING ${ql(meta.encoding)} LC_COLLATE ${ql(meta.collate)} LC_CTYPE ${ql(meta.ctype)}`)
    run('pg_restore', [...base, '-d', restoreDatabase, '--exit-on-error', '--single-transaction', dump])
    if (JSON.stringify(counts(restoreDatabase)) !== JSON.stringify(before)) throw new Error('restored counts differ')
    fs.writeFileSync(manifestPath, JSON.stringify({ database, restoreDatabase, failedDatabase, digest: digest(), counts: before, restored: true }, null, 2), { mode: 0o600, flag: 'wx' })
    console.log('database_backup_and_restore_verified')
  } else {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (m.database !== database || !m.restored || m.digest !== digest()) throw new Error('recovery verification failed')
    if (admin(`SELECT count(*) FROM pg_database WHERE datname=${ql(m.failedDatabase)}`) !== '0') throw new Error('rollback already started')
    for (const db of [database, m.restoreDatabase]) {
      admin(`ALTER DATABASE ${qi(db)} WITH ALLOW_CONNECTIONS false`)
      admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${ql(db)} AND pid<>pg_backend_pid()`)
    }
    admin(`ALTER DATABASE ${qi(database)} RENAME TO ${qi(m.failedDatabase)}`)
    try { admin(`ALTER DATABASE ${qi(m.restoreDatabase)} RENAME TO ${qi(database)}`) }
    catch (err) {
      admin(`ALTER DATABASE ${qi(m.failedDatabase)} RENAME TO ${qi(database)}`)
      admin(`ALTER DATABASE ${qi(database)} WITH ALLOW_CONNECTIONS true`)
      throw err
    }
    admin(`ALTER DATABASE ${qi(database)} WITH ALLOW_CONNECTIONS true`)
    if (JSON.stringify(counts(database)) !== JSON.stringify(m.counts)) throw new Error('rollback counts differ')
    fs.writeFileSync(path.join(recoveryDirectory, 'database-rollback-complete'), new Date().toISOString(), { mode: 0o600, flag: 'wx' })
    console.log('database_rollback_verified')
  }
} catch {
  console.error(`database_${action}_failed; inspect private recovery materials`)
  process.exitCode = 1
}
