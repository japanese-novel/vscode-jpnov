import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContained } from '../../../src/shared/config/validate.ts';

const ROOT = 'file:///Users/x/proj';

test('resolveContained accepts contained relative subpaths', () => {
  const cases: [string, string][] = [
    ['./src', 'file:///Users/x/proj/src'],
    ['src', 'file:///Users/x/proj/src'],
    ['dist', 'file:///Users/x/proj/dist'],
    ['./a/b/c', 'file:///Users/x/proj/a/b/c'],
    ['a/../b', 'file:///Users/x/proj/b'],
    ['./deep/../src', 'file:///Users/x/proj/src'],
  ];
  for (const [rel, expected] of cases) {
    const got = resolveContained(ROOT, rel);
    assert.deepEqual(got, { ok: true, abs: expected }, `for rel=${rel}`);
  }
});

test("resolveContained percent-encodes the path in VS Code's form, so URL-special characters stay in the name", () => {
  const cases: [string, string][] = [
    ['第1巻#改稿.jpnov', 'file:///Users/x/proj/%E7%AC%AC1%E5%B7%BB%23%E6%94%B9%E7%A8%BF.jpnov'],
    ['50%.jpnov', 'file:///Users/x/proj/50%25.jpnov'],
    ['a?b.jpnov', 'file:///Users/x/proj/a%3Fb.jpnov'],
    ['sub dir/b(1).jpnov', 'file:///Users/x/proj/sub%20dir/b%281%29.jpnov'],
    ['tab\there.jpnov', 'file:///Users/x/proj/tab%09here.jpnov'],
    ['x/../a#b', 'file:///Users/x/proj/a%23b'],
    // An entry is a plain path, never a pre-encoded one: this names a file literally called %E3%81%82.jpnov.
    ['%E3%81%82.jpnov', 'file:///Users/x/proj/%25E3%2581%2582.jpnov'],
  ];
  for (const [rel, expected] of cases) {
    assert.deepEqual(resolveContained(ROOT, rel), { ok: true, abs: expected }, `for rel=${JSON.stringify(rel)}`);
  }
});

test('resolveContained rejects text the encoder cannot represent (a lone surrogate) as path.invalid', () => {
  assert.deepEqual(resolveContained(ROOT, '\uD800x.jpnov'), { ok: false, code: 'path.invalid' });
});

test('resolveContained accepts when the root already has a trailing slash', () => {
  assert.deepEqual(resolveContained('file:///Users/x/proj/', './src'), {
    ok: true,
    abs: 'file:///Users/x/proj/src',
  });
});

test('resolveContained rejects empty / root-only paths', () => {
  for (const rel of ['', '   ', '.', './', 'foo/..']) {
    const got = resolveContained(ROOT, rel);
    assert.equal(got.ok, false, `should reject rel=${JSON.stringify(rel)}`);
  }
});

test('resolveContained rejects paths that escape above the root', () => {
  for (const rel of ['..', '../sibling', './a/../../escape', '../../etc']) {
    const got = resolveContained(ROOT, rel);
    assert.equal(got.ok, false, `should reject rel=${rel}`);
  }
});

test('resolveContained rejects absolute paths and URIs', () => {
  for (const rel of ['/etc/passwd', 'C:\\Windows', '\\\\server\\share', 'file:///etc', 'http://evil']) {
    const got = resolveContained(ROOT, rel);
    assert.equal(got.ok, false, `should reject rel=${rel}`);
  }
});

test('resolveContained rejects leading "~" (home-relative)', () => {
  for (const rel of ['~', '~/secrets', '~root/x']) {
    const got = resolveContained(ROOT, rel);
    assert.equal(got.ok, false, `should reject rel=${rel}`);
  }
});

test('resolveContained maps each rejection family to its code', () => {
  const code = (rel: string): string => {
    const got = resolveContained(ROOT, rel);
    assert.ok(!got.ok, `should reject ${JSON.stringify(rel)}`);
    return got.code;
  };
  assert.equal(code(''), 'path.empty');
  assert.equal(code('.'), 'path.rootDot');
  assert.equal(code('foo/..'), 'path.rootDot');
  assert.equal(code('~'), 'path.homeRelative');
  assert.equal(code('/etc/passwd'), 'path.absolute');
  assert.equal(code('..'), 'path.escapesRoot');
});
