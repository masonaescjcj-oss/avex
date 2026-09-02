import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseBuildStamp, readBuildStamp } from './build-stamp.js';

test('a stamp the installer wrote reads back', () => {
  const stamp = parseBuildStamp(
    'commit=9140832ab12c\nbranch=claude/avex-pay-setup-cnlasi\nbuilt=2026-09-02T17:40:00Z\n',
  );
  assert.deepEqual(stamp, {
    commit: '9140832ab12c',
    branch: 'claude/avex-pay-setup-cnlasi',
    built: '2026-09-02T17:40:00Z',
  });
});

test('the commit alone is enough', () => {
  // Older stamps, or a hand-written one. The commit is the part being asked for.
  assert.deepEqual(parseBuildStamp('commit=abcdef1'), {
    commit: 'abcdef1',
    branch: null,
    built: null,
  });
});

test('anything that is not a commit reads as no stamp at all', () => {
  /**
   * A half-written file must be indistinguishable from a missing one. Reporting
   * `commit: ""` would answer "which build is this" with something that looks like an
   * answer, which is worse than admitting there is no stamp.
   */
  for (const contents of ['', 'commit=\n', 'commit=not-a-sha\n', 'branch=main\n', 'garbage']) {
    assert.equal(parseBuildStamp(contents), null, JSON.stringify(contents));
  }
});

test('unknown keys are ignored rather than fatal', () => {
  // So a later installer can add a field without this refusing to read the file.
  const stamp = parseBuildStamp('commit=abcdef1\nsomething=else\n');
  assert.equal(stamp?.commit, 'abcdef1');
});

test('a missing file is not an error', () => {
  // This is read on the way to answering a health check. It cannot throw.
  assert.equal(readBuildStamp(join(tmpdir(), 'avex-no-such-stamp-file')), null);
  assert.equal(readBuildStamp(tmpdir()), null, 'a directory is not a stamp either');
});

test('a real file on disk round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avex-stamp-'));
  const path = join(dir, 'build');
  writeFileSync(path, 'commit=0123abc\nbuilt=2026-09-02T00:00:00Z\n');
  assert.equal(readBuildStamp(path)?.commit, '0123abc');
});
