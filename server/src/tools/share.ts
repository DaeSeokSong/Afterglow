import { z } from 'zod';
import { exportShape, runExport } from './export.js';
import { importShape, runImport } from './import.js';
import { runVerify } from './verify.js';
import { elicitMissing } from './elicit.js';
import { errorReply, safe, type ToolReply } from './types.js';

/**
 * `afterglow_share` — the consolidated hot-plug tool (v0.13). One tool
 * replaces export / import / verify: sign-and-bundle agents for another
 * Afterglow user, ingest a received bundle (Ed25519 signature + integrity
 * checks), or dry-run-verify one before trusting it. Thin router — each
 * action delegates to the original implementation unchanged.
 */

export const SHARE_ACTIONS = ['export', 'import', 'verify'] as const;
type ShareAction = (typeof SHARE_ACTIONS)[number];

export const shareShape = {
  ...exportShape,
  ...importShape,
  action: z
    .enum(SHARE_ACTIONS)
    .optional()
    .describe('(필수) export(번들 내보내기·서명) | import(받은 번들 반입·검증) | verify(반입 전 읽기전용 검증).'),
  input: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe('import/verify 시 (필수) 번들 폴더 또는 단일 에이전트 폴더 경로.'),
} as const;

interface ShareArgs {
  action?: ShareAction;
  [key: string]: unknown;
}

export async function runShare(args: ShareArgs): Promise<ToolReply> {
  return safe(async () => {
    const guide = await elicitMissing('share', args as Record<string, unknown>, [
      { name: 'action', required: true, label: '동작', enumValues: SHARE_ACTIONS },
    ]);
    if (guide) return guide;
    switch (args.action) {
      case 'export':
        return runExport(args as never);
      case 'import':
        return runImport(args as never);
      case 'verify':
        return runVerify(args as never);
      default:
        return errorReply(`Unknown action: ${String(args.action)}`);
    }
  });
}
