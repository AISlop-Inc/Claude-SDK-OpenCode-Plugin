#!/usr/bin/env python3
"""Collect non-inference usage, then run one bounded OpenCode maintenance session."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--opencode', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--collect-only', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    directory = Path(os.environ.get('OPENCODE_CLAUDE_FEEDBACK_DIR', Path.home() / '.local/share/opencode/claude-feedback'))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    with (directory / 'daily.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Daily feedback already running', flush=True)
            return
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp = now.strftime('%Y%m%dT%H%M%S%fZ')
        snapshot = {'checkedAt': now.isoformat()}
        for key, command in [('quota', [args.node, 'dist/usage.js']), ('metrics', [args.node, 'dist/feedback.js'])]:
            try:
                result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=60, check=True)
                snapshot[key] = json.loads(result.stdout)
            except (subprocess.SubprocessError, ValueError, OSError) as error:
                # Do not persist raw SDK errors, which can contain account information.
                snapshot[key] = {'available': False, 'errorType': type(error).__name__}
        snapshot['commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
        snapshot['previousSnapshot'] = str(directory / 'latest.json') if (directory / 'latest.json').exists() else None
        if snapshot['previousSnapshot']:
            snapshot['previousSnapshot'] = str(directory / (json.loads((directory / 'latest.json').read_text())['snapshotFile']))
        snapshot['snapshotFile'] = stamp + '.json'
        path = directory / snapshot['snapshotFile']
        path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
        temporary = directory / 'latest.tmp'
        temporary.write_text(path.read_text())
        temporary.replace(directory / 'latest.json')
        print(json.dumps({'snapshot': str(path), 'collectOnly': args.collect_only}), flush=True)
        if args.collect_only:
            return
        prompt = (repo / 'scripts/feedback-prompt.txt').read_text().replace('{{SNAPSHOT}}', str(path))
        status = {'snapshot': str(path), 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        log = directory / (stamp + '-maintenance.log')
        try:
            with log.open('w') as output:
                result = subprocess.run([args.opencode, 'run', '--standalone', '--auto', '--model', args.model,
                    '--title', 'Claudeプラグイン 日次改善 ' + stamp, prompt],
                    cwd=repo, stdout=output, stderr=subprocess.STDOUT, timeout=3600)
                status['exitCode'] = result.returncode
        except (subprocess.SubprocessError, OSError) as error:
            status['errorType'] = type(error).__name__
        status['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        status['log'] = str(log)
        (directory / (stamp + '-status.json')).write_text(json.dumps(status, indent=2) + '\n')
        print(json.dumps(status), flush=True)
        if status.get('exitCode') != 0:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
