/**
 * schema.js — Database schema migrations for TeacherDox Core multi-tenancy
 *
 * Supports three isolation strategies:
 * - schema_per_tenant: Each tenant gets their own PostgreSQL schema
 * - shared_tables: All tenants share tables with tenant_id column
 * - hybrid: Critical data in schema_per_tenant, shared reference data in shared_tables
 */

const { ISOLATION_STRATEGIES } = require('../tenant');

/**
 * Core tables that exist in every tenant schema (schema_per_tenant/hybrid)
 * or in shared public schema with tenant_id (shared_tables)
 */
const CORE_TABLES = `
-- ============================================================================
-- TEACHERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  whatsapp_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255),
  grade VARCHAR(50),
  subject VARCHAR(100),
  school_name VARCHAR(255),
  school_code VARCHAR(50),
  language VARCHAR(10) DEFAULT 'en',
  timezone VARCHAR(50) DEFAULT 'UTC',
  consent_given BOOLEAN DEFAULT false,
  consent_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teachers_tenant_whatsapp ON {schema}.teachers(tenant_id, whatsapp_id);
CREATE INDEX IF NOT EXISTS idx_teachers_active ON {schema}.teachers(tenant_id, active) WHERE active;

-- ============================================================================
-- ENTRIES TABLE (daily teaching records)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID NOT NULL REFERENCES {schema}.teachers(id),
  entry_date DATE NOT NULL,
  grade VARCHAR(50),
  subject VARCHAR(100),
  unit VARCHAR(100),
  chapter VARCHAR(100),
  topic VARCHAR(255),
  subtopic VARCHAR(255),
  method VARCHAR(50), -- lecture, discussion, activity, lab, assessment, project, other
  summary TEXT,
  homework TEXT,
  attendance JSONB DEFAULT '{}', -- {present, absent, total, details: []}
  carry_forward JSONB DEFAULT '[]', -- array of topic IDs to carry forward
  language VARCHAR(10) DEFAULT 'en',
  source VARCHAR(20) DEFAULT 'whatsapp', -- whatsapp, web, api, voice, photo
  media JSONB DEFAULT '[]', -- array of {type, url, meta}
  status VARCHAR(20) DEFAULT 'draft', -- draft, locked, amended, signed
  confidence JSONB DEFAULT '{}', -- per-field confidence scores
  provenance JSONB DEFAULT '[]', -- array of provenance steps
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  auto_signed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entries_tenant_teacher_date ON {schema}.entries(tenant_id, teacher_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_entries_status ON {schema}.entries(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_date ON {schema}.entries(tenant_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_teacher_date ON {schema}.entries(teacher_id, entry_date);

-- ============================================================================
-- CAPSULES TABLE (signed, verifiable teaching records)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.capsules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID NOT NULL REFERENCES {schema}.teachers(id),
  entry_id UUID NOT NULL REFERENCES {schema}.entries(id),
  capsule_hash VARCHAR(64) NOT NULL, -- SHA-256 of canonical JSON
  canonical_json JSONB NOT NULL, -- RFC 8785 canonical form
  signature VARCHAR(255), -- Ed25519 signature
  public_key VARCHAR(255), -- Ed25519 public key
  key_id VARCHAR(100), -- key identifier
  key_valid_from TIMESTAMPTZ,
  key_valid_until TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ,
  prev_hash VARCHAR(64), -- hash of previous capsule (chain)
  chain_index INTEGER DEFAULT 0,
  day_seal_hash VARCHAR(64), -- Merkle root of day's capsules
  day_seal_proof JSONB, -- Merkle proof
  countersignatures JSONB DEFAULT '[]', -- array of {signer, signature, role, at}
  verified_at TIMESTAMPTZ,
  verification_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capsules_tenant_teacher ON {schema}.capsules(tenant_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_capsules_entry ON {schema}.capsules(entry_id);
CREATE INDEX IF NOT EXISTS idx_capsules_hash ON {schema}.capsules(capsule_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_capsules_entry ON {schema}.capsules(entry_id);

-- ============================================================================
-- DAY_SEALS TABLE (Merkle day seals)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.day_seals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  seal_date DATE NOT NULL,
  merkle_root VARCHAR(64) NOT NULL,
  capsule_count INTEGER NOT NULL,
  capsule_hashes VARCHAR(64)[], -- array of capsule hashes in order
  signed_by UUID,
  signature VARCHAR(255),
  public_key VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_day_seals_tenant_date ON {schema}.day_seals(tenant_id, seal_date);
CREATE INDEX IF NOT EXISTS idx_day_seals_date ON {schema}.day_seals(seal_date);

-- ============================================================================
-- KEYS TABLE (Ed25519 key management)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID REFERENCES {schema}.teachers(id),
  key_id VARCHAR(100) NOT NULL,
  public_key VARCHAR(255) NOT NULL,
  private_key_encrypted TEXT, -- encrypted with tenant master key
  algorithm VARCHAR(20) DEFAULT 'Ed25519',
  purpose VARCHAR(20) DEFAULT 'signing', -- signing, sealing, countersigning
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_keys_tenant_teacher ON {schema}.keys(tenant_id, teacher_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_keys_tenant_keyid ON {schema}.keys(tenant_id, key_id);

-- ============================================================================
-- MEDIA TABLE (photos, voice notes, attachments)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID REFERENCES {schema}.teachers(id),
  entry_id UUID REFERENCES {schema}.entries(id),
  type VARCHAR(20) NOT NULL, -- photo, voice, document
  storage_path VARCHAR(500) NOT NULL,
  media_type VARCHAR(100), -- image/jpeg, audio/ogg, application/pdf
  size_bytes BIGINT,
  checksum VARCHAR(64), -- SHA-256
  metadata JSONB DEFAULT '{}', -- {width, height, duration, transcription, etc.}
  processed BOOLEAN DEFAULT false,
  processing_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_tenant_teacher ON {schema}.media(tenant_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_media_entry ON {schema}.media(entry_id);
CREATE INDEX IF NOT EXISTS idx_media_type ON {schema}.media(type);

-- ============================================================================
-- AI_CALLS TABLE (provenance & cost tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.ai_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID REFERENCES {schema}.teachers(id),
  entry_id UUID REFERENCES {schema}.entries(id),
  capability VARCHAR(20) NOT NULL, -- segment, transcribe, structure, check
  provider VARCHAR(20) NOT NULL, -- meta, baseten, gemini
  model VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC(10, 6),
  latency_ms INTEGER,
  status VARCHAR(20) DEFAULT 'success', -- success, error, fallback
  error_message TEXT,
  fallback_from VARCHAR(20), -- previous provider if fallback
  input_hash VARCHAR(64), -- hash of input for deduplication
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_tenant_teacher ON {schema}.ai_calls(tenant_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_entry ON {schema}.ai_calls(entry_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_capability ON {schema}.ai_calls(capability);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON {schema}.ai_calls(created_at);

-- ============================================================================
-- AUDIT_LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS {schema}.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  actor_type VARCHAR(20), -- teacher, system, admin
  actor_id UUID,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  before JSONB,
  after JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor ON {schema}.audit_log(tenant_id, actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON {schema}.audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON {schema}.audit_log(created_at);
`;

