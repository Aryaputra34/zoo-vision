import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from './redis.constants';

interface ChannelSubscription {
  listeners: Set<(data: Buffer) => void>;
  subscribePromise: Promise<void> | null;
}

@Injectable()
export class RedisPubSub implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisPubSub.name);
  private subClient: Redis | null = null;
  private readonly channels = new Map<string, ChannelSubscription>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private getClient(): Redis {
    if (!this.subClient) {
      this.subClient = this.redis.duplicate({
        maxRetriesPerRequest: null,
        commandTimeout: undefined,
      });
      this.subClient.on('error', (err: Error) => {
        this.logger.warn(`PubSub Redis error: ${err.message}`);
      });
      this.subClient.on(
        'messageBuffer',
        (channelBuf: Buffer, messageBuf: Buffer) => {
          const channel = channelBuf.toString();
          const sub = this.channels.get(channel);
          if (sub) {
            for (const listener of sub.listeners) {
              try {
                listener(messageBuf);
              } catch (err) {
                this.logger.error(
                  `Error in pubsub listener for ${channel}: ${(err as Error).message}`,
                );
              }
            }
          }
        },
      );
    }
    return this.subClient;
  }

  async subscribe(
    channel: string,
    onMessage: (data: Buffer) => void,
  ): Promise<() => Promise<void>> {
    let sub = this.channels.get(channel);
    if (!sub) {
      sub = {
        listeners: new Set(),
        subscribePromise: null,
      };
      this.channels.set(channel, sub);
    }

    sub.listeners.add(onMessage);

    // If first listener or no subscription is in flight, issue SUBSCRIBE
    if (!sub.subscribePromise) {
      const client = this.getClient();
      sub.subscribePromise = client
        .subscribe(channel)
        .then(() => {})
        .catch((err) => {
          // If subscribe failed, clean up listeners and state
          this.channels.delete(channel);
          throw err;
        });
    }

    try {
      await sub.subscribePromise;
    } catch (err) {
      sub.listeners.delete(onMessage);
      throw err;
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;

      const current = this.channels.get(channel);
      if (!current) return;

      current.listeners.delete(onMessage);

      // When the last listener is gone, unsubscribe from Redis
      if (current.listeners.size === 0) {
        this.channels.delete(channel);
        if (this.subClient) {
          try {
            await this.subClient.unsubscribe(channel);
          } catch (err) {
            this.logger.warn(
              `Failed to unsubscribe from ${channel}: ${(err as Error).message}`,
            );
          }
        }
      }
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.subClient) {
      if (this.subClient.status === 'ready') {
        await this.subClient.quit().catch(() => undefined);
      } else {
        this.subClient.disconnect();
      }
      this.subClient = null;
    }
    this.channels.clear();
  }
}
