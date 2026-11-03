/**
 * registry.js — Tenant Registry for TeacherDox Core
 *
 * Manages tenant lifecycle, configuration, and database connections.
 * Supports in-memory cache with persistent storage backend.
 */

const { Tenant, ISOLATION_STRATEGIES } = require('./tenant');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

// =============================================================================
// STORAGE ADAPTERS
// =============================================================================

class MemoryStorage {
  constructor() {
    this.tenants = new Map();
    this.idToSlug = new Map();
  }

  async save(tenant) {
    this.tenants.set(tenant.id, tenant.toJSON());
    this.idToSlug.set(tenant.id, tenant.slug);
    return tenant;
  }

  async getById(id) {
    const data = this.tenants.get(id);
    return data ? Tenant.fromJSON(data) : null;
  }

  async getBySlug(slug) {
    for (const [id, tenantSlug] of this.idToSlug.entries()) {
      if (tenantSlug === slug) {
        return this.getById(id);
      }
    }
    return null;
  }

  async list(options = {}) {
    const { status, limit = 100, offset = 0 } = options;
    let tenants = Array.from(this.tenants.values()).map(d => Tenant.fromJSON(d));

    if (status) {
      tenants = tenants.filter(t => t.status === status);
    }

    return tenants.slice(offset, offset + limit);
  }

  async delete(id) {
    const tenant = this.tenants.get(id);
    if (tenant) {
      this.idToSlug.delete(id);
      this.tenants.delete(id);
      return true;
    }
    return false;
  }

  async count() {
    return this.tenants.size;
  }
}

