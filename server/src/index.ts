#!/usr/bin/env node
/**
 * Afterglow MCP server entry point.
 *
 * Speaks the Model Context Protocol over stdio so Claude Code can register it
 * via:
 *
 *   claude mcp add afterglow npx @daeseoksong/afterglow-mcp
 *
 * v0.13 consolidated the surface from 26 tools to 8 (features intact — the
 * former tools live on as actions; council folded into `ask` as multi-slug,
 * council_summary/recalibrate removed):
 *
 *   Core (the happy path — create → learn → ask):
 *   - afterglow_guide      (/afterglow guide)  — state-aware "what do I do?"
 *   - afterglow_create     (/afterglow create <slug> … [--signer])  — auto-inits; --signer activates
 *   - afterglow_learn      (/afterglow learn <slug> --path|--text|--url)  — add knowledge for ask
 *   - afterglow_ask        (/afterglow ask <slug>|--slugs a,b "...")  — persona Q&A (multi-slug = 합동)
 *
 *   Grouped:
 *   - afterglow_agent      — action: list|status|inspect|edit|sign|resume|archive|restore|history|init
 *   - afterglow_interview  — 인계자 인터뷰 16 actions + handoff-*(본인 셀프검수) 5 actions
 *   - afterglow_share      — action: export|import|verify (Ed25519 서명·검증 핫플러그)
 *   - afterglow_admin      — area: access|audit|correct|version|gc (+ area 별 action)
 *
 * `ask` / `interview gap-check` / `interview suggest-questions` do NOT call an
 * LLM. They return persona + RAG context (with the v0.12 grounding contract +
 * verdict) so Claude in the user's session composes the answer. RAG ranks with
 * BM25 (Korean particle-stripped), opt-in dense backend, hybrid RRF fusion.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { guideShape, runGuide } from './tools/guide.js';
import { createShape, runCreate, type CreateArgs } from './tools/create.js';
import { learnShape, runLearn } from './tools/learn.js';
import { askShape, runAsk } from './tools/ask.js';
import { agentShape, runAgent } from './tools/agent.js';
import { interviewShape, runInterview } from './tools/interview.js';
import { shareShape, runShare } from './tools/share.js';
import { adminShape, runAdmin } from './tools/admin.js';
import { registerPrompts } from './prompts.js';
import { errorReply, type ToolReply } from './tools/types.js';

const SERVER_VERSION = '0.13.0';

export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: 'afterglow-mcp',
      version: SERVER_VERSION,
    },
    {
      instructions:
        '퇴사자 에이전트 폴더(~/.claude/afterglow/)를 관리하는 MCP 서버. ' +
        '핵심 3단계: create(--signer 로 즉시 활성화) → learn(자료 추가) → ask(질문 · slugs 로 합동 질문). ' +
        '처음이면 guide. 그 외는 4개 묶음 — agent(목록·상세·수정·서명·보관·이력), ' +
        'interview(인계자 인터뷰 + handoff-* 본인 셀프검수), share(export/import/verify 이식), ' +
        'admin(access·audit·correct·version·gc 신뢰/감사). 필수 인자를 비우면 선택지로 안내합니다.',
    },
  );

  /* ---- core: the happy path ---- */

  server.registerTool(
    'afterglow_guide',
    {
      title: 'Afterglow — 빠른 시작 안내',
      description:
        '"방금 깔았는데 뭘 하면 되지?" 에 답하는 오리엔테이션. 현재 상태(미초기화 / 첫 에이전트 / 보유)에 맞춰 create → learn → ask 핵심 단계와 복붙 예시를 보여줍니다. 인자 없이 호출하세요.',
      inputSchema: guideShape,
    },
    wrap(runGuide),
  );

  server.registerTool(
    'afterglow_create',
    {
      title: 'Afterglow — 에이전트 만들기',
      description:
        '한 명의 퇴사자에 대한 폴더(agents/<slug>/)를 만듭니다. 미초기화 상태면 자동 init. signer 를 주면 만들면서 바로 동의 서명 → active (한 번에). 없으면 draft 로 남고 agent action:sign 필요.',
      inputSchema: createShape,
    },
    wrap<CreateArgs>(runCreate),
  );

  server.registerTool(
    'afterglow_learn',
    {
      title: 'Afterglow — 지식 학습 (자료 추가)',
      description:
        '에이전트의 knowledge/ 에 자료를 추가합니다 — ask 가 검색할 내용. --path(cwd 하위 파일/폴더), --text(붙여넣기), --url(가져오기) 중 하나. .md/.txt/.json/.jsonl/.csv 만 색인됩니다.',
      inputSchema: learnShape,
    },
    wrap(runLearn),
  );

  server.registerTool(
    'afterglow_ask',
    {
      title: 'Afterglow — 질문 (단독/합동)',
      description:
        '에이전트의 페르소나 + RAG 검색 + 근거 판정(할루시네이션 방지 contract)을 묶어 반환하고, Claude 가 그 컨텍스트로 답합니다 — 별도 모델 호출 없음. slugs 에 2명 이상 주면 합동 질문(구 council). active 에이전트만.',
      inputSchema: askShape,
    },
    wrap(runAsk),
  );

  /* ---- grouped ---- */

  server.registerTool(
    'afterglow_agent',
    {
      title: 'Afterglow — 에이전트 관리',
      description:
        '수명주기·관리 묶음. action=list(목록)|status(전체 대시보드)|inspect(상세)|edit(수정: 필드/에디터/재검증)|sign(동의 서명→active)|resume(재활성화)|archive(보관)|restore(복원)|history(대화·이벤트 로그)|init(수동 부트스트랩).',
      inputSchema: agentShape,
    },
    wrap(runAgent),
  );

  server.registerTool(
    'afterglow_interview',
    {
      title: 'Afterglow — 인터뷰 (다중 회차 + 본인 셀프검수)',
      description:
        '인계자 주도 다중 인터뷰: start(자동 질문 제안)·add-question·answer·gap-check·attach(음성/영상)·transcribe(WASM whisper)·export-sheet/import-answers(HTML 답변지)·finalize(이중 서명) 등. 퇴사자 본인 셀프검수는 handoff-start|review|status|finalize|abort.',
      inputSchema: interviewShape,
    },
    wrap(runInterview),
  );

  server.registerTool(
    'afterglow_share',
    {
      title: 'Afterglow — 이식 (핫플러그)',
      description:
        '에이전트 폴더를 다른 Afterglow 사용자에게 안전하게 전달. action=export(번들 생성 + Ed25519 서명)|import(반입 — 서명·무결성·인젝션 검증, 변조 시 거부)|verify(반입 전 읽기전용 검증).',
      inputSchema: shareShape,
    },
    wrap(runShare),
  );

  server.registerTool(
    'afterglow_admin',
    {
      title: 'Afterglow — 신뢰 · 감사 · 권한',
      description:
        '거버넌스 묶음. area=access(호출 권한 정책)|audit(SHA-256 체인 감사 로그 + checkpoint)|correct(보정·답변 회수 record-answer·데이터주체 data-subject-export)|version(스냅샷/diff/rollback/tag)|gc(보존 정리·GDPR purge, 기본 dry-run) + area 별 action.',
      inputSchema: adminShape,
    },
    wrap(runAdmin),
  );

  // Slash commands: /mcp__afterglow__<name> in Claude Code's prompt box.
  // Thin typed entry points that route to the tools above.
  registerPrompts(server);

  return server;
}

/**
 * Wrap a typed handler so any thrown error becomes a structured tool reply
 * instead of crashing the server. The runX functions already wrap with
 * safe(), but we double up here so MCP transport errors never surface as
 * un-handled rejections either.
 */
function wrap<TArgs>(handler: (args: TArgs) => Promise<ToolReply>) {
  // Param typed `unknown` so the callback stays assignable to every tool's
  // (partly-optional) input schema. Required-arg enforcement + friendly
  // elicitation happens inside each handler (tools/elicit.ts), not via zod —
  // that's what lets a missing arg return a guided choice list instead of a
  // raw SDK validation error.
  return async (args: unknown): Promise<ToolReply> => {
    try {
      return await handler(args as TArgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorReply(msg);
    }
  };
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio handler keeps the event loop alive; this never resolves normally.
}

// Run only when invoked as a script (not when imported by tests).
// pathToFileURL handles Windows/POSIX differences in file:// URLs.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((err) => {
    // Write to stderr; stdout is reserved for MCP frames.
    process.stderr.write(`[afterglow-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
