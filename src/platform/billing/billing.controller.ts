import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/billing.dto';

@ApiTags('Billing')
@Public()
@Controller('api/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List active billing plans and feature limits' })
  plans() {
    return this.billing.listPlans();
  }

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Create a payOS checkout link' })
  checkout(@CurrentUser() user: JwtUser, @Body() dto: CreateCheckoutDto) {
    return this.billing.createCheckout(user.userId, dto);
  }

  @Post('payos/webhook')
  @ApiOperation({ summary: 'Receive and verify payOS payment webhook' })
  payosWebhook(@Body() body: unknown) {
    return this.billing.handlePayosWebhook(body);
  }

  @Post('payments/:provider/webhook')
  @ApiOperation({ summary: 'Receive and verify a payment provider webhook' })
  @ApiParam({ name: 'provider', description: 'Payment provider code, e.g. PAYOS' })
  providerWebhook(@Param('provider') provider: string, @Body() body: unknown) {
    return this.billing.handlePaymentProviderWebhook(provider, body);
  }

  @Get('orders/:orderCode')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get current payment order status' })
  @ApiParam({ name: 'orderCode', description: 'payOS orderCode' })
  order(@CurrentUser() user: JwtUser, @Param('orderCode') orderCode: string) {
    return this.billing.getOrder(user.userId, Number(orderCode));
  }

  @Get('me/subscription')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get current user subscription and entitlements' })
  subscription(@CurrentUser() user: JwtUser) {
    return this.billing.getSubscription(user.userId);
  }

  @Get('me/usage')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get current user feature usage for the active period' })
  usage(@CurrentUser() user: JwtUser) {
    return this.billing.getUsage(user.userId);
  }
}
