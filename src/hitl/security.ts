import type { Request, Response, NextFunction, RequestHandler } from 'express';

type Role = 'owner' | 'admin' | 'moderator' | 'operator' | 'viewer';

export function requireRole(min: Role): RequestHandler {
  const order: Role[] = ['viewer', 'operator', 'moderator', 'admin', 'owner'];
  return (req: Request & { user?: any }, res: Response, next: NextFunction) => {
    const role: Role = (req.user?.role as Role) || 'owner';
    if (order.indexOf(role) < order.indexOf(min)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
