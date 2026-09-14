import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigArg } from '@vendure/common/lib/generated-types';
import {
    Customer,
    Injector,
    Logger,
    Order,
    Payment,
    PaymentMethodService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import Stripe from 'stripe';

import { loggerCtx, STRIPE_PLUGIN_OPTIONS } from './constants';
import { sanitizeMetadata } from './metadata-sanitize';
import { VendureStripeClient } from './stripe-client';
import { getAmountInStripeMinorUnits } from './stripe-utils';
import { stripePaymentMethodHandler } from './stripe.handler';
import { StripePluginOptions } from './types';

@Injectable()
export class StripeService {
    constructor(
        @Inject(STRIPE_PLUGIN_OPTIONS) private options: StripePluginOptions,
        private connection: TransactionalConnection,
        private paymentMethodService: PaymentMethodService,
        private moduleRef: ModuleRef,
    ) {}

    async createPaymentIntent(ctx: RequestContext, order: Order): Promise<string> {
        let customerId: string | undefined;
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);

        if (this.options.storeCustomersInStripe && ctx.activeUserId) {
            customerId = await this.getStripeCustomerId(ctx, order, requestOptions);
        }
        const amountInMinorUnits = getAmountInStripeMinorUnits(order);

        const additionalParams = await this.options.paymentIntentCreateParams?.(
            new Injector(this.moduleRef),
            ctx,
            order,
        );
        const metadata = sanitizeMetadata({
            ...(typeof this.options.metadata === 'function'
                ? await this.options.metadata(new Injector(this.moduleRef), ctx, order)
                : {}),
            channelToken: ctx.channel.token,
            orderId: order.id,
            orderCode: order.code,
            languageCode: ctx.languageCode,
        });

        const allMetadata = {
            ...metadata,
            ...sanitizeMetadata(additionalParams?.metadata ?? {}),
        };

        const createParams: Stripe.PaymentIntentCreateParams = {
            amount: amountInMinorUnits,
            currency: order.currencyCode.toLowerCase(),
            customer: customerId,
            automatic_payment_methods: {
                enabled: true,
            },
            // Manual capture places a hold on the funds (status `requires_capture`) rather than
            // charging immediately, so Vendure can secure stock before the money is captured.
            ...(this.isManualCapture() ? { capture_method: 'manual' as const } : {}),
            ...(additionalParams ?? {}),
            metadata: allMetadata,
        };
        const idempotencyKey = `${order.code}_${amountInMinorUnits}`;

        const paymentIntent = await stripe.paymentIntents.create(createParams, {
            idempotencyKey,
            ...(requestOptions ?? {}),
        });

        // In manual-capture mode an intent can be cancelled server-side (for example when a stock
        // check fails after authorization). Because the idempotency key above replays the original
        // response, a same-amount retry would hand back the cancelled intent's client secret, which
        // can no longer be confirmed. Retrieve the live intent and, if it is no longer confirmable,
        // mint a fresh one so a retry always gets a usable intent.
        const usableIntent = this.isManualCapture()
            ? await this.ensureConfirmableIntent(stripe, paymentIntent, createParams, idempotencyKey, requestOptions)
            : paymentIntent;

        if (!usableIntent.client_secret) {
            // This should never happen
            Logger.warn(
                `Payment intent creation for order ${order.code} did not return client secret`,
                loggerCtx,
            );
            throw Error('Failed to create payment intent');
        }

        return usableIntent.client_secret;
    }

    /**
     * Whether the plugin is configured to authorize first and capture separately
     * (`captureMethod: 'manual'`).
     */
    isManualCapture(): boolean {
        return this.options.captureMethod === 'manual';
    }

    /**
     * Captures a previously authorized PaymentIntent, charging the held funds. Used by the payment
     * handler's `settlePayment` in manual-capture mode.
     */
    async capturePaymentIntent(
        ctx: RequestContext,
        order: Order,
        paymentIntentId: string,
    ): Promise<Stripe.PaymentIntent> {
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);
        return stripe.paymentIntents.capture(paymentIntentId, undefined, requestOptions);
    }

    /**
     * Voids (cancels) a PaymentIntent, releasing any authorized hold without charging the customer.
     * Used to release the hold when an order cannot be arranged after authorization, and by the
     * handler's `cancelPayment`.
     */
    async cancelPaymentIntent(
        ctx: RequestContext,
        order: Order,
        paymentIntentId: string,
    ): Promise<Stripe.PaymentIntent> {
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);
        return stripe.paymentIntents.cancel(paymentIntentId, undefined, requestOptions);
    }

    /**
     * Returns the created intent if it can still be confirmed; otherwise creates and returns a fresh
     * one. Used only in manual-capture mode, where the idempotency key can replay a cancelled intent
     * whose client secret is no longer usable.
     */
    private async ensureConfirmableIntent(
        stripe: VendureStripeClient,
        createdIntent: Stripe.PaymentIntent,
        createParams: Stripe.PaymentIntentCreateParams,
        idempotencyKey: string,
        requestOptions: Stripe.RequestOptions | undefined,
    ): Promise<Stripe.PaymentIntent> {
        let live: Stripe.PaymentIntent;
        try {
            live = await stripe.paymentIntents.retrieve(createdIntent.id, undefined, requestOptions);
        } catch {
            // If the live status cannot be read, fall back to the created intent.
            return createdIntent;
        }
        if (live.client_secret && this.isConfirmableStatus(live.status)) {
            return live;
        }
        // The replayed intent is no longer confirmable (e.g. cancelled). Mint a fresh one with a
        // unique idempotency key so it is not itself a replay of the dead intent.
        return stripe.paymentIntents.create(createParams, {
            ...(requestOptions ?? {}),
            idempotencyKey: `${idempotencyKey}_${Date.now()}`,
        });
    }

    private isConfirmableStatus(status: Stripe.PaymentIntent.Status): boolean {
        return (
            status === 'requires_payment_method' ||
            status === 'requires_confirmation' ||
            status === 'requires_action'
        );
    }

    async constructEventFromPayload(
        ctx: RequestContext,
        order: Order,
        payload: Buffer,
        signature: string,
    ): Promise<Stripe.Event> {
        const stripe = await this.getStripeClient(ctx, order);
        return stripe.webhooks.constructEvent(payload, signature, stripe.webhookSecret);
    }

    async createRefund(
        ctx: RequestContext,
        order: Order,
        payment: Payment,
        amount: number,
    ): Promise<Stripe.Response<Stripe.Refund>> {
        const stripe = await this.getStripeClient(ctx, order);
        return stripe.refunds.create({
            payment_intent: payment.transactionId,
            amount,
        });
    }

    /**
     * Get Stripe client based on eligible payment methods for order
     */
    async getStripeClient(ctx: RequestContext, order: Order): Promise<VendureStripeClient> {
        const [eligiblePaymentMethods, paymentMethods] = await Promise.all([
            this.paymentMethodService.getEligiblePaymentMethods(ctx, order),
            this.paymentMethodService.findAll(ctx, {
                filter: {
                    enabled: { eq: true },
                },
            }),
        ]);
        const stripePaymentMethod = paymentMethods.items.find(
            pm => pm.handler.code === stripePaymentMethodHandler.code,
        );
        if (!stripePaymentMethod) {
            throw new UserInputError('No enabled Stripe payment method found');
        }
        const isEligible = eligiblePaymentMethods.some(pm => pm.code === stripePaymentMethod.code);
        if (!isEligible) {
            throw new UserInputError(`Stripe payment method is not eligible for order ${order.code}`);
        }
        const apiKey = this.findOrThrowArgValue(stripePaymentMethod.handler.args, 'apiKey');
        const webhookSecret = this.findOrThrowArgValue(stripePaymentMethod.handler.args, 'webhookSecret');
        return new VendureStripeClient(apiKey, webhookSecret);
    }

    private findOrThrowArgValue(args: ConfigArg[], name: string): string {
        const value = args.find(arg => arg.name === name)?.value;
        if (!value) {
            throw Error(`No argument named '${name}' found!`);
        }
        return value;
    }

    /**
     * Resolves the optional per-request options (e.g. a `stripeAccount` targeting a
     * connected account). Returns `undefined` when no callback is configured or it
     * yields an empty object, because the Stripe SDK rejects an empty options hash.
     */
    private async resolveRequestOptions(
        ctx: RequestContext,
        order: Order,
    ): Promise<Stripe.RequestOptions | undefined> {
        const additionalOptions = await this.options.requestOptions?.(
            new Injector(this.moduleRef),
            ctx,
            order,
        );
        return additionalOptions && Object.keys(additionalOptions).length > 0
            ? additionalOptions
            : undefined;
    }

    /**
     * Returns the stripeCustomerId if the Customer has one. If that's not the case, queries Stripe to check
     * if the customer is already registered, in which case it saves the id as stripeCustomerId and returns it.
     * Otherwise, creates a new Customer record in Stripe and returns the generated id.
     */
    private async getStripeCustomerId(
        ctx: RequestContext,
        activeOrder: Order,
        requestOptions?: Stripe.RequestOptions,
    ): Promise<string | undefined> {
        const [stripe, order] = await Promise.all([
            this.getStripeClient(ctx, activeOrder),
            // Load relation with customer not available in the response from activeOrderService.getOrderFromContext()
            this.connection.getRepository(ctx, Order).findOne({
                where: { id: activeOrder.id },
                relations: ['customer'],
            }),
        ]);

        if (!order || !order.customer) {
            // This should never happen
            return undefined;
        }

        const { customer } = order;

        if (customer.customFields.stripeCustomerId) {
            return customer.customFields.stripeCustomerId;
        }

        let stripeCustomerId;

        // The customer lookup and creation must hit the same Stripe account as the
        // PaymentIntent. When `requestOptions` carries a `stripeAccount`, omitting it
        // here would create the customer on the platform account while the intent
        // targets the connected account, surfacing as "No such customer".
        const stripeCustomers = await stripe.customers.list(
            { email: customer.emailAddress },
            requestOptions,
        );
        if (stripeCustomers.data.length > 0) {
            stripeCustomerId = stripeCustomers.data[0].id;
        } else {
            const additionalParams = await this.options.customerCreateParams?.(
                new Injector(this.moduleRef),
                ctx,
                order,
            );
            const newStripeCustomer = await stripe.customers.create(
                {
                    email: customer.emailAddress,
                    name: `${customer.firstName} ${customer.lastName}`,
                    ...(additionalParams ?? {}),
                    ...(additionalParams?.metadata
                        ? { metadata: sanitizeMetadata(additionalParams.metadata) }
                        : {}),
                },
                requestOptions,
            );

            stripeCustomerId = newStripeCustomer.id;

            Logger.info(`Created Stripe Customer record for customerId ${customer.id}`, loggerCtx);
        }

        customer.customFields.stripeCustomerId = stripeCustomerId;
        await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

        return stripeCustomerId;
    }
}
