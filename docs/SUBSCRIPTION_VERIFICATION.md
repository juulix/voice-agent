# Subscription Receipt Verification Endpoint

## Overview

This endpoint validates subscription receipts with Apple's servers, handling both production and sandbox receipts as required by Apple Guideline 2.1.

**Endpoint:** `POST /verify-subscription`

## Apple Guideline 2.1 Compliance

When validating receipts on your server, your server needs to be able to handle a production-signed app getting its receipts from Apple's test environment. The recommended approach is:

1. **Always validate against production first**
2. **If validation fails with error code "Sandbox receipt used in production" (21007), validate against sandbox**

This endpoint implements exactly this behavior.

## Request

### Headers
- `Authorization`: Bearer token (required)
- `X-User-Id`: User identifier (required, format: `u-timestamp-8chars`)

### Body

#### Option 1: Receipt Data (Recommended)
```json
{
  "receiptData": "base64-encoded-receipt-data",
  "productId": "com.echotime2025.10.pro" // optional, helps identify plan
}
```

#### Option 2: Transaction ID (StoreKit 2)
```json
{
  "transactionId": "1234567890",
  "productId": "com.echotime2025.10.pro" // required when using transactionId
}
```

### Product IDs

Supported product IDs:
- `com.echotime2025.10.basic` → `basic` plan
- `com.echotime2025.10.pro` → `pro` plan
- `com.echotime2025.10.proyearly` → `pro-yearly` plan
- `com.balssassistents.basic` → `basic` plan
- `com.balssassistents.pro` → `pro` plan
- `com.balssassistents.proyearly` → `pro-yearly` plan

## Response

### Success (200)
```json
{
  "success": true,
  "plan": "pro",
  "isSandbox": false,
  "transactionId": "1234567890",
  "productId": "com.echotime2025.10.pro",
  "requestId": "verify-1234567890"
}
```

### Error (400)
```json
{
  "error": "invalid_receipt",
  "status": 21000,
  "message": "Apple validation failed with status 21000",
  "requestId": "verify-1234567890"
}
```

### Error (401)
```json
{
  "error": "unauthorized",
  "requestId": "verify-1234567890"
}
```

## Environment Variables

Optional but recommended:
- `APPLE_SHARED_SECRET`: Your Apple shared secret for receipt validation (get from App Store Connect)

## Validation Flow

1. **Receipt Data Provided:**
   - Validate against production App Store
   - If status 21007 (sandbox receipt), validate against sandbox
   - Extract product ID from receipt
   - Map product ID to plan

2. **Transaction ID Only (StoreKit 2):**
   - Requires `productId` in request
   - Maps product ID to plan
   - Note: Full validation requires App Store Server API v2 (future enhancement)

## Example Usage

### cURL
```bash
curl -X POST https://voice-agent-production-670b.up.railway.app/verify-subscription \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-User-Id: u-1234567890-abcdefgh" \
  -H "Content-Type: application/json" \
  -d '{
    "receiptData": "base64-encoded-receipt",
    "productId": "com.echotime2025.10.pro"
  }'
```

### JavaScript/Node.js
```javascript
const response = await fetch('https://voice-agent-production-670b.up.railway.app/verify-subscription', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'X-User-Id': 'u-1234567890-abcdefgh',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    receiptData: base64ReceiptData,
    productId: 'com.echotime2025.10.pro'
  })
});

const result = await response.json();
```

## Integration with iOS App

After a successful subscription purchase in the app:

1. Get receipt data from `Bundle.main.appStoreReceiptURL`
2. Encode receipt as base64
3. Send to `/verify-subscription` endpoint
4. Update user's subscription status based on response

## Apple Status Codes

Common Apple receipt validation status codes:
- `0`: Valid receipt
- `21000`: The App Store could not read the receipt
- `21002`: The receipt data was malformed
- `21007`: Sandbox receipt used in production (handled automatically)
- `21008`: Production receipt used in sandbox

## Notes

- This endpoint handles the Apple review scenario where production-signed apps receive sandbox receipts
- For StoreKit 2, full validation requires App Store Server API v2 (can be added later)
- The endpoint logs all validation attempts for debugging
- Failed validations are tracked in Sentry

