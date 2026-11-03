/**
 * tenant.js — Multi-tenancy configuration and isolation for TeacherDox Core
 *
 * Supports three isolation strategies:
 * - schema_per_tenant: Each tenant gets their own PostgreSQL schema
 * - shared_tables: All tenants share tables with tenant_id column
 * - hybrid: Critical data in schema_per_tenant, shared reference data in shared_tables
 */

const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

// =============================================================================
// ISOLATION STRATEGIES
// =============================================================================

const ISOLATION_STRATEGIES = {
  SCHEMA_PER_TENANT: 'schema_per_tenant',
  SHARED_TABLES: 'shared_tables',
  HYBRID: 'hybrid',
};

/**
 * Default tenant configuration
 */
const DEFAULT_TENANT_CONFIG = {
  isolation: ISOLATION_STRATEGIES.SCHEMA_PER_TENANT,
  locale: 'en',
  timezone: 'UTC',
  currency: 'USD',
  features: {
    whatsapp: true,
    voice: true,
    translation: true,
    autoSign: true,
    analytics: true,
  },
  limits: {
    maxTeachers: 1000,
    maxEntriesPerDay: 10000,
    maxStorageMB: 1000,
    aiCallsPerDay: 50000,
  },
  ai: {
    primaryProvider: 'meta',
    fallbackProviders: ['baseten', 'gemini'],
    allowedModels: ['muse-spark-1.3', 'sam-3.1', 'muse-voice-transcribe-1.0'],
    reasoningEffort: 'low',
  },
  compliance: {
    dataRetentionDays: 2555, // 7 years
    auditLogging: true,
    encryptionAtRest: true,
    piiMasking: true,
  },
  notification: {
    webhookUrl: null,
    emailAlerts: true,
    slackAlerts: false,
  },
};

// =============================================================================
// TENANT CLASS
// =============================================================================

class Tenant {
  constructor(config = {}) {
    this.id = config.id || uuidv4();
    this.name = config.name || `tenant-${this.id.slice(0, 8)}`;
    this.slug = config.slug || this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    this.config = { ...DEFAULT_TENANT_CONFIG, ...config.config };
    this.status = config.status || 'active'; // active, suspended, deleted
    this.createdAt = config.createdAt || new Date().toISOString();
    this.updatedAt = config.updatedAt || new Date().toISOString();
    this.metadata = config.metadata || {};
    this._dbPool = null;
  }

  /**
   * Get the database schema name for this tenant
   */
  getSchemaName() {
    if (this.config.isolation === ISOLATION_STRATEGIES.SCHEMA_PER_TENANT) {
      return `tenant_${this.slug.replace(/-/g, '_')}`;
    }
    return 'public';
  }

  /**
   * Get the table prefix for shared_tables strategy
   */
  getTablePrefix() {
    return this.config.isolation === ISOLATION_STRATEGIES.SHARED_TABLES
      ? `t_${this.slug.replace(/-/g, '_')}_`
      : '';
  }

  /**
   * Check if a feature is enabled for this tenant
   */
  hasFeature(feature) {
    return this.config.features[feature] === true;
  }

  /**
   * Get limit value
   */
  getLimit(limitName) {
    return this.config.limits[limitName];
  }

  /**
   * Get AI configuration
   */
  getAIConfig() {
    return this.config.ai;
  }

  /**
   * Check if tenant is active
   */
  isActive() {
    return this.status === 'active';
  }

  /**
   * Update tenant configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Serialize for storage
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      config: this.config,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: this.metadata,
    };
  }

  /**
   * Deserialize from storage
   */
  static fromJSON(data) {
    const tenant = new Tenant(data);
    return tenant;
  }
}

// =============================================================================
// TENANT CONTEXT (for request-scoped access)
// =============================================================================

const tenantContext = new Map();

function setTenantContext(requestId, tenant) {
  tenantContext.set(requestId, tenant);
}

function getTenantContext(requestId) {
  return tenantContext.get(requestId);
}

function clearTenantContext(requestId) {
  tenantContext.delete(requestId);
}

function createTenantMiddleware(registry) {
  return async (req, res, next) => {
    const tenantId = req.headers['x-tenant-id'] || req.query.tenant_id;

    if (!tenantId) {
      return res.status(400).json({
        error: { code: 'TENANT_REQUIRED', message: 'x-tenant-id header is required' },
      });
    }

    const tenant = await registry.getTenant(tenantId);
    if (!tenant) {
      return res.status(404).json({
        error: { code: 'TENANT_NOT_FOUND', message: `Tenant ${tenantId} not found` },
      });
    }

    if (!tenant.isActive()) {
      return res.status(403).json({
        error: { code: 'TENANT_INACTIVE', message: `Tenant ${tenantId} is not active` },
      });
    }

    req.tenant = tenant;
    const requestId = req.headers['x-request-id'] || uuidv4();
    setTenantContext(requestId, tenant);
    req.requestId = requestId;

    res.setHeader('x-tenant-id', tenant.id);
    res.setHeader('x-request-id', requestId);

    next();
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  Tenant,
  ISOLATION_STRATEGIES,
  DEFAULT_TENANT_CONFIG,
  setTenantContext,
  getTenantContext,
  clearTenantContext,
  createTenantMiddleware,
};