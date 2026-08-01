import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CancelMentorBookingDto,
  CreateMentorBookingDto,
  CreateMentorReviewDto,
  UpdateMeetingUrlDto,
} from './dto/mentor-booking.dto';
import { MentorBookingsService } from './mentor-bookings.service';
import { CheckoutOriginService } from '../billing/services/checkout-origin.service';

@ApiTags('Mentor Bookings')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/mentor-bookings')
export class MentorBookingsController {
  constructor(
    private readonly bookings: MentorBookingsService,
    private readonly checkoutOrigins: CheckoutOriginService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Hold a mentor slot and create the full mentor booking checkout' })
  create(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateMentorBookingDto,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    const checkoutOrigin = this.checkoutOrigins.resolve(origin, referer);
    return this.bookings.createBooking(user.userId, dto, checkoutOrigin);
  }

  @Get('me')
  @ApiOperation({ summary: 'List current user mentor bookings' })
  list(@CurrentUser() user: JwtUser) {
    return this.bookings.listStudentBookings(user.userId);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: 'Get an owned mentor booking' })
  detail(@CurrentUser() user: JwtUser, @Param('bookingId') bookingId: string) {
    return this.bookings.getStudentBooking(user.userId, bookingId);
  }

  @Post(':bookingId/pay')
  @ApiOperation({ summary: 'Create or resume the mentor booking payment checkout' })
  pay(
    @CurrentUser() user: JwtUser,
    @Param('bookingId') bookingId: string,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    const checkoutOrigin = this.checkoutOrigins.resolve(origin, referer);
    return this.bookings.pay(user.userId, bookingId, checkoutOrigin);
  }

  @Post(':bookingId/cancel')
  @ApiOperation({ summary: 'Cancel an owned mentor booking' })
  cancel(
    @CurrentUser() user: JwtUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: CancelMentorBookingDto,
  ) {
    return this.bookings.cancelByStudent(user.userId, bookingId, dto);
  }

  @Post(':bookingId/review')
  @ApiOperation({ summary: 'Review a completed mentor booking once' })
  review(
    @CurrentUser() user: JwtUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: CreateMentorReviewDto,
  ) {
    return this.bookings.createReview(user.userId, bookingId, dto);
  }
}

@ApiTags('Mentor Bookings')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('MENTOR')
@Controller('api/mentors/me/bookings')
export class MentorOwnedBookingsController {
  constructor(private readonly bookings: MentorBookingsService) {}

  @Get()
  @ApiOperation({ summary: 'List bookings assigned to the current mentor' })
  list(@CurrentUser() user: JwtUser) {
    return this.bookings.listMentorBookings(user.userId);
  }

  @Patch(':bookingId/meeting-link')
  @ApiOperation({ summary: 'Set the meeting URL for a confirmed booking' })
  meetingLink(
    @CurrentUser() user: JwtUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: UpdateMeetingUrlDto,
  ) {
    return this.bookings.updateMeetingUrl(user.userId, bookingId, dto);
  }

  @Post(':bookingId/complete')
  @ApiOperation({ summary: 'Mark a confirmed booking completed after its end time' })
  complete(@CurrentUser() user: JwtUser, @Param('bookingId') bookingId: string) {
    return this.bookings.completeBooking(user.userId, bookingId);
  }

  @Post(':bookingId/cancel')
  @ApiOperation({ summary: 'Cancel a booking assigned to the current mentor' })
  cancel(
    @CurrentUser() user: JwtUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: CancelMentorBookingDto,
  ) {
    return this.bookings.cancelByMentor(user.userId, bookingId, dto);
  }
}
