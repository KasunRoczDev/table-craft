import { z } from "@table-craft/plugin-api";
import {
  SEARCH_FIELDS_MAX,
  SEARCH_HISTOGRAM_MAX_BUCKETS,
  SEARCH_NAME_MAX_LENGTH,
  SEARCH_PAGE_LIMIT,
  SEARCH_QUERY_LANGUAGES,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_SORT_MAX,
} from "@table-craft/desktop/engine/protocol.js";
import { paging, requestId, sessionId, statementLimit } from "@table-craft/desktop/engine/requestParts.js";

const name = z.string().min(1).max(SEARCH_NAME_MAX_LENGTH);
const instant = z.iso.datetime({ offset: true }).nullable();

const searchRequest = z.strictObject({
  target: name,
  language: z.enum(SEARCH_QUERY_LANGUAGES),
  query: z.string().max(SEARCH_QUERY_MAX_LENGTH),
  sort: z.array(z.strictObject({ field: name, order: z.enum(["asc", "desc"]) })).max(SEARCH_SORT_MAX),
  time: z.strictObject({ field: name, from: instant, to: instant }).nullable(),
  fields: z.array(name).max(SEARCH_FIELDS_MAX).nullable(),
  pageSize: z.number().int().min(1).max(SEARCH_PAGE_LIMIT),
});

/** The `indices.*` requests (plan 165), spread into `engineRequestSchema`. */
export const INDEX_REQUESTS = [
  z.strictObject({ id: requestId, type: z.literal("indices.list") }),
  z.strictObject({ id: requestId, type: z.literal("indices.describe"), target: name }),
  z.strictObject({
    id: requestId,
    type: z.literal("indices.open"),
    sessionId,
    request: searchRequest,
    ...paging,
    ...statementLimit,
  }),
  z.strictObject({ id: requestId, type: z.literal("indices.count"), request: searchRequest }),
  z.strictObject({
    id: requestId,
    type: z.literal("indices.histogram"),
    request: searchRequest,
    buckets: z.number().int().min(1).max(SEARCH_HISTOGRAM_MAX_BUCKETS),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("indices.analyze"),
    request: z.strictObject({
      target: name,
      field: name.nullable(),
      analyzer: name.nullable(),
      text: z.string().max(SEARCH_QUERY_MAX_LENGTH),
    }),
  }),
] as const;
