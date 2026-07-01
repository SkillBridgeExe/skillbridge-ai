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

  it('binds each project to its OWN role/link, not the first project matched in the narrative', () => {
    const multiNarrative =
      'Dự án Kho Hàng, solo, link github.com/me/kho. Dự án Chat App, nhóm 5 người, link github.com/me/chat.';
    const out = gateProjects(
      [
        { name: 'Kho Hàng', description: 'Dự án Kho Hàng, solo, link github.com/me/kho' },
        { name: 'Chat App', description: 'Dự án Chat App, nhóm 5 người, link github.com/me/chat' },
      ],
      multiNarrative,
      resolve,
    );
    expect(out.map((p) => p.name)).toEqual(['Kho Hàng', 'Chat App']); // both grounded names survive
    const [khoHang, chatApp] = out;
    expect(khoHang.role).toBe('Solo');
    expect(khoHang.link).toBe('github.com/me/kho');
    const chat = chatApp;
    expect(chat.role).toBe('Team of 5'); // its OWN window, NOT Kho Hàng's "Solo"
    expect(chat.link).toBe('github.com/me/chat'); // its OWN window, NOT Kho Hàng's link
    expect(chat.found_fields).toContain('role');
    expect(chat.found_fields).toContain('link');
  });

  it('strips trailing sentence punctuation off a link captured at end of sentence', () => {
    const singleNarrative = 'Dự án Kho Hàng, solo, link github.com/me/kho.';
    const [p] = gateProjects(
      [{ name: 'Kho Hàng', description: 'Dự án Kho Hàng, solo, link github.com/me/kho.' }],
      singleNarrative,
      resolve,
    );
    expect(p.link).toBe('github.com/me/kho'); // no trailing "."
  });
});
