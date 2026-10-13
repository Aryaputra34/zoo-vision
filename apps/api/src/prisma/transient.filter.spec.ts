import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { TransientDbFilter } from './transient.filter';

describe('TransientDbFilter', () => {
  const host = {} as ArgumentsHost;
  const setup = () => {
    const reply = jest.fn();
    const filter = new TransientDbFilter();
    Object.assign(filter, {
      httpAdapterHost: { httpAdapter: { reply } } as unknown as HttpAdapterHost,
    });
    return { filter, reply };
  };

  it('maps a transient database error to 503 without its text', () => {
    const { filter, reply } = setup();
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'P1001',
    });
    const res = {};
    const h = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;

    filter.catch(err, h);
    error.mockRestore();

    expect(reply).toHaveBeenCalledWith(
      res,
      { statusCode: 503, message: 'Service unavailable' },
      503,
    );
  });

  it('logs a transient error once with its code and message, and still answers 503', () => {
    const { filter, reply } = setup();
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'P1001',
    });
    const res = {};
    const h = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;

    filter.catch(err, h);

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toBe(
      'database unavailable (P1001): connect ECONNREFUSED 10.0.0.5:5432',
    );
    expect(reply).toHaveBeenCalledWith(
      res,
      { statusCode: 503, message: 'Service unavailable' },
      503,
    );
    error.mockRestore();
  });

  it('leaves other errors to Nest', () => {
    const { filter, reply } = setup();
    const err = new BadRequestException('nope');
    // BaseExceptionFilter handles it via the adapter; here we only check we did not answer 503
    const spy = jest
      .spyOn(
        Object.getPrototypeOf(TransientDbFilter.prototype) as {
          catch: () => void;
        },
        'catch',
      )
      .mockImplementation(() => undefined);
    filter.catch(err, host);
    expect(spy).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
