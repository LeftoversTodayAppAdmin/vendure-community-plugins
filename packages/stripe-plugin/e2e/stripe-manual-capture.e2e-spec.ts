/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { CurrencyCode, GlobalFlag, LanguageCode } from '@vendure/common/lib/generated-types';
import { mergeConfig } from '@vendure/core';
import {
    createErrorResultGuard,
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    ErrorResultGuard,
} from '@vendure/testing';
import nock from 'nock';
import fetch from 'node-fetch';
import path from 'path';
import { Stripe } from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { StripePlugin } from '../src';
import { stripePaymentMethodHandler } from '../src/stripe.handler';

import {
    createPaymentMethodDocument,
    getCustomerListDocument,
    getOrderPaymentsDocument,
    updateProductVariantsDocument,
} from './graphql/admin-definitions';
import { ResultOf } from './graphql/graphql-admin';
import { FragmentOf } from './graphql/graphql-shop';
import { createStripePaymentIntentDocument } from './graphql/shared-definitions';
import { addItemToOrderDocument, getActiveOrderDocument, testOrderFragment } from './graphql/shop-definitions';
import { setShipping } from './payment-helpers';

const STRIPE_BASE_URL = 'https://api.stripe.com/';

/**
 * Builds and signs a Stripe webhook event so it passes signature validation in the controller.
 */
function signedWebhook(payload: object): { body: string; header: string } {
    const body = JSON.stringify(payload, null, 2);
    const header = new Stripe('test-api-key', { apiVersion: '2023-08-16' }).webhooks.generateTestHeaderString({
        payload: body,
        secret: 'test-signing-secret',
    });
    return { body, header };
}

async function postWebhook(serverPort: number, payload: object): Promise<number> {
    const { body, header } = signedWebhook(payload);
    const result = await fetch(`http://localhost:${serverPort}/payments/stripe`, {
        method: 'post',
        body,
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    });
    return result.status;
}

function amountCapturableUpdatedEvent(order: FragmentOf<typeof testOrderFragment>, paymentIntentId: string) {
    return {
        id: `evt_${paymentIntentId}`,
        object: 'event',
        api_version: '2022-11-15',
        data: {
            object: {
                id: paymentIntentId,
                currency: 'usd',
                metadata: {
                    orderCode: order.code,
                    orderId: parseInt(order.id.replace('T_', ''), 10),
                    channelToken: E2E_DEFAULT_CHANNEL_TOKEN,
                },
                amount: order.totalWithTax,
                amount_capturable: order.totalWithTax,
                amount_received: 0,
                status: 'requires_capture',
            },
        },
        livemode: false,
        pending_webhooks: 1,
        request: { id: 'req_0', idempotency_key: null },
        type: 'payment_intent.amount_capturable_updated',
    };
}

