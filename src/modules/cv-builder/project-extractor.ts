import { isGrounded } from '../cv-intake/intake-grounding';
import { extractSkillMentions } from './role-inference';

export interface ProposedProject {
  name: string;
  description?: string;
  contribution?: string;
}
export interface ExtractedProject {
  name: string;
  role: string | null;
  tech: string[];
  bullets: string[];
  link: string | null;
  found_fields: string[];
  missing_fields: string[];
}

// Curated TLD list (not a bare `[a-z]{2,}`) so file-extension-looking tokens like "Node.js" don't
// false-positive as a link.
const URL_RE =
  /\b((https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|co|vn|app|me|info|edu|gov|ai)(?:\/[^\s,)]*)?)/i;
const ROLE_RE = /\b(solo|lead|team of (\d+)|nhóm (\d+)\s*(người)?)\b/i;

function deriveRole(text: string): string | null {
  const m = ROLE_RE.exec(text);
  if (!m) return null;
  const n = m[2] ?? m[3];
  if (n) return `Team of ${n}`;
  if (/lead/i.test(m[0])) return 'Lead';
  if (/solo/i.test(m[0])) return 'Solo';
  return null;
}

/**
 * Gate LLM-proposed projects against the raw narrative. The LLM only suggests name + prose; CODE decides
 * what survives: name must be grounded (atom) or the project is dropped; bullets keep only grounded prose;
 * tech comes ONLY from the taxonomy resolver over the project window; role/link from regex over the full
 * narrative (a story usually states team size / link once, not per-project-window). No fabrication.
 */
export function gateProjects(
  proposed: ProposedProject[],
  narrative: string,
  resolve: (raw: string) => string | null,
): ExtractedProject[] {
  const out: ExtractedProject[] = [];
  for (const p of proposed) {
    const name = (p.name ?? '').trim();
    if (!isGrounded(name, narrative, 'atom')) continue; // drop fabricated/recombined names

    const window = [p.description, p.contribution].filter(Boolean).join(' ').trim();
    const found: string[] = ['name'];
    const missing: string[] = [];

    const bullets = [p.description, p.contribution]
      .map((s) => (s ?? '').trim())
      .filter((s) => s.length > 0 && isGrounded(s, narrative, 'prose'));
    if (bullets.length) found.push('bullets');
    else missing.push('bullets');

    // tech: deterministic taxonomy match over the project window (NOT the LLM's words).
    const tech = extractSkillMentions(window || narrative, resolve);
    if (tech.length) found.push('tech');
    else missing.push('tech');

    // role/link: regex over the full narrative — these facts are rarely repeated inside the
    // LLM's per-project description/contribution window, so scoping to `window` would miss them.
    const role = deriveRole(narrative);
    if (role) found.push('role');
    else missing.push('role');

    const linkMatch = URL_RE.exec(narrative);
    const link = linkMatch ? linkMatch[1] : null;
    if (link) found.push('link');
    else missing.push('link');

    out.push({ name, role, tech, bullets, link, found_fields: found, missing_fields: missing });
  }
  return out;
}
