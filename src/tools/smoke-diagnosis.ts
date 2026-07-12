/**
 * End-to-end diagnosis smoke — boots the real Nest context and drives the EXACT production path
 * through the module SERVICES directly (no HTTP): CvReviewService.review() → CvJdMatchService.match()
 * → GapReportService.build(), on one hardcoded CV+JD fixture (no PII — fake name/email).
 *
 *   pnpm diagnosis:smoke
 *
 * COST WARNING: this makes 2-3 REAL LLM calls per run (cv_review + cv_jd_match extraction, plus a
 * cv_parse Stage-1 call inside cv_review). Run it deliberately, not in a loop. NOT a CI gate — it
 * needs a real OPENAI_API_KEY (.env) + a reachable Postgres DATABASE_URL (reads one existing user
 * row for tracing FKs; writes real ai_requests/ai_results rows like any live request would).
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../app.module';
import { DatabaseService } from '../infrastructure/database/database.service';
import { CvReviewService } from '../modules/cv-review/cv-review.service';
import { CvJdMatchService } from '../modules/cv-jd-match/cv-jd-match.service';
import { GapReportService } from '../modules/gap-report/gap-report.service';
import { GapItem } from '../modules/gap-engine/gap-item';

// ── Fixture: IT fresher CV + backend-fresher JD. Fake identity only. ────────────────────────────
const CV_TEXT = `Nguyen Van Test
Fresher Backend Developer
Email: test@example.com | SDT: 0900000000 | Ha Noi, Viet Nam

Hoc van:
Dai hoc Bach Khoa Ha Noi - Ky thuat phan mem, 2020 - 2024

Ky nang:
JavaScript, Node.js, Express, MySQL, Git, HTML, CSS, REST API

Kinh nghiem:
Thuc tap sinh Backend Developer - Cong ty ABC Tech (06/2023 - 12/2023)
- Tham gia xay dung API quan ly don hang bang Node.js va Express cho he thong ban hang noi bo
- Viet truy van MySQL de thong ke doanh thu theo tuan
- Phoi hop voi nhom 4 nguoi theo quy trinh Scrum, bao cao tien do hang ngay

Du an ca nhan:
Website quan ly chi tieu ca nhan
- Xay dung backend bang Node.js, Express, MySQL, trien khai xac thuc JWT
- Viet REST API cho cac chuc nang them/sua/xoa giao dich

Hoat dong:
Thanh vien CLB Lap trinh truong Dai hoc Bach Khoa (2021 - 2023)`;

const JD_TEXT = `Tuyen dung: Backend Developer (Fresher)

Mo ta cong viec:
Chung toi dang tim Backend Developer Fresher tham gia doi ngu phat trien san pham SaaS quan ly ban hang.

Yeu cau:
- Tot nghiep Dai hoc/Cao dang chuyen nganh CNTT hoac tuong duong
- Nam vung Node.js va Express.js
- Co kien thuc ve PostgreSQL hoac cac he quan tri CSDL quan he khac
- Hieu va thiet ke duoc REST API
- Thanh thao Git, quen quy trinh lam viec nhom voi Scrum/Agile
- Co kien thuc co ban ve Docker la mot loi the
- Nam vung nguyen ly lap trinh huong doi tuong (OOP)
- Co kha nang viet unit test co ban
- Doc hieu tai lieu ky thuat tieng Anh
- Chu dong hoc hoi cong nghe moi, chiu duoc ap luc deadline`;

function fail(failures: string[], msg: string): void {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const failures: string[] = [];
  try {
    const db = app.get(DatabaseService);
    const config = app.get(ConfigService);
    const cvReview = app.get(CvReviewService);
    const cvJdMatch = app.get(CvJdMatchService);
    const gapReport = app.get(GapReportService);

    const users = await db.query<{ id: string }>(`SELECT id FROM public.users LIMIT 1`);
    if (users.length === 0) {
      throw new Error(
        'No user row found in DB — seed at least one user before running this smoke.',
      );
    }
    const userId = users[0].id;
    const cvId = randomUUID();
    const jdId = randomUUID();

    console.log(`Using existing user ${userId} · fresh cv_id=${cvId} jd_id=${jdId}\n`);

    // ── Step 1: CV review (Stage-1 parse + hybrid rule/LLM rubric scoring) ────────────────────
    console.log('Running CV review...');
    const review = await cvReview.review(userId, {
      cv_id: cvId,
      parsed_text: CV_TEXT,
      prompt_template_code: 'cv_review_v1',
    });

    // ── Step 2: CV-JD match (LLM extraction + deterministic diff) ─────────────────────────────
    console.log('Running CV-JD match...');
    const match = await cvJdMatch.match(userId, {
      cv_id: cvId,
      cv_text: CV_TEXT,
      jd_id: jdId,
      jd_text: JD_TEXT,
      scoring_template_code: config.get<string>('cvJdMatch.templateCode') ?? 'cv_jd_match_v2',
    });

    // ── Step 3: gap report (pure composition, no LLM) — mirrors CvMatchesService.getGapReport ──
    console.log('Building gap report...');
    const report = await gapReport.build({
      match: match.parsed_response,
      review: review.parsed_response,
      lang: 'vi',
    });

    // ── Invariants ─────────────────────────────────────────────────────────────────────────────
    console.log('\nInvariants:');

    const reviewScore = review.total_score;
    const matchScore = match.parsed_response.overall_score;
    if (Number.isFinite(reviewScore) && reviewScore >= 0 && reviewScore <= 100) {
      ok(`review overall_score in [0,100]: ${reviewScore}`);
    } else {
      fail(failures, `review overall_score out of [0,100]: ${reviewScore}`);
    }
    // MEASURE M1: score must be a real number OR an honest null with a stated reason — a null
    // without NO_REQUIREMENT_BASIS (or a 0-as-placeholder) is exactly the failure this smoke exists
    // to catch.
    const degradedReasons = match.parsed_response.degraded_reasons ?? [];
    if (matchScore === null) {
      if (degradedReasons.includes('NO_REQUIREMENT_BASIS')) {
        ok(`match overall_score honest-null (degraded_reasons: ${degradedReasons.join(',')})`);
      } else {
        fail(
          failures,
          `match overall_score null WITHOUT NO_REQUIREMENT_BASIS (degraded_reasons: ${degradedReasons.join(',') || 'none'})`,
        );
      }
    } else if (Number.isFinite(matchScore) && matchScore >= 0 && matchScore <= 100) {
      ok(`match overall_score in [0,100]: ${matchScore}`);
    } else {
      fail(failures, `match overall_score out of [0,100]: ${matchScore}`);
    }

    // MEASURE M1 / TRUST T1: input_quality must be classified (usable/suspect/unusable) so the FE
    // can suppress scores on unusable input. Absent = the trust gate silently disappeared.
    const inputQuality = review.parsed_response.extraction_quality?.input_quality;
    if (inputQuality && ['usable', 'suspect', 'unusable'].includes(inputQuality)) {
      ok(`extraction_quality.input_quality present: ${inputQuality}`);
    } else {
      fail(failures, `extraction_quality.input_quality missing/invalid: ${inputQuality}`);
    }

    const dims = ['action_verbs', 'skills_relevance', 'experience', 'education'] as const;
    const provenance = review.parsed_response.dimension_provenance;
    const missingDims = dims.filter((d) => !provenance?.[d]?.source);
    if (missingDims.length === 0) {
      ok(
        `dimension_provenance present for all 4 dims (${dims.map((d) => provenance?.[d]?.source).join(', ')})`,
      );
    } else {
      fail(failures, `dimension_provenance missing for: ${missingDims.join(', ')}`);
    }

    const gapItems: GapItem[] = report.gap_items;
    if (gapItems.length === 0) {
      fail(failures, 'gap_items is empty — fixture expected to produce at least one gap');
    } else {
      let sorted = true;
      for (let i = 1; i < gapItems.length; i++) {
        if (gapItems[i].severity > gapItems[i - 1].severity) {
          sorted = false;
          break;
        }
      }
      if (sorted) ok(`gap_items (${gapItems.length}) sorted severity desc`);
      else fail(failures, 'gap_items not sorted by severity desc');
    }

    const topFixable = gapItems.find((g) => g.fixability !== 'not_fixable_now');
    const topAction = report.recommended_actions[0];
    if (!topAction) {
      fail(failures, 'recommended_actions is empty — cannot check top-fixable-gap alignment');
    } else if (!topFixable) {
      fail(failures, 'no fixable gap_items found to compare against recommended_actions[0]');
    } else if (topAction.skill_canonical === topFixable.canonical_name) {
      ok(`recommended_actions[0] (${topAction.skill_canonical}) matches top fixable gap`);
    } else {
      fail(
        failures,
        `recommended_actions[0]="${topAction.skill_canonical}" != top fixable gap "${topFixable.canonical_name}"`,
      );
    }

    const verdicts = ['safe_apply', 'stretch', 'not_recommended'];
    if (report.fit && verdicts.includes(report.fit.verdict) && report.fit.reasons.length > 0) {
      ok(`fit.verdict=${report.fit.verdict} reasons=[${report.fit.reasons.join(',')}]`);
    } else {
      fail(failures, `fit missing/invalid: ${JSON.stringify(report.fit)}`);
    }

    // MEASURE M1 / TRUST T4: a pasted JD must yield a jd_intelligence block with an explicit
    // 4-state status (the v1/no-JD paths omit the block — this fixture pastes a real JD).
    const jdStatuses = [
      'available',
      'no_eligible_dimension_found',
      'not_extracted',
      'not_requested',
    ];
    const jdStatus = report.jd_intelligence?.status;
    if (jdStatus && jdStatuses.includes(jdStatus)) {
      ok(`jd_intelligence.status present: ${jdStatus}`);
    } else if (!report.jd_intelligence) {
      fail(failures, 'jd_intelligence block missing despite pasted JD (v2 extraction expected)');
    } else {
      fail(failures, `jd_intelligence.status missing/invalid: ${jdStatus}`);
    }

    let impactRangeBad = 0;
    for (const a of report.recommended_actions) {
      if (a.expected_impact && a.expected_impact.score_min > a.expected_impact.score_max) {
        impactRangeBad++;
      }
    }
    if (impactRangeBad === 0) ok('every expected_impact has score_min <= score_max');
    else fail(failures, `${impactRangeBad} action(s) have score_min > score_max`);

    let longQuotes = 0;
    for (const g of gapItems) {
      for (const e of g.evidence ?? []) {
        if (e.quote && e.quote.length > 200) longQuotes++;
      }
    }
    if (longQuotes === 0) ok('every evidence quote <= 200 chars');
    else fail(failures, `${longQuotes} evidence quote(s) exceed 200 chars`);

    // ── Summary table ──────────────────────────────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    console.log(
      `Review: overall=${review.total_score} ats=${review.parsed_response.ats_rule_score} confidence=${review.confidence_score} input_quality=${review.parsed_response.extraction_quality?.input_quality}`,
    );
    console.log(`JD intel: status=${report.jd_intelligence?.status}`);
    console.log(
      `Match:  overall=${match.parsed_response.overall_score} match_ratio=${match.parsed_response.match_ratio} required_coverage=${match.parsed_response.required_coverage}`,
    );
    console.log(`Fit:    ${report.fit?.verdict} (${(report.fit?.reasons ?? []).join(', ')})`);
    console.log(`Top gaps (${Math.min(5, gapItems.length)}/${gapItems.length}):`);
    for (const g of gapItems.slice(0, 5)) {
      console.log(
        `  - ${g.canonical_name} [${g.type}] severity=${g.severity} status=${g.cv_status} fixability=${g.fixability}`,
      );
    }
    if (topAction) {
      console.log(
        `Top action: ${topAction.action_type} ${topAction.skill_canonical}` +
          (topAction.expected_impact
            ? ` impact=[${topAction.expected_impact.score_min},${topAction.expected_impact.score_max}]`
            : ''),
      );
    }

    if (failures.length > 0) {
      console.log(`\n${failures.length} invariant(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll invariants passed.');
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`diagnosis smoke failed: ${(err as Error).message}`);
  process.exit(1);
});
