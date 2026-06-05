import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobDescriptionSourceType = 'PASTED' | 'UPLOADED' | 'SAMPLE';

@Entity('job_descriptions')
export class JobDescriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  @Column({ type: 'text', name: 'raw_text' })
  rawText!: string;

  @Column({ type: 'jsonb', name: 'parsed_json', nullable: true })
  parsedJson!: unknown | null;

  @Index()
  @Column({ type: 'varchar', name: 'source_type', nullable: true })
  sourceType!: JobDescriptionSourceType | null;

  @Index()
  @Column('uuid', { name: 'document_id', nullable: true })
  documentId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
