// ABOUTME: Hand a filed QA bug off to the agent board as a code-issue task — composes the task symptom from
// ABOUTME: the bug's captured signals (title, page, suspected component/source, errors, repro, test login),
// ABOUTME: seeds the task with the heuristic RCA as an artifact, and links both directions. Pure core, no HTTP.
import { createTask, postArtifact } from '../tasks/tasks.js';
import { getBug, linkBugToTask } from './bugs.js';
import { analyzeBug } from './analyze.js';

// QA severity (low|medium|high|critical) → task severity (low|medium|high). critical folds into high.
const TASK_SEVERITY = { critical: 'high', high: 'high', medium: 'medium', low: 'low' };

function composeSymptom(bug, analysis, bugUrl) {
  const m = bug.meta || {};
  const lines = [];
  lines.push((bug.description && bug.description.trim()) || bug.title);
  lines.push('');
  lines.push('Reported from: ' + bug.pageUrl);
  if (bugUrl) lines.push('Full capture (replay + network + console): ' + bugUrl);
  if (analysis.suspectedComponent) {
    lines.push('Suspected component: <' + analysis.suspectedComponent + '>' + (analysis.suspectedSource ? ' (' + analysis.suspectedSource + ')' : ''));
  }
  if (analysis.suspectedCause) lines.push('Likely cause: ' + analysis.suspectedCause);
  if (analysis.errorCount) lines.push(analysis.errorCount + ' console error(s) captured.');
  if (m.credentials && m.credentials.username) {
    lines.push('Test login: ' + m.credentials.username + (m.credentials.password ? ' / ' + m.credentials.password : ''));
  }
  if (analysis.reproSteps && analysis.reproSteps.length) {
    lines.push('');
    lines.push('Repro:');
    for (const s of analysis.reproSteps) lines.push('- ' + s);
  }
  return lines.join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A compact HTML RCA card for the task view (rendered in the board's sandbox). All interpolated values are
// escaped — the capture holds arbitrary page strings (error text, selectors).
function rcaHtml(bug, analysis, bugUrl) {
  const li = (arr) => arr.map((x) => '<li>' + esc(x) + '</li>').join('');
  return [
    '<div style="font:13px/1.5 system-ui">',
    '<h3 style="margin:0 0 6px">' + esc(bug.humanId) + ' — ' + esc(bug.title) + '</h3>',
    '<p><b>Suspected cause:</b> ' + esc(analysis.suspectedCause) + ' <em>(' + esc(analysis.confidence) + ' confidence)</em></p>',
    analysis.suspectedComponent ? '<p><b>Component:</b> <code>' + esc(analysis.suspectedComponent) + '</code>' + (analysis.suspectedSource ? ' — <code>' + esc(analysis.suspectedSource) + '</code>' : '') + '</p>' : '',
    analysis.evidence.length ? '<p><b>Evidence</b></p><ul>' + li(analysis.evidence) + '</ul>' : '',
    analysis.reproSteps.length ? '<p><b>Repro</b></p><ol>' + li(analysis.reproSteps) + '</ol>' : '',
    bugUrl ? '<p><a href="' + esc(bugUrl) + '">Open the full capture in be10x →</a></p>' : '',
    '</div>',
  ].filter(Boolean).join('');
}

// handoffBugToTask(db, { bugId, actorId, scope?, projectId?, teamId?, bugUrl? }) → { task, bug }.
// Creates a code-issue task owned by actorId, seeds the RCA artifact, and links the bug ⇄ task both ways.
export function handoffBugToTask(db, { bugId, actorId, scope = 'personal', projectId, teamId, bugUrl = null } = {}) {
  if (!actorId) throw new Error('MISSING_FIELD:actorId');
  const bug = getBug(db, bugId);
  if (!bug) throw new Error('NOT_FOUND');
  if (bug.taskId) {
    // Already handed off — return the existing link rather than spawning duplicate tasks on a double-click.
    return { task: null, bug, alreadyLinked: true };
  }
  const analysis = analyzeBug(bug);
  // Default the routing to the bug's OWN triage (team/project chosen at report time) so the handed-off task
  // lands in that project/team's backlog instead of the general list. An explicit caller value still wins;
  // an explicit null/'' means "no project/team" (personal); undefined (not provided) ⇒ inherit the bug's.
  const resolvedProjectId = projectId === undefined ? (bug.projectId ?? null) : (projectId || null);
  const resolvedTeamId = teamId === undefined ? (bug.teamId ?? null) : (teamId || null);
  const resolvedScope = resolvedTeamId ? 'team' : resolvedProjectId ? 'project' : scope;
  const task = createTask(db, {
    type: 'code-issue',
    scope: resolvedScope,
    title: '[bug] ' + bug.title,
    ownerId: actorId,
    teamId: resolvedTeamId,
    projectId: resolvedProjectId,
    severity: TASK_SEVERITY[bug.severity] || 'medium',
    content: {
      symptom: composeSymptom(bug, analysis, bugUrl),
      bugId: bug.id,
      bugHumanId: bug.humanId,
      pageUrl: bug.pageUrl,
      ...(analysis.suspectedComponent ? { suspectedComponent: analysis.suspectedComponent } : {}),
      ...(analysis.suspectedSource ? { suspectedSource: analysis.suspectedSource } : {}),
    },
  });
  // The RCA artifact is a bonus — never fail the hand-off if posting it throws.
  try {
    postArtifact(db, task.id, { key: 'bug-capture', kind: 'rca', title: 'Capture: ' + bug.humanId, content: rcaHtml(bug, analysis, bugUrl) }, actorId);
  } catch {
    /* ignore */
  }
  const linked = linkBugToTask(db, bug.id, task.id, actorId);
  return { task, bug: linked };
}
