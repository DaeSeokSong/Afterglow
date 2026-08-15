import { z } from 'zod';
import { editShape, runEdit } from './edit.js';
import { runInit } from './init.js';
import { runList } from './list.js';
import { runStatus } from './status.js';
import { runInspect } from './inspect.js';
import { runSign } from './sign.js';
import { runResume } from './resume.js';
import { runArchive } from './archive.js';
import { historyShape, runHistory } from './history.js';
import { elicitMissing, slugCandidates } from './elicit.js';
import { errorReply, safe, type ToolReply } from './types.js';

/**
 * `afterglow_agent` — the consolidated lifecycle/management tool (v0.13).
 * One tool replaces nine: init · list · status · inspect · edit · sign ·
 * resume · archive · restore · history. Each action routes to the original
 * implementation, which keeps its own validation, elicitation, and ACL —
 * this file is deliberately a thin router so behaviour (and the 300+ existing
 * tests that import the originals directly) stays identical.
 */

export const AGENT_ACTIONS = [
  'list', 'status', 'inspect', 'edit', 'sign', 'resume',
  'archive', 'restore', 'history', 'init',
] as const;
type AgentAction = (typeof AGENT_ACTIONS)[number];

// editShape carries the persona-patch fields (name/role/bio/tone/expertise/
// sources/mcp/confidence/dryRun/open/revalidate/caller); historyShape carries
// the log filters (since/until/filter/limit/reverse). We spread them and then
// override the shared/colliding fields with action-scoped descriptions.
export const agentShape = {
  ...editShape,
  ...historyShape,
  action: z
    .enum(AGENT_ACTIONS)
    .optional()
    .describe(
      '(필수) list(목록) | status(대시보드) | inspect(상세) | edit(수정) | sign(동의 서명→active) | resume(재활성화) | archive(보관) | restore(복원) | history(로그) | init(수동 부트스트랩 — 보통 불필요, create 가 자동 init).',
    ),
  slug: z.string().min(1).optional().describe('(필수 — list/status/init 제외) 대상 에이전트 slug.'),
  json: z.boolean().optional().describe('list/status/inspect/history 시 JSON 출력.'),
  status: z
    .enum(['active', 'learning', 'paused', 'draft', 'archived'])
    .optional()
    .describe('list 시 상태 필터.'),
  signer: z.string().max(200).optional().describe('sign 시 서명자 표시명.'),
  note: z.string().max(1_000).optional().describe('sign 시 동의 범위·메모 (선택).'),
  embeddingModel: z.string().max(200).optional().describe('init 시 임베딩 모델명 (선택).'),
} as const;

interface AgentArgs {
  action?: AgentAction;
  slug?: string;
  [key: string]: unknown;
}

export async function runAgent(args: AgentArgs): Promise<ToolReply> {
  return safe(async () => {
    const guide = await elicitMissing('agent', args as Record<string, unknown>, [
      { name: 'action', required: true, label: '동작', enumValues: AGENT_ACTIONS },
      { name: 'slug', required: false, label: '대상 에이전트 (list/status/init 외 필수)', candidates: slugCandidates },
    ]);
    if (guide) return guide;

    // Route to the original implementations. Each keeps its own required-arg
    // elicitation (e.g. sign asks for signer, edit validates the patch).
    switch (args.action) {
      case 'init':
        return runInit({ embeddingModel: args.embeddingModel as string | undefined });
      case 'list':
        return runList(args as never);
      case 'status':
        return runStatus(args as never);
      case 'inspect':
        return runInspect(args as never);
      case 'edit':
        return runEdit(args as never);
      case 'sign':
        return runSign(args as never);
      case 'resume':
        return runResume(args as never);
      case 'archive':
        return runArchive({ ...args, action: 'archive' } as never);
      case 'restore':
        return runArchive({ ...args, action: 'restore' } as never);
      case 'history':
        return runHistory(args as never);
      default:
        return errorReply(`Unknown action: ${String(args.action)}`);
    }
  });
}
