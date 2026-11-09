#!/usr/bin/env python3
"""Validate a trusted workflow dispatch before giving it credentials."""
import os
from pathlib import Path
import re
import subprocess

from run import ROOT


def check():
    sha = os.getenv('EXPECTED_SHA', '')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch('[0-9a-f]{40}', sha) or sha != actual:
        raise RuntimeError('Workflow checkout differs from the explicitly selected commit')
    version = os.getenv('RELEASE_VERSION', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise RuntimeError('RELEASE_VERSION must be X.Y.Z')
    from run import Pipeline
    os.environ['LOCAL_CI_VERSION'] = version
    location = os.getenv('LOCAL_CI_STATE_DIR', '')
    state = Path(location).expanduser().resolve()
    if not location or not Path(location).is_absolute() or state == ROOT or ROOT in state.parents or state == Path('/'):
        raise RuntimeError('Set ASSAY_CI_STATE_DIR to a private persistent absolute directory outside checkout')
    ref = os.getenv('GITHUB_REF', '')
    if ref not in ('refs/heads/main', 'refs/tags/v' + version):
        raise RuntimeError('Release workflows accept only main or the exact release tag')
    Pipeline().version_check()


if __name__ == '__main__':
    try:
        check()
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error))
