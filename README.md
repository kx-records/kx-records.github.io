# KX Records

A responsive, single-page label website with a demo submission form. Demo files and links are delivered to Discord through a Cloudflare Pages Function so the webhook URL is never exposed in the browser.

## Deploy

The site can be hosted as static files, but the demo form needs the included server-side function. GitHub Pages does not run server-side functions; deploy this repository with [Cloudflare Pages](https://developers.cloudflare.com/pages/) to enable submissions.

1. Create a Cloudflare Pages project connected to this repository. Use the repository root as the build output directory and leave the build command empty.
2. In **Settings → Variables and Secrets → Add**, add:
   - `DISCORD_WEBHOOK_URL` — store your Discord webhook URL as a secret.
   - `ALLOWED_ORIGIN` — the exact public site origin, for example `https://your-site.pages.dev` (no trailing slash).
3. Deploy or redeploy the project. The `/api/submit-demo` function will receive the form and forward the selected file or HTTPS link to your Discord channel.
4. Add a Cloudflare rate-limiting rule for `/api/submit-demo` to reduce automated abuse.

The endpoint accepts one MP3, WAV, or M4A file up to 25 MB, or one HTTPS demo link. It validates submissions server-side and does not expose webhook credentials to visitors. Use a private Discord channel because uploaded demos and artists' contact details are posted there.