describe('Stripe manual capture', () => {
    const devConfig = mergeConfig(testConfig(), {
        plugins: [
            StripePlugin.init({
                captureMethod: 'manual',
                // Return a conflicting capture_method from the create-params callback to prove the
                // plugin's captureMethod option is authoritative: every intent in this suite must
                // still be created with `capture_method: 'manual'` regardless of this value.
                paymentIntentCreateParams: () => ({ capture_method: 'automatic' }),
            }),
        ],
    });
    const { shopClient, adminClient, server } = createTestEnvironment(devConfig);
    let serverPort: number;
    let customers: ResultOf<typeof getCustomerListDocument>['customers']['items'];

    const orderGuard: ErrorResultGuard<FragmentOf<typeof testOrderFragment>> = createErrorResultGuard(
        input => !!input.lines,
    );

    async function adminOrder(orderId: string) {
        const { order } = await adminClient.query(getOrderPaymentsDocument, { id: orderId });
        return order!;
    }

    beforeAll(async () => {
        serverPort = devConfig.apiOptions.port;
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 2,
        });
        await adminClient.asSuperAdmin();
        ({
            customers: { items: customers },
        } = await adminClient.query(getCustomerListDocument, { options: { take: 2 } }));
        await adminClient.query(createPaymentMethodDocument, {
            input: {
                code: `stripe-payment-${E2E_DEFAULT_CHANNEL_TOKEN}`,
                translations: [
                    {
                        name: 'Stripe manual capture test',
                        description: 'Stripe test payment method (manual capture)',
                        languageCode: LanguageCode.en,
                    },
                ],
                enabled: true,
                handler: {
                    code: stripePaymentMethodHandler.code,
                    arguments: [
                        { name: 'apiKey', value: 'test-api-key' },
                        { name: 'webhookSecret', value: 'test-signing-secret' },
                    ],
                },
            },
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        nock.cleanAll();
        await server.destroy();
    });

    describe('creating the PaymentIntent', () => {
        beforeAll(async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            await setShipping(shopClient);
        });

        it('creates the intent with capture_method manual (config overrides paymentIntentCreateParams)', async () => {
            let createBody: any;
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents', body => {
                    createBody = body;
                    return true;
                })
                .reply(200, { id: 'pi_manual', client_secret: 'pi_manual_secret', status: 'requires_payment_method' });
            // Reconcile-on-create retrieves the live intent to confirm it is still usable.
            nock(STRIPE_BASE_URL)
                .get('/v1/payment_intents/pi_manual')
                .reply(200, { id: 'pi_manual', client_secret: 'pi_manual_secret', status: 'requires_payment_method' });

            const { createStripePaymentIntent } = await shopClient.query(createStripePaymentIntentDocument);
            expect(createStripePaymentIntent).toEqual('pi_manual_secret');
            expect(createBody.capture_method).toEqual('manual');
        });

        it('mints a fresh intent when the replayed one was cancelled', async () => {
            // The idempotency key replays a previously cancelled intent...
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents')
                .reply(200, { id: 'pi_dead', client_secret: 'pi_dead_secret', status: 'requires_payment_method' });
            // ...whose live status is now `canceled`, so its secret is unusable...
            nock(STRIPE_BASE_URL)
                .get('/v1/payment_intents/pi_dead')
                .reply(200, { id: 'pi_dead', client_secret: 'pi_dead_secret', status: 'canceled' });
            // ...so the plugin mints a fresh intent with a unique idempotency key.
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents')
                .reply(200, { id: 'pi_fresh', client_secret: 'pi_fresh_secret', status: 'requires_payment_method' });

            const { createStripePaymentIntent } = await shopClient.query(createStripePaymentIntentDocument);
            expect(createStripePaymentIntent).toEqual('pi_fresh_secret');
        });
    });

    describe('authorization webhook', () => {
        it('captures the funds when the order is still saleable', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const order = addItemToOrder;
            await setShipping(shopClient);

            const captureScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_capture_ok/capture')
                .reply(200, { id: 'pi_capture_ok', status: 'succeeded', amount_received: order.totalWithTax });

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_capture_ok'));
            expect(status).toEqual(200);
            // The plugin captured the authorized funds, so the order is settled.
            expect(captureScope.isDone()).toBe(true);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            const payment = settled.payments?.find(p => p.transactionId === 'pi_capture_ok');
            expect(payment?.state).toEqual('Settled');
        });

        it('voids the authorization when the item is no longer saleable', async () => {
            await shopClient.asUserWithCredentials(customers[1].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_2',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const order = addItemToOrder;
            await setShipping(shopClient);

            // Make T_2 unsaleable (tracked, zero on hand, no backorder threshold) to simulate the
            // item selling out during checkout.
            await adminClient.query(updateProductVariantsDocument, {
                input: [
                    {
                        id: 'T_2',
                        trackInventory: GlobalFlag.TRUE,
                        stockOnHand: 0,
                        useGlobalOutOfStockThreshold: false,
                        outOfStockThreshold: 0,
                    },
                ],
            });

            const cancelScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_void/cancel')
                .reply(200, { id: 'pi_void', status: 'canceled' });
            // Note: no capture is mocked. If the plugin tried to capture, nock would throw on the
            // unmocked request and fail this test.

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_void'));
            expect(status).toEqual(200);
            // The hold was released and nothing was captured or settled.
            expect(cancelScope.isDone()).toBe(true);
            const voided = await adminOrder(order.id);
            expect(voided.state).not.toEqual('PaymentSettled');
            expect(voided.payments?.some(p => p.state === 'Settled')).not.toBe(true);
        });
    });

    describe('webhook resilience', () => {
        it('returns 5xx on an unexpected error so Stripe redelivers the event', async () => {
            // An order that cannot be found is an unexpected/transient condition (for example
            // replication lag), so the handler must not swallow it with a 200. A 5xx lets Stripe
            // retry, and the idempotency guard makes the eventual redelivery safe.
            const status = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(
                    { code: 'NON_EXISTENT_ORDER', id: 'T_999999', totalWithTax: 1000 } as any,
                    'pi_unknown_order',
                ),
            );
            expect(status).toBeGreaterThanOrEqual(500);
        });
    });
});
