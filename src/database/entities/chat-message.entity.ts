import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ChatConversationEntity } from './chat-conversation.entity';

export type ChatMessageRole = 'user' | 'assistant';

@Entity('chat_messages')
@Index(['conversationId', 'createdAt'])
export class ChatMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'conversation_id' })
  conversationId!: string;

  @ManyToOne(() => ChatConversationEntity, (conversation) => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation!: ChatConversationEntity;

  @Column({ type: 'varchar' })
  role!: ChatMessageRole;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'jsonb', name: 'metadata', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
