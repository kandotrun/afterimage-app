import { cleanupExpiredState, createApp } from "./app";

const app = createApp();

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  scheduled(controller, env, context) {
    context.waitUntil(cleanupExpiredState(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
