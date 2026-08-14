# Contributing

## Before opening a change

- Use synthetic data only. Never commit personal media, transcripts, locations,
  account identifiers, credentials, deployment configs, or CI artifacts.
- Open an issue before a large architectural change.
- Read the root and relevant nested `AGENTS.md` files.
- Follow RED → GREEN → REFACTOR and keep wire/schema/contract changes in sync.

## Local verification

```bash
npm ci
npm run check
```

For Mage worker changes:

```bash
python3 -m venv /tmp/afterimage-mage-worker-venv
/tmp/afterimage-mage-worker-venv/bin/pip install -e 'mage-worker[test]'
/tmp/afterimage-mage-worker-venv/bin/pytest mage-worker/tests -q
```

For iOS source changes, also run a real Xcode 26 simulator build/test as
specified in `ios/AGENTS.md`. Linux checks are not a substitute for Xcode.

## Pull requests

Keep changes focused and explain intent, privacy impact, tests run, and any
migration or rollback requirements. Maintainer-controlled native/release jobs
use self-hosted infrastructure and intentionally do not execute untrusted fork
code. Include your local results; maintainers will run trusted CI after review.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
