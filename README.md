# KX Records portal

A server-backed label portal with accounts, sessions, role-based demo reviews, team promotion, and private demo uploads.

This tutorial hosts two parts separately:

- **GitHub Pages:** the public website and browser interface.
- **Dedicated dashboard:** authenticated users are redirected to `/dashboard.html`, keeping account controls separate from the public site.
- **Northflank Sandbox:** the private Node.js API, account database, sessions, and uploaded demos.

Northflank’s Sandbox plan advertises no card and up to $20/month of usage. It includes persistent volumes, always-on services, automatic HTTPS, and the resources needed for this project. Free resources can change, and usage beyond the included allowance may require an account upgrade. Check Northflank’s current plan limits before production use.

## Account roles

- **Artist:** registers, submits demos, and sees their own submissions.
- **A&R:** reviews every submission and can approve, reject, or reset it.
- **Manager:** reviews every submission and can promote users to A&R.
- **Owner:** reviews every submission and can promote users to A&R or Manager.
- **Developer:** has the same permissions as Owner.

Role permissions are enforced by the Node server. The dashboard only hides controls that the signed-in role is not allowed to use.

## What to prepare

You need:

1. A GitHub account and this repository.
2. A Northflank account. The Sandbox is the no-card option.
3. A custom API domain such as `api.example.com`, or a Northflank-generated HTTPS hostname.
4. Access to the domain's DNS settings if using a custom domain.

A custom domain is recommended. GitHub Pages hosts a user or organization repository at `https://username.github.io` and a project repository at `https://username.github.io/repository-name/`. The API domain receives HTTPS traffic directly from Northflank.

## Part 1: run locally

1. Copy `.env.example` to `.env`.

2. Set a strong session secret:

   ```dotenv
   PORT=3000
   NODE_ENV=production
   KX_SESSION_SECRET=generate-a-long-random-string-here
   KX_OWNER_EMAIL=owner@example.com
   KX_OWNER_PASSWORD=use-a-different-long-password
   KX_DEVELOPER_EMAIL=developer@example.com
   KX_DEVELOPER_PASSWORD=use-another-different-long-password
   KX_FRONTEND_ORIGIN=http://localhost:3000
   KX_API_BASE_URL=http://localhost:3000
   ```

   To generate a secret locally, run:

   ```sh
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Copy the output into `KX_SESSION_SECRET`. Do not commit `.env`.

3. Install dependencies and start the API:

   ```sh
   npm install
   npm start
   ```

4. Open `http://localhost:3000`. Sign in as the owner or developer, then use **Dashboard** to inspect demos and roles.

Local and hosted modes behave differently:

- Local mode serves the frontend and API from the same origin.
- Hosted mode serves the frontend from GitHub Pages and calls the API from `api.example.com`.
- Cross-origin hosted sessions require HTTPS and `SameSite=None` cookies.

## Part 2: create the free Northflank service

