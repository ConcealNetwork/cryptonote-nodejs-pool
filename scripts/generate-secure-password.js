#!/usr/bin/env node
/**
 * Generate a secure PBKDF2-hashed password for use in config.json
 * 
 * Usage:
 *   node scripts/generate-secure-password.js [password]
 * 
 * If no password is provided, you'll be prompted to enter one securely.
 */

const crypto = require('crypto');
const readline = require('readline');

/**
 * Hash password using PBKDF2 with salt (same implementation as in lib/api.js)
 */
function hashPasswordSecure(password) {
    const iterations = 100000; // OWASP recommendation for PBKDF2-SHA512
    const keylen = 64; // 512 bits
    const digest = 'sha512';
    const salt = crypto.randomBytes(32).toString('hex');
    
    const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString('hex');
    
    // Format: $pbkdf2$iterations$salt$hash
    return `$pbkdf2$${iterations}$${salt}$${hash}`;
}

// Get password from command line or prompt
if (process.argv[2]) {
    const password = process.argv[2];
    const hashedPassword = hashPasswordSecure(password);
    
    console.log('\n=== Secure Password Hash Generated ===\n');
    console.log('Add this to your config.json under api.password:\n');
    console.log(`"password": "${hashedPassword}",\n`);
    console.log('⚠️  WARNING: Keep this password hash secure!');
    console.log('⚠️  Do NOT commit this to version control!\n');
    
} else {
    // Prompt for password (hidden input)
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    console.log('\n=== Secure Password Hash Generator ===\n');
    console.log('Enter a strong admin password (input will be hidden):');
    
    // Hide password input
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    
    let password = '';
    
    stdin.on('data', (char) => {
        if (char === '\u0003') {
            // Ctrl+C
            process.exit();
        } else if (char === '\r' || char === '\n') {
            // Enter key
            stdin.setRawMode(false);
            stdin.pause();
            
            if (password.length < 8) {
                console.log('\n\nError: Password must be at least 8 characters long.');
                process.exit(1);
            }
            
            const hashedPassword = hashPasswordSecure(password);
            
            console.log('\n\n=== Secure Password Hash Generated ===\n');
            console.log('Add this to your config.json under api.password:\n');
            console.log(`"password": "${hashedPassword}",\n`);
            console.log('⚠️  WARNING: Keep this password hash secure!');
            console.log('⚠️  Do NOT commit this to version control!\n');
            
            process.exit(0);
        } else if (char === '\u007f') {
            // Backspace
            password = password.slice(0, -1);
            process.stdout.write('\r' + ' '.repeat(50) + '\r');
            process.stdout.write('Password: ' + '*'.repeat(password.length));
        } else {
            password += char;
            process.stdout.write('*');
        }
    });
}
