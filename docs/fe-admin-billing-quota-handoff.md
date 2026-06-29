# FE Admin Billing Quota Handoff

## Goal

Replace the free-text quota editor with a typed table/form backed by BE billing APIs. FE should not ask admins to type strings like:

```txt
cv_review:20:MONTHLY
cv_builder_create:10:MONTHLY
```

That format is brittle and can accidentally drop quota rows when sent through the full-replace API.

## APIs To Use

### List Plans

```http
GET /api/admin/billing/plans?includeInactive=true
```

Use this to load plan rows, price, active status, and current `features[]`.

### List Feature Catalog

```http
GET /api/admin/billing/features
```

Response item shape:

```json
{
  "featureKey": "cv_review",
  "label": "CV diagnosis",
  "description": "AI CV analysis, ATS checks, scoring and feedback.",
  "allowedPeriods": ["MONTHLY"],
  "recommendedLimits": {
    "FREE": 3,
    "PRO": 30,
    "PREMIUM": 100
  }
}
```

Use this endpoint to render labels, descriptions, dropdown options, and recommended defaults. Do not hard-code feature labels in FE.

### Update One Feature Quota

```http
PATCH /api/admin/billing/plans/:code/features/:featureKey
```

Request:

```json
{
  "limitValue": 20,
  "period": "MONTHLY"
}
```

Rules:

- `limitValue = -1` means unlimited.
- `limitValue = 0` means feature is not included.
- `period` should come from `allowedPeriods`.
- If the feature row does not exist yet, BE creates it.
- This endpoint does not delete other features.

### Replace All Feature Quotas

```http
PUT /api/admin/billing/plans/:code/features
```

Request:

```json
{
  "features": [
    {
      "featureKey": "cv_review",
      "limitValue": 30,
      "period": "MONTHLY"
    }
  ]
}
```

Use this only for a bulk save screen where FE intentionally sends every feature row. If FE sends a partial list, missing features are removed from that plan.

## Recommended UI

Render a quota table per plan:

| Column | Control |
|---|---|
| Feature | Catalog label + description tooltip |
| Limit | Number input, min `0` unless unlimited toggle is on |
| Unlimited | Toggle; when on, send `limitValue: -1` |
| Period | Select from `allowedPeriods` |
| Save | Calls single-feature PATCH |

Recommended display values:

- `-1` -> `Unlimited`
- `0` -> `Not included`
- Positive number -> `{n} / {period.toLowerCase()}`

## Error Handling

BE validation rejects:

- Unknown `featureKey`
- Invalid `period`
- `limitValue < -1`
- Unknown plan code

Show these as admin-edit errors and keep the local row in edit mode.

## Public Billing Page

Use:

```http
GET /api/billing/plans
```

This now returns only active subscription plans. Mentor packages should not be shown on the subscription billing page.
