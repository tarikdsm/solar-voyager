import { createServer } from 'node:net';

export function assertPortAvailable(port, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probeServer = createServer();

    probeServer.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        rejectPromise(
          new Error(`Benchmark preview port ${String(port)} is occupied at ${host}.`, {
            cause: error,
          }),
        );
        return;
      }

      rejectPromise(error);
    });
    probeServer.listen(port, host, () => {
      probeServer.close((error) => {
        if (error === undefined) {
          resolvePromise();
          return;
        }

        rejectPromise(error);
      });
    });
  });
}

export function percentile(sortedValues, fraction) {
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error('Cannot calculate a percentile without frame samples.');
  }

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}
