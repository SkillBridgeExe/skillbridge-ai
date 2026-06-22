import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type CompanyType = 'PRODUCT' | 'OUTSOURCING' | 'CONSULTING' | 'STARTUP' | 'OTHER';
export type CompanySize =
  | '1_10'
  | '11_50'
  | '51_100'
  | '101_300'
  | '301_500'
  | '501_1000'
  | '1000_PLUS';

@Entity('companies')
export class CompanyEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', length: 255 }) name!: string;
  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'name_normalized', length: 255 })
  nameNormalized!: string;
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320, default: () => 'gen_random_uuid()::text' })
  slug!: string;
  @Column('uuid', { name: 'canonical_company_id', nullable: true }) canonicalCompanyId!:
    | string
    | null;
  @Column({ type: 'varchar', length: 512, nullable: true }) website!: string | null;
  @Column({ type: 'text', name: 'logo_object_key', nullable: true }) logoObjectKey!: string | null;
  @Column({ type: 'text', name: 'cover_object_key', nullable: true }) coverObjectKey!:
    | string
    | null;
  @Column({ type: 'text', name: 'linkedin_url', nullable: true }) linkedinUrl!: string | null;
  @Column({ type: 'varchar', name: 'industry_code', length: 64, nullable: true }) industryCode!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'company_type', length: 32, nullable: true })
  companyType!: CompanyType | null;
  @Column({ type: 'varchar', name: 'company_size', length: 32, nullable: true })
  companySize!: CompanySize | null;
  @Column({ type: 'smallint', name: 'founded_year', nullable: true }) foundedYear!: number | null;
  @Column({ type: 'varchar', name: 'country_code', length: 2, default: 'VN' }) countryCode!: string;
  @Column({ type: 'varchar', name: 'headquarters_city_code', length: 64, nullable: true })
  headquartersCityCode!: string | null;
  @Column({ type: 'text', name: 'headquarters_address', nullable: true }) headquartersAddress!:
    | string
    | null;
  @Column({ type: 'varchar', name: 'short_description', length: 500, nullable: true })
  shortDescription!: string | null;
  @Column({ type: 'text', nullable: true }) description!: string | null;
  @Column({ type: 'text', name: 'culture_description', nullable: true }) cultureDescription!:
    | string
    | null;
  @Column('text', { array: true, default: () => "'{}'" }) benefits!: string[];
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt!: Date | null;
}
