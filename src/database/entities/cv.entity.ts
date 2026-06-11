import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';

export type CvKind = 'UPLOADED' | 'BUILT';

/**
 * Maps the `cvs` table (see skillbridge-fe-official/docs/database/skillbridge-mvp.dbml)
 * + the R1 additions: parsed_json (CanonicalCvDocument), cv_kind, language, is_ocr_only.
 *
 * Sample/reference entity to establish the TypeORM mapping pattern. Remaining 37
 * tables follow the same shape (snake_case columns via `name:`, timestamptz dates,
 * numeric(5,2) scores). See ARCHITECTURE.md §4.
 */
@Entity('cvs')
export class CvEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  @Column({ type: 'varchar', name: 'original_file_name', nullable: true })
  originalFileName!: string | null;

  @Column({ type: 'varchar', name: 'file_type', nullable: true })
  fileType!: string | null;

  @Column({ type: 'int', name: 'file_size', nullable: true })
  fileSize!: number | null;

  @Index()
  @Column({ type: 'varchar', name: 'content_hash', length: 64, nullable: true })
  contentHash!: string | null;

  @Column({ type: 'text', name: 'file_url', nullable: true })
  fileUrl!: string | null;

  @Column({ type: 'text', name: 'parsed_text', nullable: true })
  parsedText!: string | null;

  /** R1: structured CanonicalCvDocument (Stage 1 parse output). */
  @Column({ type: 'jsonb', name: 'parsed_json', nullable: true })
  parsedJson!: CanonicalCvDocument | null;

  /** R1/R1b: 'UPLOADED' (user CV) | 'BUILT' (builder draft/export source). */
  @Column({ type: 'varchar', name: 'cv_kind', default: 'UPLOADED' })
  cvKind!: CvKind;

  /** R1: detected language (VN/EN focus). */
  @Column({ type: 'varchar', nullable: true })
  language!: string | null;

  /** R1 completion: target role used for role-specific CV diagnosis scoring. */
  @Index()
  @Column({ type: 'varchar', name: 'target_role', nullable: true })
  targetRole!: string | null;

  @Column({ type: 'boolean', name: 'is_ocr_only', default: false })
  isOcrOnly!: boolean;

  @Index()
  @Column('uuid', { name: 'document_id', nullable: true })
  documentId!: string | null;

  /** ATS-friendliness 0-100 (numeric → string in TypeORM to avoid float loss). */
  @Column({
    type: 'numeric',
    name: 'ats_readability_score',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  atsReadabilityScore!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;
}
