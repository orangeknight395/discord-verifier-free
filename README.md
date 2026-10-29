# Discord verification — free cloud edition

This version is designed for **Cloudflare Workers Free + D1 Free**, using Discord's HTTP interactions. Your Mac can be off. Setup uses the Cloudflare, GitHub and Discord websites; you do not need Python, Node, Docker, Git or Terminal installed on your Mac.

**Use this edition for the $0 requirement. It replaces the earlier Render/Python hosting recommendation.** Do not deploy the paid Render blueprint. No service has been deployed on your behalf.

## What “free” means

Stay on **Workers Free**, use **D1 on the Free plan**, and use the supplied `workers.dev` address. This implementation requires no R2 bucket, paid database, domain purchase, server subscription or free-trial credit. It does not contain any operation that upgrades a billing plan.

Current free limits include 100,000 Worker requests/day and 10 ms of CPU per invocation. Network waiting is not CPU time. D1 includes 5 million rows read/day, 100,000 rows written/day and 5 GB total storage across the account; individual-database and other platform limits also apply. When free request/database limits are exhausted, operations fail until limits reset or capacity is freed. Remaining on the Free plan avoids automatic usage charges from these services. These limits apply across the account, including other projects. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 pricing and limit behavior](https://developers.cloudflare.com/d1/platform/pricing/)

There is no promise of unlimited usage, uninterrupted service, or unchanged provider terms forever. The bot defaults to 100 attempts per rolling day across the server, 25 open requests, three attempts/member/hour and one upload up to 4 MiB. These conservative app limits help keep use modest; they do not guarantee that every request fits the provider's CPU budget. Invalid public HTTP traffic also consumes platform requests. Monitor usage and CPU failures; reduce upload size if needed, rather than upgrading to a paid plan. The free quotas may delay reviews, recovery, notifications and evidence deletion.

Cloudflare's free services are not a sleeping container. Discord invokes the Worker when someone uses a command, dropdown, modal or button; a scheduled invocation performs cleanup and recovery. The bot may show **offline** in Discord's member list because it has no Gateway presence connection. Its commands and buttons still work.

## Workflow

1. A member runs `/verify`, receives a private dropdown and chooses an allowlisted role.
2. A modal asks for one image or video. It is not posted to the public channel.
3. The Worker validates the upload, then copies it into the private review channel as a spoiler attachment. The configured reviewer roles are mentioned.
4. A current holder of a configured reviewer role uses **Approve** or **Deny**. Self-review is prohibited. Approval grants only the selected role; denial does not grant or remove roles.
5. The database stores the decision before the role change. The first reviewer decision wins.
6. Maintenance updates the review card and sends a best-effort DM. `/verification_status` privately shows the member's latest request even if DMs are blocked. `/verification_cancel` withdraws a pending request.

See [SETUP.md](SETUP.md) for the browser-only deployment steps.

## Permissions

Use a dedicated Discord application/bot. Install it to your server with `bot` and `applications.commands` scopes. Give the bot **Manage Roles** and move its highest role above every selectable role. Do not give it Administrator. Selectable roles must be ordinary membership/access roles, not managed roles, `@everyone`, reviewer roles or administrative/moderation roles.

Create a private text channel with these explicit overwrites:

| Principal | Channel access |
| --- | --- |
| `@everyone` | Deny View Channel |
| Each configured reviewer role | Allow View Channel and Read Message History |
| The bot **member** directly | Allow View Channel, Send Messages, Read Message History, Embed Links, Attach Files |
| Other roles and members | No explicit Allow View Channel |

The validator requires the bot's member overwrite rather than a bot-role allow. Reviewer Send Messages permission is optional. Grant regular members Use Application Commands in the channel where they start `/verify`.

Make reviewer roles mentionable if you want their members to receive role pings; their notification settings may still suppress alerts. The bot does not need Mention Everyone. Server owners and administrators can see the evidence because they bypass channel privacy, but a reviewer role is still required to use the bot's decision buttons.

Leave privileged gateway intents off. Unlike the earlier Python edition, this edition **requires an Interactions Endpoint URL** in the Discord Developer Portal. Do not run both implementations on the same bot token.

## Persistent state and recovery

D1 stores request, member, role and review-message IDs; timestamps; reviewer and decision; and maintenance flags. An installation record binds the database to one application, server and review channel. Request IDs are Discord interaction IDs. Unique indexes prevent simultaneous open requests for the same member. Atomic SQL updates prevent conflicting decisions; short database leases prevent concurrent maintenance from doing the same job.

| State | Meaning |
| --- | --- |
| `receiving` | Upload/download/delivery is underway, or an interrupted delivery is being reconciled |
| `pending` | Evidence is in the review channel and awaits a decision |
| `approving` | An approval decision is saved; the role change is pending confirmation or retry |
| `approved` / `denied` | Final human decision |
| `cancelled` / `expired` / `failed` | Request closed without granting a role |

Discord single-role PUTs are idempotent. A crash after a successful role grant is recovered by checking whether the role is already present. Ambiguous role writes remain `approving`; a denial cannot overwrite them. Each retry rechecks current role safety and the original reviewer's authorization before issuing a grant. If permissions are restored later, the reserved approval can complete then, even after evidence has expired. Administrators should resolve blocked approvals promptly. If a saved approval is no longer appropriate, stop this worker and reconcile that record deliberately before restarting; there is no automatic reversal of a saved approval.

Uploads are not saved in D1 or another paid file store. If an invocation ends after Discord accepted its review message but before D1 recorded the message ID, maintenance searches the dedicated channel for the unique request marker and adopts it. A nonce also reduces short-window duplicate sends. If no matching card is found, the request fails and the member must upload again. Signed source URLs and interaction tokens are not persisted for retries. An in-flight upload cannot be cancelled until it reaches `pending` or recovery completes.

The minute trigger handles **one due request per invocation** to bound free-plan work. Pending evidence is checked periodically; expiry is also checked immediately when a reviewer clicks. Card updates and DMs may take several minutes when there is a backlog. Deleted/missing evidence fails a pending request. Cleanup does not depend on successful DM delivery. Failed API operations retry without changing a denial into an approval. A crash immediately after sending a DM can cause a duplicate DM.

## Evidence and retention

Accepted types are PNG, JPEG, GIF, WebP, MP4, MOV and WebM. The Worker accepts only Discord modal attachments, limits streamed bytes, rejects arbitrary URLs and redirects, compares the declared and received sizes, and checks file signatures. It generates a new filename and restricts allowed mentions to configured reviewer roles. It does not execute, decode, extract, transcode or otherwise run the submitted media.

Signature checks are **not malware scanning, complete media validation, or proof of authenticity**. Malicious files can imitate media headers. Use Discord previews and avoid opening unknown downloads. This implementation is not an identity-document verification system; do not solicit passwords or government IDs through it.

Defaults:

- Pending requests expire after 7 days.
- The review message, including its attached evidence, is deleted 24 hours after a terminal outcome, plus maintenance/API delays.
- A stuck reserved approval loses its review evidence after its 7-day deadline but keeps the decision record for recovery.
- Completed metadata is removed after 30 days once evidence deletion succeeds. Failed deletion keeps the metadata and retries.

The attachment exists briefly in Worker memory, then in the private Discord review channel. The Worker stores no permanent file copy. Discord controls the original modal upload and infrastructure retention; deleting the bot's review message cannot guarantee erasure of all Discord copies or files downloaded by reviewers. D1 backups and provider retention may outlast a database deletion. Host operators, server administrators and authorized reviewers must be trusted. A CDN URL can be copied, so channel privacy is not end-to-end encryption.

Administrators must maintain the private-channel permissions. Checks block new uploads/reviews if broad access is detected, but cannot undo disclosure caused by later permission changes. If hosting quotas are exhausted or the trigger is removed, cleanup pauses. If you stop using this bot, remove retained review evidence before deleting the Worker/database.

## Operation and limits

Edit `CONFIG_JSON` in Cloudflare to change role labels, allowlisted IDs or limits. Keep application/server/review-channel IDs stable while requests remain in the database. Use a separate Worker, database and bot for a separate server. Do not edit active request rows casually or restore old backups over live decisions; old state can replay approvals.

Default `max_bytes` is 4,194,304 (4 MiB). Compress/trim videos to fit. The code permits at most 8 MiB, subject to Discord and free runtime limits; larger limits are not a promise of free runtime performance. Lower the limit if the host reports CPU errors. There is no bundled media converter or paid upload-storage fallback.

Operational messages contain request IDs and safe error descriptions. The code does not log tokens, signed attachment URLs, filenames, raw HTTP responses or media bytes. Keep the bot token and setup key in Cloudflare secrets, and rotate either if exposed. Cloudflare account access should be restricted to the operators who need it.

## Validation

35 automated tests pass using native Ed25519 verification, actual SQLite SQL behind a D1-shaped adapter, and mocked Discord HTTP responses. They cover private component payloads, unsafe requests, permission gates, evidence bounds, concurrent decisions, role assignment, denial, cancellation, expiry, recovery, cleanup and database isolation.

A developer can run them with Node 24 using `node --test tests/worker.test.mjs`; this is **not required on your Mac for deployment**. The Worker itself has no npm dependencies. This implementation uses Discord's REST/interaction API directly instead of a Gateway client such as discord.py or discord.js, allowing it to run on demand in the free Worker runtime.

No live Cloudflare deployment or Discord login has been performed. Local tests do not establish production CPU usage, provider availability or real-client behavior. Perform the live acceptance checks in SETUP.md before inviting members to use it.

## Official references

- [Discord HTTP interaction handling and signatures](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx)
- [Discord file-upload modal components](https://github.com/discord/discord-api-docs/blob/main/developers/components/reference.mdx)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare dashboard deployment](https://developers.cloudflare.com/workers/get-started/dashboard/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
