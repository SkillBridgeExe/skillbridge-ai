/**
 * Story→CV cold-start, slice 1: deterministic role inference (NO LLM).
 *
 * Given the skills a user mentions, score every role by WEIGHTED coverage — sum the curated
 * `weight` of each requirement they hit (direct skill OR one member of an `any_of` group). Because
 * a rubric's weights sum to ≈1, the score is "what fraction of this role's weighted profile is
 * covered". Pick the top role; ABSTAIN (ask the user) when coverage is weak OR the top two are too
 * close (ambiguous fullstack-vs-frontend). Weighted, not counted, so one stray "react" mention can't
 * flip a strong backend. Reuses the same `weight`/`any_of` the rubric already curates — no new tuning.
 *
 * Level-blind on purpose: a story rarely states proficiency, so this answers "does WHAT", never
 * "how senior" — seniority band stays caller-supplied (see role-rubric.service.ts:8-12).
 */

export interface RoleRequirement {
  skill_canonical_name: string;
  weight: number;
  any_of?: string[];
}
export interface RoleProfile {
  role_code: string;
  requirements: RoleRequirement[];
}
export interface RoleInferenceResult {
  role_code: string | null; // null when too weak / ambiguous / no roles
  confidence: number; // weighted coverage 0..1 of the winning role
  matched_skills: string[];
  candidates: Array<{ role_code: string; score: number; matched: string[] }>;
  needs_user_input: boolean;
  reason: 'ok' | 'too_weak' | 'ambiguous' | 'no_roles';
}

export function inferRoleFromSkills(
  skills: string[],
  roles: RoleProfile[],
  opts: { minConfidence?: number; minMatched?: number; ambiguityMargin?: number } = {},
): RoleInferenceResult {
  // Defaults are the v1 floor; eval:role-infer CALIBRATES these on the gold set (do not guess).
  const minConfidence = opts.minConfidence ?? 0.34;
  const minMatched = opts.minMatched ?? 2;
  const ambiguityMargin = opts.ambiguityMargin ?? 0.1;
  const have = new Set(skills);

  const candidates = roles
    .map((role) => {
      const matched: string[] = [];
      let score = 0;
      for (const req of role.requirements) {
        const hit =
          have.has(req.skill_canonical_name) || (req.any_of ?? []).some((m) => have.has(m));
        if (hit) {
          score += req.weight;
          matched.push(req.skill_canonical_name);
        }
      }
      return { role_code: role.role_code, score, matched };
    })
    // score desc, then more requirements matched, then role_code alpha → fully deterministic ties.
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.matched.length - a.matched.length ||
        a.role_code.localeCompare(b.role_code),
    );

  if (candidates.length === 0) {
    return {
      role_code: null,
      confidence: 0,
      matched_skills: [],
      candidates,
      needs_user_input: true,
      reason: 'no_roles',
    };
  }

  const top = candidates[0];
  const second = candidates[1];

  let reason: RoleInferenceResult['reason'] = 'ok';
  if (top.matched.length < minMatched || top.score < minConfidence) reason = 'too_weak';
  else if (second && top.score - second.score < ambiguityMargin) reason = 'ambiguous';

  const ok = reason === 'ok';
  return {
    role_code: ok ? top.role_code : null,
    confidence: top.score,
    matched_skills: ok ? [...top.matched].sort() : [],
    candidates,
    needs_user_input: !ok,
    reason,
  };
}

/**
 * Pull canonical skill names out of free prose by sliding a 1..N-gram window over the words and
 * asking `resolve` (taxonomy alias lookup) for each candidate. Longest gram wins at each position so
 * "React JS" maps once to `react`, not twice. Splits on whitespace AND list/sentence punctuation so
 * "CSS," and "Node.js." tokenize cleanly (the resolver's normalizeKey drops internal dots anyway).
 */
export function extractSkillMentions(
  text: string,
  resolve: (raw: string) => string | null,
  maxGram = 3,
): string[] {
  const tokens = text.split(/[\s,;.!?()[\]/]+/).filter(Boolean);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(maxGram, tokens.length - i); n >= 1; n--) {
      const canon = resolve(tokens.slice(i, i + n).join(' '));
      if (canon) {
        found.add(canon);
        break; // longest gram first → avoid double-counting the same span
      }
    }
  }
  return [...found];
}

/** Adapt the curated RoleRubric shape (skills[] with weight/any_of) to a scoring RoleProfile. */
export function rubricsToProfiles(
  rubrics: Array<{
    role_code: string;
    skills: Array<{ skill_canonical_name: string; weight: number; any_of?: string[] }>;
  }>,
): RoleProfile[] {
  return rubrics.map((r) => ({
    role_code: r.role_code,
    requirements: r.skills.map((s) => ({
      skill_canonical_name: s.skill_canonical_name,
      weight: s.weight,
      any_of: s.any_of,
    })),
  }));
}

/** End-to-end: free story → skill mentions → weighted role inference. */
export function inferRoleFromStory(
  text: string,
  resolve: (raw: string) => string | null,
  roles: RoleProfile[],
  opts?: { minConfidence?: number; minMatched?: number; ambiguityMargin?: number },
): RoleInferenceResult {
  return inferRoleFromSkills(extractSkillMentions(text, resolve), roles, opts);
}
