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

## Security Best Practices

- Never commit `config.json` to Git
- Use strong passwords (12+ chars, mixed case, numbers, symbols)
- Rotate admin password every 3-6 months
- Store config backups in encrypted storage

## Notes

- Only PBKDF2 hashes are accepted for authentication