1. Open [Northflank](https://northflank.com/) and select **Start free**.
2. Create an account. The Sandbox does not require a card.
3. Open **Create project** and name it `kx-records`.
4. Link GitHub when prompted.
5. Inside the project, select **Create → Service → Combined**.
6. Select this repository and the branch that contains the deployment files.
7. Choose **Dockerfile** as the build option.
8. Use `Dockerfile` as the Dockerfile path and `/` as the build context.
9. Open **Advanced** and add a persistent volume named `kx-data` with mount path `/app/data`.
10. Allocate a small resource plan that remains within the included Sandbox allowance.
11. Create the service.

Northflank builds the Docker image and deploys it automatically. The Dockerfile exposes port 3000 and runs `server.js`.

## Part 3: configure Northflank secrets

1. Open the new service and choose **Configure → Variables and secrets**.
2. Add runtime variables for the API:

```dotenv
PORT=3000
NODE_ENV=production
KX_FRONTEND_ORIGIN=https://YOUR_USER.github.io
KX_API_BASE_URL=https://YOUR_NORTHFLANK_HOSTNAME
KX_SESSION_SECRET=paste-the-output-from-node-crypto
KX_OWNER_EMAIL=owner@example.com
KX_OWNER_PASSWORD=use-a-different-long-password
KX_DEVELOPER_EMAIL=developer@example.com
KX_DEVELOPER_PASSWORD=use-another-different-long-password
```

Generate a session secret locally:

```sh
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Set `KX_FRONTEND_ORIGIN` to the exact GitHub Pages origin:

- `https://username.github.io` for a user or organization Pages repository.
- `https://username.github.io/repository-name` is the public page URL for a project repository, but the CORS origin setting still uses `https://username.github.io`.

Do not include a trailing slash. Do not include `/api` or the repository path in `KX_FRONTEND_ORIGIN`.

Local `npm start` loads `.env` automatically. Northflank stores these values in its variables and secrets interface rather than in Git or a local `.env` file.

## Part 4: publish the API

1. Open **Configure → Networking**.
2. Add a public HTTP port using container port `3000`.
3. Copy the generated HTTPS hostname.
4. Reopen **Variables and secrets** and set `KX_API_BASE_URL` to that HTTPS hostname.
5. Deploy or restart the service.
6. Open `https://YOUR_NORTHFLANK_HOSTNAME/api/me`.

The response should be JSON containing `{"user":null}` before login. Northflank terminates TLS and handles certificate renewal automatically.

To use `api.example.com` instead:

1. Open **Networking → Custom domain**.
2. Add `api.example.com`.
3. Create the DNS record Northflank requests.
4. Set `KX_API_BASE_URL=https://api.example.com`.
5. Restart or redeploy the service.

## Part 5: verify persistent storage and deployment

1. Submit a test demo.
2. Restart the Northflank service.
3. Sign in and verify the test account and demo remain present.
4. If they disappear, confirm the volume is mounted at `/app/data` and is attached to the service.
5. Inspect logs from the service dashboard.

GitHub pushes to the connected branch rebuild and redeploy automatically when CI/CD is enabled.

## Part 6: configure GitHub Pages

1. Open [config.js](config.js) in the repository.
2. Set `window.KX_API_BASE_URL` to `https://api.example.com`.
3. Commit and push the frontend.
4. Open the repository **Settings → Pages**.
5. Select the repository branch and `/ (root)` folder.
6. Save and wait for GitHub Pages to publish.

Do not commit the real `.env` file. [config.js](config.js) only contains public API configuration, not passwords or session secrets.

If GitHub Pages uses a project URL, test both possibilities before continuing:

- `https://username.github.io/repository-name/`
- `https://username.github.io/repository-name/index.html`

Set `KX_FRONTEND_ORIGIN` to the exact GitHub Pages origin. For a project repository, include the full origin and repository path only in the browser URL, not in the origin setting; origins consist of scheme and host, not the repository path.

After changing a deployment environment variable, use Northflank's **Deploy / Restart** control.

## Part 7: test the complete flow

Open the public GitHub Pages URL in a normal browser window.

1. Open the Account dialog.
2. Create a normal artist account.
3. Submit a demo with an HTTPS link or an allowed audio file.
4. Confirm that `pending` appears in your dashboard.
5. Sign out.
6. Sign in with the owner credentials.
7. Open **Team** and promote an account to A&R or Manager.
8. Review the demo as approved or rejected.
9. Sign in as the promoted user and confirm the role and permissions.
10. Repeat the manager test by promoting an artist to A&R. A manager must not be able to assign Manager.

Test directly in Developer Tools if needed:

```js
fetch("https://api.example.com/api/me", { credentials: "include" })
  .then((response) => response.json())
  .then(console.log);
```

The response should contain a user after sign-in. A `403` response usually means `KX_FRONTEND_ORIGIN` does not exactly match the GitHub Pages origin.

## Persistence and backups

The server stores account data in `data/portal.json` and uploaded audio in `data/uploads/`.

Use the Northflank web shell or persistent-volume tooling to export `portal.json` and `uploads/` into encrypted storage outside Northflank. Schedule off-platform backups and test restoring them before relying on the data.

Never expose `/data`, `portal.json`, or uploaded demos through a public port or GitHub Pages.

The Northflank persistent volume must remain attached to the service. Deleting or replacing the volume can delete every account and demo. Export backups regularly and test restoring them outside the live service.

## Security checks

- Keep `.env`, private API keys, and private SSH keys out of Git.
- Remove or regenerate the old Discord webhook from [config.js](config.js); it is no longer used and was exposed in the previous public configuration.
- Use unique, long owner and developer passwords.
- Keep Northflank runtime resources and repository dependencies updated.
- Expose container port `3000` through Northflank; do not add a second public Node server.
- Restrict the API CORS origin to one exact GitHub Pages origin.
- Keep demo file storage outside the static frontend.
- Review Northflank variables, volume access, custom domains, and deployment logs periodically.
- Schedule regular backups and test a restore before relying on the site.

## Session behavior

The server uses an HTTP-only signed cookie and a file-backed session store in `data/sessions.json`. Sessions survive Node restarts and remain active until logout or the browser session ends, subject to the configured session expiry. The owner, artist, and team accounts remain in `data/portal.json`. Back up `data/sessions.json` only together with your account and upload data when required.

The file-backed store is suitable for this single-instance deployment. For a load-balanced or frequently redeployed service, replace it with shared storage such as Redis or a database-backed session store.

## Local commands

- `npm start` loads `.env` and starts the API and frontend on `http://localhost:3000`.
- `npm test` checks role and data constraints.
- `npm install --omit=dev` installs production dependencies only.

## Troubleshooting

### `403` from API requests

Confirm:

- `KX_FRONTEND_ORIGIN` exactly matches `https://username.github.io`.
- [config.js](config.js) uses the exact Northflank API origin and HTTPS URL.
- `NODE_ENV=production` is set.
- Northflank exposes container port `3000` publicly.

### Login succeeds but refresh logs out

Confirm:

- Requests include `credentials: "include"`.
- The API origin is HTTPS.
- The frontend and API origins do not accidentally differ in `http`/`https` or `www` usage.
- The server was not restarted. The current session store is in memory.

### The custom API domain has no HTTPS certificate

Confirm the DNS record matches Northflank's custom-domain instructions, wait for DNS propagation, and open the domain again from the Northflank Networking page.

### Uploaded demos cannot be downloaded

Confirm the persistent volume is mounted at `/app/data`, inspect the Northflank service logs, and redeploy after fixing the mount or service resource.

### GitHub Pages shows an old frontend

Wait for the Pages deployment to finish, hard-refresh with `Ctrl+Shift+R`, or open DevTools **Network** and confirm [config.js](config.js) returns the expected API URL.
