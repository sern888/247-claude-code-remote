/**
 * Resolve the signed-in user's id, or null when the request is unauthenticated.
 * The auth module is imported lazily so builds without auth env vars keep working.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const { neonAuth } = await import('@neondatabase/auth/next/server');
  const { user } = await neonAuth();
  return user?.id ?? null;
}
