// /api/callback — step 2 of the CMS login. GitHub sends the admin back here with a
// one-time code; we exchange it for an access token and hand it back to the CMS.
//
// Earlier versions tried to relay this via postMessage to a freshly-reloaded
// /admin/ page. That doesn't work: Decap CMS only listens for that message
// after its own login button has been clicked in that exact page instance,
// so a fresh reload never receives it and just shows the login screen again.
//
// Instead, we stash the token and redirect to /admin/, where a script writes
// it directly into localStorage in the shape Decap CMS checks for on boot —
// so Decap finds an existing session and skips the login screen entirely,
// rather than relying on any message being "caught" in time.
module.exports = async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    res.status(400).send(`OAuth error: ${error_description || error}`);
    return;
  }

  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error}`);
      return;
    }

    const token = tokenData.access_token;
    const payload = JSON.stringify({ token, backendName: "github" }).replace(/</g, "\\u003c");

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8" /></head>
      <body style="background:#0F1B33;">
        <script>
          (function() {
            // Stash the session for /admin/ to pick up and write into
            // localStorage before Decap CMS boots.
            sessionStorage.setItem('decap-cms-oauth-pending', '${payload}');
            window.location.replace('/admin/');
          })();
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Authentication failed: " + err.message);
  }
};