// PostgreSQL storage would be implemented for production
class PostgresStorage {
  constructor(pool) {
    this.pool = pool;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    `);
    this.initialized = true;
  }

  async save(tenant) {
    await this.initialize();
    const data = tenant.toJSON();
    await this.pool.query(
      `INSERT INTO tenants (id, name, slug, config, status, created_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         config = EXCLUDED.config,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         metadata = EXCLUDED.metadata`,
      [data.id, data.name, data.slug, JSON.stringify(data.config), data.status,
       data.createdAt, data.updatedAt, JSON.stringify(data.metadata)]
    );
    return tenant;
  }

  async getById(id) {
    await this.initialize();
    const result = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return result.rows[0] ? Tenant.fromJSON(result.rows[0]) : null;
  }

  async getBySlug(slug) {
    await this.initialize();
    const result = await this.pool.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return result.rows[0] ? Tenant.fromJSON(result.rows[0]) : null;
  }

  async list(options = {}) {
    await this.initialize();
    const { status, limit = 100, offset = 0 } = options;
    let query = 'SELECT * FROM tenants';
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` WHERE status = $${paramIndex++}`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await this.pool.query(query, params);
    return result.rows.map(r => Tenant.fromJSON(r));
  }

  async delete(id) {
    await this.initialize();
    const result = await this.pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async count() {
    await this.initialize();
    const result = await this.pool.query('SELECT COUNT(*) FROM tenants');
    return parseInt(result.rows[0].count, 10);
  }
}

// =============================================================================
// TENANT REGISTRY
// =============================================================================

class TenantRegistry {
  constructor(options = {}) {
    this.storage = options.storage || new MemoryStorage();
    this.cache = new Map(); // id -> tenant
    this.slugCache = new Map(); // slug -> tenant
    this.logger = options.logger || winston.createLogger({
      transports: [new winston.transports.Console()],
      level: 'info',
    });
    this.defaultTenantId = options.defaultTenantId || 'default';
  }

  /**
   * Create a new tenant
   */
  async createTenant(config) {
    // Check slug uniqueness
    if (config.slug) {
      const existing = await this.storage.getBySlug(config.slug);
      if (existing) {
        throw new Error(`Tenant with slug "${config.slug}" already exists`);
      }
    }

    const tenant = new Tenant(config);
    await this.storage.save(tenant);
    this.cache.set(tenant.id, tenant);
    this.slugCache.set(tenant.slug, tenant);

    this.logger.info('Tenant created', {
      tenantId: tenant.id,
      slug: tenant.slug,
      isolation: tenant.config.isolation,
    });

    return tenant;
  }

  /**
   * Get tenant by ID
   */
  async getTenant(id) {
    // Check cache first
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }

    const tenant = await this.storage.getById(id);
    if (tenant) {
      this.cache.set(id, tenant);
      this.slugCache.set(tenant.slug, tenant);
    }
    return tenant;
  }

  /**
   * Get tenant by slug
   */
  async getTenantBySlug(slug) {
    if (this.slugCache.has(slug)) {
      return this.slugCache.get(slug);
    }

    const tenant = await this.storage.getBySlug(slug);
    if (tenant) {
      this.cache.set(tenant.id, tenant);
      this.slugCache.set(slug, tenant);
    }
    return tenant;
  }

  /**
   * Get or create default tenant
   */
  async getDefaultTenant() {
    let tenant = await this.getTenant(this.defaultTenantId);
    if (!tenant) {
      tenant = await this.createTenant({
        id: this.defaultTenantId,
        name: 'Default Tenant',
        slug: 'default',
        config: { isolation: ISOLATION_STRATEGIES.SHARED_TABLES },
      });
    }
    return tenant;
  }

  /**
   * Update tenant configuration
   */
  async updateTenant(id, config) {
    const tenant = await this.getTenant(id);
    if (!tenant) {
      throw new Error(`Tenant ${id} not found`);
    }

    // Check slug uniqueness if changing
    if (config.slug && config.slug !== tenant.slug) {
      const existing = await this.storage.getBySlug(config.slug);
      if (existing && existing.id !== id) {
        throw new Error(`Tenant with slug "${config.slug}" already exists`);
      }
    }

    tenant.updateConfig(config);
    await this.storage.save(tenant);
    this.cache.set(id, tenant);
    this.slugCache.set(tenant.slug, tenant);

    this.logger.info('Tenant updated', { tenantId: id });
    return tenant;
  }

  /**
   * Set tenant status
   */
  async setStatus(id, status) {
    const tenant = await this.getTenant(id);
    if (!tenant) {
      throw new Error(`Tenant ${id} not found`);
    }

    const validStatuses = ['active', 'suspended', 'deleted'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    tenant.status = status;
    tenant.updatedAt = new Date().toISOString();
    await this.storage.save(tenant);
    this.cache.set(id, tenant);

    this.logger.info('Tenant status changed', { tenantId: id, status });
    return tenant;
  }

  /**
   * Delete tenant
   */
  async deleteTenant(id) {
    const tenant = await this.getTenant(id);
    if (!tenant) {
      return false;
    }

    await this.storage.delete(id);
    this.cache.delete(id);
    this.slugCache.delete(tenant.slug);

    this.logger.info('Tenant deleted', { tenantId: id });
    return true;
  }

  /**
   * List tenants
   */
  async listTenants(options = {}) {
    return this.storage.list(options);
  }

  /**
   * Get tenant count
   */
  async count() {
    return this.storage.count();
  }

  /**
   * Clear cache (useful for testing or after external changes)
   */
  clearCache() {
    this.cache.clear();
    this.slugCache.clear();
  }

  /**
   * Get database schema name for a tenant
   */
  getSchemaName(tenantId) {
    const tenant = this.cache.get(tenantId);
    return tenant ? tenant.getSchemaName() : 'public';
  }

  /**
   * Get table prefix for a tenant
   */
  getTablePrefix(tenantId) {
    const tenant = this.cache.get(tenantId);
    return tenant ? tenant.getTablePrefix() : '';
  }
}

// =============================================================================
// FACTORY
// =============================================================================

async function createRegistry(options = {}) {
  let storage;

  if (options.pool) {
    storage = new PostgresStorage(options.pool);
  } else {
    storage = new MemoryStorage();
  }

  const registry = new TenantRegistry({
    storage,
    logger: options.logger,
    defaultTenantId: options.defaultTenantId,
  });

  // Ensure default tenant exists
  await registry.getDefaultTenant();

  return registry;
}

module.exports = {
  TenantRegistry,
  createRegistry,
  MemoryStorage,
  PostgresStorage,
};