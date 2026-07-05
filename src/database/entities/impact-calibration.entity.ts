import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TransitionKind } from '../../modules/gap-report/gap-progress';

/**
 * ME2 (Wave MEASURE): one row per recommended_action from a scan-N gap report, calibrating its
 * predicted impact (impact-simulator's ExpectedImpact) against what actually happened by scan-N+1.
 * PII-free by construction: ids/enums/numbers only, no CV/JD text. Written best-effort (never-throw)
 * as a piggyback of CvMatchesService.getProgress — see that method for the write path.
 */
@Entity('impact_calibrations')
@Index(['userId', 'createdAt'])
export class ImpactCalibrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Column('uuid', { name: 'prior_match_id' })
  priorMatchId!: string;

  @Column('uuid', { name: 'current_match_id' })
  currentMatchId!: string;

  @Column({ type: 'varchar', length: 64, name: 'jd_content_hash' })
  jdContentHash!: string;

  @Column({ type: 'varchar', length: 120, name: 'canonical_name' })
  canonicalName!: string;

  @Column({ type: 'varchar', length: 32, name: 'action_type' })
  actionType!: string;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'predicted_score_min' })
  predictedScoreMin!: string;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'predicted_score_max' })
  predictedScoreMax!: string;

  @Column({
    type: 'numeric',
    precision: 6,
    scale: 3,
    name: 'predicted_severity_drop',
    nullable: true,
  })
  predictedSeverityDrop!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'actual_score_delta', nullable: true })
  actualScoreDelta!: string | null;

  @Column({
    type: 'numeric',
    precision: 6,
    scale: 3,
    name: 'actual_severity_delta',
    nullable: true,
  })
  actualSeverityDelta!: string | null;

  @Column({ type: 'varchar', length: 16, name: 'status_transition' })
  statusTransition!: TransitionKind;

  @Column({ type: 'boolean', default: false })
  attempted!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
