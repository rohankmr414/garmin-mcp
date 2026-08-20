# /// script
# dependencies = ["garth==0.6.3"]
# ///
"""One-time interactive Garmin login (handles MFA). Run: uv run scripts/garmin-login.py

garth is pinned to 0.6.3: it uses the SSO web-widget flow, which is not blocked by the
bot protection Garmin added in 2026 that breaks garth >= 0.7 (429 on /mobile/api/login).
"""
import base64
import getpass
import os

import garth

# Garmin's Cloudflare rules block the default mobile User-Agent on SSO
garth.client.sess.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )
    }
)

email = input("Garmin email: ")
password = getpass.getpass("Garmin password: ")
garth.login(email, password)  # prompts for MFA code if the account has it enabled
path = os.path.expanduser("~/.garminconnect")
garth.save(path)

with open(os.path.join(path, "oauth1_token.json"), "rb") as f:
    header = base64.b64encode(f.read()).decode()
print(f"\nTokens saved to {path}. MCP Authorization header value:\n")
print(f"Bearer {header}")
