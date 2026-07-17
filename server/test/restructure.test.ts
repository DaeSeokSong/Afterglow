/**
 * v0.13 consolidation tests — the 26→8 surface restructure.
 *
 * The old implementations are unchanged (their own suites still cover
 * behaviour); these tests prove the ROUTING layer: every grouped action
 * reaches the right implementation, elicitation menus appear when the
 * action/area is omitted, and the two feature absorptions (council →
 * ask multi-slug, handoff → interview handoff-*) work end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'afterglow-v13-'));
  process.env.AFTERGLOW_ROOT = tmpRoot;
});
afterEach(async () => {
  delete process.env.AFTERGLOW_ROOT;
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

async function makeAgent(slug = 'jiyoon', signer = '이지윤') {
  const { runCreate } = await import('../src/tools/create.js');
  await runCreate({ slug, name: '이지윤', role: '디자이너', signer } as never);
}

/* ---------------- afterglow_agent ---------------- */

describe('v13 · agent router', () => {
  it('routes list / status / inspect / history', async () => {
    await makeAgent();
    const { runAgent } = await import('../src/tools/agent.js');
    const list = await runAgent({ action: 'list', json: true } as never);
    expect(JSON.parse(list.content[0].text).agents[0].slug).toBe('jiyoon');
    const status = await runAgent({ action: 'status' } as never);
    expect(status.content[0].text).toContain('대시보드');
    const inspect = await runAgent({ action: 'inspect', slug: 'jiyoon' } as never);
    expect(inspect.isError).toBeUndefined();
    const history = await runAgent({ action: 'history', slug: 'jiyoon' } as never);
    expect(history.isError).toBeUndefined();
  });

  it('routes edit / sign / resume / archive / restore with original behaviour', async () => {
    const { runCreate } = await import('../src/tools/create.js');
    await runCreate({ slug: 'jiyoon', name: '이지윤', role: '디자이너' } as never); // draft
    const { runAgent } = await import('../src/tools/agent.js');
    const { getStatus } = await import('../src/storage.js');

    const signed = await runAgent({ action: 'sign', slug: 'jiyoon', signer: '이지윤' } as never);
    expect(signed.isError).toBeUndefined();
    expect(await getStatus('jiyoon')).toBe('active');

    const edited = await runAgent({ action: 'edit', slug: 'jiyoon', bio: '수정된 소개' } as never);
    expect(edited.isError).toBeUndefined();

    await runAgent({ action: 'archive', slug: 'jiyoon' } as never);
    expect(await getStatus('jiyoon')).toBe('archived');
    await runAgent({ action: 'restore', slug: 'jiyoon' } as never);
    expect(await getStatus('jiyoon')).toBe('paused');
    await runAgent({ action: 'resume', slug: 'jiyoon' } as never);
    expect(await getStatus('jiyoon')).toBe('active');
  });

  it('elicits the action menu when action is omitted', async () => {
    await makeAgent();
    const { runAgent } = await import('../src/tools/agent.js');
    const r = await runAgent({} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('[필수] action');
    expect(r.content[0].text).toMatch(/sign/);
    expect(r.content[0].text).toMatch(/archive/);
  });

  it('init works through the router (idempotent bootstrap)', async () => {
    const { runAgent } = await import('../src/tools/agent.js');
    const r = await runAgent({ action: 'init' } as never);
    expect(r.isError).toBeUndefined();
    const { isInitialized } = await import('../src/storage.js');
    expect(await isInitialized()).toBe(true);
  });
});

/* ---------------- afterglow_ask (multi-slug = 구 council) ---------------- */

describe('v13 · ask multi-slug', () => {
  it('2+ slugs return a joint brief with per-participant grounding', async () => {
    await makeAgent('jiyoon');
    await makeAgent('jaehoon');
    const { runLearn } = await import('../src/tools/learn.js');
    await runLearn({ slug: 'jiyoon', text: '온보딩 이탈을 22%에서 9%로 줄였습니다.' } as never);
    const { runAsk } = await import('../src/tools/ask.js');
    const r = await runAsk({ slugs: ['jiyoon', 'jaehoon'], question: '온보딩 이탈 어떻게 줄였어요?' } as never);
    const t = r.content[0].text;
    expect(t).toContain('합동 질문 컨텍스트');
    expect(t).toContain('참가자: jiyoon');
    expect(t).toContain('참가자: jaehoon');
    expect(t).toContain('답변 규칙');
    // jiyoon has the material, jaehoon doesn't → verdicts must differ
    expect(t).toMatch(/근거 판정: 근거 없음/);
    expect(t).toContain('22%에서 9%');
  });

  it('rejects duplicates and unsigned participants like the old council', async () => {
    await makeAgent('jiyoon');
    const { runCreate } = await import('../src/tools/create.js');
    await runCreate({ slug: 'draftguy', name: 'D', role: 'R' } as never); // unsigned
    const { runAsk } = await import('../src/tools/ask.js');

    const dup = await runAsk({ slugs: ['jiyoon', 'jiyoon'], question: '?' } as never);
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toMatch(/중복/);

    const unsigned = await runAsk({ slugs: ['jiyoon', 'draftguy'], question: '?' } as never);
    expect(unsigned.isError).toBe(true);
  });

  it('a single-element slugs array behaves like slug', async () => {
    await makeAgent('jiyoon');
    const { runAsk } = await import('../src/tools/ask.js');
    const r = await runAsk({ slugs: ['jiyoon'], question: '안녕하세요?' } as never);
    expect(r.content[0].text).toContain('# 호출 컨텍스트');
  });
});

/* ---------------- afterglow_interview handoff-* ---------------- */

describe('v13 · interview handoff-* (구 afterglow_handoff)', () => {
  it('handoff-start → handoff-status → handoff-abort round-trip', async () => {
    await makeAgent();
    const { runInterview } = await import('../src/tools/interview.js');
    const start = await runInterview({ action: 'handoff-start', slug: 'jiyoon', limit: 3 } as never);
    expect(start.isError).toBeUndefined();
    expect(start.content[0].text).toMatch(/검수|질문/);

    const status = await runInterview({ action: 'handoff-status', slug: 'jiyoon' } as never);
    expect(status.isError).toBeUndefined();

    const abort = await runInterview({ action: 'handoff-abort', slug: 'jiyoon' } as never);
    expect(abort.isError).toBeUndefined();
  });

  it('handoff-finalize signs consent (draft → active) with followup consent', async () => {
    const { runCreate } = await import('../src/tools/create.js');
    await runCreate({ slug: 'jiyoon', name: '이지윤', role: '디자이너' } as never); // draft
    const { runInterview } = await import('../src/tools/interview.js');
    const { getStatus, readFollowupConsent } = await import('../src/storage.js');

    await runInterview({ action: 'handoff-start', slug: 'jiyoon', limit: 2 } as never);
    const fin = await runInterview({
      action: 'handoff-finalize', slug: 'jiyoon', signer: '이지윤', signPartial: true,
      allowProxyAnnotation: true,
    } as never);
    expect(fin.isError).toBeUndefined();
    expect(await getStatus('jiyoon')).toBe('active');
    const fc = await readFollowupConsent('jiyoon');
    expect(fc?.allowProxyAnnotation).toBe(true);
  });
});

/* ---------------- afterglow_share ---------------- */

describe('v13 · share router', () => {
  it('export → verify → import round-trip through one tool', async () => {
    const cwd = process.cwd();
    const work = await mkdtemp(join(tmpdir(), 'afterglow-v13-cwd-'));
    process.chdir(work);
    try {
      await makeAgent();
      const { runShare } = await import('../src/tools/share.js');
      const ex = await runShare({ action: 'export', all: true } as never);
      expect(ex.isError).toBeUndefined();
      const outDir = ex.content[0].text.match(/위치: (\S+)/)![1];

      const ver = await runShare({ action: 'verify', input: outDir } as never);
      expect(ver.content[0].text).toMatch(/서명: ✓ 검증 통과/);

      const imp = await runShare({ action: 'import', input: outDir, as: 'jiyoon-copy' } as never);
      expect(imp.isError).toBeUndefined();
      const { agentExists } = await import('../src/storage.js');
      expect(await agentExists('jiyoon-copy')).toBe(true);
    } finally {
      process.chdir(cwd);
      await rm(work, { recursive: true, force: true });
    }
  });

  it('elicits action when omitted', async () => {
    await makeAgent();
    const { runShare } = await import('../src/tools/share.js');
    const r = await runShare({} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('[필수] action');
  });
});

/* ---------------- afterglow_admin ---------------- */

describe('v13 · admin router', () => {
  it('routes all five areas to the original implementations', async () => {
    await makeAgent();
    const { runAdmin } = await import('../src/tools/admin.js');

    const allow = await runAdmin({ area: 'access', action: 'allow', slug: 'jiyoon', rule: 'user:boss' } as never);
    expect(allow.isError).toBeUndefined();
    const check = await runAdmin({ area: 'access', action: 'check', slug: 'jiyoon', caller: 'user:boss' } as never);
    expect(check.content[0].text).toMatch(/allow/i);

    const audit = await runAdmin({ area: 'audit', json: true } as never);
    expect(JSON.parse(audit.content[0].text).verification.ok).toBe(true);

    const rec = await runAdmin({
      area: 'correct', action: 'record-answer', slug: 'jiyoon',
      question: '온보딩?', answer: '줄였어요', confidence: 80,
    } as never);
    expect(rec.isError).toBeUndefined();

    const vlist = await runAdmin({ area: 'version', action: 'list', slug: 'jiyoon' } as never);
    expect(vlist.isError).toBeUndefined();

    const gc = await runAdmin({ area: 'gc', action: 'list' } as never);
    expect(gc.isError).toBeUndefined();
  });

  it('elicits area when omitted, and the per-area action menu when only area is given', async () => {
    await makeAgent();
    const { runAdmin } = await import('../src/tools/admin.js');
    const noArea = await runAdmin({} as never);
    expect(noArea.isError).toBe(true);
    expect(noArea.content[0].text).toContain('[필수] area');

    const noAction = await runAdmin({ area: 'version' } as never);
    expect(noAction.isError).toBe(true);
    expect(noAction.content[0].text).toMatch(/rollback/);
  });

  it('rejects an invalid per-area action instead of falling through', async () => {
    await makeAgent();
    const { runAdmin } = await import('../src/tools/admin.js');
    const r = await runAdmin({ area: 'gc', action: 'nuke-everything', slug: 'jiyoon' } as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/다음 중 하나/);
  });
});
