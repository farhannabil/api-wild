import {processWelcomeOutbox} from './resend-outbox.mjs';
// Finite cron execution: one claim batch, no server, no idle loop and no PII log.
try {
  // This deployment is API WILD only. The SQL claim filters before reserving
  // any queue row or daily attempt; an AARO row is never claimed then discarded.
  console.log(JSON.stringify(await processWelcomeOutbox({limit: 1,env:{...process.env,WELCOME_BRAND:'apiwild'}})));
} catch {
  console.error('Transactional welcome worker stopped safely; inspect its protected queue.');
  process.exitCode = 1;
}
