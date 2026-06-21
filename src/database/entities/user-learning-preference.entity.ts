import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

export type LearningLanguagePref = 'vi' | 'en' | 'both';

@Entity('learning_preferences')
@Check(`"language_pref" IN ('vi', 'en', 'both')`)
export class UserLearningPreferenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ type: 'varchar', name: 'language_pref', default: 'both' })
  languagePref!: LearningLanguagePref;

  @Column({ type: 'int', name: 'available_days', default: 30 })
  availableDays!: number;

  @Column({ type: 'int', name: 'hours_per_week', default: 8 })
  hoursPerWeek!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
