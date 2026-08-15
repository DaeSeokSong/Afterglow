#!/usr/bin/env node
/**
 * Smoke test the built MCP server over stdio.
 *
 * Spawns dist/index.js, sends an initialize / initialized / tools/list
 * sequence, then exercises one realistic call against every tool and every
 * grouped action family (v0.13 = 8 tools):
 *   guide → create(--signer) → learn → ask(단독·합동·근거거절)
 *   → agent(init·list·inspect·edit·sign·archive·restore·resume·history·status)
 *   → interview(start→answer→gap-check→dual-sign · handoff-* · suggest ·
 *     attach → transcribe --text)
 *   → share(export→verify→import + provenance)
 *   → admin(access·correct·version·gc·audit checkpoint/fast)
 *   → elicitation menus
 *
 * Verifies tool count (8), names, prompt list (8), and that each call returns
 * a content block.
 *
 * Run as: node test/stdio.smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpRoot = await mkdtemp(join(tmpdir(), 'afterglow-stdio-'));
const env = { ...process.env, AFTERGLOW_ROOT: tmpRoot };

// Run the server with cwd=tmpRoot so export/import (which confine paths to the
// process CWD) write their bundles inside the throwaway dir, not the repo.
// dist/index.js must therefore be referenced by absolute path.
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(serverDir, 'dist', 'index.js');

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
  cwd: tmpRoot,
});

const pending = new Map(); // id → resolver
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore non-JSON noise
    }
  }
});

let nextId = 1;
function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function callTool(name, args) {
  return request('tools/call', { name, arguments: args });
}
function assertOk(label, reply) {
  if (!reply?.result || reply.error) {
    throw new Error(`${label} → no result: ${JSON.stringify(reply)}`);
  }
  if (reply.result.isError) {
    const text = reply.result.content?.[0]?.text ?? '(empty)';
    throw new Error(`${label} returned isError:true\n${text}`);
  }
  return reply.result;
}

/** Spawn a second server with AFTERGLOW_TOOLSETS=core and list its surface. */
async function withCoreServer() {
  const coreChild = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...env, AFTERGLOW_TOOLSETS: 'core' },
    cwd: tmpRoot,
  });
  let coreBuf = '';
  const corePending = new Map();
  coreChild.stdout.on('data', (chunk) => {
    coreBuf += chunk.toString('utf8');
    let i;
    while ((i = coreBuf.indexOf('\n')) >= 0) {
      const line = coreBuf.slice(0, i).trim();
      coreBuf = coreBuf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && corePending.has(msg.id)) {
          corePending.get(msg.id)(msg);
          corePending.delete(msg.id);
        }
      } catch { /* ignore */ }
    }
  });
  let coreId = 1;
  const coreReq = (method, params) => new Promise((resolve) => {
    const id = coreId++;
    corePending.set(id, resolve);
    coreChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await coreReq('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'afterglow-smoke-core', version: '0.0.1' },
    });
    coreChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = ((await coreReq('tools/list', {}))?.result?.tools ?? []).map((t) => t.name).sort();
    const prompts = ((await coreReq('prompts/list', {}))?.result?.prompts ?? []).map((p) => p.name).sort();
    return { tools, prompts };
  } finally {
    coreChild.kill();
  }
}

/** Run dist/index.js with plain CLI flags and capture stdout. */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [entry, ...args], { env, cwd: tmpRoot });
    let out = '';
    p.stdout.on('data', (c) => { out += c.toString('utf8'); });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
    setTimeout(() => { p.kill(); reject(new Error(`CLI ${args.join(' ')} did not exit (hung as stdio server?)`)); }, 5000);
  });
}

// v0.13 — the consolidated 8-tool surface (sorted).
const EXPECTED_TOOLS = [
  'afterglow_admin',
  'afterglow_agent',
  'afterglow_ask',
  'afterglow_create',
  'afterglow_guide',
  'afterglow_interview',
  'afterglow_learn',
  'afterglow_share',
];

