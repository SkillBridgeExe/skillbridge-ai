import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminBillingService } from './admin-billing.service';
import { AdminVoucherService } from './admin-voucher.service';
import {
  AdminListMentorBookingsQueryDto,
  AdminListOrdersQueryDto,
  AdminListPlansQueryDto,
  AdminListSubscriptionsQueryDto,
  CreateAdminBillingPlanDto,
  ReplaceAdminPlanFeaturesDto,
  UpdateAdminBillingPlanDto,
  UpdateAdminMentorBookingRefundDto,
  UpdateAdminPlanFeatureDto,
  AdminListVouchersQueryDto,
  CreateAdminVoucherDto,
  UpdateAdminVoucherDto,
  AdminFeatureUsageQueryDto,
} from './dto/admin-billing.dto';

@ApiTags('Admin Billing')
@ApiBearerAuth()
@Controller('api/admin/billing')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AdminBillingController {
  constructor(
    private readonly billing: AdminBillingService,
    private readonly vouchers: AdminVoucherService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'Admin list billing plans, optionally including inactive plans' })
  listPlans(@Query() query: AdminListPlansQueryDto) {
    return this.billing.listPlans(query);
  }

  @Get('features')
  @ApiOperation({ summary: 'Admin list supported billing feature keys and recommended limits' })
  listFeatures() {
    return this.billing.listFeatureCatalog();
  }

  @Get('feature-usage')
  @ApiOperation({ summary: 'Admin count of unique users per billing feature' })
  listFeatureUsage(@Query() query: AdminFeatureUsageQueryDto) {
    return this.billing.listFeatureUsage(query);
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

  @Patch('plans/:code/features/:featureKey')
  @ApiOperation({ summary: 'Admin upsert one feature limit for a billing plan' })
  updatePlanFeature(
    @Param('code') code: string,
    @Param('featureKey') featureKey: string,
    @Body() dto: UpdateAdminPlanFeatureDto,
  ) {
    return this.billing.updatePlanFeature(code, featureKey, dto);
  }

  @Get('vouchers')
  @ApiOperation({ summary: 'Admin list vouchers and usage counters' })
  listVouchers(@Query() query: AdminListVouchersQueryDto) {
    return this.vouchers.list(query);
  }

  @Post('vouchers')
  @ApiOperation({ summary: 'Admin create a Premium discount or credit voucher' })
  createVoucher(@Body() dto: CreateAdminVoucherDto) {
    return this.vouchers.create(dto);
  }

  @Patch('vouchers/:id')
  @ApiOperation({ summary: 'Admin update or toggle a voucher' })
  updateVoucher(@Param('id') id: string, @Body() dto: UpdateAdminVoucherDto) {
    return this.vouchers.update(id, dto);
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
