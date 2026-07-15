-- Interview Monitoring Pack (Wave I-MEASURE, Task 11) — 2026-07-14, extended 2026-07-15
-- Repo: skillbridge-ai · Lane: AI/interview · Run read-only against prod Postgres.
-- Tables: interview_sessions, interview_turns, ai_requests (request_type interview_assess /
-- interview_ask / interview_end / interview_answer). Window defaults to the last 14 days —
-- adjust the interval in one place per query.
--
-- ai_requests IS the metrics table. There is deliberately no /metrics endpoint, no dashboard and
-- no APM vendor: every question below is one query against data the app already writes, so a
-- saved .sql against the read replica is the whole tool. Add here rather than building infra.

-- 1) Interview starts per day
SELECT date_trunc('day', started_at) AS day, count(*) AS starts
FROM interview_sessions
WHERE started_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

-- 2) Completion rate per day (COMPLETED vs everything started that day)
SELECT
  date_trunc('day', started_at) AS day,
  count(*) AS started,
  count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
  round(
    count(*) FILTER (WHERE status = 'COMPLETED')::numeric / greatest(count(*), 1),
    2
  ) AS completion_rate
FROM interview_sessions
WHERE started_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

-- 3) Average answered-turn count per completed session
SELECT
  avg(t.answered) AS avg_answered_turns,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY t.answered) AS p50_answered_turns
FROM (
  SELECT s.id, count(tu.id) FILTER (WHERE tu.user_answer_text IS NOT NULL) AS answered
  FROM interview_sessions s
  JOIN interview_turns tu ON tu.session_id = s.id
  WHERE s.status = 'COMPLETED'
    AND s.started_at >= now() - interval '14 days'
  GROUP BY s.id
) t;

-- 4) Realtime fallback rate — VOICE/HYBRID sessions that never got a realtime session id
--    (they fell back to the non-realtime path).
SELECT
  count(*) AS voice_sessions,
  count(*) FILTER (WHERE realtime_session_id IS NULL) AS no_realtime,
  round(
    count(*) FILTER (WHERE realtime_session_id IS NULL)::numeric / greatest(count(*), 1),
    2
  ) AS fallback_rate
FROM interview_sessions
WHERE mode IN ('VOICE', 'HYBRID')
  AND started_at >= now() - interval '14 days';

-- 5) LLM failure rate per interview request type
SELECT
  request_type,
  count(*) AS requests,
  count(*) FILTER (WHERE status = 'FAILED') AS failed,
  round(count(*) FILTER (WHERE status = 'FAILED')::numeric / greatest(count(*), 1), 3)
    AS failure_rate
FROM ai_requests
WHERE request_type LIKE 'interview%'
  AND created_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY requests DESC;

-- 6) Latency per interview request type (avg + p95, successful calls only)
SELECT
  request_type,
  count(*) AS requests,
  round(avg(latency_ms)) AS avg_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
FROM ai_requests
WHERE request_type LIKE 'interview%'
  AND status = 'SUCCESS'
  AND latency_ms IS NOT NULL
  AND created_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY requests DESC;

-- 7) Score distribution over completed sessions (band buckets mirror the BARS bands)
SELECT
  CASE
    WHEN overall_score <= 40 THEN 'poor (0-40)'
    WHEN overall_score <= 60 THEN 'borderline (41-60)'
    WHEN overall_score <= 80 THEN 'solid (61-80)'
    ELSE 'outstanding (81-100)'
  END AS band,
  count(*) AS sessions
FROM interview_sessions
WHERE status = 'COMPLETED'
  AND overall_score IS NOT NULL
  AND started_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY min(overall_score);

-- 8) Empty/degraded report count — COMPLETED sessions missing the pieces the FE renders.
--    Any non-zero row here is a silent-degrade signal (score without explanations, or a
--    completed interview with no final score at all).
SELECT
  count(*) FILTER (WHERE final_score IS NULL) AS completed_without_final_score,
  count(*) FILTER (
    WHERE final_score IS NOT NULL
      AND jsonb_array_length(coalesce(final_score -> 'score_explanations', '[]'::jsonb)) = 0
  ) AS completed_without_explanations,
  count(*) FILTER (
    WHERE gap_items IS NOT NULL AND jsonb_array_length(gap_items) = 0
  ) AS completed_with_empty_gap_items
FROM interview_sessions
WHERE status = 'COMPLETED'
  AND started_at >= now() - interval '14 days';

-- 9) Session failure rate — sessions whose finalization actually threw. (2026-07-15)
--    Read this WITH query 2: completion_rate alone cannot tell a broken session from an
--    abandoned one, because both used to sit in IN_PROGRESS forever.
--
--    `FAILED` is written by the stale-session sweep's catch, and that sweep is start-triggered,
--    not a cron — a session only earns the label once the user starts their NEXT interview. So
--    the two backlog columns matter as much as the rate: they are rows that have already gone
--    stale but nobody has come back to trigger the sweep for. A fail_rate read without them
--    understates the damage.
SELECT
  count(*) AS started,
  count(*) FILTER (WHERE status = 'FAILED') AS failed,
  round(count(*) FILTER (WHERE status = 'FAILED')::numeric / greatest(count(*), 1), 3)
    AS fail_rate,
  -- not yet swept: expired mid-interview, waiting for the user's next start
  count(*) FILTER (WHERE status = 'IN_PROGRESS' AND expires_at < now())
    AS backlog_stuck_in_progress,
  -- not yet swept: reached COMPLETED but /end never landed, so no score was ever written
  count(*) FILTER (WHERE status = 'COMPLETED' AND overall_score IS NULL AND expires_at < now())
    AS backlog_stranded_unscored
FROM interview_sessions
WHERE started_at >= now() - interval '14 days';
