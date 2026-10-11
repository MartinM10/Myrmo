# billing

Billing service. Its database is `/var/acme/billing.db`; migrations live in `migrations/` and are applied with
`acmectl db migrate` (CI does it on every merge).
