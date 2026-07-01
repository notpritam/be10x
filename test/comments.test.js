import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { addComment, listComments, unseenComments, markCommentsSeen } from '../src/tasks/comments.js';
import { listEvents } from '../src/tasks/events.js';

function seed() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(
    'u1', 'a@b.dev', 'A', 'x', now
  );
  db.prepare(
    'INSERT INTO tasks (id,human_id,type,scope,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('t1', 'GFA-1', 'code-issue', 'personal', 'u1', 'T', 'plan_review', now, now);
  return db;
}

test('addComment stores the thread and mirrors to the event log', () => {
  const db = seed();
  const c = addComment(db, 't1', { author: 'u1', body: 'step 2 is wrong', anchor: 'plan_line' });
  assert.equal(c.body, 'step 2 is wrong');
  assert.equal(c.anchor, 'plan_line');
  assert.equal(c.seenAt, null);
  assert.deepEqual(
    listComments(db, 't1').map((x) => x.body),
    ['step 2 is wrong']
  );
  assert.ok(listEvents(db, 't1').some((e) => e.kind === 'comment'));
});

test('unknown anchors coerce to general', () => {
  const db = seed();
  assert.equal(addComment(db, 't1', { author: 'u1', body: 'x', anchor: 'bogus' }).anchor, 'general');
});

test('unseenComments + markCommentsSeen drive delta-only wakes', () => {
  const db = seed();
  const c1 = addComment(db, 't1', { author: 'u1', body: 'first' });
  const c2 = addComment(db, 't1', { author: 'u1', body: 'second' });
  assert.equal(unseenComments(db, 't1').length, 2);

  assert.equal(markCommentsSeen(db, [c1.id, c2.id]), 2);
  assert.equal(unseenComments(db, 't1').length, 0);

  // a new comment after the agent read the first batch is the only delta next time
  const c3 = addComment(db, 't1', { author: 'u1', body: 'third' });
  const unseen = unseenComments(db, 't1');
  assert.deepEqual(unseen.map((x) => x.id), [c3.id]);

  // re-marking an already-seen comment is a no-op
  assert.equal(markCommentsSeen(db, [c1.id]), 0);
});
