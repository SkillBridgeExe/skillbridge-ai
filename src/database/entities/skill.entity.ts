import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('skills')
export class SkillEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'canonical_name' })
  canonicalName!: string;

  @Column({ type: 'varchar', name: 'display_name' })
  displayName!: string;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  category!: string | null;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  source!: string | null;

  @Column({ type: 'varchar', name: 'source_external_id', nullable: true })
  sourceExternalId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  aliases!: string[] | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
