import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ActorResolver } from '../auth/actor-resolver';

/** The Swagger UI page, its assets and the document, whatever the format. */
export const DOCS_PATHS = ['/api/docs', '/api/docs-json', '/api/docs-yaml'];

/**
 * SWAGGER=superadmin: only a SUPERADMIN session or API token sees the docs. Everyone else gets
 * the 404 of a route that does not exist, so the docs' presence is not revealed either.
 */
export function docsAccess(resolver: ActorResolver): RequestHandler {
  // a failing lookup (Redis or Postgres down) hides the docs as well
  const isSuperadmin = (req: Request): Promise<boolean> =>
    resolver
      .resolve(req)
      .then((actor) => actor?.role === 'SUPERADMIN')
      .catch(() => false);

  return (req: Request, res: Response, next: NextFunction): void => {
    void isSuperadmin(req).then((allowed) => {
      if (allowed) {
        next();
        return;
      }
      res.status(404).json({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Cannot ${req.method} ${req.path}`,
      });
    });
  };
}
