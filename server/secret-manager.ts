/**
 * Production Secret Management Abstraction.
 *
 * Provides a unified, pluggable interface for loading secrets from:
 * 1. Environment variables (EnvSecretManager)
 * 2. File-mounted secrets (FileSecretManager, e.g. Kubernetes /run/secrets or Docker secrets)
 * 3. Composite provider (CompositeSecretManager) that checks file mounts first, falling back to environment
 *
 * Built-in safeguards:
 * - Redacts sensitive secret values to prevent credential leakage in logs
 * - Enforces fail-closed retrieval for mandatory production secrets
 * - Extensible provider architecture ready for AWS Secrets Manager or HashiCorp Vault
 */

import fs from "fs";
import path from "path";

export interface ISecretManager {
  /**
   * Retrieves a secret by key. Returns undefined if the secret does not exist.
   */
  getSecret(key: string): Promise<string | undefined>;

  /**
   * Retrieves a secret by key, throwing an error if the secret is undefined or empty.
   */
  getRequiredSecret(key: string): Promise<string>;

  /**
   * Checks whether a secret is configured.
   */
  hasSecret(key: string): Promise<boolean>;
}

/**
 * Common known placeholder / dummy values that must be rejected in production.
 */
export const BANNED_SECRET_PATTERNS = [
  "changeme",
  "password",
  "admin123",
  "employee123",
  "your_api_key",
  "your_api_secret",
  "your_secret",
  "your_cloud_name",
  "your_session_secret",
  "your_admin_password",
  "your_employee_password",
  "placeholder",
  "default_secret",
];

/**
 * Redacts a sensitive string for safe logging/diagnostics without leaking content.
 */
export function redactSecret(value?: string | null): string {
  if (!value) return "<not set>";
  if (value.length <= 6) return "******";
  return `${value.slice(0, 2)}***${value.slice(-2)} (len: ${value.length})`;
}

/**
 * Secret manager reading from environment variables.
 */
export class EnvSecretManager implements ISecretManager {
  async getSecret(key: string): Promise<string | undefined> {
    const val = process.env[key];
    if (val === undefined || val === null) return undefined;
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async getRequiredSecret(key: string): Promise<string> {
    const val = await this.getSecret(key);
    if (!val) {
      throw new Error(`Required secret '${key}' is missing or empty in environment.`);
    }
    return val;
  }

  async hasSecret(key: string): Promise<boolean> {
    const val = await this.getSecret(key);
    return Boolean(val);
  }
}

/**
 * Secret manager reading from mounted secret files (e.g. /run/secrets/<key> or /var/secrets/<key>).
 */
export class FileSecretManager implements ISecretManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.env.SECRETS_DIR || "/run/secrets";
  }

  async getSecret(key: string): Promise<string | undefined> {
    try {
      const sanitizedKey = key.replace(/[^A-Za-z0-9_.-]/g, "");
      const filePath = path.join(this.baseDir, sanitizedKey);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const content = fs.readFileSync(filePath, "utf-8").trim();
      return content.length > 0 ? content : undefined;
    } catch {
      return undefined;
    }
  }

  async getRequiredSecret(key: string): Promise<string> {
    const val = await this.getSecret(key);
    if (!val) {
      throw new Error(`Required secret '${key}' is missing or empty in file store '${this.baseDir}'.`);
    }
    return val;
  }

  async hasSecret(key: string): Promise<boolean> {
    const val = await this.getSecret(key);
    return Boolean(val);
  }
}

/**
 * Composite secret manager checking file stores first, falling back to environment variables.
 */
export class CompositeSecretManager implements ISecretManager {
  private providers: ISecretManager[];

  constructor(providers?: ISecretManager[]) {
    this.providers = providers || [
      new FileSecretManager(),
      new EnvSecretManager(),
    ];
  }

  async getSecret(key: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      const val = await provider.getSecret(key);
      if (val !== undefined && val.length > 0) {
        return val;
      }
    }
    return undefined;
  }

  async getRequiredSecret(key: string): Promise<string> {
    const val = await this.getSecret(key);
    if (!val) {
      throw new Error(`Required secret '${key}' could not be resolved from any configured secret provider.`);
    }
    return val;
  }

  async hasSecret(key: string): Promise<boolean> {
    const val = await this.getSecret(key);
    return Boolean(val);
  }
}

/**
 * Default global secret manager singleton instance.
 */
export const secretManager: ISecretManager = new CompositeSecretManager();
