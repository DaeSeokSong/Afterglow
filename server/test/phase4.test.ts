/**
 * Tests for the v0.1.3 additions:
 *   afterglow_archive (archive / restore / list)
 *
 * Each test redirects ~/.claude/afterglow/ to a fresh tmp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'afterglow-p4-'));
  process.env.AFTERGLOW_ROOT = tmpRoot;
  delete process.env.AFTERGLOW_ALLOW_DRAFT;
});

afterEach(async () => {
  delete process.env.AFTERGLOW_ROOT;
  delete process.env.AFTERGLOW_ALLOW_DRAFT;
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

async function bootstrap(slug = 'jiyoon') {
  const { runInit } = await import('../src/tools/init.js');
  const { runCreate } = await import('../src/tools/create.js');
  await runInit({});
  await runCreate({
    slug,
    name: '이지윤',
    role: '프로덕트 디자이너',
    tenure: '2019.03 – 2025.11',
    expertise: ['디자인'],
  });
}

async function bootstrapAndSign(slug = 'jiyoon') {
  await bootstrap(slug);
  const { runSign } = await import('../src/tools/sign.js');
  await runSign({ slug, signer: '본인' });
}

/* --------------------------------------------------------------- */
/* afterglow_archive                                               */
/* --------------------------------------------------------------- */

describe('archive · happy path', () => {
  it('archives a signed agent and blocks ask afterwards', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runAsk } = await import('../src/tools/ask.js');
    const { agentDir, archivedAgentDir } = await import('../src/storage.js');

    const r = await runArchive({ action: 'archive', slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('보관 완료');

    // agents/<slug>/ gone, archive/<slug>/ exists
    await expect(stat(agentDir('jiyoon'))).rejects.toBeDefined();
    await expect(stat(archivedAgentDir('jiyoon'))).resolves.toBeDefined();

    // ask is now blocked with a clear archived error
    const a = await runAsk({ slug: 'jiyoon', question: '?' });
    expect(a.isError).toBe(true);
    expect(a.content[0].text).toMatch(/archived|보관/i);
  });

  it('restores an archived agent into paused (not active)', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runList } = await import('../src/tools/list.js');
    const { agentDir } = await import('../src/storage.js');

    await runArchive({ action: 'archive', slug: 'jiyoon' });
    const r = await runArchive({ action: 'restore', slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('복원 완료');
    expect(r.content[0].text).toMatch(/paused/);
    await expect(stat(agentDir('jiyoon'))).resolves.toBeDefined();

    // registry says paused now
    const listing = JSON.parse((await runList({ json: true })).content[0].text) as {
      agents: { slug: string; status: string }[];
    };
    expect(listing.agents.find((a) => a.slug === 'jiyoon')?.status).toBe('paused');
  });

  it('lists archived slugs and shows empty state', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');

    const empty = await runArchive({ action: 'list' });
    expect(empty.content[0].text).toMatch(/비어있어요|비어 있어요/);

    await runArchive({ action: 'archive', slug: 'jiyoon' });
    const filled = await runArchive({ action: 'list' });
    expect(filled.content[0].text).toContain('jiyoon');
    expect(filled.content[0].text).toMatch(/1\s*명/);
  });
});

describe('archive · edge cases', () => {
  it('refuses to archive a slug that does not exist', async () => {
    const { runInit } = await import('../src/tools/init.js');
    const { runArchive } = await import('../src/tools/archive.js');
    await runInit({});
    const r = await runArchive({ action: 'archive', slug: 'ghost' });
    expect(r.isError).toBe(true);
  });

  it('refuses to archive twice (already archived)', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });
    const r = await runArchive({ action: 'archive', slug: 'jiyoon' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/already archived|이미 archived/i);
  });

  it('refuses to restore when nothing is archived', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const r = await runArchive({ action: 'restore', slug: 'jiyoon' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not archived|nothing to restore/i);
  });

  it('refuses to restore when an active slug already exists', async () => {
    // Manufacture a collision: archive jiyoon, then re-create another agent
    // with the same slug somehow → restore should refuse.
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { agentsDir } = await import('../src/storage.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });

    // Simulate something occupying agents/jiyoon/
    await mkdir(join(agentsDir(), 'jiyoon'), { recursive: true });

    const r = await runArchive({ action: 'restore', slug: 'jiyoon' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/in the way|already exists/i);
  });

  it('refuses action=archive without slug', async () => {
    const { runInit } = await import('../src/tools/init.js');
    const { runArchive } = await import('../src/tools/archive.js');
    await runInit({});
    const r = await runArchive({ action: 'archive' } as { action: 'archive' });
    expect(r.isError).toBe(true);
  });

  it('audit chain stays verified across archive → restore', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });
    await runArchive({ action: 'restore', slug: 'jiyoon' });
    const { verifyChain } = await import('../src/audit.js');
    const v = await verifyChain();
    expect(v.ok).toBe(true);
  });
});
/* --------------------------------------------------------------- */
/* regression — 1차 QA P0 fixes                                    */
/* --------------------------------------------------------------- */

