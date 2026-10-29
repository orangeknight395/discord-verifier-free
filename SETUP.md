# Browser-only setup, with $0 hosting

Use this free edition instead of the earlier Render package. You need Discord server-management access, a free Cloudflare account and a free GitHub account. Your Mac is only used as a browser; no terminal or permanent software installation is needed.

## 1. Prepare Discord

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Create its bot and invite it with the `bot` and `applications.commands` scopes. Follow the role hierarchy and private-channel permissions in [README.md](README.md).

From the application's General Information page, copy its **Application ID** and **Public Key**. From its Bot page, obtain the **Bot Token**. Keep the token private; it is different from the Public Key.

Enable Developer Mode in Discord's settings to copy your server ID, review-channel ID, reviewer-role IDs and selectable-role IDs. Fill those into a copy of `config.example.json`, preserving quotation marks around IDs. This JSON will go into a Cloudflare setting, not a source-code file containing credentials.

## 2. Create the free database

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Confirm your Workers subscription is **Free**. Do not activate Workers Paid, R2, a paid domain or a trial of a paid product for this project.
3. Find **D1** under storage/databases and create a database named `discord-verifier`.
4. Copy its database ID. No tables need to be entered manually; the setup page creates them later.

The database name is an identifier, not a password. If you already use a paid Workers account for something else, use a separate Free account for this bot rather than assuming its usage cannot be billed on the paid account.

## 3. Put the code in a private GitHub repository

1. Download/extract `discord-verifier-free.zip`. These are ordinary files, not an installer.
2. Create a private repository in [GitHub's website](https://github.com/new), for example `discord-verifier-free`.
3. Use **Add file → Upload files** to upload the contents of the extracted folder. Keep `index.mjs`, `worker.mjs`, `package.json` and `wrangler.jsonc` at the repository root, not inside an extra folder.
4. Edit `wrangler.jsonc` using GitHub's browser editor. Replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the ID copied from Cloudflare. Keep the database binding name exactly `DB`.
5. Commit the edit. Never upload a real bot token, setup key, `.env`, `.dev.vars` or submitted evidence.

## 4. Deploy the Worker in Cloudflare

1. In Cloudflare, open **Workers & Pages → Create application** and import your GitHub repository.
2. Authorize access to only the repository you need and choose its main branch.
3. Use worker name `discord-verifier-free`, matching the supplied configuration. No build step is required; the deployment command is `npx wrangler deploy` if the dashboard asks. That command runs on Cloudflare, not your Mac.
4. Deploy. The configuration provides the free `workers.dev` address, your D1 binding and a once-per-minute Cron Trigger.
5. In the Worker's settings, confirm the D1 binding **DB** points to your new database, and that a Cron Trigger exists for `* * * * *`. Also verify the compatibility date is `2026-10-27` or later.

Creating the Worker does not configure Discord yet. Initial scheduled errors about missing configuration can occur until the next step is complete. Cloudflare's labels can change; the official [dashboard guide](https://developers.cloudflare.com/workers/get-started/dashboard/) covers the import flow.

## 5. Add settings and secrets

In your Worker's **Settings → Variables and Secrets**, add:

| Name | Type | Value |
| --- | --- | --- |
| `APPLICATION_ID` | Text | Discord Application ID |
| `DISCORD_PUBLIC_KEY` | Text | Discord application's Public Key, as hexadecimal |
| `CONFIG_JSON` | Text | Complete edited contents of `config.example.json` |
| `DISCORD_TOKEN` | Secret | Discord bot token |
| `SETUP_KEY` | Secret | A new random password of at least 32 characters |

Use a password manager's generator for `SETUP_KEY`; save it temporarily so you can use the setup page. Do not use your Discord password or bot token as the setup key. Do not put secrets into GitHub, the Worker URL or this chat.

Save and deploy the updated settings. Keep the Workers subscription on **Free**. You can revoke/delete `SETUP_KEY` after successful setup to disable future command registration through that page; restore a new secret only when you need it again.

## 6. Register commands and connect Discord

1. Open your Worker's address with `/setup` appended, for example `https://discord-verifier-free.your-subdomain.workers.dev/setup`.
2. Enter **SETUP_KEY** into the form and register the commands. This initializes the database, verifies private-channel permissions and registers `/verify`, `/verification_status` and `/verification_cancel` in your configured server. Use a dedicated bot: registration replaces that application's server-specific command set.
3. If setup reports a permission error, fix the permissions in Discord and submit the setup form again.
4. In Discord Developer Portal → General Information, set the **Interactions Endpoint URL** to your Worker's address ending in `/interactions`.
5. Save. Discord checks the endpoint's signature handling and ping response. If it rejects the URL, verify the Application ID, Public Key, deployed settings and that no login/Cloudflare Access gate blocks this route.
6. In your Discord server, run `/verify`.

Unlike the original Python version, this HTTP version needs that endpoint URL. Keep privileged gateway intents off, and do not run the old Python process on the same application. A gray/offline status in Discord is normal for an HTTP-only bot.

## 7. Live acceptance checks

Before offering it to members:

- Confirm a regular member cannot see the review channel, and reviewers/the bot can.
- Submit a small image and then a small video. Confirm that submission is private and the copied evidence appears in review.
- Approve with a reviewer account and verify exactly the selected role is granted. Deny another request and verify no grant.
- Check that applicants cannot approve themselves and a non-reviewer cannot approve.
- Redeploy with a pending request, then use its existing buttons.
- Test a member with DMs blocked; `/verification_status` should still work.
- Check the Cron Trigger execution history. Review-card updates and notifications should arrive as the maintenance queue is processed.
- Test realistic file sizes while watching Worker CPU/exceeded-limit errors. Reduce `max_bytes` if needed to remain within Free limits. Local tests are not a measurement of Cloudflare CPU usage.
- In a test server, temporarily set `pending_hours` and `evidence_hours` to 1; confirm expiration and deletion, then restore intended values.

## Staying at $0

Check the Workers plan and D1 usage in Cloudflare's dashboard. Keep both on the free allowance; do not enable a paid upgrade to fix a limit error. Daily limits reset at midnight UTC; storage limits require removing data or waiting for cleanup. Heavy usage or provider changes can make the bot temporarily unavailable. There is no automatic paid fallback, always-on virtual machine, or object-storage subscription in this package.

Routine updates can be uploaded through GitHub and deployed in Cloudflare. Keep the database binding and stored application/server/channel association intact. Preserve the Cron Trigger so notification, recovery and retention work continues. Closing your browser or shutting down your Mac does not stop this cloud service.
