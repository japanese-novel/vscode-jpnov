import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BEATS } from '../../src/stage/beats.ts';
import { schedule, snapNearLabels } from '../../src/stage/schedule.ts';

test('the five beats are fixed and each carries a caption', () => {
  assert.deepEqual(BEATS.map((b) => b.id), ['write', 'check', 'collect', 'fix', 'book']);
  for (const b of BEATS) {
    assert.ok(b.heading.length > 0 && b.paragraphs.length > 0 && b.duration > 0, b.id);
  }
});

test('labels are cumulative and snapping is idempotent on labels', () => {
  const { labels, total } = schedule(BEATS);
  assert.equal(labels[0]?.at, 0);
  assert.equal(total, BEATS.reduce((n, b) => n + b.duration, 0));
  for (let i = 1; i < labels.length; i++) {
    assert.equal(labels[i]?.at, (labels[i - 1]?.at ?? 0) + (labels[i - 1]?.duration ?? 0));
  }
  const snap = snapNearLabels(labels, total);
  for (const l of labels) {
    assert.equal(snap(l.at / total, 0.5), l.at / total);
  }
  assert.equal(snap(0.5, 0.31), 0.31, 'away from a label the scroll stays put');
});
