# PunchOut Gateway Plugin

A Vendure plugin for integrating with [PunchCommerce](https://www.punchcommerce.de), a PunchOut gateway that connects your Vendure store with enterprise procurement systems (SAP Ariba, Coupa, etc.) via OCI/cXML protocols.

PunchCommerce handles all protocol translation — this plugin only speaks JSON over HTTPS.

## How It Works

1. **Buyer clicks PunchOut link** in their ERP → PunchCommerce redirects to your Vendure instance at `/punchcommerce/authenticate?sID=...&uID=...`
2. **Plugin redirects to storefront** (or returns JSON for API-level testing) with the `sID` and `uID` params
3. **Storefront authenticates the buyer** by calling Vendure's `authenticate` mutation with the `punchout` strategy
4. **Buyer shops normally** — all order mutations use `activeOrderInput: { punchout: { sID: "..." } }` to scope the cart to the PunchOut session
5. **On checkout**, storefront calls `transferPunchOutCart(sID)` to send the cart back to PunchCommerce

## Installation

```bash
npm install @vendure-community/punchout-gateway-plugin
```

## Configuration

```ts
import { PunchOutGatewayPlugin } from '@vendure-community/punchout-gateway-plugin';

export const config: VendureConfig = {
    plugins: [
        PunchOutGatewayPlugin.init({
            // Optional: redirect to storefront after PunchCommerce authentication
            // storefrontUrl: 'https://my-store.com/punchout',
        }),
    ],
};
```

### Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `apiUrl` | No | `https://www.punchcommerce.de` | Base URL of the PunchCommerce gateway. Override for staging or self-hosted instances. |
| `shippingCostMode` | No | `'nonZero'` | Controls shipping line item in the basket: `'all'` = always include, `'nonZero'` = only when > 0, `'none'` = never include. |
| `storefrontUrl` | No | — | URL of your storefront's PunchOut landing page. When set, `/punchcommerce/authenticate` redirects here with `sID` and `uID` as query params. When not set, returns JSON for testing. |

## Customer Setup

Customers are linked to PunchCommerce via a custom field on the Customer entity. No scripts or database manipulation needed.

1. **In PunchCommerce**: create a customer and set the "Customer identification" (this becomes the `uID`)
2. **In Vendure admin**: open the customer, set the **"PunchOut Customer ID (uID)"** custom field to the same value
3. That's it — the customer can now authenticate via PunchOut

## PunchCommerce Configuration

In the PunchCommerce dashboard, configure your customer:

- **Entry address**: `https://your-vendure-server.com/punchcommerce/authenticate`
- **Customer identification**: a unique identifier (e.g. `my-customer-id`)

The plugin registers a REST endpoint at `/punchcommerce/authenticate` that handles the redirect from PunchCommerce.

## Storefront Integration

### 1. Handle the PunchCommerce Redirect

When PunchCommerce redirects to your storefront (via the `storefrontUrl` option), it includes `sID` and `uID` as query parameters. Extract them and authenticate:

```ts
const params = new URLSearchParams(window.location.search);
const sID = params.get('sID');
const uID = params.get('uID');

// Store sID for use throughout the PunchOut session
sessionStorage.setItem('punchoutSID', sID);

const result = await graphqlClient.mutate({
    mutation: gql`
        mutation PunchOutLogin($sID: String!, $uID: String!) {
            authenticate(input: { punchout: { sID: $sID, uID: $uID } }) {
                ... on CurrentUser { id }
                ... on InvalidCredentialsError { message }
            }
        }
    `,
    variables: { sID, uID },
});
```

### 2. Shopping with Session-Scoped Cart

All order mutations must include `activeOrderInput` to scope the cart to the PunchOut session. This allows the same customer to have multiple concurrent PunchOut sessions with separate carts.

```ts
const sID = sessionStorage.getItem('punchoutSID');

await graphqlClient.mutate({
    mutation: gql`
        mutation AddItem($variantId: ID!, $qty: Int!, $activeOrderInput: ActiveOrderInput) {
            addItemToOrder(
                productVariantId: $variantId
                quantity: $qty
                activeOrderInput: $activeOrderInput
            ) {
                ... on Order { id totalWithTax }
                ... on ErrorResult { message }
            }
        }
    `,
    variables: {
        variantId: '42',
        qty: 1,
        activeOrderInput: { punchout: { sID } },
    },
});
```

The same `activeOrderInput` must be passed on all order operations: `addItemToOrder`, `adjustOrderLine`, `removeOrderLine`, `setOrderShippingAddress`, `setOrderShippingMethod`, `eligibleShippingMethods`, etc.

### 3. Transfer Cart on Checkout

When the buyer is ready to transfer their cart back to the procurement system:

```ts
const result = await graphqlClient.mutate({
    mutation: gql`
        mutation TransferCart($sID: String!) {
            transferPunchOutCart(sID: $sID) {
                success
                message
            }
        }
    `,
    variables: { sID },
});

if (result.data.transferPunchOutCart.success) {
    // Cart transferred — show confirmation to the buyer
}
```

## GraphQL API Reference

### Authentication (built-in mutation)

```graphql
mutation {
    authenticate(input: { punchout: { sID: "...", uID: "..." } }) {
        ... on CurrentUser { id }
        ... on InvalidCredentialsError { message }
    }
}
```

### Transfer Cart

```graphql
mutation {
    transferPunchOutCart(sID: "...") {
        success
        message
    }
}
```

Requires an authenticated PunchOut session.

## Cart Mapping

The plugin maps Vendure order lines to PunchCommerce basket positions:

- **Prices** use gross/net pattern: `price` = gross (with tax), `price_net` = net (without tax)
- **All monetary values** are converted from Vendure's integer cents to decimal (÷ 100)
- **Shipping** is included as a separate position with `type: 'shipping-costs'` (controlled by `shippingCostMode`)
- **Product descriptions** are stripped of HTML tags for the `description` field; `description_long` preserves HTML
- **Basket is sent** as `multipart/form-data` to PunchCommerce's `/gateway/v3/return` endpoint

## Parallel Sessions

The plugin uses a custom `ActiveOrderStrategy` to scope orders by PunchOut session ID (`sID`). This means:

- Each PunchOut session gets its own empty cart
- The same customer can have multiple concurrent PunchOut sessions
- Carts are isolated — items added in one session don't appear in another