/**
 * Shared tables (only used in shared_tables or hybrid strategy)
 * These exist in the 'public' schema and are shared across all tenants
 */
const SHARED_TABLES = `
-- ============================================================================
-- TENANTS TABLE (always in public schema)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON public.tenants(status);

-- ============================================================================
-- REFERENCE DATA (shared across tenants)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.locales (
  code VARCHAR(10) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  native_name VARCHAR(100),
  rtl BOOLEAN DEFAULT false,
  date_format VARCHAR(50),
  number_format JSONB,
  meta_language_name VARCHAR(100), -- for Muse Voice Transcribe languageBias
  seamlessm4t_code VARCHAR(10), -- SeamlessM4T language code
  nllb_code VARCHAR(10), -- NLLB-200 language code
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.countries (
  code CHAR(2) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  native_name VARCHAR(100),
  currency VARCHAR(3),
  timezone VARCHAR(50),
  default_locale VARCHAR(10) REFERENCES public.locales(code),
  meta_region VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.institution_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.policies (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- GLOBAL AI MODEL CONFIG (shared)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ai_models (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL, -- meta, baseten, gemini, openai
  model_id VARCHAR(100) NOT NULL,
  display_name VARCHAR(100),
  capabilities VARCHAR(20)[], -- segment, transcribe, structure, check, translate
  input_price_per_mtok NUMERIC(10, 4),
  output_price_per_mtok NUMERIC(10, 4),
  transcribe_price_per_hour NUMERIC(10, 4),
  max_tokens INTEGER,
  supports_json_schema BOOLEAN DEFAULT false,
  supports_images BOOLEAN DEFAULT false,
  supports_audio BOOLEAN DEFAULT false,
  supported_languages VARCHAR(10)[],
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, model_id)
);

-- ============================================================================
-- TRANSLATION CACHE (shared)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.translation_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_text_hash VARCHAR(64) NOT NULL,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  translated_text TEXT NOT NULL,
  model VARCHAR(100),
  confidence NUMERIC(3, 2),
  hit_count INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_text_hash, source_lang, target_lang)
);
CREATE INDEX IF NOT EXISTS idx_translation_cache_langs ON public.translation_cache(source_lang, target_lang);
`;

