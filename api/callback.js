// /api/callback — step 2 of the CMS login. GitHub sends the admin back here with a
// one-time code; we exchange it for an access token and post it to the CMS popup.
module.exports = async (req, res) => {
  const { code } = req.query;
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

    // Decap CMS listens for this exact postMessage format in the popup it opened.
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`
      <script>
        (function() {
          function receiveMessage(e) {
            window.opener.postMessage(
              'authorization:github:success:${payload.replace(/'/g, "\\'")}',
              e.origin
            );
            window.removeEventListener("message", receiveMessage, false);
          }
          window.addEventListener("message", receiveMessage, false);
          window.opener.postMessage("authorizing:github", "*");
        })();
      </script>
    `);
  } catch (err) {
    res.status(500).send("Authentication failed: " + err.message);
  }
};
