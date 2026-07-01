import { gateProjects } from './project-extractor';

// Minimal resolver: maps a few canonical tech words, null otherwise (simulates taxonomy).
const resolve = (raw: string): string | null => {
  const k = raw.toLowerCase().replace(/[\s.\-]/g, '');
  const map: Record<string, string> = {
    react: 'react',
    nodejs: 'node_js',
    node: 'node_js',
    sql: 'sql',
  };
  return map[k] ?? null;
};

describe('gateProjects', () => {
  const narrative =
    'Mình làm dự án Shop Online bằng React và Node.js, làm việc nhóm 4 người, link github.com/me/shop, giảm thời gian tải 30%.';

  it('keeps a grounded project name, derives tech from the resolver (not the LLM)', () => {
    const [p] = gateProjects(
      [
        {
          name: 'Shop Online',
          description: 'làm dự án Shop Online bằng React và Node.js',
          contribution: 'giảm thời gian tải 30%',
        },
      ],
      narrative,
      resolve,
    );
    expect(p.name).toBe('Shop Online');
    expect(p.tech.sort()).toEqual(['node_js', 'react']);
    expect(p.role).toBe('Team of 4'); // from regex "nhóm 4 người"
    expect(p.link).toBe('github.com/me/shop');
    expect(p.bullets.length).toBeGreaterThan(0);
  });

  it('drops a project whose name is NOT grounded in the narrative (no fabrication)', () => {
    const out = gateProjects([{ name: 'Imaginary CRM', description: 'a CRM' }], narrative, resolve);
    expect(out).toEqual([]);
  });

  it('drops a bullet that introduces an ungrounded number', () => {
    const [p] = gateProjects(
      [{ name: 'Shop Online', contribution: 'tăng doanh thu 99%' }], // 99% not in narrative
      narrative,
      resolve,
    );
    expect(p.bullets.join(' ')).not.toContain('99');
  });

  it('never puts an LLM-suggested tech into tech[] unless the resolver returns a canonical', () => {
    const [p] = gateProjects(
      [{ name: 'Shop Online', description: 'dùng React' }],
      narrative,
      resolve,
    );
    expect(p.tech).toContain('react');
    expect(p.tech).not.toContain('node_js'); // node not in THIS description window... (see impl note)
  });
});
