import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';

import { assertPortAvailable, percentile } from './scaffoldBenchUtils.mjs';

const HOST = '127.0.0.1';

function listenOnAvailablePort(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, HOST, () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('Unable to determine test listener port.'));
        return;
      }

      resolvePromise(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
        return;
      }

      rejectPromise(error);
    });
  });
}

describe('percentile', () => {
  it('interpolates between adjacent sorted samples', () => {
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(32.5);
  });

  it('rejects an empty sample set', () => {
    expect(() => percentile([], 0.5)).toThrow('without frame samples');
  });
});

describe('assertPortAvailable', () => {
  it('refuses an occupied port without closing its listener', async () => {
    const externalServer = createServer();
    const occupiedPort = await listenOnAvailablePort(externalServer);

    try {
      await expect(assertPortAvailable(occupiedPort, HOST)).rejects.toThrow(
        `Benchmark preview port ${String(occupiedPort)} is occupied`,
      );
      expect(externalServer.listening).toBe(true);
    } finally {
      await closeServer(externalServer);
    }
  });
});
