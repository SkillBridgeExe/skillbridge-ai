import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorAvailabilityTemplateEntity } from '../../database/entities/mentor-availability-template.entity';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { MentorReviewEntity } from '../../database/entities/mentor-review.entity';
import { MentorProfileSkillEntity } from '../../database/entities/mentor-profile-skill.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { BillingModule } from '../billing/billing.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  AdminMentorsController,
  MentorAvailabilityController,
  MentorAvailabilityTemplateController,
  MentorSelfProfileController,
  MentorsController,
} from './mentors.controller';
import { MentorsService } from './mentors.service';
import { MentorAvailabilityService } from './mentor-availability.service';
import {
  MentorBookingsController,
  MentorOwnedBookingsController,
} from './mentor-bookings.controller';
import { MentorBookingsService } from './mentor-bookings.service';

@Module({
  imports: [
    StorageModule,
    BillingModule,
    TypeOrmModule.forFeature([
      MentorProfileEntity,
      MentorAvailabilityTemplateEntity,
      MentorAvailabilitySlotEntity,
      MentorBookingEntity,
      MentorReviewEntity,
      MentorProfileSkillEntity,
      PaymentOrderEntity,
      UserEntity,
      SkillEntity,
    ]),
  ],
  controllers: [
    MentorsController,
    MentorSelfProfileController,
    MentorAvailabilityController,
    MentorAvailabilityTemplateController,
    MentorBookingsController,
    MentorOwnedBookingsController,
    AdminMentorsController,
  ],
  providers: [MentorsService, MentorAvailabilityService, MentorBookingsService, RolesGuard],
  exports: [MentorsService],
})
export class MentorsModule {}
