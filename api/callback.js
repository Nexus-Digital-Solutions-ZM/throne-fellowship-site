// /api/callback — step 2 of the CMS login. GitHub sends the admin back here with a
// one-time code; we exchange it for an access token and hand it back to the CMS.
//
// This always uses the "stash token + redirect to /admin/" relay, rather than
// trying to detect a popup via window.opener. Several mobile browsers (Edge
// included) convert window.open() into a full tab while still leaving
// window.opener technically non-null, which used to make this code wait on a
// postMessage handshake that never completed — leaving the tab permanently
// blank. Redirecting unconditionally means this always finishes, on every
// browser, whether it opened as a popup or a tab.
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
    const payload = JSON.stringify({ token, provider: "github" });
    const message = `authorization:github:success:${payload.replace(/'/g, "\\'")}`;

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8" /></head>
      <body style="background:#0F1B33;">
        <script>
          (function() {
            var message = '${message}';
            // Stash the login message and hand off to /admin/, which
            // replays it once Decap CMS has mounted and is listening.
            // This is unconditional — no window.opener detection — so it
            // works the same way whether this page is a real popup, a
            // browser-collapsed tab, or the only tab in the session.
            sessionStorage.setItem('decap-cms-oauth-relay', message);
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