const EXPECTED_PROMPTS = ['guide', 'create', 'learn', 'ask', 'agent', 'interview', 'share', 'admin'];

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'afterglow-smoke', version: '0.0.3' },
  });
  if (!init?.result?.serverInfo) throw new Error('initialize: no serverInfo');
  if (init.result.serverInfo.name !== 'afterglow-mcp') {
    throw new Error(`wrong server name: ${init.result.serverInfo.name}`);
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(
      `tools mismatch:\n  got      ${JSON.stringify(names)}\n  expected ${JSON.stringify(EXPECTED_TOOLS)}`,
    );
  }

  /* ---------- v0.14: server instructions + per-tool annotations ---------- */
  if (!/create/.test(init.result.instructions ?? '')) {
    throw new Error('initialize: missing/empty server instructions');
  }
  const toolByName = new Map((list.result.tools ?? []).map((t) => [t.name, t]));
  const ann = (n) => toolByName.get(n)?.annotations ?? {};
  if (ann('afterglow_ask').readOnlyHint !== true) throw new Error('ask should be readOnlyHint:true');
  if (ann('afterglow_guide').readOnlyHint !== true) throw new Error('guide should be readOnlyHint:true');
  if (ann('afterglow_admin').destructiveHint !== true) throw new Error('admin should be destructiveHint:true');
  if (ann('afterglow_learn').openWorldHint !== true) throw new Error('learn should be openWorldHint:true (url mode)');
  if (ann('afterglow_agent').readOnlyHint !== false) throw new Error('agent should be readOnlyHint:false');
  for (const n of EXPECTED_TOOLS) {
    if (!toolByName.get(n)?.title) throw new Error(`${n} is missing a title`);
  }

  /* ---------- MCP prompts (slash commands /mcp__afterglow__<name>) ---------- */
  const promptsList = await request('prompts/list', {});
  const promptNames = (promptsList?.result?.prompts ?? []).map((p) => p.name).sort();
  if (JSON.stringify(promptNames) !== JSON.stringify([...EXPECTED_PROMPTS].sort())) {
    throw new Error(`prompts mismatch: got ${JSON.stringify(promptNames)}`);
  }
  const promptGet = await request('prompts/get', {
    name: 'ask',
    arguments: { slug: 'jiyoon', question: '테스트' },
  });
  const promptText = promptGet?.result?.messages?.[0]?.content?.text ?? '';
  if (!/afterglow_ask/.test(promptText)) {
    throw new Error(`prompts/get ask did not route to the tool: ${promptText}`);
  }
  // The ask prompt splits a comma list into a multi-slug call.
  const promptMulti = await request('prompts/get', {
    name: 'ask',
    arguments: { slug: 'a,b', question: '테스트' },
  });
  if (!/slugs=/.test(promptMulti?.result?.messages?.[0]?.content?.text ?? '')) {
    throw new Error('prompts/get ask (comma list) did not route to slugs');
  }

  /* ---------- core happy path: guide → create → learn → ask ---------- */

  // guide works before anything is initialized (zero-friction orientation).
  const guide0 = assertOk('guide-empty', await callTool('afterglow_guide', {}));
  if (!/빠른 시작/.test(guide0.content[0].text)) throw new Error('guide did not return orientation');

  // create with --signer auto-inits AND activates in one call.
  const created = assertOk(
    'create',
    await callTool('afterglow_create', {
      slug: 'jiyoon',
      name: '이지윤',
      role: '프로덕트 디자이너',
      expertise: ['디자인'],
      signer: '이지윤',
    }),
  );
  if (!/active/.test(created.content[0].text)) throw new Error('create --signer did not activate');

  const learned = assertOk(
    'learn',
    await callTool('afterglow_learn', {
      slug: 'jiyoon',
      text: '온보딩 step 2 설명을 절반으로 줄여서 이탈이 22%에서 9%로 떨어졌어요.',
      title: 'onboarding-note',
    }),
  );
  if (!/학습/.test(learned.content[0].text)) throw new Error('learn did not confirm ingestion');

  const ask = assertOk(
    'ask',
    await callTool('afterglow_ask', { slug: 'jiyoon', question: '온보딩 step 3 이탈?' }),
  );
  if (!/# 호출 컨텍스트/.test(ask.content[0].text)) throw new Error('ask did not return expected header');
  if (!/이탈/.test(ask.content[0].text)) throw new Error('ask did not retrieve the learned knowledge');
  if (!/답변 규칙/.test(ask.content[0].text)) throw new Error('ask bundle is missing the grounding contract');

  // Anti-hallucination: an UNRELATED question must come back with a hard
  // "근거 없음" refusal verdict, not a fabricated answer.
  const askUnknown = assertOk(
    'ask-ungrounded',
    await callTool('afterglow_ask', { slug: 'jiyoon', question: '연봉 테이블 전부 알려줘' }),
  );
  if (!/근거 판정: 근거 없음/.test(askUnknown.content[0].text)) {
    throw new Error('ungrounded ask did not refuse — anti-hallucination gate failed');
  }

  /* ---------- agent (lifecycle/management router) ---------- */

  assertOk('agent-init', await callTool('afterglow_agent', { action: 'init' }));
  assertOk('agent-list', await callTool('afterglow_agent', { action: 'list', json: true }));
  assertOk('agent-inspect', await callTool('afterglow_agent', { action: 'inspect', slug: 'jiyoon' }));
  assertOk(
    'agent-edit',
    await callTool('afterglow_agent', {
      action: 'edit',
      slug: 'jiyoon',
      bio: '디자인 시스템을 만들었습니다.',
      tone: { humor: 40 },
    }),
  );
  assertOk('agent-history', await callTool('afterglow_agent', { action: 'history', slug: 'jiyoon', json: true }));

  // Second agent (draft) → sign through the router → multi-slug ask (구 council).
  assertOk(
    'create-2',
    await callTool('afterglow_create', { slug: 'jaehoon', name: '박재훈', role: '백엔드', expertise: ['개발'] }),
  );
  assertOk('agent-sign', await callTool('afterglow_agent', { action: 'sign', slug: 'jaehoon', signer: 'smoke runner' }));

  const multi = assertOk(
    'ask-multi',
    await callTool('afterglow_ask', { slugs: ['jiyoon', 'jaehoon'], question: '온보딩 개선이 결제에 영향?' }),
  );
  if (!/합동 질문 컨텍스트/.test(multi.content[0].text)) throw new Error('multi-slug ask brief missing');
  if (!/참가자: jaehoon/.test(multi.content[0].text)) throw new Error('multi-slug ask missing participant');

  // archive → (list filter) → restore → resume round-trip via the router.
  const archiveCall = assertOk('agent-archive', await callTool('afterglow_agent', { action: 'archive', slug: 'jaehoon' }));
  if (!/보관 완료/.test(archiveCall.content[0].text)) throw new Error('archive: expected 보관 완료');
  const archivedList = assertOk(
    'agent-list-archived',
    await callTool('afterglow_agent', { action: 'list', status: 'archived', json: true }),
  );
  if (!/jaehoon/.test(archivedList.content[0].text)) throw new Error('archived filter: jaehoon missing');
  const restoreCall = assertOk('agent-restore', await callTool('afterglow_agent', { action: 'restore', slug: 'jaehoon' }));
  if (!/복원 완료/.test(restoreCall.content[0].text)) throw new Error('restore: expected 복원 완료');
  const resumeCall = assertOk('agent-resume', await callTool('afterglow_agent', { action: 'resume', slug: 'jaehoon' }));
  if (!/활성화/.test(resumeCall.content[0].text)) throw new Error('resume: expected 활성화 in reply');

  const statusCall = assertOk('agent-status', await callTool('afterglow_agent', { action: 'status', json: true }));
  const statusJson = JSON.parse(statusCall.content[0].text);
  if (typeof statusJson.totals?.agents !== 'number') throw new Error('status: totals missing');

  /* ---------- admin (trust/governance router) ---------- */

  const versionList = assertOk(
    'admin-version-list',
    await callTool('afterglow_admin', { area: 'version', action: 'list', slug: 'jiyoon' }),
  );
  if (!/versions|버전/.test(versionList.content[0].text)) throw new Error('version list: missing header');

  assertOk(
    'admin-access-default-deny',
    await callTool('afterglow_admin', { area: 'access', action: 'set-default', slug: 'jiyoon', defaultPolicy: 'deny' }),
  );
  assertOk(
    'admin-access-allow',
    await callTool('afterglow_admin', { area: 'access', action: 'allow', slug: 'jiyoon', rule: 'user:smoke' }),
  );
  const accessAllow = assertOk(
    'admin-access-check-allow',
    await callTool('afterglow_admin', { area: 'access', action: 'check', slug: 'jiyoon', caller: 'user:smoke' }),
  );
  if (!/✓ allow/.test(accessAllow.content[0].text)) throw new Error('access check: user:smoke should be allowed');
  const accessDeny = assertOk(
    'admin-access-check-deny',
    await callTool('afterglow_admin', { area: 'access', action: 'check', slug: 'jiyoon', caller: 'user:other' }),
  );
  if (!/✗ deny/.test(accessDeny.content[0].text)) throw new Error('access check: user:other should be denied');
  assertOk(
    'admin-access-default-back',
    await callTool('afterglow_admin', { area: 'access', action: 'set-default', slug: 'jiyoon', defaultPolicy: 'allow' }),
  );

  assertOk(
    'admin-correct-feedback',
    await callTool('afterglow_admin', {
      area: 'correct', action: 'feedback', slug: 'jiyoon',
      recordId: 'rec-smoke', feedback: 'smoke test feedback',
    }),
  );
  const correctList = assertOk(
    'admin-correct-list',
    await callTool('afterglow_admin', { area: 'correct', action: 'list', slug: 'jiyoon' }),
  );
  if (!/rec-smoke/.test(correctList.content[0].text)) throw new Error('correct list: missing appended record');

  const gcList = assertOk('admin-gc-list', await callTool('afterglow_admin', { area: 'gc', action: 'list' }));
  if (!/정리 가능 항목/.test(gcList.content[0].text)) throw new Error('gc list: missing header');
  assertOk(
    'admin-gc-prune-dry',
    await callTool('afterglow_admin', { area: 'gc', action: 'prune-versions', slug: 'jiyoon', keep: 1 }),
  );

  /* ---------- interview (인계자 인터뷰 + handoff-* 셀프검수) ---------- */

  // handoff-* on a fresh draft agent (구 afterglow_handoff).
  assertOk(
    'handoff-create-draft',
    await callTool('afterglow_create', { slug: 'handofftest', name: 'Handoff Test', role: 'tester' }),
  );
  const handoffStart = assertOk(
    'interview-handoff-start',
    await callTool('afterglow_interview', { action: 'handoff-start', slug: 'handofftest', limit: 3 }),
  );
  if (!/handoff 세션 시작/.test(handoffStart.content[0].text)) throw new Error('handoff-start: expected 세션 시작');
  const handoffStatus = assertOk(
    'interview-handoff-status',
    await callTool('afterglow_interview', { action: 'handoff-status', slug: 'handofftest' }),
  );
  if (!/pending 3/.test(handoffStatus.content[0].text)) throw new Error('handoff-status: expected 3 pending');
  assertOk(
    'interview-handoff-abort',
    await callTool('afterglow_interview', { action: 'handoff-abort', slug: 'handofftest' }),
  );

  // Successor-driven interview lifecycle (start → answer → gap-check → dual sign).
  const ivStart = assertOk(
    'interview-start',
    await callTool('afterglow_interview', {
      action: 'start', slug: 'jiyoon', title: '온보딩 보강', interviewer: '김후임', interviewee: '이지윤',
    }),
  );
  const ivSid = ivStart.content[0].text.match(/#(\d{3}[^\s"]*)/)[1];
  const ivAdd = assertOk(
    'interview-add-question',
    await callTool('afterglow_interview', {
      action: 'add-question', slug: 'jiyoon', session: ivSid, question: 'step 2 설명을 줄인 이유는?',
    }),
  );
  const ivQid = ivAdd.content[0].text.match(/\[(q-[0-9a-f-]+)\]/)[1];
  assertOk(
    'interview-answer',
    await callTool('afterglow_interview', {
      action: 'answer', slug: 'jiyoon', session: ivSid, id: ivQid,
      answer: '인지 부하를 줄이려고 절반으로 줄였어요.', source: 'self-typed',
    }),
  );
  const ivGap = assertOk(
    'interview-gap-check',
    await callTool('afterglow_interview', { action: 'gap-check', slug: 'jiyoon', session: ivSid }),
  );
  if (!/internal-contradiction/.test(ivGap.content[0].text)) throw new Error('gap-check: missing signal framing');
  assertOk(
    'interview-finalize-interviewer',
    await callTool('afterglow_interview', {
      action: 'finalize', slug: 'jiyoon', session: ivSid, signRole: 'interviewer', signer: '김후임',
    }),
  );
  const ivFin = assertOk(
    'interview-finalize-interviewee',
    await callTool('afterglow_interview', {
      action: 'finalize', slug: 'jiyoon', session: ivSid, signRole: 'interviewee', signer: '이지윤',
    }),
  );
  if (!/finalized/.test(ivFin.content[0].text)) throw new Error('finalize: expected finalized after both signatures');

  const suggest = assertOk(
    'interview-suggest',
    await callTool('afterglow_interview', { action: 'suggest-questions', slug: 'jiyoon' }),
  );
  if (!/신호 A/.test(suggest.content[0].text)) throw new Error('suggest-questions: missing signal framing');

  // attach → transcribe --text round-trip.
  const ivStart2 = assertOk(
    'interview-start-2',
    await callTool('afterglow_interview', { action: 'start', slug: 'jiyoon', title: '녹음', interviewer: '김후임', interviewee: '이지윤' }),
  );
  const ivSid2 = ivStart2.content[0].text.match(/#(\d{3}[^\s"]*)/)[1];
  const mediaPath = join(tmpRoot, 'agents', 'jiyoon', 'smoke-clip.mp3');
  await writeFile(mediaPath, Buffer.from('SMOKE-AUDIO'));
  assertOk(
    'interview-attach-2',
    await callTool('afterglow_interview', { action: 'attach', slug: 'jiyoon', session: ivSid2, file: mediaPath, speakers: ['이지윤'] }),
  );
  const tsave = assertOk(
    'interview-transcribe-save',
    await callTool('afterglow_interview', { action: 'transcribe', slug: 'jiyoon', session: ivSid2, file: 'smoke-clip.mp3', text: '스모크전사토큰 내용.' }),
  );
  if (!/저장|polished/.test(tsave.content[0].text)) throw new Error('transcribe --text: expected save');

  /* ---------- share (hot-plug router): export → verify → import ---------- */

  const exportCall = assertOk(
    'share-export',
    await callTool('afterglow_share', { action: 'export', slugs: ['jiyoon'], exportedBy: 'smoke runner' }),
  );
  const bundlePath = exportCall.content[0].text.match(/위치:\s*(\S+)/)[1];
  const bundleAnchor = exportCall.content[0].text.match(/번들 앵커 해시:\s*(\S+)/)[1];
  const verifyCall = assertOk('share-verify', await callTool('afterglow_share', { action: 'verify', input: bundlePath }));
  if (!/import 가능|주의가 필요/.test(verifyCall.content[0].text)) throw new Error('verify: missing verdict line');
  if (!/서명: ✓ 검증 통과/.test(verifyCall.content[0].text)) throw new Error('verify: Ed25519 signature not verified');
  const importCall = assertOk(
    'share-import',
    await callTool('afterglow_share', {
      action: 'import', input: bundlePath, as: 'jiyoon-copy',
      trustSigner: '이지윤', importedBy: 'smoke runner', expectAnchor: bundleAnchor,
    }),
  );
  if (!/✓ 일치/.test(importCall.content[0].text)) throw new Error('import: expected anchor match (✓ 일치)');
  if (!/imported/.test(importCall.content[0].text)) throw new Error('import: expected an imported agent');
  const askImported = assertOk(
    'ask-imported',
    await callTool('afterglow_ask', { slug: 'jiyoon-copy', question: '온보딩?' }),
  );
  if (!/출처 \(provenance\)/.test(askImported.content[0].text)) {
    throw new Error('ask on imported agent: missing provenance banner');
  }

  /* ---------- admin audit: checkpoint + fast + full ---------- */

  const cp = assertOk('admin-audit-checkpoint', await callTool('afterglow_admin', { area: 'audit', checkpoint: true, json: true }));
  const cpJson = JSON.parse(cp.content[0].text);
  if (!(cpJson.checkpoints >= 1)) throw new Error('audit checkpoint: not recorded');
  const fast = assertOk('admin-audit-fast', await callTool('afterglow_admin', { area: 'audit', fast: true, json: true }));
  if (!JSON.parse(fast.content[0].text).verification?.ok) throw new Error('audit fast verify: not ok');
  const audit = assertOk('admin-audit', await callTool('afterglow_admin', { area: 'audit', json: true }));
  const auditJson = JSON.parse(audit.content[0].text);
  if (!auditJson.verification?.ok) {
    throw new Error(`audit chain not OK: ${JSON.stringify(auditJson.verification)}`);
  }

  /* ---------- elicitation menus over the real transport ---------- */

  // ask with no args → guided slug candidates ([필수] tags).
  const elicitReply = await callTool('afterglow_ask', {});
  const elicit = elicitReply.result;
  if (!elicit?.isError || !/정보가 더 필요/.test(elicit.content[0].text) || !/\[필수\] slug/.test(elicit.content[0].text) || !/jiyoon/.test(elicit.content[0].text)) {
    throw new Error(`elicitation guide missing for ask with no args:\n${JSON.stringify(elicitReply)}`);
  }
  // agent with no args → action menu (the v0.13 grouped-tool entrance).
  const agentMenuReply = await callTool('afterglow_agent', {});
  const agentMenu = agentMenuReply.result;
  if (!agentMenu?.isError || !/\[필수\] action/.test(agentMenu.content[0].text) || !/sign/.test(agentMenu.content[0].text)) {
    throw new Error('agent action menu missing');
  }
  // admin with area only → that area's action menu.
  const adminMenuReply = await callTool('afterglow_admin', { area: 'version' });
  const adminMenu = adminMenuReply.result;
  if (!adminMenu?.isError || !/rollback/.test(adminMenu.content[0].text)) {
    throw new Error('admin per-area action menu missing');
  }

  // status env posture (RAG mode / whisper / PII / enc).
  if (!statusJson.env || typeof statusJson.env.ragMode !== 'string' || typeof statusJson.env.whisperEngine !== 'string') {
    throw new Error(`status env block missing: ${JSON.stringify(statusJson.env)}`);
  }

  /* ---------- v0.14: prompt-argument completions ---------- */
  // Agents jiyoon + jaehoon exist by now — completing "ji" must offer jiyoon.
  const compSlug = await request('completion/complete', {
    ref: { type: 'ref/prompt', name: 'ask' },
    argument: { name: 'slug', value: 'ji' },
  });
  const slugValues = compSlug?.result?.completion?.values ?? [];
  if (!slugValues.includes('jiyoon')) {
    throw new Error(`completion ask.slug("ji") missing jiyoon: ${JSON.stringify(slugValues)}`);
  }
  // Comma-aware multi-slug: completing "jiyoon,ja" must offer "jiyoon,jaehoon".
  const compMulti = await request('completion/complete', {
    ref: { type: 'ref/prompt', name: 'ask' },
    argument: { name: 'slug', value: 'jiyoon,ja' },
  });
  const multiValues = compMulti?.result?.completion?.values ?? [];
  if (!multiValues.some((v) => v === 'jiyoon,jaehoon')) {
    throw new Error(`completion ask.slug("jiyoon,ja") missing jiyoon,jaehoon: ${JSON.stringify(multiValues)}`);
  }
  // Enum completion: agent.action "ar" → archive.
  const compAction = await request('completion/complete', {
    ref: { type: 'ref/prompt', name: 'agent' },
    argument: { name: 'action', value: 'ar' },
  });
  if (!(compAction?.result?.completion?.values ?? []).includes('archive')) {
    throw new Error('completion agent.action("ar") missing archive');
  }
  // Context-aware: admin.action with area=gc offers gc's vocabulary only.
  const compAdmin = await request('completion/complete', {
    ref: { type: 'ref/prompt', name: 'admin' },
    argument: { name: 'action', value: '' },
    context: { arguments: { area: 'gc' } },
  });
  const adminValues = compAdmin?.result?.completion?.values ?? [];
  if (!adminValues.includes('prune-versions') || adminValues.includes('rollback')) {
    throw new Error(`completion admin.action(area=gc) wrong vocabulary: ${JSON.stringify(adminValues)}`);
  }

  /* ---------- v0.14: AFTERGLOW_TOOLSETS=core + --version ---------- */
  const coreNames = await withCoreServer();
  if (JSON.stringify(coreNames.tools) !== JSON.stringify(['afterglow_ask', 'afterglow_create', 'afterglow_guide', 'afterglow_learn'])) {
    throw new Error(`toolsets=core tools mismatch: ${JSON.stringify(coreNames.tools)}`);
  }
  if (JSON.stringify(coreNames.prompts) !== JSON.stringify(['ask', 'create', 'guide', 'learn'])) {
    throw new Error(`toolsets=core prompts mismatch: ${JSON.stringify(coreNames.prompts)}`);
  }
  const versionOut = await runCli(['--version']);
  if (!/^\d+\.\d+\.\d+$/.test(versionOut.trim())) {
    throw new Error(`--version printed: ${JSON.stringify(versionOut)}`);
  }
  const helpOut = await runCli(['--help']);
  if (!/afterglow-mcp/.test(helpOut) || !/--toolsets/.test(helpOut)) {
    throw new Error('--help output missing usage/--toolsets');
  }

  console.log('smoke: OK');
  console.log(`  serverInfo.name    : ${init.result.serverInfo.name}`);
  console.log(`  protocolVersion    : ${init.result.protocolVersion}`);
  console.log(`  tools (${names.length})          : ${names.join(', ')}`);
  console.log(`  prompts (${promptNames.length})        : ${promptNames.join(', ')}`);
  console.log(`  audit total        : ${auditJson.total}`);
  console.log(`  audit chain        : ${auditJson.verification?.ok ? 'verified' : 'broken'} · checkpoint ${cpJson.checkpoints} + fast verify OK`);
  console.log(`  core path          : guide → create --signer → learn → ask (grounded + "근거 없음" refusal)  OK`);
  console.log(`  ask multi (합동)    : 2 participants, per-participant 근거 판정  OK`);
  console.log(`  agent router       : init·list·inspect·edit·sign·archive→restore→resume·history·status  OK`);
  console.log(`  interview          : start→answer→gap-check→dual-sign (#${ivSid}) · handoff-* 셀프검수 · suggest · transcribe  OK`);
  console.log(`  share router       : export(서명) → verify(✓) → import(anchor ✓ 일치) + provenance  OK`);
  console.log(`  admin router       : access(deny/allow/check) · correct · version(${(versionList.content[0].text.match(/v\d+/g) ?? []).length} snap) · gc dry-run  OK`);
  console.log(`  elicitation        : ask 후보메뉴 · agent action 메뉴 · admin area→action 메뉴  OK`);
  console.log(`  status env         : RAG ${statusJson.env.ragMode} · whisper ${statusJson.env.whisperEngine} · PII ${statusJson.env.piiRedaction} · enc ${statusJson.env.encryptionAtRest}  OK`);
  console.log(`  v0.14 annotations  : ask/guide read-only · admin destructive · learn open-world · 8 titles  OK`);
  console.log(`  v0.14 completions  : slug("ji")→jiyoon · multi("jiyoon,ja") · agent action · admin area-aware  OK`);
  console.log(`  v0.14 toolsets     : core → 4 tools + 4 prompts · --version ${versionOut.trim()} · --help  OK`);
} catch (err) {
  console.error('smoke: FAIL');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  child.kill();
  // Windows holds file handles until the child fully exits, so an immediate
  // rmdir hits EBUSY. Wait for the process to exit (bounded), then clean up
  // best-effort — a temp-dir cleanup failure must not fail an OK smoke run.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(tmpRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
