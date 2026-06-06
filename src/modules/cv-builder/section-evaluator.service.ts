import { Injectable } from '@nestjs/common';
import { BulletAnalyzerService } from '../cv-review/bullet-analyzer.service';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import {
  BasicContent,
  BuilderSection,
  CertificationEntry,
  ChecklistItem,
  EducationEntry,
  EvaluateSectionRequestDto,
  EvaluateSectionResponseDto,
  ExperienceEntry,
  ProjectEntry,
  SectionContent,
  SkillsContent,
  SummaryContent,
} from './dto/evaluate-section.dto';

type Lang = 'vi' | 'en';

/** A single deterministic criterion: bilingual label + a boolean check + an actionable "missing" hint. */
interface Criterion {
  id: string;
  label: Record<Lang, string>;
  /** true = pass. */
  pass: boolean;
  /** Shown in `missing[]` when FAIL — actionable, in the request language. */
  hint?: Record<Lang, string>;
}

/**
 * R1b — deterministic per-section CV evaluator (spec §9.2-9.3). Powers the builder's live
 * "% + ✅/❌ + cần bổ sung" per section (Upzi-parity), IT-standard.
 *
 * 100% DETERMINISTIC (NO LLM) — same input → same checklist, reproducible & free:
 *   - bullet-quality criteria (verb-first / quantified / weak-opener / first-person / filler)
 *     reuse BulletAnalyzerService.checkLine — single source of truth with the R1 diagnosis.
 *   - structural criteria (presence of fields, reverse-chronological order, date completeness)
 *     are plain code on the structured form content.
 *   - "không lỗi chính tả" is a LIGHT format/typo heuristic (obvious signals only); TRUE spelling
 *     correction is the rewrite/proofread LLM path (CvRewriteService), not this gate.
 *
 * score = round(passed / total × 100); label by threshold; missing[] = hints of FAILED criteria.
 */
@Injectable()
export class SectionEvaluatorService {
  constructor(
    private readonly bullets: BulletAnalyzerService,
    private readonly rubrics: RoleRubricService,
    private readonly taxonomy: SkillTaxonomyService,
  ) {}

  /** FE store default CV language is 'en'; only an explicit 'vi' switches. Single source for both sites. */
  private resolveLang(language?: string): Lang {
    return language === 'vi' ? 'vi' : 'en';
  }

  evaluate(req: EvaluateSectionRequestDto): EvaluateSectionResponseDto {
    const lang: Lang = this.resolveLang(req.language);
    const empty = this.isEmpty(req.section, req.content);

    if (empty) {
      return {
        score: 0,
        label: lang === 'en' ? 'No information yet' : 'Chưa có thông tin',
        checklist: this.criteriaFor(req).map((c) => ({
          id: c.id,
          criterion: c.label[lang],
          pass: false,
        })),
        missing: [
          lang === 'en'
            ? 'This section is empty — add your information.'
            : 'Mục này còn trống — hãy nhập thông tin.',
        ],
      };
    }

    const criteria = this.criteriaFor(req);
    const passed = criteria.filter((c) => c.pass).length;
    const score = criteria.length === 0 ? 0 : Math.round((passed / criteria.length) * 100);

    const checklist: ChecklistItem[] = criteria.map((c) => ({
      id: c.id,
      criterion: c.label[lang],
      pass: c.pass,
    }));
    const missing = criteria.filter((c) => !c.pass && c.hint).map((c) => c.hint![lang]);

    // Skills section: append role-rubric "you're missing in-demand skill X" hints.
    if (req.section === 'skills' && req.role_code) {
      missing.push(...this.roleSkillGaps(req.content as SkillsContent, req.role_code, lang));
    }

    // nonEmpty=true: a filled-but-all-failing section is "Cần cải thiện", NOT "Chưa có thông tin"
    // (the empty short-circuit above owns the "no information" label).
    return { score, label: this.label(score, lang, true), checklist, missing };
  }

  // ─── Section dispatch ──────────────────────────────────────────────────────
  private criteriaFor(req: EvaluateSectionRequestDto): Criterion[] {
    const lang: Lang = this.resolveLang(req.language);
    switch (req.section) {
      case 'basic':
        return this.basicCriteria(req.content as BasicContent);
      case 'summary':
        return this.summaryCriteria(req.content as SummaryContent, lang);
      case 'experience':
        return this.experienceCriteria(this.entries<ExperienceEntry>(req.content), lang);
      case 'education':
        return this.educationCriteria(this.entries<EducationEntry>(req.content));
      case 'projects':
        return this.projectsCriteria(this.entries<ProjectEntry>(req.content), lang);
      case 'skills':
        return this.skillsCriteria(req.content as SkillsContent);
      case 'certifications':
        return this.certificationsCriteria(this.entries<CertificationEntry>(req.content));
      default:
        return [];
    }
  }

