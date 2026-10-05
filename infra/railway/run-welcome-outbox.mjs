import {processWelcomeOutbox} from './resend-outbox.mjs';
// Finite cron execution: one claim batch, no server, no idle loop and no PII log.
try {
  console.log(JSON.stringify(await processWelcomeOutbox({limit: 1})));
} catch {
  console.error('Transactional welcome worker stopped safely; inspect its protected queue.');
  process.exitCode = 1;
}