/**
 * Generate SQL for a specific isolation strategy
 */
function generateSchemaSQL(strategy, tenantSlug = null) {
  let sql = '';

  // Always create shared tables
  sql += SHARED_TABLES;

  if (strategy === ISOLATION_STRATEGIES.SCHEMA_PER_TENANT) {
    if (!tenantSlug) {
      throw new Error('tenantSlug required for schema_per_tenant strategy');
    }
    const schemaName = `tenant_${tenantSlug.replace(/-/g, '_')}`;
    sql += `\n-- ============================================================================\n`;
    sql += `-- TENANT SCHEMA: ${schemaName}\n`;
    sql += `-- ============================================================================\n`;
    sql += `CREATE SCHEMA IF NOT EXISTS ${schemaName};\n`;
    sql += `GRANT USAGE ON SCHEMA ${schemaName} TO teacherdox_app;\n`;
    sql += `GRANT CREATE ON SCHEMA ${schemaName} TO teacherdox_app;\n`;
    sql += CORE_TABLES.replace(/{schema}/g, schemaName);
  } else if (strategy === ISOLATION_STRATEGIES.SHARED_TABLES) {
    sql += `\n-- ============================================================================\n`;
    sql += `-- SHARED TABLES (public schema with tenant_id)\n`;
    sql += `-- ============================================================================\n`;
    sql += CORE_TABLES.replace(/{schema}/g, 'public');
  } else if (strategy === ISOLATION_STRATEGIES.HYBRID) {
    if (!tenantSlug) {
      throw new Error('tenantSlug required for hybrid strategy');
    }
    const schemaName = `tenant_${tenantSlug.replace(/-/g, '_')}`;

    // Critical data in tenant schema
    sql += `\n-- ============================================================================\n`;
    sql += `-- TENANT SCHEMA (critical data): ${schemaName}\n`;
    sql += `-- ============================================================================\n`;
    sql += `CREATE SCHEMA IF NOT EXISTS ${schemaName};\n`;
    sql += `GRANT USAGE ON SCHEMA ${schemaName} TO teacherdox_app;\n`;
    sql += `GRANT CREATE ON SCHEMA ${schemaName} TO teacherdox_app;\n`;

    // Only critical tables in tenant schema
    const criticalTables = `
-- Teachers (critical - identity)
CREATE TABLE IF NOT EXISTS ${schemaName}.teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  whatsapp_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255),
  grade VARCHAR(50),
  subject VARCHAR(100),
  school_name VARCHAR(255),
  school_code VARCHAR(50),
  language VARCHAR(10) DEFAULT 'en',
  timezone VARCHAR(50) DEFAULT 'UTC',
  consent_given BOOLEAN DEFAULT false,
  consent_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teachers_tenant_whatsapp ON ${schemaName}.teachers(tenant_id, whatsapp_id);

-- Entries (critical - teaching records)
CREATE TABLE IF NOT EXISTS ${schemaName}.entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID NOT NULL REFERENCES ${schemaName}.teachers(id),
  entry_date DATE NOT NULL,
  grade VARCHAR(50),
  subject VARCHAR(100),
  unit VARCHAR(100),
  chapter VARCHAR(100),
  topic VARCHAR(255),
  subtopic VARCHAR(255),
  method VARCHAR(50),
  summary TEXT,
  homework TEXT,
  attendance JSONB DEFAULT '{}',
  carry_forward JSONB DEFAULT '[]',
  language VARCHAR(10) DEFAULT 'en',
  source VARCHAR(20) DEFAULT 'whatsapp',
  media JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'draft',
  confidence JSONB DEFAULT '{}',
  provenance JSONB DEFAULT '[]',
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  auto_signed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entries_tenant_teacher_date ON ${schemaName}.entries(tenant_id, teacher_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_teacher_date ON ${schemaName}.entries(teacher_id, entry_date);

-- Capsules (critical - verifiable records)
CREATE TABLE IF NOT EXISTS ${schemaName}.capsules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID NOT NULL REFERENCES ${schemaName}.teachers(id),
  entry_id UUID NOT NULL REFERENCES ${schemaName}.entries(id),
  capsule_hash VARCHAR(64) NOT NULL,
  canonical_json JSONB NOT NULL,
  signature VARCHAR(255),
  public_key VARCHAR(255),
  key_id VARCHAR(100),
  key_valid_from TIMESTAMPTZ,
  key_valid_until TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ,
  prev_hash VARCHAR(64),
  chain_index INTEGER DEFAULT 0,
  day_seal_hash VARCHAR(64),
  day_seal_proof JSONB,
  countersignatures JSONB DEFAULT '[]',
  verified_at TIMESTAMPTZ,
  verification_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capsules_tenant_teacher ON ${schemaName}.capsules(tenant_id, teacher_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_capsules_entry ON ${schemaName}.capsules(entry_id);

-- Day Seals (critical - Merkle proofs)
CREATE TABLE IF NOT EXISTS ${schemaName}.day_seals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  seal_date DATE NOT NULL,
  merkle_root VARCHAR(64) NOT NULL,
  capsule_count INTEGER NOT NULL,
  capsule_hashes VARCHAR(64)[],
  signed_by UUID,
  signature VARCHAR(255),
  public_key VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_day_seals_tenant_date ON ${schemaName}.day_seals(tenant_id, seal_date);

-- Keys (critical - signing keys)
CREATE TABLE IF NOT EXISTS ${schemaName}.keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID REFERENCES ${schemaName}.teachers(id),
  key_id VARCHAR(100) NOT NULL,
  public_key VARCHAR(255) NOT NULL,
  private_key_encrypted TEXT,
  algorithm VARCHAR(20) DEFAULT 'Ed25519',
  purpose VARCHAR(20) DEFAULT 'signing',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_keys_tenant_keyid ON ${schemaName}.keys(tenant_id, key_id);
`;
    sql += criticalTables;

    // Non-critical tables in public schema with tenant_id
    sql += `\n-- ============================================================================\n`;
    sql += `-- SHARED TABLES (non-critical data in public schema)\n`;
    sql += `-- ============================================================================\n`;

    const sharedTables = `
-- Media (non-critical - can be recreated)
CREATE TABLE IF NOT EXISTS public.media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID,
  entry_id UUID,
  type VARCHAR(20) NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  media_type VARCHAR(100),
  size_bytes BIGINT,
  checksum VARCHAR(64),
  metadata JSONB DEFAULT '{}',
  processed BOOLEAN DEFAULT false,
  processing_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_tenant_teacher ON public.media(tenant_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_media_entry ON public.media(entry_id);

-- AI Calls (non-critical - provenance/cost tracking)
CREATE TABLE IF NOT EXISTS public.ai_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  teacher_id UUID,
  entry_id UUID,
  capability VARCHAR(20) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC(10, 6),
  latency_ms INTEGER,
  status VARCHAR(20) DEFAULT 'success',
  error_message TEXT,
  fallback_from VARCHAR(20),
  input_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_tenant_teacher ON public.ai_calls(tenant_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_entry ON public.ai_calls(entry_id);

-- Audit Log (non-critical - can be archived separately)
CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  actor_type VARCHAR(20),
  actor_id UUID,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  before JSONB,
  after JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor ON public.audit_log(tenant_id, actor_type, actor_id);
`;
    sql += sharedTables;
  }

  return sql;
}

