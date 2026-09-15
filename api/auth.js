// /api/auth — step 1 of the CMS login. Redirects the admin to GitHub to approve access.
module.exports = (req, res) => {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const host = req.headers.host;
  const protocol = host.includes("localhost") ? "http" : "https";
  const redirectUri = `${protocol}://${host}/api/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo,user",
  });

  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params.toString()}` });
  res.end();
};
