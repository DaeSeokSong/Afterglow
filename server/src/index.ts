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
 * v0.14 usability pass (patterns borrowed from the highest-starred MCP
 * servers — playwright-mcp, github-mcp-server, context7):
 *   - per-tool MCP annotations (readOnlyHint / destructiveHint / idempotent /
 *     openWorld) so clients can relax approval prompts for read-only calls
 *   - English-first one-line tool descriptions (Korean glosses kept) for
 *     better LLM tool routing; user-facing OUTPUT stays Korean
 *   - AFTERGLOW_TOOLSETS=core|all (or --toolsets core) to expose only the
 *     4 happy-path tools — fewer tools helps tool choice and trims context
 *   - --version / --help CLI flags (npx no longer silently hangs)
 *   - prompt-argument completions (see prompts.ts)
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

const SERVER_VERSION = '0.14.0';

export type Toolset = 'core' | 'all';

/** Resolve the active toolset: --toolsets flag wins, then env, default all.
 *  Unknown values fall back to 'all' (never silently hide tools by typo). */
export function resolveToolset(argv: readonly string[] = process.argv.slice(2), env = process.env): Toolset {
  let raw = env.AFTERGLOW_TOOLSETS ?? '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--toolsets' && argv[i + 1]) raw = argv[i + 1];
    else if (a.startsWith('--toolsets=')) raw = a.slice('--toolsets='.length);
  }
  return raw.trim().toLowerCase() === 'core' ? 'core' : 'all';
}

export function buildServer(toolset: Toolset = resolveToolset()): McpServer {
  const server = new McpServer(
    {
      name: 'afterglow-mcp',
      version: SERVER_VERSION,
    },
    {
      instructions:
        'Afterglow turns a departing teammate into a persona+RAG agent stored under ~/.claude/afterglow/. ' +
        'Happy path (3 steps, no init): afterglow_create (pass signer to activate immediately) → afterglow_learn (add knowledge) → afterglow_ask (query; slugs=[a,b] for a joint session). ' +
        'First time? Call afterglow_guide. Everything else is grouped: afterglow_agent (list/status/inspect/edit/sign/resume/archive/restore/history/init), ' +
        'afterglow_interview (successor interviews + handoff-* self-review), afterglow_share (export/import/verify hot-plug), ' +
        'afterglow_admin (access/audit/correct/version/gc governance). ' +
        'Omitted required arguments return a numbered menu — call with what you have instead of guessing. ' +
        '한국어: 핵심 3단계 create → learn → ask. 필수 인자를 비우면 선택지로 안내합니다.',
    },
  );

  /* ---- core: the happy path ---- */

  server.registerTool(
    'afterglow_guide',
    {
      title: 'Afterglow — 빠른 시작 안내',
      description:
        'State-aware orientation for Afterglow ("what do I do next?") — shows the create → learn → ask steps with copy-paste examples for the current state. Call with no arguments. (뭐부터 하지? 상태별 안내)',
      inputSchema: guideShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(runGuide),
  );

  server.registerTool(
    'afterglow_create',
    {
      title: 'Afterglow — 에이전트 만들기',
      description:
        'Create a departing-teammate agent folder (agents/<slug>/). Auto-initializes the store; pass signer to sign consent and activate in the same call, otherwise the agent stays draft until agent action:sign. (퇴사자 에이전트 생성 — 자동 init, signer 로 즉시 active)',
      inputSchema: createShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap<CreateArgs>(runCreate),
  );

  server.registerTool(
    'afterglow_learn',
    {
      title: 'Afterglow — 지식 학습 (자료 추가)',
      description:
        "Add knowledge the agent's ask will retrieve — one of path (file/folder under cwd), text (paste), or url. Only .md/.txt/.json/.jsonl/.csv are indexed. (knowledge/ 에 자료 추가 — ask 가 검색)",
      inputSchema: learnShape,
      // openWorldHint: url mode fetches from the web.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(runLearn),
  );

  server.registerTool(
    'afterglow_ask',
    {
      title: 'Afterglow — 질문 (단독/합동)',
      description:
        "Query an agent: returns the persona + RAG retrieval + grounding verdict (anti-hallucination contract) as a context bundle Claude answers from — no extra LLM call. Pass slugs=[a,b] (2–6) for a joint session. Active agents only. (페르소나로 질문 — slugs 면 합동, 근거 없으면 거절)",
      inputSchema: askShape,
      // Writes only its own history/audit log lines — semantically a query.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(runAsk),
  );

  /* ---- grouped ---- */

  if (toolset === 'all') {
    server.registerTool(
      'afterglow_agent',
      {
        title: 'Afterglow — 에이전트 관리',
        description:
          'Agent lifecycle + daily management. action = list | status (dashboard) | inspect | edit (fields/editor/revalidate) | sign (consent → active) | resume | archive | restore | history | init. (수명주기·관리 묶음)',
        inputSchema: agentShape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      wrap(runAgent),
    );

    server.registerTool(
      'afterglow_interview',
      {
        title: 'Afterglow — 인터뷰 (다중 회차 + 본인 셀프검수)',
        description:
          "Successor-driven interviews: start (auto question suggestions) · add-question · answer · gap-check · attach (audio/video) · transcribe (WASM whisper) · export-sheet / import-answers (HTML answer sheet; pre-v0.13 legacy sheets accepted) · finalize (dual signature). The departing person's self-review: handoff-start | handoff-review | handoff-status | handoff-finalize | handoff-abort. (인계자 인터뷰 + 본인 셀프검수)",
        inputSchema: interviewShape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      wrap(runInterview),
    );

    server.registerTool(
      'afterglow_share',
      {
        title: 'Afterglow — 이식 (핫플러그)',
        description:
          'Hand agents to another Afterglow user. action = export (bundle + Ed25519 signature) | import (verifies signature/integrity/injection — tampered bundles refused) | verify (read-only pre-flight). (에이전트 폴더 안전 전달)',
        inputSchema: shareShape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      wrap(runShare),
    );

    server.registerTool(
      'afterglow_admin',
      {
        title: 'Afterglow — 신뢰 · 감사 · 권한',
        description:
          'Governance. area = access (call policy) | audit (hash-chained log + checkpoints) | correct (feedback · record-answer · data-subject-export) | version (snapshots/diff/rollback/tag) | gc (retention purge, dry-run by default) + per-area action. (거버넌스 묶음 — gc apply 는 영구 삭제)',
        inputSchema: adminShape,
        // gc --apply hard-deletes; version rollback rewrites persona.
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      wrap(runAdmin),
    );
  }

  // Slash commands: /mcp__afterglow__<name> in Claude Code's prompt box.
  // Thin typed entry points that route to the tools above (with argument
  // completions — see prompts.ts).
  registerPrompts(server, toolset);

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

const HELP = `afterglow-mcp ${SERVER_VERSION} — Afterglow MCP server (stdio)

Turn a departing teammate into a persona+RAG agent inside Claude Code.

Usage:
  afterglow-mcp                 start the MCP server on stdio (what clients run)
  afterglow-mcp --version       print the version and exit
  afterglow-mcp --help          this help

Options:
  --toolsets <core|all>         core = only guide/create/learn/ask (default: all)
                                (or env AFTERGLOW_TOOLSETS=core)

Install (Claude Code):
  claude mcp add afterglow npx -y @daeseoksong/afterglow-mcp

Other clients (Claude Desktop / Cursor / VS Code / Windsurf …):
  https://github.com/DaeSeokSong/Afterglow/tree/main/server#readme
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const server = buildServer(resolveToolset(argv));
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
