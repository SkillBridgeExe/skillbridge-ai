import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminBillingService } from './admin-billing.service';
import {
  AdminListMentorBookingsQueryDto,
  AdminListOrdersQueryDto,
  AdminListPlansQueryDto,
  AdminListSubscriptionsQueryDto,
  CreateAdminBillingPlanDto,
  ReplaceAdminPlanFeaturesDto,
  UpdateAdminBillingPlanDto,
  UpdateAdminMentorBookingRefundDto,
} from './dto/admin-billing.dto';

@ApiTags('Admin Billing')
@ApiBearerAuth()
@Controller('api/admin/billing')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Admin list billing plans, optionally including inactive plans' })
  listPlans(@Query() query: AdminListPlansQueryDto) {
    return this.billing.listPlans(query);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Admin create a billing plan or mentor package' })
  createPlan(@Body() dto: CreateAdminBillingPlanDto) {
    return this.billing.createPlan(dto);
  }

  @Patch('plans/:code')
  @ApiOperation({ summary: 'Admin update mutable billing plan fields' })
  updatePlan(@Param('code') code: string, @Body() dto: UpdateAdminBillingPlanDto) {
    return this.billing.updatePlan(code, dto);
  }

  @Put('plans/:code/features')
  @ApiOperation({ summary: 'Admin replace feature limits for a billing plan' })
  replacePlanFeatures(@Param('code') code: string, @Body() dto: ReplaceAdminPlanFeaturesDto) {
    return this.billing.replacePlanFeatures(code, dto);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Admin list payment orders' })
  listOrders(@Query() query: AdminListOrdersQueryDto) {
    return this.billing.listOrders(query);
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Admin list user subscriptions' })
  listSubscriptions(@Query() query: AdminListSubscriptionsQueryDto) {
    return this.billing.listSubscriptions(query);
  }

  @Get('mentor-bookings')
  @ApiOperation({ summary: 'Admin list mentor bookings' })
  listMentorBookings(@Query() query: AdminListMentorBookingsQueryDto) {
    return this.billing.listMentorBookings(query);
  }

  @Patch('mentor-bookings/:bookingId/refund')
  @ApiOperation({ summary: 'Record a manual mentor-booking refund outcome' })
  updateMentorBookingRefund(
    @Param('bookingId') bookingId: string,
    @Body() dto: UpdateAdminMentorBookingRefundDto,
  ) {
    return this.billing.updateMentorBookingRefund(bookingId, dto);
  }
}