  // ─── basic ──────────────────────────────────────────────────────────────────
  private basicCriteria(c: BasicContent): Criterion[] {
    const coreOk = !!(
      c.fullName?.trim() &&
      c.email?.trim() &&
      c.phone?.trim() &&
      c.location?.trim()
    );
    const emailPro = !c.email || this.isProfessionalEmail(c.email);
    return [
      {
        id: 'basic_core',
        label: { vi: 'Đủ họ tên, email, SĐT, thành phố', en: 'Has full name, email, phone, city' },
        pass: coreOk,
        hint: {
          vi: `Bổ sung: ${this.missingBasicFields(c, 'vi')}`,
          en: `Add: ${this.missingBasicFields(c, 'en')}`,
        },
      },
      {
        id: 'basic_no_personal',
        label: {
          vi: 'Không ảnh/tuổi/giới tính/tình trạng hôn nhân',
          en: 'No photo/age/gender/marital status',
        },
        // The builder form has no such fields → satisfied by construction (Harvard convention).
        pass: true,
      },
      {
        id: 'basic_email_pro',
        label: { vi: 'Email chuyên nghiệp', en: 'Professional email' },
        pass: emailPro,
        hint: {
          vi: 'Dùng email nghiêm túc (vd ten.ho@gmail.com), tránh biệt danh.',
          en: 'Use a serious email (e.g. firstname.lastname@gmail.com), avoid nicknames.',
        },
      },
    ];
  }

