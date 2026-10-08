# KX Records

A static KX Records website with a demo submission form that posts demo links or audio attachments directly to a Discord webhook. It can be hosted on GitHub Pages; no Node.js server or Cloudflare deployment is needed.

## Deploy to GitHub Pages

1. Set `window.KX_DISCORD_WEBHOOK_URL` in `config.js` to the Discord webhook URL for the channel that should receive demo submissions.
2. Push the site to the GitHub repository.
3. In the repository's **Settings → Pages**, select the branch and root folder containing `index.html` and save.
4. Open the published Pages URL and submit a test demo.

The form accepts one MP3, WAV, or M4A file up to 25 MB, or one HTTPS demo link.

## Temporary webhook warning

This is a static-only setup: the webhook URL is sent to every visitor's browser and can be read from `config.js` or browser developer tools. Anyone who can access the published site can reuse it to post to the Discord channel. A private source repository does **not** automatically make its GitHub Pages website private. Use this only for a temporary/testing channel with a small trusted audience, and delete or regenerate the webhook when finished. Do not use a webhook for a production or publicly accessible demo portal; that requires a server-side endpoint.
