import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/protocol.mjs';
import { validateSyncManifest, validateSyncTransition, fileStateEqual } from '../src/sync-protocol.mjs';
import { reconcileSync, resolveSyncConflict } from '../src/reconcile.mjs';

const state = (text, executable = false) => ({ hash: sha256(Buffer.from(text)), size: Buffer.byteLength(text), executable });
const file = (path, text) => ({ path, ...state(text) });
const manifest = (id, files = [], extra = {}) => validateSyncManifest({ version: 2, id, projectId: 'p', deviceId: 'a', parentId: null, policyRevision: 1, files, tombstones: [], conflicts: [], archiveRefs: [], ...extra });
let proposal = 0;
const plan = (remote, local, bases = [], extra = {}) => reconcileSync({ projectId: 'p', deviceId: 'b', remote, local, bases, newId: () => `proposal-${++proposal}`, ...extra });
const base = (path, text) => ({ path, state: text === null ? null : state(text) });

test('first pairing unions unique additions without inferring deletion', () => {
  const remote = manifest('root', [file('remote.txt', 'R')]);
  const result = plan(remote, [file('local.txt', 'L')]);
  assert.equal(result.blocked, false); assert.equal(result.changed, true);
  assert.deepEqual(result.manifest.files.map(item => item.path), ['local.txt', 'remote.txt']);
  assert.deepEqual(result.manifest.tombstones, []);
  assert.deepEqual(result.operations, [{ path: 'remote.txt', expected: null, desired: state('R') }]);
  validateSyncTransition(remote, result.manifest);
});

test('common base propagates local and remote disjoint edits without clocks', () => {
  const remote = manifest('root', [file('a', 'new-A'), file('b', 'old-B')]);
  const result = plan(remote, [file('a', 'old-A'), file('b', 'new-B')], [base('a', 'old-A'), base('b', 'old-B')]);
  assert.equal(result.manifest.conflicts.length, 0);
  assert.deepEqual(result.manifest.files, [file('a', 'new-A'), file('b', 'new-B')]);
  assert.deepEqual(result.operations.map(item => item.path), ['a']);
  validateSyncTransition(remote, result.manifest);
});

test('unmanaged remote paths are preserved, never replaced by a filtered local snapshot', () => {
  const remote = manifest('root', [file('private/report.txt', 'R'), file('a', 'old')]);
  const result = plan(remote, [file('a', 'new')], [base('private/report.txt', 'R'), base('a', 'old')], { isManaged: name => !name.startsWith('private/') });
  assert.equal(result.manifest.files.find(item => item.path === 'private/report.txt').hash, state('R').hash);
  assert.equal(result.manifest.tombstones.length, 0); assert.equal(result.operations.length, 0);
  assert.equal(result.adoptions.some(item => item.path.startsWith('private/')), false);
});

test('edit/edit keeps primary local untouched, stores both variants, and does not repeat conflicts', () => {
  const remote = manifest('root', [file('a', 'remote')]);
  const first = plan(remote, [file('a', 'local')], [base('a', 'common')]);
  assert.equal(first.manifest.conflicts.length, 1); assert.deepEqual(first.operations, []);
  const conflict = first.manifest.conflicts[0];
  assert.ok(fileStateEqual(conflict.main, state('remote')));
  assert.ok(conflict.variants.some(value => fileStateEqual(value, state('local'))));
  validateSyncTransition(remote, first.manifest);
  const again = plan(first.manifest, [file('a', 'local')], first.frozen);
  assert.equal(again.changed, false); assert.deepEqual(again.operations, []);
  assert.deepEqual(again.manifest.conflicts, first.manifest.conflicts);
});

test('active conflict absorbs new local versions without silently switching canonical main', () => {
  const first = plan(manifest('root', [file('a', 'R')]), [file('a', 'L')], [base('a', 'B')]);
  const next = plan(first.manifest, [file('a', 'L2')], first.frozen, { newId: () => 'next' });
  validateSyncTransition(first.manifest, next.manifest);
  assert.equal(next.manifest.conflicts[0].variants.length, 3);
  assert.deepEqual(next.manifest.conflicts[0].main, state('R'));
  assert.deepEqual(next.operations, []);
});

