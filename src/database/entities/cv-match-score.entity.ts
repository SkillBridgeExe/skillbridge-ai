import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cv_match_scores')
export class CvMatchScoreEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'match_id' })
  matchId!: string;

  @Index()
  @Column({ type: 'varchar', name: 'criteria_name' })
  criteriaName!: string;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  score!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  weight!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
