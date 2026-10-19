/**
 * The startup probe: settings-presence (workspace/folder level only — NEVER user level),
 * root-level filename matching, and a capped deep search, per workspace folder.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVscode,
  createMockState,
  resetMockState,
  Uri,
} from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { folderIsNovelProject } = await import('../../src/client/probe.ts');

beforeEach(() => {
  resetMockState(state);
});

const FOLDER_URI = 'file:///ws/a';

function folder(): { uri: Uri; name: string; index: number } {
  return { uri: Uri.parse(FOLDER_URI), name: 'a', index: 0 };
}

test('a root-level *.jpbook marks the folder as a novel project', async () => {
  state.readDirectoryResults.set(FOLDER_URI, [['volume1.jpbook', 1]]);
  assert.equal(await folderIsNovelProject(folder() as never), true);
});

test('a workspace-level jpnov.* setting starts the project without any file', async () => {
  state.inspectResults.set(`${FOLDER_URI}|jpnov`, { workspaceValue: { highlight: {} } });
  state.readDirectoryResults.set(FOLDER_URI, []);
  assert.equal(await folderIsNovelProject(folder() as never), true);
});

test('a folder-level jpnov.* setting starts the project too', async () => {
  state.inspectResults.set(`${FOLDER_URI}|jpnov`, {
    workspaceFolderValue: { highlight: { characters: [] } },
  });
  state.readDirectoryResults.set(FOLDER_URI, []);
  assert.equal(await folderIsNovelProject(folder() as never), true);
});

test('a USER-level jpnov.* setting alone must not auto-start every window', async () => {
  state.inspectResults.set(`${FOLDER_URI}|jpnov`, { globalValue: { highlight: {} } });
  state.readDirectoryResults.set(FOLDER_URI, []);
  assert.equal(await folderIsNovelProject(folder() as never), false);
});

test('no settings, no matching filenames: not a novel project', async () => {
  state.readDirectoryResults.set(FOLDER_URI, [
    ['notes.md', 1],
    ['drafts', 2],
  ]);
  assert.equal(await folderIsNovelProject(folder() as never), false);
});

test('a non-file named *.jpbook is no signal (directory or symlink)', async () => {
  // Strict FileType.File: matches server-side discovery, where a Dirent that is a
  // directory or a symlink is never a book either.
  state.readDirectoryResults.set(FOLDER_URI, [
    ['x.jpbook', 2], // directory
    ['link.jpbook', 65], // File | SymbolicLink
  ]);
  assert.equal(await folderIsNovelProject(folder() as never), false);
});

test('an unreadable root is skipped, not fatal', async () => {
  state.readDirectoryResults.set(FOLDER_URI, 'error');
  assert.equal(await folderIsNovelProject(folder() as never), false);
});

test('a nested *.jpbook (subfolders only) is found by the deep search', async () => {
  state.readDirectoryResults.set(FOLDER_URI, [['chapters', 2]]);
  state.findFilesResults.set(FOLDER_URI, [Uri.parse(`${FOLDER_URI}/books/volume1.jpbook`)]);
  assert.equal(await folderIsNovelProject(folder() as never), true);
  const call = state.findFilesCalls[0];
  assert.ok(call);
  assert.equal(call.include.pattern, '**/*.jpbook');
  assert.equal(call.maxResults, 1);
});

test('a root shallow hit answers without the deep search', async () => {
  state.readDirectoryResults.set(FOLDER_URI, [['volume1.jpbook', 1]]);
  state.findFilesResults.set(FOLDER_URI, 'error'); // would answer false if consulted
  assert.equal(await folderIsNovelProject(folder() as never), true);
  assert.equal(state.findFilesCalls.length, 0);
});

test('an empty deep search is no signal', async () => {
  state.readDirectoryResults.set(FOLDER_URI, []);
  state.findFilesResults.set(FOLDER_URI, []);
  assert.equal(await folderIsNovelProject(folder() as never), false);
  assert.equal(state.findFilesCalls.length, 1);
});

test('a failing deep search (no search provider) is not fatal', async () => {
  state.readDirectoryResults.set(FOLDER_URI, []);
  state.findFilesResults.set(FOLDER_URI, 'error');
  assert.equal(await folderIsNovelProject(folder() as never), false);
});
