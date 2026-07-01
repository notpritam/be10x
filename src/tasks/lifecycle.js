// ABOUTME: The task lifecycle state machine — legal transitions only. The board is this machine.
export const STATES = [
  'backlog',
  'researching',
  'plan_review',
  'ready_to_work',
  'in_progress',
  'needs_input',
  'verifying',
  'done',
  'blocked',
  'not_a_bug',
  'wont_fix',
];

const TRANSITIONS = {
  backlog: ['researching', 'ready_to_work', 'not_a_bug', 'wont_fix', 'blocked'],
  researching: ['plan_review', 'blocked'],
  plan_review: ['researching', 'ready_to_work', 'not_a_bug', 'wont_fix', 'blocked'],
  ready_to_work: ['in_progress', 'plan_review', 'blocked'],
  in_progress: ['needs_input', 'verifying', 'plan_review', 'blocked'],
  needs_input: ['in_progress', 'blocked'],
  verifying: ['done', 'in_progress', 'plan_review'],
  blocked: ['backlog', 'researching', 'plan_review', 'ready_to_work', 'in_progress'],
  done: [],
  not_a_bug: [],
  wont_fix: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error('ILLEGAL_TRANSITION');
}
