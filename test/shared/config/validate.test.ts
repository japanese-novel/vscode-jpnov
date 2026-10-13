import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outDirSubpath } from '../../../src/shared/config/validate.ts';

test('outDirSubpath keeps a relative folder, collapsed and /-joined, `..` included', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['./src', 'src'],
    ['src', 'src'],
    [' dist ', 'dist'],
    ['./a/b/c', 'a/b/c'],
    ['a/../b', 'b'],
    ['./deep/../src', 'src'],
    ['a\\b', 'a/b'],
    ['../dist', '../dist'],
    ['../../out/html', '../../out/html'],
    ['出力#1', '出力#1'],
    ['50%', '50%'],
    // The folder itself, and the folders above it, are folders too.
    ['.', ''],
    ['./', ''],
    ['foo/..', ''],
    ['..', '..'],
    ['../..', '../..'],
  ];
  for (const [value, rel] of cases) {
    assert.deepEqual(outDirSubpath(value), { fromRoot: false, rel }, `for ${JSON.stringify(value)}`);
  }
});

test('outDirSubpath reads a ${workspaceFolder} prefix as "from the root", the rest validated the same way', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['${workspaceFolder}/dist', 'dist'],
    ['${workspaceFolder}\\out\\html', 'out/html'],
    [' ${workspaceFolder}/./a/../b ', 'b'],
    ['${workspaceFolder}/../sibling', '../sibling'],
    ['${workspaceFolder}', ''],
    ['${workspaceFolder}/', ''],
    ['${workspaceFolder}/.', ''],
  ];
  for (const [value, rel] of cases) {
    assert.deepEqual(outDirSubpath(value), { fromRoot: true, rel }, `for ${JSON.stringify(value)}`);
  }
  for (const value of ['${workspaceFolder}/~x', '${workspaceFolder}/C:\\x']) {
    assert.equal(outDirSubpath(value), null, `for ${JSON.stringify(value)}`);
  }
  // Only the exact token, and only as a prefix.
  assert.deepEqual(outDirSubpath('dist/${workspaceFolder}'), { fromRoot: false, rel: 'dist/${workspaceFolder}' });
  assert.deepEqual(outDirSubpath('${WorkspaceFolder}/dist'), { fromRoot: false, rel: '${WorkspaceFolder}/dist' });
});

test('outDirSubpath is null for what names no folder: empty, absolute, home, unencodable', () => {
  for (const value of ['', '   ', '/etc/passwd', 'C:\\Windows', '\\\\server\\share', 'file:///etc', 'http://evil', '~', '~/secrets', '~root/x', '\uD800x']) {
    assert.equal(outDirSubpath(value), null, `for ${JSON.stringify(value)}`);
  }
});
