-- Azure AD multi-tenant customer onboarding
-- Tracks which Azure AD tenants have been onboarded via admin consent.

CREATE TABLE IF NOT EXISTS customer_tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT UNIQUE NOT NULL,
  customer_name   TEXT NOT NULL,
  onboarded_at    TIMESTAMPTZ DEFAULT NOW(),
  active          BOOLEAN DEFAULT true
);

-- Index for active tenant lookups
CREATE INDEX IF NOT EXISTS idx_customer_tenants_active
  ON customer_tenants (tenant_id) WHERE active = true;

-- Add tenant_id column to users table for Azure AD users
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id TEXT;
