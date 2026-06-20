import { buildChatFacts, groundResources } from '../../../src/modules/learning-chat/chat-grounding';
import { RetrievedResource } from '../../../src/modules/roadmap/resource-embedding';

const res = (id: string): RetrievedResource => ({
  resource_id: id,
  rank: 1,
  title: `T-${id}`,
  provider: 'Prov',
  source_type: 'course',
  outcome_type: 'practice',
});

const facts = buildChatFacts({});

describe('groundResources — anti-fabrication guard', () => {
  it('keeps only cited ids present in the retrieved set; drops fabricated ids', () => {
    const out = groundResources(
      {
        message: 'Học Docker qua tài nguyên này.',
        cited_resource_ids: ['r1', 'GHOST'],
        suggested_next_step: 'deploy a container',
      },
      [res('r1')],
      facts,
    );
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
    expect(out.message).toContain('Docker');
    expect(out.suggested_next_step).toBe('deploy a container');
  });

  it('strips a raw URL from the message (links resolve from resource_id, never raw)', () => {
    const out = groundResources(
      {
        message: 'Xem khoá tại https://fake-course.example và www.evil.test ngay.',
        cited_resource_ids: ['r1'],
      },
      [res('r1')],
      facts,
    );
    expect(out.message).not.toMatch(/https?:\/\//i);
    expect(out.message).not.toMatch(/www\./i);
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
  });

  it('dedupes repeated citations', () => {
    const out = groundResources(
      { message: 'x', cited_resource_ids: ['r1', 'r1', 'r2'] },
      [res('r1'), res('r2')],
      facts,
    );
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1', 'r2']);
  });

  it('honest empty-state: retrieved=[] → no fabricated resource even if the LLM cited one', () => {
    const out = groundResources(
      {
        message: 'Mình chưa có tài nguyên phù hợp.',
        cited_resource_ids: ['anything'],
        suggested_next_step: null,
      },
      [],
      facts,
    );
    expect(out.cited_resources).toEqual([]);
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('vague-question shape: LLM cites nothing → cited_resources empty even when a resource was retrieved', () => {
    const out = groundResources(
      {
        message: 'Bạn muốn học mảng nào của backend: API, DB hay hạ tầng?',
        cited_resource_ids: [],
      },
      [res('r-backend-broad')],
      facts,
    );
    expect(out.cited_resources).toEqual([]);
    expect(out.message).toContain('backend');
  });

  it('parse failure / non-object → deterministic fallback over the retrieved set (never throws, never invents)', () => {
    const out = groundResources('garbage', [res('r1')], facts);
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message).not.toMatch(/https?:\/\//i);
  });

  it('missing/empty message → fallback (does not emit an empty answer)', () => {
    const out = groundResources({ cited_resource_ids: ['r1'] }, [res('r1')], facts);
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('strips scheme-less provider links + shorteners the LLM invents (backstop, not just http://)', () => {
    for (const message of [
      'Thử udemy.com/course/docker-mastery nhé',
      'Xem coursera.org để học',
      'Link rút gọn bit.ly/abc123',
    ]) {
      const out = groundResources({ message, cited_resource_ids: [] }, [], facts);
      expect(out.message).not.toMatch(/udemy|coursera|bit\.ly/i);
      expect(out.message).toContain('[link]');
    }
  });

  it('does NOT mangle tech terms that look domain-ish (Node.js, socket.io) — no false positives', () => {
    const out = groundResources(
      { message: 'Học Node.js và socket.io trước khi vào Docker.', cited_resource_ids: [] },
      [],
      facts,
    );
    expect(out.message).toContain('Node.js');
    expect(out.message).toContain('socket.io');
    expect(out.message).not.toContain('[link]');
  });

  it('collapses a markdown link to its text (no dangling bracket, href removed)', () => {
    const out = groundResources(
      { message: 'Xem [khoá Docker](https://evil.test/buy) này.', cited_resource_ids: ['r1'] },
      [res('r1')],
      facts,
    );
    expect(out.message).not.toMatch(/https?:\/\//i);
    expect(out.message).not.toContain('](');
    expect(out.message).toContain('khoá Docker');
  });

  it('strips a raw URL the LLM puts in suggested_next_step (not just message)', () => {
    const out = groundResources(
      {
        message: 'ok',
        cited_resource_ids: ['r1'],
        suggested_next_step: 'Mở https://evil.test/buy để mua',
      },
      [res('r1')],
      facts,
    );
    expect(out.suggested_next_step).not.toMatch(/https?:\/\//i);
    expect(out.suggested_next_step).toContain('[link]');
  });
});

describe('buildChatFacts', () => {
  it('keeps top open gaps by severity (skill+severity+status), drops matched', () => {
    const f = buildChatFacts({
      gapItems: [
        { canonical_name: 'docker', cv_status: 'missing', severity: 0.8 },
        { canonical_name: 'react', cv_status: 'matched', severity: 0 },
        { canonical_name: 'aws', cv_status: 'partial', severity: 0.5 },
      ],
    });
    expect(f.open_gaps.map((g) => g.skill)).toEqual(['docker', 'aws']);
    expect(f.open_gaps[0]).toEqual({ skill: 'docker', severity: 0.8, status: 'missing' });
  });

  it('caps at the top 5 gaps', () => {
    const f = buildChatFacts({
      gapItems: Array.from({ length: 8 }, (_, i) => ({
        canonical_name: `s${i}`,
        cv_status: 'missing' as const,
        severity: i / 10,
      })),
    });
    expect(f.open_gaps.length).toBe(5);
    expect(f.open_gaps[0].skill).toBe('s7'); // highest severity first
  });

  it('empty input → no gaps (degrades, never throws)', () => {
    expect(buildChatFacts({}).open_gaps).toEqual([]);
  });
});
