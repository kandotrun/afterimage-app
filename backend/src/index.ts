import { cleanupExpiredState, createApp, pollTranscriptions } from "./app";

const app = createApp();

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  scheduled(controller, env, context) {
    const time = new Date(controller.scheduledTime);
    if (controller.cron === "17 3 * * *") {
      context.waitUntil(cleanupExpiredState(env, time));
    } else {
      context.waitUntil(pollTranscriptions(env, time));
    }
  },
} satisfies ExportedHandler<Env>;
