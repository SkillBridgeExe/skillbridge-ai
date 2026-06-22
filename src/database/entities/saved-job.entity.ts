import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('saved_jobs')
@Index(['userId', 'jobId'], { unique: true })
export class SavedJobEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'user_id' }) userId!: string;
  @Index() @Column('uuid', { name: 'job_id' }) jobId!: string;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
}
