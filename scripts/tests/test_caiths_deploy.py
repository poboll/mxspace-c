import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


class ControlledDeployTest(unittest.TestCase):
    def run_case(self, failure='', missing=False):
        self.temp = tempfile.TemporaryDirectory(prefix='caiths-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        app = root / 'core-v15'
        app.mkdir()
        (app / 'main.mjs').write_text('old')
        (app / 'ecosystem.config.cjs').write_text('module.exports={apps:[]}')
        script = Path(__file__).resolve().parents[1] / 'caiths-controlled-deploy.sh'
        shutil.copy(script, root)
        (root / 'caiths-db-snapshot.mjs').write_text('// fixture only')
        archive = root / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for file in ['main.mjs', 'migrate.mjs', 'src/database/migrations/meta/_journal.json',
                         'node_modules/ws/package.json', 'node_modules/sharp/package.json',
                         'node_modules/loro-crdt/package.json']:
                if not (missing and file.endswith('loro-crdt/package.json')):
                    z.writestr(file, 'new')
        binary = root / 'bin'
        binary.mkdir()
        mock = '''#!/usr/bin/env python3
import os,sys,pathlib
r=pathlib.Path(os.environ['TEST_ROOT']); c=pathlib.Path(sys.argv[0]).name
a=sys.argv[1:]; fail=os.environ.get('TEST_FAIL','')
with (r/'calls').open('a') as f:f.write(c+' '+ ' '.join(a)+'\\n')
if c=='flock': sys.exit(1 if fail=='lock' else 0)
if c=='node':
    action=a[1]
    if action=='prepare' and fail=='prepare':sys.exit(1)
    if action=='migrate' and fail=='migrate':sys.exit(1)
    if action=='rollback' and fail=='rollback':sys.exit(1)
if c=='pm2' and a[0]=='start':
    new=(r/'core-v15'/'main.mjs').read_text()=='new'
    if new and fail in ['start','rollback']:sys.exit(1)
if c=='curl':
    new=(r/'core-v15'/'main.mjs').read_text()=='new'
    if new and fail=='health':sys.exit(1)
sys.exit(0)
'''
        # Linux CI has a real /usr/local/node26 only on production, never fixture data.
        for name in ['node', 'pm2', 'curl', 'sleep', 'flock']:
            (binary / name).write_text(mock)
            (binary / name).chmod(0o755)
        env = {**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH'],
               'TEST_ROOT': str(root), 'TEST_FAIL': failure,
               'MX_SPACE_INSTALL_DIR': str(root), 'MX_SPACE_APP_DIR': str(app)}
        result = subprocess.run(['bash', str(root / script.name), str(archive)], env=env,
                                text=True, capture_output=True, timeout=15)
        calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
        return root, result, calls

    def test_success_retains_program_and_recovery(self):
        root, result, calls = self.run_case()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((root / 'core-v15/main.mjs').read_text(), 'new')
        self.assertEqual(len(list(root.glob('core-v15.backup-*'))), 1)
        self.assertIn('prepare', calls)
        self.assertNotIn('rollback', calls)
        self.assertEqual(next(root.glob('recovery-*')).stat().st_mode & 0o777, 0o700)

    def test_missing_runtime_rejected_before_stop(self):
        _, result, calls = self.run_case(missing=True)
        self.assertEqual(result.returncode, 65)
        self.assertNotIn('pm2 stop', calls)

    def test_lock_conflict_rejected(self):
        _, result, calls = self.run_case('lock')
        self.assertEqual(result.returncode, 75)
        self.assertNotIn('pm2 stop', calls)

    def test_prepare_failure_reopens_old_without_db_swap(self):
        root, result, calls = self.run_case('prepare')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('rollback', calls)
        self.assertEqual((root / 'core-v15/main.mjs').read_text(), 'old')
        self.assertIn('old database/program restored and healthy', result.stdout)

    def test_migration_failure_restores_database_before_restart(self):
        root, result, calls = self.run_case('migrate')
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(calls.index('rollback'), calls.index('pm2 start'))
        self.assertEqual((root / 'core-v15/main.mjs').read_text(), 'old')

    def test_start_failure_restores_database_and_program(self):
        root, result, calls = self.run_case('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('rollback', calls)
        self.assertEqual((root / 'core-v15/main.mjs').read_text(), 'old')

    def test_health_failure_triggers_exit_recovery(self):
        root, result, calls = self.run_case('health')
        self.assertEqual(result.returncode, 70)
        self.assertIn('rollback', calls)
        self.assertEqual((root / 'core-v15/main.mjs').read_text(), 'old')

    def test_restore_failure_never_restarts_old_against_new_db(self):
        _, result, calls = self.run_case('rollback')
        self.assertEqual(result.returncode, 71)
        self.assertNotIn('pm2 start', calls[calls.index('rollback'):])
        self.assertIn('app left STOPPED', result.stdout)


if __name__ == '__main__':
    unittest.main()
