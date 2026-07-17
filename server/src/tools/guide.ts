import { z } from 'zod';
import { isInitialized, readRegistry } from '../storage.js';
import { sanitisePromptLine } from '../sanitize.js';
import { safe, type ToolReply } from './types.js';

export const guideShape = {
  slug: z.string().min(1).optional().describe('특정 에이전트에 맞춘 다음 단계를 보고 싶을 때 그 slug.'),
} as const;

interface GuideArgs {
  slug?: string;
}

/**
 * Zero-friction orientation. Unlike `status` (a dashboard of every agent),
 * `guide` answers "I just installed this — what do I actually do?" and adapts
 * to the current state: not-initialized → first agent → has agents. Surfaces
 * only the 4 commands that matter for the happy path (create → learn → sign →
 * ask) so a new user isn't staring at 26 tools.
 */
export async function runGuide(args: GuideArgs): Promise<ToolReply> {
  return safe(async () => {
    const inited = await isInitialized();
    const reg = inited ? await readRegistry().catch(() => ({ version: 1 as const, agents: [] })) : { version: 1 as const, agents: [] };
    const agents = reg.agents;

    const L: string[] = [];
    L.push('# Afterglow — 빠른 시작');
    L.push('');
    L.push('퇴사한 동료의 자료를 한 폴더에 모아 그 사람처럼 답하는 에이전트를 만듭니다. 모델 학습 없음 · 추가 비용 0.');
    L.push('');
    L.push('핵심 흐름은 3단계뿐입니다:  **create → learn → ask**');
    L.push('  1) create  — 에이전트 만들기 (--signer 를 주면 동의 서명까지 한 번에)');
    L.push('  2) learn   — 그 사람의 자료(문서·메모·붙여넣기 텍스트)를 넣기');
    L.push('  3) ask     — 그 사람의 지식·톤으로 질문 (자료에 없는 건 지어내지 않고 "없다"고 답함)');
    L.push('');

    if (agents.length === 0) {
      L.push('## 지금 바로 (복붙해서 시작)');
      L.push('```');
      L.push('/afterglow create jiyoon --name "이지윤" --role "프로덕트 디자이너" --signer "이지윤"');
      L.push('/afterglow learn  jiyoon --text "온보딩 step2 설명을 절반으로 줄여 이탈을 22%→9% 로 낮췄다."');
      L.push('/afterglow ask    jiyoon "온보딩 이탈 어떻게 줄였어요?"');
      L.push('```');
      L.push('  · `--signer` 를 같이 주면 만들면서 바로 활성화됩니다 (create + sign 한 번에).');
      L.push('  · init 은 필요 없어요 — create 가 알아서 초기화합니다.');
      L.push('  · 자료가 파일로 있으면: `/afterglow learn jiyoon --path ./notes/`  (cwd 하위 폴더/파일).');
      L.push('');
      L.push('자연어로도 됩니다: "afterglow로 이지윤 프로덕트 디자이너 에이전트 만들어줘" 라고만 해도 Claude 가 위 흐름을 실행합니다.');
    } else {
      L.push(`## 등록된 에이전트 (${agents.length})`);
      for (const a of agents.slice(0, 8)) {
        const tag = a.status === 'active' ? '● active' : a.status === 'archived' ? '▣ archived' : `○ ${a.status}`;
        L.push(`  · ${a.slug.padEnd(16)} ${sanitisePromptLine(a.name, 24).padEnd(26)} ${tag}`);
      }
      if (agents.length > 8) L.push(`  … 외 ${agents.length - 8}개 ( agent action:list )`);
      L.push('');
      const target = (args.slug && agents.find((a) => a.slug === args.slug)) || agents.find((a) => a.status === 'active') || agents[0];
      const s = target.slug;
      const active = target.status === 'active';
      L.push(`## 다음 단계 — ${s} (${sanitisePromptLine(target.name, 24)})`);
      if (!active) {
        L.push(`  이 에이전트는 아직 ${target.status} 입니다. ask 하려면 서명이 필요해요:`);
        L.push(`    /afterglow agent --action sign --slug ${s} --signer "이름"`);
      }
      L.push(`  자료 더 넣기:   /afterglow learn ${s} --path ./<폴더>   또는   --text "<붙여넣기>"`);
      L.push(`  질문하기:       /afterglow ask   ${s} "..."   (여러 명 합동: slugs 에 2명+)`);
      L.push(`  상세/현황:      /afterglow agent --action inspect --slug ${s}   ·   agent --action status`);
    }

    L.push('');
    L.push('## 도구는 8개뿐 (필수 인자를 비우면 자동으로 안내)');
    L.push('  · guide · create · learn · ask — 핵심 4개 (위 흐름)');
    L.push('  · agent     — 관리: list·status·inspect·edit·sign·resume·archive·restore·history');
    L.push('  · interview — 인계자 인터뷰(회차·답변지·전사) + handoff-* 본인 셀프검수');
    L.push('  · share     — 이식: export(서명 번들)·import(검증 반입)·verify');
    L.push('  · admin     — 신뢰/감사: access·audit·correct·version·gc');
    return { content: [{ type: 'text', text: L.join('\n') }] };
  });
}
