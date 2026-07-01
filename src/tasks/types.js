// ABOUTME: Task-type registry. Each type is a plugin: required/optional content fields, a flow, and
// ABOUTME: whether the worker may auto-execute it. v1 ships two types: code-issue and general.
export const TASK_TYPES = {
  'code-issue': {
    label: 'Code issue',
    required: ['symptom'],
    optional: ['rootCause', 'solution', 'diagram', 'files'],
    flow: ['research', 'plan', 'implement', 'verify', 'ship'],
    agentExecutable: true,
  },
  general: {
    label: 'General / idea / research',
    required: ['summary'],
    optional: ['proposal', 'rationale', 'findings', 'sources', 'acceptance'],
    flow: ['research', 'plan', 'discuss', 'decide'],
    agentExecutable: false,
  },
};

export function getType(type) {
  const t = TASK_TYPES[type];
  if (!t) throw new Error('UNKNOWN_TYPE');
  return t;
}

export function validateContent(type, content) {
  const t = getType(type);
  for (const field of t.required) {
    const v = content[field];
    if (v === undefined || v === null || v === '') throw new Error('MISSING_FIELD:' + field);
  }
  return true;
}
