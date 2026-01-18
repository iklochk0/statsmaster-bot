export function requirePin(req: Request): string | null {
  const expected = process.env.ADMIN_PIN || "";
  if (!expected) return null;
  const got = req.headers.get("x-admin-pin") || "";
  if (got === expected) return null;
  return "Invalid PIN";
}
