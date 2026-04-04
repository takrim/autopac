import { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";

/**
 * Middleware to verify Firebase Auth token from Authorization header.
 * Attaches decoded token to req.user.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    (req as any).user = decoded;
    next();
  } catch (err) {
    logger.warn("[AUTH] Invalid token", { error: String(err) });
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
