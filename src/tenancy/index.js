/**
 * tenancy/index.js — TeacherDox Core Multi-Tenancy Module
 *
 * Exports all tenancy-related functionality:
 * - Tenant class and configuration
 * - TenantRegistry for lifecycle management
 * - Database schema migrations
 * - Isolation strategies (schema_per_tenant, shared_tables, hybrid)
 */

const {
  Tenant,
  ISOLATION_STRATEGIES,
  DEFAULT_TENANT_CONFIG,
  setTenantContext,
  getTenantContext,
  clearTenantContext,
  createTenantMiddleware,
} = require('./tenant');

const {
  TenantRegistry,
  createRegistry,
  MemoryStorage,
  PostgresStorage,
} = require('./registry');

const {
  ISOLATION_STRATEGIES: MIGRATION_ISOLATION_STRATEGIES,
  CORE_TABLES,
  SHARED_TABLES,
  generateSchemaSQL,
  generateTenantMigrationSQL,
  generateTenantDropSQL,
  MIGRATIONS,
} = require('./migrations/schema');

module.exports = {
  // Core classes
  Tenant,
  TenantRegistry,

  // Factory functions
  createRegistry,

  // Storage adapters
  MemoryStorage,
  PostgresStorage,

  // Constants
  ISOLATION_STRATEGIES,
  DEFAULT_TENANT_CONFIG,

  // Context management
  setTenantContext,
  getTenantContext,
  clearTenantContext,
  createTenantMiddleware,

  // Migrations
  MIGRATIONS,
  CORE_TABLES,
  SHARED_TABLES,
  generateSchemaSQL,
  generateTenantMigrationSQL,
  generateTenantDropSQL,
};