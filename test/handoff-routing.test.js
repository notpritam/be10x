// ABOUTME: Bug→task handoff routing — the handed-off task inherits the bug's own team/project (chosen at
// ABOUTME: report time) by default, lands in `backlog`, and honors an explicit override (incl. null = personal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { createUser } from '../src/auth/users.js';
import { createTeam } from '../src/teams/teams.js';
import { registerProject } from '../src/projects/projects.js';
import { createBug } from '../src/bugs/bugs.js';
import { handoffBugToTask } from '../src/bugs/handoff.js';

function seed() {
  const db = openDb(':memory:');
  const user = createUser(db, { email: 'qa@be10x.co', displayName: 'QA', password: 'pw123456' });
  const team = createTeam(db, { name: 'Web', createdBy: user.id });
  const project = registerProject(db, { key: 'gh/acme/app', name: 'App', ownerId: user.id, teamId: team.id });
  const project2 = registerProject(db, { key: 'gh/acme/api', name: 'API', ownerId: user.id, teamId: team.id });
  const mkBug = (over = {}) => createBug(db, { reporterId: user.id, pageUrl: 'https://app/x', title: 'boom', severity: 'high', ...over });
  return { db, user, team, project, project2, mkBug };
}

test('handoff inherits the bug’s own team/project by default, task lands in backlog', () => {
  const { db, user, team, project, mkBug } = seed();
  const bug = mkBug({ projectId: project.id, teamId: team.id });
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  assert.equal(task.status, 'backlog');
  assert.equal(task.teamId, team.id);
  assert.equal(task.projectId, project.id);
  assert.equal(task.scope, 'team'); // a team present ⇒ team scope
});

test('an explicit project overrides the bug’s triage', () => {
  const { db, user, team, project, project2, mkBug } = seed();
  const bug = mkBug({ projectId: project.id, teamId: team.id });
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id, projectId: project2.id, teamId: null });
  assert.equal(task.projectId, project2.id);
  assert.equal(task.teamId, null);
  assert.equal(task.scope, 'project');
});

test('explicit null routes to personal even when the bug had triage', () => {
  const { db, user, team, project, mkBug } = seed();
  const bug = mkBug({ projectId: project.id, teamId: team.id });
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id, projectId: null, teamId: null });
  assert.equal(task.projectId, null);
  assert.equal(task.teamId, null);
  assert.equal(task.scope, 'personal');
});

test('a bug with no triage still hands off (personal, backlog) without crashing', () => {
  const { db, user, mkBug } = seed();
  const bug = mkBug();
  const { task } = handoffBugToTask(db, { bugId: bug.id, actorId: user.id });
  assert.equal(task.projectId, null);
  assert.equal(task.teamId, null);
  assert.equal(task.status, 'backlog');
});