/**
 * Generate migration SQL for creating a new tenant
 */
function generateTenantMigrationSQL(tenant) {
  const strategy = tenant.config.isolation || ISOLATION_STRATEGIES.SCHEMA_PER_TENANT;
  return generateSchemaSQL(strategy, tenant.slug);
}

/**
 * Generate SQL to drop a tenant's schema (for deletion)
 */
function generateTenantDropSQL(tenant) {
  const strategy = tenant.config.isolation || ISOLATION_STRATEGIES.SCHEMA_PER_TENANT;

  if (strategy === ISOLATION_STRATEGIES.SCHEMA_PER_TENANT || strategy === ISOLATION_STRATEGIES.HYBRID) {
    const schemaName = `tenant_${tenant.slug.replace(/-/g, '_')}`;
    return `DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`;
  }

  // For shared_tables, we don't drop tables - we just delete tenant's rows
  // This is handled by the application logic, not migrations
  return `-- Shared tables strategy: delete tenant's rows from shared tables instead`;
}

/**
 * Get all migration files in order
 */
const MIGRATIONS = [
  {
    version: '001',
    name: 'initial_schema',
    description: 'Create initial shared tables and public schema',
    up: () => SHARED_TABLES,
    down: () => `
      DROP TABLE IF EXISTS public.translation_cache;
      DROP TABLE IF EXISTS public.ai_models;
      DROP TABLE IF EXISTS public.policies;
      DROP TABLE IF EXISTS public.institution_types;
      DROP TABLE IF EXISTS public.countries;
      DROP TABLE IF EXISTS public.locales;
      DROP TABLE IF EXISTS public.tenants;
    `,
  },
  {
    version: '002',
    name: 'core_tables_shared',
    description: 'Create core tables in public schema (shared_tables strategy)',
    up: () => CORE_TABLES.replace(/{schema}/g, 'public'),
    down: () => `
      DROP TABLE IF EXISTS public.ai_calls;
      DROP TABLE IF EXISTS public.media;
      DROP TABLE IF EXISTS public.keys;
      DROP TABLE IF EXISTS public.day_seals;
      DROP TABLE IF EXISTS public.capsules;
      DROP TABLE IF EXISTS public.entries;
      DROP TABLE IF EXISTS public.teachers;
    `,
  },
];

module.exports = {
  ISOLATION_STRATEGIES,
  CORE_TABLES,
  SHARED_TABLES,
  generateSchemaSQL,
  generateTenantMigrationSQL,
  generateTenantDropSQL,
  MIGRATIONS,
};