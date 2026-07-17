import { z } from 'zod';
import { runAccess } from './access.js';
import { auditShape, runAudit } from './audit.js';
import { correctShape, runCorrect } from './correct.js';
import { versionShape, runVersion } from './version.js';
import { gcShape, runGc } from './gc.js';
import { elicitMissing, slugCandidates } from './elicit.js';
import { errorReply, safe, type ToolReply } from './types.js';

/**
 * `afterglow_admin` — the consolidated trust/governance tool (v0.13). One
 * tool replaces five: access(호출 권한) · audit(감사 로그) · correct(보정·
 * 답변회수·데이터주체 export) · version(스냅샷/롤백) · gc(보존/정리).
 * Two-level routing keeps each area's vocabulary intact: pick an `area`,
 * then that area's `action`. Thin router — originals unchanged.
 */

const ADMIN_AREAS = ['access', 'audit', 'correct', 'version', 'gc'] as const;
type AdminArea = (typeof ADMIN_AREAS)[number];

// Per-area action enums (audit is flag-driven and takes no action).
const AREA_ACTIONS: Record<AdminArea, readonly string[] | null> = {
  access: ['list', 'allow', 'deny', 'remove', 'set-default', 'check'],
  audit: null,
  correct: ['feedback', 'edit-answer', 'save-rule', 'record-answer', 'list', 'data-subject-export'],
  version: ['list', 'diff', 'rollback', 'tag', 'snapshot'],
  gc: ['list', 'prune-versions', 'purge-media', 'purge-archive'],
};

export const adminShape = {
  // Field union of the five sub-tools, then overrides for the shared/colliding
  // fields. Only one area is active per call, so shared names are safe.
  ...auditShape,
  ...correctShape,
  ...versionShape,
  ...gcShape,
  area: z
    .enum(ADMIN_AREAS)
    .optional()
    .describe('(필수) access(호출 권한) | audit(감사 로그·무결성) | correct(보정·답변 회수·데이터주체 export) | version(스냅샷·롤백) | gc(보존·정리).'),
  action: z
    .string()
    .max(40)
    .optional()
    .describe(
      '(area 별 필수 — audit 제외) access: list|allow|deny|remove|set-default|check · correct: feedback|edit-answer|save-rule|record-answer|list|data-subject-export · version: list|diff|rollback|tag|snapshot · gc: list|prune-versions|purge-media|purge-archive.',
    ),
  slug: z.string().min(1).optional().describe('대상 에이전트 slug (대부분의 area 에서 필수 — audit/gc 는 생략 가능).'),
  rule: z
    .string()
    .max(2_000)
    .optional()
    .describe('access allow/deny/remove: "user:x"/"role:x"/"team:x" 규칙 · correct save-rule: 저장할 규칙 본문.'),
  defaultPolicy: z.enum(['allow', 'deny']).optional().describe('access set-default 시 기본 정책.'),
  limit: z.number().int().min(1).max(500).optional().describe('list 계열 표시 개수.'),
} as const;

interface AdminArgs {
  area?: AdminArea;
  action?: string;
  [key: string]: unknown;
}

export async function runAdmin(args: AdminArgs): Promise<ToolReply> {
  return safe(async () => {
    const guide = await elicitMissing('admin', args as Record<string, unknown>, [
      { name: 'area', required: true, label: '영역', enumValues: ADMIN_AREAS },
      { name: 'slug', required: false, label: '대상 에이전트 (audit/gc 는 생략 가능)', candidates: slugCandidates },
    ]);
    if (guide) return guide;
    const area = args.area as AdminArea;

    // Validate the per-area action up front so a typo can't fall through a
    // sub-tool's switch into an undefined reply.
    const allowed = AREA_ACTIONS[area];
    if (allowed) {
      if (!args.action) {
        const menu = await elicitMissing(`admin ${area}`, {}, [
          { name: 'action', required: true, label: `${area} 동작`, enumValues: allowed },
        ]);
        if (menu) return menu;
      }
      if (args.action && !allowed.includes(args.action)) {
        return errorReply(`area=${area} 의 action 은 다음 중 하나여야 합니다: ${allowed.join(' | ')}.`);
      }
    }

    switch (area) {
      case 'access':
        return runAccess(args as never);
      case 'audit':
        return runAudit(args as never);
      case 'correct':
        return runCorrect(args as never);
      case 'version':
        return runVersion(args as never);
      case 'gc':
        return runGc(args as never);
      default:
        return errorReply(`Unknown area: ${String(area)}`);
    }
  });
}
