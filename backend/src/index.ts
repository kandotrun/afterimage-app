import { cleanupExpiredState, createApp, pollTranscriptions } from "./app";
import { processPendingAccountDeletions } from "./account-deletion";

const app = createApp();

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  scheduled(controller, env, context) {
    const time = new Date(controller.scheduledTime);
    if (controller.cron === "17 3 * * *") {
      context.waitUntil(Promise.all([
        cleanupExpiredState(env, time),
        processPendingAccountDeletions(env, time),
      ]));
    } else {
      context.waitUntil(Promise.all([
        pollTranscriptions(env, time),
        processPendingAccountDeletions(env, time),
      ]));
    }
  },
} satisfies ExportedHandler<Env>;