describe('regression · audit corruption blocks further append (1차 P0 fix)', () => {
  it('tampering with the last audit line causes the next append to fail loudly', async () => {
    await bootstrapAndSign('jiyoon');
    const { auditPath, append, verifyChain, AuditCorruptedError } = await import('../src/audit.js');
    // Corrupt only the LAST line — we want lastRecord() to throw.
    const raw = await readFile(auditPath(), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    lines[lines.length - 1] = '{ not valid json';
    await writeFile(auditPath(), lines.join('\n') + '\n', 'utf8');

    await expect(append({ tool: 'test_tool', summary: 'should not happen' })).rejects.toBeInstanceOf(
      AuditCorruptedError,
    );
    // verifyChain should also report failure (untouched behaviour).
    const v = await verifyChain();
    expect(v.ok).toBe(false);
  });

  it('safe() converts AuditCorruptedError into a structured tool reply', async () => {
    await bootstrapAndSign('jiyoon');
    const { auditPath } = await import('../src/audit.js');
    const raw = await readFile(auditPath(), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    lines[lines.length - 1] = '{ also broken';
    await writeFile(auditPath(), lines.join('\n') + '\n', 'utf8');

    const { runList } = await import('../src/tools/list.js');
    const r = await runList({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/corruption|corrupted/i);
  });
});

describe('regression · NotSignedError carries current state (2차 P1 fix)', () => {
  it('paused agent ask error names the actual status and points at both sign + resume', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runAsk } = await import('../src/tools/ask.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });
    await runArchive({ action: 'restore', slug: 'jiyoon' });
    // status should now be paused
    const r = await runAsk({ slug: 'jiyoon', question: 'hi' });
    expect(r.isError).toBe(true);
    const txt = r.content[0].text;
    // The new message format includes "current: <status>" — make sure it really
    // reports paused (the looser regex from 2차 was a false positive).
    expect(txt).toMatch(/current:\s*paused/);
    // And it must offer both remediation paths (sign for first-time, resume for re-activation).
    expect(txt).toMatch(/\/afterglow sign/);
    expect(txt).toMatch(/\/afterglow resume/);
  });
});

/* --------------------------------------------------------------- */
/* afterglow_resume tool (3차 P0 fix)                              */
/* --------------------------------------------------------------- */

describe('resume · happy + edge cases', () => {
  it('paused agent (after archive → restore) becomes active again', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runResume } = await import('../src/tools/resume.js');
    const { runAsk } = await import('../src/tools/ask.js');
    const { getStatus } = await import('../src/storage.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });
    await runArchive({ action: 'restore', slug: 'jiyoon' });
    expect(await getStatus('jiyoon')).toBe('paused');

    const r = await runResume({ slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/활성화/);
    expect(await getStatus('jiyoon')).toBe('active');

    // ask now succeeds
    const a = await runAsk({ slug: 'jiyoon', question: 'hello' });
    expect(a.isError).toBeUndefined();
  });

  it('resume on already-active agent is a no-op with a friendly message', async () => {
    await bootstrapAndSign('jiyoon');
    const { runResume } = await import('../src/tools/resume.js');
    const r = await runResume({ slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/이미 active/);
  });

  it('resume refuses an archived agent (must restore first)', async () => {
    await bootstrapAndSign('jiyoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runResume } = await import('../src/tools/resume.js');
    await runArchive({ action: 'archive', slug: 'jiyoon' });
    const r = await runResume({ slug: 'jiyoon' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/archived|--action restore/);
  });

  it('resume errors on unknown slug', async () => {
    const { runInit } = await import('../src/tools/init.js');
    const { runResume } = await import('../src/tools/resume.js');
    await runInit({});
    const r = await runResume({ slug: 'ghost' });
    expect(r.isError).toBe(true);
  });

  it('resume promotes a draft agent (used when sign is impossible)', async () => {
    // draft = create without sign
    await bootstrap('jiyoon');
    const { runResume } = await import('../src/tools/resume.js');
    const { getStatus } = await import('../src/storage.js');
    expect(await getStatus('jiyoon')).toBe('draft');
    const r = await runResume({ slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(await getStatus('jiyoon')).toBe('active');
  });
});

describe('regression · inspect surfaces current status (3차 P2 fix)', () => {
  it('inspect text output includes status label', async () => {
    await bootstrapAndSign('jiyoon');
    const { runInspect } = await import('../src/tools/inspect.js');
    const r = await runInspect({ slug: 'jiyoon' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/● active/);
  });

  it('inspect JSON output includes status field', async () => {
    await bootstrapAndSign('jiyoon');
    const { runInspect } = await import('../src/tools/inspect.js');
    const r = await runInspect({ slug: 'jiyoon', json: true });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text) as { status: string };
    expect(data.status).toBe('active');
  });
});

/* --------------------------------------------------------------- */
/* archived agent integration                                      */
/* --------------------------------------------------------------- */

describe('archived agent integration', () => {
  it('archived agents block multi-slug ask too (not just single ask)', async () => {
    await bootstrapAndSign('jiyoon');
    await bootstrapAndSign('jaehoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runAsk } = await import('../src/tools/ask.js');
    await runArchive({ action: 'archive', slug: 'jaehoon' });
    const r = await runAsk({ slugs: ['jiyoon', 'jaehoon'], question: '?' } as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/archived|보관/);
  });

  it('list --status archived shows only archived', async () => {
    await bootstrapAndSign('jiyoon');
    await bootstrapAndSign('jaehoon');
    const { runArchive } = await import('../src/tools/archive.js');
    const { runList } = await import('../src/tools/list.js');
    await runArchive({ action: 'archive', slug: 'jaehoon' });
    const r = await runList({ status: 'archived', json: true });
    const data = JSON.parse(r.content[0].text) as { count: number; agents: { slug: string }[] };
    expect(data.count).toBe(1);
    expect(data.agents[0].slug).toBe('jaehoon');
  });
});
