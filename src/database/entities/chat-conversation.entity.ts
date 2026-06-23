import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatMessageEntity } from './chat-message.entity';

@Entity('chat_conversations')
@Index(['userId', 'createdAt'])
export class ChatConversationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'match_id', nullable: true })
  matchId!: string | null;

  /**
   * CV-only advisor subject (no JD match). A CV-only diagnosis chat is keyed by (user_id, cv_id) with
   * match_id NULL; a JD chat for the SAME cv is still keyed by its match_id, so the two never collide.
   */
  @Column({ type: 'uuid', name: 'cv_id', nullable: true })
  cvId!: string | null;

  @Column({ type: 'varchar', name: 'title', nullable: true })
  title!: string | null;

  @OneToMany(() => ChatMessageEntity, (message) => message.conversation)
  messages!: ChatMessageEntity[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
