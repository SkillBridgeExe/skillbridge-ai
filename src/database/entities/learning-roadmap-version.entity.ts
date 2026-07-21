import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('learning_roadmap_versions')
@Index(['roadmapId', 'versionNo'], { unique: true })
export class LearningRoadmapVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'roadmap_id' })
  roadmapId!: string;

  @Column({ type: 'int', name: 'version_no' })
  versionNo!: number;

  @Column({ type: 'jsonb', name: 'input_snapshot' })
  inputSnapshot!: Record<string, unknown>;

  @Column({ type: 'jsonb', name: 'source_gap_snapshot' })
  sourceGapSnapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64, name: 'resource_catalog_version' })
  resourceCatalogVersion!: string;

  @Column({ type: 'varchar', length: 64, name: 'content_version' })
  contentVersion!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
