import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('daily', Path(__file__).resolve().parents[1] / 'scripts/daily-feedback.py')
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


class DailyFeedbackTest(unittest.TestCase):
    def test_collection_failure_previous_snapshot_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            args = ['daily', '--node', '/node', '--opencode', '/opencode', '--model', 'openai/test', '--collect-only']
            with patch.dict(os.environ, {'OPENCODE_CLAUDE_FEEDBACK_DIR': directory}), patch('sys.argv', args), \
                    patch.object(daily.subprocess, 'check_output', return_value='abc\n'), \
                    patch.object(daily.subprocess, 'run', side_effect=[subprocess.TimeoutExpired('usage', 60),
                        subprocess.CompletedProcess([], 0, '{"observedRequests":0}')]):
                daily.main()
            first = json.loads((Path(directory) / 'latest.json').read_text())
            self.assertFalse(first['quota']['available'])
            self.assertEqual(first['metrics']['observedRequests'], 0)
            self.assertIsNone(first['previousSnapshot'])
            with patch.dict(os.environ, {'OPENCODE_CLAUDE_FEEDBACK_DIR': directory}), patch('sys.argv', args), \
                    patch.object(daily.subprocess, 'check_output', return_value='abc\n'), \
                    patch.object(daily.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}')) as run:
                daily.main()
                second = json.loads((Path(directory) / 'latest.json').read_text())
                self.assertEqual(Path(second['previousSnapshot']).name, first['snapshotFile'])
                self.assertNotEqual(first['snapshotFile'], second['snapshotFile'])
                with (Path(directory) / 'daily.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    daily.main()
                self.assertEqual(run.call_count, 2)

    def test_maintenance_failure_records_status(self):
        with tempfile.TemporaryDirectory() as directory:
            args = ['daily', '--node', '/node', '--opencode', '/opencode', '--model', 'openai/test']
            with patch.dict(os.environ, {'OPENCODE_CLAUDE_FEEDBACK_DIR': directory}), patch('sys.argv', args), \
                    patch.object(daily.subprocess, 'check_output', return_value='abc\n'), \
                    patch.object(daily.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0, '{}'),
                        subprocess.CompletedProcess([], 0, '{}'), subprocess.TimeoutExpired('opencode', 3600)]) as run:
                with self.assertRaises(SystemExit):
                    daily.main()
                self.assertIn('--standalone', run.call_args.args[0])
            status = json.loads(next(Path(directory).glob('*-status.json')).read_text())
            self.assertEqual(status['errorType'], 'TimeoutExpired')


if __name__ == '__main__':
    unittest.main()
