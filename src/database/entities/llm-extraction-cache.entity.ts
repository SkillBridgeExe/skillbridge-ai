import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('llm_extraction_cache')
export class LlmExtractionCacheEntity {
  @PrimaryColumn({ name: 'cache_key', type: 'varchar', length: 64 })
  cacheKey!: string;

  @Column({ type: 'jsonb' })
  payload!: unknown;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ name: 'model_code', type: 'varchar', length: 128 })
  modelCode!: string;

  @Column({ name: 'template_code', type: 'varchar', length: 128 })
  templateCode!: string;

  @Column({ name: 'prompt_template_version', type: 'integer' })
  promptTemplateVersion!: number;

  @Column({ name: 'hit_count', type: 'integer', default: 0 })
  hitCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_hit_at', type: 'timestamptz', nullable: true })
  lastHitAt!: Date | null;
}
