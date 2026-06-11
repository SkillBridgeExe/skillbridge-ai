import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingPlanEntity } from '../../database/entities/billing-plan.entity';
import { MentorBookingEntity } from '../../database/entities/mentor-booking.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { PaymentWebhookEventEntity } from '../../database/entities/payment-webhook-event.entity';
import { PlanFeatureEntity } from '../../database/entities/plan-feature.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminBillingController } from './admin-billing.controller';
import { AdminBillingService } from './admin-billing.service';
import { BillingController, MeEntitlementsController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { PAYMENT_PROVIDER_PORTS } from './payment-providers/payment-provider.port';
import { PaymentProviderRegistry } from './payment-providers/payment-provider.registry';
import { PayosPaymentProvider } from './payment-providers/payos-payment.provider';
import { BillingCheckoutService } from './services/billing-checkout.service';
import { BillingSettlementService } from './services/billing-settlement.service';
import { PaymentWebhookService } from './services/payment-webhook.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BillingPlanEntity,
      PlanFeatureEntity,
      UserSubscriptionEntity,
      PaymentOrderEntity,
      PaymentWebhookEventEntity,
      UsageEventEntity,
      MentorBookingEntity,
      UserEntity,
    ]),
  ],
  controllers: [BillingController, AdminBillingController, MeEntitlementsController],
  providers: [
    BillingService,
    AdminBillingService,
    BillingCheckoutService,
    BillingSettlementService,
    PaymentWebhookService,
    PayosPaymentProvider,
    {
      provide: PAYMENT_PROVIDER_PORTS,
      useFactory: (payos: PayosPaymentProvider) => [payos],
      inject: [PayosPaymentProvider],
    },
    PaymentProviderRegistry,
    EntitlementsService,
    RolesGuard,
  ],
  exports: [EntitlementsService],
})
export class BillingModule {}
