import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from '../src/web/auth.js';

// Mock the logger
vi.mock('../src/core/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function mockReq(method: string, path: string, authHeader?: string): Partial<Request> {
  return {
    method,
    path,
    ip: '127.0.0.1',
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

function mockRes(): Partial<Response> & { _status: number; _body: unknown } {
  const res: any = { _status: 200, _body: null };
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  return res;
}

describe('createAuthMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('GET requests pass without auth', () => {
    const mw = createAuthMiddleware(() => 'my-secret');
    const req = mockReq('GET', '/api/status');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('POST rejected without auth when secret is set', () => {
    const mw = createAuthMiddleware(() => 'my-secret');
    const req = mockReq('POST', '/api/trade');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res._body).toHaveProperty('error');
  });

  it('POST accepted with correct bearer token', () => {
    const mw = createAuthMiddleware(() => 'my-secret');
    const req = mockReq('POST', '/api/trade', 'Bearer my-secret');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('POST rejected with wrong token', () => {
    const mw = createAuthMiddleware(() => 'my-secret');
    const req = mockReq('POST', '/api/trade', 'Bearer wrong-token');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res._body).toHaveProperty('error');
  });

  it('POST allowed when no secret configured', () => {
    const mw = createAuthMiddleware(() => undefined);
    const req = mockReq('POST', '/api/trade');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('POST allowed when secret is empty string (via getter returning undefined)', () => {
    const mw = createAuthMiddleware(() => undefined);
    const req = mockReq('POST', '/api/settings');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('PUT rejected without auth when secret is set', () => {
    const mw = createAuthMiddleware(() => 'secret123');
    const req = mockReq('PUT', '/api/assets/0x123/config');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('DELETE rejected without auth when secret is set', () => {
    const mw = createAuthMiddleware(() => 'secret123');
    const req = mockReq('DELETE', '/api/watchlist/BTC');
    const res = mockRes();

    mw(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
