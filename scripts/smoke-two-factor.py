"""End-to-end 2FA smoke check against the disposable CI stack.

The script intentionally never prints the TOTP URI, secret, session cookies,
or recovery codes. Run only against an ephemeral account/database.
"""

import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request


BASE = os.getenv("ASSAY_TEST_URL", "http://localhost:8088")
EMAIL = os.getenv("ASSAY_TEST_EMAIL", "admin@example.com")
PASSWORD = os.environ["ASSAY_TEST_PASSWORD"]
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(path, payload=None, extra_headers=None):
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"Origin": BASE}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(BASE + path, data=body, headers=headers)
    try:
        with client.open(req, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def expect_ok(path, payload=None, extra_headers=None, expected_status=200):
    status, data = request(path, payload, extra_headers)
    if status != expected_status:
        raise AssertionError(f"{path}: expected {expected_status}, got {status} ({data.get('code', '')})")
    return data


def totp(uri):
    params = urllib.parse.parse_qs(urllib.parse.urlparse(uri).query)
    secret = params["secret"][0]
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = struct.pack(">Q", int(time.time() // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000:06d}"


expect_ok("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})
setup = expect_ok("/api/auth/two-factor/enable", {"password": PASSWORD})
assert setup["totpURI"].startswith("otpauth://totp/")
assert setup["backupCodes"]
expect_ok("/api/auth/two-factor/verify-totp", {"code": totp(setup["totpURI"])})
assert expect_ok("/api/me")["twoFactorEnabled"] is True

# Better Auth applies a short shared limit to all /two-factor/* endpoints.
time.sleep(11)

expect_ok("/api/auth/sign-out", {})
challenge = expect_ok("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})
assert challenge["twoFactorRedirect"] is True
assert request("/api/me")[0] == 401, "Password alone must not establish a session"
expect_ok("/api/auth/two-factor/verify-totp", {"code": totp(setup["totpURI"])})
assert expect_ok("/api/me")["twoFactorEnabled"] is True

expect_ok("/api/auth/sign-out", {})
assert expect_ok("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})["twoFactorRedirect"]
expect_ok("/api/auth/two-factor/verify-backup-code", {"code": setup["backupCodes"][0]})
assert expect_ok("/api/me")["twoFactorEnabled"] is True

step_up = expect_ok("/api/me/security/step-up", {
    "purpose": "two-factor", "password": PASSWORD, "code": totp(setup["totpURI"]),
}, expected_status=201)
expect_ok("/api/auth/two-factor/disable", {"password": PASSWORD}, {
    "X-Step-Up-Token": step_up["stepUpToken"],
})
assert expect_ok("/api/me")["twoFactorEnabled"] is False
expect_ok("/api/auth/sign-out", {})
assert "twoFactorRedirect" not in expect_ok("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})
print("2FA smoke passed: setup, challenge without session, TOTP, recovery code, disable")
