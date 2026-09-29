import { Request, Response } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
export const MAX_DATE_RANGE_DAYS = 90;
export const MAX_BOOKINGS_DATE_RANGE_DAYS = 365;

// Base64URL cursor serialization and deserialization
export function encodeCursor(data: any): string {
  return Buffer.from(JSON.stringify(data), "utf-8").toString("base64url");
}

export function decodeCursor<T>(cursorStr: string, schema: z.ZodSchema<T>): T {
  try {
    const json = Buffer.from(cursorStr, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    return schema.parse(parsed);
  } catch (err: any) {
    const error: any = new Error("Invalid pagination cursor format or corrupted payload");
    error.status = 400;
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

// Cursors
export const timeAndIdCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.number().int().positive(),
});
export type TimeAndIdCursor = z.infer<typeof timeAndIdCursorSchema>;

export const idCursorSchema = z.object({
  id: z.number().int().positive(),
});
export type IdCursor = z.infer<typeof idCursorSchema>;

// Distributed rate limiter for expensive queries and reports
export { adminExportsLimiter as expensiveReportsLimiter } from "./rate-limiter";

// Zod query schemas for endpoints
export const bookingsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "Limit must be a valid number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
      .default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().trim().optional(),
    format: z.enum(["cursor", "array"]).optional(),
    status: z.enum(["Pending", "Approved", "Cancelled", "Completed"]).optional(),
    stationId: z.coerce.number().int().positive().optional(),
    userId: z.coerce.number().int().positive().optional(),
    fromDate: z.coerce.date().optional(),
    toDate: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        return data.fromDate.getTime() <= data.toDate.getTime();
      }
      return true;
    },
    {
      message: "fromDate must be earlier than or equal to toDate",
      path: ["fromDate"],
    }
  )
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        const diffDays = (data.toDate.getTime() - data.fromDate.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays <= MAX_BOOKINGS_DATE_RANGE_DAYS;
      }
      return true;
    },
    {
      message: `Date range cannot exceed ${MAX_BOOKINGS_DATE_RANGE_DAYS} days`,
      path: ["toDate"],
    }
  );

export const usersQuerySchema = z.object({
  limit: z.coerce
    .number({ invalid_type_error: "Limit must be a valid number" })
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().trim().optional(),
  format: z.enum(["cursor", "array"]).optional(),
  role: z.enum(["member", "employee", "admin"]).optional(),
  membershipTier: z.string().max(50).optional(),
});

export const auditLogsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "Limit must be a valid number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
      .default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().trim().optional(),
    format: z.enum(["cursor", "array"]).optional(),
    userId: z.coerce.number().int().positive().optional(),
    action: z.string().max(100).optional(),
    fromDate: z.coerce.date().optional(),
    toDate: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        return data.fromDate.getTime() <= data.toDate.getTime();
      }
      return true;
    },
    {
      message: "fromDate must be earlier than or equal to toDate",
      path: ["fromDate"],
    }
  )
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        const diffDays = (data.toDate.getTime() - data.fromDate.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays <= MAX_DATE_RANGE_DAYS;
      }
      return true;
    },
    {
      message: `Audit log date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
      path: ["toDate"],
    }
  );

export const stationsQuerySchema = z.object({
  limit: z.coerce
    .number({ invalid_type_error: "Limit must be a valid number" })
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().trim().optional(),
  format: z.enum(["cursor", "array"]).optional(),
  gameTypeId: z.coerce.number().int().positive().optional(),
  status: z.enum(["Available", "Occupied", "Maintenance"]).optional(),
});

export const gamesQuerySchema = z.object({
  limit: z.coerce
    .number({ invalid_type_error: "Limit must be a valid number" })
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().trim().optional(),
  format: z.enum(["cursor", "array"]).optional(),
  genre: z.string().max(50).optional(),
  platform: z.string().max(50).optional(),
});

export const exportQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "Limit must be a valid number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(500, "Export batch limit cannot exceed 500 records")
      .default(250),
    cursor: z.string().trim().optional(),
    format: z.enum(["csv", "json"]).default("csv"),
    status: z.enum(["Pending", "Approved", "Cancelled", "Completed"]).optional(),
    stationId: z.coerce.number().int().positive().optional(),
    fromDate: z.coerce.date().optional(),
    toDate: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        return data.fromDate.getTime() <= data.toDate.getTime();
      }
      return true;
    },
    {
      message: "fromDate must be earlier than or equal to toDate",
      path: ["fromDate"],
    }
  )
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        const diffDays = (data.toDate.getTime() - data.fromDate.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays <= MAX_DATE_RANGE_DAYS;
      }
      return true;
    },
    {
      message: `Export date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
      path: ["toDate"],
    }
  );

export const reportsQuerySchema = z
  .object({
    limit: z.coerce
      .number({ invalid_type_error: "Limit must be a valid number" })
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(MAX_PAGE_LIMIT, `Limit cannot exceed ${MAX_PAGE_LIMIT}`)
      .default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().trim().optional(),
    format: z.enum(["cursor", "array"]).optional(),
    stationId: z.coerce.number().int().positive().optional(),
    status: z.enum(["Pending", "Approved", "Cancelled", "Completed"]).optional(),
    fromDate: z.coerce.date().optional(),
    toDate: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        return data.fromDate.getTime() <= data.toDate.getTime();
      }
      return true;
    },
    {
      message: "fromDate must be earlier than or equal to toDate",
      path: ["fromDate"],
    }
  )
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        const diffDays = (data.toDate.getTime() - data.fromDate.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays <= MAX_DATE_RANGE_DAYS;
      }
      return true;
    },
    {
      message: `Report date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
      path: ["toDate"],
    }
  );

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export function paginateItems<T>(
  fetchedRows: T[],
  limit: number,
  extractCursorData: (lastItem: T) => any
): PaginatedResult<T> {
  const hasMore = fetchedRows.length > limit;
  const items = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
  const nextCursor = hasMore && items.length > 0 ? encodeCursor(extractCursorData(items[items.length - 1])) : null;

  return {
    items,
    nextCursor,
    hasMore,
    limit,
  };
}

export function sendPaginatedResponse<T>(
  req: Request,
  res: Response,
  result: PaginatedResult<T>
) {
  // Always include standard cursor pagination headers
  res.setHeader("X-Next-Cursor", result.nextCursor || "");
  res.setHeader("X-Has-More", String(result.hasMore));
  res.setHeader("X-Pagination-Limit", String(result.limit));

  // Determine whether to return cursor envelope or backward-compatible array
  // If the query explicitly provided cursor, format=cursor, or requested limit, return cursor envelope.
  const isExplicitPagination =
    req.query.cursor !== undefined ||
    req.query.format === "cursor" ||
    req.query.limit !== undefined ||
    req.query.paginate === "true";

  if (isExplicitPagination && req.query.format !== "array") {
    return res.json(result);
  }

  // Return items array for direct compatibility with React hooks and unparameterized test calls
  return res.json(result.items);
}
