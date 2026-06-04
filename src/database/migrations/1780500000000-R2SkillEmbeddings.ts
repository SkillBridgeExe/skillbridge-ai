import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R2 steps 6-7 — semantic skill-matching infrastructure (blueprint vector_ops_plan).
 *
 *  - Installs pgvector (Supabase convention: into the `extensions` schema → the vector type is
 *    schema-qualified as extensions.vector everywhere, avoiding search_path surprises).
 *  - skill_embeddings: one row per embedded surface form (canonical | display | alias) of a
 *    taxonomy skill. model/dimensions/embedding_version are part of the identity — vectors from
 *    different models/dims/versions are geometrically incompatible and MUST never be mixed in
 *    one query (every consumer filters on the full tuple). NO vector index by design: at a few
 *    hundred rows an exact scan is faster and has perfect recall (pgvector guidance).
 *  - skill_resolutions: read-through cache of semantic-tier outcomes keyed by the normalized
 *    phrase + tuple. Bands: auto | needs_review | none. Bumping VECTOR_EMBEDDING_VERSION
 *    naturally invalidates both tables (new tuple).
 *
 *  NOTE (ts ordering): the remote migrations table already contains 1780490000000
 *  (UserProfilesAndSkills, applied outside this repo's local set) — this migration's timestamp
 *  is deliberately greater so ordering stays correct on every environment.
 *
 *  RLS: the project trigger `rls_auto_enable` force-enables RLS on new tables; the NestJS
 *  `postgres` role bypasses RLS, matching the posture of the other application tables.
 */
export class R2SkillEmbeddings1780500000000 implements MigrationInterface {
  name = 'R2SkillEmbeddings1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.skill_embeddings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
        variant varchar(16) NOT NULL,
        source_text text NOT NULL,
        embedding extensions.vector(1024) NOT NULL,
        model varchar(64) NOT NULL,
        dimensions int NOT NULL,
        embedding_version varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_skill_embeddings_source UNIQUE (source_text, model, dimensions, embedding_version),
        CONSTRAINT chk_skill_embeddings_variant CHECK (variant IN ('canonical', 'display', 'alias'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_embeddings_skill ON public.skill_embeddings (skill_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_embeddings_tuple ON public.skill_embeddings (model, dimensions, embedding_version);`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.skill_resolutions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        phrase_norm text NOT NULL,
        phrase_raw text NOT NULL,
        resolved_skill_id uuid REFERENCES public.skills(id) ON DELETE SET NULL,
        band varchar(16) NOT NULL,
        similarity numeric(5, 4),
        model varchar(64) NOT NULL,
        dimensions int NOT NULL,
        embedding_version varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_skill_resolutions_key UNIQUE (phrase_norm, model, dimensions, embedding_version),
        CONSTRAINT chk_skill_resolutions_band CHECK (band IN ('auto', 'needs_review', 'none'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_resolutions_band ON public.skill_resolutions (band);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.skill_resolutions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.skill_embeddings;`);
    // The vector extension is intentionally NOT dropped (cheap, and document_chunks/RAG will use it).
  }
}
