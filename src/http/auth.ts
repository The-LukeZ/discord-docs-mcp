const encoder = new TextEncoder();

const sha256 = async (s: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));

/**
 * Whether an `Authorization` header carries `Bearer <token>`. The comparison hashes both sides first, so the
 * inputs have equal length and the compare time does not depend on where they differ or how long the supplied
 * value is. An unset or empty configured token never matches anything.
 */
export async function isAuthorized(header: string | null | undefined, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const [a, b] = await Promise.all([sha256(supplied), sha256(token)]);
  return crypto.subtle.timingSafeEqual(a, b) && supplied.length > 0;
}
