import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';

export type CvVersionOrigin = 'MANUAL' | 'AUTO_PRE_RESTORE' | 'AUTO_PRE_IMPORT';

/**
 * A point-in-time snapshot of a CV's canonical builder document. Powers version
 * history + restore — a feature Reactive Resume does not have (it keeps a single
 * blob). MANUAL snapshots are user-initiated ("Save version"); AUTO_* ones are
 * system-captured undo points (before a restore/import) and are pruned to a cap.
 */
@Entity('cv_versions')
@Index(['cvId', 'createdAt'])
export class CvVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'cv_id' })
  cvId!: string;

  /** Full canonical builder document at capture time. */
  @Column({ type: 'jsonb' })
  snapshot!: CanonicalCvDocument;

  /** CV title at capture time — cheap list display without loading the snapshot. */
  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  /** Optional user label, e.g. "Before tailoring". */
  @Column({ type: 'varchar', nullable: true })
  label!: string | null;

  @Column({ type: 'varchar', default: 'MANUAL' })
  origin!: CvVersionOrigin;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