test('explicit resolution applies over preserved local state but later edits make a new conflict', () => {
  const first = plan(manifest('root', [file('a', 'R')]), [file('a', 'L')], [base('a', 'B')]);
  const resolved = resolveSyncConflict({ remote: first.manifest, conflictId: first.manifest.conflicts[0].id, state: state('R'), deviceId: 'a', newId: () => 'resolved' });
  validateSyncTransition(first.manifest, resolved.manifest, { resolutions: resolved.resolutions });
  const clean = plan(resolved.manifest, [file('a', 'L')], first.frozen);
  assert.equal(clean.manifest.conflicts.length, 0); assert.deepEqual(clean.operations, [{ path: 'a', expected: state('L'), desired: state('R') }]);
  const raced = plan(resolved.manifest, [file('a', 'L2')], first.frozen);
  assert.equal(raced.manifest.conflicts.length, 1); assert.deepEqual(raced.operations, []);
});

test('tracked local delete emits an explicit tombstone while remote clean delete plans recycle', () => {
  const remote = manifest('root', [file('a', 'B')]);
  const localDelete = plan(remote, [], [base('a', 'B')]);
  assert.deepEqual(localDelete.manifest.tombstones, [{ path: 'a', prior: state('B') }]);
  validateSyncTransition(remote, localDelete.manifest);
  const remoteDelete = plan(localDelete.manifest, [file('a', 'B')], [base('a', 'B')]);
  assert.equal(remoteDelete.changed, false);
  assert.deepEqual(remoteDelete.operations, [{ path: 'a', expected: state('B'), desired: null }]);
});

test('remote deletion versus local edit preserves the surviving bytes and deletion intent', () => {
  const remote = manifest('deleted', [], { tombstones: [{ path: 'a', prior: state('B') }] });
  const result = plan(remote, [file('a', 'edit')], [base('a', 'B')]);
  assert.equal(result.manifest.conflicts.length, 1); assert.deepEqual(result.operations, []);
  assert.deepEqual(result.manifest.files, [file('a', 'edit')]);
  assert.ok(result.manifest.conflicts[0].variants.includes(null));
  validateSyncTransition(remote, result.manifest);
});

test('new device lacking a conflicted file does not manufacture a deletion vote', () => {
  const first = plan(manifest('root', [file('a', 'R')]), [file('a', 'L')], [base('a', 'B')]);
  const next = plan(first.manifest, []);
  assert.equal(next.changed, false);
  assert.equal(next.manifest.conflicts[0].variants.includes(null), false);
  assert.deepEqual(next.operations, []);
});

test('recreation retains tombstone history; unknown remote omission fails closed', () => {
  const deleted = manifest('deleted', [], { tombstones: [{ path: 'a', prior: state('old') }] });
  const recreated = plan(deleted, [file('a', 'new')], [base('a', null)]);
  validateSyncTransition(deleted, recreated.manifest);
  assert.deepEqual(recreated.manifest.tombstones, deleted.tombstones);
  const unknown = plan(manifest('empty'), [file('a', 'old')], [base('a', 'old')]);
  assert.equal(unknown.blocked, true); assert.equal(unknown.blockers[0].code, 'SYNC_UNTRACKED_DELETE');
});

test('structural and case collisions preserve both trees without an apply plan', () => {
  for (const [remoteName, localName] of [['tree/a', 'tree'], ['Name', 'name']]) {
    const result = plan(manifest('root', [file(remoteName, 'R')]), [file(localName, 'L')]);
    assert.equal(result.blocked, true); assert.equal(result.manifest, null); assert.deepEqual(result.operations, []);
    assert.equal(result.blockers[0].code, 'SYNC_STRUCTURAL_CONFLICT');
  }
});
