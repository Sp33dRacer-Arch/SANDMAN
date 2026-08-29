import { app } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { releaseExpiredCheckoutReservations } from './services/checkout-reservation.service';

const server = app.listen(env.PORT, () => {
  console.log(`SANDMAN API running on ${env.API_URL} (port ${env.PORT})`);
  void releaseExpiredCheckoutReservations().catch(error => console.error('Initial checkout reservation cleanup failed', error));
});

const reservationCleanupTimer = setInterval(() => {
  void releaseExpiredCheckoutReservations().catch(error => console.error('Checkout reservation cleanup failed', error));
}, 5 * 60_000);

async function shutdown(signal: string) {
  console.log(`${signal} received. Shutting down SANDMAN...`);
  clearInterval(reservationCleanupTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
