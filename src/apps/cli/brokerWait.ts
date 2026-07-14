import type { Delivery, DeliverySubscription } from '@app/ports/gateway.ts';

export async function nextDelivery(subscription: DeliverySubscription, timeoutSec: number): Promise<Delivery | undefined> {
  const next = subscription.deliveries[Symbol.asyncIterator]().next();
  if (timeoutSec === Infinity) return (await next).value;
  return new Promise<Delivery | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutSec * 1000));
    void next.then((result) => { clearTimeout(timer); resolve(result.value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** F14 boundary: stdout write callback (flush to OS) completes before durable ack. */
export async function printDeliveryThenAck(
  delivery: Delivery,
  subscription: DeliverySubscription,
  write: (text: string) => Promise<void> = writeStdout,
): Promise<void> {
  await write(`${'='.repeat(66)}\nINCOMING ${delivery.message.name}\n${'-'.repeat(66)}\n${delivery.message.raw}\n`);
  await subscription.ack(delivery.deliveryId);
}

const writeStdout = (text: string) => new Promise<void>((resolve, reject) => {
  process.stdout.write(text, (error) => error ? reject(error) : resolve());
});
