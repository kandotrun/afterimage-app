const supportContact = "kan@2-38.com";

const pages = {
  privacy: {
    title: "Privacy Policy",
    body: `
      <p>Effective July 30, 2026. Afterimage is a private lifelog service.</p>
      <h2>Data categories and purpose</h2>
      <p>Afterimage processes account identifiers, name and email supplied by Sign in with Apple, photos or videos already stored for existing timelines, new video and audio, capture time, precise location when you choose to record it, transcripts, visual analysis, daily summaries, weather snapshots, and support communications. We use this data to authenticate you, store and play your private memories, search them, create optional summaries, provide weather context, secure the service, and respond to support requests.</p>
      <h2>Optional external AI and agent access</h2>
      <p>External AI is off until you give versioned consent. With active consent, Soniox may receive video or audio to create transcripts. Alibaba Cloud Qwen may receive transcript and visual-analysis text to create daily summaries. Mage-VL processing may retrieve consented video to produce visual analysis and requested derivatives. An MCP client or agent can retrieve only videos you separately enable. You can withdraw consent at any time; withdrawal stops new external-AI work and MCP access.</p>
      <h2>Retention and deletion</h2>
      <p>Private media and metadata remain until you delete an asset or your account. Existing transcripts and visual analysis are retained after consent withdrawal so they remain available inside your private account, and are deleted with the related asset or account. Temporary grants and derivatives expire. Account deletion removes owned database records and private objects and requests cleanup from processors and Apple; transient processor failures are retried from a durable deletion request.</p>
      <h2>Contact</h2>
      <p>Privacy and support questions: <a href="mailto:${supportContact}">${supportContact}</a>.</p>
    `,
  },
  support: {
    title: "Support",
    body: `
      <p>For help with sign-in, private uploads, playback, optional AI consent, consent withdrawal, MCP access, or account deletion, email <a href="mailto:${supportContact}">${supportContact}</a>.</p>
      <p>Include the problem, approximate time, app version, and iOS version. Do not send identity tokens, bearer tokens, private videos, Apple authorization codes, or other secrets.</p>
    `,
  },
  terms: {
    title: "Terms of Service",
    body: `
      <p>Effective July 30, 2026. Afterimage is provided for personal private-lifelog use. You are responsible for content you capture and for obtaining permission where required.</p>
      <p>Do not misuse the service, attempt unauthorized access, evade quotas, or upload unlawful content. Optional external-AI and MCP features require explicit consent and may be withdrawn. You may delete individual memories or request account deletion from the app.</p>
      <p>Questions about these terms: <a href="mailto:${supportContact}">${supportContact}</a>.</p>
    `,
  },
} as const;

export type LegalPage = keyof typeof pages;

export function legalPageResponse(page: LegalPage): Response {
  const content = pages[page];
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${content.title} · Afterimage</title>
  <style>body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1.25rem;color:#171717}h1,h2{line-height:1.2}a{color:#174ea6}</style>
</head>
<body>
  <main>
    <h1>Afterimage ${content.title}</h1>
    ${content.body}
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
