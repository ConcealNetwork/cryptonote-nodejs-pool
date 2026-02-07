#!/usr/bin/env node
/**
 * Generate a secure JWT secret for use in config.json
 *
 * Usage:
 *   node scripts/generate-jwt-secret.js
 *
 * Output: A cryptographically secure 128-character hex string
 */

const crypto = require('node:crypto');

console.log('\n=== JWT Secret Generator ===\n');
console.log('Generated JWT Secret (copy this to config.json under api.jwtSecret):\n');

const jwtSecret = crypto.randomBytes(64).toString('hex');
console.log(`"jwtSecret": "${jwtSecret}",\n`);

console.log('⚠️  IMPORTANT:');
console.log('  - Add this to config.json in the "api" section');
console.log('  - Keep this secret secure!');
console.log('  - Do NOT commit to version control!');
console.log('  - All users will be logged out if you change this value\n');
