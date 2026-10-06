const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = /\.(mp3|wav|m4a)$/i;
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "application/octet-stream"
]);

class SubmissionValidationError extends Error {}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function textField(form, name, maxLength, required = false) {
  const value = form.get(name);
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (required && !normalized) throw new SubmissionValidationError(`${name} is required.`);
  if (normalized.length > maxLength) throw new SubmissionValidationError(`${name} is too long.`);
  return normalized;
}

function validateLink(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SubmissionValidationError("Please enter a valid demo link.");
  }
  if (url.protocol !== "https:") throw new SubmissionValidationError("Demo links must use HTTPS.");
  return url.toString();
}

function validateWebhook(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Discord webhook configuration.");
  }
  if (
    url.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(url.hostname) ||
    !url.pathname.startsWith("/api/webhooks/")
  ) {
    throw new Error("Invalid Discord webhook configuration.");
  }
  return url.toString();
}

export async function onRequestPost({ request, env }) {
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    return jsonResponse({ error: "Demo submissions are not configured yet." }, 503);
  }
  if (request.headers.get("Origin") !== allowedOrigin) {
    return jsonResponse({ error: "This submission could not be verified." }, 403);
  }

  if (!env.DISCORD_WEBHOOK_URL) {
    return jsonResponse({ error: "Demo submissions are not configured yet." }, 503);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Please submit the demo form again." }, 400);
  }

  if (form.get("companyWebsite")) {
    return jsonResponse({ error: "This submission could not be verified." }, 400);
  }

  let webhookUrl;
  try {
    webhookUrl = validateWebhook(env.DISCORD_WEBHOOK_URL);
  } catch (error) {
    console.error("Invalid Discord webhook configuration", error);
    return jsonResponse({ error: "Demo submissions are not configured correctly." }, 503);
  }

  let artistName;
  let email;
  let trackTitle;
  let genre;
  let message;
  let demoUrl;
  let demoFile;
  try {
    artistName = textField(form, "artistName", 100, true);
    email = textField(form, "email", 254, true);
    trackTitle = textField(form, "trackTitle", 150, true);
    genre = textField(form, "genre", 80, true);
    message = textField(form, "message", 1000);
    demoUrl = validateLink(textField(form, "demoUrl", 1000));
    const submittedFile = form.get("demoFile");
    demoFile = submittedFile instanceof File && submittedFile.size > 0 ? submittedFile : null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400);
    }
    if (Boolean(demoFile) === Boolean(demoUrl)) {
      return jsonResponse({ error: "Submit either an audio file or a demo link." }, 400);
    }
    if (demoFile) {
      const mimeType = (demoFile.type || "application/octet-stream").toLowerCase();
      if (!ALLOWED_EXTENSIONS.test(demoFile.name) || !ALLOWED_MIME_TYPES.has(mimeType)) {
        return jsonResponse({ error: "Upload an MP3, WAV, or M4A audio file." }, 400);
      }
      if (demoFile.size > MAX_FILE_SIZE) {
        return jsonResponse({ error: "Your demo must be 25 MB or smaller." }, 413);
      }
    }
  } catch (error) {
    if (error instanceof SubmissionValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }
    console.error("Could not read a demo submission", error);
    return jsonResponse({ error: "We couldn't read your submission. Please try again." }, 500);
  }

  const payload = {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "New demo submission",
      color: 10512639,
      fields: [
        { name: "Artist", value: artistName, inline: true },
        { name: "Track", value: trackTitle, inline: true },
        { name: "Genre", value: genre, inline: true },
        { name: "Email", value: email, inline: true },
        { name: "Demo", value: demoUrl || `Attached: ${demoFile.name.slice(0, 240)}`, inline: false },
        ...(message ? [{ name: "Message", value: message, inline: false }] : [])
      ],
      timestamp: new Date().toISOString()
    }]
  };

  const webhookForm = new FormData();
  webhookForm.set("payload_json", JSON.stringify(payload));
  if (demoFile) {
    const safeName = demoFile.name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "demo";
    webhookForm.set("files[0]", demoFile, safeName);
  }

  let webhookResponse;
  try {
    webhookResponse = await fetch(webhookUrl, {
      method: "POST",
      body: webhookForm
    });
  } catch (error) {
    console.error("Demo submission failed while contacting Discord", error);
    return jsonResponse({ error: "We couldn't deliver your demo right now. Please try again later." }, 502);
  }
  if (!webhookResponse.ok) {
    console.error("Discord webhook rejected a demo submission", webhookResponse.status);
    return jsonResponse({ error: "We couldn't deliver your demo right now. Please try again later." }, 502);
  }
  return jsonResponse({ ok: true }, 200);
}
