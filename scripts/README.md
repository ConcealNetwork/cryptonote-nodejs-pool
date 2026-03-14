# Pool Scripts

Utility scripts for pool administration.

## `generate-secure-password.js`

Generates PBKDF2-SHA512 password hashes (100,000 iterations, unique salt per password).

**Usage:**
```bash
# Interactive (password hidden) - RECOMMENDED
node scripts/generate-secure-password.js

# Command line (⚠️ visible in history)
node scripts/generate-secure-password.js "your-password"
```

**Output:** Copy the `$pbkdf2$...` hash to `config.json` under `api.password`

---

## `generate-jwt-secret.js`

Generates a cryptographically secure JWT secret for session token signing.

**Usage:**
```bash
node scripts/generate-jwt-secret.js
```

**Output:** Copy the 128-character hex string to `config.json` under `api.jwtSecret`

**Important:**
- Required for production mode
- All users will be logged out if you change this value
- Keep this secret secure and never commit to Git

**Example config.json entry:**
```json
{
  "api": {
    "jwtSecret": "your-generated-128-char-hex-string-here",
    "password": "$pbkdf2$100000$...",
    ...
  }
}
```

---

## Security Best Practices

- Never commit `config.json` to Git
- Use strong passwords (12+ chars, mixed case, numbers, symbols)
- Rotate admin password every 3-6 months
- Store config backups in encrypted storage

## Notes

- Only PBKDF2 hashes are accepted for authentication
