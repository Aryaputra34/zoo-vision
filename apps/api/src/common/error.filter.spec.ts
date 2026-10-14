import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { apiError, type ApiErrorBody } from './errors';
import { ErrorFilter } from './error.filter';

describe('ErrorFilter', () => {
  const res = {};
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', url: '/api/v1/x' }),
    }),
  } as unknown as ArgumentsHost;

  const setup = () => {
    const reply = jest.fn<void, [unknown, ApiErrorBody, number]>();
    const filter = new ErrorFilter({
      httpAdapter: { reply },
    } as unknown as HttpAdapterHost);
    const body = (): ApiErrorBody => reply.mock.calls[0][1];
    const status = (): number => reply.mock.calls[0][2];
    return { filter, reply, body, status };
  };

  let error: jest.SpyInstance<void, [unknown, ...unknown[]]>;
  beforeEach(() => {
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('a transient Prisma error → 503 UNAVAILABLE, one log line with the driver text, none in the body', () => {
    const { filter, reply, body, status } = setup();
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'P1001',
    });

    filter.catch(err, host);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(status()).toBe(503);
    expect(body()).toEqual({
      statusCode: 503,
      code: 'UNAVAILABLE',
      message: 'Service temporarily unavailable',
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toBe(
      'database unavailable (P1001): connect ECONNREFUSED 10.0.0.5:5432',
    );
  });

  it('a response whose headers are out (a half-streamed file) is cut, not answered with JSON', () => {
    const { filter, reply } = setup();
    const sent = { headersSent: true, destroy: jest.fn() };
    const sentHost = {
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => sent,
        getRequest: () => ({
          method: 'GET',
          url: '/api/v1/exports/events.csv',
        }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new Error('connection terminated'), sentHost);

    expect(reply).not.toHaveBeenCalled();
    expect(sent.destroy).toHaveBeenCalledTimes(1);
    // the cause still reaches the log
    expect(String(error.mock.calls[0]?.[0])).toContain('connection terminated');
  });

  it('an error in a WebSocket handler is logged and left to the WebSocket filter, not answered as HTTP', () => {
    const { filter, reply } = setup();
    const emit = jest.fn();
    const client = { emit };
    const wsHost = {
      getType: () => 'ws',
      switchToHttp: () => ({
        getResponse: () => client,
        getRequest: () => ({}),
      }),
      switchToWs: () => ({
        getClient: () => client,
        getData: () => ({}),
        getPattern: () => 'subscribe',
      }),
      getArgs: () => [client, {}],
      getArgByIndex: (i: number) => [client, {}][i],
    } as unknown as ArgumentsHost;

    filter.catch(new Error('join failed'), wsHost);

    expect(reply).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain('join failed');
  });

  it('an unknown Error → 500 INTERNAL whose body does not carry its text, and the stack is logged', () => {
    const { filter, body, status } = setup();

    filter.catch(new Error('db password leaked'), host);

    expect(status()).toBe(500);
    expect(body()).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Internal error',
    });
    expect(JSON.stringify(body())).not.toContain('leaked');
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).toContain('db password leaked');
  });

  it('an apiError keeps its status, code, message and errors', () => {
    const { filter, body, status } = setup();

    filter.catch(
      apiError(409, 'STALE_VERSION', 'x', [{ path: '/a', message: 'm' }]),
      host,
    );

    expect(status()).toBe(409);
    expect(body()).toEqual({
      statusCode: 409,
      code: 'STALE_VERSION',
      message: 'x',
      errors: [{ path: '/a', message: 'm' }],
    });
  });

  it('a plain HttpException gets the code of its status and its string message', () => {
    const { filter, body, status } = setup();

    filter.catch(new NotFoundException('Camera not found'), host);

    expect(status()).toBe(404);
    expect(body()).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Camera not found',
    });
  });

  it('an HttpException with a message array → its first message', () => {
    const { filter, body } = setup();

    filter.catch(new BadRequestException(['a must be x', 'b must be y']), host);

    expect(body()).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'a must be x',
    });
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [413, 'TOO_LARGE'],
    [423, 'ACCOUNT_LOCKED'],
    [429, 'RATE_LIMITED'],
    [405, 'BAD_REQUEST'],
    [502, 'INTERNAL'],
  ])('HttpException status %i → code %s', (code, expected) => {
    const { filter, body, status } = setup();

    filter.catch(new HttpException('m', code), host);

    expect(status()).toBe(code);
    expect(body().code).toBe(expected);
  });

  it.each([
    [
      'MaxRetriesPerRequestError',
      'Reached the max retries per request limit (which is 2).',
    ],
    ['Error', 'Command timed out'],
    ['Error', 'Connection is closed.'],
  ])(
    'an ioredis %s "%s" → 503 UNAVAILABLE, logged, without its text in the body',
    (name, text) => {
      const { filter, body, status } = setup();
      const err = Object.assign(new Error(text), { name });

      filter.catch(err, host);

      expect(status()).toBe(503);
      expect(body()).toEqual({
        statusCode: 503,
        code: 'UNAVAILABLE',
        message: 'Service temporarily unavailable',
      });
      expect(String(error.mock.calls[0]?.[0])).toBe(
        `redis unavailable: ${text}`,
      );
    },
  );

  it('a body-parser error (status 400, text from the parser) → 400 BAD_REQUEST without the parser text', () => {
    const { filter, body, status } = setup();
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    filter.catch(err, host);

    expect(status()).toBe(400);
    expect(body()).toEqual({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Malformed request body',
    });
  });

  it('a body-parser size error (status 413) → 413 TOO_LARGE', () => {
    const { filter, body, status } = setup();
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    filter.catch(err, host);

    expect(status()).toBe(413);
    expect(body().code).toBe('TOO_LARGE');
  });
});
