# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email
`kan@2-38.com` with the subject `Afterimage security report` and include:

- the affected component and commit;
- the smallest reproducible description;
- expected impact;
- any mitigation you already tested.

Do not send real lifelog media, bearer tokens, Apple authorization material,
provider payloads, private URLs, or user identifiers. Use synthetic fixtures
and redact credentials. If a minimal report still requires sensitive material,
ask for a safe transfer method first.

We will acknowledge and investigate reports as availability permits. Please do
not publicly disclose an unresolved issue or access data that is not yours.

## Supported version

Security fixes target the current `main` branch. Older commits, forks, and
third-party deployments are not maintained by this repository.

## Deployment responsibility

A public source tree is not a security boundary. Operators are responsible for
separate Cloudflare and Apple resources, least-privilege credentials, private
R2 buckets, secret rotation, provider agreements, logging hygiene, backups,
and legal compliance. Never reuse the example identifiers or development
sessions as production credentials.
