/**
 * MCP prompts — surfaced by Claude Code as slash commands
 * `/mcp__afterglow__<name>`. These DON'T do work themselves; each one expands
 * into a short user message that asks Claude to call the matching MCP tool
 * with the arguments the user filled in.
 *
 * v0.13: the slash list mirrors the consolidated 8-tool surface — the four
 * happy-path verbs plus the four grouped tools. Tools remain the source of
 * truth; prompts are thin, typed entry points.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Build a GetPromptResult that injects one user-turn instruction. */
function ask(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Render `key="value"` pairs, skipping undefined/empty optionals. */
function kv(pairs: Record<string, string | undefined>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '″')}"`)
    .join(', ');
}

export function registerPrompts(server: McpServer): void {
  /* ---- the happy path ---- */

  server.registerPrompt(
    'guide',
    {
      title: 'Afterglow: 빠른 시작',
      description: '뭘 하면 되는지 상태별 안내 (afterglow_guide)',
      argsSchema: { slug: z.string().optional().describe('특정 에이전트 맞춤 안내 (선택)') },
    },
    async ({ slug }) => ask(`Afterglow \`afterglow_guide\` 도구를 호출해줘${slug ? `: ${kv({ slug })}` : '.'}`),
  );

  server.registerPrompt(
    'create',
    {
      title: 'Afterglow: 에이전트 생성',
      description: '퇴사자 에이전트 생성 — 자동 init, signer 주면 바로 active (afterglow_create)',
      argsSchema: {
        slug: z.string().describe('짧은 식별자 (소문자/숫자/하이픈). 예: jiyoon'),
        name: z.string().describe('실제 이름. 예: 이지윤'),
        role: z.string().describe('직무 / 부서'),
        signer: z.string().optional().describe('주면 만들면서 바로 서명·활성화 (선택)'),
        tenure: z.string().optional().describe('재직 기간 (선택)'),
        bio: z.string().optional().describe('한 줄 소개 (선택)'),
      },
    },
    async ({ slug, name, role, signer, tenure, bio }) =>
      ask(`Afterglow \`afterglow_create\` 도구를 호출해줘: ${kv({ slug, name, role, signer, tenure, bio })}`),
  );

  server.registerPrompt(
    'learn',
    {
      title: 'Afterglow: 지식 학습',
      description: 'knowledge/ 에 자료 추가 — ask 가 검색할 내용 (afterglow_learn)',
      argsSchema: {
        slug: z.string().describe('대상 slug'),
        path: z.string().optional().describe('cwd 하위 파일/폴더 (선택)'),
        text: z.string().optional().describe('붙여넣을 지식 본문 (선택)'),
        url: z.string().optional().describe('가져올 URL (선택)'),
        title: z.string().optional().describe('text/url 저장 제목 (선택)'),
      },
    },
    async ({ slug, path, text, url, title }) =>
      ask(`Afterglow \`afterglow_learn\` 도구를 호출해줘: ${kv({ slug, path, text, url, title })}`),
  );

  server.registerPrompt(
    'ask',
    {
      title: 'Afterglow: 질문',
      description: '페르소나로 질문 — slugs 콤마 구분 2명+ 이면 합동 질문 (afterglow_ask)',
      argsSchema: {
        slug: z.string().describe('대상 slug (여러 명이면 콤마로: jiyoon,jaehoon)'),
        question: z.string().describe('질문'),
      },
    },
    async ({ slug, question }) => {
      const many = (slug ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return many.length >= 2
        ? ask(`Afterglow \`afterglow_ask\` 도구를 slugs=[${many.map((s) => `"${s}"`).join(', ')}] 로 호출해줘: ${kv({ question })}`)
        : ask(`Afterglow \`afterglow_ask\` 도구를 호출해줘: ${kv({ slug, question })}`);
    },
  );

  /* ---- grouped ---- */

  server.registerPrompt(
    'agent',
    {
      title: 'Afterglow: 에이전트 관리',
      description: 'list·status·inspect·edit·sign·resume·archive·restore·history·init (afterglow_agent)',
      argsSchema: {
        action: z.string().describe('list | status | inspect | edit | sign | resume | archive | restore | history | init'),
        slug: z.string().optional().describe('대상 slug (list/status/init 외 필수)'),
        signer: z.string().optional().describe('sign 시 서명자 (선택)'),
      },
    },
    async ({ action, slug, signer }) =>
      ask(`Afterglow \`afterglow_agent\` 도구를 호출해줘: ${kv({ action, slug, signer })}`),
  );

  server.registerPrompt(
    'interview',
    {
      title: 'Afterglow: 인터뷰 / 셀프검수',
      description: '인계자 인터뷰(start·answer·attach·전사·답변지…) + 본인 셀프검수 handoff-* (afterglow_interview)',
      argsSchema: {
        slug: z.string().describe('대상 slug'),
        action: z.string().describe('start | add-question | answer | gap-check | attach | transcribe | export-sheet | import-answers | finalize | … | handoff-start | handoff-review | handoff-finalize'),
        session: z.string().optional().describe('회차 id (선택)'),
        title: z.string().optional().describe('start 시 회차 제목 (선택)'),
        interviewer: z.string().optional().describe('start 시 진행자 (선택)'),
      },
    },
    async ({ slug, action, session, title, interviewer }) =>
      ask(`Afterglow \`afterglow_interview\` 도구를 호출해줘: ${kv({ slug, action, session, title, interviewer })}`),
  );

  server.registerPrompt(
    'share',
    {
      title: 'Afterglow: 이식 (핫플러그)',
      description: 'export(서명 번들) · import(검증 반입) · verify(사전 검증) (afterglow_share)',
      argsSchema: {
        action: z.string().describe('export | import | verify'),
        slugs: z.string().optional().describe('export 시 내보낼 slug 들 (콤마, 선택 — all 도 가능)'),
        input: z.string().optional().describe('import/verify 시 번들 경로 (선택)'),
      },
    },
    async ({ action, slugs, input }) =>
      ask(`Afterglow \`afterglow_share\` 도구를 호출해줘: ${kv({ action, slugs, input })}`),
  );

  server.registerPrompt(
    'admin',
    {
      title: 'Afterglow: 신뢰 · 감사 · 권한',
      description: 'access(권한) · audit(감사) · correct(보정·회수) · version(스냅샷) · gc(정리) (afterglow_admin)',
      argsSchema: {
        area: z.string().describe('access | audit | correct | version | gc'),
        action: z.string().optional().describe('area 별 동작 (audit 는 생략)'),
        slug: z.string().optional().describe('대상 slug (선택)'),
      },
    },
    async ({ area, action, slug }) =>
      ask(`Afterglow \`afterglow_admin\` 도구를 호출해줘: ${kv({ area, action, slug })}`),
  );
}
