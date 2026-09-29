import { z } from 'zod';
import { insertUserSchema, insertGameTypeSchema, insertGameSchema, insertBookingSchema, users, gameTypes, games, bookings } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  auth: {
    register: {
      method: 'POST' as const,
      path: '/api/register',
      input: insertUserSchema,
      responses: {
        201: z.custom<typeof users.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
    login: {
      method: 'POST' as const,
      path: '/api/login',
      input: z.object({ username: z.string(), password: z.string() }),
      responses: {
        200: z.custom<typeof users.$inferSelect>(),
        401: z.object({ message: z.string() }),
      },
    },
    logout: {
      method: 'POST' as const,
      path: '/api/logout',
      responses: {
        200: z.void(),
      },
    },
    me: {
      method: 'GET' as const,
      path: '/api/user',
      responses: {
        200: z.custom<typeof users.$inferSelect>(),
        401: z.void(),
      },
    },
  },
  gameTypes: {
    list: {
      method: 'GET' as const,
      path: '/api/game-types',
      responses: {
        200: z.array(z.custom<typeof gameTypes.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/game-types',
      input: insertGameTypeSchema,
      responses: {
        201: z.custom<typeof gameTypes.$inferSelect>(),
        403: z.object({ message: z.string() }),
      },
    },
    update: {
      method: 'PATCH' as const,
      path: '/api/game-types/:id',
      input: insertGameTypeSchema.partial(),
      responses: {
        200: z.custom<typeof gameTypes.$inferSelect>(),
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/game-types/:id',
      responses: {
        204: z.void(),
      },
    },
  },
  games: {
    list: {
      method: 'GET' as const,
      path: '/api/games',
      responses: {
        200: z.array(z.custom<typeof games.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/games',
      input: insertGameSchema,
      responses: {
        201: z.custom<typeof games.$inferSelect>(),
        403: z.object({ message: z.string() }),
      },
    },
    update: {
      method: 'PATCH' as const,
      path: '/api/games/:id',
      input: insertGameSchema.partial(),
      responses: {
        200: z.custom<typeof games.$inferSelect>(),
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/games/:id',
      responses: {
        204: z.void(),
      },
    },
  },
  bookings: {
    list: {
      method: 'GET' as const,
      path: '/api/bookings',
      responses: {
        200: z.array(z.custom<typeof bookings.$inferSelect & { gameType: typeof gameTypes.$inferSelect, user: typeof users.$inferSelect }>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/bookings',
      input: insertBookingSchema.extend({
        paymentMethod: z.enum(["online", "offline"]),
        gameTitle: z.string().optional(),
      }),
      responses: {
        201: z.custom<typeof bookings.$inferSelect>(),
      },
    },
    updateStatus: {
      method: 'PATCH' as const,
      path: '/api/bookings/:id/status',
      input: z.object({ status: z.enum(["Pending", "Approved", "Cancelled", "Completed"]) }),
      responses: {
        200: z.custom<typeof bookings.$inferSelect>(),
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