  // ─── summary ──────────────────────────────────────────────────────────────────
  private summaryCriteria(c: SummaryContent, lang: Lang): Criterion[] {
    const text = (c.summary ?? '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    const sentences = text
      .split(/[.!?。]+/)
      .map((s) => s.trim())
      .filter(Boolean).length;
    const line = this.bullets.checkLine(text, lang);
    return [
      {
        id: 'sum_concise',
        label: {
          vi: '2-3 câu, ngắn gọn nêu thế mạnh + định hướng',
          en: '2-3 concise sentences: strengths + goal',
        },
        pass: words >= 15 && words <= 90 && sentences >= 1 && sentences <= 4,
        hint: {
          vi: 'Viết 2-3 câu súc tích nêu thế mạnh chính, định hướng nghề và giá trị nổi bật.',
          en: 'Write 2-3 concise sentences on key strengths, career goal, and standout value.',
        },
      },
      {
        id: 'sum_active',
        label: { vi: 'Câu chủ động, từ ngữ mạnh', en: 'Active voice, strong words' },
        pass: line.verbFirst || (!line.weakOpener && line.fillerCount === 0 && text.length > 0),
        hint: {
          vi: 'Dùng động từ mạnh, câu chủ động — tránh "Chịu trách nhiệm…", "Tham gia…".',
          en: 'Use strong verbs and active voice — avoid "Responsible for…", "Involved in…".',
        },
      },
      {
        id: 'sum_no_firstperson',
        label: { vi: 'Không đại từ nhân xưng (tôi/em/I)', en: 'No first-person pronouns (I/my)' },
        pass: !line.firstPerson,
        hint: {
          vi: 'Bỏ "tôi/em/của tôi" — CV chuẩn viết không ngôi.',
          en: 'Remove "I/my" — standard CVs are written without first person.',
        },
      },
      {
        id: 'sum_no_filler',
        label: { vi: 'Không từ mơ hồ/sáo rỗng', en: 'No vague/buzzword filler' },
        pass: line.fillerCount === 0,
        hint: {
          vi: 'Tránh "chăm chỉ, nhiệt tình, năng động" — thay bằng bằng chứng cụ thể.',
          en: 'Avoid "hardworking, passionate, dynamic" — replace with concrete evidence.',
        },
      },
      this.noTypoCriterion(text),
    ];
  }

  // ─── experience ──────────────────────────────────────────────────────────────────
  private experienceCriteria(entries: ExperienceEntry[], lang: Lang): Criterion[] {
    const filled = entries.filter(
      (e) => e.position || e.company || e.description || e.responsibilities || e.achievements,
    );
    // Bullets may live in description, responsibilities OR achievements (FE store has all three).
    const allBullets = filled.flatMap((e) =>
      this.splitBullets(
        [e.description, e.responsibilities, e.achievements].filter(Boolean).join('\n'),
      ),
    );
    const n = allBullets.length;
    const checks = allBullets.map((b) => this.bullets.checkLine(b, lang));
    const verbFirstRatio = n ? checks.filter((c) => c.verbFirst).length / n : 0;
    const quantRatio = n ? checks.filter((c) => c.quantified).length / n : 0;
    const anyFirstPerson = checks.some((c) => c.firstPerson);
    const startsWithDate = allBullets.some((b) => /^\s*(?:\(?\d{1,2}[/-]\d{2,4}|\d{4})\b/.test(b));

    return [
      {
        id: 'exp_reverse_chrono',
        label: {
          vi: 'Sắp xếp thời gian đảo ngược (mới → cũ)',
          en: 'Reverse-chronological (newest first)',
        },
        pass: this.isReverseChrono(filled.map((e) => this.endKey(e.endDate, e.startDate))),
        hint: {
          vi: 'Đưa công việc gần nhất lên đầu.',
          en: 'Put the most recent role first.',
        },
      },
      {
        id: 'exp_verb_first',
        label: {
          vi: 'Mỗi gạch đầu dòng bắt đầu bằng động từ mạnh',
          en: 'Each bullet starts with a strong verb',
        },
        pass: n > 0 && verbFirstRatio >= 0.7,
        hint: {
          vi: 'Bắt đầu mỗi gạch đầu dòng bằng động từ mạnh (Xây dựng, Tối ưu, Dẫn dắt…).',
          en: 'Start each bullet with a strong verb (Built, Optimized, Led…).',
        },
      },
      {
        id: 'exp_quantified',
        label: { vi: 'Có kết quả/thành tựu đo lường được', en: 'Has quantified results' },
        pass: n > 0 && quantRatio >= 0.4,
        hint: {
          vi: 'Thêm con số chứng minh kết quả (giảm 40% thời gian, 100+ người dùng…).',
          en: 'Add numbers proving impact (cut 40% time, 100+ users…).',
        },
      },
      {
        id: 'exp_not_start_date',
        label: {
          vi: 'Không bắt đầu gạch đầu dòng bằng ngày tháng',
          en: 'Bullets do not start with a date',
        },
        pass: !startsWithDate,
        hint: {
          vi: 'Đừng mở đầu gạch đầu dòng bằng ngày tháng — bắt đầu bằng động từ.',
          en: 'Do not open a bullet with a date — start with a verb.',
        },
      },
      {
        id: 'exp_no_firstperson',
        label: { vi: 'Không dùng đại từ nhân xưng', en: 'No first-person pronouns' },
        pass: !anyFirstPerson,
        hint: { vi: 'Bỏ "tôi/em" trong mô tả công việc.', en: 'Remove "I/my" from descriptions.' },
      },
      this.noTypoCriterion(allBullets.join('\n')),
    ];
  }

  // ─── education ──────────────────────────────────────────────────────────────────
  private educationCriteria(entries: EducationEntry[]): Criterion[] {
    const filled = entries.filter((e) => e.school || e.major);
    // Label promises "dates" → enforce a year is present (truthy fallback handles ''→startYear).
    const allHaveCore =
      filled.length > 0 &&
      filled.every(
        (e) => e.school?.trim() && e.major?.trim() && (e.startYear?.trim() || e.endYear?.trim()),
      );
    return [
      {
        id: 'edu_reverse_chrono',
        label: {
          vi: 'Sắp xếp thời gian đảo ngược (mới → cũ)',
          en: 'Reverse-chronological (newest first)',
        },
        // `||` (not `??`) so an empty-string endYear falls back to startYear (in-progress degree).
        pass: this.isReverseChrono(filled.map((e) => this.yearKey(e.endYear || e.startYear))),
        hint: { vi: 'Đưa bằng cấp gần nhất lên đầu.', en: 'Put the most recent degree first.' },
      },
      {
        id: 'edu_core',
        label: { vi: 'Có tên trường + ngành + thời gian', en: 'Has school + major + dates' },
        pass: allHaveCore,
        hint: {
          vi: 'Mỗi mục cần đủ tên trường, ngành học và thời gian.',
          en: 'Each entry needs school, major, and dates.',
        },
      },
      {
        id: 'edu_gpa',
        label: {
          vi: 'Ghi GPA nếu khá/giỏi (≥ 3.0/4 hoặc 7/10)',
          en: 'GPA shown if strong (≥ 3.0/4 or 7/10)',
        },
        pass: filled.some((e) => this.gpaIsStrong(e.gpa)) || filled.every((e) => !e.gpa),
        hint: {
          vi: 'Nếu GPA khá/giỏi, hãy ghi rõ để tạo lợi thế.',
          en: 'If your GPA is strong, show it as an advantage.',
        },
      },
      this.noTypoCriterion(
        filled.map((e) => `${e.school} ${e.major} ${e.achievements ?? ''}`).join('\n'),
      ),
    ];
  }

  // ─── projects ──────────────────────────────────────────────────────────────────
  private projectsCriteria(entries: ProjectEntry[], lang: Lang): Criterion[] {
    const filled = entries.filter((p) => p.name);
    const allHaveTech = filled.length > 0 && filled.every((p) => p.tools?.trim());
    // Impact may be in description, contribution OR result (FE store has all three).
    const bulletsByProj = filled.flatMap((p) =>
      this.splitBullets([p.description, p.contribution, p.result].filter(Boolean).join('\n')),
    );
    const checks = bulletsByProj.map((b) => this.bullets.checkLine(b, lang));
    const quantRatio = checks.length
      ? checks.filter((c) => c.quantified).length / checks.length
      : 0;
    return [
      {
        id: 'proj_name_role_tech',
        label: { vi: 'Có tên dự án + vai trò + công nghệ', en: 'Has name + role + tech stack' },
        pass: allHaveTech && filled.every((p) => p.role?.trim()),
        hint: {
          vi: 'Mỗi dự án cần tên, vai trò của bạn và công nghệ sử dụng.',
          en: 'Each project needs a name, your role, and the tech used.',
        },
      },
      {
        id: 'proj_quantified',
        label: {
          vi: 'Mô tả có đóng góp/kết quả đo lường',
          en: 'Description has measurable contribution',
        },
        pass: bulletsByProj.length > 0 && quantRatio >= 0.3,
        hint: {
          vi: 'Nêu rõ bạn làm gì + kết quả (số liệu nếu có).',
          en: 'State what you did + the result (numbers if possible).',
        },
      },
      this.noTypoCriterion(bulletsByProj.join('\n')),
    ];
  }

  // ─── skills ──────────────────────────────────────────────────────────────────
  private skillsCriteria(c: SkillsContent): Criterion[] {
    const tech = c.technicalSkills ?? [];
    const grouped = (c.technicalSkills?.length ?? 0) + (c.tools?.length ?? 0) > 0;
    const total = tech.length + (c.tools?.length ?? 0) + (c.softSkills?.length ?? 0);
    const knownRatio = tech.length
      ? tech.filter((s) => this.isKnownSkill(s)).length / tech.length
      : 0;
    return [
      {
        id: 'skill_grouped',
        label: {
          vi: 'Phân nhóm rõ (kỹ thuật / công cụ / mềm)',
          en: 'Clearly grouped (technical / tools / soft)',
        },
        pass: grouped,
        hint: {
          vi: 'Tách kỹ năng kỹ thuật và công cụ thành nhóm riêng.',
          en: 'Group technical skills and tools separately.',
        },
      },
      {
        id: 'skill_canonical',
        label: { vi: 'Dùng tên kỹ năng chuẩn', en: 'Uses standard skill names' },
        pass: tech.length === 0 || knownRatio >= 0.6,
        hint: {
          vi: 'Dùng tên chuẩn (ReactJS, Node.js, PostgreSQL…) để qua bộ lọc ATS.',
          en: 'Use standard names (ReactJS, Node.js, PostgreSQL…) to pass ATS filters.',
        },
      },
      {
        id: 'skill_not_overstuffed',
        label: {
          vi: 'Không liệt kê tràn lan (≤ ~20 kỹ năng)',
          en: 'Not over-stuffed (≤ ~20 skills)',
        },
        pass: total <= 20,
        hint: {
          vi: 'Chọn lọc kỹ năng liên quan nhất, đừng liệt kê quá dài.',
          en: 'Keep only the most relevant skills; avoid an overly long list.',
        },
      },
    ];
  }

  // ─── certifications ──────────────────────────────────────────────────────────────────
  private certificationsCriteria(entries: CertificationEntry[]): Criterion[] {
    const filled = entries.filter((c) => c.name);
    const allCore =
      filled.length > 0 &&
      filled.every((c) => c.name?.trim() && c.organization?.trim() && c.issueDate?.trim());
    return [
      {
        id: 'cert_reverse_chrono',
        label: {
          vi: 'Sắp xếp thời gian đảo ngược + tên/đơn vị/ngày',
          en: 'Reverse-chronological + name/issuer/date',
        },
        pass: this.isReverseChrono(filled.map((c) => this.dateKey(c.issueDate))),
        hint: {
          vi: 'Đưa chứng chỉ mới nhất lên đầu.',
          en: 'Put the most recent certificate first.',
        },
      },
      {
        id: 'cert_core',
        label: {
          vi: 'Đủ tên chứng chỉ + đơn vị cấp + ngày cấp',
          en: 'Has name + issuer + issue date',
        },
        pass: allCore,
        hint: {
          vi: 'Mỗi chứng chỉ cần tên, đơn vị cấp và ngày cấp.',
          en: 'Each certificate needs a name, issuer, and issue date.',
        },
      },
      this.noTypoCriterion(filled.map((c) => `${c.name} ${c.organization ?? ''}`).join('\n')),
    ];
  }

  // ─── shared helpers ──────────────────────────────────────────────────────────────────

  /** Light deterministic typo/format heuristic — NOT a dictionary spell-check (that's the LLM rewrite path). */
  private noTypoCriterion(text: string): Criterion {
    return {
      id: 'no_typo',
      label: {
        vi: 'Không lỗi định dạng/chính tả rõ ràng',
        en: 'No obvious format/spelling issues',
      },
      pass: !this.hasObviousTypos(text),
      hint: {
        vi: 'Kiểm tra khoảng trắng thừa, dấu câu lặp, viết HOA bất thường; bấm "AI giúp" để soát chính tả.',
        en: 'Check double spaces, repeated punctuation, odd CAPS; use "AI help" to proofread.',
      },
    };
  }

  private hasObviousTypos(text: string): boolean {
    const t = text ?? '';
    if (t.trim().length === 0) return false;
    if (/\s{2,}/.test(t)) return true; // double spaces
    if (/[!?.,]{2,}/.test(t)) return true; // repeated punctuation "!!", ".."
    if (/[,.;:][^\s)\]]/.test(t.replace(/\d[.,]\d/g, ''))) return true; // missing space after punctuation (excl. decimals)
    if (/\b[A-ZĐ]{4,}\b/.test(t.replace(/\b(?:[A-Z]{2,5})\b/g, ''))) return true; // long ALL-CAPS run (not an acronym)
    return false;
  }

