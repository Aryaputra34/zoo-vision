import type { Request } from 'express';
import type { RequestMeta } from './auth.service';

export const requestMeta = (req: Request): RequestMeta => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});
