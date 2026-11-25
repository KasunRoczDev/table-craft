import { z } from "@table-craft/plugin-api";
import {
  FETCH_ALL_CAP_RANGE,
  PAGE_ROWS_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
} from "@table-craft/desktop/settings/settings.js";

/** The fields every request schema shares, in `requests.ts` and `streamRequests.ts`. */
export const requestId = z.number().int().nonnegative();
export const sessionId = z.string().min(1);
export const paging = {
  pageRows: z.number().int().min(PAGE_ROWS_RANGE.min).max(PAGE_ROWS_RANGE.max),
  fetchAllCap: z.number().int().min(FETCH_ALL_CAP_RANGE.min).max(FETCH_ALL_CAP_RANGE.max),
  limitInSql: z.boolean().optional(),
};
const timeoutSeconds = z
  .number()
  .int()
  .min(STATEMENT_TIMEOUT_SECONDS_RANGE.min)
  .max(STATEMENT_TIMEOUT_SECONDS_RANGE.max)
  .optional();
export const statementLimit = { timeoutSeconds, serverEnforced: z.boolean().optional() };
/** 2^64 has 20 digits: no revision, lease ID or count is longer. */
export const DECIMAL_MAX_LENGTH = 20;
export const index = z.number().int().nonnegative();
export const leaseId = z
  .string()
  .regex(/^-?[1-9][0-9]*$/)
  .max(DECIMAL_MAX_LENGTH);
export const keyName = z.strictObject({
  text: z.string(),
  hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/)
    .nullable(),
});
