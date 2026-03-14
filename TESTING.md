# Local Testing Guide

This guide helps you set up and test the cryptonote-nodejs-pool locally for Conceal (CCX) mining.

## Prerequisites

1. **Conceal Daemon** - Running on `127.0.0.1:16000`
2. **Conceal Wallet RPC** - Running on `127.0.0.1:16001`
3. **Redis** - Running on `127.0.0.1:6379`
4. **Node.js** - v18.0+ (already installed)

## Quick Start

### 1. Copy the template configuration

```bash
cp config.json.template config.json
```

### 2. Edit `config.json` with your settings

**Required changes:**
- `poolServer.poolAddress`: Replace with your actual Conceal wallet address (must start with `ccx` and be 98 characters)
- `api.password`: Change from `change_this_password` to a secure password
- `daemon.port`: Update if your daemon uses a different port (default: 16000)
- `wallet.port`: Update if your wallet RPC uses a different port (default: 16001)

**Example Conceal address format:**
```
ccx7YourConcealWalletAddressHere123456789012345678901234567890123456789012345678901234567890123456789012
```

### 3. Start required services

**Redis:**

Redis is required for the pool to store miner data, shares, and statistics. You can run it locally for testing.

**Install Redis (if not installed):**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install redis-server

# Or use the official PPA (recommended for latest version)
sudo add-apt-repository ppa:chris-lea/redis-server
sudo apt update
sudo apt install redis-server
```

**Run Redis locally for testing:**

**Option 1: Run Redis in foreground (for testing):**
```bash
# Start Redis server (runs in foreground, press Ctrl+C to stop)
redis-server

# Or with custom config (no persistence, faster for testing)
redis-server --port 6379 --save "" --appendonly no
```

**Option 2: Run Redis as a service:**
```bash
# Start Redis service
sudo systemctl start redis

# Enable Redis to start on boot (optional)
sudo systemctl enable redis

# Check Redis status
sudo systemctl status redis
```

**Option 3: Run Redis in Docker (if you prefer containers):**
```bash
docker run -d --name redis-test -p 6379:6379 redis:7-alpine
```

**Verify Redis is running:**
```bash
# Test Redis connection
redis-cli ping
# Should return: PONG

# If you get "Address already in use" error, Redis is already running!
# Just verify it works:
redis-cli ping

# Check Redis info
redis-cli info server | head -5

# Check which Redis process is running
ps aux | grep redis-server

# Or use the test script
node scripts/test-redis.js
```

**Quick Redis test:**
```bash
# Set a test value
redis-cli set test "hello"

# Get the value
redis-cli get test
# Should return: "hello"

# Clean up test
redis-cli del test
```

**Conceal Daemon:**
```bash
# Start your Conceal daemon (conceald)
# Make sure it's running on 127.0.0.1:16000
```

**Conceal Wallet RPC:**
```bash
# Start your Conceal wallet RPC
# Make sure it's running on 127.0.0.1:16001
```

### 4. Start the pool

```bash
node init.js
```

Or start specific modules:
```bash
# Pool server only
node init.js -module=pool

# API only
node init.js -module=api

# All modules (default)
node init.js
```

### 5. Test the pool

**Check API:**
```bash
curl http://localhost:8117/stats
```

**Connect a miner:**
- Host: `localhost`
- Port: `3333` (low difficulty), `4444` (medium), or `5555` (high)
- Username: Your Conceal wallet address
- Password: Worker name (optional)

**Example miner config (XMRig):**
```json
{
  "pools": [{
    "url": "localhost:3333",
    "user": "ccx7YourConcealWalletAddressHere...",
    "pass": "worker1",
    "keepalive": true
  }]
}
```

## Configuration Notes for Conceal (CCX)

- **Algorithm**: `cryptonight`
- **Variant**: `3` (CryptoNight-GPU) - Required for Conceal block v7
- **Blob Type**: `0` (Cryptonote)
- **Coin Units**: `1000000000000` (12 decimals)
- **Address Prefix**: `6` (for integrated addresses)

## Troubleshooting

### Pool won't start

**Redis issues:**
```bash
# Quick test using the provided script
node scripts/test-redis.js

# Or manually check if Redis is running
redis-cli ping
# Should return: PONG

# If Redis is not running, start it:
redis-server

# Check Redis is listening on correct port
netstat -tlnp | grep 6379
# Or: ss -tlnp | grep 6379

# Test Redis connection from Node.js
node -e "const redis = require('redis'); const client = redis.createClient(); client.connect().then(() => { console.log('Redis connected!'); client.quit(); }).catch(err => console.error('Redis error:', err));"
```

**Daemon issues:**
```bash
# Check daemon is accessible
curl http://127.0.0.1:16000/json_rpc -d '{"method":"getblockcount"}'

# Check daemon is listening
netstat -tlnp | grep 16000
```

**Wallet RPC issues:**
```bash
# Check wallet is accessible
curl http://127.0.0.1:16001/json_rpc -d '{"method":"getbalance"}'

# Check wallet is listening
netstat -tlnp | grep 16001
```

### No shares accepted
- Verify your wallet address is correct (98 characters, starts with `ccx`)
- Check miner is using correct algorithm variant (3 for Conceal)
- Review logs in `logs/` directory

### API not responding
- Check API is enabled in config: `"api.enabled": true`
- Verify port 8117 is not blocked by firewall
- Check logs for errors

## Testing Checklist

- [ ] Redis is running
- [ ] Conceal daemon is running and synced
- [ ] Conceal wallet RPC is running
- [ ] `config.json` is properly configured
- [ ] Pool starts without errors
- [ ] API responds at `http://localhost:8117/stats`
- [ ] Miner can connect to pool
- [ ] Shares are being accepted
- [ ] Stats update in API

## Next Steps

Once local testing is successful:
1. Update `poolHost` to your actual domain
2. Configure SSL certificates if needed
3. Set up proper firewall rules
4. Configure email/Telegram notifications
5. Set up monitoring and logging
