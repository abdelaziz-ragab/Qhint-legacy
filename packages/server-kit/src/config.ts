import type { z } from 'zod';

/**
 * Parse environment variables against a zod schema. On failure, the error lists only the
 * variable names that are missing or invalid, never their values (which may be secrets).
 */
export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '?')))];
    throw new Error(`invalid configuration: check ${names.join(', ')}`);
  }
  return result.data;
}

/** True when running on Cloud Run. */
export const onCloudRun = (env: Record<string, string | undefined> = process.env) =>
  Boolean(env.K_SERVICE);
