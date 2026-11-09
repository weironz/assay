#!/usr/bin/env python3
"""Dispatch only the explicit Taskfile operation at an exact committed source."""
import os
import re
import subprocess

from run import Pipeline, clean_source


def dispatch():
    action = os.getenv('ASSAY_ACTION', '')
    if action not in ('ci', 'publish', 'deploy'):
        raise RuntimeError('Select github:ci, github:publish or github:deploy')
    pipeline = Pipeline()
    pipeline.version_check()
    current = clean_source()
    reference = os.getenv('ASSAY_ACTIONS_REF', 'main')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]*', reference) or '..' in reference:
        raise RuntimeError('Invalid ASSAY_ACTIONS_REF')
    # GitHub requires a branch/tag workflow ref, so bind the dispatch to its
    # exact SHA as well. The runner rejects drift between dispatch and checkout.
    remote = pipeline.gh('api', f'repos/{pipeline.repository}/commits/{reference}', '--jq', '.sha', capture=True)
    if remote != current['commit']:
        raise RuntimeError('Push this commit and select the matching ASSAY_ACTIONS_REF before dispatch')
    pipeline.gh('workflow', 'run', 'ci-cd.yml', '--repo', pipeline.repository, '--ref', reference,
                '-f', 'operation=' + action, '-f', 'version=' + pipeline.version,
                '-f', 'expected_sha=' + current['commit'])
    print(f'Dispatched {action} for {current["commit"]} (v{pipeline.version}); this is not a completion receipt.')
    print(f'View runs: https://github.com/{pipeline.repository}/actions/workflows/ci-cd.yml')


if __name__ == '__main__':
    try:
        dispatch()
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error))
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode)
