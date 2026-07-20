/** 1C (§1d): the normative task-block validator. Pure, total, deterministic —
 * imports nothing but types, like all of core/. The broker extracts the
 * CURRENT draft body and stamps it into meta.draftBody; decide calls this to
 * turn that body into a validated PlanTaskBlock (or a precise rejection
 * reason). Exported standalone so tests hit it directly. */
import { type PlanTask, type PlanTaskBlock, type Result, err, ok } from './types.ts';

export type PlanValidation = Result<PlanTaskBlock, string>;

/** Task id grammar (§1d): MESSAGE_ID_PATTERN-safe, but WITHOUT ':' so task
 * ids never collide with delivery-id/header syntax. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Extract the FIRST fenced code block tagged `json` (```json ... ```). Fence
 * grammar is deliberately strict: an opening ```json on its own line, then the
 * body, then a closing ``` on its own line. */
function extractJsonFence(body: string): string | undefined {
  // The opening fence tag is `json` (case-insensitive), optionally with
  // trailing spaces, on its own line. Capture up to the next closing fence.
  const match = /(^|\n)```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/i.exec(body);
  return match ? match[2] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** DFS cycle detection over the task dependency graph. Returns the offending
 * task id when a cycle is found, else undefined. */
function findCycle(tasks: readonly PlanTask[]): string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): string | undefined => {
    const mark = state.get(id);
    if (mark === 'done') return undefined;
    if (mark === 'visiting') return id; // back-edge: cycle
    state.set(id, 'visiting');
    for (const dep of byId.get(id)!.deps) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    state.set(id, 'done');
    return undefined;
  };
  for (const t of tasks) {
    const hit = visit(t.id);
    if (hit) return hit;
  }
  return undefined;
}

export function validatePlanTaskBlock(draftBody: string): PlanValidation {
  const fenced = extractJsonFence(draftBody);
  if (fenced === undefined) {
    return err('the draft has no ```json task block — a normative task block (fenced json) is required before the question can be called');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch (e) {
    return err(`the fenced json task block is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) return err('the task block must be a JSON object');

  // --- plan.wip_cap + plan.verification ---
  const plan = parsed['plan'];
  if (!isObject(plan)) return err('plan: missing (expected an object with wip_cap and verification)');
  const wipCap = plan['wip_cap'];
  if (typeof wipCap !== 'number' || !Number.isInteger(wipCap) || wipCap < 1) {
    return err('plan.wip_cap: must be an integer >= 1');
  }
  const verification = plan['verification'];
  if (!isObject(verification)) return err('plan.verification: missing (expected an object with fast_gate)');
  if (!nonBlankString(verification['fast_gate'])) return err('plan.verification.fast_gate: required, non-blank string');
  if (verification['full_suite'] !== undefined && typeof verification['full_suite'] !== 'string') {
    return err('plan.verification.full_suite: must be a string when present');
  }
  if (verification['cadence'] !== undefined && typeof verification['cadence'] !== 'string') {
    return err('plan.verification.cadence: must be a string when present');
  }

  // --- tasks[] ---
  const rawTasks = parsed['tasks'];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return err('tasks: must be a non-empty array');
  const tasks: PlanTask[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i];
    const where = `tasks[${i}]`;
    if (!isObject(t)) return err(`${where}: must be an object`);
    const id = t['id'];
    if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
      return err(`${where}.id: must match ${TASK_ID_PATTERN.source} (id-safe grammar)`);
    }
    if (ids.has(id)) return err(`${where}.id: duplicate task id '${id}'`);
    ids.add(id);
    if (!nonBlankString(t['title'])) return err(`${where}.title: required, non-blank string`);
    const cls = t['class'];
    if (cls !== 'production' && cls !== 'assist') return err(`${where}.class: must be 'production' or 'assist'`);
    const merges = t['merges'];
    if (merges !== undefined) {
      if (typeof merges !== 'boolean') return err(`${where}.merges: must be a boolean when present`);
      if (cls === 'production') return err(`${where}.merges: only 'assist' tasks may set merges`);
    }
    if (typeof t['description'] !== 'string') return err(`${where}.description: must be a string`);
    const acceptance = t['acceptance'];
    if (!Array.isArray(acceptance) || acceptance.length === 0 || !acceptance.every((a) => typeof a === 'string')) {
      return err(`${where}.acceptance: must be a non-empty array of strings`);
    }
    const deps = t['deps'];
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) {
      return err(`${where}.deps: must be an array of task-id strings`);
    }
    const affinity = t['affinity'];
    if (affinity !== undefined && (!Array.isArray(affinity) || !affinity.every((a) => typeof a === 'string'))) {
      return err(`${where}.affinity: must be an array of strings when present`);
    }
    const size = t['size'];
    if (size !== undefined && size !== 'S' && size !== 'M' && size !== 'L') {
      return err(`${where}.size: must be 'S', 'M', or 'L' when present`);
    }
    tasks.push({
      id,
      title: t['title'] as string,
      class: cls,
      ...(merges === undefined ? {} : { merges: merges as boolean }),
      description: t['description'] as string,
      acceptance: acceptance as string[],
      deps: deps as string[],
      ...(affinity === undefined ? {} : { affinity: affinity as string[] }),
      ...(size === undefined ? {} : { size: size as 'S' | 'M' | 'L' }),
    });
  }

  // --- dependency edges: existence, no self-reference, no cycles ---
  for (const t of tasks) {
    for (const dep of t.deps) {
      if (dep === t.id) return err(`tasks '${t.id}': a task cannot depend on itself`);
      if (!ids.has(dep)) return err(`tasks '${t.id}': dep '${dep}' references an unknown task id`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) return err(`tasks: dependency cycle detected involving '${cycle}'`);

  const block: PlanTaskBlock = {
    plan: {
      wip_cap: wipCap,
      verification: {
        fast_gate: verification['fast_gate'] as string,
        ...(verification['full_suite'] === undefined ? {} : { full_suite: verification['full_suite'] as string }),
        ...(verification['cadence'] === undefined ? {} : { cadence: verification['cadence'] as string }),
      },
    },
    tasks,
  };
  return ok(block);
}
