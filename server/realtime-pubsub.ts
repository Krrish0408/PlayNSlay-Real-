import { EventEmitter } from "events";
import Redis from "ioredis";
import { RealtimeNotification, RealtimeNotificationSchema } from "@shared/realtime";
import { logger } from "./observability";
import { getRedisClient } from "./rate-limiter";

/**
 * Shared Pub/Sub event bus for multi-instance scaling.
 *
 * In production clusters with multiple backend instances, events published by any
 * instance are broadcast via Redis Pub/Sub so all instances deliver them to their
 * locally connected WebSockets.
 *
 * When Redis is unavailable (e.g. single instance or test suite), an in-memory
 * EventEmitter is seamlessly used.
 */

const REDIS_CHANNEL = "pns:realtime:events";

class RealtimePubSubBus extends EventEmitter {
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;
  private isRedisConnected = false;
  private isInitialized = false;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    const baseRedis = getRedisClient();
    const redisUrl = process.env.REDIS_URL;

    if (redisUrl || baseRedis) {
      try {
        const targetUrl = redisUrl || "redis://localhost:6379";
        this.redisPub = new Redis(targetUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
        });

        this.redisSub = new Redis(targetUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
        });

        await Promise.all([this.redisPub.connect(), this.redisSub.connect()]);

        await this.redisSub.subscribe(REDIS_CHANNEL);
        this.isRedisConnected = true;

        this.redisSub.on("message", (channel, message) => {
          if (channel === REDIS_CHANNEL) {
            try {
              const parsed = JSON.parse(message);
              const validated = RealtimeNotificationSchema.parse(parsed);
              // Emit locally to all WebSocket handlers attached to this instance
              this.emit("event", validated);
            } catch (err: any) {
              logger.warn({ error: err.message }, "[PubSub] Received malformed event from Redis");
            }
          }
        });

        this.redisPub.on("error", (err) => {
          logger.warn({ error: err.message }, "[PubSub] Redis Publisher error");
        });

        this.redisSub.on("error", (err) => {
          logger.warn({ error: err.message }, "[PubSub] Redis Subscriber error");
        });

        logger.info("[PubSub] Redis distributed event bus connected and listening.");
      } catch (err: any) {
        logger.warn(
          { error: err.message },
          "[PubSub] Could not connect to Redis Pub/Sub; using in-memory event bus fallback."
        );
        this.isRedisConnected = false;
      }
    } else {
      logger.info("[PubSub] Operating in local in-memory event bus mode.");
    }
  }

  /**
   * Publishes an event to the distributed bus.
   */
  public async publish(event: RealtimeNotification): Promise<void> {
    // Validate schema before publishing
    const validated = RealtimeNotificationSchema.parse(event);

    if (this.isRedisConnected && this.redisPub && this.redisPub.status === "ready") {
      try {
        await this.redisPub.publish(REDIS_CHANNEL, JSON.stringify(validated));
        return;
      } catch (err: any) {
        logger.warn({ error: err.message }, "[PubSub] Redis publish failed, falling back to local emit");
      }
    }

    // Fallback: emit locally
    this.emit("event", validated);
  }

  /**
   * Subscribes to events arriving on this instance.
   */
  public onEvent(listener: (event: RealtimeNotification) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }

  public async close(): Promise<void> {
    if (this.redisSub) {
      await this.redisSub.quit().catch(() => {});
      this.redisSub = null;
    }
    if (this.redisPub) {
      await this.redisPub.quit().catch(() => {});
      this.redisPub = null;
    }
    this.isRedisConnected = false;
    this.isInitialized = false;
  }
}

export const realtimePubSub = new RealtimePubSubBus();