  private isProfessionalEmail(email: string): boolean {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    const bad = [
      'cute',
      'baby',
      'sexy',
      'xxx',
      'cool',
      'pro',
      'forever',
      'lonely',
      'angel',
      'devil',
    ];
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(email)) return false;
    return !bad.some((w) => local.includes(w));
  }

  private missingBasicFields(c: BasicContent, lang: Lang): string {
    const labels: Record<string, Record<Lang, string>> = {
      fullName: { vi: 'họ tên', en: 'full name' },
      email: { vi: 'email', en: 'email' },
      phone: { vi: 'số điện thoại', en: 'phone' },
      location: { vi: 'thành phố', en: 'city' },
    };
    const miss = (['fullName', 'email', 'phone', 'location'] as const)
      .filter((k) => !c[k]?.trim())
      .map((k) => labels[k][lang]);
    return miss.length ? miss.join(', ') : lang === 'vi' ? '(đủ rồi)' : '(complete)';
  }

  private roleSkillGaps(c: SkillsContent, roleCode: string, lang: Lang): string[] {
    const rubric = this.rubrics.getRubric(roleCode);
    if (!rubric) return [];
    const have = new Set(
      [...(c.technicalSkills ?? []), ...(c.tools ?? [])]
        .map((s) => SkillTaxonomyService.normalizeKey(s))
        .map((k) => this.taxonomy.lookupByAliasKey(k))
        .filter((x): x is string => !!x),
    );
    const required = rubric.skills
      .filter((s) => s.importance === 'REQUIRED' && !have.has(s.skill_canonical_name))
      .slice(0, 4)
      .map(
        (s) =>
          this.taxonomy.getByCanonical(s.skill_canonical_name)?.display_name ??
          s.skill_canonical_name,
      );
    if (required.length === 0) return [];
    return [
      lang === 'vi'
        ? `Vai trò này thường yêu cầu thêm: ${required.join(', ')}.`
        : `This role usually also expects: ${required.join(', ')}.`,
    ];
  }

  // ─── parsing helpers ──────────────────────────────────────────────────────────────────
  private entries<T>(content: SectionContent): T[] {
    const e = (content as { entries?: T[] }).entries;
    return Array.isArray(e) ? e : [];
  }

  private isEmpty(section: BuilderSection, content: SectionContent): boolean {
    switch (section) {
      case 'basic': {
        const c = content as BasicContent;
        // .trim() so a whitespace-only field is NOT treated as "non-empty"; include all
        // contact fields so a links-only draft still routes through normal scoring.
        return ![c.fullName, c.email, c.phone, c.location, c.linkedin, c.github, c.portfolio].some(
          (v) => v?.trim(),
        );
      }
      case 'summary':
        return !(content as SummaryContent).summary?.trim();
      case 'skills': {
        // languages EXCLUDED on purpose: skillsCriteria does not score languages, so a
        // languages-only section is effectively empty (avoids a vacuous 67% — review finding).
        const c = content as SkillsContent;
        return (
          (c.technicalSkills?.length ?? 0) +
            (c.tools?.length ?? 0) +
            (c.softSkills?.length ?? 0) ===
          0
        );
      }
      default: {
        const list = this.entries<Record<string, unknown>>(content);
        return (
          list.filter((e) => Object.values(e).some((v) => typeof v === 'string' && v.trim()))
            .length === 0
        );
      }
    }
  }

  /**
   * Split a rich-text description into bullet lines. Splits on newlines AND inline bullet
   * glyphs (• · ▪ ‣) so a pasted single-line "• A • B • C" yields 3 bullets, not 1 (which
   * would make the ratio thresholds all-or-nothing — review finding).
   */
  private splitBullets(desc?: string): string[] {
    if (!desc) return [];
    return desc
      .split(/\r?\n|(?=[•·▪‣])/)
      .map((l) => l.replace(/^\s*[-•·▪‣*]\s*/, '').trim())
      .filter((l) => l.length > 0);
  }

  /**
   * Reverse-chronological = the entries that HAVE a date are non-increasing. Unknown dates
   * (key 0) are SKIPPED, not treated as oldest — a newest-entry-with-blank-date (common while
   * editing) must not falsely fail the check (review finding).
   */
  private isReverseChrono(keys: number[]): boolean {
    const known = keys.filter((k) => k > 0);
    if (known.length <= 1) return true;
    for (let i = 1; i < known.length; i++) {
      if (known[i] > known[i - 1]) return false;
    }
    return true;
  }

  /** End date for ordering; ongoing role (blank end) falls back to start. Unknown = 0 (skipped). */
  private endKey(end?: string, start?: string): number {
    return this.dateKey(end) || this.dateKey(start);
  }

  /** "MM/YYYY" or "YYYY" → sortable int YYYYMM. Unknown → 0. */
  private dateKey(s?: string): number {
    const m = (s ?? '').match(/(?:(\d{1,2})[/-])?(\d{4})/);
    if (!m) return 0;
    const year = parseInt(m[2], 10);
    const month = m[1] ? parseInt(m[1], 10) : 1;
    return year * 100 + month;
  }

  private yearKey(s?: string): number {
    const m = (s ?? '').match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : 0;
  }

  private gpaIsStrong(gpa?: string): boolean {
    if (!gpa) return false;
    // \d{1,2} on the integer part so "10/10" / "10" parse as 10 (not "1"); review finding.
    const m = gpa.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:\/\s*(\d{1,2}))?/);
    if (!m) return false;
    const val = parseFloat(m[1].replace(',', '.'));
    const scale = m[2] ? parseInt(m[2], 10) : val > 4.5 ? 10 : 4;
    return scale === 10 ? val >= 7 : val >= 3.0;
  }

  private isKnownSkill(s: string): boolean {
    return !!this.taxonomy.lookupByAliasKey(SkillTaxonomyService.normalizeKey(s));
  }

  private label(score: number, lang: Lang, nonEmpty = false): string {
    if (score >= 80) return lang === 'en' ? 'Very good' : 'Rất tốt';
    if (score >= 1 || nonEmpty) return lang === 'en' ? 'Needs improvement' : 'Cần cải thiện';
    return lang === 'en' ? 'No information yet' : 'Chưa có thông tin';
  }
}
